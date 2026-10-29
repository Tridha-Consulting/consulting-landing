import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison. Both sides are hashed first so unequal lengths cannot leak through timing. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
