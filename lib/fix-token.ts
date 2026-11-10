import { createHmac, timingSafeEqual } from 'node:crypto';

// The credential /api/lead hands out with an `emailOk: false` answer and /api/lead-email requires, so
// only the visitor whose lead was just saved can ask for the email correction (a lead id alone is not
// enough, and an unauthenticated caller cannot make the endpoint read the Sheet).

/** Names the MAC's purpose, so the same secret signs nothing else the same way. */
const DOMAIN = 'lead-email:';

/** The secret that keys the token: CRON_SECRET, shared with /api/calendar-cron (see README, environment variables). */
function secret(): string | undefined {
  return process.env.CRON_SECRET?.trim() || undefined;
}

/** True when tokens can be issued and checked. */
export function fixTokensConfigured(): boolean {
  return secret() !== undefined;
}

/** base64url HMAC-SHA256 over `lead-email:<leadId>`; undefined when CRON_SECRET is unset. */
export function fixTokenFor(leadId: string): string | undefined {
  const key = secret();
  return key === undefined ? undefined : createHmac('sha256', key).update(DOMAIN + leadId).digest('base64url');
}

/** Constant-time check of a token against the one for `leadId`; false when none can be issued. */
export function validFixToken(leadId: string, token: unknown): boolean {
  const expected = fixTokenFor(leadId);
  if (expected === undefined || typeof token !== 'string') return false;
  const given = Buffer.from(token);
  const want = Buffer.from(expected);
  // timingSafeEqual throws on unequal lengths, so a wrong-length token is rejected first.
  return given.length === want.length && timingSafeEqual(given, want);
}
