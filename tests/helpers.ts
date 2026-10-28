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
