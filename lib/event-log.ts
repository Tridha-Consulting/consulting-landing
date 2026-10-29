import { formatIST } from './columns.js';

// The audit log: one row per lead event on its own tab (EVENTS_TAB, default "Events"), so the Leads
// tab can stay "current state" while history (who was Booked, when it was Declined) is kept.
// Best-effort by design: a failed log write is reported in the logs and never reaches the caller.

/** Header row of the Events tab, in column order. `npm run sheet-headers` prints it. */
export const EVENT_HEADERS: readonly string[] = [
  'At (IST)',
  'Lead ID',
  'Event',
  'Status From',
  'Status To',
  'Call Time (IST)',
  'Booking UID',
  'Source',
  'Detail',
];

/**
 * How long a caller waits for the log write. The write is awaited so a serverless function is not
 * frozen mid-request, so this bounds the latency the log can add to /api/lead, the webhook and the
 * calendar sync; the Sheets default (WRITE_DEADLINE_MS) would let a stuck write cost 8 seconds.
 */
export const EVENT_LOG_DEADLINE_MS = 2000;

/** Which part of the system wrote the event. */
export type EventSource = 'form' | 'cal' | 'google-calendar';

export interface LeadEvent {
  event: string;
  source: EventSource;
  leadId?: string;
  statusFrom?: string;
  statusTo?: string;
  callTime?: string;
  bookingUid?: string;
  detail?: string;
}

/** One Events row; the time is when the event is recorded. */
export function eventRow(e: LeadEvent, at: Date): string[] {
  return [
    formatIST(at),
    e.leadId ?? '',
    e.event,
    e.statusFrom ?? '',
    e.statusTo ?? '',
    e.callTime ?? '',
    e.bookingUid ?? '',
    e.source,
    e.detail ?? '',
  ];
}

/**
 * Appends one row per event in a single request. Never rejects: any failure, including missing
 * Sheet configuration, is logged once per event as EVENT_LOG_WRITE_FAILED and swallowed, so the
 * lead, webhook or sync that called this behaves exactly as if logging were off. The Sheets client
 * is imported here, at call time, so this module (and scripts that only print EVENT_HEADERS) loads
 * without credentials, and missing environment is a logged failure rather than a crash in the caller.
 */
export async function logEvents(
  events: readonly LeadEvent[],
  { now = new Date(), deadlineMs }: { now?: Date; deadlineMs?: number } = {},
): Promise<void> {
  if (events.length === 0) return;
  try {
    const { WRITE_DEADLINE_MS, eventsTabRef, sheetsRequest, withDeadline } = await import('./sheets-client.js');
    await withDeadline(
      'events write',
      deadlineMs ?? WRITE_DEADLINE_MS,
      (signal) =>
        sheetsRequest(
          {
            path: `/values/${encodeURIComponent(`${eventsTabRef()}!A1`)}:append`,
            method: 'POST',
            // RAW so text that arrived from a visitor or an attendee is stored, never evaluated as a formula.
            params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
            data: { values: events.map((e) => eventRow(e, now)) },
          },
          signal,
        ),
      // A 4xx (a missing Events tab is a 400) proves the token worked, so it must not cost every later lead a token fetch.
      { keepClientOnHttp4xx: true },
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Identifiers only: the event name and lead id, never a name, email or answer.
    for (const e of events) {
      console.error(JSON.stringify({ event: 'EVENT_LOG_WRITE_FAILED', eventName: e.event, ...(e.leadId && { leadId: e.leadId }), error }));
    }
  }
}
