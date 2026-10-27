import { LAST_COLUMN_LETTER, assertSheetLayout, columnIndex, columnLetter } from './columns.js';
import { planBooking, type Booking, type BookingTrigger, type MatchedBy } from './cal-booking.js';
import { env } from './env.js';
import { WRITE_DEADLINE_MS, sheetsRequest, withDeadline } from './sheets-client.js';

export interface SyncOutcome {
  matchedBy: MatchedBy;
  /** 1-based sheet row; null only if an append response named no range. */
  row: number | null;
  /** Set when nothing was written because the event was out of date. */
  stale?: 'stale_event' | 'stale_cancellation';
  /** A timestamp was ignored as too far in the future; see Plan.warn. */
  warn?: string;
  /** Custom booking-form keys with a value but no column; see Plan.unmapped. */
  unmapped?: string[];
}

/** A1 tab reference, quoted so tab names with spaces or punctuation resolve. */
function tabRef(): string {
  return `'${env.sheetTab.replace(/'/g, "''")}'`;
}

/**
 * Reads the whole tab once, then writes the lead's booking cells in one request (or appends one row).
 * One deadline covers the token fetch, the read and the write.
 */
export function syncBooking(
  trigger: BookingTrigger,
  booking: Booking,
  { eventAt, now = new Date(), deadlineMs = WRITE_DEADLINE_MS }: { eventAt?: string; now?: Date; deadlineMs?: number } = {},
): Promise<SyncOutcome> {
  return withDeadline('sheets sync', deadlineMs, async (signal) => {
    const read = await sheetsRequest<{ values?: string[][] }>(
      {
        path: `/values/${encodeURIComponent(`${tabRef()}!A:${LAST_COLUMN_LETTER}`)}`,
        method: 'GET',
        params: { majorDimension: 'ROWS' },
      },
      signal,
    );
    // Refuse before planning: every write below addresses cells by header position.
    assertSheetLayout(read.values?.[0]);
    const plan = planBooking(read.values ?? [], trigger, booking, now, eventAt);

    if (plan.action === 'stale') {
      return { matchedBy: plan.matchedBy, row: plan.row, stale: plan.reason === 'event' ? 'stale_event' : 'stale_cancellation', warn: plan.warn };
    }

    if (plan.action === 'append') {
      // RAW so attendee-supplied text such as "=HYPERLINK(...)" is stored, never evaluated.
      const res = await sheetsRequest<{ updates?: { updatedRange?: string } }>(
        {
          path: `/values/${encodeURIComponent(`${tabRef()}!A1`)}:append`,
          method: 'POST',
          params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
          data: { values: [plan.values] },
        },
        signal,
      );
      const m = /!\$?[A-Z]+(\d+)/.exec(res.updates?.updatedRange ?? '');
      return { matchedBy: 'appended', row: m ? Number(m[1]) : null, warn: plan.warn, unmapped: plan.unmapped };
    }

    // One batchUpdate touches only the booking cells, so a setter's edits to the rest of
    // the row (or a lead written between our read and write) are never overwritten.
    const at = (header: string, value: string) => ({
      range: `${tabRef()}!${columnLetter(columnIndex(header))}${plan.row}`,
      values: [[value]],
    });
    const { cells } = plan;
    await sheetsRequest(
      {
        path: '/values:batchUpdate',
        method: 'POST',
        data: {
          valueInputOption: 'RAW',
          data: [
            at('Status', cells.status),
            at('Call Time (IST)', cells.callTime),
            at('Booking Details', cells.details),
            at('Booking UID', cells.uid),
            // Left alone when the event carried no createdAt, so the stored order marker survives.
            ...(cells.lastEventAt ? [at('Last Event At', cells.lastEventAt)] : []),
            // Only a BOOKING_CREATED sets this, and only non-empty answers are written, so a later
            // event that omits them leaves the stored values alone.
            ...(cells.bookedAt ? [at('Booked At (IST)', cells.bookedAt)] : []),
            ...cells.answers.map((a) => at(a.header, a.value)),
          ],
        },
      },
      signal,
    );
    return { matchedBy: plan.matchedBy, row: plan.row, warn: plan.warn, unmapped: plan.unmapped };
  });
}
