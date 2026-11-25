import { expect, vi } from 'vitest';

// The doubles every test runs against, so no test can open an SMTP connection: tests/setup.ts mocks nodemailer
// with the transport here and installs a request context (the one the Vercel platform provides) whose waitUntil
// is the spy here. Endpoints send alerts after the response through waitUntil: the promises it is given are
// kept here, and `flush` waits for them. The spies live on globalThis
// because vi.resetModules() reloads this file and the tests still hold the instances they first imported.
interface Mail {
  sendMail: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  createTransport: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn<(p: Promise<unknown>) => void>>;
  /** The promises handed to waitUntil since the last reset. */
  background: Promise<unknown>[];
  /** Waits until every alert started so far has finished. */
  flush(): Promise<void>;
  reset(): void;
  /** Removes the request context, as when code runs outside a Vercel request. */
  clearContext(): void;
}

/** Where the platform keeps the request context (the symbol @vercel/functions reads). */
export const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

const store = globalThis as { __mailFake?: Mail };

export const mail: Mail = (store.__mailFake ??= (() => {
  const sendMail = vi.fn();
  const close = vi.fn();
  const createTransport = vi.fn();
  const waitUntil = vi.fn<(p: Promise<unknown>) => void>();
  const self: Mail = {
    sendMail,
    close,
    createTransport,
    waitUntil,
    background: [],
    async flush() {
      for (let seen = -1; seen !== self.background.length; ) {
        seen = self.background.length;
        await Promise.all(self.background);
      }
    },
    clearContext() {
      delete (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT];
    },
    reset() {
      sendMail.mockReset().mockResolvedValue({ accepted: [] });
      close.mockReset();
      createTransport.mockReset().mockImplementation(() => ({ sendMail, close }));
      self.background = [];
      waitUntil.mockReset().mockImplementation((p: Promise<unknown>) => {
        self.background.push(p);
      });
      (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => ({ waitUntil: (p: Promise<unknown>) => waitUntil(p) }) };
    },
  };
  self.reset();
  return self;
})());

type Sent = { from: string; to: string; subject: string; text: string; html?: unknown; signal?: AbortSignal };

/** The messages passed to sendMail, in order. */
export function sentMail(): Sent[] {
  return mail.sendMail.mock.calls.map((c) => c[0] as Sent);
}

/** The messages sent once every alert started so far has finished. */
export async function mails(): Promise<Sent[]> {
  await mail.flush();
  return sentMail();
}

/** Fails when any alert started so far reached the mail transport. */
export async function expectNoMail(): Promise<void> {
  await mail.flush();
  expect(mail.createTransport).not.toHaveBeenCalled();
}
