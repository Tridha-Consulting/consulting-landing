import { LAST_COLUMN_LETTER, assertSheetLayout, columnIndex, columnLetter } from './columns.js';
import { EMAIL_CHECK, type EmailCheck } from './email-domain.js';
import { WRITE_DEADLINE_MS, sheetsRequest, tabRef, withDeadline } from './sheets-client.js';

export type CorrectionOutcome =
  | { status: 'updated'; row: number }
  /** No row carries this Lead ID. */
  | { status: 'not_found' }
  /** The row already holds this address with a passing check: an earlier request of the same correction was applied. Nothing is written. */
  | { status: 'already_corrected' }
  /** The row's Email Check is not 'No mail server' and the address differs, so it is not open to change. */
  | { status: 'not_correctable' };

/**
 * Replaces the email of the lead's row, but only while that row's Email Check is 'No mail server',
 * so a row with a working address can never be rewritten through it (a retry of a correction that
 * was already applied is recognised by its address and changes nothing). Reads the tab once, then one batchUpdate writes the Email and Email Check
 * cells and nothing else, so the setter's edits to the rest of the row survive. One deadline covers
 * the token fetch, the read and the write.
 */
export function correctLeadEmail(
  leadId: string,
  email: string,
  emailCheck: EmailCheck,
  { deadlineMs = WRITE_DEADLINE_MS }: { deadlineMs?: number } = {},
): Promise<CorrectionOutcome> {
  return withDeadline('email correction', deadlineMs, async (signal) => {
    const read = await sheetsRequest<{ values?: string[][] }>(
      {
        path: `/values/${encodeURIComponent(`${tabRef()}!A:${LAST_COLUMN_LETTER}`)}`,
        method: 'GET',
        params: { majorDimension: 'ROWS' },
      },
      signal,
    );
    // Refuse before matching: the write below addresses cells by header position.
    assertSheetLayout(read.values?.[0]);
    const rows = read.values ?? [];
    const leadCol = columnIndex('Lead ID');
    // Index 0 is the header row, which a visitor-chosen id must never match.
    let index = -1;
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i]![leadCol] ?? '').trim() === leadId) {
        index = i;
        break;
      }
    }
    if (index < 0) return { status: 'not_found' };
    const current = rows[index]!;
    const check = (current[columnIndex('Email Check')] ?? '').trim();
    if (check !== EMAIL_CHECK.noMailServer) {
      // The first attempt can land while its answer is lost; the retry must not dead-end on a row it already fixed.
      const applied = (check === EMAIL_CHECK.ok || check === EMAIL_CHECK.unchecked) && (current[columnIndex('Email')] ?? '').trim().toLowerCase() === email.trim().toLowerCase();
      return { status: applied ? 'already_corrected' : 'not_correctable' };
    }

    const row = index + 1;
    const at = (header: string, value: string) => ({ range: `${tabRef()}!${columnLetter(columnIndex(header))}${row}`, values: [[value]] });
    await sheetsRequest(
      {
        path: '/values:batchUpdate',
        method: 'POST',
        // RAW so an address is stored as text, never evaluated.
        data: { valueInputOption: 'RAW', data: [at('Email', email), at('Email Check', emailCheck)] },
      },
      signal,
    );
    return { status: 'updated', row };
  });
}
