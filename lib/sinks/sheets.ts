import { JWT } from 'google-auth-library';
import { toRow, type LeadRow } from '../columns.js';
import { env } from '../env.js';
import type { LeadSink } from './types.js';

/** One deadline for the whole write: OAuth token fetch plus append. */
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

async function append(lead: LeadRow, signal: AbortSignal): Promise<void> {
  const range = encodeURIComponent(`${env.sheetTab}!A1`);
  // RAW so a name like "=HYPERLINK(...)" is stored as text, never evaluated.
  await getClient().request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.sheetId)}/values/${range}:append`,
    method: 'POST',
    params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
    data: { values: [toRow(lead)] },
    signal,
  });
}

export function createSheetsSink(deadlineMs: number = WRITE_DEADLINE_MS): LeadSink {
  return {
    name: 'sheets',
    async write(lead: LeadRow) {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error(`sheets write exceeded ${deadlineMs}ms`));
        }, deadlineMs);
      });
      try {
        // The token request inside client.request() cannot be aborted, so the race is what bounds it.
        await Promise.race([append(lead, abort.signal), deadline]);
      } catch (err) {
        // A hung token refresh stays cached on the JWT and would fail every later write on this
        // instance, so a failed write discards the client and the next lead starts clean.
        client = undefined;
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export const sheetsSink: LeadSink = createSheetsSink();
