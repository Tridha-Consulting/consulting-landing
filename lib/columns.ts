import type { LeadInput } from './schema.js';

/** A validated lead plus server-side fields. */
export interface LeadRow extends LeadInput {
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

/** The one definition of the sheet layout: header text and where each value comes from. */
export const COLUMNS: readonly Column[] = [
  { header: 'Submitted At (IST)', value: (l) => formatIST(l.submittedAt) },
  { header: 'Full Name', value: (l) => l.fullName },
  { header: 'Email', value: (l) => l.email },
  { header: 'Phone', value: (l) => l.phone },
  { header: 'Status', value: () => STATUS.new },
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
  // Filled by /api/cal-webhook; a fresh lead has not booked yet. Append only, never reorder.
  { header: 'Call Time (IST)', value: () => '' },
  { header: 'Booking Details', value: () => '' },
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

/** Letter of the last column, so ranges like `A:U` follow the layout instead of hard-coding it. */
export const LAST_COLUMN_LETTER = columnLetter(HEADERS.length - 1);
