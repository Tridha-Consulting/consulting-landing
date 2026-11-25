import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mail } from './mail-fake.js';
import { makeRequest, readJsonResponse, validBody } from './helpers.js';

// A factory runs when the module is first imported, so the flag says whether nodemailer was loaded at all.
const loaded = vi.hoisted(() => ({ nodemailer: false }));
vi.mock('nodemailer', async () => {
  loaded.nodemailer = true;
  const { mail: fake } = await import('./mail-fake.js');
  return { default: { createTransport: fake.createTransport }, createTransport: fake.createTransport };
});

const write = vi.fn();
vi.mock('../lib/sinks/index.js', () => ({ sinks: [{ name: 'test', write: (l: unknown) => write(l) }] }));

beforeEach(() => {
  loaded.nodemailer = false;
  write.mockReset();
  write.mockResolvedValue(undefined);
  vi.stubEnv('ALERT_SMTP_PASS', 'app-password-placeholder');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('nodemailer is loaded lazily', () => {
  it('a saved lead, with alerts configured, never loads it', async () => {
    const { POST } = await import('../api/lead.js');
    const out = await readJsonResponse(await POST(makeRequest('POST', validBody)));
    expect(out.status).toBe(200);
    await mail.flush();
    expect(loaded.nodemailer).toBe(false);
    expect(mail.createTransport).not.toHaveBeenCalled();
  });

  it('the first failure alert loads it (so the flag does detect a load)', async () => {
    write.mockRejectedValue(new Error('sheets down'));
    const { POST } = await import('../api/lead.js');
    expect((await readJsonResponse(await POST(makeRequest('POST', validBody)))).status).toBe(502);
    await mail.flush();
    expect(loaded.nodemailer).toBe(true);
    expect(mail.createTransport).toHaveBeenCalledTimes(1);
  });
});
