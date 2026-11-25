import { vi } from 'vitest';

// The nodemailer double every test runs against (tests/setup.ts mocks the package with it), so no test can open
// an SMTP connection. The spies live on globalThis because vi.resetModules() reloads this file and the tests
// still hold the instances they first imported.
interface Mail {
  sendMail: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  createTransport: ReturnType<typeof vi.fn>;
  reset(): void;
}

const store = globalThis as { __mailFake?: Mail };

export const mail: Mail = (store.__mailFake ??= (() => {
  const sendMail = vi.fn();
  const close = vi.fn();
  const createTransport = vi.fn();
  const reset = () => {
    sendMail.mockReset().mockResolvedValue({ accepted: [] });
    close.mockReset();
    createTransport.mockReset().mockImplementation(() => ({ sendMail, close }));
  };
  reset();
  return { sendMail, close, createTransport, reset };
})());

/** The messages passed to sendMail, in order. */
export function sentMail(): { from: string; to: string; subject: string; text: string; html?: unknown }[] {
  return mail.sendMail.mock.calls.map((c) => c[0] as { from: string; to: string; subject: string; text: string; html?: unknown });
}
