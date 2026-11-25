import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRequest, readJsonResponse, validBody } from './helpers.js';
import { mail, sentMail } from './mail-fake.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('missing environment', () => {
  it('handler returns 500, logs LEAD_SINK_MISCONFIGURED naming the vars, and never reports success', async () => {
    vi.resetModules();
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', '');
    vi.stubEnv('GOOGLE_PRIVATE_KEY', '');
    vi.stubEnv('SHEET_ID', '');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('../api/lead.js');
    const out = await readJsonResponse(await POST(makeRequest('POST', validBody)));
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({ ok: false });
    const line = String(errSpy.mock.calls[0]![0]);
    expect(JSON.parse(line).event).toBe('LEAD_SINK_MISCONFIGURED');
    expect(line).toContain('GOOGLE_SERVICE_ACCOUNT_EMAIL');
    expect(line).toContain('GOOGLE_PRIVATE_KEY');
    expect(line).toContain('SHEET_ID');
  });

  it('mails the submitted lead, since a misconfigured sink loses it, and answers as before', async () => {
    vi.resetModules();
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', '');
    vi.stubEnv('GOOGLE_PRIVATE_KEY', '');
    vi.stubEnv('SHEET_ID', '');
    vi.stubEnv('ALERT_SMTP_PASS', 'app-password-placeholder');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('../api/lead.js');
    const out = await readJsonResponse(await POST(makeRequest('POST', validBody, { 'x-forwarded-for': '203.0.113.9' })));
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ ok: false, error: 'server_misconfigured' });
    expect(sentMail()).toHaveLength(1);
    const { subject, text } = sentMail()[0]!;
    expect(subject).toBe('[consulting.tridha.net] Lead NOT saved, server misconfigured: Asha Rao (Rao Textiles)');
    for (const value of ['Asha Rao', 'asha@example.com', '+919812345678', 'Founder', 'raotextiles.in', 'meta', '203.0.113.9', 'SHEET_ID']) {
      expect(text, value).toContain(value);
    }
  });

  it('sends no mail when ALERT_SMTP_PASS is unset, and the response is the same', async () => {
    vi.resetModules();
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', '');
    vi.stubEnv('GOOGLE_PRIVATE_KEY', '');
    vi.stubEnv('SHEET_ID', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { POST } = await import('../api/lead.js');
    const out = await readJsonResponse(await POST(makeRequest('POST', validBody)));
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ ok: false, error: 'server_misconfigured' });
    expect(mail.createTransport).not.toHaveBeenCalled();
  });

  it('env module throws a clear error at load', async () => {
    vi.resetModules();
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'a@b.iam.gserviceaccount.com');
    vi.stubEnv('GOOGLE_PRIVATE_KEY', '');
    vi.stubEnv('SHEET_ID', '');
    await expect(import('../lib/env.js')).rejects.toThrow(/GOOGLE_PRIVATE_KEY, SHEET_ID/);
  });

  it('env module loads and unescapes the key when configured', async () => {
    vi.resetModules();
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'a@b.iam.gserviceaccount.com');
    vi.stubEnv('GOOGLE_PRIVATE_KEY', 'line1\\nline2');
    vi.stubEnv('SHEET_ID', 'sheet');
    const { env } = await import('../lib/env.js');
    expect(env.privateKey).toBe('line1\nline2');
    expect(env.sheetTab).toBe('Leads');
  });
});
