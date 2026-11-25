import { expect } from 'vitest';
import { BOTTLENECK_OPTIONS, BUDGET_OPTIONS, DECISION_MAKER_OPTIONS, REVENUE_OPTIONS, TECH_TEAM_OPTIONS, TIMELINE_OPTIONS } from '../lib/schema.js';

export const validBody = {
  fullName: 'Asha Rao',
  designation: 'Founder',
  phone: '+919812345678',
  email: 'asha@example.com',
  company: 'Rao Textiles',
  website: 'raotextiles.in',
  revenue: REVENUE_OPTIONS[1],
  budget: BUDGET_OPTIONS[2],
  bottleneck: [BOTTLENECK_OPTIONS[0], BOTTLENECK_OPTIONS[3]],
  techTeam: TECH_TEAM_OPTIONS[1],
  timeline: TIMELINE_OPTIONS[0],
  decisionMaker: DECISION_MAKER_OPTIONS[0],
  utmSource: 'meta',
  landingUrl: 'https://consulting.tridha.net/?utm_source=meta',
};

/** A real Request, the same shape Vercel's Web handler runtime passes to POST(). */
export function makeRequest(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
  return new Request('https://consulting.tridha.net/api/lead', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
}

export async function readJsonResponse(res: Response): Promise<{ status: number; headers: Headers; body: unknown }> {
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}

/**
 * A lead with every field of the form filled with a value of its own, so a mail that drops or swaps a field is
 * noticed: the 12 answers (name, email, phone and nine questions), the 13 attribution fields, nothing else.
 */
export const fullBody = {
  ...validBody,
  fullName: 'Asha Rao',
  designation: 'Founder and Director',
  company: 'Rao Textiles',
  website: 'raotextiles.in',
  utmSource: 'utmSource-value',
  utmMedium: 'utmMedium-value',
  utmCampaign: 'utmCampaign-value',
  utmContent: 'utmContent-value',
  utmTerm: 'utmTerm-value',
  fbclid: 'fbclid-value',
  gclid: 'gclid-value',
  liFatId: 'liFatId-value',
  twclid: 'twclid-value',
  gbraid: 'gbraid-value',
  wbraid: 'wbraid-value',
  referrer: 'https://referrer.example.com/page',
  landingUrl: 'https://consulting.tridha.net/?utm_source=utmSource-value',
};

/** The JSON that follows "Details:" in an alert body. */
export function detailsOf(text: string): Record<string, unknown> {
  const at = text.indexOf('\nDetails:\n');
  if (at < 0) throw new Error('no Details section in the mail body');
  return JSON.parse(text.slice(at + '\nDetails:\n'.length)) as Record<string, unknown>;
}

/** Every field of `fullBody` is in `lead`, each with the value it was sent with (the 12 answers and 13 attribution fields). */
export function expectEveryLeadField(lead: Record<string, unknown>): void {
  expect(Object.keys(fullBody)).toHaveLength(12 + 13);
  const values = Object.values(fullBody).map((v) => JSON.stringify(v));
  expect(new Set(values).size, 'fixture values are distinct').toBe(values.length);
  for (const [key, value] of Object.entries(fullBody)) expect(lead[key], key).toEqual(value);
}

/** The submission context of a mail's Details: the browser's proposed lead id, its User-Agent and its ip. */
export function expectSubmissionContext(details: Record<string, unknown>, expected: { leadId: string; userAgent: string; ip: string }): void {
  expect(details.leadId, 'leadId').toBe(expected.leadId);
  expect(details.userAgent, 'userAgent').toBe(expected.userAgent);
  expect(details.ip, 'ip').toBe(expected.ip);
  expect(details.submittedAt, 'submittedAt').toEqual(expect.any(String));
}

/** A lead id as the browser proposes it (a UUID v4). */
export const PROPOSED_ID = '9b2f3c1e-5d4a-4f6b-8a7c-1e2d3f4a5b6c';
