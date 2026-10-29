// Calendar sync configuration, kept apart from lib/env.ts so that /api/lead and /api/cal-webhook
// keep working when these are unset. Only the calendar handlers import this file, and they import
// it dynamically so a missing variable becomes a logged 500 rather than a failed module load.
const REQUIRED = ['CALENDAR_ID', 'CALENDAR_CHANNEL_TOKEN'] as const;

export class CalendarEnvError extends Error {
  constructor(missing: string[]) {
    super(`Missing required environment variables: ${missing.join(', ')}`);
    this.name = 'CalendarEnvError';
  }
}

function load() {
  const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
  if (missing.length) throw new CalendarEnvError([...missing]);
  return {
    /** Calendar the bookings land on: the one shared read-only with the service account. */
    calendarId: process.env.CALENDAR_ID!.trim(),
    /** Shared secret Google echoes in X-Goog-Channel-Token on every push notification. */
    channelToken: process.env.CALENDAR_CHANNEL_TOKEN!.trim(),
  };
}

/** Validated at module load: importing this file throws when configuration is incomplete. */
export const calendarEnv = load();
