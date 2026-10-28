import { BOTTLENECK_OPTIONS, type LeadInput } from './schema.js';

/** Qualification answers. A lead from the site form always has them; a row built from a Cal booking alone may not. */
type AnswerKey = 'designation' | 'company' | 'website' | 'revenue' | 'budget' | 'bottleneck' | 'techTeam' | 'timeline' | 'decisionMaker';

/** A validated lead plus server-side fields. */
export interface LeadRow extends Omit<LeadInput, AnswerKey>, Partial<Pick<LeadInput, AnswerKey>> {
  leadId: string;
  submittedAt: Date;
  userAgent: string;
  ip: string;
}

export interface Column {
  header: string;
  value: (lead: LeadRow) => string;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** `YYYY-MM-DD HH:mm:ss` in Asia/Kolkata (fixed +05:30, no DST). */
export function formatIST(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

/** Values of the Status column. `New` is written by /api/lead, the rest by /api/cal-webhook. */
export const STATUS = {
  new: 'New',
  booked: 'Booked',
  rescheduled: 'Rescheduled',
  cancelled: 'Cancelled',
} as const;

/**
 * The one definition of the sheet layout: header text and where each value comes from.
 * While the sheet holds no data rows the layout may be reordered freely. Once it does, columns are
 * only ever appended: reordering would misalign every existing row against the new headers.
 * Call, booking and event columns are filled by /api/cal-webhook; a fresh lead from /api/lead leaves them blank.
 */
export const COLUMNS: readonly Column[] = [
  { header: 'Submitted At (IST)', value: (l) => formatIST(l.submittedAt) },
  { header: 'Full Name', value: (l) => l.fullName },
  { header: 'Email', value: (l) => l.email },
  { header: 'Phone', value: (l) => l.phone },
  { header: 'Status', value: () => STATUS.new },
  { header: 'Call Time (IST)', value: () => '' },
  // When the booking was made (its BOOKING_CREATED event), as opposed to when the call is.
  { header: 'Booked At (IST)', value: () => '' },
  // One column per qualification answer. /api/lead fills them from the site form. A booking updating
  // that row only writes a column when Cal sent a non-empty answer for it, and a lead created from a
  // booking alone gets them from lib/cal-booking.ts (ANSWER_COLUMNS) if the event type asks such questions.
  { header: 'Designation', value: (l) => l.designation ?? '' },
  { header: 'Company', value: (l) => l.company ?? '' },
  { header: 'Website', value: (l) => l.website ?? '' },
  { header: 'Annual Revenue', value: (l) => l.revenue ?? '' },
  { header: 'Budget (3-6 Months)', value: (l) => l.budget ?? '' },
  // Selections joined in the order of BOTTLENECK_OPTIONS, not the order they were ticked.
  { header: 'Bottleneck', value: (l) => BOTTLENECK_OPTIONS.filter((o) => l.bottleneck?.includes(o)).join('; ') },
  { header: 'Tech Team', value: (l) => l.techTeam ?? '' },
  { header: 'Timeline', value: (l) => l.timeline ?? '' },
  { header: 'Decision Maker', value: (l) => l.decisionMaker ?? '' },
  // Booking answers that have no column of their own, plus the cancellation reason.
  { header: 'Booking Details', value: () => '' },
  { header: 'UTM Source', value: (l) => l.utmSource ?? '' },
  { header: 'UTM Medium', value: (l) => l.utmMedium ?? '' },
  { header: 'UTM Campaign', value: (l) => l.utmCampaign ?? '' },
  { header: 'UTM Content', value: (l) => l.utmContent ?? '' },
  { header: 'UTM Term', value: (l) => l.utmTerm ?? '' },
  { header: 'fbclid', value: (l) => l.fbclid ?? '' },
  { header: 'gclid', value: (l) => l.gclid ?? '' },
  { header: 'li_fat_id', value: (l) => l.liFatId ?? '' },
  { header: 'Referrer', value: (l) => l.referrer ?? '' },
  { header: 'Landing URL', value: (l) => l.landingUrl ?? '' },
  { header: 'User Agent', value: (l) => l.userAgent },
  { header: 'IP', value: (l) => l.ip },
  { header: 'Lead ID', value: (l) => l.leadId },
  { header: 'Booking UID', value: () => '' },
  // `createdAt` of the last webhook event applied, so a late or replayed older event is ignored.
  { header: 'Last Event At', value: () => '' },
];

export const HEADERS: string[] = COLUMNS.map((c) => c.header);

export function toRow(lead: LeadRow): string[] {
  return COLUMNS.map((c) => c.value(lead));
}

/** Zero-based position of a header in the sheet; throws on a typo so a bad name fails loudly. */
export function columnIndex(header: string): number {
  const i = HEADERS.indexOf(header);
  if (i < 0) throw new Error(`unknown sheet column: ${header}`);
  return i;
}

/** A1-notation letters for a zero-based column index: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Letter of the last column, so ranges like `A:AF` follow the layout instead of hard-coding it. */
export const LAST_COLUMN_LETTER = columnLetter(HEADERS.length - 1);

/** The sheet's first row is not the header row this code was written against. */
export class SheetLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetLayoutError';
  }
}

/**
 * Throws unless `firstRow` is exactly HEADERS (cells trimmed, same length). Writes address cells by
 * the position of a header, so against a sheet in another layout they would land in the wrong
 * columns. The message names headers and positions only, never row data: a tab with no header row
 * has a lead there, so a found header is quoted only when it is one of ours.
 */
export function assertSheetLayout(firstRow: readonly string[] | undefined): void {
  if (!firstRow || firstRow.length === 0) {
    throw new SheetLayoutError('sheet layout mismatch: the tab has no header row; run npm run sheet-headers and paste it into A1');
  }
  const found = firstRow.map((c) => String(c ?? '').trim());
  const width = Math.max(found.length, HEADERS.length);
  for (let i = 0; i < width; i++) {
    if (found[i] === HEADERS[i]) continue;
    const shown = found[i] === undefined || found[i] === '' ? '(empty)' : HEADERS.includes(found[i]!) ? `"${found[i]}"` : `(other text, ${found[i]!.length} characters)`;
    throw new SheetLayoutError(
      `sheet layout mismatch at column ${columnLetter(i)} (position ${i + 1}): expected ${HEADERS[i] === undefined ? '(nothing)' : `"${HEADERS[i]}"`}, found ${shown}; the header row must equal npm run sheet-headers`,
    );
  }
}
