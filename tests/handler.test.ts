import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as lead from '../api/lead.js';
import { makeRequest, readJsonResponse, validBody } from './helpers.js';

const write = vi.fn();
vi.mock('../lib/sinks/index.js', () => ({ sinks: [{ name: 'test', write: (l: unknown) => write(l) }] }));

let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  write.mockReset();
  write.mockResolvedValue(undefined);
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
    expect((await call('POST', { ...validBody, referrer: 'x'.repeat(11 * 1024) })).statusCode).toBe(413);
    expect(write).not.toHaveBeenCalled();
  });

  it('413 up front from Content-Length, without reading the body', async () => {
    const req = makeRequest('POST', validBody, { 'content-length': String(11 * 1024) });
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
    const body = out.body as { ok: boolean; leadId: string };
    expect(body.ok).toBe(true);
    expect(body.leadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toMatchObject({ leadId: body.leadId, ip: '203.0.113.9', userAgent: 'UA/1' });
    expect(JSON.parse(String(logSpy.mock.calls[0]![0]))).toEqual({ event: 'LEAD_WRITTEN', leadId: body.leadId });
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
