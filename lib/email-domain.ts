import { Resolver } from 'node:dns/promises';

/**
 * Whether the domain of an email address can receive mail. Cal.com refuses a booking whose attendee
 * domain cannot (HTTP 400 `email_domain_cannot_receive_mail`), so /api/lead asks first and the form
 * lets the visitor fix the address before the calendar opens. The result is written to the Email
 * Check column; the lead is saved whatever it is.
 */
export const EMAIL_CHECK = {
  ok: 'OK',
  noMailServer: 'No mail server',
  unchecked: 'Unchecked',
} as const;

export type EmailCheck = (typeof EMAIL_CHECK)[keyof typeof EMAIL_CHECK];

/** The part of node's Resolver that is used, so a test can inject a fake one. */
export interface MxResolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  /** Abandons queries still in flight; called when the overall deadline passes. */
  cancel?(): void;
}

export interface EmailDomainDeps {
  resolver?: MxResolver;
  /** Upper bound on the whole check, whatever the resolver does. */
  deadlineMs?: number;
}

/** One DNS query gets this long and is not retried. */
const QUERY_TIMEOUT_MS = 1500;
/** The whole check, so a hung resolver cannot stall /api/lead. */
export const EMAIL_CHECK_DEADLINE_MS = 2000;

/** DNS answers that mean the name has no mail exchanger, as opposed to the lookup itself failing. */
const NO_MAIL_CODES = new Set(['ENOTFOUND', 'ENODATA']);

function defaultResolver(): MxResolver {
  return new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 1 });
}

/** The domain after the last "@", lower-cased and without a trailing dot; '' when there is none. */
function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
}

/** An exchanger that can take mail: not empty and not the "." of a null MX (RFC 7505). */
function isUsableExchange(exchange: string): boolean {
  const e = exchange.trim();
  return e !== '' && e !== '.';
}

async function lookup(resolver: MxResolver, domain: string): Promise<EmailCheck> {
  try {
    const records = await resolver.resolveMx(domain);
    return records.some((r) => isUsableExchange(r.exchange)) ? EMAIL_CHECK.ok : EMAIL_CHECK.noMailServer;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    // Timeouts, SERVFAIL, a refused connection and anything else are our DNS trouble, not the lead's.
    return typeof code === 'string' && NO_MAIL_CODES.has(code) ? EMAIL_CHECK.noMailServer : EMAIL_CHECK.unchecked;
  }
}

/**
 * Looks up the MX records of the email's domain. Never rejects and never blocks a lead on a
 * lookup that did not finish: 'No mail server' is returned only on a definite answer (no such
 * domain, no MX records, or a null MX); every other outcome is 'Unchecked'.
 */
export async function checkEmailDomain(email: string, { resolver, deadlineMs = EMAIL_CHECK_DEADLINE_MS }: EmailDomainDeps = {}): Promise<EmailCheck> {
  const domain = domainOf(email);
  if (!domain) return EMAIL_CHECK.unchecked;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Built inside the try: a resolver that cannot be constructed is 'Unchecked', never a lost lead.
    const active = resolver ?? defaultResolver();
    const deadline = new Promise<EmailCheck>((resolve) => {
      timer = setTimeout(() => {
        try {
          active.cancel?.();
        } catch {
          // The answer is already 'Unchecked'.
        }
        resolve(EMAIL_CHECK.unchecked);
      }, deadlineMs);
    });
    return await Promise.race([lookup(active, domain), deadline]);
  } catch {
    return EMAIL_CHECK.unchecked;
  } finally {
    clearTimeout(timer);
  }
}
