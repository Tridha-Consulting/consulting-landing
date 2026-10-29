import { generateKeyPairSync } from 'node:crypto';
import { HEADERS, LAST_COLUMN_LETTER, toRow } from '../lib/columns.js';
import type { CalendarEvent } from '../lib/calendar-client.js';

// An in-memory Sheet and Calendar behind a stubbed fetch, so the real JWT and gaxios run and only the
// network is faked. Used with a vi.mock of google-auth-library in each test file (see mockJwt).

export const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export const SHEET_ID = 'sheet-1';
export const CALENDAR_ID = 'calendar-1@example.com';
export const CHANNEL_TOKEN = 'channel-token-test';
export const CRON_SECRET = 'cron-secret-test';
export const PRODUCTION_HOST = 'consulting.example';
export const WATCH_EXPIRATION_MS = Date.UTC(2026, 9, 31, 0, 30, 0);

export const COL = Object.fromEntries(HEADERS.map((h, i) => [h, i])) as Record<string, number>;

export interface Call {
  method: string;
  url: URL;
  body: unknown;
}

// Kept on globalThis: vi.resetModules() re-evaluates this file, and the mocked JWT and the tests must share one state.
interface FakeState {
  sheet: string[][];
  sheetCalls: Call[];
  /** Appends to the Events tab; kept apart from sheetCalls so tests of the Leads tab count only their own requests. */
  eventCalls: Call[];
  /** Rows appended to the Events tab. */
  eventRows: string[][];
  calendarCalls: Call[];
  events: CalendarEvent[];
  pageSize: number;
  failSheets: boolean;
  /** Make appends to the Events tab fail with a 500, leaving the Leads tab working. */
  failEvents: boolean;
  /** Make appends to the Events tab never answer. */
  hangEvents: boolean;
  /** Make appends to the Events tab answer with this HTTP status (e.g. 400 for a missing tab); 0 leaves them working. */
  eventsStatus: number;
  /** OAuth token requests so far: a new JWT client fetches one, a reused client reuses its cached token. */
  tokenCalls: number;
  failList: boolean;
  failWatch: boolean;
}

export const fake: FakeState = (globalThis as { __calendarFake?: FakeState }).__calendarFake ??= {
  sheet: [] as string[][],
  /** Calls to sheets.googleapis.com. */
  sheetCalls: [] as Call[],
  eventCalls: [] as Call[],
  eventRows: [] as string[][],
  /** Calls to the Calendar API. */
  calendarCalls: [] as Call[],
  /** Events the Calendar list call returns, split into pages of `pageSize`. */
  events: [] as CalendarEvent[],
  pageSize: 250,
  /** Set to make a whole API fail with a 500. */
  failSheets: false,
  failEvents: false,
  hangEvents: false,
  eventsStatus: 0,
  tokenCalls: 0,
  failList: false,
  failWatch: false,
};

export function resetFakes(): void {
  fake.sheet = [[...HEADERS]];
  fake.sheetCalls = [];
  fake.eventCalls = [];
  fake.eventRows = [];
  fake.calendarCalls = [];
  fake.events = [];
  fake.pageSize = 250;
  fake.failSheets = false;
  fake.failEvents = false;
  fake.hangEvents = false;
  fake.eventsStatus = 0;
  fake.tokenCalls = 0;
  fake.failList = false;
  fake.failWatch = false;
}

/** The Events tab's name as the code under test resolves it. */
function eventsTabName(): string {
  return process.env.EVENTS_TAB?.trim() || 'Events';
}

/** The tab an append addresses, unquoted; undefined for any other request. */
function appendTab(url: URL): string | undefined {
  const m = /\/values\/(.+)!A1:append$/.exec(decodeURIComponent(url.pathname));
  if (!m) return undefined;
  const tab = m[1]!;
  return tab.startsWith("'") && tab.endsWith("'") ? tab.slice(1, -1).replace(/''/g, "'") : tab;
}

function letterToIndex(letters: string): number {
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

/** Google trims trailing empty cells from each row it returns. */
function trimmed(rows: string[][]): string[][] {
  return rows.map((r) => {
    const out = [...r];
    while (out.length && out.at(-1) === '') out.pop();
    return out;
  });
}

/** An append to the Events tab: stored apart from the Leads sheet. */
function eventsAppend(c: Call): Response {
  if (fake.eventsStatus) return Response.json({ error: { code: fake.eventsStatus, message: "Unable to parse range: 'Events'!A1" } }, { status: fake.eventsStatus });
  if (fake.failEvents || fake.failSheets) return new Response('{"error":{"message":"boom"}}', { status: 500 });
  if (c.url.searchParams.get('valueInputOption') !== 'RAW') throw new Error('events append must be RAW');
  if (c.url.searchParams.get('insertDataOption') !== 'INSERT_ROWS') throw new Error('events append must INSERT_ROWS');
  const { values } = c.body as { values: string[][] };
  fake.eventRows.push(...values);
  return Response.json({ updates: { updatedRows: values.length } });
}

function sheets(c: Call): Response {
  if (fake.failSheets) return new Response('{"error":{"message":"boom"}}', { status: 500 });
  const path = decodeURIComponent(c.url.pathname);
  const prefix = `/v4/spreadsheets/${SHEET_ID}`;
  if (!path.startsWith(prefix)) throw new Error(`unexpected sheets path ${path}`);
  const rest = path.slice(prefix.length);
  if (c.method === 'GET' && rest.startsWith('/values/')) {
    // Like Sheets, return only the columns of the requested range (A:<last>), so a column added to
    // the right of ours is never seen by the code under test.
    const last = /!A:([A-Z]+)$/.exec(rest)?.[1];
    const width = last ? letterToIndex(last) + 1 : Infinity;
    return Response.json({ range: rest, majorDimension: 'ROWS', values: trimmed(fake.sheet.map((r) => r.slice(0, width))) });
  }
  if (c.method === 'POST' && rest === '/values:batchUpdate') {
    const { valueInputOption, data } = c.body as { valueInputOption: string; data: { range: string; values: string[][] }[] };
    if (valueInputOption !== 'RAW') throw new Error(`valueInputOption ${valueInputOption}`);
    for (const { range, values } of data) {
      const m = /^'Leads'!([A-Z]+)(\d+)$/.exec(range);
      if (!m) throw new Error(`unexpected range ${range}`);
      const row = (fake.sheet[Number(m[2]) - 1] ??= []);
      const col = letterToIndex(m[1]!);
      while (row.length <= col) row.push('');
      row[col] = values[0]![0]!;
    }
    return Response.json({ totalUpdatedCells: data.length });
  }
  if (c.method === 'POST' && rest === '/values/Leads!A1:append') {
    const { values } = c.body as { values: string[][] };
    fake.sheet.push(values[0]!);
    return Response.json({ updates: { updatedRange: `'Leads'!A${fake.sheet.length}` } });
  }
  throw new Error(`unexpected sheets request ${c.method} ${rest}`);
}

function calendar(c: Call): Response {
  const path = decodeURIComponent(c.url.pathname);
  const base = `/calendar/v3/calendars/${CALENDAR_ID}/events`;
  if (c.method === 'GET' && path === base) {
    if (fake.failList) return new Response('{"error":{"message":"boom"}}', { status: 500 });
    const start = Number(c.url.searchParams.get('pageToken') ?? 0);
    const end = start + fake.pageSize;
    return Response.json({ items: fake.events.slice(start, end), ...(end < fake.events.length && { nextPageToken: String(end) }) });
  }
  if (c.method === 'POST' && path === `${base}/watch`) {
    if (fake.failWatch) return new Response('{"error":{"message":"boom"}}', { status: 500 });
    return Response.json({ kind: 'api#channel', id: (c.body as { id: string }).id, expiration: String(WATCH_EXPIRATION_MS) });
  }
  throw new Error(`unexpected calendar request ${c.method} ${path}`);
}

/** The fetch the mocked JWT uses. */
export async function fakeFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const raw = String(init?.body ?? '');
  const call: Call = { method: init?.method ?? 'GET', url, body: raw.startsWith('{') ? JSON.parse(raw) : raw };
  if (url.hostname === 'oauth2.googleapis.com') {
    fake.tokenCalls++;
    return Response.json({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' });
  }
  if (url.hostname === 'sheets.googleapis.com') {
    // Routed by tab name, however the request quotes it: the Events tab apart from the Leads tab.
    if (appendTab(url) === eventsTabName()) {
      fake.eventCalls.push(call);
      return fake.hangEvents ? new Promise<Response>(() => {}) : eventsAppend(call);
    }
    fake.sheetCalls.push(call);
    return sheets(call);
  }
  if (url.hostname === 'www.googleapis.com') {
    fake.calendarCalls.push(call);
    return calendar(call);
  }
  throw new Error(`unexpected host ${url.hostname}`);
}

/** Builds the google-auth-library mock: the real JWT with its fetch pointed at fakeFetch. */
export function mockJwt(actual: typeof import('google-auth-library')) {
  class JWT extends actual.JWT {
    constructor(opts: ConstructorParameters<typeof actual.JWT>[0]) {
      super({ ...opts, transporterOptions: { fetchImplementation: (url: unknown, init?: unknown) => fakeFetch(url, init as RequestInit) } } as never);
    }
  }
  return { ...actual, JWT };
}

/** A sheet row for a lead; `uid` fills Booking UID. */
export function leadRow(o: { status: string; uid?: string; email?: string; id?: string; callTime?: string }): string[] {
  const row = toRow({
    fullName: 'Test Lead',
    email: o.email ?? 'booker@example.com',
    phone: '+910000000000',
    leadId: o.id ?? `lead-${o.uid ?? 'x'}`,
    submittedAt: new Date('2026-10-01T00:00:00Z'),
    userAgent: '',
    ip: '',
  });
  row[COL['Status']!] = o.status;
  row[COL['Booking UID']!] = o.uid ?? '';
  row[COL['Call Time (IST)']!] = o.callTime ?? '';
  return row;
}

/** A Cal-created Google event: organizer, the booker and optionally other guests. */
export function calEvent(o: {
  uid: string;
  booker?: string;
  response?: string;
  guests?: { email: string; responseStatus: string }[];
  status?: string;
  /** Event start with an offset, e.g. '2026-11-05T12:00:00+05:30'. */
  start?: string;
  /** Leave out the attendee list, as Google does for a calendar shared at free/busy only. */
  noAttendees?: boolean;
}): CalendarEvent {
  const attendees = [
    { email: 'organizer@example.com', organizer: true, responseStatus: 'accepted' },
    { email: o.booker ?? 'booker@example.com', responseStatus: o.response ?? 'needsAction' },
    ...(o.guests ?? []),
  ];
  return {
    id: `gcal-${o.uid}`,
    iCalUID: `${o.uid}@Cal.com`,
    status: o.status ?? 'confirmed',
    ...(o.start && { start: { dateTime: o.start } }),
    ...(!o.noAttendees && { attendees }),
  };
}

export { LAST_COLUMN_LETTER };
