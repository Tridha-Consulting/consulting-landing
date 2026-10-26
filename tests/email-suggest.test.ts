import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* package.json is "type": "module", so require() would parse the browser script as ESM and skip its
   CommonJS export. Evaluate it with a CommonJS module shim instead; this exercises the same branch. */
const src = readFileSync(new URL('../js/email-suggest.js', import.meta.url), 'utf8');
const cjs: { exports: unknown } = { exports: {} };
new Function('module', src)(cjs);
const suggestEmail = cjs.exports as (e: string) => string | null;

const TYPOS: Record<string, string[]> = {
  'gmail.com': ['gmial.com', 'gmai.com', 'gmil.com', 'gmaill.com', 'gamil.com', 'gnail.com', 'gmile.com', 'gmali.com', 'gmal.com', 'gmail.co', 'gmail.con', 'gmail.cm', 'gmail.om', 'gmail.comh', 'gmail.coom', 'gmail.in'],
  'yahoo.com': ['yaho.com', 'yahooo.com', 'yahho.com', 'yhoo.com', 'yahoo.co', 'yahoo.con'],
  'hotmail.com': ['hotmial.com', 'hotmal.com', 'hotmai.com', 'hotmail.co', 'hotmail.con'],
  'outlook.com': ['outlok.com', 'outllook.com', 'outlook.co', 'outlook.con'],
  'icloud.com': ['icloud.co', 'iclod.com', 'icoud.com'],
  'rediffmail.com': ['rediffmail.co', 'redifmail.com', 'rediffmai.com']
};
const typoRows = Object.entries(TYPOS).flatMap(([good, bad]) => bad.map((d) => [d, good] as const));

const KNOWN = ['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com', 'rocketmail.com', 'outlook.com', 'outlook.in', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'rediffmail.com', 'zohomail.in', 'zoho.com', 'protonmail.com', 'proton.me', 'mail.com', 'gmx.com', 'yandex.com'];
const BUSINESS = ['tridha.net', 'example.com', 'acme.co.in', 'infosys.com', 'tcs.com', 'wipro.com', 'gail.co.in', 'iitb.ac.in'];
// Real domains the fuzzy rule must leave alone: lookalike names and providers on regional TLDs.
const REAL_LOOKALIKES = ['email.com', 'cloud.com', 'ecloud.com', 'gail.com', 'yahoo.ca', 'yahoo.no', 'yahoo.ch', 'hotmail.ca', 'hotmail.no', 'outlook.cz', 'outlook.cl', 'yahoo.co.uk', 'hotmail.co.uk', 'gmail.co.in'];

describe('suggestEmail', () => {
  it.each(typoRows)('explicit typo %s -> %s', (bad, good) => {
    expect(suggestEmail(`asha@${bad}`)).toBe(`asha@${good}`);
  });

  it('preserves local part case and +tag, normalises domain case/space', () => {
    expect(suggestEmail('Asha.K+ads@GMILE.com')).toBe('Asha.K+ads@gmail.com');
    expect(suggestEmail('a@b@gmial.com')).toBe('a@b@gmail.com');
  });

  it.each([
    ['gmail.comm', 'gmail.com'],
    ['gmail.comx', 'gmail.com'],
    ['gmaik.com', 'gmail.com'],
    ['yahooo.co', 'yahoo.com'],
    ['hotmaill.com', 'hotmail.com']
  ])('fuzzy %s -> %s', (bad, good) => {
    expect(suggestEmail(`x@${bad}`)).toBe(`x@${good}`);
  });

  it.each(KNOWN)('known domain %s -> null', (d) => {
    expect(suggestEmail(`x@${d}`)).toBeNull();
  });

  it.each(BUSINESS)('business domain %s -> null', (d) => {
    expect(suggestEmail(`x@${d}`)).toBeNull();
  });

  it.each(REAL_LOOKALIKES)('real lookalike domain %s -> null', (d) => {
    expect(suggestEmail(`x@${d}`)).toBeNull();
  });

  it('corrects at most two edits', () => {
    expect(suggestEmail('x@gmaiiil.com')).toBe('x@gmail.com');
    expect(suggestEmail('x@gmaiiiil.com')).toBeNull();
  });

  it('still corrects a slipped .com on a provider name', () => {
    expect(suggestEmail('x@gmail.cpm')).toBe('x@gmail.com');
    expect(suggestEmail('x@outlook.comm')).toBe('x@outlook.com');
  });

  it.each(['no-at-sign', '', '@gmial.com'])('no usable address %j -> null', (v) => {
    expect(suggestEmail(v)).toBeNull();
  });
});

describe('browser export', () => {
  it('sets window.trdSuggestEmail when loaded as a page script', () => {
    const win: { trdSuggestEmail?: (e: string) => string | null } = {};
    new Function('window', 'module', src)(win, undefined);
    expect(win.trdSuggestEmail?.('a@gmile.com')).toBe('a@gmail.com');
  });
});

describe('index.html script order', () => {
  it('loads js/email-suggest.js before js/form.js', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const a = html.indexOf('js/email-suggest.js');
    const b = html.indexOf('js/form.js');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });
});
