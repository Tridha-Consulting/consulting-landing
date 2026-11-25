import { afterEach, describe, expect, it, vi } from 'vitest';
import { detailsOf, expectEveryLeadField, fullBody, makeRequest, readJsonResponse, validBody } from './helpers.js';
import { expectNoMail, mail, mails } from './mail-fake.js';

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

  it('mails every field of the submitted lead, since a misconfigured sink loses it, and answers as before', async () => {
    vi.resetModules();
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', '');
    vi.stubEnv('GOOGLE_PRIVATE_KEY', '');
    vi.stubEnv('SHEET_ID', '');
    vi.stubEnv('ALERT_SMTP_PASS', 'app-password-placeholder');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('../api/lead.js');
    const out = await readJsonResponse(await POST(makeRequest('POST', fullBody, { 'x-forwarded-for': '203.0.113.9' })));
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ ok: false, error: 'server_misconfigured' });
    const sent = await mails();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('[consulting.tridha.net] Lead NOT saved, server misconfigured: Asha Rao (Rao Textiles)');
    expect(sent[0]!.text).toContain('SHEET_ID');
    const details = detailsOf(sent[0]!.text) as { lead: Record<string, unknown>; ip: string; submittedAt: string };
    expectEveryLeadField(details.lead);
    expect(details.ip).toBe('203.0.113.9');
    expect(details.submittedAt).toEqual(expect.any(String));
  });

  it('caps the mails at five per ten minutes, the last one saying so, however many senders there are', async () => {
    vi.resetModules();
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', '');
    vi.stubEnv('GOOGLE_PRIVATE_KEY', '');
    vi.stubEnv('SHEET_ID', '');
    vi.stubEnv('ALERT_SMTP_PASS', 'app-password-placeholder');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('../api/lead.js');
    for (let i = 0; i < 8; i++) {
      const out = await readJsonResponse(await POST(makeRequest('POST', validBody, { 'x-forwarded-for': `203.0.113.${i + 1}` })));
      expect(out).toMatchObject({ status: 500, body: { ok: false, error: 'server_misconfigured' } });
    }
    const sent = await mails();
    expect(sent).toHaveLength(5);
    expect(sent.slice(0, 4).every((m) => !m.text.includes('suppressed'))).toBe(true);
    expect(sent[4]!.text).toContain('Further alerts of this type are suppressed for 10 minutes; see the Vercel logs');
    expect(errSpy.mock.calls.filter((c) => String(c[0]).includes('LEAD_SINK_MISCONFIGURED'))).toHaveLength(8);
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
    await expectNoMail();
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
