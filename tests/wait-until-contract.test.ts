import { waitUntil as packageWaitUntil } from '@vercel/functions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alertInBackground, registerWaitUntil, resetAlertThrottle } from '../lib/alert.js';
import { REQUEST_CONTEXT, mail } from './mail-fake.js';

// lib/alert.ts reads the platform's request context itself instead of importing @vercel/functions (which costs
// every endpoint its load time). These tests keep that copy honest: the package and the lookup must reach the
// same waitUntil, so an upgrade of the package that moves it fails here.

let context: { waitUntil: ReturnType<typeof vi.fn> };

beforeEach(() => {
  context = { waitUntil: vi.fn() };
  (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => context };
  resetAlertThrottle();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('the request-context contract', () => {
  it('the package and our lookup call the same waitUntil with the same promise', () => {
    const viaPackage = Promise.resolve('package');
    const viaUs = Promise.resolve('us');
    packageWaitUntil(viaPackage);
    expect(registerWaitUntil(viaUs)).toBe(true);
    expect(context.waitUntil.mock.calls).toEqual([[viaPackage], [viaUs]]);
  });

  it('both call it as a method of the context, as the platform expects', () => {
    const seen: unknown[] = [];
    context = {
      waitUntil: vi.fn(function (this: unknown) {
        seen.push(this);
      }),
    };
    packageWaitUntil(Promise.resolve());
    registerWaitUntil(Promise.resolve());
    expect(seen).toEqual([context, context]);
  });

  it('with no request context both do nothing, and ours reports it', () => {
    delete (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT];
    expect(() => packageWaitUntil(Promise.resolve())).not.toThrow();
    expect(registerWaitUntil(Promise.resolve())).toBe(false);
  });

  it('alertInBackground registers its send through that lookup', async () => {
    alertInBackground({ event: 'TEST_EVENT', subject: 'x' });
    expect(context.waitUntil).toHaveBeenCalledTimes(1);
    expect(await context.waitUntil.mock.calls[0]![0]).toBe(false);
  });
});

describe('ALERT_NO_WAITUNTIL', () => {
  const alert = { event: 'TEST_EVENT', subject: 'x' };
  const noWaitUntilLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => String(c[0]).includes('ALERT_NO_WAITUNTIL'));

  it('on Vercel, with no waitUntil, is logged once per instance, and the mail still goes out', async () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('ALERT_SMTP_PASS', 'app-password-placeholder');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mail.clearContext();
    alertInBackground({ ...alert, dedupeKey: 'a' });
    alertInBackground({ ...alert, dedupeKey: 'b' });
    expect(noWaitUntilLines(err)).toHaveLength(1);
    expect(JSON.parse(String(noWaitUntilLines(err)[0]![0]))).toEqual({ event: 'ALERT_NO_WAITUNTIL', alertEvent: 'TEST_EVENT' });
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(2));
  });

  it('is not logged outside Vercel, or when a waitUntil is found', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mail.clearContext();
    alertInBackground(alert);
    expect(noWaitUntilLines(err)).toHaveLength(0);

    vi.stubEnv('VERCEL', '1');
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => context };
    alertInBackground(alert);
    expect(noWaitUntilLines(err)).toHaveLength(0);
  });
});
