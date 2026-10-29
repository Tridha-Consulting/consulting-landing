import { classifyChannel } from './channel.js';
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

/** Values of the Status column. `New` is written by /api/lead, `Declined` by the calendar sync (lib/calendar-sync.ts), the rest by /api/cal-webhook. */
export const STATUS = {
  new: 'New',
  booked: 'Booked',
  rescheduled: 'Rescheduled',
  cancelled: 'Cancelled',
  declined: 'Declined',
} as const;

/**
 * The one definition of the sheet layout: header text and where each value comes from.
 * While the sheet holds no data rows the layout may be reordered freely. Once it does, columns are
 * only ever appended: reordering would misalign every existing row against the new headers.
 * Call, booking and event columns are filled by /api/cal-webhook; a fresh lead from /api/lead leaves them blank.
 * The last four columns (MANUAL_HEADERS) belong to the team: the code writes them blank on a new row
 * and no updater ever addresses them.
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
  // Where the lead came from, derived from the attribution columns by lib/channel.ts when the row is written.
  { header: 'Channel', value: (l) => classifyChannel(l) },
  { header: 'twclid', value: (l) => l.twclid ?? '' },
  // Google Ads click ids for iOS traffic that cannot carry a gclid: gbraid (app-to-web) and wbraid (web-to-app).
  { header: 'gbraid', value: (l) => l.gbraid ?? '' },
  { header: 'wbraid', value: (l) => l.wbraid ?? '' },
  // Team-only columns: written blank, never touched by /api/lead, /api/cal-webhook or the calendar sync.
  { header: 'Call Outcome', value: () => '' },
  { header: 'Qualified', value: () => '' },
  { header: 'Setter Notes', value: () => '' },
  { header: 'Deal Value (₹)', value: () => '' },
];

export const HEADERS: string[] = COLUMNS.map((c) => c.header);

/** The columns the team fills by hand. No code path may write them after the row is appended; the describe blocks "team-only columns are never written by the webhook" (tests/cal-webhook.test.ts) and "team-only columns and trailing columns" (tests/calendar-sync.test.ts) hold that. */
export const MANUAL_HEADERS: readonly string[] = ['Call Outcome', 'Qualified', 'Setter Notes', 'Deal Value (₹)'];

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

/** Letter of the last column, so ranges like `A:AN` follow the layout instead of hard-coding it. Reads stop here, so a column the team adds to the right is never read. */
export const LAST_COLUMN_LETTER = columnLetter(HEADERS.length - 1);

/** The sheet's first row is not the header row this code was written against. */
export class SheetLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetLayoutError';
  }
}

/**
 * Throws unless the first HEADERS.length cells of `firstRow` are exactly HEADERS (cells trimmed).
 * Writes address cells by the position of a header, so against a sheet in another layout they
 * would land in the wrong columns. Anything within our columns that differs (missing, renamed,
 * reordered, inserted in the middle) throws. Cells after the last of our columns are not looked at:
 * a team member may add a column at the far right, and reads stop at LAST_COLUMN_LETTER so it is
 * never read or written. Once the sheet holds data rows our columns are still append-only (see
 * COLUMNS). The message names headers and positions only, never row data: a tab with no header row
 * has a lead there, so a found header is quoted only when it is one of ours.
 */
export function assertSheetLayout(firstRow: readonly string[] | undefined): void {
  if (!firstRow || firstRow.length === 0) {
    throw new SheetLayoutError('sheet layout mismatch: the tab has no header row; run npm run sheet-headers and paste it into A1');
  }
  const found = firstRow.slice(0, HEADERS.length).map((c) => String(c ?? '').trim());
  for (let i = 0; i < HEADERS.length; i++) {
    if (found[i] === HEADERS[i]) continue;
    const shown = found[i] === undefined || found[i] === '' ? '(empty)' : HEADERS.includes(found[i]!) ? `"${found[i]}"` : `(other text, ${found[i]!.length} characters)`;
    throw new SheetLayoutError(
      `sheet layout mismatch at column ${columnLetter(i)} (position ${i + 1}): expected "${HEADERS[i]}", found ${shown}; the first ${HEADERS.length} header cells must equal npm run sheet-headers (columns added after ${LAST_COLUMN_LETTER} are fine)`,
    );
  }
}
