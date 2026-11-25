import { beforeEach, vi } from 'vitest';

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
vi.mock('nodemailer', async () => {
  const { mail } = await import('./mail-fake.js');
  return { default: { createTransport: mail.createTransport }, createTransport: mail.createTransport };
});

beforeEach(async () => {
  const { mail } = await import('./mail-fake.js');
  mail.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const name of ['ALERT_SMTP_PASS', 'ALERT_SMTP_USER', 'ALERT_SMTP_HOST', 'ALERT_TO']) vi.stubEnv(name, '');
});
