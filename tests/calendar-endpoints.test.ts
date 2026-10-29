import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEADERS, STATUS } from '../lib/columns.js';
import {
  CALENDAR_ID,
  CHANNEL_TOKEN,
  COL,
  CRON_SECRET,
  PRODUCTION_HOST,
  SHEET_ID,
  WATCH_EXPIRATION_MS,
  calEvent,
  fake,
  leadRow,
  privateKey,
  resetFakes,
} from './calendar-fakes.js';
import { readJsonResponse } from './helpers.js';

vi.mock('google-auth-library', async () => {
  const actual = await vi.importActual<typeof import('google-auth-library')>('google-auth-library');
  const { mockJwt } = await import('./calendar-fakes.js');
  return mockJwt(actual);
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface EnvOptions {
  calendarId?: string;
  token?: string;
  cronSecret?: string;
  host?: string;
}

function stubEnv(o: EnvOptions = {}): void {
  vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'lead-writer@proj.iam.gserviceaccount.com');
  vi.stubEnv('GOOGLE_PRIVATE_KEY', privateKey);
  vi.stubEnv('SHEET_ID', SHEET_ID);
  vi.stubEnv('SHEET_TAB', 'Leads');
  vi.stubEnv('CALENDAR_ID', o.calendarId ?? CALENDAR_ID);
  vi.stubEnv('CALENDAR_CHANNEL_TOKEN', o.token ?? CHANNEL_TOKEN);
  vi.stubEnv('CRON_SECRET', o.cronSecret ?? CRON_SECRET);
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', o.host ?? PRODUCTION_HOST);
}

function notifyRequest(headers: Record<string, string> = {}, method = 'POST'): Request {
  return new Request(`https://${PRODUCTION_HOST}/api/calendar-notify`, { method, headers });
}

function cronRequest(headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(`https://${PRODUCTION_HOST}/api/calendar-cron`, { method, headers });
}

const goodPush = { 'x-goog-channel-token': CHANNEL_TOKEN, 'x-goog-resource-state': 'exists' };
const goodCron = { authorization: `Bearer ${CRON_SECRET}` };

let errors: ReturnType<typeof vi.spyOn>;
const errorEvents = () => errors.mock.calls.map((c: unknown[]) => (JSON.parse(String(c[0])) as { event: string }).event);
const listCalls = () => fake.calendarCalls.filter((c) => c.method === 'GET');
const watchCalls = () => fake.calendarCalls.filter((c) => c.method === 'POST');
const sheetWrites = () => fake.sheetCalls.filter((c) => c.method === 'POST');

beforeEach(() => {
  resetFakes();
  vi.resetModules();
  stubEnv();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('POST /api/calendar-notify', () => {
  const load = () => import('../api/calendar-notify.js');

  it.each([
    ['a missing token', {}],
    ['a wrong token', { 'x-goog-channel-token': 'nope', 'x-goog-resource-state': 'exists' }],
    ['a truncated token', { 'x-goog-channel-token': CHANNEL_TOKEN.slice(0, -1), 'x-goog-resource-state': 'exists' }],
    ['an empty token', { 'x-goog-channel-token': '', 'x-goog-resource-state': 'exists' }],
  ])('rejects %s with 401 and touches no API', async (_name, headers) => {
    fake.events = [calEvent({ uid: 'u1', response: 'declined' })];
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1' }));
    const { POST } = await load();
    const out = await readJsonResponse(await POST(notifyRequest(headers)));
    expect(out.status).toBe(401);
    expect(fake.calendarCalls).toHaveLength(0);
    expect(fake.sheetCalls).toHaveLength(0);
    expect(errorEvents()).toEqual(['CALENDAR_NOTIFY_BAD_TOKEN']);
  });

  it('acknowledges the sync handshake without calling any API', async () => {
    const { POST } = await load();
    const out = await readJsonResponse(await POST(notifyRequest({ ...goodPush, 'x-goog-resource-state': 'sync' })));
    expect(out.status).toBe(200);
    expect(fake.calendarCalls).toHaveLength(0);
    expect(fake.sheetCalls).toHaveLength(0);
  });

  it('lists events updated in the last 48h across pages and flags the declining booker', async () => {
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1' }), leadRow({ status: STATUS.booked, uid: 'u2', email: 'other@example.com' }));
    fake.events = [
      calEvent({ uid: 'u1', response: 'declined' }),
      calEvent({ uid: 'u2', booker: 'other@example.com', response: 'accepted' }),
      { iCalUID: 'not-cal@google.com' },
    ];
    fake.pageSize = 2;
    const before = Date.now();
    const { POST } = await load();
    const out = await readJsonResponse(await POST(notifyRequest(goodPush)));
    expect(out).toMatchObject({ status: 200, body: { ok: true, events: 3, changed: 1 } });

    expect(listCalls()).toHaveLength(2);
    const first = listCalls()[0]!.url;
    expect(decodeURIComponent(first.pathname)).toBe(`/calendar/v3/calendars/${CALENDAR_ID}/events`);
    expect(first.searchParams.get('singleEvents')).toBe('true');
    expect(first.searchParams.get('showDeleted')).toBe('true');
    const updatedMin = Date.parse(first.searchParams.get('updatedMin')!);
    expect(updatedMin).toBeGreaterThanOrEqual(before - 2 * DAY - 1000);
    expect(updatedMin).toBeLessThanOrEqual(Date.now() - 2 * DAY + 1000);
    expect(listCalls()[1]!.url.searchParams.get('pageToken')).toBe('2');

    expect(sheetWrites()).toHaveLength(1);
    expect(fake.sheet[1]![COL['Status']!]).toBe('Declined');
    expect(fake.sheet[2]![COL['Status']!]).toBe('Booked');
  });

  it('returns 200 and writes nothing when nothing changed', async () => {
    fake.sheet.push(leadRow({ status: STATUS.declined, uid: 'u1' }));
    fake.events = [calEvent({ uid: 'u1', response: 'declined' })];
    const { POST } = await load();
    const out = await readJsonResponse(await POST(notifyRequest(goodPush)));
    expect(out).toMatchObject({ status: 200, body: { changed: 0 } });
    expect(sheetWrites()).toHaveLength(0);
  });

  it('returns 500 when the Calendar API fails, so Google retries', async () => {
    fake.failList = true;
    const { POST } = await load();
    const out = await readJsonResponse(await POST(notifyRequest(goodPush)));
    expect(out.status).toBe(500);
    expect(errorEvents()).toEqual(['CALENDAR_NOTIFY_FAILED']);
  });

  it('returns 500 when the Sheets API fails', async () => {
    fake.events = [calEvent({ uid: 'u1', response: 'declined' })];
    fake.failSheets = true;
    const { POST } = await load();
    expect((await POST(notifyRequest(goodPush))).status).toBe(500);
    expect(errorEvents()).toEqual(['CALENDAR_NOTIFY_FAILED']);
  });

  it('returns 500 and writes nothing when the header row is wrong', async () => {
    fake.sheet[0] = [...HEADERS.slice(0, 4), 'Renamed', ...HEADERS.slice(5)];
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1' }));
    fake.events = [calEvent({ uid: 'u1', response: 'declined' })];
    const { POST } = await load();
    expect((await POST(notifyRequest(goodPush))).status).toBe(500);
    expect(sheetWrites()).toHaveLength(0);
  });

  it('returns 500 with a named variable when CALENDAR_ID is unset', async () => {
    stubEnv({ calendarId: '' });
    const { POST } = await load();
    expect((await POST(notifyRequest(goodPush))).status).toBe(500);
    const line = String(errors.mock.calls[0]![0]);
    expect(JSON.parse(line).event).toBe('CALENDAR_NOTIFY_MISCONFIGURED');
    expect(line).toContain('CALENDAR_ID');
    expect(fake.calendarCalls).toHaveLength(0);
  });

  it('answers other methods with a JSON 405', async () => {
    const { GET } = await load();
    const out = await readJsonResponse(GET());
    expect(out.status).toBe(405);
    expect(out.headers.get('allow')).toBe('POST');
  });
});

describe('GET /api/calendar-cron', () => {
  const load = () => import('../api/calendar-cron.js');

  it.each([
    ['no header', {}],
    ['wrong secret', { authorization: 'Bearer nope' }],
    ['the secret without Bearer', { authorization: CRON_SECRET }],
  ])('rejects %s with 401 and touches no API', async (_name, headers) => {
    const { GET } = await load();
    const out = await readJsonResponse(await GET(cronRequest(headers)));
    expect(out.status).toBe(401);
    expect(fake.calendarCalls).toHaveLength(0);
    expect(fake.sheetCalls).toHaveLength(0);
    expect(errorEvents()).toEqual(['CALENDAR_CRON_UNAUTHORIZED']);
  });

  it('refuses with 500 when CRON_SECRET is unset, rather than accepting "Bearer "', async () => {
    stubEnv({ cronSecret: '' });
    const { GET } = await load();
    expect((await GET(cronRequest({ authorization: 'Bearer ' }))).status).toBe(500);
    expect(fake.calendarCalls).toHaveLength(0);
  });

  it('sweeps yesterday..+90 days, flags a decline, and opens a 2-day push channel', async () => {
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1' }));
    fake.events = [calEvent({ uid: 'u1', response: 'declined' })];
    const before = Date.now();
    const { GET } = await load();
    const out = await readJsonResponse(await GET(cronRequest(goodCron)));
    expect(out).toMatchObject({ status: 200, body: { ok: true, swept: 1, changed: 1, channelExpiresAt: new Date(WATCH_EXPIRATION_MS).toISOString() } });

    const list = listCalls()[0]!.url;
    expect(list.searchParams.get('singleEvents')).toBe('true');
    expect(list.searchParams.get('updatedMin')).toBeNull();
    const timeMin = Date.parse(list.searchParams.get('timeMin')!);
    const timeMax = Date.parse(list.searchParams.get('timeMax')!);
    expect(Math.abs(timeMin - (before - DAY))).toBeLessThan(5000);
    expect(Math.abs(timeMax - (before + 90 * DAY))).toBeLessThan(5000);
    expect(fake.sheet[1]![COL['Status']!]).toBe('Declined');

    expect(watchCalls()).toHaveLength(1);
    const watch = watchCalls()[0]!;
    expect(decodeURIComponent(watch.url.pathname)).toBe(`/calendar/v3/calendars/${CALENDAR_ID}/events/watch`);
    expect(watch.body).toMatchObject({
      type: 'web_hook',
      address: `https://${PRODUCTION_HOST}/api/calendar-notify`,
      token: CHANNEL_TOKEN,
      params: { ttl: '172800' },
    });
    expect((watch.body as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses a fresh channel id on every run', async () => {
    const { GET } = await load();
    await GET(cronRequest(goodCron));
    await GET(cronRequest(goodCron));
    const [a, b] = watchCalls().map((c) => (c.body as { id: string }).id);
    expect(a).not.toBe(b);
  });

  it('still renews the channel when the sweep fails, and answers 500', async () => {
    fake.failList = true;
    const { GET } = await load();
    const out = await readJsonResponse(await GET(cronRequest(goodCron)));
    expect(out).toMatchObject({ status: 500, body: { ok: false, swept: null, channelExpiresAt: new Date(WATCH_EXPIRATION_MS).toISOString() } });
    expect(watchCalls()).toHaveLength(1);
    expect(errorEvents()).toEqual(['CALENDAR_SWEEP_FAILED']);
  });

  it('still sweeps when renewing fails, and answers 500', async () => {
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1' }));
    fake.events = [calEvent({ uid: 'u1', response: 'declined' })];
    fake.failWatch = true;
    const { GET } = await load();
    const out = await readJsonResponse(await GET(cronRequest(goodCron)));
    expect(out).toMatchObject({ status: 500, body: { ok: false, swept: 1, changed: 1, channelExpiresAt: null } });
    expect(fake.sheet[1]![COL['Status']!]).toBe('Declined');
    expect(errorEvents()).toEqual(['CALENDAR_WATCH_RENEW_FAILED']);
  });

  it('fails loudly, without a watch call, when the production host is unknown, but still sweeps', async () => {
    stubEnv({ host: '' });
    fake.sheet.push(leadRow({ status: STATUS.booked, uid: 'u1' }));
    fake.events = [calEvent({ uid: 'u1', response: 'declined' })];
    const { GET } = await load();
    const out = await readJsonResponse(await GET(cronRequest(goodCron)));
    expect(out).toMatchObject({ status: 500, body: { ok: false, changed: 1 } });
    expect(watchCalls()).toHaveLength(0);
    expect(String(errors.mock.calls[0]![0])).toContain('VERCEL_PROJECT_PRODUCTION_URL');
  });

  it('returns 500 with a named variable when CALENDAR_CHANNEL_TOKEN is unset', async () => {
    stubEnv({ token: '' });
    const { GET } = await load();
    expect((await GET(cronRequest(goodCron))).status).toBe(500);
    expect(String(errors.mock.calls[0]![0])).toContain('CALENDAR_CHANNEL_TOKEN');
    expect(fake.calendarCalls).toHaveLength(0);
  });

  it('answers other methods with a JSON 405', async () => {
    const { POST } = await load();
    const out = await readJsonResponse(POST());
    expect(out.status).toBe(405);
    expect(out.headers.get('allow')).toBe('GET');
  });
});

describe('configuration', () => {
  it('registers the daily cron in vercel.json', async () => {
    const { readFileSync } = await import('node:fs');
    const cfg = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as { crons: { path: string; schedule: string }[] };
    expect(cfg.crons).toEqual([{ path: '/api/calendar-cron', schedule: '30 0 * * *' }]);
  });

  it('leaves /api/lead and /api/cal-webhook loadable when the calendar variables are unset', async () => {
    stubEnv({ calendarId: '', token: '', cronSecret: '' });
    await expect(import('../api/lead.js')).resolves.toBeTruthy();
    await expect(import('../api/cal-webhook.js')).resolves.toBeTruthy();
    await expect(import('../lib/env.js')).resolves.toBeTruthy();
    await expect(import('../lib/calendar-env.js')).rejects.toThrow(/CALENDAR_ID, CALENDAR_CHANNEL_TOKEN/);
  });
});
