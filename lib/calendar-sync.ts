import { LAST_COLUMN_LETTER, STATUS, assertSheetLayout, columnIndex, columnLetter, formatIST } from './columns.js';
import { CALENDAR_DEADLINE_MS, calendarDeadline, listEvents, type CalendarEvent, type ListQuery } from './calendar-client.js';
import { WRITE_DEADLINE_MS, sheetsRequest, tabRef, withDeadline } from './sheets-client.js';

// Google Calendar invitee responses -> the lead's Status. Cal.com creates a calendar event for each
// booking and invites the booker, but is never told when the booker clicks "No". The decision here
// is pure (planCalendarSync); syncCalendarEvents reads the sheet once and writes the changes in one request.

const COL = {
  status: columnIndex('Status'),
  email: columnIndex('Email'),
  uid: columnIndex('Booking UID'),
  callTime: columnIndex('Call Time (IST)'),
};

/** Cal.com's booking uid from a Google event's iCalUID (`<uid>@Cal.com`), or undefined for any other event. */
export function bookingUidFromICalUid(iCalUid: string | undefined): string | undefined {
  const m = /^(.+)@cal\.com$/i.exec(iCalUid?.trim() ?? '');
  return m?.[1]?.trim() || undefined;
}

export interface StatusChange {
  /** 1-based sheet row. */
  row: number;
  uid: string;
  from: string;
  to: string;
}

export interface CalendarPlan {
  changes: StatusChange[];
  /** Booking uids of Cal events that matched no row, by uid or by time. */
  unmatched: string[];
  /** Booking uids of events matched to a row only through the reschedule fallback (email + call time). */
  matchedByTime: string[];
  /** Booking uids of events whose row was found but whose attendees include nobody with the row's email. */
  bookerNotFound: string[];
  /** Cal events that came back with no attendee list at all (the calendar is shared at free/busy only). */
  withoutAttendees: number;
}

function cell(row: string[], index: number): string {
  return (row[index] ?? '').trim();
}

function sameInstantAsCell(start: string | undefined, callTime: string): boolean {
  if (!start || !callTime) return false;
  const ms = Date.parse(start);
  return Number.isFinite(ms) && formatIST(new Date(ms)) === callTime;
}

/**
 * Cal updates a rescheduled booking's Google event in place, so its iCalUID keeps the ORIGINAL
 * booking uid while the webhook overwrites the row's Booking UID with the new one. The row is then
 * found by who and when: a non-organizer attendee whose email is the row's Email, the event's start
 * (in the webhook's Call Time format) equal to the row's Call Time, and a Status that a live booking
 * can hold. Newest row wins.
 */
function findRowByTime(rows: string[][], event: CalendarEvent): number {
  const emails = new Set(
    (event.attendees ?? []).filter((a) => !a.organizer).map((a) => a.email?.trim().toLowerCase()).filter((e): e is string => !!e),
  );
  for (let i = rows.length - 1; i >= 1; i--) {
    const row = rows[i]!;
    const status = cell(row, COL.status);
    if (status !== STATUS.booked && status !== STATUS.rescheduled && status !== STATUS.declined) continue;
    const email = cell(row, COL.email).toLowerCase();
    if (!email || !emails.has(email)) continue;
    if (sameInstantAsCell(event.start?.dateTime, cell(row, COL.callTime))) return i;
  }
  return -1;
}

/**
 * Decides which Status cells to change. `rows` is the sheet as read, header row included, so
 * row number = index + 1. Only the booker's own response counts: a guest added by the setter
 * who declines changes nothing. Events are applied in order against a running copy of each row's
 * Status, so the same booking appearing twice yields one change, and a re-run on an already
 * updated sheet yields none.
 */
export function planCalendarSync(rows: string[][], events: readonly CalendarEvent[]): CalendarPlan {
  const original = new Map<number, string>();
  const current = new Map<number, string>();
  const unmatched = new Set<string>();
  const matchedByTime = new Set<string>();
  const bookerNotFound = new Set<string>();
  let withoutAttendees = 0;

  for (const event of events) {
    if (event.status === 'cancelled') continue;
    const uid = bookingUidFromICalUid(event.iCalUID);
    if (!uid) continue;
    if (!event.attendees) {
      withoutAttendees++;
      continue;
    }

    // Newest row wins, like lib/cal-booking.ts. Index 0 is the header row and is never matched.
    let index = -1;
    for (let i = rows.length - 1; i >= 1; i--) {
      if (cell(rows[i]!, COL.uid) === uid) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      index = findRowByTime(rows, event);
      if (index < 0) {
        unmatched.add(uid);
        continue;
      }
      matchedByTime.add(uid);
    }

    const email = cell(rows[index]!, COL.email).toLowerCase();
    const booker = email ? event.attendees.find((a) => a.email?.trim().toLowerCase() === email) : undefined;
    if (!booker) {
      bookerNotFound.add(uid);
      continue;
    }

    const status = current.get(index) ?? cell(rows[index]!, COL.status);
    let next = status;
    if (booker.responseStatus === 'declined') {
      if (status === STATUS.booked || status === STATUS.rescheduled) next = STATUS.declined;
    } else if (status === STATUS.declined) {
      next = STATUS.booked;
    }
    if (next === status) continue;
    if (!original.has(index)) original.set(index, status);
    current.set(index, next);
  }

  const changes: StatusChange[] = [];
  for (const [index, to] of current) {
    const from = original.get(index)!;
    if (from !== to) changes.push({ row: index + 1, uid: cell(rows[index]!, COL.uid), from, to });
  }
  return { changes, unmatched: [...unmatched], matchedByTime: [...matchedByTime], bookerNotFound: [...bookerNotFound], withoutAttendees };
}

/**
 * Reads the whole tab once, then writes every Status change in one values.batchUpdate. Nothing but
 * Status cells is touched. One deadline covers the token fetch, the read and the write. A batch of
 * events that carries no Cal booking uid returns without reading the sheet.
 */
export async function syncCalendarEvents(
  events: readonly CalendarEvent[],
  { deadlineMs = WRITE_DEADLINE_MS }: { deadlineMs?: number } = {},
): Promise<{ changes: StatusChange[] }> {
  if (!events.some((e) => bookingUidFromICalUid(e.iCalUID))) return { changes: [] };
  const plan = await withDeadline('calendar sheet sync', deadlineMs, async (signal) => {
    const read = await sheetsRequest<{ values?: string[][] }>(
      {
        path: `/values/${encodeURIComponent(`${tabRef()}!A:${LAST_COLUMN_LETTER}`)}`,
        method: 'GET',
        params: { majorDimension: 'ROWS' },
      },
      signal,
    );
    // Refuse before planning: the write addresses a cell by the position of the Status header.
    assertSheetLayout(read.values?.[0]);
    const p = planCalendarSync(read.values ?? [], events);
    if (p.changes.length) {
      await sheetsRequest(
        {
          path: '/values:batchUpdate',
          method: 'POST',
          data: {
            // RAW, like every other write here, so nothing is ever evaluated as a formula.
            valueInputOption: 'RAW',
            data: p.changes.map((c) => ({ range: `${tabRef()}!${columnLetter(COL.status)}${c.row}`, values: [[c.to]] })),
          },
        },
        signal,
      );
    }
    return p;
  });

  // Identifiers only: no names or emails in logs.
  for (const uid of plan.unmatched) console.log(JSON.stringify({ event: 'CALENDAR_EVENT_UNMATCHED', uid }));
  for (const uid of plan.matchedByTime) console.log(JSON.stringify({ event: 'CALENDAR_EVENT_MATCHED_BY_TIME', uid }));
  for (const uid of plan.bookerNotFound) console.log(JSON.stringify({ event: 'CALENDAR_BOOKER_NOT_FOUND', uid }));
  if (plan.withoutAttendees > 0) {
    console.log(
      JSON.stringify({
        event: 'CALENDAR_EVENTS_WITHOUT_ATTENDEES',
        count: plan.withoutAttendees,
        hint: 'share the calendar with the service account with "See all event details"',
      }),
    );
  }
  for (const { uid, from, to } of plan.changes) console.log(JSON.stringify({ event: 'CALENDAR_STATUS_CHANGED', uid, from, to }));
  return { changes: plan.changes };
}

/** Lists the calendar's events under one deadline, then syncs them; both bounded separately, so each has its own full budget. */
export async function syncFromCalendar(calendarId: string, query: ListQuery): Promise<{ events: number; changes: StatusChange[] }> {
  const events = await calendarDeadline('calendar list', CALENDAR_DEADLINE_MS, (signal) => listEvents(calendarId, query, signal));
  const { changes } = await syncCalendarEvents(events);
  return { events: events.length, changes };
}
