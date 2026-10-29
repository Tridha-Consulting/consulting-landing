const REQUIRED = ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'SHEET_ID'] as const;

export class EnvError extends Error {
  constructor(missing: string[]) {
    super(`Missing required environment variables: ${missing.join(', ')}`);
    this.name = 'EnvError';
  }
}

function load() {
  const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
  if (missing.length) throw new EnvError([...missing]);
  return {
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!.trim(),
    // Vercel UI and .env files often store the key with literal \n sequences.
    privateKey: process.env.GOOGLE_PRIVATE_KEY!.trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n'),
    sheetId: process.env.SHEET_ID!.trim(),
    sheetTab: process.env.SHEET_TAB?.trim() || 'Leads',
    // The audit-log tab (lib/event-log.ts).
    eventsTab: process.env.EVENTS_TAB?.trim() || 'Events',
  };
}

/** Validated at module load: importing this file throws when configuration is incomplete. */
export const env = load();
