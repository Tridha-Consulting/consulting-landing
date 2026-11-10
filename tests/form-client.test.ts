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
}

type Reply = { status: number; body: unknown };

/** `response` answers every request; `route` answers per request and may reject to simulate a network failure. */
async function loadPage(search = '', calLink = '', response?: Reply, route?: (url: string, body: Record<string, unknown>) => Reply | Promise<Reply>): Promise<Page> {
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

  it.each([
    ['2932838188', 'a landline-style number (starts with 2)'],
    ['5876543210', 'starts with 5'],
    ['98765', 'too short'],
    ['98765432101', 'too long'],
  ])('rejects the Indian number %s on the client (%s)', async (num) => {
    const p = await loadPage();
    const form = openForm(p);
    fillValid(p, form);
    setText(p, form, 'phone', num);
    submit(p, form);
    expect(errorText(form, 'phone')).toBe('Please enter a valid 10-digit mobile number.');
    expect(p.calls).toHaveLength(0);
  });

  it.each(['9876543210', '098765 43210', '7045152625', '6000000000'])('accepts the Indian number %s on the client', async (num) => {
    const p = await loadPage();
    const form = openForm(p);
    fillValid(p, form);
    setText(p, form, 'phone', num);
    submit(p, form);
    await vi.waitFor(() => expect(p.calls).toHaveLength(1));
    expect(errorText(form, 'phone')).toBe('');
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
