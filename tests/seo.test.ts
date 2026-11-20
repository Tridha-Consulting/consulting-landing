import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/* jsdom runs no script here, so what these tests see is what a crawler that does not run JavaScript sees. */
const doc = (html: string): Document => new JSDOM(html).window.document;
const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const SITE = 'https://consulting.tridha.net/';
const index = doc(read('index.html'));

type Node = Record<string, unknown> & { '@type': string; '@id': string };
type Faq = { q: string; a: string };

function jsonLd(d: Document): unknown[] {
  return [...d.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent ?? ''));
}

const blocks = jsonLd(index);
const graph = ((blocks[0] ?? {}) as { '@graph'?: Node[] })['@graph'] ?? [];
const node = (type: string): Node => {
  const found = graph.filter((n) => n['@type'] === type);
  expect(found, `one ${type} in the @graph`).toHaveLength(1);
  return found[0]!;
};

/* Every {"@id": …} object anywhere under a value: a reference to another node. */
function refs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(refs);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o['@id'] === 'string') return [o['@id']];
    return Object.values(o).flatMap(refs);
  }
  return [];
}

const visibleFaq = (): Faq[] =>
  [...index.querySelectorAll('#faq .cellcard')].map((card) => ({ q: text(card.querySelector('h3')), a: text(card.querySelector('p')) }));

describe('structured data (JSON-LD on index.html)', () => {
  it('is one schema.org @graph of the Organization, the service, the site, the page and its FAQ', () => {
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as Record<string, unknown>)['@context']).toBe('https://schema.org');
    expect(graph.map((n) => n['@type']).sort()).toEqual(['FAQPage', 'Organization', 'ProfessionalService', 'WebPage', 'WebSite']);
    expect(new Set(graph.map((n) => n['@id'])).size, 'each node has its own @id').toBe(graph.length);
  });

  it('points every reference at a node in the graph', () => {
    const ids = new Set(graph.map((n) => n['@id']));
    const all = graph.flatMap((n) => refs(Object.fromEntries(Object.entries(n).filter(([k]) => k !== '@id'))));
    expect(all.length).toBeGreaterThan(0);
    for (const id of all) expect(ids, id).toContain(id);
  });

  /* tridha.net declares the same Organization under this @id, so a parser that reads both sites merges them into one entity. */
  it('names the Organization as tridha.net does', () => {
    const org = node('Organization');
    expect(org['@id']).toBe('https://tridha.net/#org');
    expect(org.name).toBe('Tridha');
    expect(org.url).toBe('https://tridha.net/');
  });

  it('describes the page with its own title and meta description, so the two cannot drift', () => {
    const page = node('WebPage');
    expect(page.url).toBe(SITE);
    expect(page.name).toBe(index.title);
    expect(page.description).toBe(index.querySelector('meta[name="description"]')?.getAttribute('content'));
    expect(index.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(SITE);
  });

  it("places the service in the cities the page's header names", () => {
    const address = node('ProfessionalService').address as { addressLocality: string }[];
    expect(address.map((a) => a.addressLocality)).toEqual(text(index.querySelector('.lp-header .loc')).split(' · '));
  });

  it('gives every URL as an absolute https URL', () => {
    const urls = JSON.stringify(blocks).match(/"(?:https?:)?\/\/[^"]*"|"\/[^"]*"/g) ?? [];
    for (const u of urls) expect(u, u).toMatch(/^"https:\/\//);
  });
});

describe('FAQ', () => {
  it('is in the page before the final booking section, as static HTML', () => {
    const sections = [...index.querySelectorAll('main > section')].map((s) => s.id);
    expect(sections.indexOf('faq')).toBeGreaterThan(-1);
    expect(sections.indexOf('faq')).toBe(sections.indexOf('book-a-call') - 1);
    const faq = index.querySelector('#faq')!;
    expect(faq.getAttribute('aria-labelledby')).toBe('faq-title');
    expect(text(faq.querySelector('h2#faq-title'))).toBe('Frequently asked questions');
    expect(visibleFaq().length).toBeGreaterThanOrEqual(5);
    expect(visibleFaq().length).toBeLessThanOrEqual(7);
    for (const { q, a } of visibleFaq()) {
      expect(q, 'each question is an h3 ending in a question mark').toMatch(/\?$/);
      expect(a.length, q).toBeGreaterThan(0);
    }
  });

  /* Answer engines and Google both treat FAQ markup that differs from the visible text as misleading. */
  it('marks up exactly the questions and answers a visitor reads, in the same order', () => {
    const faq = node('FAQPage');
    expect(faq.url).toBe(`${SITE}#faq`);
    expect(faq.name).toBe(text(index.querySelector('#faq-title')));
    const marked = (faq.mainEntity as { '@type': string; name: string; acceptedAnswer: { '@type': string; text: string } }[]).map((m) => {
      expect(m['@type']).toBe('Question');
      expect(m.acceptedAnswer['@type']).toBe('Answer');
      return { q: m.name, a: m.acceptedAnswer.text };
    });
    expect(marked).toEqual(visibleFaq());
  });
});
