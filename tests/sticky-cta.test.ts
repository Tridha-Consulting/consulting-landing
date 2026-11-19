import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const css = read('css/site.css');

/* The bodies of every `@media <query> {` block, braces balanced. */
function mediaBlocks(source: string, query: string): string[] {
  const out: string[] = [];
  for (let start = source.indexOf(`@media ${query} {`); start >= 0; start = source.indexOf(`@media ${query} {`, start + 1)) {
    const open = source.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length && end < 0; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) end = i;
    }
    if (end < 0) throw new Error(`unbalanced @media ${query}`);
    out.push(source.slice(open + 1, end));
  }
  return out;
}

function px(block: string, name: string): number {
  const m = new RegExp(`${name}:\\s*(\\d+)px;`).exec(block);
  if (!m) throw new Error(`${name} is not a px value`);
  return Number(m[1]);
}

/* jsdom does not lay out, apply media queries or evaluate calc(), so the computed 83px and the focus landings above
   the bar were measured in Chromium (390x844, 412x915). This file pins the rule those runs measured. */
describe('scroll padding for the mobile sticky CTA bar (css/site.css)', () => {
  const blocks = mediaBlocks(css, '(max-width: 760px)').filter((b) => b.includes('--sticky-cta-h'));
  const mobile = blocks[0] ?? '';

  it('keeps the bar variables in one mobile block', () => {
    expect(blocks).toHaveLength(1);
  });
  const SELECTOR = 'html:has(.trd-lp .sticky-mobile-cta)';

  it('clears the bar by its height plus 8px, inside the mobile query only', () => {
    const rule = new RegExp(`${SELECTOR.replace(/[.()]/g, '\\$&')}\\s*\\{\\s*scroll-padding-bottom:\\s*([^;]+);\\s*\\}`).exec(mobile);
    expect(rule?.[1]).toBe('calc(var(--sticky-cta-h) + var(--sticky-cta-clear) + env(safe-area-inset-bottom))');
    // The bar is the two paddings, its 1px top border and the button: 75px, and the padding 8px more.
    expect(px(mobile, '--sticky-cta-pad') * 2 + 1 + px(mobile, '--sticky-cta-btn-h')).toBe(75);
    expect(px(mobile, '--sticky-cta-clear')).toBe(8);
    expect(mobile).toContain('--sticky-cta-h: calc(var(--sticky-cta-pad) * 2 + 1px + var(--sticky-cta-btn-h));');
  });

  it('is the only scroll padding the site sets, so no page-wide rule pads a page without the bar', () => {
    for (const file of ['css/site.css', 'css/form.css']) {
      const sets = [...read(file).matchAll(/scroll-padding[\w-]*\s*:/g)];
      expect(sets, file).toHaveLength(file === 'css/site.css' ? 1 : 0);
    }
  });

  it.each([
    ['index.html', true],
    ['book.html', false],
  ])('the selector matches %s: %s (book.html loads site.css but renders no bar)', (page, applies) => {
    const html = read(page);
    expect(html).toContain('href="css/site.css"');
    expect(new JSDOM(html).window.document.documentElement.matches(SELECTOR)).toBe(applies);
  });
});
