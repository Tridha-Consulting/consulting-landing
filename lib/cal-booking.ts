import { z } from 'zod';
import { STATUS, columnIndex, formatIST, toRow, type LeadRow } from './columns.js';

// Pure booking logic for /api/cal-webhook: parse a Cal.com payload, find the lead's row in rows
// already read from the sheet, and say what to write. No I/O here; lib/cal-sheet.ts does that.

export const HANDLED_TRIGGERS = ['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'] as const;
export type BookingTrigger = (typeof HANDLED_TRIGGERS)[number];

export function isHandledTrigger(t: unknown): t is BookingTrigger {
  return (HANDLED_TRIGGERS as readonly unknown[]).includes(t);
}

const text = z.string().refine((s) => s.trim() !== '', 'blank');

const bookingSchema = z.object({
  uid: text,
  startTime: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date'),
  attendees: z
    .array(z.object({ name: z.string().nullish(), email: text, phoneNumber: z.string().nullish() }))
    .min(1),
  responses: z.record(z.string(), z.unknown()).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  rescheduleUid: z.string().nullish(),
  cancellationReason: z.string().nullish(),
});

export type Booking = z.infer<typeof bookingSchema>;

export function parseBooking(payload: unknown): { ok: true; booking: Booking } | { ok: false; issues: string[] } {
  const r = bookingSchema.safeParse(payload);
  if (r.success) return { ok: true, booking: r.data };
  return { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.') || '_'}: ${i.message}`) };
}

export function statusFor(trigger: BookingTrigger): string {
  if (trigger === 'BOOKING_CREATED') return STATUS.booked;
  if (trigger === 'BOOKING_RESCHEDULED') return STATUS.rescheduled;
  return STATUS.cancelled;
}

/** The Events-tab wording for a trigger. */
export function eventNameFor(trigger: BookingTrigger): string {
  if (trigger === 'BOOKING_CREATED') return 'Booked';
  if (trigger === 'BOOKING_RESCHEDULED') return 'Rescheduled';
  return 'Cancelled';
}

// Sheets rejects a cell over 50,000 characters, which would make the write fail on every retry.
const MAX_DETAILS_CHARS = 45_000;
const TRUNCATED = '… (truncated)';

// Cal's built-in booking fields can arrive labelled with their internal name. Maps, not object
// literals: keys come from the booking form, and "constructor" or "__proto__" must not resolve.
const BUILTIN_LABELS = new Map([
  ['location', 'Location'],
  ['guests', 'Guests'],
  ['additional_guests', 'Guests'],
  ['notes', 'Notes'],
  ['rescheduleReason', 'Reschedule reason'],
  ['title', 'Meeting title'],
]);

/** Labels Cal itself uses internally; anything else is owner-written text and is kept verbatim. */
const INTERNAL_LABELS = new Set(['location', 'notes', 'guests', 'additional_guests', 'rescheduleReason', 'what_is_this_meeting_about']);

const LOCATIONS = new Map([
  ['integrations:google:meet', 'Google Meet'],
  ['integrations:daily', 'Cal Video'],
  ['integrations:zoom', 'Zoom'],
  ['integrations:office365_video', 'Microsoft Teams'],
]);

/** A location as text: a known integration by name, else the option (address, number) or the value. */
function locationText(v: unknown): string {
  const isObject = typeof v === 'object' && v !== null && !Array.isArray(v);
  const value = flatten(isObject ? (v as { value?: unknown }).value : v);
  const option = isObject ? flatten((v as { optionValue?: unknown }).optionValue) : '';
  return LOCATIONS.get(value) ?? (option || value);
}

function labelFor(key: string, label: unknown): string {
  const given = typeof label === 'string' ? label.trim() : '';
  const builtin = BUILTIN_LABELS.get(key);
  // Relabel only a blank label or one that is just the field's own key or a Cal-internal name.
  if (builtin && (!given || given === key || INTERNAL_LABELS.has(given))) return builtin;
  return given || key;
}

/** A response value as one line of text: arrays joined, objects reduced to their `value`. */
function flatten(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.replace(/\s*\n\s*/g, ' ').trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(flatten).filter(Boolean).join(', ');
  if (typeof v === 'object') return flatten((v as { value?: unknown }).value);
  return '';
}

// Already in their own columns, so repeating them in Booking Details is noise.
const IDENTITY_FIELDS = new Set(['name', 'email', 'attendeePhoneNumber']);

/**
 * Cal field identifier (the `responses` key) -> sheet header: the one place that says which
 * booking-form answer lands in which column. A Map, not an object literal: keys come from the
 * public booking form, and "constructor" or "__proto__" must not resolve. An identifier missing
 * here (a typo in Cal) is not lost: it falls through to Booking Details and is logged as unmapped.
 */
export const ANSWER_COLUMNS: ReadonlyMap<string, string> = new Map([
  ['designation', 'Designation'],
  ['company', 'Company'],
  ['website', 'Website'],
  ['revenue', 'Annual Revenue'],
  ['budget', 'Budget (3-6 Months)'],
  ['bottleneck', 'Bottleneck'],
  ['tech_team', 'Tech Team'],
  ['timeline', 'Timeline'],
  ['decision_maker', 'Decision Maker'],
]);

/** Cal may write an identifier with hyphens where we use underscores (tech-team for tech_team). */
function isAnswerKey(key: string): boolean {
  return ANSWER_COLUMNS.has(key.replaceAll('-', '_'));
}

// Fields Cal adds itself; a custom field outside this set and ANSWER_COLUMNS is worth a log line.
const BUILTIN_KEYS = new Set(['location', 'notes', 'guests', 'additional_guests', 'rescheduleReason', 'title', 'what_is_this_meeting_about']);

function responseValue(booking: Booking, key: string): string {
  const responses = booking.responses;
  if (!responses || !Object.hasOwn(responses, key)) return '';
  return flatten((responses[key] as { value?: unknown } | null | undefined)?.value);
}

/** Cuts text to fit a Sheets cell without leaving half of a surrogate pair (an emoji) at the cut. */
function capCell(all: string): string {
  if (all.length <= MAX_DETAILS_CHARS) return all;
  let cut = MAX_DETAILS_CHARS - TRUNCATED.length;
  if (/[\uD800-\uDBFF]/.test(all[cut - 1] ?? '')) cut--;
  return all.slice(0, cut) + TRUNCATED;
}

/**
 * One `Label: value` line per non-empty response that has no column of its own, plus the
 * cancellation reason on cancel.
 */
export function bookingDetails(booking: Booking, trigger: BookingTrigger): string {
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(booking.responses ?? {})) {
    if (IDENTITY_FIELDS.has(key) || isAnswerKey(key)) continue;
    const e = (entry ?? {}) as { label?: unknown; value?: unknown };
    const value = key === 'location' ? locationText(e.value) : flatten(e.value);
    if (!value) continue;
    lines.push(`${labelFor(key, e.label)}: ${value}`);
  }
  const reason = booking.cancellationReason?.trim();
  if (trigger === 'BOOKING_CANCELLED' && reason) lines.push(`Cancellation reason: ${reason}`);
  return capCell(lines.join('\n'));
}

export interface AnswerCell {
  header: string;
  value: string;
}

/** The mapped booking-form answers that carry a value, one per column. Empty answers are omitted. */
export function bookingAnswers(booking: Booking): AnswerCell[] {
  const out: AnswerCell[] = [];
  for (const [key, header] of ANSWER_COLUMNS) {
    // The underscore spelling wins when both carry a value.
    const value = capCell(responseValue(booking, key) || responseValue(booking, key.replaceAll('_', '-')));
    if (value) out.push({ header, value });
  }
  return out;
}

/** Custom response keys that carry a value but map to no column, so the owner can spot a mistyped identifier. */
export function unmappedKeys(booking: Booking): string[] {
  return Object.entries(booking.responses ?? {})
    .filter(([key, entry]) => !IDENTITY_FIELDS.has(key) && !BUILTIN_KEYS.has(key) && !isAnswerKey(key) && flatten((entry as { value?: unknown } | null)?.value) !== '')
    .map(([key]) => key);
}

export type MatchedBy = 'leadId' | 'uid' | 'email' | 'appended';

export interface BookingCells {
  status: string;
  callTime: string;
  details: string;
  /** Mapped booking-form answers with a value; an empty answer is never written, so it cannot blank a cell. */
  answers: AnswerCell[];
  /** First booking time: set on BOOKING_CREATED only, and on update only when the cell is empty; '' means the cell is left alone. */
  bookedAt: string;
  uid: string;
  /** Envelope `createdAt` as received; '' when the event carried none (the cell is then left alone). */
  lastEventAt: string;
}

export type Plan = (
  | { action: 'update'; row: number; matchedBy: Exclude<MatchedBy, 'appended'>; cells: BookingCells }
  | { action: 'append'; matchedBy: 'appended'; values: string[] }
  /**
   * Not written: either the event is older than the one already applied to the row ('event'), or
   * it cancels a booking the row no longer holds ('cancellation'), whatever the timestamps say.
   */
  | { action: 'stale'; row: number; matchedBy: Exclude<MatchedBy, 'appended'>; reason: 'event' | 'cancellation' }
) & {
  /** Set when a timestamp was ignored for being more than a day ahead of the server clock. */
  warn?: string;
  /** Custom response keys with a value but no column (see unmappedKeys); absent when there are none. */
  unmapped?: string[];
};

const COL = {
  email: columnIndex('Email'),
  leadId: columnIndex('Lead ID'),
  uid: columnIndex('Booking UID'),
  lastEventAt: columnIndex('Last Event At'),
  bookedAt: columnIndex('Booked At (IST)'),
};

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * A timestamp for ordering, or undefined (treated as missing). Date.parse alone accepts text such
 * as "follow up 2027", and the cell is free text a setter can edit, so only strict ISO-8601
 * counts. One more than a day ahead of the server clock is skew or junk, and would freeze the row.
 */
function stamp(s: string | undefined, now: Date): { ms?: number; future?: boolean } {
  if (!s || !ISO_DATETIME.test(s)) return {};
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return {};
  return ms - now.getTime() > MAX_FUTURE_SKEW_MS ? { future: true } : { ms };
}

function cell(row: string[], index: number): string {
  return (row[index] ?? '').trim();
}

function findRow(
  rows: string[][],
  bookingUids: string[],
  leadId: string,
  email: string,
): { index: number; by: 'leadId' | 'uid' | 'email' } | undefined {
  // Row index 0 is the header row. leadId and the email come from the public booking form, so
  // they can spell a header ("Lead ID", "Email"); the header is never matched or written.
  if (leadId) {
    for (let i = 1; i < rows.length; i++) {
      if (cell(rows[i]!, COL.leadId) === leadId) return { index: i, by: 'leadId' };
    }
  }
  for (let i = rows.length - 1; i >= 1; i--) {
    const uid = cell(rows[i]!, COL.uid);
    if (uid && bookingUids.includes(uid)) return { index: i, by: 'uid' };
  }
  const wanted = email.trim().toLowerCase();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (cell(rows[i]!, COL.email).toLowerCase() === wanted) return { index: i, by: 'email' };
  }
  return undefined;
}

/**
 * Decides what to write for one booking event. `rows` is the sheet as read, header row included,
 * so row number = index + 1. Replaying the same event lands on the same row: an appended booking
 * carries its uid, so the second delivery matches it instead of appending again. `eventAt` is the
 * webhook envelope `createdAt`: an event strictly older than the row's Last Event At is stale.
 */
export function planBooking(rows: string[][], trigger: BookingTrigger, booking: Booking, now: Date, eventAt?: string): Plan {
  const attendee = booking.attendees[0]!;
  const event = stamp(eventAt, now);
  const cells: BookingCells = {
    status: statusFor(trigger),
    callTime: formatIST(new Date(booking.startTime)),
    details: bookingDetails(booking, trigger),
    answers: bookingAnswers(booking),
    // A usable envelope time says when the booking was made; otherwise the server clock does.
    bookedAt: trigger === 'BOOKING_CREATED' ? formatIST(event.ms !== undefined ? new Date(event.ms) : now) : '',
    uid: booking.uid.trim(),
    // Stored only when usable for ordering, so a junk createdAt never lands in the sheet.
    lastEventAt: event.ms !== undefined ? eventAt! : '',
  };
  const unmappedList = unmappedKeys(booking);
  const unmapped = unmappedList.length ? unmappedList : undefined;
  const warns: string[] = [];
  if (event.future) warns.push('event_createdAt_in_future');

  const metaLeadId = booking.metadata?.leadId;
  const leadId = typeof metaLeadId === 'string' ? metaLeadId.trim() : '';
  const uids = [cells.uid];
  if (trigger === 'BOOKING_RESCHEDULED' && booking.rescheduleUid?.trim()) uids.push(booking.rescheduleUid.trim());

  const found = findRow(rows, uids, leadId, attendee.email);
  if (found) {
    const row = rows[found.index]!;
    const applied = stamp(cell(row, COL.lastEventAt), now);
    if (applied.future) warns.push('row_last_event_in_future');
    const warn = warns.length ? warns.join(',') : undefined;
    const stale = (reason: 'event' | 'cancellation'): Plan => ({
      action: 'stale', row: found.index + 1, matchedBy: found.by, reason, warn, unmapped,
    });
    // A late or replayed event must not revert newer state (if both timestamps are usable).
    if (event.ms !== undefined && applied.ms !== undefined && event.ms < applied.ms) return stale('event');
    // A cancel applies only to the booking the row holds; a cancel of an earlier booking must not
    // mark a live one Cancelled. This holds whatever the timestamps say.
    const current = cell(row, COL.uid);
    if (trigger === 'BOOKING_CANCELLED' && current && current !== cells.uid) return stale('cancellation');
    // Booked At records the first booking and never moves: a filled cell is left alone, so a replay
    // or a re-book after a cancel keeps the original time.
    const keep = cell(row, COL.bookedAt) !== '';
    return { action: 'update', row: found.index + 1, matchedBy: found.by, cells: keep ? { ...cells, bookedAt: '' } : cells, warn, unmapped };
  }

  const lead: LeadRow = {
    fullName: attendee.name?.trim() || responseValue(booking, 'name'),
    email: attendee.email.trim(),
    phone: responseValue(booking, 'attendeePhoneNumber') || attendee.phoneNumber?.trim() || '',
    leadId: `cal-${cells.uid}`,
    submittedAt: now,
    userAgent: '',
    ip: '',
  };
  const values = toRow(lead);
  values[columnIndex('Status')] = cells.status;
  values[columnIndex('Call Time (IST)')] = cells.callTime;
  values[columnIndex('Booked At (IST)')] = cells.bookedAt;
  values[columnIndex('Booking Details')] = cells.details;
  values[columnIndex('Booking UID')] = cells.uid;
  values[COL.lastEventAt] = cells.lastEventAt;
  for (const a of cells.answers) values[columnIndex(a.header)] = a.value;
  return { action: 'append', matchedBy: 'appended', values, warn: warns.length ? warns.join(',') : undefined, unmapped };
}
