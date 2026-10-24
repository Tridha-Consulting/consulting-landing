import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DIAL_CODES, leadSchema } from '../lib/schema.js';
import { validBody } from './helpers.js';

const formJs = readFileSync(new URL('../js/form.js', import.meta.url), 'utf8');

function clientEmailPattern(): RegExp {
  const m = formJs.match(/email: \{ max: (\d+), pattern: \/(.+)\/ \}/);
  if (!m) throw new Error('email pattern not found in js/form.js');
  return new RegExp(m[2]!);
}

describe('js/form.js mirrors lib/schema.ts', () => {
  it('uses the same email regex as the server', () => {
    expect(clientEmailPattern().source).toBe(z.regexes.email.source);
  });

  it.each([
    'asha@example.com',
    'first.last+tag@sub.example.co.in',
    "o'brien@example.com",
    'josé@example.com',
    'a@exa_mple.com',
    'a@b',
    'a b@example.com',
    'a@@example.com',
    '.a@example.com',
    'a..b@example.com',
    'a@example.c',
    '',
  ])('client and server agree on %j', (email) => {
    const client = email.length <= 254 && clientEmailPattern().test(email);
    const server = leadSchema.safeParse({ ...validBody, email }).success;
    expect(client).toBe(server);
  });

  it('offers exactly the country codes the server knows', () => {
    const codes = [...formJs.matchAll(/\['[^']+', '(\d+)'\]/g)].map((m) => m[1]);
    expect(codes.sort()).toEqual([...DIAL_CODES].sort());
  });
});
