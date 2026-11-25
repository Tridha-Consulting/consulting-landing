import { formatIST } from './columns.js';

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

/** The whole send, connection included, finishes or is abandoned within this time. */
export const ALERT_DEADLINE_MS = 6000;
export const THROTTLE_MS = 10 * 60 * 1000;
export const MAX_BODY_BYTES = 60 * 1024;
const MAX_SUBJECT_CHARS = 150;
const SUBJECT_PREFIX = '[consulting.tridha.net] ';
const DEFAULT_USER = 'consulting@tridha.net';
const DEFAULT_HOST = 'smtp.zoho.in';

const sentAt = new Map<string, number>();

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logFailure(alertEvent: string, err: unknown): void {
  console.error(JSON.stringify({ event: 'ALERT_SEND_FAILED', alertEvent, error: message(err) }));
}

/** One line: control characters (CR and LF included) become spaces, so a name can never add a mail header. */
function subjectLine(subject: string): string {
  const clean = subject.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (SUBJECT_PREFIX + clean).slice(0, MAX_SUBJECT_CHARS);
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

/** The plain-text body: what failed, when (IST), the error, then the details. */
export function alertBody(alert: Alert, now: Date = new Date()): string {
  const lines = [alert.summary ?? `Something failed on consulting.tridha.net (${alert.event}).`, '', `Event: ${alert.event}`, `Time (IST): ${formatIST(now)}`];
  if (alert.error) lines.push(`Error: ${alert.error}`);
  if (alert.details !== undefined) lines.push('', 'Details:', stringifyDetails(alert.details));
  const body = lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') <= MAX_BODY_BYTES) return body;
  return `${truncateBytes(body, MAX_BODY_BYTES)}\n\n[truncated: the body was cut at ${MAX_BODY_BYTES / 1024} KB; the full text is in the Vercel logs]`;
}

/** True when `key` was already sent inside the window; otherwise records it as sent now. */
function throttled(key: string, now: number): boolean {
  for (const [k, at] of sentAt) if (now - at >= THROTTLE_MS) sentAt.delete(k);
  if (sentAt.has(key)) return true;
  sentAt.set(key, now);
  return false;
}

/** Clears the throttle; for tests. */
export function resetAlertThrottle(): void {
  sentAt.clear();
}

/**
 * Emails `alert` to the team. Never throws and takes at most ALERT_DEADLINE_MS, so a caller can await it on
 * a failure path without changing its response. Without ALERT_SMTP_PASS it only logs that alerts are off.
 * Resolves true when the mail was accepted by the server, false when it was skipped or failed.
 */
export async function sendAlert(alert: Alert): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let transport: { close(): void } | undefined;
  try {
    // Read per call, not at module load, so the site runs unchanged without these set.
    const pass = process.env.ALERT_SMTP_PASS?.trim();
    if (!pass) {
      console.warn(JSON.stringify({ event: 'ALERT_NOT_CONFIGURED', alertEvent: alert.event }));
      return false;
    }
    if (alert.dedupeKey !== undefined && throttled(`${alert.event}:${alert.dedupeKey}`, Date.now())) {
      console.warn(JSON.stringify({ event: 'ALERT_THROTTLED', alertEvent: alert.event }));
      return false;
    }

    const user = process.env.ALERT_SMTP_USER?.trim() || DEFAULT_USER;
    const to = process.env.ALERT_TO?.trim() || user;
    const host = process.env.ALERT_SMTP_HOST?.trim() || DEFAULT_HOST;

    const nodemailer = await import('nodemailer');
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

    const send = created.sendMail({ from: user, to, subject: subjectLine(alert.subject), text: alertBody(alert) });
    // Without a handler, a send that fails after the deadline would be an unhandled rejection.
    send.catch(() => {});
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ALERT_DEADLINE_MS} ms`)), ALERT_DEADLINE_MS);
    });
    await Promise.race([send, deadline]);
    return true;
  } catch (err) {
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
