import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeadRow } from '../lib/columns.js';
import { toRow } from '../lib/columns.js';

// Real JWT + real gaxios; only the network (global fetch) is stubbed.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const lead: LeadRow = {
  fullName: '=HYPERLINK("http://x")',
  email: 'asha@example.com',
  phone: '+919812345678',
  leadId: '11111111-1111-4111-8111-111111111111',
  submittedAt: new Date('2026-10-24T18:45:09Z'),
  userAgent: 'UA/1.0',
  ip: '203.0.113.9',
};

interface Call {
  url: URL;
  method: string;
  body: string;
}

let calls: Call[];

// gaxios (under google-auth-library) fetches through node-fetch, not global fetch, so the
// stub is injected where the library takes it: the JWT's transporter. Token and append share it.
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

function stubNetwork(handlers: { token?: () => Promise<Response>; sheets?: () => Promise<Response> }) {
  calls = [];
  net.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    if (url.hostname === 'oauth2.googleapis.com') {
      return handlers.token ? handlers.token() : Response.json({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.hostname === 'sheets.googleapis.com') {
      return handlers.sheets ? handlers.sheets() : Response.json({ updates: { updatedRows: 1 } });
    }
    throw new Error(`unexpected host ${url.hostname}`);
  };
}

async function loadSink(tab: string, deadlineMs?: number) {
  vi.resetModules();
  vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'lead-writer@proj.iam.gserviceaccount.com');
  vi.stubEnv('GOOGLE_PRIVATE_KEY', privateKey);
  vi.stubEnv('SHEET_ID', 'sheet/id 1');
  vi.stubEnv('SHEET_TAB', tab);
  const mod = await import('../lib/sinks/sheets.js');
  return deadlineMs === undefined ? mod.sheetsSink : mod.createSheetsSink(deadlineMs);
}

beforeEach(() => stubNetwork({}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('sheets sink', () => {
  it('appends one row to the URL-encoded tab with RAW + INSERT_ROWS', async () => {
    const sink = await loadSink('Leads & Calls');
    await sink.write(lead);

    const append = calls.find((c) => c.url.hostname === 'sheets.googleapis.com')!;
    expect(append).toBeDefined();
    expect(append.method).toBe('POST');
    expect(append.url.origin + append.url.pathname).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent('sheet/id 1')}/values/${encodeURIComponent('Leads & Calls!A1')}:append`,
    );
    expect(append.url.searchParams.get('valueInputOption')).toBe('RAW');
    expect(append.url.searchParams.get('insertDataOption')).toBe('INSERT_ROWS');
    expect(JSON.parse(append.body)).toEqual({ values: [toRow(lead)] });
  });

  it('throws on a non-2xx append so the handler logs LEAD_WRITE_FAILED', async () => {
    stubNetwork({ sheets: async () => Response.json({ error: { message: 'forbidden' } }, { status: 403 }) });
    const sink = await loadSink('Leads');
    await expect(sink.write(lead)).rejects.toThrow();
  });

  it('a hung token request rejects within the deadline', async () => {
    stubNetwork({ token: () => new Promise<Response>(() => {}) });
    const sink = await loadSink('Leads', 150);
    const t0 = Date.now();
    await expect(sink.write(lead)).rejects.toThrow(/exceeded 150ms/);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(calls.some((c) => c.url.hostname === 'sheets.googleapis.com')).toBe(false);
  });

  it('a hung token request does not poison the next write on the same instance', async () => {
    let tokenCalls = 0;
    stubNetwork({
      token: () => (++tokenCalls === 1
        ? new Promise<Response>(() => {})
        : Promise.resolve(Response.json({ access_token: 'tok2', expires_in: 3600, token_type: 'Bearer' }))),
    });
    const sink = await loadSink('Leads', 150);
    await expect(sink.write(lead)).rejects.toThrow(/exceeded 150ms/);
    await expect(sink.write(lead)).resolves.toBeUndefined();
    expect(tokenCalls).toBe(2);
    expect(calls.filter((c) => c.url.hostname === 'sheets.googleapis.com')).toHaveLength(1);
  });

  it('a hung append rejects within the same deadline', async () => {
    stubNetwork({ sheets: () => new Promise<Response>(() => {}) });
    const sink = await loadSink('Leads', 150);
    await expect(sink.write(lead)).rejects.toThrow(/exceeded 150ms/);
  });

  it('defaults to an 8 second overall deadline', async () => {
    await loadSink('Leads');
    const { WRITE_DEADLINE_MS } = await import('../lib/sinks/sheets.js');
    expect(WRITE_DEADLINE_MS).toBe(8000);
  });
});
