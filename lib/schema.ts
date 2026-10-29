import { isValidPhoneNumber } from 'libphonenumber-js/max';
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
 * Option lists of the qualification questions, in display order. The server is the contract:
 * js/form.js mirrors these strings by copy and tests/client-parity.test.ts pins the copies.
 * The cell written to the sheet is the option text itself.
 */
export const REVENUE_OPTIONS = [
  'Upto ₹5 Crores',
  '₹5 Crores – ₹20 Crores',
  '₹20 Crores – ₹50 Crores',
  '₹50 Crores+',
] as const;

export const BUDGET_OPTIONS = [
  'Less than ₹5 Lakhs',
  '₹5 Lakhs – ₹15 Lakhs',
  '₹15 Lakhs – ₹50 Lakhs',
  '₹50 Lakhs+',
] as const;

export const BOTTLENECK_OPTIONS = [
  'High manual labor/payroll costs in operations or customer support',
  'Slow turnaround times (sales follow-ups, client deliverables, manual data entry)',
  'Lack of a senior technical leader (CTO) to guide our tech roadmap',
  "Inefficient internal systems that don't speak to each other",
] as const;

export const TECH_TEAM_OPTIONS = [
  'Yes, we have a full dev team.',
  'Yes, but they lack AI expertise/are overwhelmed.',
  'No, we rely entirely on external vendors or manual processes.',
] as const;

export const TIMELINE_OPTIONS = [
  'Immediately (Within the next 15-30 days)',
  'Within the next 2-3 months',
  'Just researching/No immediate timeline',
] as const;

export const DECISION_MAKER_OPTIONS = ['Yes, I sign off on budgets.', 'No'] as const;

/** A required free-text answer, trimmed, 1..max characters. */
function answerText(label: string, max: number) {
  return z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} is too long`);
}

/** A required single choice from a fixed list. */
function choice<const T extends readonly [string, ...string[]]>(options: T, label: string) {
  return z.enum(options, { error: `Choose ${label}` });
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
    .refine((v) => /^\+\d{6,15}$/.test(v), 'Enter a phone number with country code (6-15 digits)')
    // "max" metadata, not the default "min": min accepts +912932838188 (a landline-shaped Indian
    // number) which Cal.com's phone field then rejects, so only max agrees with the booking step.
    .refine((v) => isValidPhoneNumber(v), 'Enter a valid phone number'),
  designation: answerText('Designation', 120),
  company: answerText('Company name', 120),
  website: answerText('Company website', 200),
  revenue: choice(REVENUE_OPTIONS, 'your annual revenue'),
  budget: choice(BUDGET_OPTIONS, 'your budget'),
  bottleneck: z
    .array(z.enum(BOTTLENECK_OPTIONS, { error: 'Select one or two' }), { error: 'Select one or two' })
    .min(1, 'Select one or two')
    .max(2, 'Select one or two')
    .refine((v) => new Set(v).size === v.length, 'Select one or two'),
  techTeam: choice(TECH_TEAM_OPTIONS, 'an option'),
  timeline: choice(TIMELINE_OPTIONS, 'an option'),
  decisionMaker: choice(DECISION_MAKER_OPTIONS, 'an option'),
  utmSource: attr,
  utmMedium: attr,
  utmCampaign: attr,
  utmContent: attr,
  utmTerm: attr,
  fbclid: attr,
  gclid: attr,
  liFatId: attr,
  twclid: attr,
  gbraid: attr,
  wbraid: attr,
  referrer: attr,
  landingUrl: attr,
});

export type LeadInput = z.infer<typeof leadSchema>;
