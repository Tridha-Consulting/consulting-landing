import { describe, expect, it } from 'vitest';
import {
  BOTTLENECK_OPTIONS,
  BUDGET_OPTIONS,
  DECISION_MAKER_OPTIONS,
  REVENUE_OPTIONS,
  TECH_TEAM_OPTIONS,
  TIMELINE_OPTIONS,
  leadSchema,
  normalisePhone,
} from '../lib/schema.js';
import { validBody } from './helpers.js';

describe('leadSchema', () => {
  it('accepts a valid lead', () => {
    expect(leadSchema.safeParse(validBody).success).toBe(true);
  });

  it('normalises phone separators', () => {
    const r = leadSchema.parse({ ...validBody, phone: '+91 98123-45678' });
    expect(r.phone).toBe('+919812345678');
  });

  it('rejects a missing name', () => {
    expect(leadSchema.safeParse({ ...validBody, fullName: undefined }).success).toBe(false);
    expect(leadSchema.safeParse({ ...validBody, fullName: '   ' }).success).toBe(false);
  });

  it('rejects a bad email', () => {
    expect(leadSchema.safeParse({ ...validBody, email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects a short phone, one without country code, or one too long', () => {
    expect(leadSchema.safeParse({ ...validBody, phone: '+9112' }).success).toBe(false);
    expect(leadSchema.safeParse({ ...validBody, phone: '9812345678' }).success).toBe(false);
    expect(leadSchema.safeParse({ ...validBody, phone: '+9198123456781234' }).success).toBe(false);
  });

  it('rejects oversize fields', () => {
    expect(leadSchema.safeParse({ ...validBody, fullName: 'a'.repeat(121) }).success).toBe(false);
    expect(leadSchema.safeParse({ ...validBody, utmSource: 'a'.repeat(501) }).success).toBe(false);
    expect(leadSchema.safeParse({ ...validBody, referrer: 'a'.repeat(501) }).success).toBe(false);
  });

  it('rejects emails with non-ASCII local parts or underscores in the domain', () => {
    expect(leadSchema.safeParse({ ...validBody, email: 'josé@example.com' }).success).toBe(false);
    expect(leadSchema.safeParse({ ...validBody, email: 'a@exa_mple.com' }).success).toBe(false);
  });
});

const CHOICES = {
  revenue: REVENUE_OPTIONS,
  budget: BUDGET_OPTIONS,
  techTeam: TECH_TEAM_OPTIONS,
  timeline: TIMELINE_OPTIONS,
  decisionMaker: DECISION_MAKER_OPTIONS,
} as const;

const ANSWER_FIELDS = ['designation', 'company', 'website', 'revenue', 'budget', 'bottleneck', 'techTeam', 'timeline', 'decisionMaker'] as const;

describe('leadSchema qualification answers', () => {
  it('has the agreed option lists, in order', () => {
    expect(REVENUE_OPTIONS).toEqual(['Upto ₹5 Crores', '₹5 Crores – ₹20 Crores', '₹20 Crores – ₹50 Crores', '₹50 Crores+']);
    expect(BUDGET_OPTIONS).toEqual(['Less than ₹5 Lakhs', '₹5 Lakhs – ₹15 Lakhs', '₹15 Lakhs – ₹50 Lakhs', '₹50 Lakhs+']);
    expect(DECISION_MAKER_OPTIONS).toEqual(['Yes, I sign off on budgets.', 'No']);
    expect(BOTTLENECK_OPTIONS).toEqual([
      'High manual labor/payroll costs in operations or customer support',
      'Slow turnaround times (sales follow-ups, client deliverables, manual data entry)',
      'Lack of a senior technical leader (CTO) to guide our tech roadmap',
      "Inefficient internal systems that don't speak to each other",
    ]);
    expect(TECH_TEAM_OPTIONS).toEqual([
      'Yes, we have a full dev team.',
      'Yes, but they lack AI expertise/are overwhelmed.',
      'No, we rely entirely on external vendors or manual processes.',
    ]);
    expect(TIMELINE_OPTIONS).toEqual([
      'Immediately (Within the next 15-30 days)',
      'Within the next 2-3 months',
      'Just researching/No immediate timeline',
    ]);
  });

  it.each(Object.entries(CHOICES))('%s accepts every option and rejects an unknown one', (field, options) => {
    for (const o of options) expect(leadSchema.safeParse({ ...validBody, [field]: o }).success).toBe(true);
    expect(leadSchema.safeParse({ ...validBody, [field]: 'Something else' }).success).toBe(false);
    expect(leadSchema.safeParse({ ...validBody, [field]: options[0].toLowerCase() }).success).toBe(false);
    expect(leadSchema.safeParse({ ...validBody, [field]: ` ${options[0]}` }).success).toBe(false);
  });

  it('accepts every single bottleneck option and one pair', () => {
    for (const o of BOTTLENECK_OPTIONS) expect(leadSchema.safeParse({ ...validBody, bottleneck: [o] }).success).toBe(true);
    expect(leadSchema.safeParse({ ...validBody, bottleneck: [BOTTLENECK_OPTIONS[3], BOTTLENECK_OPTIONS[1]] }).success).toBe(true);
  });

  it('rejects an unknown bottleneck option', () => {
    expect(leadSchema.safeParse({ ...validBody, bottleneck: ['Something else'] }).success).toBe(false);
    expect(leadSchema.safeParse({ ...validBody, bottleneck: [BOTTLENECK_OPTIONS[0], 'Something else'] }).success).toBe(false);
  });

  it.each(ANSWER_FIELDS)('rejects a missing %s', (field) => {
    const r = leadSchema.safeParse({ ...validBody, [field]: undefined });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path[0])).toEqual([field]);
  });

  it('rejects zero, three or duplicate bottleneck selections with "Select one or two"', () => {
    const three = [BOTTLENECK_OPTIONS[0], BOTTLENECK_OPTIONS[1], BOTTLENECK_OPTIONS[2]];
    for (const bottleneck of [[], three, [BOTTLENECK_OPTIONS[0], BOTTLENECK_OPTIONS[0]], BOTTLENECK_OPTIONS[0], null]) {
      const r = leadSchema.safeParse({ ...validBody, bottleneck });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.map((i) => i.message)).toContain('Select one or two');
    }
  });

  it('trims text answers and enforces 1..max', () => {
    expect(leadSchema.parse({ ...validBody, designation: '  CEO  ', company: ' Acme ', website: ' acme.com ' })).toMatchObject({
      designation: 'CEO',
      company: 'Acme',
      website: 'acme.com',
    });
    const limits = { designation: 120, company: 120, website: 200 } as const;
    for (const [field, max] of Object.entries(limits)) {
      expect(leadSchema.safeParse({ ...validBody, [field]: 'a'.repeat(max) }).success).toBe(true);
      expect(leadSchema.safeParse({ ...validBody, [field]: 'a'.repeat(max + 1) }).success).toBe(false);
      expect(leadSchema.safeParse({ ...validBody, [field]: '   ' }).success).toBe(false);
      expect(leadSchema.safeParse({ ...validBody, [field]: '' }).success).toBe(false);
    }
  });

  it('does not format-check the website', () => {
    expect(leadSchema.safeParse({ ...validBody, website: 'not a url at all' }).success).toBe(true);
  });

  it('gives a readable message per missing answer', () => {
    const r = leadSchema.safeParse({});
    expect(r.success).toBe(false);
    if (r.success) return;
    const byField = new Map(r.error.issues.map((i) => [String(i.path[0]), i.message]));
    for (const f of ANSWER_FIELDS) {
      expect(byField.get(f), f).toBeDefined();
      expect(byField.get(f), f).not.toMatch(/invalid input|expected/i);
    }
  });
});

describe('phone validity (libphonenumber-js max metadata)', () => {
  const phoneOk = (phone: string) => leadSchema.safeParse({ ...validBody, phone }).success;

  it('rejects +912932838188, the number Cal.com refused', () => {
    const r = leadSchema.safeParse({ ...validBody, phone: '+912932838188' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('Enter a valid phone number');
    expect(r.error?.issues[0]?.path).toEqual(['phone']);
  });

  it.each([
    '+919876543210', // India
    '+917045152625',
    '+916000000000',
    '+919999999999',
    '+447911123456', // UK mobile
    '+442071838750', // UK London
    '+14155552671', // US
    '+971501234567', // UAE
    '+6591234567', // Singapore
    '+390612345678', // Italy keeps the 0 (landline)
  ])('accepts %s', (n) => {
    expect(phoneOk(n)).toBe(true);
  });

  it.each([
    '+912932838188',
    '+910000000000',
    '+1234567890',
    '+614123456789', // Australian mobile with an extra digit
    '+9112', // passes the length shape check only on paper; too short anyway
  ])('rejects %s', (n) => {
    expect(phoneOk(n)).toBe(false);
  });

  it('validates after normalisation (trunk zero, separators)', () => {
    expect(phoneOk('+91 098765-43210')).toBe(true);
    expect(phoneOk('+44 (0) 7911 123456')).toBe(true);
  });
});

describe('normalisePhone trunk zero', () => {
  it.each([
    ['+9109812345678', '+919812345678'],
    ['+44 07911 123456', '+447911123456'],
    ['+971 0501234567', '+971501234567'],
    ['+3906 1234 5678', '+390612345678'], // Italy keeps the 0
    ['+919812345678', '+919812345678'],
    ['+9100812345678', '+910812345678'], // only one 0 is stripped
  ])('%s -> %s', (raw, expected) => {
    expect(normalisePhone(raw)).toBe(expected);
  });

  it('is applied by the schema', () => {
    expect(leadSchema.parse({ ...validBody, phone: '+44 07911 123456' }).phone).toBe('+447911123456');
  });
});
