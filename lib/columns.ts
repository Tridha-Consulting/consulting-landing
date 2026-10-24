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

/** The one definition of the sheet layout: header text and where each value comes from. */
export const COLUMNS: readonly Column[] = [
  { header: 'Submitted At (IST)', value: (l) => formatIST(l.submittedAt) },
  { header: 'Full Name', value: (l) => l.fullName },
  { header: 'Email', value: (l) => l.email },
  { header: 'Phone', value: (l) => l.phone },
  { header: 'Status', value: () => 'New' },
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
];

export const HEADERS: string[] = COLUMNS.map((c) => c.header);

export function toRow(lead: LeadRow): string[] {
  return COLUMNS.map((c) => c.value(lead));
}
