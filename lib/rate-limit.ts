// Per-client rate limiting for POST /api/lead.

export const DEFAULT_LEAD_RATE_LIMIT = 5;
export const DEFAULT_LEAD_RATE_WINDOW_SEC = 10 * 60;
/** Upper bound on tracked clients; past it the least recently active one is dropped. */
export const MAX_TRACKED_KEYS = 5000;

export interface RateLimitResult {
  allowed: boolean;
  /** Whole seconds until the next hit would be allowed; 0 when allowed. */
  retryAfterSec: number;
}

/** What the handler depends on, so a shared store can replace the in-memory one without touching it. */
export interface RateLimiter {
  hit(key: string, now: number): RateLimitResult;
}

export interface RateLimits {
  max: number;
  windowMs: number;
}

/** A positive integer from the environment; anything else (unset, empty, 0, negative, fractional, text) is the default. */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** LEAD_RATE_LIMIT (max submissions) and LEAD_RATE_WINDOW_SEC, read on every call. */
export function leadRateLimits(): RateLimits {
  return {
    max: positiveIntEnv('LEAD_RATE_LIMIT', DEFAULT_LEAD_RATE_LIMIT),
    windowMs: positiveIntEnv('LEAD_RATE_WINDOW_SEC', DEFAULT_LEAD_RATE_WINDOW_SEC) * 1000,
  };
}

/**
 * Sliding-window limiter kept in this instance's memory: at most `max` hits per key within `windowMs`.
 * A refused hit is not recorded, so a client that backs off regains its budget as the window slides.
 *
 * The limit is per serverless instance. It stops a burst from one source that lands on one instance, but it is
 * not a global quota across Vercel instances; Turnstile is the bot defence.
 */
export function createMemoryRateLimiter(limits: () => RateLimits, maxKeys: number = MAX_TRACKED_KEYS) {
  // Insertion order is last-activity order (an updated key is re-inserted), so the front is always the
  // stalest client: that is where both expiry pruning and cap eviction take from.
  const hits = new Map<string, number[]>();

  function prune(now: number, windowMs: number): void {
    for (const [key, stamps] of hits) {
      if (stamps[stamps.length - 1]! > now - windowMs) break;
      hits.delete(key);
    }
  }

  return {
    hit(key: string, now: number): RateLimitResult {
      const { max, windowMs } = limits();
      prune(now, windowMs);

      const stamps = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
      if (stamps.length >= max) {
        const retryAfterSec = Math.max(1, Math.ceil((stamps[0]! + windowMs - now) / 1000));
        return { allowed: false, retryAfterSec };
      }

      stamps.push(now);
      hits.delete(key);
      hits.set(key, stamps);
      while (hits.size > maxKeys) hits.delete(hits.keys().next().value!);
      return { allowed: true, retryAfterSec: 0 };
    },
    /** Number of clients currently tracked. */
    size(): number {
      return hits.size;
    },
    reset(): void {
      hits.clear();
    },
  };
}

const leadLimiter = createMemoryRateLimiter(leadRateLimits);

/**
 * Counts a submission against `ip`. An empty ip (no x-forwarded-for or x-real-ip header) is never limited:
 * keying every such request to one bucket would throttle unrelated clients together. `vercel dev` sends
 * x-real-ip as the loopback address, so local runs are limited like production.
 */
export function checkLeadRate(ip: string, now: number = Date.now()): RateLimitResult {
  if (!ip) return { allowed: true, retryAfterSec: 0 };
  return leadLimiter.hit(ip, now);
}

export function leadRateKeyCount(): number {
  return leadLimiter.size();
}

export function resetLeadRateLimit(): void {
  leadLimiter.reset();
}
