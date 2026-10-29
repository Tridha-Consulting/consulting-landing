import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATUS } from '../lib/columns.js';
import { EVENT_HEADERS, eventRow, type LeadEvent } from '../lib/event-log.js';
import { CALENDAR_ID, SHEET_ID, calEvent, fake, leadRow, privateKey, resetFakes } from './calendar-fakes.js';
import { makeRequest, readJsonResponse, validBody } from './helpers.js';

// The real JWT, gaxios, handlers and sheets sink run; only the network is faked, with the Events tab
// kept apart from the Leads tab (see tests/calendar-fakes.ts).
vi.mock('google-auth-library', async () => {
  const actual = await vi.importActual<typeof import('google-auth-library')>('google-auth-library');
  const { mockJwt } = await import('./calendar-fakes.js');
  return mockJwt(actual);
});

let errors: ReturnType<typeof vi.spyOn>;
let logs: ReturnType<typeof vi.spyOn>;

function stubEnv(eventsTab?: string): void {
  vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'lead-writer@proj.iam.gserviceaccount.com');
  vi.stubEnv('GOOGLE_PRIVATE_KEY', privateKey);
  vi.stubEnv('SHEET_ID', SHEET_ID);
  vi.stubEnv('SHEET_TAB', 'Leads');
  vi.stubEnv('EVENTS_TAB', eventsTab ?? '');
  vi.stubEnv('CALENDAR_ID', CALENDAR_ID);
}

beforeEach(() => {
  resetFakes();
  vi.resetModules();
  stubEnv();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const logged = (spy: { mock: { calls: unknown[][] } }, event: string): Record<string, unknown>[] =>
  spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.event === event);

const NOW = new Date('2026-10-28T18:45:09Z');

describe('event rows', () => {
  it('has the nine Events headers in order', () => {
    expect(EVENT_HEADERS).toEqual(['At (IST)', 'Lead ID', 'Event', 'Status From', 'Status To', 'Call Time (IST)', 'Booking UID', 'Source', 'Detail']);
  });

  it('puts every field under its header, blank when absent, with the time in IST', () => {
    const full: LeadEvent = {
      event: 'Rescheduled', source: 'cal', leadId: 'L1', statusFrom: 'Booked', statusTo: 'Rescheduled',
      callTime: '2026-11-02 15:00:00', bookingUid: 'bk_1', detail: 'x',
    };
    expect(eventRow(full, NOW)).toEqual(['2026-10-29 00:15:09', 'L1', 'Rescheduled', 'Booked', 'Rescheduled', '2026-11-02 15:00:00', 'bk_1', 'cal', 'x']);
    expect(eventRow({ event: 'Lead submitted', source: 'form' }, NOW)).toEqual(['2026-10-29 00:15:09', '', 'Lead submitted', '', '', '', '', 'form', '']);
    expect(eventRow(full, NOW)).toHaveLength(EVENT_HEADERS.length);
  });
});

describe('logEvents', () => {
  it('appends to the Events tab, RAW and INSERT_ROWS, one request for several events', async () => {
    const { logEvents } = await import('../lib/event-log.js');
    await logEvents(
      [
        { event: 'Booked', source: 'cal', leadId: 'L1' },
        { event: 'Cancelled', source: 'cal', leadId: 'L2', detail: '=HYPERLINK("http://x")' },
      ],
      { now: NOW },
    );
    expect(fake.eventCalls).toHaveLength(1);
    expect(fake.sheetCalls).toHaveLength(0);
    const call = fake.eventCalls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url.searchParams.get('valueInputOption')).toBe('RAW');
    expect(call.url.searchParams.get('insertDataOption')).toBe('INSERT_ROWS');
    expect(fake.eventRows).toHaveLength(2);
    expect(fake.eventRows[1]![8]).toBe('=HYPERLINK("http://x")');
    expect(errors).not.toHaveBeenCalled();
  });

  it('writes nothing, and makes no request, for an empty list', async () => {
    const { logEvents } = await import('../lib/event-log.js');
    await logEvents([]);
    expect(fake.eventCalls).toHaveLength(0);
  });

  it('uses EVENTS_TAB when set, with an apostrophe in the name doubled', async () => {
    vi.resetModules();
    stubEnv("Rao's Events");
    const { logEvents } = await import('../lib/event-log.js');
    await logEvents([{ event: 'Booked', source: 'cal' }]);
    expect(fake.sheetCalls).toHaveLength(0);
    expect(fake.eventCalls).toHaveLength(1);
    expect(decodeURIComponent(fake.eventCalls[0]!.url.pathname)).toContain("/values/'Rao''s Events'!A1:append");
    expect(fake.eventRows).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('a failed write resolves, and logs EVENT_LOG_WRITE_FAILED with the event, lead id and error', async () => {
    fake.failEvents = true;
    const { logEvents } = await import('../lib/event-log.js');
    await expect(logEvents([{ event: 'Booked', source: 'cal', leadId: 'L1', detail: 'private detail' }])).resolves.toBeUndefined();
    const lines = logged(errors, 'EVENT_LOG_WRITE_FAILED');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'EVENT_LOG_WRITE_FAILED', eventName: 'Booked', leadId: 'L1' });
    expect(String(lines[0]!.error)).not.toBe('');
    expect(JSON.stringify(lines[0])).not.toContain('private detail');
  });

  it('logs one line per event when a batch fails, and omits a missing lead id', async () => {
    fake.failEvents = true;
    const { logEvents } = await import('../lib/event-log.js');
    await logEvents([{ event: 'A', source: 'cal', leadId: 'L1' }, { event: 'B', source: 'cal' }]);
    const lines = logged(errors, 'EVENT_LOG_WRITE_FAILED');
    expect(lines.map((l) => l.eventName)).toEqual(['A', 'B']);
    expect(lines[1]).not.toHaveProperty('leadId');
  });

  it('a hung write is cut off by the deadline and resolves, logging the failure', async () => {
    fake.hangEvents = true;
    const { logEvents } = await import('../lib/event-log.js');
    const t0 = Date.now();
    await expect(logEvents([{ event: 'Booked', source: 'cal', leadId: 'L1' }], { deadlineMs: 100 })).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(String(logged(errors, 'EVENT_LOG_WRITE_FAILED')[0]!.error)).toMatch(/exceeded 100ms/);
  });

  it('missing Sheet configuration is a logged failure, never a throw', async () => {
    vi.resetModules();
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', '');
    vi.stubEnv('GOOGLE_PRIVATE_KEY', '');
    vi.stubEnv('SHEET_ID', '');
    const { logEvents } = await import('../lib/event-log.js');
    await expect(logEvents([{ event: 'Booked', source: 'cal', leadId: 'L1' }])).resolves.toBeUndefined();
    const [line] = logged(errors, 'EVENT_LOG_WRITE_FAILED');
    expect(String(line!.error)).toContain('SHEET_ID');
  });

  it('loads without any environment, so scripts can read EVENT_HEADERS', async () => {
    vi.resetModules();
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', '');
    vi.stubEnv('GOOGLE_PRIVATE_KEY', '');
    vi.stubEnv('SHEET_ID', '');
    const mod = await import('../lib/event-log.js');
    expect(mod.EVENT_HEADERS).toHaveLength(9);
  });
});

describe('a stuck Events write is capped at 2 seconds', () => {
  // The JWT, gaxios and the handlers are real and the fake network answers at once; only the Events
  // request hangs, and a fake clock stepped by hand decides when its deadline fires.
  const STEP_MS = 50;

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Runs `run` on a fake clock and returns the fake time between the Events write being sent and `run`
   * settling. The clock is stepped, not jumped, because the Events timer only exists once the earlier
   * Sheets work has finished. Infinity when the Events write was never sent or `run` never settled.
   */
  async function timeSpentOnEvents<T>(run: () => Promise<T>): Promise<{ elapsedMs: number; value: Promise<T> }> {
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const value = run().finally(() => {
      settled = true;
    });
    let now = 0;
    let sentAt: number | undefined;
    const realStart = Date.now();
    for (; !settled && (sentAt === undefined ? Date.now() - realStart < 20_000 : now - sentAt < 10_000); now += STEP_MS) {
      await vi.advanceTimersByTimeAsync(STEP_MS);
      // A few real milliseconds so the token signing and the fake network, which are not on the fake clock, make progress.
      await new Promise<void>((resolve) => realSetTimeout(resolve, 3));
      if (sentAt === undefined && fake.eventCalls.length > 0) sentAt = now;
    }
    return { elapsedMs: settled && sentAt !== undefined ? now - sentAt : Infinity, value };
  }

  it('POST /api/lead waits for a hung Events write about 2 s, not the 8 s Sheets default, and the lead is stored', async () => {
    fake.hangEvents = true;
    const { POST } = await import('../api/lead.js');
    const { elapsedMs, value } = await timeSpentOnEvents(async () => readJsonResponse(await POST(makeRequest('POST', validBody))));
    expect(elapsedMs).toBeGreaterThanOrEqual(1900);
    expect(elapsedMs).toBeLessThanOrEqual(2200);
    const out = await value;
    expect(out.status).toBe(200);
    expect(fake.sheet).toHaveLength(2);
    expect(String(logged(errors, 'EVENT_LOG_WRITE_FAILED')[0]!.error)).toMatch(/exceeded 2000ms/);
  });

  it('the calendar sync waits for a hung Events write about 2 s, and the Status change is kept', async () => {
    fake.hangEvents = true;
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1', id: 'lead-1' }));
    const { syncCalendarEvents } = await import('../lib/calendar-sync.js');
    const { elapsedMs, value } = await timeSpentOnEvents(() => syncCalendarEvents([calEvent({ uid: 'u1', response: 'declined' })]));
    expect(elapsedMs).toBeGreaterThanOrEqual(1900);
    expect(elapsedMs).toBeLessThanOrEqual(2200);
    expect((await value).changes).toHaveLength(1);
    expect(fake.sheet[1]![4]).toBe('Declined');
    expect(String(logged(errors, 'EVENT_LOG_WRITE_FAILED')[0]!.error)).toMatch(/exceeded 2000ms/);
  });
});

describe('a failed Events write and the shared Sheets client', () => {
  const event = [{ event: 'Booked', source: 'cal', leadId: 'L1' }] as const;

  it.each([400, 403, 404])('an HTTP %d keeps the client: later writes reuse the cached token', async (status) => {
    fake.eventsStatus = status;
    const { logEvents } = await import('../lib/event-log.js');
    await logEvents(event);
    await logEvents(event);
    await logEvents(event);
    expect(logged(errors, 'EVENT_LOG_WRITE_FAILED')).toHaveLength(3);
    expect(fake.eventCalls).toHaveLength(3);
    expect(fake.tokenCalls).toBe(1);
  });

  it('a missing Events tab (400) does not cost each lead a token fetch', async () => {
    fake.eventsStatus = 400;
    const { POST } = await import('../api/lead.js');
    for (let i = 0; i < 3; i++) expect((await readJsonResponse(await POST(makeRequest('POST', validBody)))).status).toBe(200);
    expect(fake.sheet).toHaveLength(4);
    expect(logged(errors, 'EVENT_LOG_WRITE_FAILED')).toHaveLength(3);
    expect(fake.tokenCalls).toBe(1);
  });

  it('an HTTP 500 still discards the client, so the next call fetches a fresh token', async () => {
    fake.eventsStatus = 500;
    const { logEvents } = await import('../lib/event-log.js');
    await logEvents(event);
    await logEvents(event);
    expect(fake.tokenCalls).toBe(2);
  });

  it('a timeout still discards the client', async () => {
    fake.hangEvents = true;
    const { logEvents } = await import('../lib/event-log.js');
    await logEvents(event, { deadlineMs: 50 });
    await logEvents(event, { deadlineMs: 50 });
    expect(fake.tokenCalls).toBe(2);
  });

  it('a 4xx on a Leads write still discards the client (only the event log opts in)', async () => {
    const { sheetsRequest, withDeadline } = await import('../lib/sheets-client.js');
    const call = () => withDeadline('probe', 1000, (signal) => sheetsRequest({ path: '/values/Nope!A1:append', method: 'POST', data: { values: [] } }, signal));
    await expect(call()).rejects.toThrow();
    await expect(call()).rejects.toThrow();
    expect(fake.tokenCalls).toBe(2);
  });
});

describe('POST /api/lead logs a Lead submitted event', () => {
  async function post(body: unknown) {
    const { POST } = await import('../api/lead.js');
    return readJsonResponse(await POST(makeRequest('POST', body)));
  }

  it('one row: lead id, Status To New, source form, the Channel as Detail', async () => {
    const out = await post({ ...validBody, utmSource: 'google', utmMedium: 'cpc' });
    expect(out.status).toBe(200);
    const { leadId } = out.body as { leadId: string };
    expect(fake.sheet.at(-1)).toHaveLength(40);
    expect(fake.eventRows).toHaveLength(1);
    const [at, id, event, from, to, callTime, uid, source, detail] = fake.eventRows[0]!;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect([id, event, from, to, callTime, uid, source, detail]).toEqual([leadId, 'Lead submitted', '', STATUS.new, '', '', 'form', 'Google Ads']);
  });

  it('the Channel column and the event Detail agree', async () => {
    await post({ ...validBody, twclid: 'T1', utmSource: undefined });
    expect(fake.sheet.at(-1)![32]).toBe('X Ads');
    expect(fake.sheet.at(-1)![33]).toBe('T1');
    expect(fake.eventRows[0]![8]).toBe('X Ads');
  });

  it('a failed log write leaves the response and the stored lead unchanged, and logs the failure', async () => {
    fake.failEvents = true;
    const out = await post(validBody);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, leadId: expect.any(String) });
    expect(fake.sheet).toHaveLength(2);
    expect(fake.eventRows).toHaveLength(0);
    const [line] = logged(errors, 'EVENT_LOG_WRITE_FAILED');
    expect(line).toMatchObject({ eventName: 'Lead submitted', leadId: (out.body as { leadId: string }).leadId });
    expect(logged(logs, 'LEAD_WRITTEN')).toHaveLength(1);
    expect(logged(errors, 'LEAD_WRITE_FAILED')).toHaveLength(0);
  });

  it('no log row when the lead is not stored: write failure, invalid body, honeypot', async () => {
    fake.failSheets = true;
    expect((await post(validBody)).status).toBe(502);
    fake.failSheets = false;
    expect((await post({ ...validBody, email: 'nope' })).status).toBe(400);
    expect((await post({ ...validBody, company_website: 'http://spam' })).status).toBe(200);
    expect(fake.eventCalls).toHaveLength(0);
    expect(fake.eventRows).toHaveLength(0);
  });
});

describe('calendar sync logs declines', () => {
  async function run(events: ReturnType<typeof calEvent>[]) {
    const { syncCalendarEvents } = await import('../lib/calendar-sync.js');
    return syncCalendarEvents(events);
  }

  it('a decline: Declined in Google Calendar, Booked to Declined, uid, call time, lead id', async () => {
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1', id: 'lead-1', callTime: '2026-11-05 12:00:00' }));
    const out = await run([calEvent({ uid: 'u1', response: 'declined' })]);
    expect(out.changes).toHaveLength(1);
    expect(fake.eventRows).toHaveLength(1);
    const [, leadId, event, from, to, callTime, uid, source, detail] = fake.eventRows[0]!;
    expect([leadId, event, from, to, callTime, uid, source, detail]).toEqual(['lead-1', 'Declined in Google Calendar', 'Booked', 'Declined', '2026-11-05 12:00:00', 'u1', 'google-calendar', '']);
  });

  it('a re-accept: Re-accepted in Google Calendar, Declined to Booked', async () => {
    fake.sheet.push(leadRow({ status: STATUS.declined, uid: 'u1', id: 'lead-1' }));
    await run([calEvent({ uid: 'u1', response: 'accepted' })]);
    expect(fake.eventRows).toHaveLength(1);
    expect(fake.eventRows[0]!.slice(2, 5)).toEqual(['Re-accepted in Google Calendar', 'Declined', 'Booked']);
  });

  it('several changes go in one append, one row each', async () => {
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1', id: 'lead-1', email: 'a@example.com' }));
    fake.sheet.push(leadRow({ status: STATUS.rescheduled, uid: 'u2', id: 'lead-2', email: 'b@example.com' }));
    await run([calEvent({ uid: 'u1', booker: 'a@example.com', response: 'declined' }), calEvent({ uid: 'u2', booker: 'b@example.com', response: 'declined' })]);
    expect(fake.eventCalls).toHaveLength(1);
    expect(fake.eventRows.map((r) => [r[1], r[3], r[4]])).toEqual([['lead-1', 'Booked', 'Declined'], ['lead-2', 'Rescheduled', 'Declined']]);
  });

  it('no log row when nothing changed: already Declined, other guest, unmatched event, other status', async () => {
    fake.sheet.push(leadRow({ status: STATUS.declined, uid: 'u1' }));
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u2', email: 'two@example.com' }));
    fake.sheet.push(leadRow({ status: STATUS.cancelled, uid: 'u3', email: 'three@example.com' }));
    await run([
      calEvent({ uid: 'u1', response: 'declined' }),
      calEvent({ uid: 'u2', booker: 'two@example.com', response: 'accepted', guests: [{ email: 'closer@example.com', responseStatus: 'declined' }] }),
      calEvent({ uid: 'unknown', response: 'declined' }),
      calEvent({ uid: 'u3', booker: 'three@example.com', response: 'declined' }),
    ]);
    expect(fake.eventCalls).toHaveLength(0);
    expect(fake.eventRows).toHaveLength(0);
  });

  it('a failed log write leaves the Status change and the result unchanged, and logs the failure', async () => {
    fake.failEvents = true;
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1', id: 'lead-1' }));
    const out = await run([calEvent({ uid: 'u1', response: 'declined' })]);
    expect(out.changes).toEqual([{ row: 2, uid: 'u1', from: 'Booked', to: 'Declined' }]);
    expect(fake.sheet[1]![4]).toBe('Declined');
    expect(fake.eventRows).toHaveLength(0);
    expect(logged(errors, 'EVENT_LOG_WRITE_FAILED')).toMatchObject([{ eventName: 'Declined in Google Calendar', leadId: 'lead-1' }]);
    expect(logged(logs, 'CALENDAR_STATUS_CHANGED')).toHaveLength(1);
  });
});
