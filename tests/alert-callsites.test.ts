import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// An endpoint that awaited sendAlert would hold its response for the mail server, up to the 6 s deadline, past
// the browser's submit timeouts (js/form.js). Endpoints call alertInBackground, which sends after the response.
const API_DIR = new URL('../api/', import.meta.url);
const files = readdirSync(API_DIR).filter((f) => f.endsWith('.ts'));

describe('alerts from the endpoints', () => {
  it('finds the endpoints', () => {
    expect(files).toEqual(expect.arrayContaining(['lead.ts', 'lead-email.ts', 'cal-webhook.ts', 'calendar-cron.ts', 'calendar-notify.ts']));
  });

  it.each(files)('api/%s never imports or calls sendAlert, only alertInBackground', (file) => {
    // Comments and strings are not code, but a mention of the name in one is unlikely enough to be worth flagging too.
    const source = readFileSync(new URL(file, API_DIR), 'utf8');
    expect(source).not.toMatch(/\bsendAlert\b/);
  });

  it('every alert in api/ goes through alertInBackground, and none is awaited', () => {
    for (const file of files) {
      const source = readFileSync(new URL(file, API_DIR), 'utf8');
      expect(source, file).not.toMatch(/await\s+alertInBackground/);
    }
    const total = files.map((f) => (readFileSync(new URL(f, API_DIR), 'utf8').match(/\balertInBackground\(/g) ?? []).length).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });
});
