import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_COLUMN_LETTER, columnIndex, columnLetter } from '../lib/columns.js';
import { createRecentLeads, proposedLeadId, submitterKey } from '../lib/lead-dedupe.js';
import { fixTokenFor } from '../lib/fix-token.js';
import { COL, SHEET_ID, fake, privateKey, resetFakes } from './calendar-fakes.js';
import { makeRequest, readJsonResponse, validBody } from './helpers.js';

// The real handler, sheets sink, lead lookup, JWT and gaxios run; only the network is faked (tests/calendar-fakes.ts),
// so a "row" below is a row of the in-memory Leads tab.
vi.mock('google-auth-library', async () => {
  const actual = await vi.importActual<typeof import('google-auth-library')>('google-auth-library');
  const { mockJwt } = await import('./calendar-fakes.js');
  return mockJwt(actual);
});

// The MX lookup has its own tests (tests/email-domain.test.ts); here the handler is given a verdict.
const mx = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('../lib/email-domain.js', async (importActual) => ({
  ...(await importActual<typeof import('../lib/email-domain.js')>()),
  checkEmailDomain: (email: string) => mx.check(email),
}));

const KEY = '0f8e3d6a-1b2c-4d5e-8f90-a1b2c3d4e5f6';
const OTHER_KEY = '6c5b4a39-2817-4f06-9e1d-c2b3a4958677';
const CRON_SECRET = 'cron-secret-test';

let errors: ReturnType<typeof vi.spyOn>;
let logs: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetFakes();
  vi.resetModules();
  vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'lead-writer@proj.iam.gserviceaccount.com');
  vi.stubEnv('GOOGLE_PRIVATE_KEY', privateKey);
  vi.stubEnv('SHEET_ID', SHEET_ID);
  vi.stubEnv('SHEET_TAB', 'Leads');
  vi.stubEnv('EVENTS_TAB', '');
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
  vi.stubEnv('TURNSTILE_SECRET_KEY', '');
  mx.check.mockReset();
  mx.check.mockResolvedValue('OK');
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const ID_COL = columnLetter(columnIndex('Lead ID'));

type Handlers = Record<string, (r: Request) => Promise<Response>>;

/** api/lead.ts as a fresh serverless instance would load it: its own module state, so its own memory of attempts. */
async function instance(): Promise<(body: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: unknown }>> {
  vi.resetModules();
  const h = (await import('../api/lead.js')) as unknown as Handlers;
  return async (body, headers) => {
    const out = await readJsonResponse(await h.POST!(makeRequest('POST', body, headers)));
    return { status: out.status, body: out.body };
  };
}

/** Data rows of the Leads tab (row 1 is the header). */
const rows = () => fake.sheet.slice(1);
const appends = () => fake.sheetCalls.filter((c) => c.method === 'POST' && /:append$/.test(c.url.pathname));
const leadReads = () => fake.sheetCalls.filter((c) => c.method === 'GET');
const logged = (spy: { mock: { calls: unknown[][] } }, event: string): Record<string, unknown>[] =>
  spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.event === event);

describe('POST /api/lead with a proposed Lead ID', () => {
  it('stores the lead under the id the browser proposed', async () => {
    const post = await instance();
    const out = await post({ ...validBody, leadId: KEY });
    expect(out).toEqual({ status: 200, body: { ok: true, leadId: KEY, emailOk: true } });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]![COL['Lead ID']!]).toBe(KEY);
    expect(fake.eventRows.map((r) => r[1])).toEqual([KEY]);
  });

  it('sequential retry on the same instance: the same answer, one row, no second write or audit row', async () => {
    const post = await instance();
    const first = await post({ ...validBody, leadId: KEY });
    const retry = await post({ ...validBody, leadId: KEY });
    expect(retry).toEqual(first);
    expect(rows()).toHaveLength(1);
    expect(appends()).toHaveLength(1);
    expect(fake.eventRows).toHaveLength(1);
    expect(logged(logs, 'LEAD_WRITTEN')).toHaveLength(1);
    expect(logged(logs, 'LEAD_RETRY_JOINED')).toEqual([{ event: 'LEAD_RETRY_JOINED', leadId: KEY, status: 200 }]);
  });

  it('sequential retry that reaches another instance: answered from the row the Sheet holds, nothing appended', async () => {
    const first = await (await instance())({ ...validBody, leadId: KEY });
    const retry = await (await instance())({ ...validBody, leadId: KEY });
    expect(retry).toEqual(first);
    expect(rows()).toHaveLength(1);
    expect(appends()).toHaveLength(1);
    expect(fake.eventRows).toHaveLength(1);
    expect(logged(logs, 'LEAD_RETRY_REPLAYED')).toEqual([{ event: 'LEAD_RETRY_REPLAYED', leadId: KEY, row: 2 }]);
  });

  it('concurrent retry: arriving while the first request is still writing, it waits and gets the same answer; one row', async () => {
    const post = await instance();
    let release!: () => void;
    fake.appendGate = new Promise<void>((r) => (release = r));
    const first = post({ ...validBody, leadId: KEY });
    await vi.waitFor(() => expect(appends()).toHaveLength(1));
    const retry = post({ ...validBody, leadId: KEY });
    // The retry is held behind the first: it makes no Sheets call of its own while the append is stuck.
    const callsWhileHeld = fake.sheetCalls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.sheetCalls).toHaveLength(callsWhileHeld);
    release();
    const [a, b] = await Promise.all([first, retry]);
    expect(a).toEqual({ status: 200, body: { ok: true, leadId: KEY, emailOk: true } });
    expect(b).toEqual(a);
    expect(rows()).toHaveLength(1);
    expect(appends()).toHaveLength(1);
    expect(fake.eventRows).toHaveLength(1);
  });

  it('a waiting retry gets the first attempt\'s failure, and the next retry writes the lead once', async () => {
    const post = await instance();
    fake.failSheets = true;
    let release!: () => void;
    fake.appendGate = new Promise<void>((r) => (release = r));
    const first = post({ ...validBody, leadId: KEY });
    await vi.waitFor(() => expect(appends()).toHaveLength(1));
    const retry = post({ ...validBody, leadId: KEY });
    release();
    expect(await first).toEqual({ status: 502, body: { ok: false, error: 'write_failed' } });
    expect(await retry).toEqual({ status: 502, body: { ok: false, error: 'write_failed' } });
    fake.failSheets = false;
    fake.appendGate = null;
    expect(await post({ ...validBody, leadId: KEY })).toEqual({ status: 200, body: { ok: true, leadId: KEY, emailOk: true } });
    expect(rows()).toHaveLength(1);
  });

  it('different ids are different submissions: two rows, each under its own id', async () => {
    const post = await instance();
    const a = await post({ ...validBody, leadId: KEY });
    const b = await post({ ...validBody, leadId: OTHER_KEY });
    expect((a.body as { leadId: string }).leadId).toBe(KEY);
    expect((b.body as { leadId: string }).leadId).toBe(OTHER_KEY);
    expect(rows().map((r) => r[COL['Lead ID']!])).toEqual([KEY, OTHER_KEY]);
  });

  it('no id, or one that is not a lowercase UUID v4: a fresh server id every time and no lookup, as before', async () => {
    const post = await instance();
    for (const leadId of [undefined, 'Lead ID', KEY.toUpperCase(), '11111111-1111-1111-8111-111111111111', 42]) {
      const out = await post({ ...validBody, leadId });
      expect(out.status).toBe(200);
      const id = (out.body as { leadId: string }).leadId;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(id).not.toBe(String(leadId).toLowerCase());
    }
    expect(rows()).toHaveLength(5);
    expect(new Set(rows().map((r) => r[COL['Lead ID']!])).size).toBe(5);
    expect(leadReads()).toHaveLength(0);
  });

  it('a retry of a lead whose domain has no mail server gets its fixToken again, from memory or from the Sheet', async () => {
    mx.check.mockResolvedValue('No mail server');
    const expected = { status: 200, body: { ok: true, leadId: KEY, emailOk: false, fixToken: fixTokenFor(KEY) } };
    const post = await instance();
    expect(await post({ ...validBody, leadId: KEY })).toEqual(expected);
    expect(await post({ ...validBody, leadId: KEY })).toEqual(expected);
    expect(await (await instance())({ ...validBody, leadId: KEY })).toEqual(expected);
    expect(rows()).toHaveLength(1);
  });

  it('the email-fix step finds the row by the proposed id; a late retry of the original answers then gets a row of its own', async () => {
    mx.check.mockResolvedValue('No mail server');
    const body = { ...validBody, email: 'asha@nomx.example.com', leadId: KEY };
    const first = await (await instance())(body);
    const { fixToken } = first.body as { fixToken: string };
    mx.check.mockResolvedValue('OK');
    vi.resetModules();
    const fix = (await import('../api/lead-email.js')) as unknown as Handlers;
    const req = new Request('https://consulting.tridha.net/api/lead-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leadId: KEY, email: 'asha@example.org', fixToken }),
    });
    expect((await readJsonResponse(await fix.POST!(req))).body).toEqual({ ok: true, leadId: KEY, emailOk: true });
    expect(rows()[0]![COL['Email']!]).toBe('asha@example.org');
    // A retry of the original submission no longer matches the row's email: it is stored as a lead of its own.
    const late = await (await instance())(body);
    expect((late.body as { leadId: string }).leadId).not.toBe(KEY);
    expect(rows()).toHaveLength(2);
  });

  it('an id already stored for a different email or phone is never answered from: the lead gets an id of its own', async () => {
    await (await instance())({ ...validBody, leadId: KEY });
    for (const other of [{ email: 'someone@example.com' }, { phone: '+447911123456' }]) {
      const out = await (await instance())({ ...validBody, ...other, leadId: KEY });
      expect(out.status).toBe(200);
      expect((out.body as { leadId: string }).leadId).not.toBe(KEY);
      expect(out.body).not.toHaveProperty('fixToken');
    }
    expect(rows()).toHaveLength(3);
    expect(logged(errors, 'LEAD_ID_CONFLICT')).toHaveLength(2);
  });

  it('the same conflict on one instance, decided from memory', async () => {
    const post = await instance();
    let release!: () => void;
    fake.appendGate = new Promise<void>((r) => (release = r));
    const first = post({ ...validBody, leadId: KEY });
    await vi.waitFor(() => expect(appends()).toHaveLength(1));
    const other = post({ ...validBody, email: 'someone@example.com', leadId: KEY });
    await vi.waitFor(() => expect(appends()).toHaveLength(2));
    release();
    const [a, b] = await Promise.all([first, other]);
    expect((a.body as { leadId: string }).leadId).toBe(KEY);
    expect((b.body as { leadId: string }).leadId).not.toBe(KEY);
    expect(rows()).toHaveLength(2);
    expect(logged(errors, 'LEAD_ID_CONFLICT')).toEqual([{ event: 'LEAD_ID_CONFLICT', leadId: KEY }]);
  });

  it('a lookup that fails never costs the lead: it is appended and the failure is logged without personal data', async () => {
    await (await instance())({ ...validBody, leadId: KEY });
    fake.failLeadReads = true;
    const out = await (await instance())({ ...validBody, leadId: KEY });
    expect(out).toEqual({ status: 200, body: { ok: true, leadId: KEY, emailOk: true } });
    // The duplicate this check exists to prevent: the price of never losing a lead when the Sheet cannot be read.
    expect(rows()).toHaveLength(2);
    const [line] = logged(errors, 'LEAD_DEDUPE_CHECK_FAILED');
    expect(line).toMatchObject({ event: 'LEAD_DEDUPE_CHECK_FAILED', leadId: KEY });
    expect(JSON.stringify(line)).not.toContain(validBody.email);
  });

  it('a row sorted away between the two reads is treated as a failed lookup, never answered from another lead', async () => {
    await (await instance())({ ...validBody, leadId: KEY });
    await (await instance())({ ...validBody, email: 'b@example.com', leadId: OTHER_KEY });
    const post = await instance();
    // Swap the two data rows after the Lead ID column was read and before the matched row is.
    const original = fake.sheetCalls.push.bind(fake.sheetCalls);
    fake.sheetCalls.push = (...calls) => {
      if (calls.some((c) => c.method === 'GET' && /!A\d+:/.test(decodeURIComponent(c.url.pathname)))) {
        [fake.sheet[1], fake.sheet[2]] = [fake.sheet[2]!, fake.sheet[1]!];
      }
      return original(...calls);
    };
    const out = await post({ ...validBody, leadId: KEY });
    expect(out.body).toEqual({ ok: true, leadId: KEY, emailOk: true });
    expect(logged(errors, 'LEAD_DEDUPE_CHECK_FAILED')[0]?.error).toMatch(/no longer holds the Lead ID/);
    expect(rows()).toHaveLength(3);
  });

  it('the rate limit still counts every retry', async () => {
    vi.stubEnv('LEAD_RATE_LIMIT', '2');
    const post = await instance();
    const ip = { 'x-forwarded-for': '203.0.113.7' };
    expect((await post({ ...validBody, leadId: KEY }, ip)).status).toBe(200);
    expect((await post({ ...validBody, leadId: KEY }, ip)).status).toBe(200);
    expect((await post({ ...validBody, leadId: KEY }, ip)).status).toBe(429);
    expect(rows()).toHaveLength(1);
  });

  it('Turnstile still checks every retry before the id is looked at', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'ts-secret');
    const post = await instance();
    const siteverify = vi.fn(async (_url: unknown, init: { body: URLSearchParams }) =>
      Response.json({ success: init.body.get('response') === 'good' }),
    );
    vi.stubGlobal('fetch', siteverify);
    expect((await post({ ...validBody, leadId: KEY, turnstileToken: 'good' })).status).toBe(200);
    expect(await post({ ...validBody, leadId: KEY, turnstileToken: 'used' })).toEqual({ status: 400, body: { ok: false, error: 'captcha_failed' } });
    expect(siteverify).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(1);
  });

  it('the lookup reads the Lead ID column, then only the matching row', async () => {
    await (await instance())({ ...validBody, leadId: KEY });
    fake.sheetCalls = [];
    await (await instance())({ ...validBody, leadId: KEY });
    expect(leadReads().map((c) => `${decodeURIComponent(c.url.pathname).split('!')[1]} ${c.url.searchParams.get('majorDimension')}`)).toEqual([
      `${ID_COL}:${ID_COL} COLUMNS`,
      `A2:${LAST_COLUMN_LETTER}2 ROWS`,
    ]);
    expect(fake.sheetCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('lib/lead-dedupe.ts', () => {
  it('accepts only a lowercase UUID v4 as a proposed id', () => {
    expect(proposedLeadId(KEY)).toBe(KEY);
    for (const v of [undefined, null, 42, '', 'Lead ID', KEY.toUpperCase(), `${KEY} `, '11111111-1111-1111-8111-111111111111', 'cal-abc']) {
      expect(proposedLeadId(v), String(v)).toBeUndefined();
    }
  });

  it('names a submitter by email, case folded, and phone', () => {
    expect(submitterKey({ email: ' Asha@Example.com', phone: '+919812345678' })).toBe(submitterKey({ email: 'asha@example.com', phone: '+919812345678' }));
    expect(submitterKey({ email: 'asha@example.com', phone: '+919812345678' })).not.toBe(submitterKey({ email: 'asha@example.com', phone: '+919812345679' }));
  });

  it('keeps a success for the TTL, forgets a failure at once, and caps how many ids it holds', async () => {
    let now = 0;
    const recent = createRecentLeads(1000, 2, () => now);
    const a = recent.claim('a', 'x');
    expect(a.kind).toBe('own');
    if (a.kind === 'own') a.settle({ status: 200, body: { ok: true } });
    const joined = recent.claim('a', 'x');
    expect(joined.kind).toBe('join');
    if (joined.kind === 'join') expect(await joined.reply).toEqual({ status: 200, body: { ok: true } });
    expect(recent.claim('a', 'y').kind).toBe('conflict');
    now = 1001;
    expect(recent.claim('a', 'x').kind).toBe('own');
    const b = recent.claim('b', 'x');
    if (b.kind === 'own') b.settle({ status: 502, body: { ok: false } });
    expect(recent.claim('b', 'x').kind).toBe('own');
    recent.claim('c', 'x');
    expect(recent.size()).toBe(2);
  });
});
