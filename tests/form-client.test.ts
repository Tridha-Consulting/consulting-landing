import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { leadSchema } from '../lib/schema.js';

/**
 * Executes the page's own js/form.js in jsdom (no remote URL is ever loaded) and drives the real
 * form. tests/client-parity.test.ts only compares text; this file is what runs the client.
 */
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const FIELD_KEYS = ['fullName', 'designation', 'phone', 'email', 'company', 'website',
  'revenue', 'budget', 'bottleneck', 'techTeam', 'timeline', 'decisionMaker'];

type Call = { url: string; init: { method: string; body: string } };

interface Page {
  window: JSDOM['window'];
  document: Document;
  calls: Call[];
}

async function loadPage(search = '', calLink = ''): Promise<Page> {
  const dom = new JSDOM(read('index.html'), {
    url: `http://localhost/${search}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls: Call[] = [];
  const w = window as unknown as Record<string, unknown>;
  w.fetch = vi.fn((url: string, init: Call['init']) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, leadId: 'x' }) });
  });
  window.Element.prototype.scrollIntoView = () => {};
  // Empty CAL_LINK (the default here): success shows the thank-you instead of mounting the calendar.
  window.eval(read('js/config.js').replace(/CAL_LINK:\s*'[^']*'/, `CAL_LINK: '${calLink}'`));
  for (const f of ['js/email-suggest.js', 'js/booking.js', 'js/form.js']) window.eval(read(f));
  if (window.document.readyState === 'loading') {
    await new Promise<void>((r) => window.document.addEventListener('DOMContentLoaded', () => r()));
  }
  return { window, document: window.document, calls };
}

function openForm(p: Page) {
  (p.document.querySelector('.trd-book-btn') as HTMLElement).click();
  return p.document.querySelector('form') as HTMLFormElement;
}

function setText(p: Page, form: HTMLFormElement, name: string, value: string) {
  const input = form.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new p.window.Event('input', { bubbles: true }));
}

function choose(form: HTMLFormElement, name: string, index: number) {
  (form.querySelectorAll(`input[name="${name}"]`)[index] as HTMLInputElement).click();
}

function fillValid(p: Page, form: HTMLFormElement, bottlenecks = [0, 2]) {
  setText(p, form, 'fullName', 'Asha Rao');
  setText(p, form, 'designation', 'Founder');
  setText(p, form, 'phone', '098765 43210');
  setText(p, form, 'email', 'asha@acme-industries.com');
  setText(p, form, 'company', 'Acme Industries');
  setText(p, form, 'website', 'acme-industries.com');
  choose(form, 'revenue', 1);
  choose(form, 'budget', 2);
  for (const i of bottlenecks) choose(form, 'bottleneck', i);
  choose(form, 'techTeam', 1);
  choose(form, 'timeline', 0);
  choose(form, 'decisionMaker', 0);
}

function submit(p: Page, form: HTMLFormElement) {
  form.dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
}

function errorText(form: HTMLFormElement, name: string): string {
  const input = form.querySelector(`[name="${name}"]`) as HTMLElement;
  const holder = input.closest('.trd-field') as HTMLElement;
  return (holder.querySelector('.trd-error')?.textContent ?? '').trim();
}

async function submitValid(search = '') {
  const p = await loadPage(search);
  const form = openForm(p);
  fillValid(p, form);
  submit(p, form);
  await vi.waitFor(() => expect(p.calls).toHaveLength(1));
  return { p, form, body: JSON.parse(p.calls[0]!.init.body) as Record<string, unknown> };
}

describe('js/form.js in jsdom', () => {
  it('posts one complete lead that satisfies the server schema', async () => {
    const { p, body } = await submitValid();
    expect(p.calls[0]!.url).toBe('/api/lead');
    expect(p.calls[0]!.init.method).toBe('POST');
    expect(Array.isArray(body.bottleneck)).toBe(true);
    expect(body.bottleneck).toEqual([
      'High manual labor/payroll costs in operations or customer support',
      'Lack of a senior technical leader (CTO) to guide our tech roadmap',
    ]);
    for (const k of FIELD_KEYS) expect(body, k).toHaveProperty(k);
    expect(body.phone).toBe('+919876543210');
    expect(body.company_website).toBe('');
    expect(body).not.toHaveProperty('trd_extra');
    const parsed = leadSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    await vi.waitFor(() => expect(p.document.querySelector('.trd-thanks')).not.toBeNull());
    expect(p.calls).toHaveLength(1);
  });

  it('names the honeypot trd_extra in the DOM and sends it as company_website', async () => {
    const p = await loadPage();
    const form = openForm(p);
    expect(form.querySelector('input[name="company_website"]')).toBeNull();
    expect(p.document.querySelector('input[name="company_website"]')).toBeNull();
    expect(form.querySelector('input[name="trd_extra"]')).not.toBeNull();
    fillValid(p, form);
    setText(p, form, 'trd_extra', 'bot-was-here');
    submit(p, form);
    await vi.waitFor(() => expect(p.calls).toHaveLength(1));
    const body = JSON.parse(p.calls[0]!.init.body);
    expect(body.company_website).toBe('bot-was-here');
    expect(body).not.toHaveProperty('trd_extra');
  });

  it('sends nothing on an empty submit and flags all 12 fields', async () => {
    const p = await loadPage();
    const form = openForm(p);
    submit(p, form);
    await new Promise((r) => setTimeout(r, 20));
    expect(p.calls).toHaveLength(0);
    for (const k of FIELD_KEYS) expect(errorText(form, k), k).not.toBe('');
  });

  it('limits bottlenecks to two and rejects none', async () => {
    const p = await loadPage();
    const form = openForm(p);
    const boxes = Array.from(form.querySelectorAll('input[name="bottleneck"]')) as HTMLInputElement[];
    expect(boxes).toHaveLength(4);
    boxes[0]!.click();
    expect(boxes.map((b) => b.disabled)).toEqual([false, false, false, false]);
    boxes[1]!.click();
    expect(boxes.map((b) => b.disabled)).toEqual([false, false, true, true]);
    boxes[2]!.click();
    expect(boxes[2]!.checked).toBe(false);
    expect(boxes.filter((b) => b.checked)).toHaveLength(2);
    boxes[1]!.click();
    expect(boxes.map((b) => b.disabled)).toEqual([false, false, false, false]);

    boxes[0]!.click();
    expect(boxes.filter((b) => b.checked)).toHaveLength(0);
    fillValid(p, form, []);
    submit(p, form);
    await new Promise((r) => setTimeout(r, 20));
    expect(p.calls).toHaveLength(0);
    expect(errorText(form, 'bottleneck')).not.toBe('');
  });

  it('strips control characters from attribution values', async () => {
    const { body } = await submitValid('?utm_source=%01%01abc');
    expect(body.utmSource).toBe('abc');
  });

  it('hands the company to the calendar so the Cal event name can show it', async () => {
    const p = await loadPage('', 'tridha-consulting/exploration-call');
    const booking = (p.window as unknown as { trdBooking: { mount: unknown; bookingUrl: (x: object) => string } }).trdBooking;
    const prefills: Record<string, string>[] = [];
    booking.mount = (_host: unknown, prefill: Record<string, string>) => { prefills.push(prefill); return true; };
    const form = openForm(p);
    fillValid(p, form);
    submit(p, form);
    await vi.waitFor(() => expect(prefills).toHaveLength(1));
    expect(prefills[0]).toMatchObject({ name: 'Asha Rao', company: 'Acme Industries', phone: '+919876543210', leadId: 'x' });
    const url = new URL(booking.bookingUrl({ company: 'Acme & Co', name: 'Asha' }));
    expect(url.searchParams.get('company')).toBe('Acme & Co');
  });

  it('starts loading the calendar when the form opens, before submit', async () => {
    const p = await loadPage('', 'tridha-consulting/exploration-call');
    const booking = (p.window as unknown as { trdBooking: { warm: () => void } }).trdBooking;
    let warmed = 0;
    booking.warm = () => { warmed++; };
    openForm(p);
    expect(warmed).toBe(1);
    expect(p.calls).toHaveLength(0);
  });
});
