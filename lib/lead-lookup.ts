import { LAST_COLUMN_LETTER, columnIndex, columnLetter } from './columns.js';
import { sheetsRequest, tabRef, withDeadline } from './sheets-client.js';

/**
 * How long /api/lead waits for the duplicate check before it gives up and appends anyway. It runs beside the
 * 2 second MX lookup, so the most it adds to a request is about 2 seconds over that, which keeps the slowest
 * path (Turnstile 5 s, this, the 8 s append, the 2 s audit row) under the form's 20 second abort.
 */
export const LOOKUP_DEADLINE_MS = 4000;

/** The cells of a stored lead that a retry is answered from. */
export interface StoredLead {
  /** 1-based sheet row. */
  row: number;
  email: string;
  phone: string;
  emailCheck: string;
}

/**
 * The lead whose Lead ID is `leadId`, or null when no row has it. Reads the Lead ID column, then, on a match,
 * that one row; the row's own Lead ID cell is checked again, so a sheet sorted between the two reads is
 * reported as an error rather than answered from another lead's row. Index 0 is the header, never a lead.
 * One deadline covers the token fetch and both reads. Read-only: it never writes.
 */
export function findLead(leadId: string, { deadlineMs = LOOKUP_DEADLINE_MS }: { deadlineMs?: number } = {}): Promise<StoredLead | null> {
  return withDeadline(
    'lead lookup',
    deadlineMs,
    async (signal) => {
      const idCol = columnIndex('Lead ID');
      const letter = columnLetter(idCol);
      const ids = await sheetsRequest<{ values?: string[][] }>(
        { path: `/values/${encodeURIComponent(`${tabRef()}!${letter}:${letter}`)}`, method: 'GET', params: { majorDimension: 'COLUMNS' } },
        signal,
      );
      const cells = ids.values?.[0] ?? [];
      const index = cells.findIndex((cell, i) => i > 0 && String(cell ?? '').trim() === leadId);
      if (index < 0) return null;
      const row = index + 1;
      const got = await sheetsRequest<{ values?: string[][] }>(
        { path: `/values/${encodeURIComponent(`${tabRef()}!A${row}:${LAST_COLUMN_LETTER}${row}`)}`, method: 'GET', params: { majorDimension: 'ROWS' } },
        signal,
      );
      const cellsOfRow = got.values?.[0] ?? [];
      const cell = (header: string) => String(cellsOfRow[columnIndex(header)] ?? '').trim();
      if (cell('Lead ID') !== leadId) throw new Error(`lead lookup: row ${row} no longer holds the Lead ID it was found by`);
      return { row, email: cell('Email'), phone: cell('Phone'), emailCheck: cell('Email Check') };
    },
    // A 4xx (a missing tab, say) means the token and client work: keep them for the append that follows.
    { keepClientOnHttp4xx: true },
  );
}
