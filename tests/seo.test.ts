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

/* robots.txt read as RFC 9309 does: a crawler takes the groups whose user-agent line names it (case-insensitive), or the *
   group when none does, and of their rules the longest matching path wins, Allow on a tie. The file uses no * or $ inside a
   path, and this reader refuses one rather than guess. */
type Group = { agents: string[]; rules: { allow: boolean; path: string }[] };

function robots(source: string): { groups: Group[]; sitemaps: string[] } {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [, key = '', value = ''] = /^([^:]+):\s*(.*)$/.exec(line) ?? [];
    const k = key.trim().toLowerCase();
    if (k === 'user-agent') {
      if (!lastWasAgent || !current) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (k === 'allow' || k === 'disallow') {
      if (!current) throw new Error(`rule before any user-agent: ${line}`);
      if (/[*$]/.test(value)) throw new Error(`this reader does not handle wildcards: ${line}`);
      current.rules.push({ allow: k === 'allow', path: value });
      lastWasAgent = false;
    } else if (k === 'sitemap') {
      sitemaps.push(value);
    } else {
      throw new Error(`unknown robots.txt line: ${line}`);
    }
  }
  return { groups, sitemaps };
}

function allowed(file: ReturnType<typeof robots>, agent: string, path: string): boolean {
  const named = file.groups.filter((g) => g.agents.includes(agent.toLowerCase()));
  const groups = named.length ? named : file.groups.filter((g) => g.agents.includes('*'));
  const hits = groups.flatMap((g) => g.rules).filter((r) => r.path !== '' && path.startsWith(r.path));
  hits.sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return hits[0]?.allow ?? true;
}

const CRAWLERS = [
  'Googlebot', 'Bingbot', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User',
  'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot',
];

describe('robots.txt', () => {
  const file = robots(read('robots.txt'));

  it('names each search and AI crawler the owner welcomed in a group of its own', () => {
    const named = file.groups.flatMap((g) => g.agents).filter((a) => a !== '*');
    expect(named.sort()).toEqual(CRAWLERS.map((c) => c.toLowerCase()).sort());
  });

  /* Naming a crawler drops the * group for it, so a named group without its own Disallow: /api/ would open the API to it. */
  it.each([...CRAWLERS, '*', 'SomeUnlistedBot'])('lets %s fetch the pages, llms.txt and the sitemap, and never /api/', (agent) => {
    for (const path of ['/', '/book', '/llms.txt', '/sitemap.xml', '/assets/og.jpg']) expect(allowed(file, agent, path), path).toBe(true);
    for (const path of ['/api/lead', '/api/cal-webhook', '/api/']) expect(allowed(file, agent, path), path).toBe(false);
  });

  it('points at the sitemap', () => {
    expect(file.sitemaps).toEqual(['https://consulting.tridha.net/sitemap.xml']);
  });
});

/* The file each public URL serves (cleanUrls in vercel.json drops .html). */
const PAGE_FOR: Record<string, string> = { '/': 'index.html', '/book': 'book.html' };
const robotsMeta = (page: string): string =>
  (doc(read(page)).querySelector('meta[name="robots"]')?.getAttribute('content') ?? '').toLowerCase().replace(/\s+/g, '');

describe('sitemap.xml and indexing', () => {
  const sitemap = new JSDOM(read('sitemap.xml'), { contentType: 'text/xml' }).window.document;
  const urls = [...sitemap.getElementsByTagName('url')].map((u) => ({
    loc: u.getElementsByTagName('loc')[0]?.textContent?.trim() ?? '',
    lastmod: u.getElementsByTagName('lastmod')[0]?.textContent?.trim() ?? '',
  }));

  it('lists the landing page, with a lastmod date', () => {
    expect(sitemap.documentElement.namespaceURI).toBe('http://www.sitemaps.org/schemas/sitemap/0.9');
    expect(urls.map((u) => u.loc)).toEqual([SITE]);
    for (const { loc, lastmod } of urls) expect(lastmod, loc).toMatch(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  });

  /* A sitemap URL is a request to index it, so it must be a page that allows indexing and calls itself canonical. */
  it('lists only pages that may be indexed and name themselves canonical', () => {
    for (const { loc } of urls) {
      const page = PAGE_FOR[new URL(loc).pathname];
      expect(page, `${loc} maps to a page in this repo`).toBeDefined();
      expect(robotsMeta(page!)).not.toContain('noindex');
      expect(doc(read(page!)).querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(loc);
    }
  });

  /* /book is the step after the form (or a setter's personal link): no value on its own in a search result, but its links may
     still be followed. */
  it('keeps /book out of the index and out of the sitemap', () => {
    expect(robotsMeta('book.html')).toBe('noindex,follow');
    expect(urls.map((u) => new URL(u.loc).pathname)).not.toContain('/book');
    expect(doc(read('book.html')).querySelector('link[rel="canonical"]'), 'a noindex page names no canonical').toBeNull();
  });
});

/* llmstxt.org: an H1 with the name, a > summary, free text and lists with no headings, then H2 sections that are lists of
   links, each "- [name](url)" with optional ": notes". */
describe('llms.txt', () => {
  const lines = read('llms.txt').split(/\r?\n/);
  const firstH2 = lines.findIndex((l) => l.startsWith('## '));
  const links = [...read('llms.txt').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1]!);

  it('opens with the name and a one-line summary', () => {
    expect(lines[0]).toBe('# Tridha');
    const summary = lines.slice(1).find((l) => l.trim() !== '');
    expect(summary).toMatch(/^> \S/);
    expect(lines.filter((l) => l.startsWith('> ')), 'one summary line').toHaveLength(1);
  });

  it('gives the same revenue band as the page', () => {
    const band = /₹[\d,]+Cr to ₹[\d,]+Cr/.exec(text(index.querySelector('.hero-copy .eyebrow')))?.[0];
    expect(band).toBeDefined();
    expect(lines.find((l) => l.startsWith('> '))).toContain(band);
  });

  it('keeps headings to the H1 and H2 link sections, each a list of links', () => {
    expect(lines.filter((l) => /^#{3,}\s/.test(l))).toEqual([]);
    expect(lines.slice(1, firstH2).filter((l) => l.startsWith('#'))).toEqual([]);
    expect(firstH2).toBeGreaterThan(0);
    for (const l of lines.slice(firstH2).filter((x) => x.trim() !== '' && !x.startsWith('## '))) {
      expect(l, 'a section line is a link item').toMatch(/^- \[[^\]]+\]\(https:\/\/[^)]+\)(?:: .+)?$/);
    }
  });

  it('links to this site and to tridha.net, and nowhere else', () => {
    expect(links).toContain(SITE);
    expect(links).toContain('https://tridha.net/');
    for (const url of links) expect(['consulting.tridha.net', 'tridha.net'], url).toContain(new URL(url).hostname);
    for (const url of links) expect(url, url).toMatch(/^https:\/\//);
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
