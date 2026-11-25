import { randomUUID } from 'node:crypto';
import { alertInBackground } from '../lib/alert.js';
import { classifyChannel } from '../lib/channel.js';
import { EMAIL_CHECK, checkEmailDomain } from '../lib/email-domain.js';
import { EVENT_LOG_DEADLINE_MS, logEvents } from '../lib/event-log.js';
import { fixTokenFor } from '../lib/fix-token.js';
import { BodyError, clientIp, json, methodNotAllowed, readJsonObject } from '../lib/http.js';
import { checkLeadRate } from '../lib/rate-limit.js';
import { recentLeads, proposedLeadId, submitterKey, type Claim, type LeadReply } from '../lib/lead-dedupe.js';
import type { StoredLead } from '../lib/lead-lookup.js';
import { leadSchema, type LeadInput } from '../lib/schema.js';
import { STATUS, type LeadRow } from '../lib/columns.js';
import type { LeadSink } from '../lib/sinks/index.js';

// Web-standard handlers (named method exports); the request helpers are in lib/http.ts.

// Largest valid body: 12 answers (~1 KB), thirteen attribution fields of 500 characters, a Turnstile token
// (up to 2 KB), and up to 3 bytes per UTF-16 unit for non-Latin text. That worst case is about 24.1 KB
// (about 10 KB when ASCII), so the 32 KiB cap leaves room for a few more fields. tests/handler.test.ts builds it.
const MAX_BODY_BYTES = 32 * 1024;
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

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

/** The User-Agent header, capped like the stored column. */
function userAgentOf(request: Request): string {
  return (request.headers.get('user-agent') ?? '').slice(0, 500);
}

/** "name (company)" of a body that has not been validated yet, for an alert subject; never throws on a wrong type. */
function submitterLabel(body: Record<string, unknown>): string {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : 'unknown');
  return `${text(body.fullName)} (${text(body.company)})`;
}

/** The lead as submitted, minus the one-shot captcha token. */
function submittedLead(body: Record<string, unknown>): Record<string, unknown> {
  const { turnstileToken: _token, ...lead } = body;
  return lead;
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(request, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyError) return json(err.status, { ok: false, error: err.message });
    return json(400, { ok: false, error: 'invalid_request' });
  }

  // Bots fill the hidden field. Pretend success and write nothing.
  if (typeof body.company_website === 'string' && body.company_website.trim() !== '') {
    return json(200, { ok: true });
  }

  const ip = clientIp(request);

  // Before Turnstile, so a flood does not spend a siteverify call per request. A honeypot hit returned above
  // and costs the sender nothing here.
  const rate = checkLeadRate(ip);
  if (!rate.allowed) {
    console.error(JSON.stringify({ event: 'LEAD_RATE_LIMITED', ip, lead: submittedLead(body) }));
    return json(429, { ok: false, error: 'rate_limited' }, { 'Retry-After': String(rate.retryAfterSec) });
  }

  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  if (turnstileSecret) {
    let verdict: TurnstileVerdict;
    try {
      verdict = await verifyTurnstile(turnstileSecret, body.turnstileToken, ip);
    } catch (err) {
      // The lead is dropped here, so log it in full like every other lost write.
      const error = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ event: 'LEAD_CAPTCHA_UNAVAILABLE', error, lead: submittedLead(body) }));
      alertInBackground({
        event: 'LEAD_CAPTCHA_UNAVAILABLE',
        subject: `Lead NOT saved (captcha check unavailable): ${submitterLabel(body)}`,
        summary: 'A lead submitted the form, but the captcha check could not reach Cloudflare, so the lead was dropped and NOT saved. The submitted answers are below; contact the lead or add them to the Sheet by hand.',
        error,
        details: { lead: submittedLead(body), leadId: proposedLeadId(body.leadId), ip, userAgent: userAgentOf(request), submittedAt: new Date().toISOString() },
        dedupeKey: proposedLeadId(body.leadId),
      });
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

  // The Lead ID the browser proposed for this submission; its retries carry the same one. A retry by the same
  // submitter is answered from the attempt already running or answered on this instance, else from the row
  // the Sheet holds, and appends nothing (lib/lead-dedupe.ts, README "Duplicate submissions").
  const proposed = proposedLeadId(body.leadId);
  let claim: Claim | undefined = proposed ? recentLeads.claim(proposed, submitterKey(parsed.data)) : undefined;
  if (claim?.kind === 'join') {
    const reply = await claim.reply;
    console.log(JSON.stringify({ event: 'LEAD_RETRY_JOINED', leadId: proposed, status: reply.status }));
    return json(reply.status, reply.body);
  }
  if (claim?.kind === 'conflict') {
    // Another submitter holds this id here: this lead gets an id of its own.
    console.error(JSON.stringify({ event: 'LEAD_ID_CONFLICT', leadId: proposed }));
    claim = undefined;
  }
  let reply: LeadReply = { status: 500, body: { ok: false, error: 'internal_error' } };
  try {
    reply = await storeLead(request, parsed.data, ip, claim ? proposed : undefined);
    return json(reply.status, reply.body);
  } finally {
    // Always settled, so a retry waiting on this attempt is never left hanging.
    claim?.settle(reply);
  }
}

/** The stored lead with this id, or null; a lookup that fails is logged and treated as none, so it never costs a lead its row. */
async function storedLead(leadId: string): Promise<StoredLead | null> {
  try {
    const { findLead } = await import('../lib/lead-lookup.js');
    return await findLead(leadId);
  } catch (err) {
    console.error(JSON.stringify({ event: 'LEAD_DEDUPE_CHECK_FAILED', leadId, error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}

/** The success answer for a stored lead, the same whether it was written now or by an earlier attempt. */
function stored(leadId: string, emailCheck: string): LeadReply {
  const emailOk = emailCheck !== EMAIL_CHECK.noMailServer;
  if (emailOk) return { status: 200, body: { ok: true, leadId, emailOk } };
  // The token that lets the form correct this row's email (/api/lead-email). Without CRON_SECRET the lead is
  // still saved and the form skips the correction step.
  const fixToken = fixTokenFor(leadId);
  if (!fixToken) console.error(JSON.stringify({ event: 'LEAD_FIX_TOKEN_UNAVAILABLE', leadId, error: 'Missing environment variable: CRON_SECRET' }));
  return { status: 200, body: { ok: true, leadId, emailOk, ...(fixToken && { fixToken }) } };
}

/**
 * Appends the lead, or answers from the row an earlier attempt of the same submission wrote. `proposed` is the
 * browser's id when this request owns it; without one the lead gets a fresh id and no lookup is needed.
 */
async function storeLead(request: Request, data: LeadInput, ip: string, proposed: string | undefined): Promise<LeadReply> {
  let sinks: LeadSink[];
  try {
    ({ sinks } = await import('../lib/sinks/index.js'));
  } catch (err) {
    // Missing env fails module load. Never report success when nothing can store the lead.
    const error = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'LEAD_SINK_MISCONFIGURED', error }));
    // The lead is lost here, so the alert carries what was submitted, for the team to enter by hand.
    alertInBackground({
      event: 'LEAD_SINK_MISCONFIGURED',
      subject: `Lead NOT saved, server misconfigured: ${data.fullName} (${data.company})`,
      summary: 'A lead submitted the form, but no Sheet is configured to store it, so it was NOT saved. The submitted answers are below; add them to the Sheet by hand, then fix the environment variables.',
      error,
      details: { lead: data, leadId: proposed, ip, userAgent: userAgentOf(request), submittedAt: new Date().toISOString() },
      dedupeKey: proposed,
    });
    return { status: 500, body: { ok: false, error: 'server_misconfigured' } };
  }

  // A domain with no mail server still gets its row; the form then asks for a corrected address. The lookup
  // runs beside the MX check, so it adds time only when it is the slower of the two.
  const [emailCheck, earlier] = await Promise.all([checkEmailDomain(data.email), proposed ? storedLead(proposed) : null]);
  let leadId = proposed ?? randomUUID();
  if (earlier) {
    if (submitterKey(earlier) === submitterKey(data)) {
      console.log(JSON.stringify({ event: 'LEAD_RETRY_REPLAYED', leadId, row: earlier.row }));
      return stored(leadId, earlier.emailCheck);
    }
    // The row with this id belongs to someone else: never answer from it, store this lead under its own id.
    console.error(JSON.stringify({ event: 'LEAD_ID_CONFLICT', leadId, row: earlier.row }));
    leadId = randomUUID();
  }

  const lead: LeadRow = {
    ...data,
    leadId,
    submittedAt: new Date(),
    userAgent: userAgentOf(request),
    ip,
    emailCheck,
  };

  const results = await Promise.allSettled(sinks.map((s) => s.write(lead)));
  let written = 0;
  const failures: { sink: string | undefined; error: string }[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      written++;
      return;
    }
    const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
    failures.push({ sink: sinks[i]?.name, error });
    // The full lead is logged on purpose: Vercel logs are the recovery path for a lost write.
    console.error(JSON.stringify({ event: 'LEAD_WRITE_FAILED', sink: sinks[i]?.name, error, lead }));
  });

  if (failures.length) {
    const lost = written === 0;
    alertInBackground({
      event: 'LEAD_WRITE_FAILED',
      subject: lost ? `Lead NOT saved: ${lead.fullName} (${lead.company})` : `Lead saved, but sink failed: ${lead.fullName} (${lead.company})`,
      summary: lost
        ? 'A lead submitted the form and could NOT be saved to any sink. The full lead is below; add it to the Sheet by hand.'
        : 'A lead was saved to some sinks but not to the ones listed under failures. The full lead is below.',
      error: failures.map((f) => `${f.sink ?? 'unknown sink'}: ${f.error}`).join('; '),
      details: { lead, failures },
      dedupeKey: lead.leadId,
    });
  }
  if (written === 0) return { status: 502, body: { ok: false, error: 'write_failed' } };

  console.log(JSON.stringify({ event: 'LEAD_WRITTEN', leadId: lead.leadId, emailCheck }));
  // Best-effort audit row after the lead is stored; logEvents never throws, so the response is unchanged,
  // and the deadline caps the time a stuck Events write can add to it.
  await logEvents([{ event: 'Lead submitted', source: 'form', leadId: lead.leadId, statusTo: STATUS.new, detail: classifyChannel(lead) }], {
    deadlineMs: EVENT_LOG_DEADLINE_MS,
  });
  return stored(lead.leadId, emailCheck);
}


export const GET = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
