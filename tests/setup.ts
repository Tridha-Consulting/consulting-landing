import { afterEach, beforeEach, vi } from 'vitest';

// No test may query real DNS: the default resolver of lib/email-domain.ts cannot be constructed here,
// so a test that reaches it without injecting a resolver gets 'Unchecked' at once instead of waiting on the network.
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    constructor() {
      throw new Error('real DNS is never queried in tests: inject a resolver or mock lib/email-domain.js');
    }
  },
}));

// No test may open an SMTP connection: nodemailer is replaced by tests/mail-fake.ts, and alerts start every test
// switched off (the developer's own ALERT_* variables are ignored) until the test stubs ALERT_SMTP_PASS.
// A request context with a spy waitUntil is installed too, so a test can wait for the mail an endpoint sends after its response.
vi.mock('nodemailer', async () => {
  const { mail } = await import('./mail-fake.js');
  return { default: { createTransport: mail.createTransport }, createTransport: mail.createTransport };
});

const realWarn = console.warn.bind(console);

beforeEach(async () => {
  const { mail } = await import('./mail-fake.js');
  mail.reset();
  // The two informational alert lines (not configured, throttled) are expected on most failure paths; every other warning still prints.
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (!/"event":"ALERT_(NOT_CONFIGURED|THROTTLED)"/.test(String(args[0]))) realWarn(...args);
  });
  for (const name of ['ALERT_SMTP_PASS', 'ALERT_SMTP_USER', 'ALERT_TO']) vi.stubEnv(name, '');
  // Even if a test lets a real send through (a mock that does not apply, as vitest can do for concurrent
  // imports), it goes to an address in TEST-NET-1 (RFC 5737), which nothing answers, never to the real mail
  // server that an empty ALERT_SMTP_HOST would default to. A test of that default stubs '' itself.
  vi.stubEnv('ALERT_SMTP_HOST', '192.0.2.1');
});

afterEach(async () => {
  const { mail } = await import('./mail-fake.js');
  mail.clearContext();
});
