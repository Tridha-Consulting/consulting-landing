import { toRow, type LeadRow } from '../columns.js';
import { env } from '../env.js';
import { WRITE_DEADLINE_MS, sheetsRequest, withDeadline } from '../sheets-client.js';
import type { LeadSink } from './types.js';

export { WRITE_DEADLINE_MS };

async function append(lead: LeadRow, signal: AbortSignal): Promise<void> {
  const range = encodeURIComponent(`${env.sheetTab}!A1`);
  // RAW so a name like "=HYPERLINK(...)" is stored as text, never evaluated.
  await sheetsRequest(
    {
      path: `/values/${range}:append`,
      method: 'POST',
      params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
      data: { values: [toRow(lead)] },
    },
    signal,
  );
}

export function createSheetsSink(deadlineMs: number = WRITE_DEADLINE_MS): LeadSink {
  return {
    name: 'sheets',
    write: (lead: LeadRow) => withDeadline('sheets write', deadlineMs, (signal) => append(lead, signal)),
  };
}

export const sheetsSink: LeadSink = createSheetsSink();
