import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEADERS, STATUS } from '../lib/columns.js';
import { bookingUidFromICalUid, planCalendarSync } from '../lib/calendar-sync.js';
import { CALENDAR_ID, COL, SHEET_ID, calEvent, fake, leadRow, privateKey, resetFakes } from './calendar-fakes.js';

// lib/calendar-sync.ts imports lib/env.ts, which validates at load; the pure tests below never build a client.
vi.hoisted(() => {
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'unused@proj.iam.gserviceaccount.com';
  process.env.GOOGLE_PRIVATE_KEY = 'unused';
  process.env.SHEET_ID = 'unused';
});

vi.mock('google-auth-library', async () => {
  const actual = await vi.importActual<typeof import('google-auth-library')>('google-auth-library');
  const { mockJwt } = await import('./calendar-fakes.js');
  return mockJwt(actual);
});

const header = [...HEADERS];

describe('bookingUidFromICalUid', () => {
  it.each([
    ['testUid000000000000000@Cal.com', 'testUid000000000000000'],
    ['abc@cal.com', 'abc'],
    ['abc@CAL.COM', 'abc'],
    ['  abc@Cal.com ', 'abc'],
  ])('%s -> %s', (input, uid) => {
    expect(bookingUidFromICalUid(input)).toBe(uid);
  });

  it.each([undefined, '', '@Cal.com', 'abc@google.com', 'abc@Cal.com.evil.test', 'abc', 'abc@cal.comx'])('ignores %j', (input) => {
    expect(bookingUidFromICalUid(input)).toBeUndefined();
  });
});

describe('planCalendarSync', () => {
  const sheetWith = (...rows: string[][]) => [header, ...rows];

  it('flags a Booked lead whose booker declined', () => {
    const plan = planCalendarSync(sheetWith(leadRow({ status: STATUS.booked, uid: 'u1' })), [calEvent({ uid: 'u1', response: 'declined' })]);
    expect(plan.changes).toEqual([{ row: 2, uid: 'u1', from: 'Booked', to: 'Declined' }]);
  });

  it('flags a Rescheduled lead whose booker declined', () => {
    const plan = planCalendarSync(sheetWith(leadRow({ status: STATUS.rescheduled, uid: 'u1' })), [calEvent({ uid: 'u1', response: 'declined' })]);
    expect(plan.changes).toEqual([{ row: 2, uid: 'u1', from: 'Rescheduled', to: 'Declined' }]);
  });

  it('returns a Declined lead to Booked when the booker accepts again', () => {
    for (const response of ['accepted', 'tentative', 'needsAction']) {
      const plan = planCalendarSync(sheetWith(leadRow({ status: STATUS.declined, uid: 'u1' })), [calEvent({ uid: 'u1', response })]);
      expect(plan.changes).toEqual([{ row: 2, uid: 'u1', from: 'Declined', to: 'Booked' }]);
    }
  });

  it('ignores a decline by another guest', () => {
    const event = calEvent({ uid: 'u1', response: 'accepted', guests: [{ email: 'closer@example.com', responseStatus: 'declined' }] });
    expect(planCalendarSync(sheetWith(leadRow({ status: STATUS.booked, uid: 'u1' })), [event]).changes).toEqual([]);
  });

  it('does not un-flag a Declined lead because another guest accepted while the booker is still declined', () => {
    const event = calEvent({ uid: 'u1', response: 'declined', guests: [{ email: 'closer@example.com', responseStatus: 'accepted' }] });
    expect(planCalendarSync(sheetWith(leadRow({ status: STATUS.declined, uid: 'u1' })), [event]).changes).toEqual([]);
  });

  it('finds the booker by email, ignoring case and spaces', () => {
    const rows = sheetWith(leadRow({ status: STATUS.booked, uid: 'u1', email: ' Booker@Example.COM ' }));
    const plan = planCalendarSync(rows, [calEvent({ uid: 'u1', booker: 'booker@example.com', response: 'declined' })]);
    expect(plan.changes).toHaveLength(1);
  });

  it('does nothing when no attendee matches the row email', () => {
    const rows = sheetWith(leadRow({ status: STATUS.booked, uid: 'u1', email: 'someone.else@example.com' }));
    expect(planCalendarSync(rows, [calEvent({ uid: 'u1', response: 'declined' })]).changes).toEqual([]);
  });

  it.each([STATUS.cancelled, STATUS.new, ''])('leaves a %j row alone on a decline', (status) => {
    expect(planCalendarSync(sheetWith(leadRow({ status, uid: 'u1' })), [calEvent({ uid: 'u1', response: 'declined' })]).changes).toEqual([]);
  });

  it.each([STATUS.cancelled, STATUS.new])('leaves a %s row alone when the booker has not declined', (status) => {
    expect(planCalendarSync(sheetWith(leadRow({ status, uid: 'u1' })), [calEvent({ uid: 'u1', response: 'accepted' })]).changes).toEqual([]);
  });

  it('leaves an already Declined row alone on another decline', () => {
    expect(planCalendarSync(sheetWith(leadRow({ status: STATUS.declined, uid: 'u1' })), [calEvent({ uid: 'u1', response: 'declined' })]).changes).toEqual([]);
  });

  it('ignores a cancelled Google event', () => {
    const rows = sheetWith(leadRow({ status: STATUS.booked, uid: 'u1' }));
    expect(planCalendarSync(rows, [calEvent({ uid: 'u1', response: 'declined', status: 'cancelled' })]).changes).toEqual([]);
  });

  it('ignores events that are not Cal bookings', () => {
    const rows = sheetWith(leadRow({ status: STATUS.booked, uid: 'u1' }));
    const plan = planCalendarSync(rows, [{ iCalUID: 'u1@google.com', attendees: [{ email: 'booker@example.com', responseStatus: 'declined' }] }, {}]);
    expect(plan).toEqual({ changes: [], unmatched: [], matchedByTime: [], bookerNotFound: [], withoutAttendees: 0 });
  });

  it('reports an unmatched uid once and writes nothing', () => {
    const rows = sheetWith(leadRow({ status: STATUS.booked, uid: 'u1' }));
    const plan = planCalendarSync(rows, [calEvent({ uid: 'zzz', response: 'declined' }), calEvent({ uid: 'zzz', response: 'declined' })]);
    expect(plan).toMatchObject({ changes: [], unmatched: ['zzz'] });
  });

  it('never matches the header row, whatever the event uid says', () => {
    const plan = planCalendarSync(sheetWith(), [calEvent({ uid: 'Booking UID', booker: 'Email', response: 'declined' })]);
    expect(plan).toMatchObject({ changes: [], unmatched: ['Booking UID'] });
  });

  it('matches the newest row when a uid appears twice', () => {
    const rows = sheetWith(leadRow({ status: STATUS.booked, uid: 'u1', id: 'a' }), leadRow({ status: STATUS.booked, uid: 'u1', id: 'b' }));
    expect(planCalendarSync(rows, [calEvent({ uid: 'u1', response: 'declined' })]).changes).toMatchObject([{ row: 3 }]);
  });

  it('collapses the same booking listed twice into one change, and a decline then re-accept into none', () => {
    const rows = sheetWith(leadRow({ status: STATUS.booked, uid: 'u1' }));
    const declined = calEvent({ uid: 'u1', response: 'declined' });
    expect(planCalendarSync(rows, [declined, declined]).changes).toHaveLength(1);
    expect(planCalendarSync(rows, [declined, calEvent({ uid: 'u1', response: 'accepted' })]).changes).toEqual([]);
  });

  it('flags a decline when the attendee email differs from the row only in case', () => {
    const rows = sheetWith(leadRow({ status: STATUS.booked, uid: 'u1', email: 'asha@x.com' }));
    expect(planCalendarSync(rows, [calEvent({ uid: 'u1', booker: 'ASHA@X.COM', response: 'declined' })]).changes).toHaveLength(1);
  });

  describe('booker not found', () => {
    it('reports the uid when a row matches but no attendee has the row email', () => {
      const rows = sheetWith(leadRow({ status: STATUS.booked, uid: 'u1', email: 'someone.else@example.com' }));
      const plan = planCalendarSync(rows, [calEvent({ uid: 'u1', response: 'declined' }), calEvent({ uid: 'u1', response: 'declined' })]);
      expect(plan).toMatchObject({ changes: [], unmatched: [], bookerNotFound: ['u1'] });
    });

    it('does not report it when the booker is found', () => {
      const rows = sheetWith(leadRow({ status: STATUS.booked, uid: 'u1' }));
      expect(planCalendarSync(rows, [calEvent({ uid: 'u1', response: 'declined' })]).bookerNotFound).toEqual([]);
    });
  });

  describe('events without attendees', () => {
    it('counts Cal events that carry no attendee list and makes no change', () => {
      const rows = sheetWith(leadRow({ status: STATUS.booked, uid: 'u1' }));
      const plan = planCalendarSync(rows, [calEvent({ uid: 'u1', noAttendees: true }), calEvent({ uid: 'u2', noAttendees: true })]);
      expect(plan).toEqual({ changes: [], unmatched: [], matchedByTime: [], bookerNotFound: [], withoutAttendees: 2 });
    });

    it('does not count cancelled events, non-Cal events or events that have an attendee list', () => {
      const rows = sheetWith(leadRow({ status: STATUS.booked, uid: 'u1' }));
      const plan = planCalendarSync(rows, [
        calEvent({ uid: 'u1', noAttendees: true, status: 'cancelled' }),
        { iCalUID: 'x@google.com' },
        calEvent({ uid: 'u1', response: 'accepted' }),
      ]);
      expect(plan.withoutAttendees).toBe(0);
    });
  });

  // Cal updates a rescheduled booking's Google event in place (iCalUID keeps the ORIGINAL uid) while
  // the webhook overwrites the row's Booking UID with the new booking's uid.
  describe('reschedule fallback (email + call time)', () => {
    const START = '2026-11-05T12:00:00+05:30';
    const CALL_TIME = '2026-11-05 12:00:00';
    const rescheduled = (o: { status?: string; callTime?: string; email?: string } = {}) =>
      leadRow({ status: o.status ?? STATUS.rescheduled, uid: 'newUid', callTime: o.callTime ?? CALL_TIME, ...(o.email && { email: o.email }) });
    const oldEvent = (o: { response?: string; start?: string; booker?: string } = {}) =>
      calEvent({ uid: 'oldUid', response: o.response ?? 'declined', start: o.start ?? START, ...(o.booker && { booker: o.booker }) });

    it('flags the decline on the row holding the new uid and reports the match by time', () => {
      const plan = planCalendarSync(sheetWith(rescheduled()), [oldEvent()]);
      expect(plan.changes).toEqual([{ row: 2, uid: 'newUid', from: 'Rescheduled', to: 'Declined' }]);
      expect(plan.matchedByTime).toEqual(['oldUid']);
      expect(plan.unmatched).toEqual([]);
    });

    it('compares the instant, whatever offset the event start carries', () => {
      const plan = planCalendarSync(sheetWith(rescheduled()), [oldEvent({ start: '2026-11-05T06:30:00Z' })]);
      expect(plan.changes).toHaveLength(1);
    });

    it('writes nothing and reports the uid unmatched when the call time differs', () => {
      const plan = planCalendarSync(sheetWith(rescheduled({ callTime: '2026-11-05 12:30:00' })), [oldEvent()]);
      expect(plan).toMatchObject({ changes: [], unmatched: ['oldUid'], matchedByTime: [] });
    });

    it('does not match an event with no start, or an unparseable one', () => {
      const noStart = oldEvent();
      delete noStart.start;
      expect(planCalendarSync(sheetWith(rescheduled()), [noStart]).unmatched).toEqual(['oldUid']);
      expect(planCalendarSync(sheetWith(rescheduled()), [oldEvent({ start: 'not a date' })]).unmatched).toEqual(['oldUid']);
    });

    it('does not match a row without a call time', () => {
      expect(planCalendarSync(sheetWith(rescheduled({ callTime: '' })), [oldEvent()]).unmatched).toEqual(['oldUid']);
    });

    it.each([STATUS.cancelled, STATUS.new, ''])('never matches a %j row', (status) => {
      const plan = planCalendarSync(sheetWith(rescheduled({ status })), [oldEvent()]);
      expect(plan).toMatchObject({ changes: [], unmatched: ['oldUid'], matchedByTime: [] });
    });

    it.each([STATUS.booked, STATUS.rescheduled, STATUS.declined])('matches a %s row', (status) => {
      expect(planCalendarSync(sheetWith(rescheduled({ status })), [oldEvent()]).matchedByTime).toEqual(['oldUid']);
    });

    it('returns a Declined row to Booked when the booker accepts the moved event', () => {
      const plan = planCalendarSync(sheetWith(rescheduled({ status: STATUS.declined })), [oldEvent({ response: 'accepted' })]);
      expect(plan.changes).toEqual([{ row: 2, uid: 'newUid', from: 'Declined', to: 'Booked' }]);
    });

    it('ignores the organizer email: a row holding it is never matched', () => {
      const rows = sheetWith(rescheduled({ email: 'organizer@example.com' }));
      const plan = planCalendarSync(rows, [oldEvent({ booker: 'someone@example.com' })]);
      expect(plan).toMatchObject({ changes: [], unmatched: ['oldUid'], matchedByTime: [] });
    });

    it('ignores a decline by a guest the setter added', () => {
      const event = calEvent({ uid: 'oldUid', response: 'accepted', start: START, guests: [{ email: 'closer@example.com', responseStatus: 'declined' }] });
      expect(planCalendarSync(sheetWith(rescheduled()), [event]).changes).toEqual([]);
    });

    it('takes the newest row when several qualify', () => {
      const rows = sheetWith(rescheduled(), rescheduled(), rescheduled({ status: STATUS.cancelled }));
      expect(planCalendarSync(rows, [oldEvent()]).changes).toMatchObject([{ row: 3 }]);
    });

    it('prefers a uid match over a time match', () => {
      const rows = sheetWith(leadRow({ status: STATUS.booked, uid: 'oldUid', email: 'other@example.com' }), rescheduled());
      const plan = planCalendarSync(rows, [oldEvent({ booker: 'other@example.com' })]);
      expect(plan.changes).toMatchObject([{ row: 2, uid: 'oldUid' }]);
      expect(plan.matchedByTime).toEqual([]);
    });

    it('matches the email case-insensitively, ignoring spaces', () => {
      const plan = planCalendarSync(sheetWith(rescheduled({ email: ' Asha@X.com ' })), [oldEvent({ booker: 'ASHA@x.COM' })]);
      expect(plan.changes).toHaveLength(1);
    });
  });
});

describe('syncCalendarEvents', () => {
  beforeEach(() => {
    resetFakes();
    vi.resetModules();
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'lead-writer@proj.iam.gserviceaccount.com');
    vi.stubEnv('GOOGLE_PRIVATE_KEY', privateKey);
    vi.stubEnv('SHEET_ID', SHEET_ID);
    vi.stubEnv('SHEET_TAB', 'Leads');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const load = () => import('../lib/calendar-sync.js');
  const writes = () => fake.sheetCalls.filter((c) => c.method === 'POST');

  it('writes every change in one RAW batchUpdate that touches only Status cells', async () => {
    fake.sheet.push(
      leadRow({ status: STATUS.booked, uid: 'u1', email: 'a@example.com' }),
      leadRow({ status: STATUS.rescheduled, uid: 'u2', email: 'b@example.com' }),
      leadRow({ status: STATUS.booked, uid: 'u3', email: 'c@example.com' }),
    );
    const before = structuredClone(fake.sheet);
    const { syncCalendarEvents } = await load();
    const out = await syncCalendarEvents([
      calEvent({ uid: 'u1', booker: 'a@example.com', response: 'declined' }),
      calEvent({ uid: 'u2', booker: 'b@example.com', response: 'declined' }),
      calEvent({ uid: 'u3', booker: 'c@example.com', response: 'accepted' }),
    ]);
    expect(out.changes).toHaveLength(2);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.body).toEqual({
      valueInputOption: 'RAW',
      data: [
        { range: "'Leads'!E2", values: [['Declined']] },
        { range: "'Leads'!E3", values: [['Declined']] },
      ],
    });
    // Only the Status column of rows 2 and 3 differs.
    const diffs: string[] = [];
    fake.sheet.forEach((row, r) => row.forEach((v, c) => v !== before[r]?.[c] && diffs.push(`${r + 1}:${c}`)));
    expect(diffs).toEqual([`2:${COL['Status']}`, `3:${COL['Status']}`]);
  });

  it('re-running the same events makes zero writes', async () => {
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1' }));
    const { syncCalendarEvents } = await load();
    const events = [calEvent({ uid: 'u1', response: 'declined' })];
    expect((await syncCalendarEvents(events)).changes).toHaveLength(1);
    expect(fake.sheet[1]![COL['Status']!]).toBe('Declined');
    fake.sheetCalls = [];
    expect((await syncCalendarEvents(events)).changes).toEqual([]);
    expect(writes()).toHaveLength(0);
  });

  it('restores Booked on re-accept', async () => {
    fake.sheet.push(leadRow({ status: STATUS.declined, uid: 'u1' }));
    const { syncCalendarEvents } = await load();
    await syncCalendarEvents([calEvent({ uid: 'u1', response: 'accepted' })]);
    expect(fake.sheet[1]![COL['Status']!]).toBe('Booked');
  });

  it('logs the change with identifiers only, and the unmatched uid', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1', email: 'private.person@example.com' }));
    const { syncCalendarEvents } = await load();
    await syncCalendarEvents([calEvent({ uid: 'u1', booker: 'private.person@example.com', response: 'declined' }), calEvent({ uid: 'nope', response: 'declined' })]);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: 'CALENDAR_EVENT_UNMATCHED', uid: 'nope' },
      { event: 'CALENDAR_STATUS_CHANGED', uid: 'u1', from: 'Booked', to: 'Declined' },
    ]);
    expect(lines.join('')).not.toContain('private.person');
    expect(lines.join('')).not.toContain('Test Lead');
  });

  it('refuses to write against a sheet whose header row differs', async () => {
    fake.sheet[0] = [...HEADERS.slice(0, 4), 'Renamed', ...HEADERS.slice(5)];
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1' }));
    const { syncCalendarEvents } = await load();
    await expect(syncCalendarEvents([calEvent({ uid: 'u1', response: 'declined' })])).rejects.toMatchObject({ name: 'SheetLayoutError' });
    expect(writes()).toHaveLength(0);
  });

  it('does not read the sheet when no event is a Cal booking', async () => {
    const { syncCalendarEvents } = await load();
    expect(await syncCalendarEvents([{ iCalUID: 'x@google.com' }])).toEqual({ changes: [] });
    expect(fake.sheetCalls).toHaveLength(0);
  });

  it('propagates a Sheets failure so the caller can retry', async () => {
    fake.failSheets = true;
    const { syncCalendarEvents } = await load();
    await expect(syncCalendarEvents([calEvent({ uid: 'u1', response: 'declined' })])).rejects.toThrow();
  });

  it('reads the configured tab by its quoted A1 reference', async () => {
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1' }));
    const { syncCalendarEvents } = await load();
    await syncCalendarEvents([calEvent({ uid: 'u1', response: 'declined' })]);
    expect(decodeURIComponent(fake.sheetCalls[0]!.url.pathname)).toContain("/values/'Leads'!A:");
  });

  it('logs the time match and the missing booker by uid only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    fake.sheet.push(
      leadRow({ status: STATUS.rescheduled, uid: 'newUid', email: 'asha@x.com', callTime: '2026-11-05 12:00:00' }),
      leadRow({ status: STATUS.booked, uid: 'u2', email: 'someone.else@x.com' }),
    );
    const { syncCalendarEvents } = await load();
    const out = await syncCalendarEvents([
      calEvent({ uid: 'oldUid', booker: 'asha@x.com', response: 'declined', start: '2026-11-05T12:00:00+05:30' }),
      calEvent({ uid: 'u2', booker: 'typo@x.com', response: 'declined' }),
    ]);
    expect(out.changes).toEqual([{ row: 2, uid: 'newUid', from: 'Rescheduled', to: 'Declined' }]);
    expect(fake.sheet[1]![COL['Status']!]).toBe('Declined');
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: 'CALENDAR_EVENT_MATCHED_BY_TIME', uid: 'oldUid' },
      { event: 'CALENDAR_BOOKER_NOT_FOUND', uid: 'u2' },
      { event: 'CALENDAR_STATUS_CHANGED', uid: 'newUid', from: 'Rescheduled', to: 'Declined' },
    ]);
    expect(lines.join('')).not.toContain('@x.com');
  });

  it('logs events without attendees once per sync, with the count and the sharing hint', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1' }));
    const { syncCalendarEvents } = await load();
    await syncCalendarEvents([calEvent({ uid: 'a', noAttendees: true }), calEvent({ uid: 'b', noAttendees: true }), calEvent({ uid: 'u1', response: 'accepted' })]);
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toEqual([
      { event: 'CALENDAR_EVENTS_WITHOUT_ATTENDEES', count: 2, hint: 'share the calendar with the service account with "See all event details"' },
    ]);
  });

  it('does not log the attendees warning when every event has an attendee list', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1' }));
    const { syncCalendarEvents } = await load();
    await syncCalendarEvents([calEvent({ uid: 'u1', response: 'accepted' })]);
    expect(log).not.toHaveBeenCalled();
  });

  describe('listEvents page cap', () => {
    const list = async () => {
      const { listEvents } = await import('../lib/calendar-client.js');
      return listEvents(CALENDAR_ID, {}, new AbortController().signal);
    };

    it('returns every event when the listing fills exactly the page cap', async () => {
      fake.events = Array.from({ length: 20 }, (_, i) => calEvent({ uid: `e${i}` }));
      fake.pageSize = 1;
      expect(await list()).toHaveLength(20);
    });

    it('throws rather than truncating when the listing needs more pages than the cap', async () => {
      fake.events = Array.from({ length: 21 }, (_, i) => calEvent({ uid: `e${i}` }));
      fake.pageSize = 1;
      await expect(list()).rejects.toThrow(/exceeded 20 pages/);
    });
  });
});

describe('team-only columns and trailing columns', () => {
  beforeEach(() => {
    resetFakes();
    vi.resetModules();
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'lead-writer@proj.iam.gserviceaccount.com');
    vi.stubEnv('GOOGLE_PRIVATE_KEY', privateKey);
    vi.stubEnv('SHEET_ID', SHEET_ID);
    vi.stubEnv('SHEET_TAB', 'Leads');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const manual: Record<string, string> = { 'Call Outcome': 'No answer', Qualified: 'Maybe', 'Setter Notes': 'Call back Tue', 'Deal Value (₹)': '120000' };
  const fill = (row: string[]) => {
    for (const [h, v] of Object.entries(manual)) row[COL[h]!] = v;
    return row;
  };

  it('a decline and a re-accept leave filled team cells untouched and write only the Status column', async () => {
    fake.sheet.push(fill(leadRow({ status: STATUS.booked, uid: 'u1', email: 'a@example.com' })), fill(leadRow({ status: STATUS.declined, uid: 'u2', email: 'b@example.com' })));
    const { syncCalendarEvents } = await import('../lib/calendar-sync.js');
    const out = await syncCalendarEvents([
      calEvent({ uid: 'u1', booker: 'a@example.com', response: 'declined' }),
      calEvent({ uid: 'u2', booker: 'b@example.com', response: 'accepted' }),
    ]);
    expect(out.changes).toHaveLength(2);
    for (const r of [1, 2]) for (const [h, v] of Object.entries(manual)) expect(fake.sheet[r]![COL[h]!], `${h} row ${r + 1}`).toBe(v);
    const batch = fake.sheetCalls.find((c) => c.method === 'POST')!.body as { data: { range: string }[] };
    for (const d of batch.data) expect(d.range).toMatch(/^'Leads'!E\d+$/);
  });

  it('a column added to the right of ours is neither read nor touched', async () => {
    fake.sheet[0] = [...HEADERS, 'Follow-up date'];
    fake.sheet.push([...leadRow({ status: STATUS.booked, uid: 'u1' }), '2026-11-20']);
    const { syncCalendarEvents } = await import('../lib/calendar-sync.js');
    const out = await syncCalendarEvents([calEvent({ uid: 'u1', response: 'declined' })]);
    expect(out.changes).toHaveLength(1);
    expect(fake.sheet[1]![HEADERS.length]).toBe('2026-11-20');
    expect(fake.sheet[1]![COL['Status']!]).toBe('Declined');
    expect(decodeURIComponent(fake.sheetCalls[0]!.url.pathname)).toContain('!A:AN');
  });

  it('a middle insert is refused before any write', async () => {
    fake.sheet[0] = [...HEADERS.slice(0, 10), 'Inserted', ...HEADERS.slice(10)];
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1' }));
    const { syncCalendarEvents } = await import('../lib/calendar-sync.js');
    await expect(syncCalendarEvents([calEvent({ uid: 'u1', response: 'declined' })])).rejects.toMatchObject({ name: 'SheetLayoutError' });
    expect(fake.sheetCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
