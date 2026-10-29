import type { LeadRow } from './columns.js';

/** The marketing channel a lead came from. Written to the Channel column and to the Events tab. */
export type Channel =
  | 'Google Ads'
  | 'Meta Ads'
  | 'X Ads'
  | 'LinkedIn Ads'
  | 'Paid (other)'
  | 'Organic Search'
  | 'Organic Social'
  | 'Email'
  | 'Referral'
  | 'Direct';

/** The attribution fields the rules read; every one is optional because a row built from a booking alone has none. */
export type ChannelInput = Pick<LeadRow, 'utmSource' | 'utmMedium' | 'fbclid' | 'gclid' | 'gbraid' | 'wbraid' | 'liFatId' | 'twclid' | 'referrer' | 'landingUrl'>;

/** The site's own host: a referrer equal to it is the visitor moving between our pages, not a channel. */
const SITE_HOST = 'consulting.tridha.net';

/**
 * Lower-cased and trimmed, with each run of spaces, hyphens and underscores collapsed to one `_`, so
 * "Paid Social", "paid-social" and "paid_social" are one value.
 */
const norm = (v: string | undefined): string => (v ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '_');

/** GA4's rule for a paid medium (cpc, cpm, cpv, ppc, retargeting, paid*), applied to the normalised medium. */
const GA4_PAID_MEDIUM = /^(.*cp.*|ppc|retargeting|paid.*)$/;
const EXTRA_PAID_MEDIUMS = new Set(['sponsored', 'display', 'ad', 'ads', 'pmax', 'paid_social', 'paidsocial', 'social_paid']);
const SOCIAL_MEDIUMS = new Set(['social', 'organic_social']);

const isPaidMedium = (medium: string): boolean => GA4_PAID_MEDIUM.test(medium) || EXTRA_PAID_MEDIUMS.has(medium);

/** utm_source spellings folded to one platform name (input is already normalised). */
const SOURCE_ALIASES: Readonly<Record<string, string>> = {
  google_ads: 'google', googleads: 'google', adwords: 'google', google: 'google',
  x: 'x', twitter: 'x',
  facebook: 'meta', fb: 'meta', instagram: 'meta', ig: 'meta', meta: 'meta',
  linkedin: 'linkedin', lnkd: 'linkedin',
};
const canonicalSource = (source: string): string => SOURCE_ALIASES[source] ?? source;

const SOCIAL_SOURCES = new Set(['meta', 'x', 'linkedin', 'youtube', 'whatsapp', 'reddit']);
const SEARCH_SOURCES = new Set(['google', 'bing', 'duckduckgo', 'yahoo', 'yandex', 'ecosia']);
// Exact names only: a source that merely contains "mail" (dailymail, hotmail) is not email.
const EMAIL_SOURCES = new Set(['email', 'newsletter', 'mailchimp', 'zoho_campaigns']);

// A web host matches an entry when it is that domain or a subdomain of it (l.facebook.com, in.search.yahoo.com).
const SEARCH_DOMAINS = ['bing.com', 'duckduckgo.com', 'ecosia.org', 'search.yahoo.com'];
// google.com, google.co.in, google.com.au, yandex.ru: the brand itself (no subdomain: mail., docs. and news. are not search) plus a country-style suffix.
const SEARCH_BRAND = /^(?:google|yandex)\.(?:com?\.)?[a-z]{2,3}$/;
const SOCIAL_DOMAINS = [
  't.co', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'lnkd.in',
  'youtube.com', 'whatsapp.com', 'wa.me', 'reddit.com',
];
const EMAIL_DOMAINS = ['mail.google.com', 'outlook.live.com', 'mail.yahoo.com'];
const GOOGLE_ADS_DOMAINS = ['googleadservices.com', 'googlesyndication.com', 'doubleclick.net'];

/** `android-app://<package>` referrers, which the Android apps send in place of a web URL. */
const APP_CHANNELS: Readonly<Record<string, Channel>> = {
  'com.google.android.gm': 'Email',
  'com.google.android.googlequicksearchbox': 'Organic Search',
  'com.linkedin.android': 'Organic Social',
  'com.twitter.android': 'Organic Social',
  'com.instagram.android': 'Organic Social',
  'com.facebook.katana': 'Organic Social',
  'com.whatsapp': 'Organic Social',
};

function onDomain(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

type Referrer = { web: string } | { app: string };

/** An http(s) host without a leading `www.` or an `android-app://` package, lower-cased; undefined for anything else (malformed text, other schemes). */
function parseReferrer(url: string | undefined): Referrer | undefined {
  const text = (url ?? '').trim();
  if (!text) return undefined;
  try {
    const u = new URL(text);
    const host = u.hostname.toLowerCase();
    if (u.protocol === 'android-app:') return host ? { app: host } : undefined;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    const web = host.replace(/^www\./, '');
    return web ? { web } : undefined;
  } catch {
    return undefined;
  }
}

function hostOf(url: string | undefined): string | undefined {
  const r = parseReferrer(url);
  return r && 'web' in r ? r.web : undefined;
}

const has = (v: string | undefined): boolean => Boolean(v?.trim());

function paidChannel(lead: ChannelInput, source: string): Channel {
  if (has(lead.gclid) || has(lead.gbraid) || has(lead.wbraid) || source === 'google') return 'Google Ads';
  if (has(lead.twclid) || source === 'x') return 'X Ads';
  if (has(lead.liFatId) || source === 'linkedin') return 'LinkedIn Ads';
  // fbclid reaches here only beside a paid medium or another click id, where it is the Meta signal.
  if (has(lead.fbclid) || source === 'meta') return 'Meta Ads';
  return 'Paid (other)';
}

function referrerChannel(referrer: string | undefined, landingUrl: string | undefined): Channel {
  const r = parseReferrer(referrer);
  if (!r) return 'Direct';
  if ('app' in r) return APP_CHANNELS[r.app] ?? 'Referral';
  const host = r.web;
  if (host === SITE_HOST || host === hostOf(landingUrl)) return 'Direct';
  if (onDomain(host, EMAIL_DOMAINS)) return 'Email';
  if (onDomain(host, GOOGLE_ADS_DOMAINS)) return 'Google Ads';
  if (SEARCH_BRAND.test(host) || onDomain(host, SEARCH_DOMAINS)) return 'Organic Search';
  if (onDomain(host, SOCIAL_DOMAINS)) return 'Organic Social';
  return 'Referral';
}

/**
 * Classifies a lead's first-touch attribution into one channel, first matching rule wins:
 * 1. a paid utm_medium (GA4's rule, or sponsored, display, ad, ads, pmax, paid_social, paidsocial,
 *    social_paid) or any click id (gclid, gbraid, wbraid, twclid, li_fat_id) means paid, and the source
 *    picks the platform (Google, X, LinkedIn, Meta in that order when several signals disagree), else
 *    Paid (other);
 * 2. utm_medium email, or a utm_source of exactly email, newsletter, mailchimp or zoho_campaigns, is Email;
 * 3. utm_medium social or organic_social is Organic Social;
 * 4. a bare fbclid is Organic Social, because Meta appends it to organic link clicks too;
 * 5. a utm_source that is a social network is Organic Social, and a search engine with utm_medium
 *    organic is Organic Search;
 * 6. the referrer: webmail, Google ad domains, search engines, social sites, the site's own host
 *    (ignored), any other host as Referral; android-app referrers by package;
 * 7. otherwise Direct, except that a lead carrying any utm_source is Referral: tagged traffic is never Direct.
 * utm_medium and utm_source are matched after lower-casing and folding spaces, hyphens and underscores
 * into one underscore. Pure and total: any field may be missing, mixed-case or malformed.
 */
export function classifyChannel(lead: ChannelInput): Channel {
  const medium = norm(lead.utmMedium);
  const rawSource = norm(lead.utmSource);
  const source = canonicalSource(rawSource);

  if (isPaidMedium(medium) || has(lead.gclid) || has(lead.gbraid) || has(lead.wbraid) || has(lead.twclid) || has(lead.liFatId)) {
    return paidChannel(lead, source);
  }
  if (medium === 'email' || EMAIL_SOURCES.has(source)) return 'Email';
  if (SOCIAL_MEDIUMS.has(medium)) return 'Organic Social';
  if (has(lead.fbclid)) return 'Organic Social';
  if (SOCIAL_SOURCES.has(source)) return 'Organic Social';
  if (SEARCH_SOURCES.has(source) && medium === 'organic') return 'Organic Search';
  const byReferrer = referrerChannel(lead.referrer, lead.landingUrl);
  if (byReferrer === 'Direct' && rawSource) return 'Referral';
  return byReferrer;
}
