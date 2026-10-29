import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BOTTLENECK_OPTIONS,
  BUDGET_OPTIONS,
  DECISION_MAKER_OPTIONS,
  DIAL_CODES,
  REVENUE_OPTIONS,
  TECH_TEAM_OPTIONS,
  TIMELINE_OPTIONS,
  leadSchema,
} from '../lib/schema.js';
import { validBody } from './helpers.js';

const formJs = readFileSync(new URL('../js/form.js', import.meta.url), 'utf8');

function clientEmailPattern(): RegExp {
  const m = formJs.match(/email: \{ max: (\d+), pattern: \/(.+)\/ \}/);
  if (!m) throw new Error('email pattern not found in js/form.js');
  return new RegExp(m[2]!);
}

/** The OPTIONS object literal of js/form.js, evaluated. It is our own source, in a test. */
function clientOptions(): Record<string, string[]> {
  const m = formJs.match(/var OPTIONS = (\{[\s\S]*?\n  \});/);
  if (!m) throw new Error('OPTIONS not found in js/form.js');
  return new Function(`return ${m[1]}`)() as Record<string, string[]>;
}

function clientRule(field: string): { min: number; max: number } {
  const m = formJs.match(new RegExp(`${field}: \\{ min: (\\d+), max: (\\d+) \\}`));
  if (!m) throw new Error(`rule ${field} not found in js/form.js`);
  return { min: Number(m[1]), max: Number(m[2]) };
}

/** Every file a browser loads for the page, to prove the internal budget notes never ship. */
function clientFiles(dir: string): string[] {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const out = [join(root, 'index.html'), join(root, 'book.html')];
  for (const f of readdirSync(join(root, dir))) out.push(join(root, dir, f));
  return out;
}

describe('js/form.js phone rule is a subset of the server rule, not a mirror', () => {
  // The client only knows the India shape (10 digits, first 6-9); libphonenumber-js is not bundled.
  // The server is the backstop, so a client-accepted number may still get a server 400 on the field.
  it('every Indian number the client rule would accept has the shape the server expects', () => {
    expect(formJs).toContain(String.raw`dial === '91' && !/^[6-9]\d{9}$/.test(national)`);
    for (const n of ['9876543210', '7045152625', '6000000000', '9999999999', '8123456789']) {
      expect(leadSchema.safeParse({ ...validBody, phone: `+91${n}` }).success, n).toBe(true);
    }
  });
});

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

  it('offers exactly the option lists the server accepts, same strings, same order', () => {
    const client = clientOptions();
    expect(Object.keys(client).sort()).toEqual(['bottleneck', 'budget', 'decisionMaker', 'revenue', 'techTeam', 'timeline']);
    expect(client.revenue).toEqual([...REVENUE_OPTIONS]);
    expect(client.budget).toEqual([...BUDGET_OPTIONS]);
    expect(client.bottleneck).toEqual([...BOTTLENECK_OPTIONS]);
    expect(client.techTeam).toEqual([...TECH_TEAM_OPTIONS]);
    expect(client.timeline).toEqual([...TIMELINE_OPTIONS]);
    expect(client.decisionMaker).toEqual([...DECISION_MAKER_OPTIONS]);
  });

  it('every client option is accepted by the server', () => {
    const client = clientOptions();
    for (const [field, options] of Object.entries(client)) {
      for (const o of options) {
        const value = field === 'bottleneck' ? [o] : o;
        expect(leadSchema.safeParse({ ...validBody, [field]: value }).success, `${field}: ${o}`).toBe(true);
      }
    }
  });

  it('asks the questions the spec lists', () => {
    for (const q of [
      "What is your company's current annual revenue?",
      'To implement custom AI or scale your tech infrastructure, what is your approved investment budget for the next 3-6 months?',
      "What is the biggest operational bottleneck currently slowing down your company's growth? (Select up to two)",
      'Do you have an in-house development/tech team?',
      'If we identify a clear ROI path to automate your bottlenecks, how soon are you looking to initiate the project?',
      'Are you the primary decision-maker for financial investments in your company?',
    ]) {
      expect(formJs).toContain(q);
    }
  });

  it('uses the same text length limits as the server', () => {
    for (const field of ['fullName', 'designation', 'company', 'website'] as const) {
      const { min, max } = clientRule(field);
      expect(min).toBe(1);
      expect(leadSchema.safeParse({ ...validBody, [field]: 'a'.repeat(max) }).success, `${field} at max`).toBe(true);
      expect(leadSchema.safeParse({ ...validBody, [field]: 'a'.repeat(max + 1) }).success, `${field} over max`).toBe(false);
    }
  });

  it('never ships the internal budget notes', () => {
    for (const file of [...clientFiles('js'), ...clientFiles('css')]) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/Fractional CTO/i);
      expect(text, file).not.toMatch(/\bICP\b/);
    }
  });

  it('offers exactly the country codes the server knows', () => {
    const codes = [...formJs.matchAll(/\['[^']+', '(\d+)'\]/g)].map((m) => m[1]);
    expect(codes.sort()).toEqual([...DIAL_CODES].sort());
  });
});
