import { createHmac, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEADERS, toRow, type LeadRow } from '../lib/columns.js';
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
  if (c.method === 'GET' && rest.startsWith('/values/')) return Response.json({ range: rest, majorDimension: 'ROWS', values: trimmed(sheet) });
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
    return Response.json({ updates: { updatedRange: `'${tab.replace(/'/g, "''")}'!A${sheet.length}:V${sheet.length}` } });
  }
  throw new Error(`unexpected request ${c.method} ${rest}`);
}

beforeEach(() => {
  sheet = [[...HEADERS]];
  calls = [];
  sheetsHandler = undefined;
  tab = 'Leads';
  net.fetch = async (input, init) => {
    const url = new URL(String(input));
    const raw = String(init?.body ?? '');
    const call: Call = { method: init?.method ?? 'GET', url, body: raw && raw.startsWith('{') ? JSON.parse(raw) : raw, signal: init?.signal ?? undefined };
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' });
    if (url.hostname !== 'sheets.googleapis.com') throw new Error(`unexpected host ${url.hostname}`);
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
  it('matches by metadata.leadId and fills the four booking cells', async () => {
    sheet.push(leadRow({ 'Lead ID': 'lead-1' }), leadRow({ 'Lead ID': 'lead-2', Email: 'other@example.com' }));
    const h = await loadHandler();
    const out = await post(h, calRequest(event('BOOKING_CREATED', booking({ metadata: { leadId: 'lead-2', videoCallUrl: 'https://meet' } }))));
    expect(out).toMatchObject({ status: 200, body: { ok: true, matchedBy: 'leadId' } });

    expect(sheet).toHaveLength(3);
    expect(sheet[1]![COL['Status']!]).toBe('New');
    const row = sheet[2]!;
    expect(row[COL['Status']!]).toBe('Booked');
    expect(row[COL['Call Time (IST)']!]).toBe('2026-11-02 15:00:00');
    expect(row[COL['Booking Details']!]).toBe('Company: Rao & Co');
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
    expect(decodeURIComponent(calls[0]!.url.pathname)).toContain("/values/'Leads'!A:V");
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
    expect(row[COL['Booking Details']!]).toBe('Company: Rao & Co\nCancellation reason: Clash with board meeting');
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
              company: { label: 'company', value: 'Rao & Co' },
            },
          }),
        ),
      ),
    );
    expect(sheet[1]![COL['Booking Details']!]).toBe(
      ['Location: Cal Video', 'Guests: a@x.co, b@x.co', 'Notes: Hello', 'Reschedule reason: Travelling', 'company: Rao & Co'].join('\n'),
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
    expect(decodeURIComponent(calls[0]!.url.pathname)).toContain("/values/'Rao''s Leads'!A:V");
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
