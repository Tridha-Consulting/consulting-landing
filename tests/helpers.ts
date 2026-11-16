import { getExampleNumber } from 'libphonenumber-js/max';
import mobileExamples from 'libphonenumber-js/mobile/examples';
import { BOTTLENECK_OPTIONS, BUDGET_OPTIONS, DECISION_MAKER_OPTIONS, REVENUE_OPTIONS, TECH_TEAM_OPTIONS, TIMELINE_OPTIONS } from '../lib/schema.js';

/**
 * libphonenumber's example Indian mobile, its 10 national digits. The phone tests type it in each shape
 * with phoneShape instead of writing an Indian mobile with +91 or a trunk 0 into a test, which the commit
 * guard refuses as a personal phone number.
 */
export const IN_MOBILE: string = getExampleNumber('IN', mobileExamples)!.nationalNumber;
if (!/^[6-9]\d{9}$/.test(IN_MOBILE)) throw new Error('libphonenumber example for IN is not a 10-digit mobile');

/** The shape with each # replaced by the next digit of `digits`: phoneShape('+91 ##### #####'). */
export function phoneShape(shape: string, digits: string = IN_MOBILE): string {
  let i = 0;
  const typed = shape.replace(/#/g, () => digits.charAt(i++));
  if (i !== digits.length) throw new Error(`${shape} has ${i} digit slots for ${digits.length} digits`);
  return typed;
}

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
