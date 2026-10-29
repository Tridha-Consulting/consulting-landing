import { createHmac, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEADERS, LAST_COLUMN_LETTER, MANUAL_HEADERS, columnLetter, toRow, type LeadRow } from '../lib/columns.js';
import { ANSWER_COLUMNS, parseBooking, planBooking, type Booking } from '../lib/cal-booking.js';
import { readJsonResponse } from './helpers.js';

// Real JWT + real gaxios; only the network is stubbed, with an in-memory sheet behind it so a
// replayed webhook is judged against the state the first delivery actually left.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const net = vi.hoisted(() => ({ fetch: (async () => new Response(null, { status: 500 })) as (url: unknown, init?: RequestInit) => Promise<Response> }));

vi.mock('google-auth-library', async () => {
  const actual = await vi.importActual<typeof import('google-auth-library')>('google-auth-library');
  class JWT extends actual.JWT {
    constructor(opts: ConstructorParameters<typeof actual.JWT>[0]) {
      super({ ...opts, transporterOptions: { fetchImplementation: (url: unknown, init?: unknown) => net.fetch(url, init as RequestInit) } } as never);
    }
  }
  return { ...actual, JWT };
});

const SECRET = 'whsec_test';
const SHEET_ID = 'sheet-1';

const COL = Object.fromEntries(HEADERS.map((h, i) => [h, i])) as Record<string, number>;

interface Call {
  method: string;
  url: URL;
  body: unknown;
  signal?: AbortSignal;
}

let sheet: string[][];
let calls: Call[];
/** Appends to the Events tab, kept out of `calls` so the Leads-tab request counts below stay exact. */
let eventCalls: Call[];
let eventRows: string[][];
/** Set to make the Events append answer with this response. */
let eventsHandler: ((c: Call) => Response | Promise<Response>) | undefined;
let tab = 'Leads';
let sheetsHandler: ((c: Call) => Response | Promise<Response>) | undefined;

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

function fakeSheets(c: Call): Response {
  const path = decodeURIComponent(c.url.pathname);
  const prefix = `/v4/spreadsheets/${SHEET_ID}`;
  if (!path.startsWith(prefix)) throw new Error(`unexpected sheets path ${path}`);
  const rest = path.slice(prefix.length);
  if (c.method === 'GET' && rest.startsWith('/values/')) {
    // Like Sheets, return only the columns of the requested range (A:<last>), so a column added to
    // the right of ours is never seen by the code under test.
    const last = /!A:([A-Z]+)$/.exec(rest)?.[1];
    const width = last ? letterToIndex(last) + 1 : Infinity;
    return Response.json({ range: rest, majorDimension: 'ROWS', values: trimmed(sheet.map((r) => r.slice(0, width))) });
  }
  if (c.method === 'POST' && rest === '/values:batchUpdate') {
    const { valueInputOption, data } = c.body as { valueInputOption: string; data: { range: string; values: string[][] }[] };
    expect(valueInputOption).toBe('RAW');
    for (const { range, values } of data) {
      const m = new RegExp(`^'${tab.replace(/'/g, "''")}'!([A-Z]+)(\\d+)$`).exec(range);
      if (!m) throw new Error(`unexpected range ${range}`);
      const row = (sheet[Number(m[2]) - 1] ??= []);
      const col = letterToIndex(m[1]!);
      while (row.length <= col) row.push('');
      row[col] = values[0]![0]!;
    }
    return Response.json({ totalUpdatedCells: data.length });
  }
  if (c.method === 'POST' && rest.endsWith(':append')) {
    expect(c.url.searchParams.get('valueInputOption')).toBe('RAW');
    const { values } = c.body as { values: string[][] };
    sheet.push(values[0]!);
    return Response.json({ updates: { updatedRange: `'${tab.replace(/'/g, "''")}'!A${sheet.length}:${LAST_COLUMN_LETTER}${sheet.length}` } });
  }
  throw new Error(`unexpected request ${c.method} ${rest}`);
}

beforeEach(() => {
  sheet = [[...HEADERS]];
  calls = [];
  eventCalls = [];
  eventRows = [];
  eventsHandler = undefined;
  sheetsHandler = undefined;
  tab = 'Leads';
  net.fetch = async (input, init) => {
    const url = new URL(String(input));
    const raw = String(init?.body ?? '');
    const call: Call = { method: init?.method ?? 'GET', url, body: raw && raw.startsWith('{') ? JSON.parse(raw) : raw, signal: init?.signal ?? undefined };
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' });
    if (url.hostname !== 'sheets.googleapis.com') throw new Error(`unexpected host ${url.hostname}`);
    if (decodeURIComponent(url.pathname).includes("/values/'Events'!A1:append")) {
      eventCalls.push(call);
      if (eventsHandler) return eventsHandler(call);
      eventRows.push(...(call.body as { values: string[][] }).values);
      return Response.json({ updates: { updatedRows: 1 } });
    }
    calls.push(call);
    return sheetsHandler ? sheetsHandler(call) : fakeSheets(call);
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadHandler(env: { secret?: string; sheet?: boolean; tab?: string } = {}) {
  vi.resetModules();
  vi.stubEnv('CAL_WEBHOOK_SECRET', env.secret ?? SECRET);
  const sheetOn = env.sheet !== false;
  vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', sheetOn ? 'lead-writer@proj.iam.gserviceaccount.com' : '');
  vi.stubEnv('GOOGLE_PRIVATE_KEY', sheetOn ? privateKey : '');
  vi.stubEnv('SHEET_ID', sheetOn ? SHEET_ID : '');
  tab = env.tab ?? 'Leads';
  vi.stubEnv('SHEET_TAB', tab);
  return import('../api/cal-webhook.js');
}

function sign(raw: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

function calRequest(body: unknown, headers: Record<string, string> | 'unsigned' = {}, method = 'POST'): Request {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (headers !== 'unsigned') Object.assign(h, { 'x-cal-signature-256': sign(raw) }, headers);
  return new Request('https://consulting.tridha.net/api/cal-webhook', { method, headers: h, body: method === 'GET' ? undefined : raw });
}

function booking(over: Record<string, unknown> = {}) {
  return {
    uid: 'bk_1',
    title: 'Strategy call',
    startTime: '2026-11-02T09:30:00Z',
    endTime: '2026-11-02T10:00:00Z',
    attendees: [{ name: 'Asha Rao', email: 'Asha@Example.com', timeZone: 'Asia/Kolkata' }],
    responses: {
      name: { label: 'Your name', value: 'Asha Rao' },
      email: { label: 'Email address', value: 'asha@example.com' },
      company: { label: 'Company', value: 'Rao & Co' },
    },
    metadata: {},
    ...over,
  };
}

function event(triggerEvent: string, payload: Record<string, unknown>, createdAt: string | null = '2026-10-26T06:00:00.000Z') {
  return { triggerEvent, ...(createdAt !== null && { createdAt }), payload };
}

/** A signed request for an exact body text, so a replay is byte-identical. */
function signedRaw(raw: string): Request {
  return calRequest(raw);
}

function leadRow(over: Partial<Record<string, string>> = {}): string[] {
  const lead: LeadRow = {
    fullName: 'Asha Rao',
    email: 'asha@example.com',
    phone: '+919812345678',
    leadId: 'lead-1',
    submittedAt: new Date('2026-10-25T18:45:09Z'),
    userAgent: 'UA',
    ip: '1.2.3.4',
  };
  const row = toRow(lead);
  for (const [h, v] of Object.entries(over)) row[COL[h]!] = v!;
  return row;
}

async function post(handler: { POST: (r: Request) => Promise<Response> }, req: Request) {
  return readJsonResponse(await handler.POST(req));
}

function logged(spy: { mock: { calls: unknown[][] } }, name: string): string | undefined {
  return spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes(`"event":"${name}"`));
}

describe('signature', () => {
  it('accepts a valid signature', async () => {
    const h = await loadHandler();
    const out = await post(h, calRequest(event('PING', {})));
    expect(out.status).toBe(200);
  });

  it('rejects a tampered body with 401, logs no body, touches no sheet', async () => {
    const h = await loadHandler();
    const raw = JSON.stringify(event('BOOKING_CREATED', booking()));
    const req = new Request('https://x/api/cal-webhook', {
      method: 'POST',
      headers: { 'x-cal-signature-256': sign(raw) },
      body: raw.replace('Asha', 'Evil'),
    });
    const out = await post(h, req);
    expect(out.status).toBe(401);
    const line = logged(console.error as never, 'CAL_WEBHOOK_BAD_SIGNATURE')!;
    expect(line).toBeDefined();
    expect(line).not.toContain('Evil');
    expect(calls).toHaveLength(0);
  });

  it('rejects a signature made with the wrong secret', async () => {
    const h = await loadHandler();
    const raw = JSON.stringify(event('PING', {}));
    const out = await post(h, calRequest(raw, { 'x-cal-signature-256': sign(raw, 'other') }));
    expect(out.status).toBe(401);
  });

  it('rejects a missing header with 401', async () => {
    const h = await loadHandler();
    expect((await post(h, calRequest(event('PING', {}), 'unsigned'))).status).toBe(401);
  });

  it.each(['abcd', 'a'.repeat(65), ''])('rejects a wrong-length header (%#) with 401, no throw', async (sig) => {
    const h = await loadHandler();
    expect((await post(h, calRequest(event('PING', {}), { 'x-cal-signature-256': sig }))).status).toBe(401);
  });

  it('accepts an upper-case hex signature', async () => {
    const h = await loadHandler();
    const raw = JSON.stringify(event('PING', {}));
    expect((await post(h, calRequest(raw, { 'x-cal-signature-256': sign(raw).toUpperCase() }))).status).toBe(200);
  });

  it('500 + CAL_WEBHOOK_MISCONFIGURED when the secret is missing', async () => {
    const h = await loadHandler({ secret: ' ' });
    const out = await post(h, calRequest(event('PING', {})));
    expect(out.status).toBe(500);
    expect(logged(console.error as never, 'CAL_WEBHOOK_MISCONFIGURED')).toContain('CAL_WEBHOOK_SECRET');
  });

  it('413 over 64 KB', async () => {
    const h = await loadHandler();
    const out = await post(h, calRequest('x'.repeat(64 * 1024 + 1)));
    expect(out.status).toBe(413);
  });

  it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])('405 on %s', async (method) => {
    const h = (await loadHandler()) as unknown as Record<string, (r: Request) => Promise<Response>>;
    const res = await h[method]!(calRequest(event('PING', {}), {}, method === 'GET' || method === 'HEAD' ? 'GET' : method));
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });

  it('400 on a signed body that is not JSON', async () => {
    const h = await loadHandler();
    expect((await post(h, calRequest('not json'))).status).toBe(400);
  });
});

describe('ignored triggers', () => {
  it.each(['PING', 'MEETING_ENDED', 'BOOKING_REQUESTED'])('%s -> 200 ignored, no Sheets call, no sheet env needed', async (t) => {
    const h = await loadHandler({ sheet: false });
    const out = await post(h, calRequest(event(t, { anything: true })));
    expect(out).toMatchObject({ status: 200, body: { ok: true, ignored: t } });
    expect(calls).toHaveLength(0);
  });
});

describe('booking created', () => {
  it('matches by metadata.leadId and fills the booking cells', async () => {
    sheet.push(leadRow({ 'Lead ID': 'lead-1' }), leadRow({ 'Lead ID': 'lead-2', Email: 'other@example.com' }));
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-2', videoCallUrl: 'https://meet' } }))));
    expect(out).toMatchObject({ status: 200, body: { ok: true, matchedBy: 'leadId' } });

    expect(sheet).toHaveLength(3);
    expect(sheet[1]![COL['Status']!]).toBe('New');
    const row = sheet[2]!;
    expect(row[COL['Status']!]).toBe('Booked');
    expect(row[COL['Call Time (IST)']!]).toBe('2026-11-02 15:00:00');
    expect(row[COL['Company']!]).toBe('Rao & Co');
    expect(row[COL['Booking Details']!]).toBe('');
    expect(row[COL['Booking UID']!]).toBe('bk_1');
    expect(row[COL['Email']!]).toBe('other@example.com');
    expect(row[COL['Lead ID']!]).toBe('lead-2');

    const synced = JSON.parse(logged(console.log as never, 'CAL_BOOKING_SYNCED')!);
    expect(synced).toMatchObject({ uid: 'bk_1', trigger: 'BOOKING_CREATED', matchedBy: 'leadId', row: 3 });
  });

  it('does one read and one write, with RAW so formulas are never evaluated', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' } }))));
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(calls[0]!.url.searchParams.get('majorDimension')).toBe('ROWS');
    expect(decodeURIComponent(calls[0]!.url.pathname)).toContain(`/values/'Leads'!A:${LAST_COLUMN_LETTER}`);
  });

  it('matches by email, case-insensitive and trimmed, picking the bottom-most of two rows', async () => {
    sheet.push(
      leadRow({ Email: 'ASHA@example.com', 'Lead ID': 'old' }),
      leadRow({ Email: '  asha@EXAMPLE.com ', 'Lead ID': 'new' }),
    );
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CREATED', booking())));
    expect(out.body).toMatchObject({ matchedBy: 'email' });
    expect(sheet[1]![COL['Status']!]).toBe('New');
    expect(sheet[1]![COL['Booking UID']!]).toBe('');
    expect(sheet[2]![COL['Status']!]).toBe('Booked');
    expect(sheet[2]![COL['Booking UID']!]).toBe('bk_1');
  });

  it('falls back to email when the leadId matches no row', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'ghost' } }))));
    expect(out.body).toMatchObject({ matchedBy: 'email' });
    expect(sheet).toHaveLength(2);
  });

  it('appends a new row when nothing matches', async () => {
    sheet.push(leadRow({ Email: 'someone@else.com' }));
    const h = await loadHandler();
    const out = await post(
      h,
      calRequest(event('BOOKING_CREATED', booking({ attendees: [{ name: 'Asha Rao', email: 'Asha@Example.com', phoneNumber: '+911111111111' }] }))),
    );
    expect(out.body).toMatchObject({ ok: true, matchedBy: 'appended' });
    expect(sheet).toHaveLength(3);
    const row = sheet[2]!;
    expect(row).toHaveLength(HEADERS.length);
    expect(row[COL['Submitted At (IST)']!]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(row[COL['Full Name']!]).toBe('Asha Rao');
    expect(row[COL['Email']!]).toBe('Asha@Example.com');
    expect(row[COL['Phone']!]).toBe('+911111111111');
    expect(row[COL['Status']!]).toBe('Booked');
    expect(row[COL['Lead ID']!]).toBe('cal-bk_1');
    expect(row[COL['UTM Source']!]).toBe('');
    expect(row[COL['User Agent']!]).toBe('');
    expect(row[COL['IP']!]).toBe('');
    expect(JSON.parse(logged(console.log as never, 'CAL_BOOKING_SYNCED')!)).toMatchObject({ matchedBy: 'appended', row: 3 });
  });

  it('takes the phone from responses.attendeePhoneNumber before attendee.phoneNumber', async () => {
    const h = await loadHandler();
    await post(
      h,
      calRequest(
        event(
          'BOOKING_CREATED',
          booking({
            attendees: [{ name: 'A', email: 'a@b.co', phoneNumber: '+910000000000' }],
            responses: { attendeePhoneNumber: { label: 'Phone', value: '+919999999999' } },
          }),
        ),
      ),
    );
    expect(sheet[1]![COL['Phone']!]).toBe('+919999999999');
    expect(sheet[1]![COL['Booking Details']!]).toBe('');
  });

  it('a duplicate delivery of an appended booking does not append twice', async () => {
    const h = await loadHandler();
    const req = () => calRequest(event('BOOKING_CREATED', booking()));
    expect((await post(h, req())).body).toMatchObject({ matchedBy: 'appended' });
    const afterFirst = JSON.stringify(sheet);
    expect((await post(h, req())).body).toMatchObject({ matchedBy: 'uid' });
    expect(sheet).toHaveLength(2);
    expect(JSON.stringify(sheet)).toBe(afterFirst);
  });

  it('a duplicate delivery of a matched booking leaves the sheet unchanged', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    const req = () => calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' } })));
    await post(h, req());
    const afterFirst = JSON.stringify(sheet);
    await post(h, req());
    expect(JSON.stringify(sheet)).toBe(afterFirst);
  });
});

describe('booking rescheduled', () => {
  it('matches the old uid via rescheduleUid and updates uid, time and status', async () => {
    sheet.push(leadRow({ Email: 'unrelated@x.co', Status: 'Booked', 'Booking UID': 'bk_old', 'Call Time (IST)': '2026-11-01 10:00:00' }));
    const h = await loadHandler();
    const payload = booking({
      uid: 'bk_new',
      rescheduleUid: 'bk_old',
      startTime: '2026-11-05T04:00:00Z',
      responses: { rescheduleReason: { label: 'Reason for reschedule', value: 'Travelling' } },
    });
    const out = await post(h, calRequest(event('BOOKING_RESCHEDULED', payload)));
    expect(out.body).toMatchObject({ matchedBy: 'uid' });
    const row = sheet[1]!;
    expect(row[COL['Status']!]).toBe('Rescheduled');
    expect(row[COL['Booking UID']!]).toBe('bk_new');
    expect(row[COL['Call Time (IST)']!]).toBe('2026-11-05 09:30:00');
    expect(row[COL['Booking Details']!]).toBe('Reason for reschedule: Travelling');
    // a replay now matches the new uid directly
    expect((await post(h, calRequest(event('BOOKING_RESCHEDULED', payload)))).body).toMatchObject({ matchedBy: 'uid' });
    expect(sheet).toHaveLength(2);
  });
});

describe('booking cancelled', () => {
  it('sets Cancelled, records the reason, keeps the call time', async () => {
    sheet.push(leadRow({ Status: 'Booked', 'Booking UID': 'bk_1', 'Call Time (IST)': '2026-11-02 15:00:00' }));
    const h = await loadHandler();
    const out = await post(
      h,
      calRequest(
        event('BOOKING_CANCELLED', booking({ cancellationReason: 'Clash with board meeting', responses: { company: { label: 'Company', value: 'Rao & Co' } } })),
      ),
    );
    expect(out.body).toMatchObject({ matchedBy: 'uid' });
    const row = sheet[1]!;
    expect(row[COL['Status']!]).toBe('Cancelled');
    expect(row[COL['Call Time (IST)']!]).toBe('2026-11-02 15:00:00');
    expect(row[COL['Company']!]).toBe('Rao & Co');
    expect(row[COL['Booking Details']!]).toBe('Cancellation reason: Clash with board meeting');
    expect(row[COL['Booking UID']!]).toBe('bk_1');
  });

  it('matches by email when the cancel payload has no metadata', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    const p = booking();
    delete (p as Record<string, unknown>).metadata;
    const out = await post(h, calRequest(event('BOOKING_CANCELLED', { ...p, cancellationReason: 'No longer needed' })));
    expect(out.body).toMatchObject({ matchedBy: 'email' });
    expect(sheet[1]![COL['Status']!]).toBe('Cancelled');
    // Field names only: a live cancel's reason never reached Booking Details (2026-10-29), so the log shows where it is.
    const synced = JSON.parse(logged(console.log as never, 'CAL_BOOKING_SYNCED')!);
    expect(synced.payloadKeys).toContain('cancellationReason');
    expect(JSON.stringify(synced)).not.toContain('No longer needed');
  });

  it('ignores a cancellation of a booking the lead has since replaced', async () => {
    sheet.push(leadRow({ Status: 'Booked', 'Booking UID': 'bk_newer' }));
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CANCELLED', booking({ uid: 'bk_stale' }))));
    expect(out.body).toMatchObject({ ok: true, ignored: 'stale_cancellation' });
    expect(sheet[1]![COL['Status']!]).toBe('Booked');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('booking details formatting', () => {
  it('one Label: value line per response; arrays joined, objects reduced to value, empties and identity fields dropped', async () => {
    const h = await loadHandler();
    const payload = booking({
      responses: {
        name: { label: 'Your name', value: 'Asha Rao' },
        email: { label: 'Email', value: 'a@b.co' },
        attendeePhoneNumber: { label: 'Phone', value: '+91' },
        guests: { label: 'Guests', value: [] },
        rescheduleReason: { label: 'Why', value: '' },
        topics: { label: 'Topics', value: ['Pricing', 'Hiring', ''] },
        location: { label: 'Location', value: { value: 'integrations:google:meet', optionValue: '' } },
        notes: { label: 'Anything else?', value: 'Line one\nLine two' },
        seats: { label: 'Seats', value: 3 },
        nolabel: { value: 'kept' },
        broken: null,
      },
    });
    await post(h, calRequest(event('BOOKING_CREATED', payload)));
    expect(sheet[1]![COL['Booking Details']!]).toBe(
      ['Topics: Pricing, Hiring', 'Location: Google Meet', 'Anything else?: Line one Line two', 'Seats: 3', 'nolabel: kept'].join('\n'),
    );
  });

  it('stores formula-looking text verbatim under RAW', async () => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ attendees: [{ name: '=HYPERLINK("http://x")', email: 'e@x.co' }] }))));
    expect(sheet[1]![COL['Full Name']!]).toBe('=HYPERLINK("http://x")');
    const append = calls.find((c) => c.url.pathname.endsWith(':append'))!;
    expect(append.url.searchParams.get('valueInputOption')).toBe('RAW');
  });
});

describe('failures', () => {
  it('Sheets failure -> 502 and CAL_WEBHOOK_WRITE_FAILED carrying the full payload', async () => {
    sheetsHandler = () => Response.json({ error: { message: 'boom' } }, { status: 500 });
    const h = await loadHandler();
    const payload = booking({ uid: 'bk_lost', responses: { company: { label: 'Company', value: 'Rao & Co' } } });
    const out = await post(h, calRequest(event('BOOKING_CREATED', payload)));
    expect(out.status).toBe(502);
    const line = JSON.parse(logged(console.error as never, 'CAL_WEBHOOK_WRITE_FAILED')!);
    expect(line.trigger).toBe('BOOKING_CREATED');
    expect(line.payload).toMatchObject({ uid: 'bk_lost', attendees: [{ email: 'Asha@Example.com' }] });
    expect(JSON.stringify(line)).toContain('Rao & Co');
  });

  it('a failed append is 502 too, never reported as synced', async () => {
    sheetsHandler = (c) => (c.method === 'GET' ? Response.json({ values: [[...HEADERS]] }) : Response.json({}, { status: 403 }));
    const h = await loadHandler();
    expect((await post(h, calRequest(event('BOOKING_CREATED', booking())))).status).toBe(502);
    expect(logged(console.log as never, 'CAL_BOOKING_SYNCED')).toBeUndefined();
  });

  it('missing Sheet env on a booking -> 500 CAL_WEBHOOK_MISCONFIGURED with the payload', async () => {
    const h = await loadHandler({ sheet: false });
    const out = await post(h, calRequest(event('BOOKING_CREATED', booking())));
    expect(out.status).toBe(500);
    const line = logged(console.error as never, 'CAL_WEBHOOK_MISCONFIGURED')!;
    expect(line).toContain('GOOGLE_SERVICE_ACCOUNT_EMAIL');
    expect(line).toContain('bk_1');
  });

  it('a signed booking with no usable uid or attendee -> 400 and logged', async () => {
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CREATED', { startTime: 'x', attendees: [] })));
    expect(out.status).toBe(400);
    expect(logged(console.error as never, 'CAL_WEBHOOK_BAD_PAYLOAD')).toContain('uid');
    expect(calls).toHaveLength(0);
  });
});

describe('header row is never matched or written', () => {
  it.each([
    ['leadId', { metadata: { leadId: 'Lead ID' } }],
    ['uid', { uid: 'Booking UID' }],
    ['email', { attendees: [{ name: 'X', email: 'Email' }] }],
  ])('a booker-controlled %s spelling a header appends instead of touching row 1', async (_n, over) => {
    const h = await loadHandler();
    const headerBefore = [...sheet[0]!];
    const out = await post(h, calRequest(event('BOOKING_CANCELLED', booking(over))));
    expect(out.status).toBe(200);
    expect(sheet[0]).toEqual(headerBefore);
    expect(sheet).toHaveLength(2);
    expect(calls.every((c) => !(c.body as { data?: { range: string }[] })?.data?.some((d) => /!\D+1$/.test(d.range)))).toBe(true);
  });

  it('a header-spelled uid does not match the header even when a real row exists', async () => {
    sheet.push(leadRow({ Email: 'other@x.co' }));
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ uid: 'Booking UID', metadata: { leadId: 'Lead ID' } }))));
    expect(sheet[0]![COL['Booking UID']!]).toBe('Booking UID');
    expect(sheet[0]![COL['Status']!]).toBe('Status');
    expect(sheet).toHaveLength(3);
  });
});

describe('event ordering (Last Event At)', () => {
  const T = (m: number) => `2026-10-26T06:${String(m).padStart(2, '0')}:00.000Z`;
  const last = () => sheet[1]![COL['Last Event At']!];

  it('stores the envelope createdAt as received, on update and on append', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' } }), T(1))));
    expect(last()).toBe(T(1));
    sheet.length = 1;
    await post(h, calRequest(event('BOOKING_CREATED', booking(), T(2))));
    expect(sheet[1]![COL['Last Event At']!]).toBe(T(2));
  });

  it('E17 (documented limitation): a cancel delivered before its own reschedule is ignored, so the row ends Rescheduled', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ uid: 'bk_old' }), T(1))));
    const cancel = await post(h, calRequest(event('BOOKING_CANCELLED', booking({ uid: 'bk_new' }), T(3))));
    const resched = await post(h, calRequest(event('BOOKING_RESCHEDULED', booking({ uid: 'bk_new', rescheduleUid: 'bk_old' }), T(2))));
    expect(cancel.body).toEqual({ ok: true, ignored: 'stale_cancellation' });
    expect(resched.body).toMatchObject({ ok: true, matchedBy: 'uid' });
    expect(sheet[1]![COL['Status']!]).toBe('Rescheduled');
    expect(sheet[1]![COL['Booking UID']!]).toBe('bk_new');
  });

  it('book A, book B, cancel A leaves B live, with or without usable timestamps', async () => {
    for (const stamps of [[T(1), T(2), T(3)], [null, null, null]] as const) {
      sheet = [[...HEADERS], leadRow()];
      const h = await loadHandler();
      const ev = (t: string, uid: string, at: string | null, extra: Record<string, unknown> = {}) =>
        calRequest(event(t, booking({ uid, metadata: { leadId: 'lead-1' }, ...extra }), at));
      await post(h, ev('BOOKING_CREATED', 'bk_A', stamps[0]));
      await post(h, ev('BOOKING_CREATED', 'bk_B', stamps[1], { startTime: '2026-11-09T09:30:00Z' }));
      const out = await post(h, ev('BOOKING_CANCELLED', 'bk_A', stamps[2], { cancellationReason: 'rebooked' }));
      expect(out.body).toEqual({ ok: true, ignored: 'stale_cancellation' });
      expect(sheet[1]![COL['Status']!]).toBe('Booked');
      expect(sheet[1]![COL['Booking UID']!]).toBe('bk_B');
      expect(sheet[1]![COL['Call Time (IST)']!]).toBe('2026-11-09 15:00:00');
      expect(sheet[1]![COL['Booking Details']!]).not.toContain('rebooked');
      const line = JSON.parse(logged(console.log as never, 'CAL_WEBHOOK_STALE')!);
      expect(line).toMatchObject({ uid: 'bk_A', trigger: 'BOOKING_CANCELLED', reason: 'stale_cancellation' });
    }
  });

  it('a cancel applies when the row holds no booking uid yet', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CANCELLED', booking({ uid: 'bk_x' }), T(2))));
    expect(out.body).toMatchObject({ ok: true, matchedBy: 'email' });
    expect(sheet[1]![COL['Status']!]).toBe('Cancelled');
  });

  it('E18a: a replayed CREATED after a RESCHEDULED does not revert the row', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    const created = JSON.stringify(event('BOOKING_CREATED', booking({ uid: 'bk_A' }), T(1)));
    await post(h, signedRaw(created));
    await post(h, calRequest(event('BOOKING_RESCHEDULED', booking({ uid: 'bk_B', rescheduleUid: 'bk_A', startTime: '2026-11-09T09:30:00Z' }), T(2))));
    const replay = await post(h, signedRaw(created));
    expect(replay.body).toEqual({ ok: true, ignored: 'stale_event' });
    expect(sheet[1]![COL['Booking UID']!]).toBe('bk_B');
    expect(sheet[1]![COL['Status']!]).toBe('Rescheduled');
    expect(sheet).toHaveLength(2);
  });

  it('E18b: a replayed RESCHEDULED after the new booking was CANCELLED stays Cancelled', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ uid: 'bk_A' }), T(1))));
    const resched = JSON.stringify(event('BOOKING_RESCHEDULED', booking({ uid: 'bk_B', rescheduleUid: 'bk_A' }), T(2)));
    await post(h, signedRaw(resched));
    await post(h, calRequest(event('BOOKING_CANCELLED', booking({ uid: 'bk_B' }), T(3))));
    await post(h, signedRaw(resched));
    expect(sheet[1]![COL['Status']!]).toBe('Cancelled');
    expect(last()).toBe(T(3));
  });

  it('an event with the same createdAt is applied, so a duplicate delivery is a no-op rewrite', async () => {
    const h = await loadHandler();
    const raw = JSON.stringify(event('BOOKING_CREATED', booking(), T(1)));
    await post(h, signedRaw(raw));
    const before = JSON.stringify(sheet);
    expect((await post(h, signedRaw(raw))).body).toMatchObject({ matchedBy: 'uid' });
    expect(JSON.stringify(sheet)).toBe(before);
  });

  it('logs CAL_WEBHOOK_STALE with uid and trigger for an ignored event', async () => {
    sheet.push(leadRow({ 'Last Event At': T(5), 'Booking UID': 'bk_1' }));
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking(), T(4))));
    const line = JSON.parse(logged(console.log as never, 'CAL_WEBHOOK_STALE')!);
    expect(line).toMatchObject({ uid: 'bk_1', trigger: 'BOOKING_CREATED', reason: 'stale_event' });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it.each([
    ['row has no Last Event At', {}, T(1)],
    ['row value unparseable', { 'Last Event At': 'garbage' }, T(1)],
    ['event has no createdAt', { 'Last Event At': T(9) }, null],
    ['event createdAt unparseable', { 'Last Event At': T(9) }, 'garbage'],
  ])('falls back to current behaviour when %s', async (_n, rowOver, createdAt) => {
    sheet.push(leadRow({ 'Booking UID': 'bk_1', Status: 'Booked', ...rowOver }));
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CREATED', booking(), createdAt)));
    expect(out.body).toMatchObject({ ok: true, matchedBy: 'uid' });
    expect(sheet[1]![COL['Status']!]).toBe('Booked');
  });

  it('without timestamps the stale-cancel guard still applies', async () => {
    sheet.push(leadRow({ Status: 'Booked', 'Booking UID': 'bk_newer' }));
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CANCELLED', booking({ uid: 'bk_stale' }), null)));
    expect(out.body).toEqual({ ok: true, ignored: 'stale_cancellation' });
    expect(sheet[1]![COL['Status']!]).toBe('Booked');
  });

  it('an event without createdAt leaves the stored Last Event At alone', async () => {
    sheet.push(leadRow({ 'Last Event At': T(5), 'Booking UID': 'bk_1' }));
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CANCELLED', booking(), null)));
    expect(sheet[1]![COL['Status']!]).toBe('Cancelled');
    expect(last()).toBe(T(5));
  });
});

describe('rejected signed bodies are logged for recovery', () => {
  it('signed non-JSON -> 400 and BAD_PAYLOAD carries the raw body', async () => {
    const h = await loadHandler();
    const raw = '{"triggerEvent":"BOOKING_CREATED","payload":{"uid":"MARKER_JSON"';
    expect((await post(h, calRequest(raw))).status).toBe(400);
    const line = JSON.parse(logged(console.error as never, 'CAL_WEBHOOK_BAD_PAYLOAD')!);
    expect(line.body).toBe(raw);
  });

  it('signed JSON array -> 400 and logged with the body', async () => {
    const h = await loadHandler();
    expect((await post(h, calRequest('[{"uid":"MARKER_ARR"}]'))).status).toBe(400);
    expect(logged(console.error as never, 'CAL_WEBHOOK_BAD_PAYLOAD')).toContain('MARKER_ARR');
  });

  it('a schema-failing booking logs the payload itself', async () => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', { uid: 'MARKER_SCHEMA', startTime: '2026-11-02T09:30:00Z', attendees: [{ email: '' }] })));
    const line = JSON.parse(logged(console.error as never, 'CAL_WEBHOOK_BAD_PAYLOAD')!);
    expect(line.payload).toMatchObject({ uid: 'MARKER_SCHEMA' });
  });

  it('413 is logged with the byte size and never the body', async () => {
    const h = await loadHandler();
    const body = 'SECRETMARKER' + 'x'.repeat(64 * 1024);
    expect((await post(h, calRequest(body))).status).toBe(413);
    const line = logged(console.error as never, 'CAL_WEBHOOK_TOO_LARGE')!;
    expect(JSON.parse(line).bytes).toBe(Buffer.byteLength(body));
    expect(line).not.toContain('SECRETMARKER');
  });

  it('the 64 KB cap counts bytes, not characters', async () => {
    const h = await loadHandler();
    const body = 'é'.repeat(33_000); // 33,000 characters but 66,000 bytes
    expect(body.length).toBeLessThan(64 * 1024);
    expect((await post(h, calRequest(body))).status).toBe(413);
  });

  it('a body exactly at the cap is read (and then fails the schema, not the size check)', async () => {
    const h = await loadHandler();
    const body = 'x'.repeat(64 * 1024);
    expect((await post(h, calRequest(body))).status).toBe(400);
  });
});

describe('booking details limits and labels', () => {
  it('caps a 52k notes answer under the 50,000 cell limit with a truncation marker', async () => {
    const h = await loadHandler();
    const notes = { label: 'Anything else?', value: 'n'.repeat(52_000) };
    expect((await post(h, calRequest(event('BOOKING_CREATED', booking({ responses: { notes } }))))).status).toBe(200);
    const details = sheet[1]![COL['Booking Details']!]!;
    expect(details.length).toBeLessThanOrEqual(45_000);
    expect(details.endsWith('… (truncated)')).toBe(true);
    expect(details.startsWith('Anything else?: nnn')).toBe(true);
  });

  it('leaves details just under the cap untouched', async () => {
    const h = await loadHandler();
    const value = 'n'.repeat(44_000);
    await post(h, calRequest(event('BOOKING_CREATED', booking({ responses: { x: { label: 'X', value } } }))));
    expect(sheet[1]![COL['Booking Details']!]).toBe(`X: ${value}`);
  });

  it('gives Cal built-in fields readable labels when they arrive with internal ones', async () => {
    const h = await loadHandler();
    await post(
      h,
      calRequest(
        event(
          'BOOKING_CREATED',
          booking({
            responses: {
              location: { label: 'location', value: { value: 'integrations:daily', optionValue: '' } },
              guests: { label: 'additional_guests', value: ['a@x.co', 'b@x.co'] },
              notes: { label: 'notes', value: 'Hello' },
              rescheduleReason: { label: 'rescheduleReason', value: 'Travelling' },
              widget: { label: 'widget', value: 'Rao & Co' },
            },
          }),
        ),
      ),
    );
    expect(sheet[1]![COL['Booking Details']!]).toBe(
      ['Location: Cal Video', 'Guests: a@x.co, b@x.co', 'Notes: Hello', 'Reschedule reason: Travelling', 'widget: Rao & Co'].join('\n'),
    );
  });

  it('keeps an owner-written label for a built-in field', async () => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ responses: { notes: { label: 'Agenda for the call', value: 'Pricing' } } }))));
    expect(sheet[1]![COL['Booking Details']!]).toBe('Agenda for the call: Pricing');
  });

  it.each([
    [{ value: 'integrations:google:meet', optionValue: '' }, 'Location: Google Meet'],
    [{ value: 'integrations:zoom', optionValue: '' }, 'Location: Zoom'],
    ['integrations:daily', 'Location: Cal Video'],
    [{ value: 'inPerson', optionValue: '12 MG Road, Delhi' }, 'Location: 12 MG Road, Delhi'],
    [{ value: 'phone', optionValue: '+919812345678' }, 'Location: +919812345678'],
    [{ value: 'somethingNew', optionValue: '' }, 'Location: somethingNew'],
  ])('flattens location %j', async (value, expected) => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ responses: { location: { label: 'location', value } } }))));
    expect(sheet[1]![COL['Booking Details']!]).toBe(expected);
  });

  it('records the cancellation reason only on a cancel', async () => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ cancellationReason: 'stray' }), '2026-10-26T06:01:00.000Z')));
    expect(sheet[1]![COL['Booking Details']!]).not.toContain('Cancellation reason');
    await post(h, calRequest(event('BOOKING_RESCHEDULED', booking({ cancellationReason: 'stray', rescheduleUid: 'bk_1' }), '2026-10-26T06:02:00.000Z')));
    expect(sheet[1]![COL['Booking Details']!]).not.toContain('Cancellation reason');
  });
});

describe('signature is over the raw bytes', () => {
  it('a pretty-printed body verifies (no re-serialisation before the HMAC)', async () => {
    const h = await loadHandler();
    const raw = JSON.stringify(event('BOOKING_CREATED', booking()), null, 2);
    const out = await post(h, calRequest(raw));
    expect(out.body).toMatchObject({ ok: true, matchedBy: 'appended' });
  });

  it('a signature for the compact form does not verify the pretty form', async () => {
    const h = await loadHandler();
    const obj = event('BOOKING_CREATED', booking());
    const out = await post(h, calRequest(JSON.stringify(obj, null, 2), { 'x-cal-signature-256': sign(JSON.stringify(obj)) }));
    expect(out.status).toBe(401);
  });

  it.each([1, 8, 32, 63])('rejects a %d-character prefix of the right signature', async (n) => {
    const h = await loadHandler();
    const raw = JSON.stringify(event('PING', {}));
    expect((await post(h, calRequest(raw, { 'x-cal-signature-256': sign(raw).slice(0, n) }))).status).toBe(401);
  });

  it('rejects the right signature with extra characters appended', async () => {
    const h = await loadHandler();
    const raw = JSON.stringify(event('PING', {}));
    expect((await post(h, calRequest(raw, { 'x-cal-signature-256': sign(raw) + '0' }))).status).toBe(401);
  });
});

describe('tab names and deadlines', () => {
  it("doubles an apostrophe in the tab name in every range (read, update, append)", async () => {
    const h = await loadHandler({ tab: "Rao's Leads" });
    await post(h, calRequest(event('BOOKING_CREATED', booking(), '2026-10-26T06:01:00.000Z')));
    expect(decodeURIComponent(calls[0]!.url.pathname)).toContain(`/values/'Rao''s Leads'!A:${LAST_COLUMN_LETTER}`);
    expect(decodeURIComponent(calls[1]!.url.pathname)).toContain("/values/'Rao''s Leads'!A1:append");
    sheet.push(leadRow());
    sheet.splice(1, 1);
    await post(h, calRequest(event('BOOKING_CANCELLED', booking(), '2026-10-26T06:02:00.000Z')));
    expect(sheet[1]![COL['Status']!]).toBe('Cancelled');
    const update = calls.at(-1)!.body as { data: { range: string }[] };
    expect(update.data.every((d) => d.range.startsWith("'Rao''s Leads'!"))).toBe(true);
  });

  it('passes the abort signal to every Sheets request and aborts it at the deadline', async () => {
    sheetsHandler = () => new Promise<Response>(() => {});
    await loadHandler();
    const { syncBooking } = await import('../lib/cal-sheet.js');
    const { parseBooking } = await import('../lib/cal-booking.js');
    const parsed = parseBooking(booking());
    if (!parsed.ok) throw new Error('fixture');
    await expect(syncBooking('BOOKING_CREATED', parsed.booking, { deadlineMs: 100 })).rejects.toThrow(/sheets sync exceeded 100ms/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBeDefined();
    expect(calls[0]!.signal!.aborted).toBe(true);
  });

  it('the webhook gives up on a hung Sheet after exactly the 8 second deadline with a 502', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      sheetsHandler = () => new Promise<Response>(() => {});
      const h = await loadHandler();
      let settled: number | undefined;
      const pending = post(h, calRequest(event('BOOKING_CREATED', booking()))).then((r) => (settled = r.status));
      await vi.advanceTimersByTimeAsync(7_999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toBe(502);
      expect(logged(console.error as never, 'CAL_WEBHOOK_WRITE_FAILED')).toContain('exceeded 8000ms');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('timestamps must be strict ISO and not far in the future', () => {
  const T = (m: number) => `2026-10-26T06:${String(m).padStart(2, '0')}:00.000Z`;

  it.each(['follow up 2027', '2099-12-31', '2099-12-31T00:00:00Z', '1', 'tomorrow', '2026-10-26 06:30:00'])(
    'a Last Event At cell of %j is treated as missing, not as a freeze',
    async (cell) => {
      sheet.push(leadRow({ 'Last Event At': cell, 'Booking UID': 'bk_1', Status: 'New' }));
      const h = await loadHandler();
      const out = await post(h, calRequest(event('BOOKING_CREATED', booking(), T(1))));
      expect(out.body).toMatchObject({ ok: true, matchedBy: 'uid' });
      expect(sheet[1]![COL['Status']!]).toBe('Booked');
      expect(sheet[1]![COL['Last Event At']!]).toBe(T(1));
    },
  );

  it('a far-future stored timestamp is reported once in the sync line', async () => {
    sheet.push(leadRow({ 'Last Event At': '2099-12-31T00:00:00Z', 'Booking UID': 'bk_1' }));
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking(), T(1))));
    expect(JSON.parse(logged(console.log as never, 'CAL_BOOKING_SYNCED')!).warn).toBe('row_last_event_in_future');
  });

  it.each(['2099-12-31T00:00:00Z', 'tomorrow', '2026-10-26'])('an envelope createdAt of %j is not stored and does not order', async (createdAt) => {
    sheet.push(leadRow({ 'Last Event At': T(5), 'Booking UID': 'bk_1', Status: 'Booked' }));
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CANCELLED', booking(), createdAt)));
    expect(out.body).toMatchObject({ ok: true, matchedBy: 'uid' });
    expect(sheet[1]![COL['Status']!]).toBe('Cancelled');
    expect(sheet[1]![COL['Last Event At']!]).toBe(T(5));
    if (createdAt.startsWith('2099')) {
      expect(JSON.parse(logged(console.log as never, 'CAL_BOOKING_SYNCED')!).warn).toBe('event_createdAt_in_future');
    }
  });

  it('honours an offset: 11:31+05:30 is 06:01Z, so 06:00Z is older', async () => {
    sheet.push(leadRow({ 'Last Event At': '2026-10-26T11:31:00+05:30', 'Booking UID': 'bk_1', Status: 'Booked' }));
    const h = await loadHandler();
    expect((await post(h, calRequest(event('BOOKING_CANCELLED', booking(), T(0))))).body).toEqual({ ok: true, ignored: 'stale_event' });
    expect(sheet[1]![COL['Status']!]).toBe('Booked');
  });

  it('accepts second-less and millisecond-less ISO forms', async () => {
    sheet.push(leadRow({ 'Last Event At': '2026-10-26T06:05Z', 'Booking UID': 'bk_1', Status: 'Booked' }));
    const h = await loadHandler();
    expect((await post(h, calRequest(event('BOOKING_CANCELLED', booking(), '2026-10-26T06:04:59Z')))).body).toEqual({ ok: true, ignored: 'stale_event' });
  });
});

describe('prototype-named keys, labels and truncation', () => {
  it('constructor / toString / __proto__ response keys and location values are plain text', async () => {
    const h = await loadHandler();
    const responses = JSON.parse(
      '{"constructor":{"label":"constructor","value":"v1"},"toString":{"label":"","value":"v2"},"__proto__":{"label":"__proto__","value":"v3"},"location":{"label":"location","value":"toString"}}',
    );
    expect((await post(h, calRequest(event('BOOKING_CREATED', booking({ responses }))))).status).toBe(200);
    const details = sheet[1]![COL['Booking Details']!]!;
    expect(details).toContain('constructor: v1');
    expect(details).toContain('toString: v2');
    expect(details).toContain('Location: toString');
    expect(details).not.toContain('function');
  });

  it.each(['constructor', '__proto__', 'hasOwnProperty'])('location value %s is returned as text', async (value) => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ responses: { location: { label: 'location', value } } }))));
    expect(sheet[1]![COL['Booking Details']!]).toBe(`Location: ${value}`);
  });

  it('never cuts an emoji in half at the truncation point', async () => {
    const h = await loadHandler();
    // "X: " is 3 characters; the cut falls at index 44,987, so the high surrogate sits at 44,986.
    const value = 'a'.repeat(44_983) + '\u{1F600}' + 'b'.repeat(200);
    await post(h, calRequest(event('BOOKING_CREATED', booking({ responses: { x: { label: 'X', value } } }))));
    const details = sheet[1]![COL['Booking Details']!]!;
    expect(details.endsWith('… (truncated)')).toBe(true);
    expect(details.length).toBeLessThanOrEqual(45_000);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(details)).toBe(false);
  });

  it.each([
    ['notes', 'agenda', 'agenda: Pricing'],
    ['notes', 'Notes for us', 'Notes for us: Pricing'],
    ['location', 'where', 'where: Pricing'],
    ['notes', 'notes', 'Notes: Pricing'],
    ['notes', '', 'Notes: Pricing'],
    ['guests', 'additional_guests', 'Guests: Pricing'],
    ['title', 'what_is_this_meeting_about', 'Meeting title: Pricing'],
    ['title', '', 'Meeting title: Pricing'],
  ])('field %s with label %j renders as %j', async (key, label, expected) => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ responses: { [key]: { label, value: 'Pricing' } } }))));
    expect(sheet[1]![COL['Booking Details']!]).toBe(expected);
  });
});

// One literal table, deliberately not derived from ANSWER_COLUMNS: it pins what the owner types
// into Cal (identifier) against what the setter reads in the sheet (header).
const ANSWER_TABLE: [string, string, unknown, string][] = [
  ['designation', 'Designation', 'Founder', 'Founder'],
  ['company', 'Company', 'Rao & Co', 'Rao & Co'],
  ['website', 'Website', 'https://rao.example', 'https://rao.example'],
  ['revenue', 'Annual Revenue', '₹5 Crores – ₹20 Crores', '₹5 Crores – ₹20 Crores'],
  ['budget', 'Budget (3-6 Months)', '₹5 Lakhs – ₹15 Lakhs', '₹5 Lakhs – ₹15 Lakhs'],
  ['bottleneck', 'Bottleneck', ['Lead generation', 'Sales process'], 'Lead generation, Sales process'],
  ['tech_team', 'Tech Team', 'In-house', 'In-house'],
  ['timeline', 'Timeline', 'Within a month', 'Within a month'],
  ['decision_maker', 'Decision Maker', 'Yes, me', 'Yes, me'],
];
const ANSWER_HEADERS = ANSWER_TABLE.map((r) => r[1]);

function answerResponses(only?: string): Record<string, unknown> {
  return Object.fromEntries(ANSWER_TABLE.filter(([id]) => !only || id === only).map(([id, , value]) => [id, { label: id, value }]));
}

/** Cell references written by the last batchUpdate, without the tab name. */
function writtenRanges(): string[] {
  return (calls.at(-1)!.body as { data: { range: string }[] }).data.map((d) => d.range.replace(/^.*!/, ''));
}

describe('booking answer columns', () => {
  it('maps exactly the nine owner-final identifiers', () => {
    expect([...ANSWER_COLUMNS]).toEqual(ANSWER_TABLE.map(([id, header]) => [id, header]));
  });

  it.each(ANSWER_TABLE)('%s lands in the %s column on update (checkbox arrays joined)', async (id, header, _v, expected) => {
    sheet.push(leadRow());
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' }, responses: answerResponses(id) }))));
    expect(sheet[1]![COL[header]!]).toBe(expected);
    for (const other of ANSWER_HEADERS.filter((x) => x !== header)) expect(sheet[1]![COL[other]!] ?? '').toBe('');
    expect(sheet[1]![COL['Booking Details']!]).toBe('');
  });

  it.each(ANSWER_TABLE)('%s lands in the %s column on append', async (id, header, _v, expected) => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ responses: answerResponses(id) }))));
    expect(sheet).toHaveLength(2);
    expect(sheet[1]![COL[header]!]).toBe(expected);
    for (const other of ANSWER_HEADERS.filter((x) => x !== header)) expect(sheet[1]![COL[other]!]).toBe('');
    expect(sheet[1]![COL['Booking Details']!]).toBe('');
  });

  it('a full set of answers fills all nine columns in one batchUpdate and nothing else', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' }, responses: answerResponses() }))));
    for (const [, header, , expected] of ANSWER_TABLE) expect(sheet[1]![COL[header]!]).toBe(expected);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    const cols = ['Status', 'Call Time (IST)', 'Booking Details', 'Booking UID', 'Last Event At', 'Booked At (IST)', ...ANSWER_HEADERS];
    expect(writtenRanges().sort()).toEqual(cols.map((c) => `${columnLetter(COL[c]!)}2`).sort());
  });

  it('an empty or missing answer on a later event does not blank the stored answer', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    const T = (m: number) => `2026-10-26T06:${String(m).padStart(2, '0')}:00.000Z`;
    await post(h, calRequest(event('BOOKING_CREATED', booking({ uid: 'bk_A', metadata: { leadId: 'lead-1' }, responses: answerResponses() }), T(1))));
    const stored = ANSWER_HEADERS.map((x) => sheet[1]![COL[x]!]);
    expect(stored.every(Boolean)).toBe(true);
    const answerCells = ANSWER_HEADERS.map((x) => `${columnLetter(COL[x]!)}2`);
    const answerWrites = () => writtenRanges().filter((r) => answerCells.includes(r));

    // Reschedule whose responses carry only a reason (no answers at all).
    await post(h, calRequest(event('BOOKING_RESCHEDULED', booking({ uid: 'bk_B', rescheduleUid: 'bk_A', responses: { rescheduleReason: { label: 'Why', value: 'Travelling' } } }), T(2))));
    expect(sheet[1]![COL['Status']!]).toBe('Rescheduled');
    expect(answerWrites()).toEqual([]);
    expect(ANSWER_HEADERS.map((x) => sheet[1]![COL[x]!])).toEqual(stored);

    // Cancel with every answer present but empty.
    const blank = Object.fromEntries(ANSWER_TABLE.map(([id]) => [id, { label: id, value: id === 'bottleneck' ? [] : '' }]));
    await post(h, calRequest(event('BOOKING_CANCELLED', booking({ uid: 'bk_B', responses: blank }), T(3))));
    expect(sheet[1]![COL['Status']!]).toBe('Cancelled');
    expect(answerWrites()).toEqual([]);
    expect(ANSWER_HEADERS.map((x) => sheet[1]![COL[x]!])).toEqual(stored);

    // Cancel with no responses key at all.
    const bare = booking({ uid: 'bk_B' }) as Record<string, unknown>;
    delete bare.responses;
    await post(h, calRequest(event('BOOKING_CANCELLED', bare, T(4))));
    expect(answerWrites()).toEqual([]);
    expect(ANSWER_HEADERS.map((x) => sheet[1]![COL[x]!])).toEqual(stored);
  });

  it('a later non-empty answer replaces the stored one', async () => {
    sheet.push(leadRow({ Company: 'Old Co', 'Booking UID': 'bk_1' }));
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_RESCHEDULED', booking({ uid: 'bk_2', rescheduleUid: 'bk_1', responses: answerResponses('company') }))));
    expect(sheet[1]![COL['Company']!]).toBe('Rao & Co');
  });

  it('caps an oversized answer under the 50,000 cell limit', async () => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ responses: { website: { label: 'Website', value: 'w'.repeat(52_000) } } }))));
    const cell = sheet[1]![COL['Website']!]!;
    expect(cell.length).toBeLessThanOrEqual(45_000);
    expect(cell.endsWith('… (truncated)')).toBe(true);
  });
});

describe('answers without a column', () => {
  it('a mistyped identifier lands in Booking Details and is reported as unmapped; built-ins are not', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    const responses = {
      name: { label: 'Name', value: 'Asha Rao' },
      email: { label: 'Email', value: 'asha@example.com' },
      attendeePhoneNumber: { label: 'Phone', value: '+91' },
      designation: { label: 'Designation', value: 'Founder' },
      desgination: { label: 'Designation', value: 'CEO' },
      tech_tema: { label: 'Tech team', value: ['Yes', 'No'] },
      emptyone: { label: 'Empty', value: '' },
      location: { label: 'location', value: 'integrations:daily' },
      notes: { label: 'notes', value: 'Hi' },
      guests: { label: 'guests', value: ['g@x.co'] },
      additional_guests: { label: 'additional_guests', value: ['h@x.co'] },
      rescheduleReason: { label: 'rescheduleReason', value: 'Busy' },
      title: { label: 'title', value: 'Strategy call' },
      what_is_this_meeting_about: { label: 'what_is_this_meeting_about', value: 'Pricing' },
    };
    await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' }, responses }))));
    const details = sheet[1]![COL['Booking Details']!]!;
    expect(details).toContain('Designation: CEO');
    expect(details).toContain('Tech team: Yes, No');
    expect(sheet[1]![COL['Designation']!]).toBe('Founder');
    expect(details).not.toContain('Founder');
    const synced = JSON.parse(logged(console.log as never, 'CAL_BOOKING_SYNCED')!);
    expect(synced.unmapped).toEqual(['desgination', 'tech_tema']);
  });

  it('an unmapped key is reported on append too', async () => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ responses: { revnue: { label: 'Revenue', value: 'x' } } }))));
    expect(sheet[1]![COL['Booking Details']!]).toBe('Revenue: x');
    expect(JSON.parse(logged(console.log as never, 'CAL_BOOKING_SYNCED')!).unmapped).toEqual(['revnue']);
  });

  it('logs no unmapped field when every answer has a column', async () => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ responses: answerResponses() }))));
    expect(JSON.parse(logged(console.log as never, 'CAL_BOOKING_SYNCED')!)).not.toHaveProperty('unmapped');
  });

  it('prototype-named identifiers are not mapped to a column; they fall through to Booking Details', async () => {
    expect(ANSWER_COLUMNS.get('__proto__')).toBeUndefined();
    expect(ANSWER_COLUMNS.get('constructor')).toBeUndefined();
    expect(ANSWER_COLUMNS.has('toString')).toBe(false);
    const h = await loadHandler();
    const responses = JSON.parse('{"constructor":{"label":"constructor","value":"c1"},"toString":{"label":"toString","value":"t1"}}');
    await post(h, calRequest(event('BOOKING_CREATED', booking({ responses }))));
    const row = sheet[1]!;
    expect(ANSWER_HEADERS.map((x) => row[COL[x]!])).toEqual(ANSWER_HEADERS.map(() => ''));
    expect(row[COL['Booking Details']!]).toBe(['constructor: c1', 'toString: t1'].join(String.fromCharCode(10)));
    expect(JSON.parse(logged(console.log as never, 'CAL_BOOKING_SYNCED')!).unmapped).toEqual(['constructor', 'toString']);
  });

  it('an own "__proto__" response key (zod drops it on the wire, so built by hand here) is not mapped either', () => {
    const responses = JSON.parse('{"__proto__":{"label":"__proto__","value":"p1"},"constructor":{"label":"constructor","value":"c1"}}');
    expect(Object.keys(responses)).toContain('__proto__');
    const b = { uid: 'bk_p', startTime: '2026-11-02T09:30:00Z', attendees: [{ email: 'p@x.co' }], responses } as Booking;
    const plan = planBooking([[...HEADERS]], 'BOOKING_CREATED', b, new Date('2026-10-28T10:00:00Z'));
    expect(plan.action).toBe('append');
    if (plan.action !== 'append') return;
    expect(ANSWER_HEADERS.map((x) => plan.values[COL[x]!])).toEqual(ANSWER_HEADERS.map(() => ''));
    expect(plan.values[COL['Booking Details']!]).toBe(['__proto__: p1', 'constructor: c1'].join(String.fromCharCode(10)));
    expect(plan.unmapped).toEqual(['__proto__', 'constructor']);
  });
});
describe('Booked At (IST)', () => {
  const T = (m: number) => `2026-10-26T06:${String(m).padStart(2, '0')}:00.000Z`;
  const bookedAt = () => sheet[1]![COL['Booked At (IST)']!];
  const bookedAtCell = () => `${columnLetter(COL['Booked At (IST)']!)}2`;

  it('is the envelope createdAt in IST on BOOKING_CREATED, on update and on append', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' } }), T(0))));
    expect(bookedAt()).toBe('2026-10-26 11:30:00');
    sheet.length = 1;
    await post(h, calRequest(event('BOOKING_CREATED', booking(), T(7))));
    expect(bookedAt()).toBe('2026-10-26 11:37:00');
  });

  it('is never overwritten by a reschedule or a cancel', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ uid: 'bk_A', metadata: { leadId: 'lead-1' } }), T(1))));
    const first = bookedAt();
    expect(first).toBe('2026-10-26 11:31:00');
    await post(h, calRequest(event('BOOKING_RESCHEDULED', booking({ uid: 'bk_B', rescheduleUid: 'bk_A' }), T(2))));
    expect(sheet[1]![COL['Status']!]).toBe('Rescheduled');
    expect(bookedAt()).toBe(first);
    expect(writtenRanges()).not.toContain(bookedAtCell());
    await post(h, calRequest(event('BOOKING_CANCELLED', booking({ uid: 'bk_B' }), T(3))));
    expect(sheet[1]![COL['Status']!]).toBe('Cancelled');
    expect(bookedAt()).toBe(first);
    expect(writtenRanges()).not.toContain(bookedAtCell());
  });

  it.each(['BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'])('is left blank when a %s appends a new row', async (trigger) => {
    const h = await loadHandler();
    await post(h, calRequest(event(trigger, booking({ rescheduleUid: 'nope' }), T(1))));
    expect(sheet).toHaveLength(2);
    expect(bookedAt()).toBe('');
  });

  it('a stale CREATED writes nothing, Booked At included', async () => {
    sheet.push(leadRow({ 'Last Event At': T(5), 'Booking UID': 'bk_1', 'Booked At (IST)': 'earlier' }));
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CREATED', booking(), T(4))));
    expect(out.body).toEqual({ ok: true, ignored: 'stale_event' });
    expect(bookedAt()).toBe('earlier');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('a CREATED replay with no createdAt leaves a filled Booked At alone (first booking time never moves)', async () => {
    sheet.push(leadRow({ 'Booking UID': 'bk_1', 'Booked At (IST)': '2026-10-20 10:00:00', Status: 'Booked' }));
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CREATED', booking(), null)));
    expect(out.body).toMatchObject({ ok: true, matchedBy: 'uid' });
    expect(writtenRanges()).not.toContain(bookedAtCell());
    expect(bookedAt()).toBe('2026-10-20 10:00:00');
  });

  it('a re-book after a cancel keeps the original first-booked time', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ uid: 'bk_A', metadata: { leadId: 'lead-1' } }), T(1))));
    await post(h, calRequest(event('BOOKING_CANCELLED', booking({ uid: 'bk_A' }), T(2))));
    await post(h, calRequest(event('BOOKING_CREATED', booking({ uid: 'bk_B', metadata: { leadId: 'lead-1' } }), T(3))));
    expect(sheet[1]![COL['Booking UID']!]).toBe('bk_B');
    expect(bookedAt()).toBe('2026-10-26 11:31:00');
  });

  it('a CREATED on a row whose Booked At is empty or blank writes it', async () => {
    for (const existing of ['', '  ']) {
      sheet = [[...HEADERS], leadRow({ 'Booked At (IST)': existing })];
      const h = await loadHandler();
      await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' } }), T(1))));
      expect(writtenRanges()).toContain(bookedAtCell());
      expect(bookedAt()).toBe('2026-10-26 11:31:00');
    }
  });
  describe('falls back to the server clock when the envelope time is unusable', () => {
    const now = new Date('2026-10-28T10:00:00Z');
    const parsed = () => {
      const p = parseBooking(booking({ metadata: { leadId: 'lead-1' } }));
      if (!p.ok) throw new Error('fixture');
      return p.booking;
    };

    it.each([undefined, 'garbage', '2026-10-26', '2099-12-31T00:00:00Z'])('createdAt %j, on update', (createdAt) => {
      const plan = planBooking([[...HEADERS], leadRow()], 'BOOKING_CREATED', parsed(), now, createdAt);
      expect(plan.action).toBe('update');
      if (plan.action === 'update') expect(plan.cells.bookedAt).toBe('2026-10-28 15:30:00');
    });

    it.each([undefined, 'garbage'])('createdAt %j, on append', (createdAt) => {
      const plan = planBooking([[...HEADERS]], 'BOOKING_CREATED', parsed(), now, createdAt);
      expect(plan.action).toBe('append');
      if (plan.action === 'append') expect(plan.values[COL['Booked At (IST)']!]).toBe('2026-10-28 15:30:00');
    });

    it('is empty for a reschedule or a cancel even with a usable envelope time', () => {
      for (const trigger of ['BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'] as const) {
        const plan = planBooking([[...HEADERS], leadRow()], trigger, parsed(), now, T(1));
        expect(plan.action).toBe('update');
        if (plan.action === 'update') expect(plan.cells.bookedAt).toBe('');
      }
    });
  });
});

describe('hyphenated identifiers (Cal may turn _ into -)', () => {
  const hyphenated = (id: string) => id.replaceAll('_', '-');

  it.each(ANSWER_TABLE)('%s spelled with hyphens lands in the %s column on update and append', async (id, header, value, expected) => {
    const responses = { [hyphenated(id)]: { label: id, value } };
    sheet.push(leadRow());
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' }, responses }))));
    expect(sheet[1]![COL[header]!]).toBe(expected);
    expect(sheet[1]![COL['Booking Details']!]).toBe('');
    expect(JSON.parse(logged(console.log as never, 'CAL_BOOKING_SYNCED')!)).not.toHaveProperty('unmapped');
    sheet.length = 1;
    await post(h, calRequest(event('BOOKING_CREATED', booking({ uid: 'bk_2', responses }))));
    expect(sheet[1]![COL[header]!]).toBe(expected);
    expect(sheet[1]![COL['Booking Details']!]).toBe('');
  });

  it('the underscore spelling wins when both carry a value', async () => {
    const h = await loadHandler();
    const responses = { 'tech-team': { label: 'x', value: 'hyphen' }, tech_team: { label: 'y', value: 'underscore' } };
    await post(h, calRequest(event('BOOKING_CREATED', booking({ responses }))));
    expect(sheet[1]![COL['Tech Team']!]).toBe('underscore');
    expect(sheet[1]![COL['Booking Details']!]).toBe('');
  });

  it('the hyphen spelling is used when the underscore one is empty', async () => {
    const h = await loadHandler();
    const responses = { 'decision-maker': { label: 'x', value: 'No' }, decision_maker: { label: 'y', value: '' } };
    await post(h, calRequest(event('BOOKING_CREATED', booking({ responses }))));
    expect(sheet[1]![COL['Decision Maker']!]).toBe('No');
  });

  it('a hyphenated typo is still reported as unmapped and kept in Booking Details', async () => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ responses: { 'tech-tema': { label: 'Tech', value: 'Yes' } } }))));
    expect(sheet[1]![COL['Booking Details']!]).toBe('Tech: Yes');
    expect(JSON.parse(logged(console.log as never, 'CAL_BOOKING_SYNCED')!).unmapped).toEqual(['tech-tema']);
  });
});

describe('header guard', () => {
  const OLD_HEADERS = [
    'Submitted At (IST)', 'Full Name', 'Email', 'Phone', 'Status', 'UTM Source', 'UTM Medium', 'UTM Campaign', 'UTM Content',
    'UTM Term', 'fbclid', 'gclid', 'li_fat_id', 'Referrer', 'Landing URL', 'User Agent', 'IP', 'Lead ID', 'Call Time (IST)',
    'Booking Details', 'Booking UID', 'Last Event At',
  ];

  async function expectRefused(initial: string[][], opts: { trigger?: string } = {}) {
    sheet = initial;
    const h = await loadHandler();
    const trigger = opts.trigger ?? 'BOOKING_CREATED';
    const out = await post(h, calRequest(event(trigger, booking({ uid: 'bk_guard', metadata: { leadId: 'lead-1' }, responses: answerResponses() }))));
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ ok: false, error: 'server_misconfigured' });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(logged(console.log as never, 'CAL_BOOKING_SYNCED')).toBeUndefined();
    expect(logged(console.error as never, 'CAL_WEBHOOK_WRITE_FAILED')).toBeUndefined();
    const line = JSON.parse(logged(console.error as never, 'CAL_WEBHOOK_MISCONFIGURED')!);
    expect(line.error).toMatch(/^sheet layout mismatch/);
    expect(line.trigger).toBe(trigger);
    expect(line.payload).toMatchObject({ uid: 'bk_guard' });
    return line.error as string;
  }

  it.each(['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'])('the old 22-column header: no write, 500, payload logged (%s)', async (trigger) => {
    const error = await expectRefused([OLD_HEADERS, leadRow()], { trigger });
    expect(error).toContain('column F (position 6): expected "Call Time (IST)", found "UTM Source"');
    expect(sheet[1]).toEqual(leadRow());
  });

  it('an empty sheet: no write, 500, payload logged', async () => {
    const error = await expectRefused([]);
    expect(error).toContain('no header row');
    expect(sheet).toEqual([]);
  });

  it('a header with one renamed column: no write, 500, names the column', async () => {
    const renamed = [...HEADERS];
    renamed[COL['Company']!] = 'Compnay';
    const error = await expectRefused([renamed, leadRow()]);
    expect(error).toContain('column I (position 9): expected "Company", found (other text, 7 characters)');
  });

  it('a header row cut short (trailing columns missing) is refused', async () => {
    const error = await expectRefused([HEADERS.slice(0, 31), leadRow()]);
    expect(error).toContain('column AF (position 32): expected "Last Event At", found (empty)');
  });

  it('a tab whose first row is a lead, not a header: refused, and the error never quotes row data', async () => {
    const error = await expectRefused([leadRow()]);
    for (const secret of ['Asha Rao', 'asha@example.com', '+919812345678', 'lead-1', 'UA']) expect(error).not.toContain(secret);
    expect(error).toContain('(other text,');
  });

  it('the correct header, even with stray spaces in its cells, proceeds normally', async () => {
    sheet = [HEADERS.map((x) => ` ${x} `), leadRow()];
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' }, responses: answerResponses('company') }))));
    expect(out).toMatchObject({ status: 200, body: { ok: true, matchedBy: 'leadId' } });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(sheet[1]![COL['Company']!]).toBe('Rao & Co');
  });
});

describe('event log', () => {
  const lines = (name: string) => (console.error as never as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).filter((s) => s.includes(`"event":"${name}"`));

  it('a created booking logs Booked: from-status the lead row held, to Booked, call time, uid, source cal', async () => {
    sheet.push(leadRow({ 'Lead ID': 'lead-1' }));
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' } }))));
    expect(eventCalls).toHaveLength(1);
    expect(eventRows).toHaveLength(1);
    const [at, leadId, ev, from, to, callTime, uid, source, detail] = eventRows[0]!;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect([leadId, ev, from, to, callTime, uid, source, detail]).toEqual(['lead-1', 'Booked', 'New', 'Booked', '2026-11-02 15:00:00', 'bk_1', 'cal', '']);
    expect((eventCalls[0]!.body as { values: string[][] }).values).toHaveLength(1);
    expect(eventCalls[0]!.url.searchParams.get('valueInputOption')).toBe('RAW');
    expect(eventCalls[0]!.url.searchParams.get('insertDataOption')).toBe('INSERT_ROWS');
  });

  it('a reschedule logs Rescheduled from Booked, with the new call time and uid', async () => {
    sheet.push(leadRow({ 'Lead ID': 'lead-1', Status: 'Booked', 'Booking UID': 'bk_A', 'Call Time (IST)': '2026-11-02 15:00:00' }));
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_RESCHEDULED', booking({ uid: 'bk_B', rescheduleUid: 'bk_A', startTime: '2026-11-09T09:30:00Z' }))));
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]!.slice(1, 8)).toEqual(['lead-1', 'Rescheduled', 'Booked', 'Rescheduled', '2026-11-09 15:00:00', 'bk_B', 'cal']);
  });

  it('a cancel logs Cancelled from the prior status', async () => {
    sheet.push(leadRow({ 'Lead ID': 'lead-1', Status: 'Rescheduled', 'Booking UID': 'bk_1' }));
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CANCELLED', booking({ cancellationReason: 'Clash' }))));
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]!.slice(1, 8)).toEqual(['lead-1', 'Cancelled', 'Rescheduled', 'Cancelled', '2026-11-02 15:00:00', 'bk_1', 'cal']);
    expect(eventRows[0]![8]).toBe('');
  });

  it('a booking with no lead row appends one and logs it with the generated lead id and no prior status', async () => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking())));
    expect(sheet).toHaveLength(2);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]!.slice(1, 8)).toEqual(['cal-bk_1', 'Booked', '', 'Booked', '2026-11-02 15:00:00', 'bk_1', 'cal']);
  });

  it('the log is written after the sheet, as a separate request, to the Events tab', async () => {
    sheet.push(leadRow());
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking())));
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(decodeURIComponent(eventCalls[0]!.url.pathname)).toContain("/values/'Events'!A1:append");
  });

  it('stale events and ignored triggers log nothing', async () => {
    sheet.push(leadRow({ Status: 'Booked', 'Booking UID': 'bk_newer', 'Last Event At': '2026-10-26T06:00:00.000Z' }));
    const h = await loadHandler();
    const staleCancel = await post(h, calRequest(event('BOOKING_CANCELLED', booking({ uid: 'bk_stale' }))));
    expect(staleCancel.body).toMatchObject({ ignored: 'stale_cancellation' });
    const staleEvent = await post(h, calRequest(event('BOOKING_CREATED', booking({ uid: 'bk_newer' }), '2026-10-25T06:00:00.000Z')));
    expect(staleEvent.body).toMatchObject({ ignored: 'stale_event' });
    expect((await post(h, calRequest(event('PING', {})))).status).toBe(200);
    expect(eventCalls).toHaveLength(0);
    expect(eventRows).toHaveLength(0);
  });

  it('a duplicate delivery of the same event logs once', async () => {
    sheet.push(leadRow({ 'Lead ID': 'lead-1' }));
    const h = await loadHandler();
    const raw = JSON.stringify(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' } })));
    await post(h, signedRaw(raw));
    await post(h, signedRaw(raw));
    expect(eventRows).toHaveLength(1);
  });

  it('a duplicate delivery of an appended booking logs once', async () => {
    const h = await loadHandler();
    const raw = JSON.stringify(event('BOOKING_CREATED', booking()));
    await post(h, signedRaw(raw));
    await post(h, signedRaw(raw));
    expect(sheet).toHaveLength(2);
    expect(eventRows).toHaveLength(1);
  });

  it('rejected, unsigned and refused requests log nothing', async () => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking()), 'unsigned'));
    await post(h, calRequest(event('BOOKING_CREATED', { uid: 'x' })));
    sheet = [['Wrong header']];
    await post(h, calRequest(event('BOOKING_CREATED', booking())));
    expect(eventCalls).toHaveLength(0);
  });

  it('a failed log write leaves the webhook at 200, the sheet updated, and logs EVENT_LOG_WRITE_FAILED', async () => {
    sheet.push(leadRow({ 'Lead ID': 'lead-1' }));
    eventsHandler = () => Response.json({ error: { message: 'boom' } }, { status: 500 });
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' } }))));
    expect(out).toMatchObject({ status: 200, body: { ok: true, matchedBy: 'leadId' } });
    expect(sheet[1]![COL['Status']!]).toBe('Booked');
    expect(eventRows).toHaveLength(0);
    expect(logged(console.log as never, 'CAL_BOOKING_SYNCED')).toBeDefined();
    expect(logged(console.error as never, 'CAL_WEBHOOK_WRITE_FAILED')).toBeUndefined();
    const failed = lines('EVENT_LOG_WRITE_FAILED');
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0]!)).toMatchObject({ eventName: 'Booked', leadId: 'lead-1' });
  });

  it('a hung log write cannot change the response either, and holds it back by at most 2 s', async () => {
    sheet.push(leadRow({ 'Lead ID': 'lead-1' }));
    eventsHandler = () => new Promise<Response>(() => {});
    const h = await loadHandler();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const pending = post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' } })))).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(2100);
      expect(settled, 'the webhook was still waiting on the Events write after 2.1 s').toBe(true);
      const out = await pending;
      expect(out).toMatchObject({ status: 200, body: { ok: true } });
    } finally {
      vi.useRealTimers();
    }
    expect(sheet[1]![COL['Status']!]).toBe('Booked');
    expect(JSON.parse(lines('EVENT_LOG_WRITE_FAILED')[0]!).error).toMatch(/exceeded 2000ms/);
  });

  it('a failed main write is still a 502 and logs no event', async () => {
    sheet.push(leadRow());
    sheetsHandler = () => Response.json({ error: { message: 'boom' } }, { status: 500 });
    const h = await loadHandler();
    expect((await post(h, calRequest(event('BOOKING_CREATED', booking())))).status).toBe(502);
    expect(eventCalls).toHaveLength(0);
  });
});

describe('team-only columns are never written by the webhook', () => {
  const manualCells: Record<string, string> = { 'Call Outcome': 'Spoke, send deck', Qualified: 'Yes', 'Setter Notes': 'CEO, wants a pilot', 'Deal Value (₹)': '450000' };
  const manualIndexes = MANUAL_HEADERS.map((h) => COL[h]!);

  it.each(['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'])('%s leaves filled team cells exactly as they were, and addresses none of them', async (trigger) => {
    sheet.push(leadRow({ 'Lead ID': 'lead-1', Status: 'Booked', 'Booking UID': 'bk_1', ...manualCells }));
    const h = await loadHandler();
    const out = await post(h, calRequest(event(trigger, booking({ metadata: { leadId: 'lead-1' }, responses: { company: { value: 'Rao & Co' }, designation: { value: 'CEO' } } }))));
    expect(out.status).toBe(200);
    for (const header of MANUAL_HEADERS) expect(sheet[1]![COL[header]!], header).toBe(manualCells[header]);
    const batch = calls.find((c) => c.url.pathname.endsWith(':batchUpdate'))!.body as { data: { range: string }[] };
    const written = batch.data.map((d) => letterToIndex(/!([A-Z]+)\d+$/.exec(d.range)![1]!));
    expect(written.length).toBeGreaterThan(0);
    for (const i of written) expect(manualIndexes, `column ${columnLetter(i)}`).not.toContain(i);
  });

  it('a booking that creates a row writes them blank', async () => {
    const h = await loadHandler();
    await post(h, calRequest(event('BOOKING_CREATED', booking())));
    for (const header of MANUAL_HEADERS) expect(sheet[1]![COL[header]!], header).toBe('');
    expect(sheet[1]).toHaveLength(HEADERS.length);
  });

  it('a column added to the right of ours is neither read nor written', async () => {
    sheet = [[...HEADERS, 'Follow-up date'], [...leadRow({ 'Lead ID': 'lead-1' }), '2026-11-20']];
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-1' } }))));
    expect(out).toMatchObject({ status: 200, body: { ok: true, matchedBy: 'leadId' } });
    expect(sheet[1]![HEADERS.length]).toBe('2026-11-20');
    expect(sheet[1]![COL['Status']!]).toBe('Booked');
    expect(decodeURIComponent(calls[0]!.url.pathname)).toContain(`!A:${LAST_COLUMN_LETTER}`);
    expect(LAST_COLUMN_LETTER).toBe('AN');
  });
});
