import { z } from 'zod';
import { SheetLayoutError } from '../lib/columns.js';
import { EMAIL_CHECK, checkEmailDomain } from '../lib/email-domain.js';
import { EVENT_LOG_DEADLINE_MS, logEvents } from '../lib/event-log.js';
import { fixTokensConfigured, validFixToken } from '../lib/fix-token.js';
import { BodyError, json, methodNotAllowed, readJsonObject } from '../lib/http.js';
import { emailSchema } from '../lib/schema.js';

// Correct the email of a lead that /api/lead reported emailOk:false (no mail server for its domain),
// updating the same row so the lead is not stored twice. Web-standard handler like api/lead.ts.

// Three short strings: a UUID, an address of at most 254 characters and a 43-character token.
const MAX_BODY_BYTES = 2 * 1024;

const bodySchema = z.object({
  leadId: z.uuid('Invalid lead id'),
  // The same rule leadSchema applies to the email field.
  email: emailSchema,
});

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(request, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyError) return json(err.status, { ok: false, error: err.message });
    return json(400, { ok: false, error: 'invalid_request' });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '_');
      (fields[key] ??= []).push(issue.message);
    }
    return json(400, { ok: false, error: 'validation_failed', fields });
  }
  const { leadId, email } = parsed.data;

  // Before any DNS or Sheet call: only the visitor /api/lead issued a token to may reach the Sheet from here.
  if (!fixTokensConfigured()) {
    console.error(JSON.stringify({ event: 'LEAD_EMAIL_MISCONFIGURED', error: 'Missing environment variable: CRON_SECRET' }));
    return json(500, { ok: false, error: 'server_misconfigured' });
  }
  if (!validFixToken(leadId, body.fixToken)) return json(403, { ok: false, error: 'forbidden' });

  let correctLeadEmail: typeof import('../lib/email-sheet.js').correctLeadEmail;
  try {
    ({ correctLeadEmail } = await import('../lib/email-sheet.js'));
  } catch (err) {
    // Missing Sheet env fails module load. The correction is logged: Vercel logs are the recovery path.
    console.error(JSON.stringify({ event: 'LEAD_EMAIL_MISCONFIGURED', error: err instanceof Error ? err.message : String(err), leadId, email }));
    return json(500, { ok: false, error: 'server_misconfigured' });
  }

  const emailCheck = await checkEmailDomain(email);

  try {
    const out = await correctLeadEmail(leadId, email, emailCheck);
    if (out.status === 'not_found') return json(404, { ok: false, error: 'not_found' });
    // A retry after a write the visitor never saw succeed: the row already holds this address, checked.
    if (out.status === 'already_corrected') return json(200, { ok: true, leadId, emailOk: true });
    if (out.status === 'not_correctable') return json(409, { ok: false, error: 'not_correctable' });
    console.log(JSON.stringify({ event: 'LEAD_EMAIL_CORRECTED', leadId, row: out.row, emailCheck }));
    // Best-effort audit row after the sheet is updated; logEvents never throws, and the deadline caps
    // the time a stuck Events write can add to the response. Detail is the check result, never the address.
    await logEvents([{ event: 'Email corrected', source: 'form', leadId, detail: emailCheck }], { deadlineMs: EVENT_LOG_DEADLINE_MS });
    return json(200, { ok: true, leadId, emailOk: emailCheck !== EMAIL_CHECK.noMailServer });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (err instanceof SheetLayoutError) {
      // Nothing was written, and retrying cannot help until the header row is fixed.
      console.error(JSON.stringify({ event: 'LEAD_EMAIL_MISCONFIGURED', error, leadId, email }));
      return json(500, { ok: false, error: 'server_misconfigured' });
    }
    // The attempted correction is logged on purpose, like LEAD_WRITE_FAILED: the logs are the recovery path.
    console.error(JSON.stringify({ event: 'LEAD_EMAIL_WRITE_FAILED', error, leadId, email }));
    return json(502, { ok: false, error: 'write_failed' });
  }
}

export const GET = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
