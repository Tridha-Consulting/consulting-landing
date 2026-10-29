import { JWT } from 'google-auth-library';
import { env } from './env.js';
import { withDeadline } from './sheets-client.js';

/** One deadline for a whole Calendar operation: OAuth token fetch plus every page of the API calls. */
export const CALENDAR_DEADLINE_MS = 8000;

/** Pages fetched per listing; at 250 events a page this is far beyond what one calendar holds. */
const MAX_PAGES = 20;

let client: JWT | undefined;

function getClient(): JWT {
  // A separate client from the Sheets one: it asks for the read-only Calendar scope and nothing else.
  client ??= new JWT({
    email: env.serviceAccountEmail,
    key: env.privateKey,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  return client;
}

/** The fields of a Calendar event the sync reads. */
export interface CalendarEvent {
  id?: string;
  iCalUID?: string;
  status?: string;
  /** `dateTime` carries an offset, e.g. 2026-11-05T12:00:00+05:30; an all-day event has `date` only. */
  start?: { dateTime?: string; date?: string };
  attendees?: { email?: string; responseStatus?: string; organizer?: boolean }[];
}

export interface ListQuery {
  /** RFC 3339 instants; send either `updatedMin`, or `timeMin` with `timeMax`. */
  updatedMin?: string;
  timeMin?: string;
  timeMax?: string;
  showDeleted?: boolean;
}

function eventsUrl(calendarId: string, suffix = ''): string {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${suffix}`;
}

/** Every event matching `query`, recurrences expanded, across all pages. */
export async function listEvents(calendarId: string, query: ListQuery, signal: AbortSignal): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = { singleEvents: 'true', maxResults: '250' };
    if (query.updatedMin) params.updatedMin = query.updatedMin;
    if (query.timeMin) params.timeMin = query.timeMin;
    if (query.timeMax) params.timeMax = query.timeMax;
    if (query.showDeleted) params.showDeleted = 'true';
    if (pageToken) params.pageToken = pageToken;
    const res = await getClient().request<{ items?: CalendarEvent[]; nextPageToken?: string }>({ url: eventsUrl(calendarId), method: 'GET', params, signal });
    out.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken;
    if (!pageToken) return out;
  }
  // Truncating silently would hide declines past the cut, so a runaway listing fails instead.
  throw new Error(`calendar listing exceeded ${MAX_PAGES} pages`);
}

export interface WatchRequest {
  channelId: string;
  address: string;
  token: string;
  /** Requested channel lifetime in seconds. */
  ttlSeconds: number;
}

/** Opens a push channel on the calendar's events; returns when Google will stop it. */
export async function watchEvents(calendarId: string, req: WatchRequest, signal: AbortSignal): Promise<{ expiresAt: Date | null }> {
  const res = await getClient().request<{ expiration?: string }>({
    url: eventsUrl(calendarId, '/watch'),
    method: 'POST',
    data: { id: req.channelId, type: 'web_hook', address: req.address, token: req.token, params: { ttl: String(req.ttlSeconds) } },
    signal,
  });
  const ms = Number(res.data.expiration);
  return { expiresAt: Number.isFinite(ms) && ms > 0 ? new Date(ms) : null };
}

/** `withDeadline` for Calendar calls; a failure also discards this module's JWT so a hung token refresh cannot stick. */
export async function calendarDeadline<T>(what: string, deadlineMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  try {
    return await withDeadline(what, deadlineMs, run);
  } catch (err) {
    client = undefined;
    throw err;
  }
}
