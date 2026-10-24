import { describe, expect, it } from 'vitest';
import { leadSchema, normalisePhone } from '../lib/schema.js';
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
