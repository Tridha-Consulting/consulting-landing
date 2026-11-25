import { formatIST } from './ist.js';

// Failure alerts: one plain-text email to the team through the Zoho mailbox, sent from the failure paths of
// the API endpoints. Vercel's Hobby plan keeps logs for about an hour, so a lead that fails to save at night
// would otherwise be found too late to recover from the logs. See README "Failure alerts".

export interface Alert {
  /** The log event the alert mirrors, e.g. `LEAD_WRITE_FAILED`. */
  event: string;
  /** Short subject; the `[consulting.tridha.net]` prefix is added here. */
  subject: string;
  /** What went wrong, in plain words, shown first in the body. */
  summary?: string;
  error?: string;
  /** Printed as indented JSON; a lost lead carries every field of the lead here so it can be re-entered by hand. */
  details?: unknown;
  /** An alert with the same key is sent at most once per THROTTLE_MS on one server instance. */
  dedupeKey?: string;
}

/** The whole send, import and connection included, finishes or is abandoned within this time. */
export const ALERT_DEADLINE_MS = 6000;
export const THROTTLE_MS = 10 * 60 * 1000;
export const MAX_BODY_BYTES = 60 * 1024;
/**
 * Events a stranger can reach without any credential (a valid-looking lead while the server is misconfigured),
 * each with its own key, so the per-key throttle alone would not bound them: at most this many mails per
 * THROTTLE_MS on one instance, whatever the keys.
 */
export const WINDOW_CAPS: Readonly<Record<string, number>> = { LEAD_SINK_MISCONFIGURED: 5, LEAD_CAPTCHA_UNAVAILABLE: 5 };
const MAX_SUBJECT_CHARS = 150;
const SUBJECT_PREFIX = '[consulting.tridha.net] ';
const DEFAULT_USER = 'consulting@tridha.net';
const DEFAULT_HOST = 'smtp.zoho.in';

/**
 * The platform's request context, found where @vercel/functions looks for it (its get-context.js). Reading the
 * symbol here keeps that package, and the load time it adds, out of every endpoint;
 * tests/wait-until-contract.test.ts pins this lookup to the package's own waitUntil.
 */
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
type RequestContext = { waitUntil?: (promise: Promise<unknown>) => void };

/** nodemailer, loaded by the first alert and shared by the alerts that follow, which may run at once. */
let mailer: Promise<typeof import('nodemailer')> | undefined;
let noWaitUntilLogged = false;

/** When each throttle key was last sent. */
const sentAt = new Map<string, number>();
/** When each capped event was sent, within the window. */
const capSends = new Map<string, number[]>();

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logFailure(alertEvent: string, err: unknown): void {
  console.error(JSON.stringify({ event: 'ALERT_SEND_FAILED', alertEvent, error: message(err) }));
}

/** One line: control characters (CR and LF included) become spaces, so a name can never add a mail header. */
function subjectLine(subject: string): string {
  const clean = subject.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  // By code point, so the cut never splits a surrogate pair.
  return Array.from(SUBJECT_PREFIX + clean)
    .slice(0, MAX_SUBJECT_CHARS)
    .join('');
}

/** Cuts `text` to at most `maxBytes` of UTF-8 without splitting a character. */
function truncateBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  // Back up to a character boundary: continuation bytes are 10xxxxxx.
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function stringifyDetails(details: unknown): string {
  try {
    return JSON.stringify(details, null, 2) ?? String(details);
  } catch (err) {
    return `(details could not be serialised: ${message(err)})`;
  }
}

/** The plain-text body: what failed, when (IST), the error, then the details. A `notice` goes right after the summary. */
export function alertBody(alert: Alert, now: Date = new Date(), notice?: string): string {
  const lines = [alert.summary ?? `Something failed on consulting.tridha.net (${alert.event}).`];
  if (notice) lines.push('', notice);
  lines.push('', `Event: ${alert.event}`, `Time (IST): ${formatIST(now)}`);
  if (alert.error) lines.push(`Error: ${alert.error}`);
  if (alert.details !== undefined) lines.push('', 'Details:', stringifyDetails(alert.details));
  const body = lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') <= MAX_BODY_BYTES) return body;
  return `${truncateBytes(body, MAX_BODY_BYTES)}\n\n[truncated: the body was cut at ${MAX_BODY_BYTES / 1024} KB; the full text is in the Vercel logs]`;
}

interface Slot {
  /** True when this is the last mail the window allows for a capped event. */
  last: boolean;
  /** Gives the slot back, so a send that failed does not suppress the next attempt. */
  release(): void;
}

/** Claims the throttle key and the window cap for `alert`, or returns null when either is used up. */
function reserve(alert: Alert, now: number): Slot | null {
  for (const [k, at] of sentAt) if (now - at >= THROTTLE_MS) sentAt.delete(k);
  for (const [event, stamps] of capSends) {
    const live = stamps.filter((at) => now - at < THROTTLE_MS);
    if (live.length) capSends.set(event, live);
    else capSends.delete(event);
  }

  const key = alert.dedupeKey !== undefined ? `${alert.event}:${alert.dedupeKey}` : undefined;
  if (key !== undefined && sentAt.has(key)) return null;
  const cap = WINDOW_CAPS[alert.event];
  const stamps = capSends.get(alert.event) ?? [];
  if (cap !== undefined && stamps.length >= cap) return null;

  if (key !== undefined) sentAt.set(key, now);
  if (cap !== undefined) capSends.set(alert.event, [...stamps, now]);
  return {
    last: cap !== undefined && stamps.length + 1 === cap,
    release() {
      if (key !== undefined && sentAt.get(key) === now) sentAt.delete(key);
      const held = capSends.get(alert.event);
      const at = held?.indexOf(now) ?? -1;
      if (held && at >= 0) held.splice(at, 1);
    },
  };
}

/** Clears the throttle and the once-per-instance notice; for tests. */
export function resetAlertThrottle(): void {
  sentAt.clear();
  capSends.clear();
  noWaitUntilLogged = false;
}

/**
 * Emails `alert` to the team. Never throws and takes at most ALERT_DEADLINE_MS, import included. Without
 * ALERT_SMTP_PASS it only logs that alerts are off. Resolves true when the mail was accepted by the server,
 * false when it was skipped or failed. Endpoints call alertInBackground, not this, so a slow mail server never
 * delays a response.
 */
export async function sendAlert(alert: Alert): Promise<boolean> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let transport: { close(): void } | undefined;
  let slot: Slot | null = null;
  let loading: typeof mailer;
  let imported = false;
  try {
    // Read per call, not at module load, so the site runs unchanged without these set.
    const pass = process.env.ALERT_SMTP_PASS?.trim();
    if (!pass) {
      console.warn(JSON.stringify({ event: 'ALERT_NOT_CONFIGURED', alertEvent: alert.event }));
      return false;
    }
    slot = reserve(alert, startedAt);
    if (!slot) {
      console.warn(JSON.stringify({ event: 'ALERT_THROTTLED', alertEvent: alert.event }));
      return false;
    }
    const notice = slot.last ? 'Further alerts of this type are suppressed for 10 minutes; see the Vercel logs for any that follow.' : undefined;

    const user = process.env.ALERT_SMTP_USER?.trim() || DEFAULT_USER;
    const to = process.env.ALERT_TO?.trim() || user;
    const host = process.env.ALERT_SMTP_HOST?.trim() || DEFAULT_HOST;

    // The timer starts before the import, so loading nodemailer counts toward the deadline.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ALERT_DEADLINE_MS} ms`)), ALERT_DEADLINE_MS);
    });
    const delivery = (async () => {
      // One import for alerts that run at once. If it fails or hangs past the deadline it is forgotten below.
      loading = mailer ??= import('nodemailer');
      const nodemailer = await loading;
      imported = true;
      const created = nodemailer.createTransport({
        host,
        port: 465,
        secure: true,
        auth: { user, pass },
        connectionTimeout: ALERT_DEADLINE_MS,
        greetingTimeout: ALERT_DEADLINE_MS,
        socketTimeout: ALERT_DEADLINE_MS,
      });
      transport = created;
      await created.sendMail({
        from: user,
        to,
        subject: subjectLine(alert.subject),
        text: alertBody(alert, new Date(), notice),
        // Aborting the send is what closes an open SMTP connection; closing the transport does not.
        signal: AbortSignal.timeout(Math.max(1, ALERT_DEADLINE_MS - (Date.now() - startedAt))),
      });
    })();
    // A delivery that fails after the deadline has no one waiting on it.
    delivery.catch(() => {});
    await Promise.race([delivery, deadline]);
    return true;
  } catch (err) {
    slot?.release();
    if (!imported && mailer === loading) mailer = undefined;
    logFailure(alert.event, err);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      transport?.close();
    } catch {
      // Closing a transport that never connected can throw; the send's outcome is already settled.
    }
  }
}

/**
 * Starts the alert and returns at once: the mail is sent after the response, kept alive by the platform's
 * waitUntil (registerWaitUntil). Never throws.
 */
export function alertInBackground(alert: Alert): void {
  const sending = sendAlert(alert).catch(() => false);
  if (registerWaitUntil(sending)) return;
  // On Vercel a missing waitUntil means the mail may be cut off with the function; say so once.
  if (process.env.VERCEL && !noWaitUntilLogged) {
    noWaitUntilLogged = true;
    console.error(JSON.stringify({ event: 'ALERT_NO_WAITUNTIL', alertEvent: alert.event }));
  }
}

/**
 * Asks the platform to keep the function alive until `promise` settles. False when there is no request
 * context to ask (local runs, tests), in which case the promise simply runs on. Never throws.
 */
export function registerWaitUntil(promise: Promise<unknown>): boolean {
  try {
    const store = (globalThis as Record<symbol, { get?: () => RequestContext | undefined } | undefined>)[REQUEST_CONTEXT];
    const context = store?.get?.();
    if (typeof context?.waitUntil !== 'function') return false;
    context.waitUntil(promise);
    return true;
  } catch {
    return false;
  }
}
