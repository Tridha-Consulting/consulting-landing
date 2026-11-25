import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as lead from '../api/lead.js';
import { columnIndex, toRow } from '../lib/columns.js';
import { fixTokenFor } from '../lib/fix-token.js';
import { resetLeadRateLimit } from '../lib/rate-limit.js';
import { resetAlertThrottle } from '../lib/alert.js';
import { BOTTLENECK_OPTIONS, BUDGET_OPTIONS, DECISION_MAKER_OPTIONS, REVENUE_OPTIONS, TECH_TEAM_OPTIONS, TIMELINE_OPTIONS } from '../lib/schema.js';
import { makeRequest, readJsonResponse, validBody } from './helpers.js';
import { mail, sentMail } from './mail-fake.js';

const write = vi.fn();
vi.mock('../lib/sinks/index.js', () => ({ sinks: [{ name: 'test', write: (l: unknown) => write(l) }] }));
// The audit log has its own tests (tests/event-log.test.ts); here only what the handler hands it is checked.
const logEvents = vi.fn();
vi.mock('../lib/event-log.js', async (importActual) => ({
  ...(await importActual<typeof import('../lib/event-log.js')>()),
  logEvents: (e: unknown, o: unknown) => logEvents(e, o),
}));

// The MX lookup has its own tests (tests/email-domain.test.ts); here the handler is given a verdict.
const checkEmailDomain = vi.fn();
vi.mock('../lib/email-domain.js', async (importActual) => ({
  ...(await importActual<typeof import('../lib/email-domain.js')>()),
  checkEmailDomain: (e: unknown) => checkEmailDomain(e),
}));

let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetLeadRateLimit();
  write.mockReset();
  write.mockResolvedValue(undefined);
  logEvents.mockReset();
  logEvents.mockResolvedValue(undefined);
  checkEmailDomain.mockReset();
  checkEmailDomain.mockResolvedValue('OK');
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const handlers = lead as unknown as Record<string, (r: Request) => Promise<Response>>;

async function call(method: string, body?: unknown, headers?: Record<string, string>) {
  const out = await readJsonResponse(await handlers[method]!(makeRequest(method, body, headers)));
  return { statusCode: out.status, headers: out.headers, body: out.body };
}

function loggedEvent(spy: { mock: { calls: unknown[][] } }, event: string): Record<string, unknown> | undefined {
  const line = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes(`"event":"${event}"`));
  return line ? (JSON.parse(line) as Record<string, unknown>) : undefined;
}

describe('POST /api/lead', () => {
  it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])('405 on %s', async (method) => {
    const out = await call(method);
    expect(out.statusCode).toBe(405);
    expect(out.headers.get('Allow')).toBe('POST');
    expect(write).not.toHaveBeenCalled();
  });

  it('honeypot filled -> 200 and no write', async () => {
    const out = await call('POST', { ...validBody, company_website: 'http://spam' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toEqual({ ok: true });
    expect(write).not.toHaveBeenCalled();
  });

  it('a full valid body appends a row with every answer under its header', async () => {
    const out = await call('POST', validBody);
    expect(out.statusCode).toBe(200);
    expect(write).toHaveBeenCalledTimes(1);
    const row = toRow(write.mock.calls[0]![0] as Parameters<typeof toRow>[0]);
    expect(row).toContain('Founder');
    expect(row).toContain('Rao Textiles');
    expect(row).toContain('raotextiles.in');
    expect(row).toContain('₹5 Crores – ₹20 Crores');
    expect(row).toContain('₹15 Lakhs – ₹50 Lakhs');
    expect(row).toContain(`${BOTTLENECK_OPTIONS[0]}; ${BOTTLENECK_OPTIONS[3]}`);
    expect(row).toContain('Yes, but they lack AI expertise/are overwhelmed.');
    expect(row).toContain('Immediately (Within the next 15-30 days)');
    expect(row).toContain('Yes, I sign off on budgets.');
  });

  it('a missing or unknown answer -> 400 naming the field, no write', async () => {
    const missing = await call('POST', { ...validBody, budget: undefined });
    expect(missing.statusCode).toBe(400);
    expect(Object.keys((missing.body as { fields: Record<string, string[]> }).fields)).toEqual(['budget']);
    const unknown = await call('POST', { ...validBody, bottleneck: ['nope'] });
    expect(unknown.statusCode).toBe(400);
    expect(Object.keys((unknown.body as { fields: Record<string, string[]> }).fields)).toEqual(['bottleneck']);
    expect(write).not.toHaveBeenCalled();
  });

  it('accepts the largest valid body, for ASCII and for multi-byte text', async () => {
    const attributionKeys = ['utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm', 'fbclid', 'gclid', 'liFatId', 'twclid', 'gbraid', 'wbraid', 'referrer', 'landingUrl'];
    const [b1, b2] = [...BOTTLENECK_OPTIONS].sort((a, b) => b.length - a.length);
    for (const ch of ['a', 'ह']) {
      const body = {
        ...validBody,
        ...Object.fromEntries(attributionKeys.map((k) => [k, ch.repeat(500)])),
        fullName: ch.repeat(120),
        designation: ch.repeat(120),
        company: ch.repeat(120),
        website: ch.repeat(200),
        email: `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.example.com`,
        bottleneck: [b1, b2],
        company_website: '',
        turnstileToken: 't'.repeat(2048),
      };
      const raw = JSON.stringify(body);
      // MAX_BODY_BYTES is 32 KiB; the multi-byte body is well past the 10 KiB the endpoint started with.
      expect(Buffer.byteLength(raw), ch).toBeLessThanOrEqual(32 * 1024);
      if (ch !== 'a') expect(Buffer.byteLength(raw)).toBeGreaterThan(10 * 1024);
      write.mockClear();
      const out = await call('POST', raw);
      expect(out.statusCode, ch).toBe(200);
      expect(write, ch).toHaveBeenCalledTimes(1);
    }
  });

  it('invalid -> 400 with field errors', async () => {
    const out = await call('POST', { ...validBody, email: 'nope', phone: '1' });
    expect(out.statusCode).toBe(400);
    const fields = (out.body as { fields: Record<string, string[]> }).fields;
    expect(Object.keys(fields)).toEqual(expect.arrayContaining(['email', 'phone']));
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects the emails the client used to accept (server rule is the contract)', async () => {
    for (const email of ['josé@example.com', 'a@exa_mple.com']) {
      const out = await call('POST', { ...validBody, email });
      expect(out.statusCode).toBe(400);
      expect(Object.keys((out.body as { fields: Record<string, string[]> }).fields)).toEqual(['email']);
    }
  });

  it('rejects malformed JSON with 400 and an oversize body with 413', async () => {
    expect((await call('POST', '{not json')).statusCode).toBe(400);
    expect((await call('POST', { ...validBody, referrer: 'x'.repeat(33 * 1024) })).statusCode).toBe(413);
    expect(write).not.toHaveBeenCalled();
  });

  it('413 up front from Content-Length, without reading the body', async () => {
    const req = makeRequest('POST', validBody, { 'content-length': String(33 * 1024) });
    const textSpy = vi.spyOn(req, 'text');
    const res = await handlers.POST!(req);
    expect(res.status).toBe(413);
    expect(textSpy).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('reads the body of a real Request: a valid lead is stored, never rejected as invalid_json', async () => {
    const res = await handlers.POST!(
      new Request('https://consulting.tridha.net/api/lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validBody),
      }),
    );
    expect(res.status).toBe(200);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('non-object JSON -> 400', async () => {
    expect((await call('POST', '[1,2]')).statusCode).toBe(400);
    expect((await call('POST', 'null')).statusCode).toBe(400);
  });

  it('sink throws -> 502 and LEAD_WRITE_FAILED carries the full lead', async () => {
    write.mockRejectedValue(new Error('sheets down'));
    const out = await call('POST', validBody);
    expect(out.statusCode).toBe(502);
    const parsed = loggedEvent(errSpy, 'LEAD_WRITE_FAILED') as { lead: Record<string, unknown> };
    expect(parsed).toMatchObject({ event: 'LEAD_WRITE_FAILED', sink: 'test', error: 'sheets down' });
    expect(parsed.lead).toMatchObject({ fullName: 'Asha Rao', email: 'asha@example.com', phone: '+919812345678' });
    expect(parsed.lead.leadId).toBeTruthy();
  });

  it('success -> 200 with leadId, logs LEAD_WRITTEN, passes server fields to the sink', async () => {
    const out = await call('POST', validBody, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'UA/1' });
    expect(out.statusCode).toBe(200);
    const body = out.body as { ok: boolean; leadId: string; emailOk: boolean };
    expect(body.ok).toBe(true);
    expect(body.emailOk).toBe(true);
    expect(body.leadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toMatchObject({ leadId: body.leadId, ip: '203.0.113.9', userAgent: 'UA/1' });
    expect(JSON.parse(String(logSpy.mock.calls[0]![0]))).toEqual({ event: 'LEAD_WRITTEN', leadId: body.leadId, emailCheck: 'OK' });
  });
});

describe('POST /api/lead email check', () => {
  it.each([
    ['OK', true],
    ['Unchecked', true],
    ['No mail server', false],
  ])('a lookup result of %s writes it to the row and answers emailOk %s', async (check, emailOk) => {
    checkEmailDomain.mockResolvedValue(check);
    const out = await call('POST', validBody);
    expect(out.statusCode).toBe(200);
    expect(out.body).toEqual({ ok: true, leadId: expect.any(String), emailOk });
    expect(checkEmailDomain).toHaveBeenCalledWith('asha@example.com');
    expect(write).toHaveBeenCalledTimes(1);
    const lead = write.mock.calls[0]![0] as Parameters<typeof toRow>[0];
    expect(lead.emailCheck).toBe(check);
    expect(toRow(lead)[columnIndex('Email Check')]).toBe(check);
    expect(toRow(lead)[columnIndex('Cancellation Reason')]).toBe('');
    expect(JSON.parse(String(logSpy.mock.calls[0]![0]))).toMatchObject({ event: 'LEAD_WRITTEN', emailCheck: check });
  });

  it('a domain with no mail server still gets its row, and the audit event is unchanged', async () => {
    checkEmailDomain.mockResolvedValue('No mail server');
    const out = await call('POST', { ...validBody, email: 'asha@gmial.co' });
    expect(out.body).toMatchObject({ ok: true, emailOk: false });
    expect(write).toHaveBeenCalledTimes(1);
    expect(logEvents.mock.calls[0]![0][0]).toMatchObject({ event: 'Lead submitted', source: 'form' });
  });

  it('checks the validated, trimmed address, and not at all for an invalid one', async () => {
    await call('POST', { ...validBody, email: '  asha@example.com ' });
    expect(checkEmailDomain).toHaveBeenCalledWith('asha@example.com');
    checkEmailDomain.mockClear();
    expect((await call('POST', { ...validBody, email: 'nope' })).statusCode).toBe(400);
    expect(checkEmailDomain).not.toHaveBeenCalled();
  });

  it('a resolver that cannot be constructed never loses the lead: the row is written Unchecked and the answer is ok', async () => {
    // The real checkEmailDomain with its default resolver, whose constructor throws under tests/setup.ts.
    const { checkEmailDomain: real } = await vi.importActual<typeof import('../lib/email-domain.js')>('../lib/email-domain.js');
    checkEmailDomain.mockImplementation((e: string) => real(e));
    const out = await call('POST', validBody);
    expect(out.statusCode).toBe(200);
    expect(out.body).toEqual({ ok: true, leadId: expect.any(String), emailOk: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect((write.mock.calls[0]![0] as { emailCheck: string }).emailCheck).toBe('Unchecked');
  });

  it('the honeypot does no lookup', async () => {
    await call('POST', { ...validBody, company_website: 'http://spam' });
    expect(checkEmailDomain).not.toHaveBeenCalled();
  });
});

describe('POST /api/lead audit event', () => {
  it('hands one Lead submitted event to the log after the write, with the Channel as Detail', async () => {
    const out = await call('POST', { ...validBody, utmSource: 'google', utmMedium: 'cpc' });
    const { leadId } = out.body as { leadId: string };
    expect(logEvents).toHaveBeenCalledTimes(1);
    expect(logEvents).toHaveBeenCalledWith([{ event: 'Lead submitted', source: 'form', leadId, statusTo: 'New', detail: 'Google Ads' }], { deadlineMs: 2000 });
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(logEvents.mock.invocationCallOrder[0]!);
  });

  it('classifies an X click id and a bare visit', async () => {
    await call('POST', { ...validBody, utmSource: undefined, twclid: 'T1' });
    expect(logEvents.mock.calls[0]![0][0].detail).toBe('X Ads');
    logEvents.mockClear();
    await call('POST', { ...validBody, utmSource: undefined, landingUrl: undefined });
    expect(logEvents.mock.calls[0]![0][0].detail).toBe('Direct');
  });

  it('writes the channel and click id to the row', async () => {
    await call('POST', { ...validBody, utmSource: undefined, twclid: 'T1' });
    const row = toRow(write.mock.calls[0]![0] as Parameters<typeof toRow>[0]);
    // Channel, twclid, gbraid, wbraid, the four team columns, then Email Check ('OK' from the mocked lookup) and Cancellation Reason.
    expect(row.slice(-10)).toEqual(['X Ads', 'T1', '', '', '', '', '', '', 'OK', '']);
  });

  it('no event when the lead is not stored: write failure, validation failure, honeypot', async () => {
    write.mockRejectedValue(new Error('sheets down'));
    expect((await call('POST', validBody)).statusCode).toBe(502);
    write.mockResolvedValue(undefined);
    expect((await call('POST', { ...validBody, email: 'nope' })).statusCode).toBe(400);
    expect((await call('POST', { ...validBody, company_website: 'http://spam' })).statusCode).toBe(200);
    expect(logEvents).not.toHaveBeenCalled();
  });
});

describe('Turnstile', () => {
  beforeEach(() => vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret'));

  it('verification fails -> 400, no write, one LEAD_CAPTCHA_REJECTED line with codes and the full lead', async () => {
    const f = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) });
    vi.stubGlobal('fetch', f);
    const out = await call('POST', { ...validBody, turnstileToken: 'bad' });
    expect(out.statusCode).toBe(400);
    expect(out.body).toEqual({ ok: false, error: 'captcha_failed' });
    expect(f).toHaveBeenCalledOnce();
    expect(String(f.mock.calls[0]![0])).toContain('challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(write).not.toHaveBeenCalled();
    const lines = errSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('LEAD_CAPTCHA_REJECTED'));
    expect(lines).toHaveLength(1);
    const ev = loggedEvent(errSpy, 'LEAD_CAPTCHA_REJECTED')!;
    expect(ev.errorCodes).toEqual(['invalid-input-response']);
    expect(ev.lead).toMatchObject(validBody);
    expect(ev.lead).not.toHaveProperty('turnstileToken');
    expect(ev).not.toHaveProperty('hint');
  });

  it('missing token -> 400 without calling Cloudflare, logs the lead plus a TURNSTILE_SITE_KEY hint', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await call('POST', validBody)).statusCode).toBe(400);
    expect(f).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    const ev = loggedEvent(errSpy, 'LEAD_CAPTCHA_REJECTED')!;
    expect(ev.errorCodes).toEqual(['missing-input-response']);
    expect(String(ev.hint)).toContain('TURNSTILE_SITE_KEY');
    expect(String(ev.hint)).toContain('js/config.js');
    expect(ev.lead).toMatchObject(validBody);
  });

  it('Cloudflare network error -> 502 captcha_unavailable and the lead is NOT written (but is logged)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const out = await call('POST', { ...validBody, turnstileToken: 'tok' });
    expect(out.statusCode).toBe(502);
    expect(out.body).toEqual({ ok: false, error: 'captcha_unavailable' });
    expect(write).not.toHaveBeenCalled();
    const ev = loggedEvent(errSpy, 'LEAD_CAPTCHA_UNAVAILABLE')!;
    expect(ev.lead).toMatchObject(validBody);
  });

  it('Cloudflare timeout -> 502 and no write', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')));
    expect((await call('POST', { ...validBody, turnstileToken: 'tok' })).statusCode).toBe(502);
    expect(write).not.toHaveBeenCalled();
  });

  it('verification succeeds -> 200 and the lead is written', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }));
    expect((await call('POST', { ...validBody, turnstileToken: 'good' })).statusCode).toBe(200);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('rate limiting', () => {
  const ipA = { 'x-forwarded-for': '203.0.113.9' };

  it('the 6th request from one ip -> 429 rate_limited with Retry-After, no write, full lead logged', async () => {
    for (let i = 0; i < 5; i++) expect((await call('POST', validBody, ipA)).statusCode).toBe(200);
    expect(write).toHaveBeenCalledTimes(5);
    const out = await call('POST', { ...validBody, turnstileToken: 'tok' }, ipA);
    expect(out.statusCode).toBe(429);
    expect(out.body).toEqual({ ok: false, error: 'rate_limited' });
    expect(Number(out.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(out.headers.get('Retry-After'))).toBeLessThanOrEqual(600);
    expect(write).toHaveBeenCalledTimes(5);
    const ev = loggedEvent(errSpy, 'LEAD_RATE_LIMITED')!;
    expect(ev.ip).toBe('203.0.113.9');
    expect(ev.lead).toMatchObject(validBody);
    expect(ev.lead).not.toHaveProperty('turnstileToken');
  });

  it('a different ip is unaffected, and so is a request with no ip', async () => {
    for (let i = 0; i < 6; i++) await call('POST', validBody, ipA);
    expect((await call('POST', validBody, { 'x-forwarded-for': '198.51.100.7' })).statusCode).toBe(200);
    expect((await call('POST', validBody)).statusCode).toBe(200);
  });

  it('only the first x-forwarded-for hop is the key', async () => {
    for (let i = 0; i < 5; i++) await call('POST', validBody, { 'x-forwarded-for': `203.0.113.9, 10.0.0.${i}` });
    expect((await call('POST', validBody, { 'x-forwarded-for': '203.0.113.9, 10.0.0.99' })).statusCode).toBe(429);
  });

  it('LEAD_RATE_LIMIT lowers the limit', async () => {
    vi.stubEnv('LEAD_RATE_LIMIT', '1');
    expect((await call('POST', validBody, ipA)).statusCode).toBe(200);
    expect((await call('POST', validBody, ipA)).statusCode).toBe(429);
  });

  it('a honeypot request is answered before the limiter and does not consume budget', async () => {
    for (let i = 0; i < 20; i++) expect((await call('POST', { ...validBody, company_website: 'spam' }, ipA)).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) expect((await call('POST', validBody, ipA)).statusCode).toBe(200);
    expect((await call('POST', validBody, ipA)).statusCode).toBe(429);
  });

  it('runs before Turnstile: a limited request makes no siteverify call', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret');
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', f);
    for (let i = 0; i < 5; i++) expect((await call('POST', { ...validBody, turnstileToken: 'good' }, ipA)).statusCode).toBe(200);
    expect(f).toHaveBeenCalledTimes(5);
    expect((await call('POST', { ...validBody, turnstileToken: 'good' }, ipA)).statusCode).toBe(429);
    expect(f).toHaveBeenCalledTimes(5);
  });

  it('requests that fail validation still count (attempts, not just accepted leads)', async () => {
    for (let i = 0; i < 5; i++) expect((await call('POST', { ...validBody, budget: undefined }, ipA)).statusCode).toBe(400);
    expect((await call('POST', validBody, ipA)).statusCode).toBe(429);
  });
});

describe('POST /api/lead fixToken', () => {
  beforeEach(() => vi.stubEnv('CRON_SECRET', 'cron-secret-test'));

  it('a domain with no mail server also returns the token for the new lead id', async () => {
    checkEmailDomain.mockResolvedValue('No mail server');
    const out = await call('POST', validBody);
    const body = out.body as { leadId: string; emailOk: boolean; fixToken: string };
    expect(body.emailOk).toBe(false);
    expect(body.fixToken).toBe(fixTokenFor(body.leadId));
    expect(body.fixToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each(['OK', 'Unchecked'])('a lookup result of %s returns no token', async (check) => {
    checkEmailDomain.mockResolvedValue(check);
    const out = await call('POST', validBody);
    expect(out.body).not.toHaveProperty('fixToken');
  });

  it('without CRON_SECRET the lead is still saved and answered, with no token, and the gap is logged', async () => {
    vi.stubEnv('CRON_SECRET', '');
    checkEmailDomain.mockResolvedValue('No mail server');
    const out = await call('POST', validBody);
    expect(out.statusCode).toBe(200);
    expect(out.body).toEqual({ ok: true, leadId: expect.any(String), emailOk: false });
    expect(write).toHaveBeenCalledTimes(1);
    expect(loggedEvent(errSpy, 'LEAD_FIX_TOKEN_UNAVAILABLE')).toMatchObject({ leadId: (out.body as { leadId: string }).leadId });
  });
});

describe('failure alerts', () => {
  beforeEach(() => {
    vi.stubEnv('ALERT_SMTP_PASS', 'app-password-placeholder');
    resetAlertThrottle();
  });

  it('a lost lead mails every field of the lead, and the response is unchanged', async () => {
    write.mockRejectedValue(new Error('sheets down'));
    const out = await call('POST', { ...validBody, utmSource: 'meta' }, { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'UA/1' });
    expect(out.statusCode).toBe(502);
    expect(out.body).toEqual({ ok: false, error: 'write_failed' });
    expect(loggedEvent(errSpy, 'LEAD_WRITE_FAILED')).toMatchObject({ error: 'sheets down' });

    const [mailed] = sentMail();
    expect(sentMail()).toHaveLength(1);
    expect(mailed!.subject).toBe('[consulting.tridha.net] Lead NOT saved: Asha Rao (Rao Textiles)');
    for (const value of [
      'Asha Rao',
      'asha@example.com',
      '+919812345678',
      'Founder',
      'Rao Textiles',
      'raotextiles.in',
      REVENUE_OPTIONS[1],
      BUDGET_OPTIONS[2],
      BOTTLENECK_OPTIONS[0],
      BOTTLENECK_OPTIONS[3],
      TECH_TEAM_OPTIONS[1],
      TIMELINE_OPTIONS[0],
      DECISION_MAKER_OPTIONS[0],
      'meta',
      '203.0.113.9',
      'UA/1',
      'sheets down',
    ]) {
      expect(mailed!.text, value).toContain(JSON.stringify(value).slice(1, -1));
    }
    expect(mailed!.text).toMatch(/"leadId": "[0-9a-f-]{36}"/);
  });

  it('mails each distinct lost lead, even in quick succession', async () => {
    write.mockRejectedValue(new Error('sheets down'));
    await call('POST', validBody);
    await call('POST', validBody);
    expect(sentMail()).toHaveLength(2);
  });

  it('a mail that cannot be sent changes nothing in the response', async () => {
    write.mockRejectedValue(new Error('sheets down'));
    mail.sendMail.mockRejectedValue(new Error('smtp down'));
    const out = await call('POST', validBody);
    expect(out.statusCode).toBe(502);
    expect(out.body).toEqual({ ok: false, error: 'write_failed' });
    expect(loggedEvent(errSpy, 'ALERT_SEND_FAILED')).toMatchObject({ alertEvent: 'LEAD_WRITE_FAILED', error: 'smtp down' });
  });

  it('a saved lead sends no mail', async () => {
    expect((await call('POST', validBody)).statusCode).toBe(200);
    expect(mail.createTransport).not.toHaveBeenCalled();
  });

  it('an unconfigured mailbox changes nothing in the response and logs ALERT_NOT_CONFIGURED', async () => {
    vi.stubEnv('ALERT_SMTP_PASS', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    write.mockRejectedValue(new Error('sheets down'));
    const out = await call('POST', validBody);
    expect(out.statusCode).toBe(502);
    expect(out.body).toEqual({ ok: false, error: 'write_failed' });
    expect(loggedEvent(warn, 'ALERT_NOT_CONFIGURED')).toMatchObject({ alertEvent: 'LEAD_WRITE_FAILED' });
    expect(mail.createTransport).not.toHaveBeenCalled();
  });

  it('a rate-limited lead sends no mail', async () => {
    const ipA = { 'x-forwarded-for': '203.0.113.9' };
    for (let i = 0; i < 5; i++) await call('POST', validBody, ipA);
    const out = await call('POST', validBody, ipA);
    expect(out.statusCode).toBe(429);
    expect(mail.createTransport).not.toHaveBeenCalled();
  });

  it('a rejected captcha, an unreachable captcha, and a validation error send no mail', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: false }) }));
    expect((await call('POST', { ...validBody, turnstileToken: 'bad' })).statusCode).toBe(400);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect((await call('POST', { ...validBody, turnstileToken: 'tok' })).statusCode).toBe(502);
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    expect((await call('POST', { ...validBody, budget: undefined })).statusCode).toBe(400);
    expect(mail.createTransport).not.toHaveBeenCalled();
  });

  it('a missing CRON_SECRET (no fix token) sends no mail', async () => {
    vi.stubEnv('CRON_SECRET', '');
    checkEmailDomain.mockResolvedValue('No mail server');
    expect((await call('POST', validBody)).statusCode).toBe(200);
    expect(mail.createTransport).not.toHaveBeenCalled();
  });
});
