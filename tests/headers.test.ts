import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

type Rule = { source: string; headers: { key: string; value: string }[] };
const rules = (JSON.parse(read('vercel.json')) as { headers: Rule[] }).headers;
const PAGES = ['index.html', 'book.html'];

/* The sources in vercel.json are literal paths, optionally ending in (.*). Any other syntax fails here until this is taught it. */
function matches(source: string, path: string): boolean {
  const m = /^([\w/.-]*)(\(\.\*\))?$/.exec(source);
  if (!m) throw new Error(`matches() cannot read the vercel.json source ${source}`);
  return m[2] ? path.startsWith(m[1]!) : path === m[1];
}

/* The one value a header takes on a path. Two matching rules setting the same key fail, so rule order never decides a header. */
function header(path: string, key: string): string {
  const values = rules
    .filter((r) => matches(r.source, path))
    .flatMap((r) => r.headers.filter((h) => h.key.toLowerCase() === key.toLowerCase()).map((h) => h.value));
  expect(values, `${key} on ${path}`).toHaveLength(1);
  return values[0]!;
}

function parseCsp(value: string): Map<string, string[]> {
  const parts = value.split(';').map((d) => d.trim()).filter(Boolean);
  const map = new Map(parts.map((d) => {
    const [name, ...sources] = d.split(/\s+/);
    return [name!.toLowerCase(), sources] as const;
  }));
  expect(map.size, 'a repeated CSP directive is ignored by browsers').toBe(parts.length);
  return map;
}

const csp = parseCsp(header('/', 'Content-Security-Policy'));

function directive(name: string): string[] {
  const sources = csp.get(name);
  if (!sources) throw new Error(`CSP has no ${name}`);
  return sources;
}

/* CSP host-source matching for https URLs: https://host matches that host only, https://*.domain any subdomain but not the domain itself. */
function allows(sources: readonly string[], url: string): boolean {
  const { protocol, hostname } = new URL(url);
  return sources.some((s) => {
    const m = /^(https:)\/\/(\*\.)?([a-z0-9.-]+)$/.exec(s);
    if (!m || m[1] !== protocol) return false;
    return m[2] ? hostname.endsWith(`.${m[3]}`) : hostname === m[3];
  });
}

/* Browsers hash an inline script or handler as parsed, and HTML parsing turns CRLF into LF, so a Windows checkout hashes like the deployed file. */
function sha256(text: string): string {
  return `'sha256-${createHash('sha256').update(text.replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`;
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

function inlineHandlers(html: string): string[] {
  return [...html.matchAll(/\son[a-z]+=(?:"([^"]*)"|'([^']*)')/g)].map((m) => {
    const code = m[1] ?? m[2]!;
    if (code.includes('&')) throw new Error(`decode the HTML entities in ${code} before hashing it`);
    return code;
  });
}

const origin = (url: string): string => new URL(url).origin;

const trackJs = read('js/track.js');
const TAG_SCRIPTS = [...trackJs.matchAll(/addScript\('(https:\/\/[^']+)'/g)].map((m) => origin(m[1]!));
const CAL_ORIGINS = [
  /CAL_ORIGIN: '([^']+)'/.exec(read('js/config.js'))?.[1],
  /DEFAULT_ORIGIN = '([^']+)'/.exec(read('js/booking.js'))?.[1],
].map((u) => origin(u ?? 'missing:'));
const TURNSTILE = [...read('js/form.js').matchAll(/\.src = '(https:\/\/[^']+)'/g)].map((m) => origin(m[1]!));
const LOADED_SCRIPTS = [...new Set([...TAG_SCRIPTS, ...CAL_ORIGINS, ...TURNSTILE])];

type Directive = 'script-src' | 'style-src' | 'font-src' | 'img-src' | 'connect-src' | 'frame-src' | 'form-action';
type Needs = Partial<Record<Directive, string[]>>;

const GOOGLE_HITS = [
  'https://www.googletagmanager.com', 'https://region1.google-analytics.com', 'https://region1.analytics.google.com',
  'https://www.google.com', 'https://google.com', 'https://www.google.co.in', 'https://googleads.g.doubleclick.net',
  'https://stats.g.doubleclick.net', 'https://www.googleadservices.com', 'https://pagead2.googlesyndication.com',
];
const LINKEDIN_HITS = ['https://px.ads.linkedin.com', 'https://px4.ads.linkedin.com', 'https://dc.ads.linkedin.com'];
const X_HITS = ['https://t.co', 'https://analytics.twitter.com', 'https://ads-twitter.com', 'https://ads-api.twitter.com'];

/* What each third-party script this site loads goes on to need from the page, keyed by that script's origin.
   Every host in the CSP must serve one of these needs, so this table is where a CSP host's reason lives. */
const VENDOR_NEEDS: Record<string, Needs> = {
  /* Meta Pixel. fbevents.js sends hits to www.facebook.com/tr by image, sendBeacon or fetch, and as a last resort POSTs a hidden
     form into a hidden iframe (form-action, frame-src). It samples telemetry to connect.facebook.net/log, and names
     www.instagram.com/tr as its Instagram attribution endpoint. */
  'https://connect.facebook.net': {
    'img-src': ['https://www.facebook.com', 'https://www.instagram.com'],
    'connect-src': ['https://www.facebook.com', 'https://connect.facebook.net', 'https://www.instagram.com'],
    'frame-src': ['https://www.facebook.com'],
    'form-action': ['https://www.facebook.com'],
  },
  /* gtag.js, for GA4 and Google Ads: the Google Analytics and Google Ads tables of Google's tag CSP guide
     (developers.google.com/tag-platform/security/guides/csp). That guide asks for each local Google TLD by name: google.co.in
     serves Indian visitors. gtag.js also posts to google.com without www (/pagead/form-data), loads the remarketing hit
     googleads.g.doubleclick.net/pagead/viewthroughconversion, frames its service worker from www.googletagmanager.com, and
     Google Ads remarketing frames td.doubleclick.net. */
  'https://www.googletagmanager.com': {
    'script-src': ['https://www.googleadservices.com', 'https://www.google.com', 'https://googleads.g.doubleclick.net'],
    'img-src': GOOGLE_HITS,
    'connect-src': [...GOOGLE_HITS, 'https://ad.doubleclick.net'],
    'frame-src': ['https://www.googletagmanager.com', 'https://td.doubleclick.net'],
  },
  /* LinkedIn Insight Tag. insight.min.js sends px.ads.linkedin.com/collect as an image and /wa/ by fetch, sendBeacon or XHR;
     LinkedIn's help article on a tag that won't load (linkedin.com/help/lms/answer/a425696) adds the px4 and dc hosts and the
     p.adsymptotic.com and www.linkedin.com cookie syncs. */
  'https://snap.licdn.com': {
    'img-src': [...LINKEDIN_HITS, 'https://p.adsymptotic.com', 'https://www.linkedin.com'],
    'connect-src': LINKEDIN_HITS,
  },
  /* X pixel. uwt.js sends t.co/1/i/adsct and analytics.twitter.com/1/i/adsct by sendBeacon, falling back to an image; X's
     pixel FAQ asks for ads-twitter.com and ads-api.twitter.com in img-src and connect-src as well. */
  'https://static.ads-twitter.com': { 'img-src': X_HITS, 'connect-src': X_HITS },
  /* Cal.com embed. embed.js frames the booking page (and its preload) from the embed origin, and its injected stylesheet loads
     the Cal Sans font from cal.com. Cal's hosted app answers on cal.com too, which booking.js links visitors to. app.cal.com
     already runs script here, so letting it make requests as well adds no exposure if a later embed.js starts to. */
  'https://app.cal.com': {
    'script-src': ['https://cal.com'],
    'frame-src': ['https://app.cal.com', 'https://cal.com'],
    'font-src': ['https://cal.com'],
    'connect-src': ['https://app.cal.com'],
  },
  /* Turnstile: Cloudflare's Turnstile CSP reference asks for script-src and frame-src; api.js also sends its feedback reports
     from this page by sendBeacon or fetch. */
  'https://challenges.cloudflare.com': {
    'frame-src': ['https://challenges.cloudflare.com'],
    'connect-src': ['https://challenges.cloudflare.com'],
  },
};

/* Google Fonts CSS points at font files on fonts.gstatic.com, fetched in CORS mode, which is why its preconnect carries crossorigin. */
const PAGE_NEEDS: Needs = {
  'style-src': PAGES.flatMap((p) => [...read(p).matchAll(/<link rel="stylesheet" href="(https:\/\/[^"]+)"/g)].map((m) => origin(m[1]!))),
  'font-src': PAGES.flatMap((p) => [...read(p).matchAll(/<link rel="preconnect" href="(https:\/\/[^"]+)" crossorigin>/g)].map((m) => origin(m[1]!))),
};

function needs(name: Directive): string[] {
  const vendor = Object.values(VENDOR_NEEDS).flatMap((n) => n[name] ?? []);
  return [...(name === 'script-src' ? LOADED_SCRIPTS : []), ...vendor, ...(PAGE_NEEDS[name] ?? [])];
}

describe('security headers (vercel.json)', () => {
  it('sends a CSP, X-Frame-Options DENY and the existing hardening headers on every route', () => {
    const all = rules.find((r) => r.source === '/(.*)');
    expect(all?.headers.map((h) => h.key)).toContain('Content-Security-Policy');
    for (const path of ['/', '/book', '/api/lead', '/assets/hero.mp4']) {
      expect(header(path, 'Content-Security-Policy')).toContain("default-src 'self'");
      expect(header(path, 'X-Frame-Options')).toBe('DENY');
      expect(header(path, 'X-Content-Type-Options')).toBe('nosniff');
      expect(header(path, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    }
  });

  it('locks down the page itself', () => {
    expect(directive('default-src')).toEqual(["'self'"]);
    expect(directive('base-uri')).toEqual(["'self'"]);
    expect(directive('object-src')).toEqual(["'none'"]);
    expect(directive('frame-ancestors')).toEqual(["'none'"]);
    expect(directive('form-action')).toContain("'self'");
    expect(directive('media-src')).toEqual(["'self'"]);
    expect(csp.has('upgrade-insecure-requests')).toBe(true);
  });

  it('never lets script-src fall back to inline, eval or a whole scheme', () => {
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", '*', 'https:', 'http:', 'data:', 'blob:']) {
      expect(directive('script-src')).not.toContain(bad);
    }
  });

  it.each(PAGES)('hashes every inline script and handler on %s into script-src', (page) => {
    const html = read(page);
    for (const code of [...inlineScripts(html), ...inlineHandlers(html)]) expect(directive('script-src')).toContain(sha256(code));
    if (inlineHandlers(html).length) expect(directive('script-src')).toContain("'unsafe-hashes'");
  });

  it("keeps book.html's never-blank guard and its onerror handler under a hash", () => {
    const html = read('book.html');
    expect(inlineScripts(html)).toHaveLength(1);
    expect(inlineHandlers(html)).toEqual(['trdBookStaticFallback()']);
  });

  it('carries no hash for a script that no longer exists', () => {
    const current = new Set(PAGES.flatMap((p) => [...inlineScripts(read(p)), ...inlineHandlers(read(p))].map(sha256)));
    for (const hash of directive('script-src').filter((s) => s.startsWith("'sha256-"))) expect(current).toContain(hash);
  });

  it('allows every third-party script this site loads', () => {
    expect(TAG_SCRIPTS.length, 'every addScript call in track.js names a literal https URL').toBe(
      [...trackJs.matchAll(/(?<!function )addScript\(/g)].length,
    );
    expect(TAG_SCRIPTS).toEqual(['https://connect.facebook.net', 'https://www.googletagmanager.com', 'https://snap.licdn.com', 'https://static.ads-twitter.com']);
    expect(CAL_ORIGINS).toEqual(['https://app.cal.com', 'https://app.cal.com']);
    expect(TURNSTILE).toEqual(['https://challenges.cloudflare.com']);
    for (const url of LOADED_SCRIPTS) expect(allows(directive('script-src'), url), url).toBe(true);
  });

  it('knows what each loaded script needs, and allows all of it', () => {
    for (const url of LOADED_SCRIPTS) expect(Object.keys(VENDOR_NEEDS), `VENDOR_NEEDS has no entry for ${url}`).toContain(url);
    for (const name of ['script-src', 'style-src', 'font-src', 'img-src', 'connect-src', 'frame-src', 'form-action'] as const) {
      for (const url of needs(name)) expect(allows(directive(name), url), `${name} ${url}`).toBe(true);
    }
  });

  it('allows the Google Fonts hosts the pages use', () => {
    expect(PAGE_NEEDS['style-src']).toContain('https://fonts.googleapis.com');
    expect(PAGE_NEEDS['font-src']).toContain('https://fonts.gstatic.com');
  });

  it('allows no host without a reason in VENDOR_NEEDS or the pages', () => {
    for (const name of ['script-src', 'style-src', 'font-src', 'img-src', 'connect-src', 'frame-src', 'form-action'] as const) {
      for (const source of directive(name).filter((s) => s.startsWith('https://'))) {
        expect(needs(name).some((url) => allows([source], url)), `${name} ${source} serves no listed need`).toBe(true);
      }
    }
  });
});

/* document.featurePolicy.features() in Chromium 156.0.8078.4. Chromium logs "Error with Permissions-Policy header: Unrecognized
   feature" on every page view for a name outside it. To deny a feature a later Chrome adds, refresh this list from that call. */
const CHROMIUM_FEATURES = new Set([
  'accelerometer', 'aria-notify', 'autoplay', 'bluetooth', 'browsing-topics', 'camera', 'captured-surface-control',
  'ch-device-memory', 'ch-downlink', 'ch-dpr', 'ch-ect', 'ch-prefers-color-scheme', 'ch-prefers-reduced-motion',
  'ch-prefers-reduced-transparency', 'ch-rtt', 'ch-save-data', 'ch-ua', 'ch-ua-arch', 'ch-ua-bitness', 'ch-ua-form-factors',
  'ch-ua-full-version', 'ch-ua-full-version-list', 'ch-ua-high-entropy-values', 'ch-ua-mobile', 'ch-ua-model', 'ch-ua-platform',
  'ch-ua-platform-version', 'ch-ua-wow64', 'ch-viewport-height', 'ch-viewport-width', 'ch-width', 'clipboard-read',
  'clipboard-write', 'compute-pressure', 'cross-origin-isolated', 'deferred-fetch', 'deferred-fetch-minimal',
  'digital-credentials-create', 'digital-credentials-get', 'display-capture', 'encrypted-media', 'fullscreen', 'gamepad',
  'geolocation', 'gyroscope', 'hid', 'identity-credentials-get', 'idle-detection', 'interest-cohort', 'keyboard-map',
  'language-detector', 'language-model', 'local-fonts', 'local-network', 'local-network-access', 'loopback-network',
  'magnetometer', 'media-playback-while-not-visible', 'microphone', 'midi', 'on-device-speech-recognition', 'otp-credentials',
  'payment', 'picture-in-picture', 'private-state-token-issuance', 'private-state-token-redemption',
  'publickey-credentials-create', 'publickey-credentials-get', 'screen-wake-lock', 'serial', 'speaker-selection',
  'storage-access', 'summarizer', 'sync-xhr', 'translator', 'unload', 'usb', 'window-management', 'xr-spatial-tracking',
]);

describe('Permissions-Policy', () => {
  /* Each entry is feature=* or feature=(allowlist), and the allowlist holds self and quoted origins; () denies the feature. */
  const entries = header('/', 'Permissions-Policy').split(/,\s*/).map((p) => {
    const m = /^([a-z0-9-]+)=(?:(\*)|\(([^()]*)\))$/.exec(p);
    if (!m) throw new Error(`cannot read the Permissions-Policy entry ${p}`);
    return [m[1]!, m[2] ? ['*'] : m[3]!.split(/\s+/).filter(Boolean)] as const;
  });
  const policy = new Map(entries);

  it('names each feature once', () => {
    expect(policy.size, 'a repeated feature keeps only its last allowlist').toBe(entries.length);
  });

  it.each(['camera', 'microphone', 'geolocation', 'usb', 'serial', 'hid', 'bluetooth', 'browsing-topics'])('denies %s', (feature) => {
    expect(policy.get(feature)).toEqual([]);
  });

  /* Turnstile's api.js delegates these to its widget iframe through allow="…", and Cloudflare challenges redeem private state tokens. */
  it.each([
    'cross-origin-isolated', 'fullscreen', 'autoplay', 'keyboard-map', 'gamepad', 'xr-spatial-tracking',
    'private-token', 'private-state-token-issuance', 'private-state-token-redemption',
  ])('leaves %s, which Turnstile uses, unrestricted', (feature) => {
    expect(policy.has(feature)).toBe(false);
  });

  /* A frame gets a feature only when its parent document has that feature for its own origin, so the allowlist needs self:
     payment=("https://app.cal.com" "https://cal.com") left allowsFeature('payment') false inside the Cal frame (Chromium 156). */
  it('lets the Cal.com embed keep payment, which embed.js delegates to its iframe with allow="payment"', () => {
    const payment = policy.get('payment');
    if (payment === undefined || payment.includes('*')) return;
    expect(payment).toContain('self');
    for (const cal of CAL_ORIGINS) expect(payment).toContain(`"${cal}"`);
  });

  it('names only features Chromium recognises', () => {
    for (const feature of policy.keys()) expect(CHROMIUM_FEATURES.has(feature), `${feature} is not a Chromium 156 feature`).toBe(true);
  });

  it('names no FLoC interest-cohort', () => {
    // Chromium 156 still parses interest-cohort, but FLoC is gone and the name gates nothing; browsing-topics replaced it.
    expect(policy.has('interest-cohort')).toBe(false);
  });
});

describe('Cache-Control', () => {
  it.each(['/assets/hero.mp4', '/assets/hero-poster.webp', '/assets/favicon.svg'])('caches %s for a year as immutable', (path) => {
    expect(header(path, 'Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it.each(['/css/site.css', '/js/form.js'])('still makes browsers revalidate %s', (path) => {
    expect(header(path, 'Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });
});
