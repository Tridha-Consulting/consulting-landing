import { SheetLayoutError } from '../lib/columns.js';
import { safeEqual } from '../lib/safe-equal.js';

// Google Calendar push notifications -> booker declines onto the lead's row. Google sends no event
// data, only "something changed" with the channel's token, so every notification re-lists the events
// updated in the last two days; the sync is idempotent, so duplicate or overlapping notifications are harmless.

const LOOKBACK_MS = 48 * 60 * 60 * 1000;

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}

export async function POST(request: Request): Promise<Response> {
  let calendarEnv: typeof import('../lib/calendar-env.js').calendarEnv;
  let syncFromCalendar: typeof import('../lib/calendar-sync.js').syncFromCalendar;
  try {
    ({ calendarEnv } = await import('../lib/calendar-env.js'));
    ({ syncFromCalendar } = await import('../lib/calendar-sync.js'));
  } catch (err) {
    console.error(JSON.stringify({ event: 'CALENDAR_NOTIFY_MISCONFIGURED', error: err instanceof Error ? err.message : String(err) }));
    return json(500, { ok: false, error: 'server_misconfigured' });
  }

  if (!safeEqual(request.headers.get('x-goog-channel-token') ?? '', calendarEnv.channelToken)) {
    // Unauthenticated request: log the event only.
    console.error(JSON.stringify({ event: 'CALENDAR_NOTIFY_BAD_TOKEN' }));
    return json(401, { ok: false, error: 'bad_token' });
  }

  // Google sends `sync` once when a channel opens; there is nothing to read yet.
  if (request.headers.get('x-goog-resource-state') === 'sync') return json(200, { ok: true, ignored: 'sync' });

  try {
    const updatedMin = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const { events, changes } = await syncFromCalendar(calendarEnv.calendarId, { updatedMin, showDeleted: true });
    return json(200, { ok: true, events, changed: changes.length });
  } catch (err) {
    // 500 makes Google retry with backoff; the daily cron sweep covers a notification that never succeeds.
    console.error(
      JSON.stringify({ event: 'CALENDAR_NOTIFY_FAILED', error: err instanceof Error ? err.message : String(err), ...(err instanceof SheetLayoutError && { layout: true }) }),
    );
    return json(500, { ok: false, error: 'sync_failed' });
  }
}

// Any other method gets a JSON 405 (Vercel's default for an unexported method is an empty body).
function methodNotAllowed(): Response {
  return json(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
}
export const GET = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
