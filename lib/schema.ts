import { z } from 'zod';

const attr = z.string().trim().max(500).optional();

/**
 * Country calling codes offered by js/form.js (COUNTRIES). Codes are prefix-free, so the first
 * match in "+<code><number>" is the country.
 */
export const DIAL_CODES: readonly string[] = [
  '91', '1', '44', '971', '65', '61', '966', '974', '965', '973', '968', '49', '33', '31', '41', '39',
  '34', '353', '60', '852', '81', '86', '62', '66', '64', '27', '234', '254', '880', '94', '977', '92',
];

/** Italy is the one country whose national numbers keep the leading 0. */
const KEEPS_TRUNK_ZERO = '39';

/**
 * Strip separators, then one leading trunk 0 from the national number (counterpart: nationalDigits
 * in js/form.js). The client sends "+<country code><number>".
 */
export function normalisePhone(raw: string): string {
  const compact = raw.replace(/[\s\-().]/g, '');
  if (!compact.startsWith('+')) return compact;
  const cc = DIAL_CODES.find((c) => compact.startsWith(`+${c}`));
  if (!cc || cc === KEEPS_TRUNK_ZERO) return compact;
  const national = compact.slice(cc.length + 1);
  return `+${cc}${national.startsWith('0') ? national.slice(1) : national}`;
}

/**
 * Single source of truth for an inbound lead. js/form.js mirrors these rules by name; its email
 * pattern is a copy of zod's (z.regexes.email), pinned by tests/client-parity.test.ts.
 */
export const leadSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required').max(120, 'Full name is too long'),
  email: z.string().trim().max(254, 'Email is too long').pipe(z.email('Enter a valid email')),
  phone: z
    .string()
    .transform(normalisePhone)
    .refine((v) => /^\+\d{6,15}$/.test(v), 'Enter a phone number with country code (6-15 digits)'),
  utmSource: attr,
  utmMedium: attr,
  utmCampaign: attr,
  utmContent: attr,
  utmTerm: attr,
  fbclid: attr,
  gclid: attr,
  liFatId: attr,
  referrer: attr,
  landingUrl: attr,
});

export type LeadInput = z.infer<typeof leadSchema>;
