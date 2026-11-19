import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { classifyChannel } from '../lib/channel.js';
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
  /** Uncaught errors the page raised: jsdom reports a throwing listener or timer as a window 'error' event and carries on. */
  errors: string[];
}

type Reply = { status: number; body: unknown };

interface LoadOptions {
  /** sessionStorage entries the page finds when its scripts run: what a reload in the same tab sees. */
  storage?: Record<string, string>;
  /** Runs on the window after `storage` is written and before the page's scripts, e.g. to make storage throw. */
  before?: (window: JSDOM['window']) => void;
  /** TURNSTILE_SITE_KEY for config.js (empty otherwise, as in the repo). */
  turnstileSiteKey?: string;
}

/** `response` answers every request; `route` answers per request and may reject to simulate a network failure. */
async function loadPage(search = '', calLink = '', response?: Reply, route?: (url: string, body: Record<string, unknown>) => Reply | Promise<Reply>, opts: LoadOptions = {}): Promise<Page> {
  const dom = new JSDOM(read('index.html'), {
    url: `http://localhost/${search}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  for (const [k, v] of Object.entries(opts.storage ?? {})) window.sessionStorage.setItem(k, v);
  opts.before?.(window);
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(String(e.error?.message ?? e.message)));
  const calls: Call[] = [];
  const w = window as unknown as Record<string, unknown>;
  w.fetch = vi.fn((url: string, init: Call['init']) => {
    calls.push({ url, init });
    if (route) {
      return Promise.resolve(route(url, JSON.parse(init.body))).then((r) => ({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) }));
    }
    if (response) {
      return Promise.resolve({ ok: response.status < 400, status: response.status, json: () => Promise.resolve(response.body) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, leadId: 'x' }) });
  });
  window.Element.prototype.scrollIntoView = () => {};
  // Empty CAL_LINK (the default here): success shows the thank-you instead of mounting the calendar.
  window.eval(read('js/config.js')
    .replace(/CAL_LINK:\s*'[^']*'/, `CAL_LINK: '${calLink}'`)
    .replace(/TURNSTILE_SITE_KEY:\s*'[^']*'/, `TURNSTILE_SITE_KEY: '${opts.turnstileSiteKey ?? ''}'`));
  for (const f of ['js/email-suggest.js', 'js/booking.js', 'js/form.js']) window.eval(read(f));
  if (window.document.readyState === 'loading') {
    await new Promise<void>((r) => window.document.addEventListener('DOMContentLoaded', () => r()));
  }
  return { window, document: window.document, calls, errors };
}

/* Clicks Book and requires the modal to have opened. A throw while the form is built (restoring a draft
   included) stops open() before it shows the overlay, and jsdom only reports the throw, so without these
   checks the form would still be found, filled and sent. */
function openForm(p: Page) {
  (p.document.querySelector('.trd-book-btn') as HTMLElement).click();
  expect(p.errors, 'no uncaught error while opening the form').toEqual([]);
  expect(p.document.querySelector('.trd-overlay')?.classList.contains('is-open'), 'the modal opened').toBe(true);
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

function chooseDial(p: Page, form: HTMLFormElement, dial: string) {
  const sel = form.querySelector('select') as HTMLSelectElement;
  sel.value = dial;
  expect(sel.value, `+${dial} is offered`).toBe(dial);
  sel.dispatchEvent(new p.window.Event('change', { bubbles: true }));
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

  it('captures every click id and sends it under its schema key, X included', async () => {
    const { body } = await submitValid('?gclid=G1&fbclid=F1&li_fat_id=L1&twclid=T1&utm_source=x&utm_medium=paid_social');
    expect(body).toMatchObject({ gclid: 'G1', fbclid: 'F1', liFatId: 'L1', twclid: 'T1', utmSource: 'x', utmMedium: 'paid_social' });
    expect(leadSchema.parse(body)).toMatchObject({ twclid: 'T1' });
  });

  it('captures the Google Ads iOS click ids, gbraid and wbraid, and the server accepts and classifies them', async () => {
    const { body } = await submitValid('?gbraid=GB1&wbraid=WB1');
    expect(body).toMatchObject({ gbraid: 'GB1', wbraid: 'WB1' });
    const parsed = leadSchema.parse(body);
    expect(parsed).toMatchObject({ gbraid: 'GB1', wbraid: 'WB1' });
    expect(classifyChannel(parsed)).toBe('Google Ads');
  });

  it('a gbraid or wbraid link replaces the attribution stored earlier in the tab', async () => {
    await loadPage('?utm_source=newsletter');
    const g = await loadPage('?gbraid=GB9');
    expect(JSON.parse(g.window.sessionStorage.getItem('tridha_attribution')!)).toMatchObject({ gbraid: 'GB9' });
    const w = await loadPage('?wbraid=WB9');
    expect(JSON.parse(w.window.sessionStorage.getItem('tridha_attribution')!)).toMatchObject({ wbraid: 'WB9' });
  });

  it('a twclid link replaces the attribution stored earlier in the tab, like any other click id', async () => {
    const p = await loadPage('?utm_source=newsletter');
    expect(JSON.parse(p.window.sessionStorage.getItem('tridha_attribution')!)).toMatchObject({ utm_source: 'newsletter' });
    const q = await loadPage('?twclid=T9');
    expect(JSON.parse(q.window.sessionStorage.getItem('tridha_attribution')!)).toMatchObject({ twclid: 'T9' });
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

  /* The phone rules through the real form: [dropdown, typed, posted]. Every posted lead also passes the server schema.
     The Indian mobiles are fictitious (98765 43210 and runs of consecutive digits), typed in each shape. */
  const IN_STORED = '+919876543210';
  it.each([
    ['91', '9876543210', IN_STORED, 'a plain 10-digit mobile'],
    ['91', '098765 43210', IN_STORED, 'the trunk 0 dropped'],
    ['91', '919876543210', IN_STORED, '91 in front, no +'],
    ['91', '+91 98765 43210', IN_STORED, '+91 with spaces'],
    ['91', '+91-98765-43210', IN_STORED, '+91 with dashes'],
    ['91', '(+91) 98765 43210', IN_STORED, '+91 in parentheses'],
    ['91', '0091 9876543210', IN_STORED, '0091, the international prefix and the code for India'],
    ['91', '009876543210', IN_STORED, '00 before a mobile with India selected: a trunk 0 typed twice'],
    ['91', '0 0 98765 43210', IN_STORED, '"0 0", the two zeros spaced apart'],
    ['91', '000 98765 43210', IN_STORED, 'three zeros, all trunk zeros'],
    ['91', '98765.43210', IN_STORED, 'dots'],
    ['91', '‪98765 43210‬', IN_STORED, 'pasted from a phone, wrapped in invisible direction marks'],
    ['91', '‪+91 98765 43210‬', IN_STORED, '+91, pasted from a phone'],
    ['91', '‎9876543210', IN_STORED, 'a left-to-right mark in front'],
    ['91', '98765​43210', IN_STORED, 'a zero-width space inside'],
    ['91', '6789012345', '+916789012345', 'a mobile starting 6'],
    ['91', '7890123456', '+917890123456', 'a mobile starting 7'],
    ['91', '8901234567', '+918901234567', 'a mobile starting 8'],
    ['91', '+971 50 123 4567', '+971501234567', 'a typed UAE code wins over the India dropdown'],
    ['91', '+44 7911 123456', '+447911123456', 'a typed UK code wins over the India dropdown'],
    ['44', '+91 98765 43210', IN_STORED, 'a typed +91 wins over the UK dropdown'],
    ['44', '00971501234567', '+971501234567', 'with the UK dropdown 00 is still the international prefix'],
    ['971', '050 123 4567', '+971501234567', 'the UAE dropdown, trunk 0 dropped'],
    ['39', '06 1234 5678', '+390612345678', 'the Italy dropdown keeps the 0'],
    ['91', '+39 06 1234 5678', '+390612345678', 'a typed Italy code keeps the 0'],
  ])('dropdown +%s, typed %j: posts %s (%s)', async (dial, typed, posted) => {
    const p = await loadPage();
    const form = openForm(p);
    fillValid(p, form);
    chooseDial(p, form, dial);
    setText(p, form, 'phone', typed);
    submit(p, form);
    await vi.waitFor(() => expect(p.calls).toHaveLength(1));
    expect(errorText(form, 'phone')).toBe('');
    const body = JSON.parse(p.calls[0]!.init.body);
    expect(body.phone).toBe(posted);
    const parsed = leadSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.phone).toBe(posted);
  });

  it.each([
    ['91', '0000000000', 'Please enter a valid phone number.', 'only zeros'],
    ['91', '12345', 'Please enter a valid phone number.', 'too short'],
    ['91', '98765432101', 'Please enter a valid phone number.', 'too long'],
    ['91', '5876543210', 'Please enter a valid phone number.', 'an Indian number starting 5'],
    ['91', '2932838188', 'Please enter a valid phone number.', 'a landline-style Indian number'],
    ['91', '+91 5876543210', 'Please enter a valid phone number.', '+91 and a number starting 5'],
    ['91', 'abcdefghij', 'Please enter a valid phone number.', 'letters'],
    ['91', '98765 abc 43210', 'Please enter a valid phone number.', 'letters among the digits'],
    ['91', '---', 'Please enter a valid phone number.', 'separators only'],
    ['44', '+44 7911', 'Please enter a valid phone number.', 'a typed code with under 8 digits'],
    ['91', '00971501234567', 'Please enter a valid phone number.', '00 and a UAE number with India selected (only + and 0091 are international)'],
    ['91', '0044 7911 123456', 'Please enter a valid phone number.', '00 and a UK number with India selected'],
    ['91', '', 'Please enter your phone number.', 'empty'],
    ['91', '   ', 'Please enter your phone number.', 'spaces only'],
    ['91', '‪ ‬', 'Please enter your phone number.', 'invisible characters only'],
  ])('dropdown +%s, typed %j: refused with %j (%s)', async (dial, typed, message) => {
    const p = await loadPage();
    const form = openForm(p);
    fillValid(p, form);
    chooseDial(p, form, dial);
    setText(p, form, 'phone', typed);
    submit(p, form);
    await new Promise((r) => setTimeout(r, 20));
    expect(p.calls).toHaveLength(0);
    expect(errorText(form, 'phone')).toBe(message);
    expect(form.querySelector('input[name="phone"]')!.getAttribute('aria-invalid')).toBe('true');
  });

  // Outside India the browser checks only the length; libphonenumber on the server refuses the rest, and
  // its 400 names the phone field. The route answers with the server schema's own verdict and message.
  it.each([
    ['+44 7911 12345', '+44791112345', 'a UK mobile one digit short'],
  ])('typed %j posts %s, which only the server refuses; its message shows under the phone field (%s)', async (typed, posted) => {
    const p = await loadPage('', '', undefined, (_url, body) => {
      const r = leadSchema.safeParse(body);
      if (r.success) return { status: 200, body: { ok: true, leadId: 'x' } };
      const fields: Record<string, string[]> = {};
      for (const issue of r.error.issues) (fields[String(issue.path[0] ?? '_')] ??= []).push(issue.message);
      return { status: 400, body: { ok: false, error: 'validation_failed', fields } };
    });
    const form = openForm(p);
    fillValid(p, form);
    setText(p, form, 'phone', typed);
    submit(p, form);
    await vi.waitFor(() => expect(errorText(form, 'phone')).toBe('Enter a valid phone number'));
    expect(JSON.parse(p.calls[0]!.init.body).phone).toBe(posted);
    expect(p.calls).toHaveLength(1);
    expect(p.document.querySelector('.trd-thanks')).toBeNull();
    expect(form.querySelector('input[name="phone"]')).toBe(p.document.activeElement);
    for (const k of FIELD_KEYS.filter((f) => f !== 'phone')) expect(errorText(form, k), k).toBe('');
  });

  it('shows the server phone message on the phone field and keeps the form usable', async () => {
    const p = await loadPage('', '', {
      status: 400,
      body: { ok: false, error: 'validation_failed', fields: { phone: ['Enter a valid phone number'] } },
    });
    const form = openForm(p);
    fillValid(p, form);
    submit(p, form);
    await vi.waitFor(() => expect(errorText(form, 'phone')).toBe('Enter a valid phone number'));
    expect(p.calls).toHaveLength(1);
    expect(p.document.querySelector('.trd-thanks')).toBeNull();
    const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Submit');
    expect(form.querySelector('input[name="phone"]')).toBe(p.document.activeElement);
    // The visitor fixes it and can resubmit.
    setText(p, form, 'phone', '9812345678');
    expect(errorText(form, 'phone')).toBe('');
    submit(p, form);
    await vi.waitFor(() => expect(p.calls).toHaveLength(2));
  });
});

const DRAFT_KEY = 'trd-lead-draft-v1';
const submitButton = (form: HTMLFormElement) => form.querySelector('button[type="submit"]') as HTMLButtonElement;
const submitError = (form: HTMLFormElement) => form.querySelector('.trd-submit-error') as HTMLElement;

function storageEntries(p: Page): Record<string, string> {
  const s = p.window.sessionStorage;
  const out: Record<string, string> = {};
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i)!;
    out[k] = s.getItem(k)!;
  }
  return out;
}

function draft(p: Page): Record<string, unknown> | null {
  const raw = p.window.sessionStorage.getItem(DRAFT_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/** Every answer as the form shows it: each text value, the country code, and the ticked options of each group. */
function answers(form: HTMLFormElement): Record<string, unknown> {
  const out: Record<string, unknown> = { dial: (form.querySelector('select') as HTMLSelectElement).value };
  for (const k of FIELD_KEYS) {
    const els = Array.from(form.querySelectorAll(`input[name="${k}"]`)) as HTMLInputElement[];
    const grouped = els[0]!.type === 'radio' || els[0]!.type === 'checkbox';
    out[k] = grouped ? els.filter((e) => e.checked).map((e) => e.value) : els[0]!.value;
  }
  return out;
}

const TEXT_KEYS = ['fullName', 'designation', 'phone', 'email', 'company', 'website'];
const EMPTY_ANSWERS = { dial: '91', ...Object.fromEntries(FIELD_KEYS.map((k) => [k, TEXT_KEYS.includes(k) ? '' : []])) };

/** Replaces the page's setTimeout/clearTimeout with a list the test fires by hand. */
function handTimers(p: Page) {
  const w = p.window as unknown as { setTimeout: unknown; clearTimeout: unknown };
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  w.setTimeout = (fn: () => void, ms: number) => {
    timers.set(next, { fn, ms });
    return next++;
  };
  w.clearTimeout = (id: number) => {
    timers.delete(id);
  };
  return {
    pending: () => [...timers.values()].map((t) => t.ms),
    fire(ms: number) {
      for (const [id, t] of timers) {
        if (t.ms === ms) {
          timers.delete(id);
          t.fn();
          return;
        }
      }
      throw new Error(`no ${ms} ms timer is pending`);
    },
  };
}

/** A fetch that never answers: its promise rejects only when the request's signal aborts, as a browser's does. */
function hangingFetch(p: Page) {
  const w = p.window as unknown as { fetch: unknown; DOMException: typeof DOMException };
  w.fetch = (url: string, init: Call['init'] & { signal?: AbortSignal }) => {
    p.calls.push({ url, init });
    return new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new w.DOMException('The operation was aborted.', 'AbortError')));
    });
  };
}

describe('js/form.js when /api/lead does not answer', () => {
  it('aborts after 20 seconds and shows the network-failure error, with the button back and every answer kept', async () => {
    // The reference: what the visitor sees when the request fails outright.
    const down = await loadPage('', '', undefined, () => Promise.reject(new TypeError('Failed to fetch')));
    const downForm = openForm(down);
    fillValid(down, downForm);
    submit(down, downForm);
    await vi.waitFor(() => expect(submitError(downForm).textContent).toContain('something went wrong'));

    const p = await loadPage();
    const timers = handTimers(p);
    hangingFetch(p);
    const form = openForm(p);
    fillValid(p, form);
    const typed = answers(form);
    submit(p, form);
    await vi.waitFor(() => expect(p.calls).toHaveLength(1));
    const signal = (p.calls[0]!.init as unknown as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(false);
    expect(submitButton(form).disabled).toBe(true);
    expect(submitButton(form).textContent).toBe('Submitting');
    expect(timers.pending()).toEqual([20000]);

    timers.fire(20000);
    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => expect(submitError(form).textContent).toContain('something went wrong'));
    expect(submitError(form).innerHTML).toBe(submitError(downForm).innerHTML);
    expect(submitError(form).textContent).toBe('Sorry, something went wrong and your details were not sent. Please try again, or contact us at contact@tridha.net.');
    expect(submitError(form).querySelector('a')?.getAttribute('href')).toBe('mailto:contact@tridha.net');
    expect(submitButton(form).disabled).toBe(false);
    expect(submitButton(form).textContent).toBe(submitButton(downForm).textContent);
    expect(submitButton(form).textContent).toBe('Submit');
    expect(answers(form)).toEqual(typed);
    expect(draft(p)).toMatchObject({ fullName: 'Asha Rao', email: 'asha@acme-industries.com' });
    expect(p.document.querySelector('.trd-thanks')).toBeNull();

    // Not busy any more: pressing Submit again sends the same lead, and an answer this time is a success.
    (p.window as unknown as { fetch: unknown }).fetch = (url: string, init: Call['init']) => {
      p.calls.push({ url, init });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, leadId: 'x' }) });
    };
    submit(p, form);
    await vi.waitFor(() => expect(p.document.querySelector('.trd-thanks')).not.toBeNull());
    expect(p.calls).toHaveLength(2);
    expect(JSON.parse(p.calls[1]!.init.body)).toEqual(JSON.parse(p.calls[0]!.init.body));
    await vi.waitFor(() => expect(timers.pending()).toEqual([]));
  });

  it.each([
    [200, { ok: true, leadId: 'x' }],
    [500, { ok: false, error: 'write_failed' }],
  ])('an answer (%i) inside 20 seconds clears the timer, so it can never abort a finished request', async (status, body) => {
    const p = await loadPage('', '', { status, body });
    const timers = handTimers(p);
    const form = openForm(p);
    fillValid(p, form);
    submit(p, form);
    await vi.waitFor(() => expect(p.calls).toHaveLength(1));
    expect((p.calls[0]!.init as unknown as { signal: unknown }).signal).toBeInstanceOf(p.window.AbortSignal);
    await vi.waitFor(() => expect(timers.pending()).toEqual([]));
    if (status === 200) expect(p.document.querySelector('.trd-thanks')).not.toBeNull();
    else expect(submitError(form).textContent).toContain('something went wrong');
  });
});

describe('js/form.js keeps a draft of the answers for a reload in the same tab', () => {
  it('saves each answer to sessionStorage as it is typed or picked, and never the honeypot', async () => {
    const p = await loadPage();
    const form = openForm(p);
    expect(draft(p)).toBeNull();
    setText(p, form, 'fullName', 'Asha Rao');
    expect(draft(p)).toMatchObject({ fullName: 'Asha Rao', dial: '91', email: '', revenue: '', bottleneck: [] });
    choose(form, 'revenue', 1);
    choose(form, 'bottleneck', 0);
    choose(form, 'bottleneck', 2);
    const dial = form.querySelector('select') as HTMLSelectElement;
    dial.value = '44';
    dial.dispatchEvent(new p.window.Event('change', { bubbles: true }));
    setText(p, form, 'trd_extra', 'bot-was-here');
    const boxes = Array.from(form.querySelectorAll('input[name="bottleneck"]')) as HTMLInputElement[];
    const revenue = (form.querySelectorAll('input[name="revenue"]')[1] as HTMLInputElement).value;
    expect(draft(p)).toMatchObject({ fullName: 'Asha Rao', dial: '44', revenue, bottleneck: [boxes[0]!.value, boxes[2]!.value] });
    expect(Object.keys(draft(p)!).sort()).toEqual([...FIELD_KEYS, 'dial'].sort());
    expect(JSON.stringify(storageEntries(p))).not.toContain('bot-was-here');
    // Emptying every answer drops the draft rather than storing a blank one.
    setText(p, form, 'fullName', '');
    choose(form, 'bottleneck', 0);
    choose(form, 'bottleneck', 2);
    expect(draft(p)).not.toBeNull();
    (form.querySelectorAll('input[name="revenue"]')[1] as HTMLInputElement).checked = false;
    form.dispatchEvent(new p.window.Event('change', { bubbles: true }));
    expect(draft(p)).toBeNull();
  });

  it('saves the address the visitor picks from the typo hint', async () => {
    const p = await loadPage();
    const form = openForm(p);
    fillValid(p, form);
    setText(p, form, 'email', 'asha@gmial.com');
    submit(p, form);
    expect(draft(p)).toMatchObject({ email: 'asha@gmial.com' });
    (form.querySelector('.trd-error .trd-suggest') as HTMLButtonElement).click();
    expect(draft(p)).toMatchObject({ email: 'asha@gmail.com' });
  });

  it('restores every answer when the form is built after a reload, and the restored lead posts as typed', async () => {
    const first = await loadPage();
    const f1 = openForm(first);
    fillValid(first, f1);
    setText(first, f1, 'trd_extra', 'bot-was-here');
    const typed = answers(f1);

    const fresh = await loadPage();
    expect(answers(openForm(fresh))).toEqual(EMPTY_ANSWERS);

    const second = await loadPage('', '', undefined, undefined, { storage: storageEntries(first) });
    const f2 = openForm(second);
    expect(answers(f2)).toEqual(typed);
    expect((f2.querySelector('input[name="trd_extra"]') as HTMLInputElement).value).toBe('');
    // Two restored bottlenecks lock the other two, as when they are ticked by hand.
    const boxes = Array.from(f2.querySelectorAll('input[name="bottleneck"]')) as HTMLInputElement[];
    expect(boxes.map((b) => b.disabled)).toEqual([false, true, false, true]);
    submit(second, f2);
    await vi.waitFor(() => expect(second.calls).toHaveLength(1));
    const body = JSON.parse(second.calls[0]!.init.body);
    const parsed = leadSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(body).toMatchObject({ fullName: typed.fullName, email: typed.email, company: typed.company, website: typed.website, company_website: '' });
    // The restored number posts in the same E.164 form as when typed (trunk zero dropped, country code in front).
    expect(body.phone).toBe(`+${typed.dial}${String(typed.phone).replace(/\D/g, '').replace(/^0+/, '')}`);
    expect(body.bottleneck).toEqual(typed.bottleneck);
  });

  it('restores the country code with a partly filled form', async () => {
    const first = await loadPage();
    const f1 = openForm(first);
    const dial = f1.querySelector('select') as HTMLSelectElement;
    dial.value = '971';
    dial.dispatchEvent(new first.window.Event('change', { bubbles: true }));
    setText(first, f1, 'phone', '501234567');
    const second = await loadPage('', '', undefined, undefined, { storage: storageEntries(first) });
    const f2 = openForm(second);
    expect(answers(f2)).toEqual({ ...EMPTY_ANSWERS, dial: '971', phone: '501234567' });
  });

  it('clears the draft once the lead is saved, so a reload after submitting starts empty', async () => {
    const p = await loadPage();
    const form = openForm(p);
    fillValid(p, form);
    expect(draft(p)).not.toBeNull();
    submit(p, form);
    await vi.waitFor(() => expect(p.document.querySelector('.trd-thanks')).not.toBeNull());
    expect(draft(p)).toBeNull();
    expect(storageEntries(p)).toHaveProperty('tridha_attribution');
    const again = await loadPage('', '', undefined, undefined, { storage: storageEntries(p) });
    expect(answers(openForm(again))).toEqual(EMPTY_ANSWERS);
  });

  it('keeps the draft when the lead is not saved', async () => {
    const p = await loadPage('', '', { status: 500, body: { ok: false, error: 'write_failed' } });
    const form = openForm(p);
    fillValid(p, form);
    submit(p, form);
    await vi.waitFor(() => expect(submitError(form).textContent).toContain('something went wrong'));
    expect(draft(p)).toMatchObject({ fullName: 'Asha Rao', company: 'Acme Industries' });
  });

  it('never stores the Turnstile token', async () => {
    const TOKEN = 'TS-TOKEN-must-not-be-stored';
    const p = await loadPage('', '', { status: 500, body: { ok: false, error: 'write_failed' } }, undefined, { turnstileSiteKey: 'test-site-key' });
    const form = openForm(p);
    const w = p.window as unknown as { turnstile: unknown; __trdTsReady: () => void };
    w.turnstile = {
      render: (_el: unknown, o: { callback: (t: string) => void }) => {
        o.callback(TOKEN);
        return 'widget-1';
      },
      reset: () => {},
    };
    w.__trdTsReady();
    fillValid(p, form);
    expect(JSON.stringify(storageEntries(p))).not.toContain(TOKEN);
    submit(p, form);
    await vi.waitFor(() => expect(p.calls).toHaveLength(1));
    expect(JSON.parse(p.calls[0]!.init.body).turnstileToken).toBe(TOKEN);
    await vi.waitFor(() => expect(submitError(form).textContent).toContain('something went wrong'));
    expect(draft(p)).not.toBeNull();
    expect(JSON.stringify(storageEntries(p))).not.toContain(TOKEN);
  });

  it.each([
    ['sessionStorage throws on access', (w: JSDOM['window']) => {
      Object.defineProperty(w, 'sessionStorage', { configurable: true, get() { throw new w.DOMException('The operation is insecure.', 'SecurityError'); } });
    }],
    ['every storage call throws', (w: JSDOM['window']) => {
      for (const m of ['getItem', 'setItem', 'removeItem'] as const) {
        w.Storage.prototype[m] = () => { throw new w.DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
      }
    }],
  ])('when %s, the form still opens, sends a complete lead and shows the thank-you', async (_name, breakStorage) => {
    const p = await loadPage('', '', undefined, undefined, { before: breakStorage });
    const form = openForm(p);
    fillValid(p, form);
    submit(p, form);
    await vi.waitFor(() => expect(p.calls).toHaveLength(1));
    const body = JSON.parse(p.calls[0]!.init.body);
    const parsed = leadSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(body.landingUrl).toBe('http://localhost/');
    await vi.waitFor(() => expect(p.document.querySelector('.trd-thanks')).not.toBeNull());
    expect(p.errors, 'no storage call escaped its guard').toEqual([]);
  });

  it.each([
    ['not JSON', '{"fullName": "Asha'],
    ['JSON null', 'null'],
    ['a JSON string', '"Asha Rao"'],
    ['an array', '["Asha Rao"]'],
    ['wrong types and unknown options', JSON.stringify({ fullName: 42, email: ['a@b.co'], dial: '999', revenue: 'Not an option', bottleneck: 'not a list', techTeam: { x: 1 } })],
  ])('a stored draft that is %s is ignored: the form opens empty and still sends', async (_name, raw) => {
    const p = await loadPage('', '', undefined, undefined, { storage: { [DRAFT_KEY]: raw } });
    const form = openForm(p);
    expect(answers(form)).toEqual(EMPTY_ANSWERS);
    fillValid(p, form);
    submit(p, form);
    await vi.waitFor(() => expect(p.document.querySelector('.trd-thanks')).not.toBeNull());
    expect(draft(p)).toBeNull();
    expect(p.errors).toEqual([]);
  });

  it('a stored draft cannot exceed a field limit or the two-bottleneck cap', async () => {
    const first = await loadPage();
    const options = Array.from(openForm(first).querySelectorAll('input[name="bottleneck"]')).map((b) => (b as HTMLInputElement).value);
    const raw = JSON.stringify({ fullName: 'x'.repeat(500), phone: '9'.repeat(400), bottleneck: options });
    const p = await loadPage('', '', undefined, undefined, { storage: { [DRAFT_KEY]: raw } });
    const form = openForm(p);
    const restored = answers(form);
    expect((restored.fullName as string).length).toBe(120);
    expect((restored.phone as string).length).toBe(254);
    expect(restored.bottleneck).toEqual(options.slice(0, 2));
    const boxes = Array.from(form.querySelectorAll('input[name="bottleneck"]')) as HTMLInputElement[];
    expect(boxes.map((b) => b.disabled)).toEqual([false, false, true, true]);
  });
});

/** jsdom lays nothing out, so every element has no client rects and the modal's focus trap would find nothing tabbable. */
function layOut(p: Page) {
  p.window.Element.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; };
}

/** Presses Tab (Shift+Tab with `shift`) on the focused element. jsdom has no default action for it: a press the
    page does not cancel is one it leaves to the browser's own move. */
function pressTab(p: Page, shift = false) {
  const ev = new p.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
  (p.document.activeElement ?? p.document.body).dispatchEvent(ev);
  return ev;
}

/** A mouse press on `target`, then what a browser does by default and jsdom does not: unless the page cancels the
    press, the focus moves to the pressed element's nearest focusable ancestor, or to the body when there is none. */
function pressMouse(p: Page, target: Element) {
  const ev = new p.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  target.dispatchEvent(ev);
  if (!ev.defaultPrevented) {
    const focusable = target.closest('a[href], button, input, select, textarea, iframe, [tabindex]') as HTMLElement | null;
    if (focusable) focusable.focus();
    else (p.document.activeElement as HTMLElement | null)?.blur();
  }
  return ev;
}

function pressEscape(p: Page) {
  (p.document.activeElement ?? p.document.body).dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

/** What Chromium does to a focused button once it is disabled, and jsdom does not: the focus drops to the page body.
    jsdom ignores blur() on a disabled element, so the button is enabled for the blur and disabled again. */
function dropFocusOf(p: Page, button: HTMLButtonElement) {
  expect(p.document.activeElement).toBe(button);
  expect(button.disabled).toBe(true);
  button.disabled = false;
  button.blur();
  button.disabled = true;
  expect(p.document.activeElement).toBe(p.document.body);
}

type Answer = () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
const answer = (status: number, body: unknown): Answer => () => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

/** Every /api/lead request gets `reply`. */
function answerLeads(p: Page, reply: Answer) {
  (p.window as unknown as { fetch: unknown }).fetch = (url: string, init: Call['init']) => {
    p.calls.push({ url, init });
    return reply();
  };
}

const GENERIC_LEAD_ERROR = 'Sorry, something went wrong and your details were not sent. Please try again, or contact us at contact@tridha.net.';

/* Every way /api/lead can fail without naming a form field: each ends in the generic message. */
const LEAD_FAILURES: [string, Answer][] = [
  ['a 500', answer(500, { ok: false, error: 'write_failed' })],
  ['a 502', answer(502, { ok: false, error: 'write_failed' })],
  ['a 409', answer(409, { ok: false, error: 'conflict' })],
  ['a 429 (rate limited)', answer(429, { ok: false, error: 'rate_limited' })],
  ['a 400 captcha_failed', answer(400, { ok: false, error: 'captcha_failed' })],
  ['a 400 whose fields are none of the form', answer(400, { ok: false, error: 'validation_failed', fields: { landingUrl: ['Too long'] } })],
  ['a 400 whose body is not JSON', () => Promise.resolve({ ok: false, status: 400, json: () => Promise.reject(new SyntaxError('Unexpected token <')) })],
  ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
];

describe('js/form.js keeps the keyboard inside the modal', () => {
  /* Opens the form, fills it, and sends it from the focused Submit button, as a keyboard user does. */
  async function sendFromKeyboard(p: Page) {
    const form = openForm(p);
    fillValid(p, form);
    submitButton(form).focus();
    submit(p, form);
    await vi.waitFor(() => expect(p.calls).toHaveLength(1));
    return form;
  }

  it.each(LEAD_FAILURES)('after %s the error message takes the focus, and Tab moves on from it inside the modal', async (_name, reply) => {
    const p = await loadPage();
    answerLeads(p, reply);
    const form = await sendFromKeyboard(p);
    const alert = submitError(form);
    await vi.waitFor(() => expect(p.document.activeElement).toBe(alert));
    expect(alert.textContent).toBe(GENERIC_LEAD_ERROR);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.getAttribute('tabindex')).toBe('-1');
    expect(alert.closest('.trd-overlay.is-open')).not.toBeNull();
    expect(submitButton(form).disabled).toBe(false);
    // Controls lie on both sides of the message (its contact link and Submit after, the answers before), so the
    // trap leaves both moves to the browser, which goes on from the message and cannot leave the modal.
    layOut(p);
    expect(pressTab(p).defaultPrevented).toBe(false);
    expect(pressTab(p, true).defaultPrevented).toBe(false);
    expect(p.document.activeElement).toBe(alert);
    expect(p.errors).toEqual([]);
  });

  it('after a send aborted at 20 seconds the error message takes the focus', async () => {
    const p = await loadPage();
    const timers = handTimers(p);
    hangingFetch(p);
    const form = await sendFromKeyboard(p);
    expect(p.document.activeElement).not.toBe(submitError(form));
    timers.fire(20000);
    await vi.waitFor(() => expect(p.document.activeElement).toBe(submitError(form)));
    expect(submitError(form).textContent).toBe(GENERIC_LEAD_ERROR);
  });

  it('a 400 that names form fields still focuses the first of them, not the message', async () => {
    const p = await loadPage();
    answerLeads(p, answer(400, { ok: false, error: 'validation_failed', fields: { website: ['Enter a website'], phone: ['Enter a valid phone number'] } }));
    const form = await sendFromKeyboard(p);
    await vi.waitFor(() => expect(errorText(form, 'phone')).toBe('Enter a valid phone number'));
    expect(errorText(form, 'website')).toBe('Enter a website');
    expect(p.document.activeElement).toBe(form.querySelector('input[name="phone"]'));
    expect(submitError(form).textContent).toBe('');
  });

  it('a send that fails after the modal was closed leaves the focus on the button that opened it', async () => {
    const p = await loadPage();
    let down!: () => void;
    answerLeads(p, () => new Promise((_, reject) => { down = () => reject(new TypeError('Failed to fetch')); }));
    const trigger = p.document.querySelector('.trd-book-btn') as HTMLElement;
    const form = await sendFromKeyboard(p);
    pressEscape(p);
    expect(p.document.activeElement).toBe(trigger);
    down();
    await vi.waitFor(() => expect(submitError(form).textContent).toBe(GENERIC_LEAD_ERROR));
    expect(p.document.activeElement).toBe(trigger);
  });

  type HeldFailure = 'a 500' | 'a network failure';
  /** /api/lead answers only when the returned function is called: with a 500, or by failing as a network does. */
  function holdLead(p: Page) {
    let settle: ((kind: HeldFailure) => void) | undefined;
    answerLeads(p, () => new Promise((resolve, reject) => {
      settle = (kind) => (kind === 'a 500'
        ? resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false, error: 'write_failed' }) })
        : reject(new TypeError('Failed to fetch')));
    }));
    return (kind: HeldFailure) => {
      if (!settle) throw new Error('no /api/lead request is waiting');
      settle(kind);
    };
  }
  const HELD: HeldFailure[] = ['a 500', 'a network failure'];
  const companyInput = (form: HTMLFormElement) => form.querySelector('input[name="company"]') as HTMLInputElement;

  it.each(HELD)('after Enter in a field, left alone while the send ran, %s moves the focus to the error message', async (kind) => {
    const p = await loadPage();
    const settle = holdLead(p);
    const form = openForm(p);
    fillValid(p, form);
    companyInput(form).focus();
    submit(p, form);
    await vi.waitFor(() => expect(p.calls).toHaveLength(1));
    expect(p.document.activeElement).toBe(companyInput(form));
    settle(kind);
    await vi.waitFor(() => expect(p.document.activeElement).toBe(submitError(form)));
    expect(submitError(form).textContent).toBe(GENERIC_LEAD_ERROR);
  });

  it.each(HELD)('when the focus dropped to the page body during the send (Chromium does that to a disabled button), %s moves it to the error message', async (kind) => {
    const p = await loadPage();
    const settle = holdLead(p);
    const form = await sendFromKeyboard(p);
    dropFocusOf(p, submitButton(form));
    settle(kind);
    await vi.waitFor(() => expect(p.document.activeElement).toBe(submitError(form)));
  });

  it.each(HELD)('a visitor who went back to another field and typed while the send ran keeps the focus and every key there after %s', async (kind) => {
    const p = await loadPage();
    const settle = holdLead(p);
    const form = await sendFromKeyboard(p);
    const company = companyInput(form);
    company.focus();
    setText(p, form, 'company', 'Acme Industries Pvt');
    settle(kind);
    await vi.waitFor(() => expect(submitError(form).textContent).toBe(GENERIC_LEAD_ERROR));
    expect(p.document.activeElement).toBe(company);
    // Keys typed after the failure still reach the field.
    setText(p, form, 'company', 'Acme Industries Pvt Ltd');
    expect(p.document.activeElement).toBe(company);
    expect(company.value).toBe('Acme Industries Pvt Ltd');
  });

  it.each(HELD)('a visitor who only moved to another control while the send ran keeps the focus there after %s', async (kind) => {
    const p = await loadPage();
    const settle = holdLead(p);
    const form = await sendFromKeyboard(p);
    const website = form.querySelector('input[name="website"]') as HTMLInputElement;
    website.focus();
    settle(kind);
    await vi.waitFor(() => expect(submitError(form).textContent).toBe(GENERIC_LEAD_ERROR));
    expect(p.document.activeElement).toBe(website);
  });

  it.each(HELD)('a visitor who sent with Enter in a field and went on typing in it keeps the focus there after %s', async (kind) => {
    const p = await loadPage();
    const settle = holdLead(p);
    const form = openForm(p);
    fillValid(p, form);
    const company = companyInput(form);
    company.focus();
    submit(p, form);
    await vi.waitFor(() => expect(p.calls).toHaveLength(1));
    setText(p, form, 'company', 'Acme Industries Pvt');
    settle(kind);
    await vi.waitFor(() => expect(submitError(form).textContent).toBe(GENERIC_LEAD_ERROR));
    expect(p.document.activeElement).toBe(company);
  });

  it.each([
    ['a mouse or touch press back in it', (p: Page, company: HTMLInputElement) => { pressMouse(p, company); }],
    ['an arrow key in it', (p: Page, company: HTMLInputElement) => { company.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); }],
  ] as [string, (p: Page, company: HTMLInputElement) => void][])('a visitor who sent with Enter in a field, then made %s without typing, keeps the focus there after a failure', async (_name, act) => {
    const p = await loadPage();
    const settle = holdLead(p);
    const form = openForm(p);
    fillValid(p, form);
    const company = companyInput(form);
    company.focus();
    submit(p, form);
    await vi.waitFor(() => expect(p.calls).toHaveLength(1));
    act(p, company);
    expect(p.document.activeElement).toBe(company);
    settle('a 500');
    await vi.waitFor(() => expect(submitError(form).textContent).toBe(GENERIC_LEAD_ERROR));
    expect(p.document.activeElement).toBe(company);
  });

  it('only what the visitor does during the send counts: the answers typed and the Enter that sent them do not keep the focus off the message', async () => {
    const p = await loadPage();
    const settle = holdLead(p);
    const form = openForm(p);
    fillValid(p, form);
    const company = companyInput(form);
    pressMouse(p, company);
    setText(p, form, 'company', 'Acme Industries Pvt');
    company.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    submit(p, form);
    await vi.waitFor(() => expect(p.calls).toHaveLength(1));
    settle('a 500');
    await vi.waitFor(() => expect(p.document.activeElement).toBe(submitError(form)));
  });

  it('a press on the backdrop closes the modal and returns the focus to the button that opened it, as Esc does', async () => {
    const p = await loadPage();
    const overlay = () => p.document.querySelector('.trd-overlay') as HTMLElement;
    const trigger = p.document.querySelectorAll('.trd-book-btn')[1] as HTMLElement;
    trigger.focus();
    trigger.click();
    expect(overlay().classList.contains('is-open')).toBe(true);
    // The reference: Esc.
    pressEscape(p);
    expect(overlay().classList.contains('is-open')).toBe(false);
    expect(p.document.activeElement).toBe(trigger);

    trigger.click();
    expect(overlay().classList.contains('is-open')).toBe(true);
    expect(p.document.activeElement).not.toBe(trigger);
    const press = pressMouse(p, overlay());
    expect(overlay().classList.contains('is-open')).toBe(false);
    expect(press.defaultPrevented, 'the press cannot move the focus after close()').toBe(true);
    expect(p.document.activeElement).toBe(trigger);
    expect(p.document.body.style.overflow).toBe('');
    expect(p.document.querySelector('.trd-lp')?.hasAttribute('inert')).toBe(false);
    expect(p.errors).toEqual([]);
  });

  it('a press inside the card is not cancelled and does not close the modal', async () => {
    const p = await loadPage();
    const form = openForm(p);
    const company = form.querySelector('input[name="company"]') as HTMLInputElement;
    const press = pressMouse(p, company);
    expect(press.defaultPrevented).toBe(false);
    expect(p.document.activeElement).toBe(company);
    expect(pressMouse(p, p.document.querySelector('.trd-card')!).defaultPrevented).toBe(false);
    expect(p.document.querySelector('.trd-overlay')!.classList.contains('is-open')).toBe(true);
  });

  it('Tab from the thank-you, with nothing tabbable after it, wraps to the close button; Shift+Tab is left to the browser', async () => {
    const p = await loadPage();
    const form = await sendFromKeyboard(p);
    await vi.waitFor(() => expect(p.document.querySelector('.trd-thanks')).not.toBeNull());
    expect(form.isConnected).toBe(false);
    const thanks = p.document.querySelector('.trd-thanks') as HTMLElement;
    expect(p.document.activeElement).toBe(thanks);
    layOut(p);
    expect(pressTab(p, true).defaultPrevented).toBe(false);
    expect(p.document.activeElement).toBe(thanks);
    expect(pressTab(p).defaultPrevented).toBe(true);
    expect(p.document.activeElement).toBe(p.document.querySelector('.trd-close'));
  });
});

describe('js/form.js when the email domain has no mail server', () => {
  const CAL = 'tridha-consulting/exploration-call';
  const LEAD_ID = '11111111-1111-4111-8111-111111111111';
  const FIX_TOKEN = 'fix-token-1';
  const notOk: Reply = { status: 200, body: { ok: true, leadId: LEAD_ID, emailOk: false, fixToken: FIX_TOKEN } };
  const goodReply: Reply = { status: 200, body: { ok: true, leadId: LEAD_ID, emailOk: true } };

  interface Fixed extends Page {
    prefills: Record<string, string>[];
    lead: () => HTMLFormElement;
    fixCalls: () => Call[];
  }

  function stubMount(p: Page): Record<string, string>[] {
    const prefills: Record<string, string>[] = [];
    const booking = (p.window as unknown as { trdBooking: { mount: unknown } }).trdBooking;
    booking.mount = (_host: unknown, prefill: Record<string, string>) => {
      prefills.push(prefill);
      return true;
    };
    return prefills;
  }

  /** Loads the page, submits a valid lead and waits for the fix step. `emailReply` answers /api/lead-email. */
  async function reachFixStep(emailReply: Reply | (() => Reply | Promise<Reply>) = goodReply, calLink = CAL): Promise<Fixed> {
    const p = await loadPage('', calLink, undefined, (url) => {
      if (url === '/api/lead') return notOk;
      return typeof emailReply === 'function' ? emailReply() : emailReply;
    });
    const prefills = stubMount(p);
    const form = openForm(p);
    fillValid(p, form);
    submit(p, form);
    await vi.waitFor(() => expect(p.document.querySelector('.trd-fix')).not.toBeNull());
    return { ...p, prefills, lead: () => p.document.querySelector('.trd-fix') as HTMLFormElement, fixCalls: () => p.calls.filter((c) => c.url === '/api/lead-email') };
  }

  const fixInput = (p: Page) => p.document.querySelector('.trd-fix input[name="fix_email"]') as HTMLInputElement;
  const fixError = (p: Page) => (p.document.querySelector('.trd-fix .trd-error')?.textContent ?? '').trim();
  const fixFormError = (p: Page) => (p.document.querySelector('.trd-fix .trd-submit-error')?.textContent ?? '').trim();
  const continueBtn = (p: Page) => p.document.querySelector('.trd-fix button[type="submit"]') as HTMLButtonElement;
  const skipBtn = (p: Page) => p.document.querySelector('.trd-fix .trd-skip') as HTMLButtonElement;
  function type(p: Page, value: string) {
    const input = fixInput(p);
    input.value = value;
    input.dispatchEvent(new p.window.Event('input', { bubbles: true }));
  }
  function cont(p: Fixed) {
    p.lead().dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
  }

  it('emailOk false shows the fix step instead of the calendar, with the saved address prefilled', async () => {
    const p = await reachFixStep();
    expect(p.prefills).toHaveLength(0);
    expect(p.document.querySelector('.trd-booking')).toBeNull();
    expect(p.document.querySelector('.trd-thanks')).toBeNull();
    expect(p.document.querySelector('form:not(.trd-fix)')).toBeNull();
    const text = p.document.querySelector('.trd-fix-title')?.textContent ?? '';
    expect(text).toContain("We've saved your details.");
    expect(text).toContain("couldn't find a mail server for acme-industries.com");
    expect(text).toContain("your booking confirmation wouldn't reach you. Please check your email:");
    expect(fixInput(p).value).toBe('asha@acme-industries.com');
    expect(continueBtn(p).textContent).toBe('Continue to booking');
    expect(skipBtn(p).textContent).toBe('Skip — just call me');
    // The lead was posted once, and nothing else yet.
    expect(p.calls.map((c) => c.url)).toEqual(['/api/lead']);
    expect(p.document.activeElement?.className).toBe('trd-fix-title');
  });

  it('Continue with a corrected address posts the lead id and address, then opens the calendar prefilled with it', async () => {
    const p = await reachFixStep();
    type(p, '  asha@acme.org ');
    cont(p);
    await vi.waitFor(() => expect(p.prefills).toHaveLength(1));
    expect(p.fixCalls()).toHaveLength(1);
    const call = p.fixCalls()[0]!;
    expect(call.init.method).toBe('POST');
    expect(JSON.parse(call.init.body)).toEqual({ leadId: LEAD_ID, email: 'asha@acme.org', fixToken: FIX_TOKEN });
    expect(p.prefills[0]).toMatchObject({ email: 'asha@acme.org', leadId: LEAD_ID, name: 'Asha Rao', company: 'Acme Industries', phone: '+919876543210' });
    expect(p.document.querySelector('.trd-fix')).toBeNull();
    expect(p.document.querySelector('.trd-booking')).not.toBeNull();
    // No second lead is created: the lead endpoint was called once.
    expect(p.calls.filter((c) => c.url === '/api/lead')).toHaveLength(1);
  });

  it('the Continue button shows a working state while the check runs, and ignores a second press', async () => {
    let release!: (r: Reply) => void;
    const pending = new Promise<Reply>((r) => {
      release = r;
    });
    const p = await reachFixStep(() => pending);
    cont(p);
    await vi.waitFor(() => expect(p.fixCalls()).toHaveLength(1));
    expect(continueBtn(p).disabled).toBe(true);
    expect(continueBtn(p).textContent).toBe('Checking');
    cont(p);
    expect(p.fixCalls()).toHaveLength(1);
    release(goodReply);
    await vi.waitFor(() => expect(p.prefills).toHaveLength(1));
  });

  it('with no CAL_LINK to open, a successful correction shows the thank-you', async () => {
    const p = await reachFixStep(goodReply, '');
    type(p, 'asha@acme.org');
    cont(p);
    await vi.waitFor(() => expect(p.document.querySelector('.trd-thanks')).not.toBeNull());
    expect(p.document.querySelector('.trd-fix')).toBeNull();
  });

  it('Skip shows the existing thank-you screen and sends nothing', async () => {
    const p = await reachFixStep();
    skipBtn(p).click();
    const thanks = p.document.querySelector('.trd-thanks') as HTMLElement;
    expect(thanks.textContent).toBe('Thank you — our team will call you shortly.');
    expect(p.document.querySelector('.trd-fix')).toBeNull();
    expect(p.fixCalls()).toHaveLength(0);
    expect(p.prefills).toHaveLength(0);
    expect(p.document.activeElement).toBe(thanks);
  });

  it('Continue with an address that still has no mail server keeps the step and shows an error', async () => {
    const p = await reachFixStep(notOk);
    type(p, 'asha@acme-industriez.com');
    cont(p);
    await vi.waitFor(() => expect(fixError(p)).toContain("We still can't find a mail server for acme-industriez.com"));
    expect(p.document.querySelector('.trd-fix')).not.toBeNull();
    expect(p.prefills).toHaveLength(0);
    expect(continueBtn(p).disabled).toBe(false);
    expect(continueBtn(p).textContent).toBe('Continue to booking');
    expect(fixInput(p).getAttribute('aria-invalid')).toBe('true');
    expect(p.document.activeElement).toBe(fixInput(p));
    // Typing again clears the error, and the visitor can still skip.
    type(p, 'asha@acme.org');
    expect(fixError(p)).toBe('');
    skipBtn(p).click();
    expect(p.document.querySelector('.trd-thanks')).not.toBeNull();
  });

  it('a network failure shows the generic error with the contact, and the visitor can retry', async () => {
    let down = true;
    const p = await reachFixStep(() => (down ? Promise.reject(new TypeError('network down')) : goodReply));
    cont(p);
    await vi.waitFor(() => expect(fixFormError(p)).toContain('something went wrong'));
    expect(fixFormError(p)).toContain('contact@tridha.net');
    expect(p.document.querySelector('.trd-fix a')?.getAttribute('href')).toBe('mailto:contact@tridha.net');
    expect(continueBtn(p).disabled).toBe(false);
    expect(p.prefills).toHaveLength(0);
    down = false;
    cont(p);
    await vi.waitFor(() => expect(p.prefills).toHaveLength(1));
  });

  it.each([500, 502, 403, 404])('a %i from the email endpoint shows the generic error and keeps the step, which can still be skipped', async (status) => {
    const p = await reachFixStep({ status, body: { ok: false, error: 'x' } });
    cont(p);
    await vi.waitFor(() => expect(fixFormError(p)).toContain('something went wrong'));
    expect(p.document.querySelector('.trd-fix')).not.toBeNull();
    expect(p.prefills).toHaveLength(0);
    skipBtn(p).click();
    expect(p.document.querySelector('.trd-thanks')).not.toBeNull();
  });

  it('a server validation message for the email is shown on the field', async () => {
    const p = await reachFixStep({ status: 400, body: { ok: false, error: 'validation_failed', fields: { email: ['Enter a valid email'] } } });
    cont(p);
    await vi.waitFor(() => expect(fixError(p)).toBe('Enter a valid email'));
    expect(p.prefills).toHaveLength(0);
  });

  it('checks the address on the client first: an invalid one sends nothing', async () => {
    const p = await reachFixStep();
    type(p, 'not-an-email');
    cont(p);
    expect(fixError(p)).toBe('Please enter a valid email address.');
    type(p, '');
    cont(p);
    expect(fixError(p)).toBe('Please enter your email address.');
    expect(p.fixCalls()).toHaveLength(0);
  });

  it('runs the typo hint on this input too: a hint first, then the suggestion goes through', async () => {
    const p = await reachFixStep();
    type(p, 'asha@gmial.com');
    cont(p);
    expect(fixError(p)).toBe('Did you mean asha@gmail.com?');
    expect(p.fixCalls()).toHaveLength(0);
    (p.document.querySelector('.trd-fix .trd-error .trd-suggest') as HTMLButtonElement).click();
    expect(fixInput(p).value).toBe('asha@gmail.com');
    expect(fixError(p)).toBe('');
    cont(p);
    await vi.waitFor(() => expect(p.prefills).toHaveLength(1));
    expect(JSON.parse(p.fixCalls()[0]!.init.body).email).toBe('asha@gmail.com');
    expect(p.prefills[0]).toMatchObject({ email: 'asha@gmail.com' });
  });

  it('keeps an address the visitor has already been asked about, like the main form does', async () => {
    const p = await reachFixStep();
    type(p, 'asha@gmial.com');
    cont(p);
    expect(p.fixCalls()).toHaveLength(0);
    cont(p);
    await vi.waitFor(() => expect(p.fixCalls()).toHaveLength(1));
    expect(JSON.parse(p.fixCalls()[0]!.init.body).email).toBe('asha@gmial.com');
  });

  it('emailOk true, or no emailOk at all, goes straight to the calendar with the typed address and never shows the step', async () => {
    for (const body of [{ ok: true, leadId: LEAD_ID, emailOk: true }, { ok: true, leadId: LEAD_ID }]) {
      const p = await loadPage('', CAL, { status: 200, body });
      const prefills = stubMount(p);
      const form = openForm(p);
      fillValid(p, form);
      submit(p, form);
      await vi.waitFor(() => expect(prefills).toHaveLength(1));
      expect(prefills[0]).toMatchObject({ email: 'asha@acme-industries.com', leadId: LEAD_ID });
      expect(p.document.querySelector('.trd-fix')).toBeNull();
    }
  });

  it('closing and reopening the modal on the fix step returns focus to it', async () => {
    const p = await reachFixStep();
    (p.document.querySelector('.trd-close') as HTMLElement).click();
    expect(p.document.querySelector('.trd-overlay')!.classList.contains('is-open')).toBe(false);
    (p.document.querySelector('.trd-book-btn') as HTMLElement).click();
    expect(p.document.activeElement?.className).toBe('trd-fix-title');
    expect(p.document.querySelector('.trd-fix')).not.toBeNull();
  });

  it('a 409 shows a short message with the contact, keeps the step, and Skip still works', async () => {
    const p = await reachFixStep({ status: 409, body: { ok: false, error: 'not_correctable' } });
    cont(p);
    await vi.waitFor(() => expect(fixFormError(p)).toContain("We can't update your email here"));
    expect(fixFormError(p)).toContain('contact@tridha.net');
    expect(fixFormError(p)).not.toContain('something went wrong');
    expect(p.document.querySelector('.trd-fix')).not.toBeNull();
    expect(continueBtn(p).disabled).toBe(false);
    skipBtn(p).click();
    expect(p.document.querySelector('.trd-thanks')).not.toBeNull();
  });

  it('sends the fixToken the lead answer carried', async () => {
    const p = await reachFixStep();
    cont(p);
    await vi.waitFor(() => expect(p.fixCalls()).toHaveLength(1));
    expect(JSON.parse(p.fixCalls()[0]!.init.body).fixToken).toBe(FIX_TOKEN);
  });

  it('emailOk false with no fixToken (the server cannot issue one) goes to the thank-you: no step, no calendar', async () => {
    const p = await loadPage('', CAL, { status: 200, body: { ok: true, leadId: LEAD_ID, emailOk: false } });
    const prefills = stubMount(p);
    const form = openForm(p);
    fillValid(p, form);
    submit(p, form);
    await vi.waitFor(() => expect(p.document.querySelector('.trd-thanks')).not.toBeNull());
    expect(p.document.querySelector('.trd-fix')).toBeNull();
    expect(prefills).toHaveLength(0);
    expect(p.calls).toHaveLength(1);
  });

  it('links the instruction text and the error to the input', async () => {
    const p = await reachFixStep();
    const ids = (fixInput(p).getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids).toHaveLength(2);
    expect(p.document.getElementById(ids[0]!)).toBe(p.document.querySelector('.trd-fix-title'));
    expect(p.document.getElementById(ids[1]!)).toBe(p.document.querySelector('.trd-fix .trd-error'));
  });

  it('Skip while a correction is in flight aborts it, shows the thank-you, and a late answer opens nothing', async () => {
    let release!: (r: Reply) => void;
    const pending = new Promise<Reply>((r) => {
      release = r;
    });
    const p = await reachFixStep(() => pending);
    cont(p);
    await vi.waitFor(() => expect(p.fixCalls()).toHaveLength(1));
    const signal = (p.fixCalls()[0]!.init as unknown as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(false);
    skipBtn(p).click();
    expect(signal.aborted).toBe(true);
    expect(p.document.querySelector('.trd-thanks')).not.toBeNull();
    expect(p.document.querySelector('.trd-fix')).toBeNull();
    release(goodReply);
    await new Promise((r) => setTimeout(r, 30));
    expect(p.prefills).toHaveLength(0);
    expect(p.document.querySelector('.trd-booking')).toBeNull();
    expect(p.document.querySelector('.trd-thanks')).not.toBeNull();
  });

  it('a request that takes 15 seconds is aborted and shows the generic error, and the visitor can retry', async () => {
    const p = await reachFixStep();
    const w = p.window as unknown as { fetch: unknown; setTimeout: unknown; DOMException: typeof DOMException };
    const timers: [() => void, number][] = [];
    w.setTimeout = (fn: () => void, ms: number) => {
      timers.push([fn, ms]);
      return timers.length;
    };
    w.fetch = (url: string, init: Call['init'] & { signal: AbortSignal }) => {
      p.calls.push({ url, init });
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new w.DOMException('aborted', 'AbortError')));
      });
    };
    cont(p);
    await vi.waitFor(() => expect(p.fixCalls()).toHaveLength(1));
    expect(timers.map((t) => t[1])).toContain(15000);
    timers.find((t) => t[1] === 15000)![0]();
    await vi.waitFor(() => expect(fixFormError(p)).toContain('something went wrong'));
    expect(continueBtn(p).disabled).toBe(false);
    expect(p.document.querySelector('.trd-fix')).not.toBeNull();
    expect(p.prefills).toHaveLength(0);
  });

  const fixAlert = (p: Page) => p.document.querySelector('.trd-fix .trd-submit-error') as HTMLElement;

  it.each([
    ['a network failure', () => Promise.reject(new TypeError('network down')), 'something went wrong'],
    ['a 500', { status: 500, body: { ok: false, error: 'x' } }, 'something went wrong'],
    ['a 502', { status: 502, body: { ok: false, error: 'write_failed' } }, 'something went wrong'],
    ['a 403', { status: 403, body: { ok: false, error: 'forbidden' } }, 'something went wrong'],
    ['a 400 with no message for the email', { status: 400, body: { ok: false, error: 'validation_failed', fields: {} } }, 'something went wrong'],
    ['a 409', { status: 409, body: { ok: false, error: 'not_correctable' } }, "We can't update your email here"],
  ] as [string, Reply | (() => Promise<Reply>), string][])('after %s the step\'s error message takes the focus, and Tab moves on from it inside the modal', async (_name, reply, text) => {
    const p = await reachFixStep(reply);
    continueBtn(p).focus();
    cont(p);
    const alert = fixAlert(p);
    await vi.waitFor(() => expect(p.document.activeElement).toBe(alert));
    expect(fixFormError(p)).toContain(text);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.getAttribute('tabindex')).toBe('-1');
    expect(continueBtn(p).disabled).toBe(false);
    layOut(p);
    expect(pressTab(p).defaultPrevented).toBe(false);
    expect(pressTab(p, true).defaultPrevented).toBe(false);
    expect(p.errors).toEqual([]);
  });

  it('after a correction aborted at 15 seconds the step\'s error message takes the focus', async () => {
    const p = await reachFixStep();
    const timers = handTimers(p);
    hangingFetch(p);
    continueBtn(p).focus();
    cont(p);
    await vi.waitFor(() => expect(p.fixCalls()).toHaveLength(1));
    expect(p.document.activeElement).not.toBe(fixAlert(p));
    timers.fire(15000);
    await vi.waitFor(() => expect(p.document.activeElement).toBe(fixAlert(p)));
    expect(fixFormError(p)).toContain('something went wrong');
  });

  it('a 400 that names the email focuses the input, not the message', async () => {
    const p = await reachFixStep({ status: 400, body: { ok: false, error: 'validation_failed', fields: { email: ['Enter a valid email'] } } });
    continueBtn(p).focus();
    cont(p);
    await vi.waitFor(() => expect(fixError(p)).toBe('Enter a valid email'));
    expect(p.document.activeElement).toBe(fixInput(p));
    expect(fixFormError(p)).toBe('');
  });

  /* /api/lead-email answers only when the returned function is called; an Error fails the request as a network does. */
  async function holdFix() {
    let settle: ((r: Reply | Error) => void) | undefined;
    const p = await reachFixStep(() => new Promise<Reply>((resolve, reject) => {
      settle = (r) => (r instanceof Error ? reject(r) : resolve(r));
    }));
    return {
      p,
      settle(r: Reply | Error) {
        if (!settle) throw new Error('no /api/lead-email request is waiting');
        settle(r);
      },
    };
  }
  const HELD_FIX: [string, () => Reply | Error, string][] = [
    ['a 500', () => ({ status: 500, body: { ok: false, error: 'x' } }), 'something went wrong'],
    ['a network failure', () => new TypeError('network down'), 'something went wrong'],
    ['a 409', () => ({ status: 409, body: { ok: false, error: 'not_correctable' } }), "We can't update your email here"],
  ];

  it.each(HELD_FIX)('after Enter in the email input, left alone while Checking ran, %s moves the focus to the step\'s message', async (_name, reply, text) => {
    const { p, settle } = await holdFix();
    fixInput(p).focus();
    cont(p);
    await vi.waitFor(() => expect(p.fixCalls()).toHaveLength(1));
    expect(p.document.activeElement).toBe(fixInput(p));
    settle(reply());
    await vi.waitFor(() => expect(p.document.activeElement).toBe(fixAlert(p)));
    expect(fixFormError(p)).toContain(text);
  });

  it.each(HELD_FIX)('when the focus dropped to the page body while Checking ran, %s moves it to the step\'s message', async (_name, reply) => {
    const { p, settle } = await holdFix();
    continueBtn(p).focus();
    cont(p);
    await vi.waitFor(() => expect(p.fixCalls()).toHaveLength(1));
    dropFocusOf(p, continueBtn(p));
    settle(reply());
    await vi.waitFor(() => expect(p.document.activeElement).toBe(fixAlert(p)));
  });

  it.each(HELD_FIX)('a visitor who pressed Continue, then went back to the email input and typed while Checking ran, keeps the focus there after %s', async (_name, reply, text) => {
    const { p, settle } = await holdFix();
    continueBtn(p).focus();
    cont(p);
    await vi.waitFor(() => expect(p.fixCalls()).toHaveLength(1));
    fixInput(p).focus();
    type(p, 'asha@acme-industries.co');
    settle(reply());
    await vi.waitFor(() => expect(fixFormError(p)).toContain(text));
    expect(p.document.activeElement).toBe(fixInput(p));
    type(p, 'asha@acme-industries.com');
    expect(p.document.activeElement).toBe(fixInput(p));
    expect(fixInput(p).value).toBe('asha@acme-industries.com');
  });

  it.each(HELD_FIX)('a visitor who only moved to Skip while Checking ran keeps the focus there after %s', async (_name, reply, text) => {
    const { p, settle } = await holdFix();
    continueBtn(p).focus();
    cont(p);
    await vi.waitFor(() => expect(p.fixCalls()).toHaveLength(1));
    skipBtn(p).focus();
    settle(reply());
    await vi.waitFor(() => expect(fixFormError(p)).toContain(text));
    expect(p.document.activeElement).toBe(skipBtn(p));
  });

  it.each(HELD_FIX)('a visitor who pressed Enter in the email input and went on typing in it keeps the focus there after %s', async (_name, reply, text) => {
    const { p, settle } = await holdFix();
    fixInput(p).focus();
    cont(p);
    await vi.waitFor(() => expect(p.fixCalls()).toHaveLength(1));
    type(p, 'asha@acme-industries.co');
    settle(reply());
    await vi.waitFor(() => expect(fixFormError(p)).toContain(text));
    expect(p.document.activeElement).toBe(fixInput(p));
  });

  it('a visitor who pressed Enter in the email input, then pressed back in it without typing, keeps the focus there after a failure', async () => {
    const { p, settle } = await holdFix();
    fixInput(p).focus();
    cont(p);
    await vi.waitFor(() => expect(p.fixCalls()).toHaveLength(1));
    pressMouse(p, fixInput(p));
    settle(new TypeError('network down'));
    await vi.waitFor(() => expect(fixFormError(p)).toContain('something went wrong'));
    expect(p.document.activeElement).toBe(fixInput(p));
  });

  it('Tab from the step title goes on to the email input (left to the browser), not back to the close button', async () => {
    const p = await reachFixStep();
    expect(p.document.activeElement).toBe(p.document.querySelector('.trd-fix-title'));
    layOut(p);
    expect(pressTab(p).defaultPrevented).toBe(false);
    expect(pressTab(p, true).defaultPrevented).toBe(false);
    expect(p.document.activeElement).toBe(p.document.querySelector('.trd-fix-title'));
  });

  it('inserts the domain as text: markup in it cannot create an element (render helper called directly)', async () => {
    const p = await loadPage();
    const forms = p.window as unknown as { trdForm: { fixTitle: (domain: string, id: string) => HTMLElement } };
    const evil = '<img src=x onerror=alert(1)>.example.com';
    const title = forms.trdForm.fixTitle(evil, 'fix-title');
    expect(title.id).toBe('fix-title');
    expect(title.querySelector('img')).toBeNull();
    expect(title.querySelectorAll('*')).toHaveLength(1);
    expect(title.querySelector('strong')?.textContent).toBe(evil);
    expect(title.textContent).toContain(`mail server for ${evil}, so your booking`);
  });
});
