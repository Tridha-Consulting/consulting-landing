import { randomUUID } from 'node:crypto';
import { classifyChannel } from '../lib/channel.js';
import { EVENT_LOG_DEADLINE_MS, logEvents } from '../lib/event-log.js';
import { leadSchema } from '../lib/schema.js';
import { STATUS, type LeadRow } from '../lib/columns.js';
import type { LeadSink } from '../lib/sinks/index.js';

// Web-standard handlers (named method exports). Vercel's Node helper layer, which pre-drains
// the request stream into req.body, is not in the path, so the body is read here exactly once.

// Largest valid body: 12 answers (~1 KB), thirteen attribution fields of 500 characters, a Turnstile token
// (up to 2 KB), and up to 3 bytes per UTF-16 unit for non-Latin text. That worst case is about 24.1 KB
// (about 10 KB when ASCII), so the 32 KiB cap leaves room for a few more fields. tests/handler.test.ts builds it.
const MAX_BODY_BYTES = 32 * 1024;
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

class BodyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new BodyError(413, 'payload_too_large');

  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new BodyError(413, 'payload_too_large');

  try {
    return JSON.parse(raw);
  } catch {
    throw new BodyError(400, 'invalid_json');
  }
}

function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd || (request.headers.get('x-real-ip') ?? '').trim();
}

interface TurnstileVerdict {
  success: boolean;
  errorCodes: string[];
}

/** Throws when Cloudflare cannot be reached; a rejection is a normal verdict. */
async function verifyTurnstile(secret: string, token: unknown, ip: string): Promise<TurnstileVerdict> {
  if (typeof token !== 'string' || !token) return { success: false, errorCodes: ['missing-input-response'] };
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  const res = await fetch(TURNSTILE_URL, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
  if (!res.ok) return { success: false, errorCodes: [`siteverify-http-${res.status}`] };
  const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
  return { success: data.success === true, errorCodes: data['error-codes'] ?? [] };
}

/** The lead as submitted, minus the one-shot captcha token. */
function submittedLead(body: Record<string, unknown>): Record<string, unknown> {
  const { turnstileToken: _token, ...lead } = body;
  return lead;
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await readJson(request);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BodyError(400, 'invalid_json');
    body = parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BodyError) return json(err.status, { ok: false, error: err.message });
    return json(400, { ok: false, error: 'invalid_request' });
  }

  // Bots fill the hidden field. Pretend success and write nothing.
  if (typeof body.company_website === 'string' && body.company_website.trim() !== '') {
    return json(200, { ok: true });
  }

  const ip = clientIp(request);

  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  if (turnstileSecret) {
    let verdict: TurnstileVerdict;
    try {
      verdict = await verifyTurnstile(turnstileSecret, body.turnstileToken, ip);
    } catch (err) {
      // The lead is dropped here, so log it in full like every other lost write.
      console.error(
        JSON.stringify({
          event: 'LEAD_CAPTCHA_UNAVAILABLE',
          error: err instanceof Error ? err.message : String(err),
          lead: submittedLead(body),
        }),
      );
      return json(502, { ok: false, error: 'captcha_unavailable' });
    }
    if (!verdict.success) {
      const missingToken = typeof body.turnstileToken !== 'string' || !body.turnstileToken;
      console.error(
        JSON.stringify({
          event: 'LEAD_CAPTCHA_REJECTED',
          errorCodes: verdict.errorCodes,
          ...(missingToken && {
            hint: 'No Turnstile token was sent. TURNSTILE_SECRET_KEY is set, so TURNSTILE_SITE_KEY may be unset in js/config.js.',
          }),
          lead: submittedLead(body),
        }),
      );
      return json(400, { ok: false, error: 'captcha_failed' });
    }
  }

  const parsed = leadSchema.safeParse(body);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '_');
      (fields[key] ??= []).push(issue.message);
    }
    return json(400, { ok: false, error: 'validation_failed', fields });
  }

  let sinks: LeadSink[];
  try {
    ({ sinks } = await import('../lib/sinks/index.js'));
  } catch (err) {
    // Missing env fails module load. Never report success when nothing can store the lead.
    console.error(JSON.stringify({ event: 'LEAD_SINK_MISCONFIGURED', error: err instanceof Error ? err.message : String(err) }));
    return json(500, { ok: false, error: 'server_misconfigured' });
  }

  const lead: LeadRow = {
    ...parsed.data,
    leadId: randomUUID(),
    submittedAt: new Date(),
    userAgent: (request.headers.get('user-agent') ?? '').slice(0, 500),
    ip,
  };

  const results = await Promise.allSettled(sinks.map((s) => s.write(lead)));
  let written = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      written++;
      return;
    }
    const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
    // The full lead is logged on purpose: Vercel logs are the recovery path for a lost write.
    console.error(JSON.stringify({ event: 'LEAD_WRITE_FAILED', sink: sinks[i]?.name, error, lead }));
  });

  if (written === 0) return json(502, { ok: false, error: 'write_failed' });

  console.log(JSON.stringify({ event: 'LEAD_WRITTEN', leadId: lead.leadId }));
  // Best-effort audit row after the lead is stored; logEvents never throws, so the response is unchanged,
  // and the deadline caps the time a stuck Events write can add to it.
  await logEvents([{ event: 'Lead submitted', source: 'form', leadId: lead.leadId, statusTo: STATUS.new, detail: classifyChannel(lead) }], {
    deadlineMs: EVENT_LOG_DEADLINE_MS,
  });
  return json(200, { ok: true, leadId: lead.leadId });
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
