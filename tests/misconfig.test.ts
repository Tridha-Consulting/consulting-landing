import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRequest, readJsonResponse, validBody } from './helpers.js';

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
