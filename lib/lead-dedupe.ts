// Duplicate-submission guard for POST /api/lead. The browser proposes the Lead ID (a random UUID v4) and sends
// the same one with every retry of one submission (js/form.js), so a retry of a lead that was already stored
// is answered from that lead instead of appending a second row. This file holds the pure parts: which ids
// are accepted, what makes two requests the same submission, and the per-instance memory of the attempts
// running or recently answered. The Sheet lookup is lib/lead-lookup.ts.

/** A lowercase random UUID v4, the shape crypto.randomUUID() and the form's fallback produce. */
const PROPOSED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The Lead ID the browser proposed, or undefined when it sent none or anything but a lowercase UUID v4. */
export function proposedLeadId(value: unknown): string | undefined {
  return typeof value === 'string' && PROPOSED_ID.test(value) ? value : undefined;
}

/**
 * Who sent a lead: the stored email, case folded, and the stored phone. Two requests with one Lead ID are
 * the same submission only when these match, so knowing someone's Lead ID alone never replays their
 * answer (which can carry the token that corrects their email).
 */
export function submitterKey(lead: { email: string; phone: string }): string {
  return `${lead.email.trim().toLowerCase()}\n${lead.phone.trim()}`;
}

/** The status and JSON body /api/lead answered with. */
export interface LeadReply {
  status: number;
  body: Record<string, unknown>;
}

export type Claim =
  /** No attempt with this id is known here: this request writes, then calls settle with its answer. */
  | { kind: 'own'; settle(reply: LeadReply): void }
  /** An attempt by the same submitter is running or answered: this request gets that answer. */
  | { kind: 'join'; reply: Promise<LeadReply> }
  /** The id is held by a different submitter: this request must not use it. */
  | { kind: 'conflict' };

interface Entry {
  who: string;
  reply: Promise<LeadReply>;
  /** When the answer was a success; a settled entry expires `ttlMs` later. Unset while it runs. */
  doneAt?: number;
}

/** How long a successful answer is kept for a retry to reuse without reading the Sheet. */
export const RECENT_TTL_MS = 15 * 60 * 1000;
/** Upper bound on ids held; past it the oldest is dropped (a retry then falls back to the Sheet lookup). */
export const MAX_RECENT = 2000;

/**
 * Attempts on this instance, by proposed Lead ID: running ones, and successful ones for `ttlMs`. A failed
 * attempt is forgotten as soon as it answers, so the next retry writes again. This covers a retry that
 * reaches the same instance while the first request is still running; a retry on another instance is
 * covered only by the Sheet lookup, and only once the first request has appended its row.
 */
export function createRecentLeads(ttlMs: number = RECENT_TTL_MS, maxEntries: number = MAX_RECENT, now: () => number = Date.now) {
  const entries = new Map<string, Entry>();

  function prune(): void {
    const t = now();
    for (const [id, e] of entries) if (e.doneAt !== undefined && t - e.doneAt > ttlMs) entries.delete(id);
  }

  return {
    claim(id: string, who: string): Claim {
      prune();
      const held = entries.get(id);
      if (held) return held.who === who ? { kind: 'join', reply: held.reply } : { kind: 'conflict' };
      let resolve!: (r: LeadReply) => void;
      const entry: Entry = { who, reply: new Promise<LeadReply>((r) => (resolve = r)) };
      entries.set(id, entry);
      // Insertion order is age order, so the front is the oldest id.
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
      return {
        kind: 'own',
        settle(reply: LeadReply) {
          if (reply.status === 200) entry.doneAt = now();
          else if (entries.get(id) === entry) entries.delete(id);
          resolve(reply);
        },
      };
    },
    size(): number {
      return entries.size;
    },
    reset(): void {
      entries.clear();
    },
  };
}

/** This instance's memory for /api/lead. */
export const recentLeads = createRecentLeads();

export function resetRecentLeads(): void {
  recentLeads.reset();
}
