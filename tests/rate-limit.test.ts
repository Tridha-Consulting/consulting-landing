import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LEAD_RATE_LIMIT,
  DEFAULT_LEAD_RATE_WINDOW_SEC,
  MAX_TRACKED_KEYS,
  checkLeadRate,
  createMemoryRateLimiter,
  leadRateKeyCount,
  leadRateLimits,
  resetLeadRateLimit,
} from '../lib/rate-limit.js';

const WINDOW_MS = 10 * 60 * 1000;

beforeEach(() => resetLeadRateLimit());
afterEach(() => vi.unstubAllEnvs());

describe('createMemoryRateLimiter', () => {
  const make = (max = 3, windowMs = 60_000, maxKeys?: number) => createMemoryRateLimiter(() => ({ max, windowMs }), maxKeys);

  it('allows max hits, then refuses', () => {
    const l = make(3);
    expect([0, 1, 2].map((i) => l.hit('a', i * 1000).allowed)).toEqual([true, true, true]);
    expect(l.hit('a', 3000).allowed).toBe(false);
  });

  it('slides: the oldest hit leaving the window frees exactly one slot', () => {
    const l = make(3, 60_000);
    l.hit('a', 0);
    l.hit('a', 10_000);
    l.hit('a', 20_000);
    expect(l.hit('a', 59_999).allowed).toBe(false);
    expect(l.hit('a', 60_001).allowed).toBe(true); // hit at t=0 expired
    expect(l.hit('a', 60_002).allowed).toBe(false); // t=10s, 20s and 60.001s still count
    expect(l.hit('a', 70_001).allowed).toBe(true); // t=10s expired
  });

  it('retryAfterSec is the whole seconds until the oldest hit expires, rounded up, at least 1', () => {
    const l = make(2, 60_000);
    l.hit('a', 0);
    l.hit('a', 5_000);
    expect(l.hit('a', 10_000)).toEqual({ allowed: false, retryAfterSec: 50 });
    expect(l.hit('a', 10_500)).toEqual({ allowed: false, retryAfterSec: 50 }); // 49.5 s rounds up
    expect(l.hit('a', 59_999).retryAfterSec).toBe(1);
    expect(l.hit('b', 0)).toEqual({ allowed: true, retryAfterSec: 0 });
  });

  it('refused hits are not recorded, so waiting out the window restores the full budget', () => {
    const l = make(2, 60_000);
    l.hit('a', 0);
    l.hit('a', 1);
    for (let i = 0; i < 50; i++) l.hit('a', 2 + i);
    expect(l.hit('a', 60_001).allowed).toBe(true);
  });

  it('keys are independent', () => {
    const l = make(1);
    expect(l.hit('a', 0).allowed).toBe(true);
    expect(l.hit('a', 1).allowed).toBe(false);
    expect(l.hit('b', 1).allowed).toBe(true);
  });

  it('drops expired keys', () => {
    const l = make(3, 60_000);
    for (let i = 0; i < 100; i++) l.hit(`ip${i}`, i);
    expect(l.size()).toBe(100);
    l.hit('late', 200_000);
    expect(l.size()).toBe(1);
  });

  it('caps tracked keys by evicting the least recently active one', () => {
    const l = make(1, 60_000, 3);
    l.hit('a', 0);
    l.hit('b', 1);
    l.hit('c', 2);
    l.hit('d', 3);
    expect(l.size()).toBe(3);
    expect(l.hit('a', 4).allowed).toBe(true); // evicted, so it starts over (and now evicts b)
    expect(l.hit('c', 5).allowed).toBe(false); // still tracked
    expect(l.size()).toBe(3);
  });

  it('a flood of rotating keys never exceeds the cap', () => {
    const l = make(5, WINDOW_MS);
    for (let i = 0; i < MAX_TRACKED_KEYS + 500; i++) l.hit(`ip${i}`, i);
    expect(l.size()).toBe(MAX_TRACKED_KEYS);
  });
});

describe('leadRateLimits (environment)', () => {
  it('defaults to 5 per 10 minutes', () => {
    expect(DEFAULT_LEAD_RATE_LIMIT).toBe(5);
    expect(DEFAULT_LEAD_RATE_WINDOW_SEC).toBe(600);
    expect(leadRateLimits()).toEqual({ max: 5, windowMs: WINDOW_MS });
  });

  it('LEAD_RATE_LIMIT and LEAD_RATE_WINDOW_SEC override', () => {
    vi.stubEnv('LEAD_RATE_LIMIT', '2');
    vi.stubEnv('LEAD_RATE_WINDOW_SEC', '30');
    expect(leadRateLimits()).toEqual({ max: 2, windowMs: 30_000 });
    expect(checkLeadRate('1.1.1.1', 0).allowed).toBe(true);
    expect(checkLeadRate('1.1.1.1', 1).allowed).toBe(true);
    expect(checkLeadRate('1.1.1.1', 2)).toEqual({ allowed: false, retryAfterSec: 30 });
    expect(checkLeadRate('1.1.1.1', 30_000).allowed).toBe(true);
  });

  it.each(['', ' ', '0', '-3', 'abc', '2.5', '5abc', 'NaN', 'Infinity'])('invalid value %j falls back to the default, never disables', (bad) => {
    vi.stubEnv('LEAD_RATE_LIMIT', bad);
    vi.stubEnv('LEAD_RATE_WINDOW_SEC', bad);
    expect(leadRateLimits()).toEqual({ max: 5, windowMs: WINDOW_MS });
  });
});

describe('checkLeadRate', () => {
  it('limits an ip after 5 submissions in 10 minutes and reports the wait', () => {
    for (let i = 0; i < 5; i++) expect(checkLeadRate('203.0.113.9', i * 1000).allowed).toBe(true);
    expect(checkLeadRate('203.0.113.9', 5000)).toEqual({ allowed: false, retryAfterSec: 595 });
  });

  it('an empty ip is never limited and is not tracked', () => {
    for (let i = 0; i < 50; i++) expect(checkLeadRate('', i).allowed).toBe(true);
    expect(leadRateKeyCount()).toBe(0);
  });

  it('resetLeadRateLimit clears every client', () => {
    for (let i = 0; i < 5; i++) checkLeadRate('9.9.9.9', i);
    expect(checkLeadRate('9.9.9.9', 6).allowed).toBe(false);
    resetLeadRateLimit();
    expect(checkLeadRate('9.9.9.9', 7).allowed).toBe(true);
  });
});
