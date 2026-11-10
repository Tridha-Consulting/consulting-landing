import { describe, expect, it, vi } from 'vitest';
import { EMAIL_CHECK, checkEmailDomain, type MxResolver } from '../lib/email-domain.js';

// A fake resolver is injected into every call: no test here (or anywhere) queries real DNS.

function dnsError(code: string): Error {
  return Object.assign(new Error(`queryMx ${code} example.invalid`), { code });
}

function resolverOf(resolveMx: MxResolver['resolveMx'], cancel?: () => void): MxResolver {
  return { resolveMx, cancel };
}

describe('checkEmailDomain', () => {
  it('OK when the domain has a mail exchanger, and looks up the domain lower-cased without the local part', async () => {
    const resolveMx = vi.fn().mockResolvedValue([{ exchange: 'mx.example.com', priority: 10 }]);
    expect(await checkEmailDomain('Asha@Example.COM', { resolver: resolverOf(resolveMx) })).toBe('OK');
    expect(resolveMx).toHaveBeenCalledExactlyOnceWith('example.com');
  });

  it('OK when at least one record is usable, even beside a "." one', async () => {
    const resolver = resolverOf(async () => [
      { exchange: '.', priority: 0 },
      { exchange: 'mx2.example.com', priority: 20 },
    ]);
    expect(await checkEmailDomain('a@example.com', { resolver })).toBe('OK');
  });

  it.each([['.'], ['']])('"No mail server" for a null MX (RFC 7505), exchange %j', async (exchange) => {
    const resolver = resolverOf(async () => [{ exchange, priority: 0 }]);
    expect(await checkEmailDomain('a@example.com', { resolver })).toBe('No mail server');
  });

  it('"No mail server" for an empty answer', async () => {
    expect(await checkEmailDomain('a@example.com', { resolver: resolverOf(async () => []) })).toBe('No mail server');
  });

  it.each(['ENOTFOUND', 'ENODATA'])('"No mail server" for %s', async (code) => {
    const resolver = resolverOf(async () => {
      throw dnsError(code);
    });
    expect(await checkEmailDomain('a@gmial.co', { resolver })).toBe('No mail server');
  });

  it.each(['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', 'ECANCELLED', 'EREFUSED'])('Unchecked for %s: our DNS trouble never blocks a lead', async (code) => {
    const resolver = resolverOf(async () => {
      throw dnsError(code);
    });
    expect(await checkEmailDomain('a@example.com', { resolver })).toBe('Unchecked');
  });

  it('Unchecked for an error with no code, and for a non-Error rejection', async () => {
    expect(await checkEmailDomain('a@example.com', { resolver: resolverOf(async () => Promise.reject(new Error('boom'))) })).toBe('Unchecked');
    expect(await checkEmailDomain('a@example.com', { resolver: resolverOf(async () => Promise.reject('boom')) })).toBe('Unchecked');
  });

  it('Unchecked at the overall deadline when the resolver hangs, and the resolver is cancelled', async () => {
    const cancel = vi.fn();
    const hung = resolverOf(() => new Promise(() => {}), cancel);
    const started = Date.now();
    expect(await checkEmailDomain('a@example.com', { resolver: hung, deadlineMs: 30 })).toBe('Unchecked');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('a hung resolver without cancel() is still bounded', async () => {
    const hung: MxResolver = { resolveMx: () => new Promise(() => {}) };
    expect(await checkEmailDomain('a@example.com', { resolver: hung, deadlineMs: 20 })).toBe('Unchecked');
  });

  it('uses a deadline of about 2 seconds by default', async () => {
    vi.useFakeTimers();
    try {
      const pending = checkEmailDomain('a@example.com', { resolver: resolverOf(() => new Promise(() => {})) });
      await vi.advanceTimersByTimeAsync(1999);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(await pending).toBe('Unchecked');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an answer before the deadline leaves no timer behind', async () => {
    vi.useFakeTimers();
    try {
      const resolver = resolverOf(async () => [{ exchange: 'mx.example.com', priority: 1 }]);
      expect(await checkEmailDomain('a@example.com', { resolver })).toBe('OK');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Unchecked, without a lookup, when there is no domain to look up', async () => {
    const resolveMx = vi.fn();
    for (const email of ['no-at-sign', 'a@', 'a@.']) {
      expect(await checkEmailDomain(email, { resolver: resolverOf(resolveMx) }), email).toBe('Unchecked');
    }
    expect(resolveMx).not.toHaveBeenCalled();
  });

  it('strips a trailing dot from the domain', async () => {
    const resolveMx = vi.fn().mockResolvedValue([{ exchange: 'mx.example.com', priority: 1 }]);
    await checkEmailDomain('a@example.com.', { resolver: resolverOf(resolveMx) });
    expect(resolveMx).toHaveBeenCalledWith('example.com');
  });

  it('a resolver that cannot be constructed is Unchecked, never a rejection (tests/setup.ts makes the default one throw, so no DNS is queried)', async () => {
    await expect(checkEmailDomain('a@example.com')).resolves.toBe('Unchecked');
  });

  it('exports the three result strings the sheet column holds', () => {
    expect(Object.values(EMAIL_CHECK)).toEqual(['OK', 'No mail server', 'Unchecked']);
  });
});
