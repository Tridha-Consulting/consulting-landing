import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getExampleNumber, type CountryCode } from 'libphonenumber-js/max';
import mobileExamples from 'libphonenumber-js/mobile/examples';
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

type ClientPhone = {
  normalisePhone: (dial: string, value: string) => string;
  validate: (field: string, value: string, dial: string) => string;
};

/** js/form.js's phone code (COUNTRIES, RULES and its validation section), evaluated. It is our own source, in a test. */
function clientPhone(): ClientPhone {
  const countries = formJs.match(/var COUNTRIES = \[[\s\S]*?\];/);
  const rules = formJs.match(/var RULES = \{[\s\S]*?\n  \};/);
  const section = formJs.match(/\/\* -{10} validation -{10} \*\/([\s\S]*?)\/\* -{10} DOM helpers -{10} \*\//);
  if (!countries || !rules || !section) throw new Error('phone code not found in js/form.js');
  return new Function(`${countries[0]}\n${rules[0]}\n${section[1]}\nreturn { normalisePhone: normalisePhone, validate: validate };`)() as ClientPhone;
}

const client = clientPhone();

/** What the server stores for a phone value, or null when it answers 400 on the field. */
function serverPhone(phone: string): string | null {
  const r = leadSchema.safeParse({ ...validBody, phone });
  return r.success ? r.data.phone : null;
}

/** Region per offered country code, for libphonenumber's example numbers. */
const REGIONS: Record<string, CountryCode> = {
  '91': 'IN', '1': 'US', '44': 'GB', '971': 'AE', '65': 'SG', '61': 'AU', '966': 'SA', '974': 'QA', '965': 'KW',
  '973': 'BH', '968': 'OM', '49': 'DE', '33': 'FR', '31': 'NL', '41': 'CH', '39': 'IT', '34': 'ES', '353': 'IE',
  '60': 'MY', '852': 'HK', '81': 'JP', '86': 'CN', '62': 'ID', '66': 'TH', '64': 'NZ', '27': 'ZA', '234': 'NG',
  '254': 'KE', '880': 'BD', '94': 'LK', '977': 'NP', '92': 'PK',
};

function exampleMobile(dial: string) {
  const n = getExampleNumber(REGIONS[dial]!, mobileExamples);
  if (!n) throw new Error(`no example number for +${dial}`);
  return n;
}

/** 10-digit national numbers with first digits 1-9, from a fixed seed so a failure reproduces. A first 0
 * is left out: typed after a trunk 0 it makes "00", which another test covers. */
function sampleNationals(count: number): string[] {
  let x = 20261116;
  const next = () => (x = (x * 1103515245 + 12345) % 2147483648);
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(String(1 + (i % 9)) + String(next() % 1e9).padStart(9, '0'));
  return out;
}

/** How the server stores the fictitious mobile 98765 43210 that the phone tests type in each shape. */
const IN_STORED = '+919876543210';

/** Left-to-right embedding and its pop: an Android or WhatsApp copy of a number wraps it in these, unseen. */
const LRE = '‪';
const PDF = '‬';

/** The ways a visitor types, or pastes, one Indian number into the field. */
function indianShapes(n: string): string[] {
  const spaced = `${n.slice(0, 5)} ${n.slice(5)}`;
  return [n, `0${n}`, `0${spaced}`, `91${n}`, `0091 ${n}`, `+91${n}`, `+91 ${spaced}`, `+91-${n.slice(0, 5)}-${n.slice(5)}`, `(+91) ${spaced}`, `+91 0${n}`,
    `${LRE}${spaced}${PDF}`, `${LRE}+91 ${spaced}${PDF}`, `‎${n}`];
}

describe('js/form.js phone rules against lib/schema.ts, run', () => {
  it('drops the same trunk zeros as the server (Italy keeps them)', () => {
    expect(serverPhone('+91009876543210')).toBe(IN_STORED);
    expect(client.normalisePhone('91', '+91009876543210')).toBe(IN_STORED);
    expect(client.normalisePhone('44', '+44 07400 123456')).toBe(serverPhone('+44 07400 123456'));
    expect(client.normalisePhone('39', '06 1234 5678')).toBe('+390612345678');
    expect(client.normalisePhone('91', '+39 06 1234 5678')).toBe('+390612345678');
    expect(serverPhone('+39 06 1234 5678')).toBe('+390612345678');
    // "00" before a third 0 is not the international prefix: all three are trunk zeros, as on the server.
    expect(client.normalisePhone('91', '000 98765 43210')).toBe(IN_STORED);
    expect(serverPhone('+91 000 98765 43210')).toBe(IN_STORED);
  });

  it('India: every typed form of a number the server takes is taken and sent as the server stores it; the rest are refused on both sides', () => {
    let taken = 0;
    for (const n of sampleNationals(2000)) {
      const stored = serverPhone(`+91${n}`);
      // The browser's India rule is the server's own: 10 digits, first 6-9, and libphonenumber takes every such number.
      expect(stored !== null, n).toBe(/^[6-9]\d{9}$/.test(n));
      if (stored) taken++;
      for (const dial of ['91', '44']) {
        for (const typed of indianShapes(n)) {
          // With another dropdown only the forms that carry the code (+91, 0091) are Indian.
          if (dial !== '91' && !/^(\+|\(\+|00)/.test(typed.replace(/[‎‪‬]/g, ''))) continue;
          expect(client.normalisePhone(dial, typed), `${dial} ${typed}`).toBe(stored ?? '');
        }
      }
    }
    expect(taken).toBeGreaterThan(700);
  });

  it('India: numbers of the wrong length or first digit are refused on both sides', () => {
    for (const n of ['5876543210', '2932838188', '0000000000', '1234567890', '98765', '987654321', '98765432101', '915876543210']) {
      expect(client.normalisePhone('91', n), n).toBe('');
      expect(client.validate('phone', n, '91'), n).toBe('Please enter a valid phone number.');
      expect(serverPhone(`+91${n}`), n).toBeNull();
    }
  });

  it('a number typed with "+" and its country code is sent exactly as the server stores it, whatever the dropdown; so is one typed with "00" unless India is selected', () => {
    const typed = [
      ...DIAL_CODES.map((d) => exampleMobile(d).formatInternational()),
      // Countries the dropdown does not list: their codes are sent as typed.
      ...(['RU', 'TR', 'BR', 'KR', 'MX', 'EG', 'PH', 'VN'] as const).map((r) => getExampleNumber(r, mobileExamples)!.formatInternational()),
      '+44 (0)7400 123456', '+1 212 555 0123',
    ];
    for (const t of typed) {
      const stored = serverPhone(t);
      expect(stored, t).not.toBeNull();
      for (const dial of ['91', '1', '971', '39']) {
        expect(client.normalisePhone(dial, t), `${dial} ${t}`).toBe(stored);
        if (dial !== '91') expect(client.normalisePhone(dial, t.replace('+', '00')), `${dial} ${t} with 00`).toBe(stored);
      }
      // With India selected "00" brings only India's own code (0091); digits that make an Indian mobile are
      // that mobile (see the next test), and every other number typed with "00" is refused.
      const digits = t.replace(/\D/g, '');
      const withIndia = stored!.startsWith('+91') ? stored : /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : '';
      expect(client.normalisePhone('91', t.replace('+', '00')), `91 ${t} with 00`).toBe(withIndia);
    }
  });

  it('a number typed in national form with its country in the dropdown is sent as the server stores the same number', () => {
    for (const dial of DIAL_CODES) {
      const n = exampleMobile(dial);
      expect(n.countryCallingCode, dial).toBe(dial);
      expect(client.normalisePhone(dial, n.formatNational()), `${dial} ${n.formatNational()}`).toBe(serverPhone(n.number));
      expect(serverPhone(n.number), n.number).toBe(n.number);
    }
  });

  it('outside India the browser checks only the length, so libphonenumber on the server is the one to refuse a bad number', () => {
    // A UK mobile one digit short passes the browser, typed with the code or with the UK in the dropdown.
    expect(client.normalisePhone('91', '+44 7911 12345')).toBe('+44791112345');
    expect(serverPhone('+44791112345')).toBeNull();
    expect(client.normalisePhone('44', '7911 12345')).toBe('+44791112345');
  });

  it('with India selected, "00" and an Indian mobile is the mobile with a trunk 0 typed twice; only "+" and "0091" are international', () => {
    // Spaced or not, the two zeros before a mobile are dropped, and the server stores what is sent.
    for (const shape of ['009876543210', '00 98765 43210', '0 0 98765 43210', '0-0-98765-43210', '‪00 98765 43210‬']) {
      expect(client.normalisePhone('91', shape), shape).toBe(IN_STORED);
    }
    expect(serverPhone(IN_STORED)).toBe(IN_STORED);
    // A mobile that starts 91 is the mobile, not India's code and 8 digits.
    const starts91 = '9123456789';
    expect(client.normalisePhone('91', `00${starts91}`)).toBe(`+91${starts91}`);
    expect(serverPhone(`+91${starts91}`)).toBe(`+91${starts91}`);
    // "0091" and "+91" are India's code, trunk 0 or not.
    for (const shape of ['0091 9876543210', '0091 09876543210', '00 91 98765 43210', '+91 98765 43210']) {
      expect(client.normalisePhone('91', shape), shape).toBe(IN_STORED);
    }
    // Every 10-digit mobile typed after "00" is sent as that Indian mobile, never as a foreign number.
    let mobiles = 0;
    for (const n of sampleNationals(2000).filter((x) => /^[6-9]/.test(x))) {
      mobiles++;
      expect(client.normalisePhone('91', `00${n}`), n).toBe(`+91${n}`);
      expect(client.normalisePhone('91', `00 ${n.slice(0, 5)} ${n.slice(5)}`), n).toBe(`+91${n}`);
    }
    expect(mobiles).toBeGreaterThan(800);
    // Any other "00" number is refused in the browser; typed with "+" the same number is sent.
    for (const [typed, plus] of [['00971501234567', '+971501234567'], ['0044 7911 123456', '+447911123456'], ['00 92 300 1234567', '+923001234567']]) {
      expect(client.normalisePhone('91', typed!), typed).toBe('');
      expect(client.validate('phone', typed!, '91'), typed).toBe('Please enter a valid phone number.');
      expect(client.normalisePhone('91', plus!), plus).toBe(plus);
      expect(serverPhone(plus!), plus).toBe(plus);
    }
    // Indian digits of the wrong length or first digit after "00" are refused too.
    for (const typed of ['005876543210', '0098765', '00915876543210']) {
      expect(client.normalisePhone('91', typed), typed).toBe('');
    }
  });

  it('with another country selected, "00" is still the international prefix, whatever digits follow', () => {
    expect(client.normalisePhone('44', '00971501234567')).toBe('+971501234567');
    expect(client.normalisePhone('971', '0044 7911 123456')).toBe('+447911123456');
    // The digits of an Indian mobile after "00" start a country code, as they would be dialled.
    expect(client.normalisePhone('44', '009876543210')).toBe('+9876543210');
    expect(client.normalisePhone('44', '0091 9876543210')).toBe(IN_STORED);
  });

  it('drops spaces, dashes, dots and parentheses, pasted typographic ones included', () => {
    const chars = { noBreakSpace: 0xa0, nonBreakingHyphen: 0x2011, enDash: 0x2013, emDash: 0x2014, minus: 0x2212 };
    for (const [name, code] of Object.entries(chars)) {
      const sep = String.fromCharCode(code);
      expect(client.normalisePhone('91', `+91${sep}98765${sep}43210`), name).toBe(IN_STORED);
    }
    expect(client.normalisePhone('91', '(0) 98765.43210')).toBe(IN_STORED);
    expect(client.normalisePhone('91', '98765/43210')).toBe('');
  });

  it('drops the invisible characters a pasted number carries, so a number that looks right is taken', () => {
    const invisible = {
      softHyphen: 0xad, arabicLetterMark: 0x61c, zeroWidthSpace: 0x200b, zeroWidthNonJoiner: 0x200c, zeroWidthJoiner: 0x200d,
      leftToRightMark: 0x200e, rightToLeftMark: 0x200f, leftToRightEmbedding: 0x202a, rightToLeftEmbedding: 0x202b,
      popDirectionalFormatting: 0x202c, leftToRightOverride: 0x202d, rightToLeftOverride: 0x202e, wordJoiner: 0x2060,
      leftToRightIsolate: 0x2066, rightToLeftIsolate: 0x2067, firstStrongIsolate: 0x2068, popDirectionalIsolate: 0x2069, byteOrderMark: 0xfeff,
    };
    for (const [name, code] of Object.entries(invisible)) {
      const c = String.fromCharCode(code);
      const shapes: [string, string][] = [['91', `${c}98765${c}43210${c}`], ['91', `${c}+91 98765 43210${c}`], ['44', `${c}+91 98765 43210${c}`], ['91', `${c}0091 9876543210`]];
      for (const [dial, shape] of shapes) {
        expect(client.normalisePhone(dial, shape), `${name} ${dial} ${shape}`).toBe(IN_STORED);
        expect(client.validate('phone', shape, dial), `${name} ${dial} ${shape}`).toBe('');
      }
      // Alone they leave the field as empty as it looks.
      expect(client.validate('phone', `${c}${c}`, '91'), name).toBe('Please enter your phone number.');
    }
    expect(client.normalisePhone('91', `${LRE}+971 50 123 4567${PDF}`)).toBe('+971501234567');
  });

  it('a typed country code needs 8 to 15 digits with the code, and an empty field keeps its own message', () => {
    expect(client.normalisePhone('91', '+44 7911 1')).toBe('');
    expect(client.normalisePhone('91', '+44 7911 12')).toBe('+44791112');
    expect(client.normalisePhone('91', '+7 123 456')).toBe('');
    expect(client.normalisePhone('91', '+7 1234 567')).toBe('+71234567');
    expect(client.normalisePhone('91', '+7 1234 5678 9012 34')).toBe('+712345678901234');
    expect(client.normalisePhone('91', '+7 1234 5678 9012 345')).toBe('');
    expect(client.normalisePhone('91', '+0 1234 5678')).toBe('');
    expect(client.validate('phone', '', '91')).toBe('Please enter your phone number.');
    expect(client.validate('phone', '   ', '91')).toBe('Please enter your phone number.');
    for (const v of ['---', '()', '+', 'abcdefghij', '98765 abc 43210', '+91 98765 43210 x2']) {
      expect(client.validate('phone', v, '91'), v).toBe('Please enter a valid phone number.');
    }
  });
});

describe('js/form.js attribution mirrors lib/schema.ts', () => {
  it('captures a fixed set of query parameters, twclid, gbraid and wbraid among them', () => {
    const m = formJs.match(/var ATTR_PARAMS = \[([^\]]+)\]/);
    expect(m, 'ATTR_PARAMS not found in js/form.js').not.toBeNull();
    const params = [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(params).toEqual(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'li_fat_id', 'twclid', 'gbraid', 'wbraid']);
  });

  it('sends only keys the schema knows, and every attribution key the schema has', () => {
    const body = formJs.match(/function attributionPayload\(\) \{[\s\S]*?return \{([\s\S]*?)\};/);
    expect(body, 'attributionPayload not found in js/form.js').not.toBeNull();
    const sent = [...body![1]!.matchAll(/(\w+): a\./g)].map((x) => x[1]!).sort();
    const attribution = Object.keys(leadSchema.shape).filter((k) => /^(utm|fbclid|gclid|gbraid|wbraid|liFatId|twclid|referrer|landingUrl)/.test(k)).sort();
    expect(sent).toEqual(attribution);
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
