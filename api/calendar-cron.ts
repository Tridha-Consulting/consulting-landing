import { randomUUID } from 'node:crypto';
import { safeEqual } from '../lib/safe-equal.js';

// Daily Vercel cron. (a) Sweeps the next 90 days of the calendar for booker declines, which covers any
// push notification that never arrived. (b) Opens a fresh two-day push channel for /api/calendar-notify.
// Channels are never stored or stopped: a new one opens every day, so they overlap, and the
// duplicate notifications that causes are harmless because the sync is idempotent.

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_PAST_MS = DAY_MS;
const SWEEP_AHEAD_MS = 90 * DAY_MS;
const CHANNEL_TTL_SECONDS = 2 * 24 * 60 * 60;

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    console.error(JSON.stringify({ event: 'CALENDAR_CRON_MISCONFIGURED', error: 'Missing required environment variable: CRON_SECRET' }));
    return json(500, { ok: false, error: 'server_misconfigured' });
  }
  // Vercel sends the secret as a Bearer token on every cron invocation.
  if (!safeEqual(request.headers.get('authorization') ?? '', `Bearer ${secret}`)) {
    console.error(JSON.stringify({ event: 'CALENDAR_CRON_UNAUTHORIZED' }));
    return json(401, { ok: false, error: 'unauthorized' });
  }

  let calendarEnv: typeof import('../lib/calendar-env.js').calendarEnv;
  let calendarClient: typeof import('../lib/calendar-client.js');
  let syncFromCalendar: typeof import('../lib/calendar-sync.js').syncFromCalendar;
  try {
    ({ calendarEnv } = await import('../lib/calendar-env.js'));
    calendarClient = await import('../lib/calendar-client.js');
    ({ syncFromCalendar } = await import('../lib/calendar-sync.js'));
  } catch (err) {
    console.error(JSON.stringify({ event: 'CALENDAR_CRON_MISCONFIGURED', error: message(err) }));
    return json(500, { ok: false, error: 'server_misconfigured' });
  }

  // The two jobs are independent: one failing must not skip the other.
  let failed = false;
  let swept: number | null = null;
  let changed: number | null = null;
  let channelExpiresAt: string | null = null;

  try {
    const now = Date.now();
    const out = await syncFromCalendar(calendarEnv.calendarId, {
      timeMin: new Date(now - SWEEP_PAST_MS).toISOString(),
      timeMax: new Date(now + SWEEP_AHEAD_MS).toISOString(),
    });
    swept = out.events;
    changed = out.changes.length;
  } catch (err) {
    failed = true;
    console.error(JSON.stringify({ event: 'CALENDAR_SWEEP_FAILED', error: message(err) }));
  }

  try {
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
    if (!host) throw new Error('Missing environment variable VERCEL_PROJECT_PRODUCTION_URL, so the push address is unknown');
    const channelId = randomUUID();
    const { expiresAt } = await calendarClient.calendarDeadline('calendar watch', calendarClient.CALENDAR_DEADLINE_MS, (signal) =>
      calendarClient.watchEvents(
        calendarEnv.calendarId,
        { channelId, address: `https://${host}/api/calendar-notify`, token: calendarEnv.channelToken, ttlSeconds: CHANNEL_TTL_SECONDS },
        signal,
      ),
    );
    channelExpiresAt = expiresAt?.toISOString() ?? null;
    console.log(JSON.stringify({ event: 'CALENDAR_CHANNEL_RENEWED', channelId, expiresAt: channelExpiresAt }));
  } catch (err) {
    failed = true;
    console.error(JSON.stringify({ event: 'CALENDAR_WATCH_RENEW_FAILED', error: message(err) }));
  }

  return json(failed ? 500 : 200, { ok: !failed, swept, changed, channelExpiresAt });
}

// Any other method gets a JSON 405 (Vercel's default for an unexported method is an empty body).
function methodNotAllowed(): Response {
  return json(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET' });
}
export const POST = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
