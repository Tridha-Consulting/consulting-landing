import { createHmac, timingSafeEqual } from 'node:crypto';
import { isHandledTrigger, parseBooking } from '../lib/cal-booking.js';

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

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CAL_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error(JSON.stringify({ event: 'CAL_WEBHOOK_MISCONFIGURED', error: 'Missing required environment variable: CAL_WEBHOOK_SECRET' }));
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
    return json(400, { ok: false, error: 'invalid_json' });
  }

  // Cal's dashboard test ping and any trigger we did not subscribe to land here: acknowledge.
  const trigger = body.triggerEvent;
  if (!isHandledTrigger(trigger)) return json(200, { ok: true, ignored: trigger ?? null });

  const booking = parseBooking(body.payload);
  if (!booking.ok) {
    console.error(JSON.stringify({ event: 'CAL_WEBHOOK_BAD_PAYLOAD', trigger, issues: booking.issues, payload: body.payload }));
    return json(400, { ok: false, error: 'invalid_payload' });
  }

  let syncBooking: typeof import('../lib/cal-sheet.js').syncBooking;
  try {
    ({ syncBooking } = await import('../lib/cal-sheet.js'));
  } catch (err) {
    // Missing Sheet env fails module load. The payload is logged: Vercel logs are the recovery path.
    console.error(
      JSON.stringify({ event: 'CAL_WEBHOOK_MISCONFIGURED', error: err instanceof Error ? err.message : String(err), trigger, payload: body.payload }),
    );
    return json(500, { ok: false, error: 'server_misconfigured' });
  }

  try {
    const eventAt = typeof body.createdAt === 'string' ? body.createdAt : undefined;
    const out = await syncBooking(trigger, booking.booking, { eventAt });
    if (out.stale) {
      console.log(JSON.stringify({ event: 'CAL_WEBHOOK_STALE', uid: booking.booking.uid, trigger, reason: out.stale, matchedBy: out.matchedBy, row: out.row, ...(out.warn && { warn: out.warn }) }));
      return json(200, { ok: true, ignored: out.stale });
    }
    console.log(JSON.stringify({ event: 'CAL_BOOKING_SYNCED', uid: booking.booking.uid, trigger, matchedBy: out.matchedBy, row: out.row, ...(out.warn && { warn: out.warn }) }));
    return json(200, { ok: true, matchedBy: out.matchedBy });
  } catch (err) {
    // 502 makes Cal retry; the full payload is logged for recovery if retries run out.
    console.error(
      JSON.stringify({ event: 'CAL_WEBHOOK_WRITE_FAILED', error: err instanceof Error ? err.message : String(err), trigger, payload: body.payload }),
    );
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
