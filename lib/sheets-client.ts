import { JWT } from 'google-auth-library';
import { env } from './env.js';

/** One deadline for a whole Sheets operation: OAuth token fetch plus the API calls. */
export const WRITE_DEADLINE_MS = 8000;

let client: JWT | undefined;

function getClient(): JWT {
  client ??= new JWT({
    email: env.serviceAccountEmail,
    key: env.privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return client;
}

/** A1 tab reference, quoted so tab names with spaces or punctuation resolve. */
export function tabRef(): string {
  return `'${env.sheetTab.replace(/'/g, "''")}'`;
}

export interface SheetsRequest {
  /** Path under `/v4/spreadsheets/{sheetId}`, already URL-encoded, e.g. `/values/Leads!A1:append`. */
  path: string;
  method: 'GET' | 'POST';
  params?: Record<string, string>;
  data?: unknown;
}

export async function sheetsRequest<T = unknown>(req: SheetsRequest, signal: AbortSignal): Promise<T> {
  const res = await getClient().request<T>({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.sheetId)}${req.path}`,
    method: req.method,
    params: req.params,
    data: req.data,
    signal,
  });
  return res.data;
}

/**
 * Runs `run` under one deadline and discards the cached client when it fails, so a hung token
 * refresh cannot fail every later call on this instance. `what` prefixes the timeout message.
 */
export async function withDeadline<T>(what: string, deadlineMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`${what} exceeded ${deadlineMs}ms`));
    }, deadlineMs);
  });
  try {
    // The token request inside client.request() cannot be aborted, so the race is what bounds it.
    return await Promise.race([run(abort.signal), deadline]);
  } catch (err) {
    // A hung token refresh stays cached on the JWT and would fail every later request on this
    // instance, so a failure discards the client and the next call starts clean.
    client = undefined;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
