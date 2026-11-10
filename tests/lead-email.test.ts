import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MANUAL_HEADERS } from '../lib/columns.js';
import { fixTokenFor } from '../lib/fix-token.js';
import { COL, SHEET_ID, fake, leadRow, privateKey, resetFakes } from './calendar-fakes.js';
import { readJsonResponse } from './helpers.js';

// The real JWT, gaxios, handler and Sheets code run; only the network is faked (tests/calendar-fakes.ts).
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

const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
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
  mx.check.mockReset();
  mx.check.mockResolvedValue('OK');
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const handlers = async () => (await import('../api/lead-email.js')) as unknown as Record<string, (r: Request) => Promise<Response>>;

function request(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
  return new Request('https://consulting.tridha.net/api/lead-email', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
}

/**
 * An object body gets the valid fixToken for its leadId unless it names a `fixToken` key itself
 * (`fixToken: undefined` sends none), so each test states only what it is about.
 */
async function call(method: string, body?: unknown, headers?: Record<string, string>) {
  if (typeof body === 'object' && body !== null && !('fixToken' in body) && typeof (body as { leadId?: unknown }).leadId === 'string') {
    body = { ...body, fixToken: fixTokenFor((body as { leadId: string }).leadId) };
  }
  return readJsonResponse(await (await handlers())[method]!(request(method, body, headers)));
}

/** A row whose domain had no mail server when it was written. */
function badRow(over: { id?: string; email?: string } = {}): string[] {
  const row = leadRow({ status: 'New', id: over.id ?? LEAD_ID, email: over.email ?? 'asha@gmial.co' });
  row[COL['Email Check']!] = 'No mail server';
  return row;
}

const logged = (spy: { mock: { calls: unknown[][] } }, event: string): Record<string, unknown>[] =>
  spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.event === event);

const posts = () => fake.sheetCalls.filter((c) => c.method === 'POST');

describe('POST /api/lead-email: rejected before the sheet', () => {
  it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])('405 on %s', async (method) => {
    const out = await call(method);
    expect(out.status).toBe(405);
    expect(out.headers.get('Allow')).toBe('POST');
    expect(out.body).toEqual({ ok: false, error: 'method_not_allowed' });
    expect(fake.sheetCalls).toHaveLength(0);
  });

  it.each([
    ['an address with no domain', { leadId: LEAD_ID, email: 'asha' }, 'email'],
    ['a blank address', { leadId: LEAD_ID, email: '   ' }, 'email'],
    ['an address over 254 characters', { leadId: LEAD_ID, email: `${'a'.repeat(250)}@example.com` }, 'email'],
    ['a missing address', { leadId: LEAD_ID }, 'email'],
    ['a non-string address', { leadId: LEAD_ID, email: 42 }, 'email'],
    ['a lead id that is not a UUID', { leadId: 'cal-bk_1', email: 'asha@example.com' }, 'leadId'],
    ['a missing lead id', { email: 'asha@example.com' }, 'leadId'],
    ['the header text as the lead id', { leadId: 'Lead ID', email: 'asha@example.com' }, 'leadId'],
  ])('400 validation_failed for %s, naming the field and touching nothing', async (_name, body, field) => {
    const out = await call('POST', body);
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ ok: false, error: 'validation_failed' });
    expect(Object.keys((out.body as { fields: Record<string, string[]> }).fields)).toContain(field);
    expect(fake.sheetCalls).toHaveLength(0);
    expect(mx.check).not.toHaveBeenCalled();
  });

  it('applies the same email rule as the lead form', async () => {
    for (const email of ['josé@example.com', 'a@exa_mple.com']) {
      expect((await call('POST', { leadId: LEAD_ID, email })).status, email).toBe(400);
    }
  });

  it('400 invalid_json for malformed JSON and for a body that is not an object', async () => {
    for (const body of ['{not json', '[1,2]', 'null', '"text"']) {
      const out = await call('POST', body);
      expect(out.status, body).toBe(400);
      expect(out.body).toEqual({ ok: false, error: 'invalid_json' });
    }
    expect(fake.sheetCalls).toHaveLength(0);
  });

  it('413 for a body over 2 KiB, and up front from Content-Length without reading it', async () => {
    const big = await call('POST', { leadId: LEAD_ID, email: 'asha@example.com', pad: 'x'.repeat(2 * 1024) });
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ ok: false, error: 'payload_too_large' });

    const req = request('POST', { leadId: LEAD_ID, email: 'asha@example.com' }, { 'content-length': String(3 * 1024) });
    const textSpy = vi.spyOn(req, 'text');
    expect((await (await handlers()).POST!(req)).status).toBe(413);
    expect(textSpy).not.toHaveBeenCalled();
    expect(fake.sheetCalls).toHaveLength(0);
  });

  it('accepts a body at the largest valid size (a UUID, a 254-character address and the token)', async () => {
    fake.sheet.push(badRow());
    const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(49)}.example.com`;
    expect(email.length).toBeLessThanOrEqual(254);
    const raw = JSON.stringify({ leadId: LEAD_ID, email, fixToken: fixTokenFor(LEAD_ID) });
    expect(Buffer.byteLength(raw)).toBeLessThan(2 * 1024);
    expect((await call('POST', raw)).status).toBe(200);
  });
});

describe('POST /api/lead-email: finding the row', () => {
  it('404 not_found when no row has the lead id, with no write and no event', async () => {
    fake.sheet.push(badRow({ id: OTHER_ID }));
    const out = await call('POST', { leadId: LEAD_ID, email: 'asha@example.com' });
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ ok: false, error: 'not_found' });
    expect(posts()).toHaveLength(0);
    expect(fake.eventCalls).toHaveLength(0);
  });

  it.each(['OK', 'Unchecked', ''])('409 not_correctable when the row Email Check is %j: a good row is never rewritten', async (check) => {
    const row = badRow();
    row[COL['Email Check']!] = check;
    fake.sheet.push(row);
    const before = JSON.stringify(fake.sheet);
    const out = await call('POST', { leadId: LEAD_ID, email: 'someone.else@example.com' });
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ ok: false, error: 'not_correctable' });
    expect(JSON.stringify(fake.sheet)).toBe(before);
    expect(posts()).toHaveLength(0);
    expect(fake.eventCalls).toHaveLength(0);
  });

  it('409 for a row from before the column existed (its Email Check cell is absent)', async () => {
    fake.sheet.push(leadRow({ status: 'New', id: LEAD_ID }).slice(0, COL['Email Check']));
    expect((await call('POST', { leadId: LEAD_ID, email: 'asha@example.com' })).status).toBe(409);
    expect(posts()).toHaveLength(0);
  });

  it('matches the exact lead id among many rows, and corrects only that one', async () => {
    fake.sheet.push(badRow({ id: OTHER_ID, email: 'other@gmial.co' }), badRow(), badRow({ id: '33333333-3333-4333-8333-333333333333', email: 'third@gmial.co' }));
    const out = await call('POST', { leadId: LEAD_ID, email: 'corrected@example.org' });
    expect(out.status).toBe(200);
    expect(fake.sheet.map((r) => r[COL['Email']!])).toEqual(['Email', 'other@gmial.co', 'corrected@example.org', 'third@gmial.co']);
    expect(fake.sheet.map((r) => r[COL['Email Check']!])).toEqual(['Email Check', 'No mail server', 'OK', 'No mail server']);
  });

  it('refuses a sheet whose header row is not ours: 500, nothing written, the attempted correction logged', async () => {
    fake.sheet[0] = [...fake.sheet[0]!.slice(0, 10), 'Inserted', ...fake.sheet[0]!.slice(10)];
    fake.sheet.push(badRow());
    const out = await call('POST', { leadId: LEAD_ID, email: 'corrected@example.org' });
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ ok: false, error: 'server_misconfigured' });
    expect(posts()).toHaveLength(0);
    expect(logged(errors, 'LEAD_EMAIL_MISCONFIGURED')[0]).toMatchObject({ leadId: LEAD_ID, email: 'corrected@example.org' });
  });

  it('500 server_misconfigured, with the correction logged, when the Sheet environment is missing', async () => {
    vi.stubEnv('SHEET_ID', '');
    vi.resetModules();
    const out = await call('POST', { leadId: LEAD_ID, email: 'corrected@example.org' });
    expect(out.status).toBe(500);
    expect(logged(errors, 'LEAD_EMAIL_MISCONFIGURED')[0]).toMatchObject({ leadId: LEAD_ID, email: 'corrected@example.org' });
    expect(mx.check).not.toHaveBeenCalled();
  });
});

describe('POST /api/lead-email: correcting the row', () => {
  it('writes the new address and its check, and only those two cells', async () => {
    const row = badRow();
    row[COL['Setter Notes']!] = 'Call back Tue';
    row[COL['Deal Value (₹)']!] = '120000';
    fake.sheet.push(row);
    const before = [...fake.sheet[1]!];
    mx.check.mockResolvedValue('OK');

    const out = await call('POST', { leadId: LEAD_ID, email: '  corrected@example.org ' });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, leadId: LEAD_ID, emailOk: true });
    expect(mx.check).toHaveBeenCalledWith('corrected@example.org');

    const batch = posts();
    expect(batch).toHaveLength(1);
    const { valueInputOption, data } = batch[0]!.body as { valueInputOption: string; data: { range: string; values: string[][] }[] };
    expect(valueInputOption).toBe('RAW');
    expect(data).toEqual([
      { range: "'Leads'!C2", values: [['corrected@example.org']] },
      { range: "'Leads'!AO2", values: [['OK']] },
    ]);

    const after = fake.sheet[1]!;
    expect(after[COL['Email']!]).toBe('corrected@example.org');
    expect(after[COL['Email Check']!]).toBe('OK');
    after.forEach((cell, i) => {
      if (i !== COL['Email']! && i !== COL['Email Check']!) expect(cell, `column ${i}`).toBe(before[i]);
    });
    for (const h of MANUAL_HEADERS) expect(after[COL[h]!], h).toBe(before[COL[h]!]);
  });

  it('appends one Email corrected event (form source, the lead id, the check result, never the address)', async () => {
    fake.sheet.push(badRow());
    await call('POST', { leadId: LEAD_ID, email: 'corrected@example.org' });
    expect(fake.eventRows).toHaveLength(1);
    const [at, id, event, from, to, callTime, uid, source, detail] = fake.eventRows[0]!;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect([id, event, from, to, callTime, uid, source, detail]).toEqual([LEAD_ID, 'Email corrected', '', '', '', '', 'form', 'OK']);
    expect(JSON.stringify(fake.eventRows)).not.toContain('corrected@example.org');
    expect(logged(logs, 'LEAD_EMAIL_CORRECTED')[0]).toMatchObject({ leadId: LEAD_ID, row: 2, emailCheck: 'OK' });
  });

  it('a still-bad address is written anyway (the latest attempt wins) and answers emailOk false', async () => {
    fake.sheet.push(badRow());
    mx.check.mockResolvedValue('No mail server');
    const out = await call('POST', { leadId: LEAD_ID, email: 'asha@gmial.com' });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, leadId: LEAD_ID, emailOk: false });
    expect(fake.sheet[1]![COL['Email']!]).toBe('asha@gmial.com');
    expect(fake.sheet[1]![COL['Email Check']!]).toBe('No mail server');
    expect(fake.eventRows[0]![8]).toBe('No mail server');

    // The row stays correctable, so a third attempt lands too.
    mx.check.mockResolvedValue('OK');
    expect((await call('POST', { leadId: LEAD_ID, email: 'corrected@example.org' })).body).toMatchObject({ emailOk: true });
    expect(fake.sheet[1]![COL['Email']!]).toBe('corrected@example.org');
  });

  it('an Unchecked lookup is written as such and counts as ok', async () => {
    fake.sheet.push(badRow());
    mx.check.mockResolvedValue('Unchecked');
    const out = await call('POST', { leadId: LEAD_ID, email: 'asha@example.org' });
    expect(out.body).toEqual({ ok: true, leadId: LEAD_ID, emailOk: true });
    expect(fake.sheet[1]![COL['Email Check']!]).toBe('Unchecked');
  });

  it('once corrected, the same lead id cannot be used to rewrite the row with another address', async () => {
    fake.sheet.push(badRow());
    expect((await call('POST', { leadId: LEAD_ID, email: 'corrected@example.org' })).status).toBe(200);
    const out = await call('POST', { leadId: LEAD_ID, email: 'attacker@example.com' });
    expect(out.status).toBe(409);
    expect(fake.sheet[1]![COL['Email']!]).toBe('corrected@example.org');
  });

  describe('a retry of a correction that was already applied', () => {
    /** A row the first attempt already fixed, whose answer the visitor never saw. */
    function fixedRow(check: string, email = 'corrected@example.org'): string[] {
      const row = badRow({ email });
      row[COL['Email Check']!] = check;
      return row;
    }

    it.each(['OK', 'Unchecked'])('answers 200 emailOk true without writing when the row holds the same address with Email Check %s', async (check) => {
      fake.sheet.push(fixedRow(check));
      const before = JSON.stringify(fake.sheet);
      const out = await call('POST', { leadId: LEAD_ID, email: 'corrected@example.org' });
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ ok: true, leadId: LEAD_ID, emailOk: true });
      expect(JSON.stringify(fake.sheet)).toBe(before);
      expect(posts()).toHaveLength(0);
      expect(fake.eventCalls).toHaveLength(0);
    });

    it('compares the address trimmed and case-insensitively', async () => {
      fake.sheet.push(fixedRow('OK', 'Corrected@Example.org'));
      const out = await call('POST', { leadId: LEAD_ID, email: '  corrected@EXAMPLE.org ' });
      expect(out.body).toEqual({ ok: true, leadId: LEAD_ID, emailOk: true });
      expect(posts()).toHaveLength(0);
    });

    it('is a 409 when the row holds a different address, or its check is blank', async () => {
      fake.sheet.push(fixedRow('OK'));
      expect((await call('POST', { leadId: LEAD_ID, email: 'someone.else@example.org' })).status).toBe(409);
      fake.sheet[1]![COL['Email Check']!] = '';
      expect((await call('POST', { leadId: LEAD_ID, email: 'corrected@example.org' })).status).toBe(409);
      expect(posts()).toHaveLength(0);
    });

    it('the same request twice in a row: the first writes, the second is recognised', async () => {
      fake.sheet.push(badRow());
      expect((await call('POST', { leadId: LEAD_ID, email: 'corrected@example.org' })).status).toBe(200);
      expect(posts()).toHaveLength(1);
      expect((await call('POST', { leadId: LEAD_ID, email: 'corrected@example.org' })).body).toEqual({ ok: true, leadId: LEAD_ID, emailOk: true });
      expect(posts()).toHaveLength(1);
      expect(fake.eventRows).toHaveLength(1);
    });
  });

  it('stores an address that looks like a formula as text', async () => {
    fake.sheet.push(badRow());
    await call('POST', { leadId: LEAD_ID, email: '+cmd@example.com' });
    expect((posts()[0]!.body as { valueInputOption: string }).valueInputOption).toBe('RAW');
  });

  it('a failed Events write does not change the answer', async () => {
    fake.sheet.push(badRow());
    fake.failEvents = true;
    const out = await call('POST', { leadId: LEAD_ID, email: 'corrected@example.org' });
    expect(out.status).toBe(200);
    expect(fake.sheet[1]![COL['Email']!]).toBe('corrected@example.org');
    expect(logged(errors, 'EVENT_LOG_WRITE_FAILED')).toHaveLength(1);
  });
});

describe('POST /api/lead-email: Sheets failure', () => {
  it('502 write_failed, and the attempted correction (lead id and address) is logged for recovery', async () => {
    fake.sheet.push(badRow());
    fake.failSheets = true;
    const out = await call('POST', { leadId: LEAD_ID, email: 'corrected@example.org' });
    expect(out.status).toBe(502);
    expect(out.body).toEqual({ ok: false, error: 'write_failed' });
    const line = logged(errors, 'LEAD_EMAIL_WRITE_FAILED')[0]!;
    expect(line).toMatchObject({ leadId: LEAD_ID, email: 'corrected@example.org' });
    expect(String(line.error)).not.toBe('');
    expect(fake.eventCalls).toHaveLength(0);
  });
});

describe('POST /api/lead-email: the fix token', () => {
  const body = { leadId: LEAD_ID, email: 'corrected@example.org' };

  it.each([
    ['missing', () => undefined],
    ['empty', () => ''],
    ['wrong', () => 'x'.repeat(43)],
    ['not a string', () => 42],
    ['the token of a different lead', () => fixTokenFor(OTHER_ID)],
    ['the token with a character cut off', () => fixTokenFor(LEAD_ID)!.slice(1)],
  ])('403 forbidden for a %s token, with no DNS lookup and no sheet request at all', async (_name, token) => {
    fake.sheet.push(badRow());
    const out = await call('POST', { ...body, fixToken: token() });
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ ok: false, error: 'forbidden' });
    expect(fake.sheetCalls).toHaveLength(0);
    expect(fake.eventCalls).toHaveLength(0);
    expect(fake.tokenCalls).toBe(0);
    expect(mx.check).not.toHaveBeenCalled();
    expect(fake.sheet[1]![COL['Email']!]).toBe('asha@gmial.co');
  });

  it('a token for a lead that does not exist passes the gate and then gets 404', async () => {
    fake.sheet.push(badRow({ id: OTHER_ID }));
    expect((await call('POST', body)).status).toBe(404);
  });

  it('the token is base64url HMAC-SHA256 over "lead-email:" + leadId keyed by CRON_SECRET', async () => {
    const { createHmac } = await import('node:crypto');
    expect(fixTokenFor(LEAD_ID)).toBe(createHmac('sha256', CRON_SECRET).update(`lead-email:${LEAD_ID}`).digest('base64url'));
    expect(fixTokenFor(LEAD_ID)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fixTokenFor(LEAD_ID)).not.toBe(fixTokenFor(OTHER_ID));
    // Another secret signs differently, so a token cannot outlive a rotation.
    vi.stubEnv('CRON_SECRET', 'rotated');
    expect(fixTokenFor(LEAD_ID)).not.toBe(createHmac('sha256', CRON_SECRET).update(`lead-email:${LEAD_ID}`).digest('base64url'));
  });

  it('with CRON_SECRET unset: 500 server_misconfigured, logged, nothing read, even for a request carrying a token', async () => {
    vi.stubEnv('CRON_SECRET', '');
    fake.sheet.push(badRow());
    const out = await call('POST', { ...body, fixToken: 'anything' });
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ ok: false, error: 'server_misconfigured' });
    expect(logged(errors, 'LEAD_EMAIL_MISCONFIGURED')[0]).toMatchObject({ error: expect.stringContaining('CRON_SECRET') });
    expect(fake.sheetCalls).toHaveLength(0);
    expect(mx.check).not.toHaveBeenCalled();
  });

  it('a malformed body is still a 400, before the token is looked at', async () => {
    expect((await call('POST', { leadId: 'nope', email: 'corrected@example.org', fixToken: undefined })).status).toBe(400);
  });
});

describe('POST /api/lead-email: matching and robustness', () => {
  it('a Lead ID that merely contains the requested id never matches (exact match only)', async () => {
    fake.sheet.push(badRow({ id: `x${LEAD_ID}` }), badRow({ id: `${LEAD_ID}-2` }), badRow({ id: `cal-${LEAD_ID}` }));
    const before = JSON.stringify(fake.sheet);
    const out = await call('POST', { leadId: LEAD_ID, email: 'corrected@example.org' });
    expect(out.status).toBe(404);
    expect(JSON.stringify(fake.sheet)).toBe(before);
    expect(posts()).toHaveLength(0);
  });

  it('a resolver that cannot even be constructed still corrects the row, with Email Check Unchecked', async () => {
    // The real checkEmailDomain with the default resolver, whose constructor throws under tests/setup.ts.
    mx.check.mockImplementation(async (email: string) => (await vi.importActual<typeof import('../lib/email-domain.js')>('../lib/email-domain.js')).checkEmailDomain(email));
    fake.sheet.push(badRow());
    const out = await call('POST', { leadId: LEAD_ID, email: 'corrected@example.org' });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, leadId: LEAD_ID, emailOk: true });
    expect(fake.sheet[1]![COL['Email Check']!]).toBe('Unchecked');
  });
});
