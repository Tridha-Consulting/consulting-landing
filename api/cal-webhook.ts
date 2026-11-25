import { createHmac, timingSafeEqual } from 'node:crypto';
import { sendAlert } from '../lib/alert.js';
import { eventNameFor, isHandledTrigger, parseBooking } from '../lib/cal-booking.js';
import { SheetLayoutError } from '../lib/columns.js';
import { EVENT_LOG_DEADLINE_MS, logEvents } from '../lib/event-log.js';

// Cal.com booking webhooks -> the lead's row in the Sheet. Web-standard handler like api/lead.ts:
// the raw body is read once because the signature is over the exact bytes Cal sent.

const MAX_BODY_BYTES = 64 * 1024;

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}

/** Reads the raw body once; `tooLarge` carries the byte size when it exceeds the cap. */
async function readRaw(request: Request): Promise<{ raw: string } | { tooLarge: number }> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return { tooLarge: declared };
  const raw = await request.text();
  const bytes = Buffer.byteLength(raw);
  return bytes > MAX_BODY_BYTES ? { tooLarge: bytes } : { raw };
}

/** Constant-time check of `x-cal-signature-256` (hex HMAC-SHA256 of the raw body). */
function validSignature(secret: string, raw: string, header: string | null): boolean {
  if (!header) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const given = Buffer.from(header.trim().toLowerCase());
  // timingSafeEqual throws on unequal lengths, so a wrong-length header is rejected first.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The booking uid of an unparsed payload, for the throttle key of an alert about it. */
function payloadUid(payload: unknown): string {
  const uid = typeof payload === 'object' && payload !== null ? (payload as { uid?: unknown }).uid : undefined;
  return typeof uid === 'string' ? uid : 'unknown';
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CAL_WEBHOOK_SECRET?.trim();
  if (!secret) {
    const error = 'Missing required environment variable: CAL_WEBHOOK_SECRET';
    console.error(JSON.stringify({ event: 'CAL_WEBHOOK_MISCONFIGURED', error }));
    // Reachable without a signature, so the alert is throttled to one per window instead of one per request.
    await sendAlert({
      event: 'CAL_WEBHOOK_MISCONFIGURED',
      subject: 'Cal.com webhook cannot verify bookings: secret missing',
      summary: 'Every Cal.com booking webhook is being refused with a 500 because CAL_WEBHOOK_SECRET is not set, so no booking reaches the Sheet.',
      error,
      dedupeKey: 'secret-missing',
    });
    return json(500, { ok: false, error: 'server_misconfigured' });
  }

  const read = await readRaw(request);
  if ('tooLarge' in read) {
    // Not yet authenticated, so the size only: never the body.
    console.error(JSON.stringify({ event: 'CAL_WEBHOOK_TOO_LARGE', bytes: read.tooLarge }));
    return json(413, { ok: false, error: 'payload_too_large' });
  }
  const { raw } = read;

  if (!validSignature(secret, raw, request.headers.get('x-cal-signature-256'))) {
    // Unauthenticated body: log the event only, never its content.
    console.error(JSON.stringify({ event: 'CAL_WEBHOOK_BAD_SIGNATURE' }));
    return json(401, { ok: false, error: 'bad_signature' });
  }

  let body: { triggerEvent?: unknown; createdAt?: unknown; payload?: unknown };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed;
  } catch {
    // Signature-verified and at most 64 KB, so the raw text is safe to log and is the recovery path.
    console.error(JSON.stringify({ event: 'CAL_WEBHOOK_BAD_PAYLOAD', error: 'invalid_json', body: raw }));
    // Past the signature check, so only the holder of the secret can reach this.
    await sendAlert({
      event: 'CAL_WEBHOOK_BAD_PAYLOAD',
      subject: 'Cal.com webhook body is not valid JSON',
      summary: 'A signed Cal.com webhook arrived whose body is not a JSON object, so it was rejected with a 400 and nothing was written. The raw body is below.',
      error: 'invalid_json',
      details: { body: raw },
      dedupeKey: 'invalid-json',
    });
    return json(400, { ok: false, error: 'invalid_json' });
  }

  // Cal's dashboard test ping and any trigger we did not subscribe to land here: acknowledge.
  const trigger = body.triggerEvent;
  if (!isHandledTrigger(trigger)) return json(200, { ok: true, ignored: trigger ?? null });

  const booking = parseBooking(body.payload);
  if (!booking.ok) {
    console.error(JSON.stringify({ event: 'CAL_WEBHOOK_BAD_PAYLOAD', trigger, issues: booking.issues, payload: body.payload }));
    await sendAlert({
      event: 'CAL_WEBHOOK_BAD_PAYLOAD',
      subject: `Cal.com ${trigger} webhook has an unusable payload`,
      summary: 'A signed Cal.com webhook was rejected with a 400 because its booking payload is missing required fields, so nothing was written to the Sheet.',
      error: JSON.stringify(booking.issues),
      details: { trigger, issues: booking.issues, payload: body.payload },
      dedupeKey: `${trigger}:${payloadUid(body.payload)}`,
    });
    return json(400, { ok: false, error: 'invalid_payload' });
  }

  let syncBooking: typeof import('../lib/cal-sheet.js').syncBooking;
  try {
    ({ syncBooking } = await import('../lib/cal-sheet.js'));
  } catch (err) {
    // Missing Sheet env fails module load. The payload is logged: Vercel logs are the recovery path.
    const error = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'CAL_WEBHOOK_MISCONFIGURED', error, trigger, payload: body.payload }));
    await sendAlert({
      event: 'CAL_WEBHOOK_MISCONFIGURED',
      subject: `Cal.com ${trigger} booking NOT recorded: server misconfigured`,
      summary: 'A Cal.com booking webhook could not be recorded because the Sheet is not configured. Cal.com will not retry a 500; the payload is below.',
      error,
      details: { trigger, payload: body.payload },
      dedupeKey: `${trigger}:${booking.booking.uid}`,
    });
    return json(500, { ok: false, error: 'server_misconfigured' });
  }

  try {
    const eventAt = typeof body.createdAt === 'string' ? body.createdAt : undefined;
    const out = await syncBooking(trigger, booking.booking, { eventAt });
    if (out.stale) {
      console.log(JSON.stringify({ event: 'CAL_WEBHOOK_STALE', uid: booking.booking.uid, trigger, reason: out.stale, matchedBy: out.matchedBy, row: out.row, ...(out.warn && { warn: out.warn }) }));
      return json(200, { ok: true, ignored: out.stale });
    }
    console.log(JSON.stringify({ event: 'CAL_BOOKING_SYNCED', uid: booking.booking.uid, trigger, matchedBy: out.matchedBy, row: out.row, ...(out.warn && { warn: out.warn }), ...(out.unmapped && { unmapped: out.unmapped }) }));
    // Best-effort audit row, after the sheet is already updated; logEvents never throws, and the deadline
    // caps the time a stuck Events write can add to the response.
    if (out.change) {
      await logEvents(
        [
          {
            event: eventNameFor(trigger),
            source: 'cal',
            leadId: out.change.leadId,
            statusFrom: out.change.statusFrom,
            statusTo: out.change.statusTo,
            callTime: out.change.callTime,
            bookingUid: out.change.uid,
          },
        ],
        { deadlineMs: EVENT_LOG_DEADLINE_MS },
      );
    }
    return json(200, { ok: true, matchedBy: out.matchedBy });
  } catch (err) {
    if (err instanceof SheetLayoutError) {
      // Nothing was written. Retrying cannot help until the header row is fixed, so 500 with the
      // payload logged for recovery, like any other misconfiguration.
      console.error(JSON.stringify({ event: 'CAL_WEBHOOK_MISCONFIGURED', error: err.message, trigger, payload: body.payload }));
      await sendAlert({
        event: 'CAL_WEBHOOK_MISCONFIGURED',
        subject: `Cal.com ${trigger} booking NOT recorded: Sheet header row is wrong`,
        summary: 'A Cal.com booking could not be written because the Sheet header row differs from the one the code expects. Nothing was written; fix the header row, then re-enter the booking from the payload below.',
        error: err.message,
        details: { trigger, payload: body.payload },
        dedupeKey: `${trigger}:${booking.booking.uid}`,
      });
      return json(500, { ok: false, error: 'server_misconfigured' });
    }
    // 502 makes Cal retry; the full payload is logged for recovery if retries run out.
    const error = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'CAL_WEBHOOK_WRITE_FAILED', error, trigger, payload: body.payload }));
    // Cal retries, so a retry of this booking and trigger shares the key and is not mailed again.
    await sendAlert({
      event: 'CAL_WEBHOOK_WRITE_FAILED',
      subject: `Cal.com ${trigger} booking not written to the Sheet`,
      summary: 'A Cal.com booking webhook could not be written to the Sheet (answered 502, so Cal.com retries). If the retries run out, the payload below is what to enter by hand.',
      error,
      details: { trigger, payload: body.payload },
      dedupeKey: `${trigger}:${booking.booking.uid}`,
    });
    return json(502, { ok: false, error: 'write_failed' });
  }
}

// Any other method gets a JSON 405 (Vercel's default for an unexported method is an empty body).
function methodNotAllowed(): Response {
  return json(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
}
export const GET = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
