// Web-standard request helpers shared by the JSON endpoints (api/lead.ts, api/lead-email.ts).
// Vercel's Node helper layer, which pre-drains the request stream into req.body, is not in the path,
// so a body is read here exactly once.

/** A request the endpoint refuses before looking at its content; `message` is the `error` of the JSON reply. */
export class BodyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}

/** Parses a JSON body of at most `maxBytes`: a declared length over the cap is refused without reading the stream. */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new BodyError(413, 'payload_too_large');

  const raw = await request.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new BodyError(413, 'payload_too_large');

  try {
    return JSON.parse(raw);
  } catch {
    throw new BodyError(400, 'invalid_json');
  }
}

/** A JSON object body, or a BodyError: an array, a string or null is `invalid_json` like malformed text. */
export async function readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const parsed = await readJson(request, maxBytes);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BodyError(400, 'invalid_json');
  return parsed as Record<string, unknown>;
}

/** Any method other than POST gets a JSON 405 (Vercel's default for an unexported method is an empty body). */
export function methodNotAllowed(): Response {
  return json(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
}

export function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd || (request.headers.get('x-real-ip') ?? '').trim();
}
