export const validBody = {
  fullName: 'Asha Rao',
  email: 'asha@example.com',
  phone: '+919812345678',
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
