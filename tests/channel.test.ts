import { describe, expect, it } from 'vitest';
import { classifyChannel, type Channel, type ChannelInput } from '../lib/channel.js';

const ch = (lead: ChannelInput): Channel => classifyChannel(lead);

describe('rule 1: paid', () => {
  it.each([
    'cpc', 'ppc', 'paid', 'paid_social', 'paidsocial', 'display', 'ads', 'ad',
    // GA4's rule: anything containing cp, retargeting, or starting with paid.
    'cpm', 'cpv', 'cpa', 'cpe', 'CPM', 'retargeting', 'paid_media', 'paid-search', 'paidsearch',
    'sponsored', 'pmax', 'social_paid', 'social-paid',
  ])('utm_medium=%s is paid, Paid (other) with no known source', (utmMedium) => {
    expect(ch({ utmMedium })).toBe('Paid (other)');
    expect(ch({ utmMedium, utmSource: 'newsletter-network' })).toBe('Paid (other)');
  });

  it('spaces, hyphens, underscores and case in utm_medium do not matter', () => {
    for (const utmMedium of ['Paid Social', 'paid-social', 'PAID_SOCIAL', '  paid   social ', 'Paid-_Social', 'Social Paid']) {
      expect(ch({ utmMedium }), utmMedium).toBe('Paid (other)');
    }
  });

  it.each(['organic', 'email', 'social', 'organic_social', 'referral', 'newsletter', 'banner', 'affiliate'])('utm_medium=%s is not paid', (utmMedium) => {
    expect(ch({ utmMedium, utmSource: 'newsletter-network' })).not.toBe('Paid (other)');
  });

  it('picks the platform from utm_source', () => {
    for (const utmSource of ['google', 'adwords', 'googleads', 'google_ads', 'Google Ads', 'google-ads', 'GOOGLE_ADS']) {
      expect(ch({ utmMedium: 'cpc', utmSource }), utmSource).toBe('Google Ads');
    }
    for (const utmSource of ['x', 'twitter']) expect(ch({ utmMedium: 'paid_social', utmSource })).toBe('X Ads');
    for (const utmSource of ['linkedin', 'lnkd']) expect(ch({ utmMedium: 'paid_social', utmSource })).toBe('LinkedIn Ads');
    for (const utmSource of ['facebook', 'fb', 'instagram', 'ig', 'meta']) expect(ch({ utmMedium: 'paid_social', utmSource })).toBe('Meta Ads');
  });

  it.each(['paid-social', 'Paid Social', 'cpm', 'paid_media', 'paid_social', 'cpc'])('facebook + %s is Meta Ads, with or without an fbclid', (utmMedium) => {
    expect(ch({ utmSource: 'facebook', utmMedium })).toBe('Meta Ads');
    expect(ch({ utmSource: 'facebook', utmMedium, fbclid: 'F1' })).toBe('Meta Ads');
    expect(ch({ utmSource: 'Instagram', utmMedium, fbclid: 'F1' })).toBe('Meta Ads');
  });

  it('linkedin + sponsored is LinkedIn Ads; google + pmax is Google Ads', () => {
    expect(ch({ utmSource: 'linkedin', utmMedium: 'sponsored' })).toBe('LinkedIn Ads');
    expect(ch({ utmSource: 'LinkedIn', utmMedium: 'Sponsored' })).toBe('LinkedIn Ads');
    expect(ch({ utmSource: 'google', utmMedium: 'pmax' })).toBe('Google Ads');
  });

  it('a click id alone is paid, with no utm at all', () => {
    expect(ch({ gclid: 'G1' })).toBe('Google Ads');
    expect(ch({ twclid: 'T1' })).toBe('X Ads');
    expect(ch({ liFatId: 'L1' })).toBe('LinkedIn Ads');
  });

  it('gbraid and wbraid (Google Ads iOS click ids) are Google Ads, alone or with other signals', () => {
    expect(ch({ gbraid: 'GB1' })).toBe('Google Ads');
    expect(ch({ wbraid: 'WB1' })).toBe('Google Ads');
    expect(ch({ gbraid: 'GB1', utmMedium: 'email', referrer: 'https://www.reddit.com/r/x' })).toBe('Google Ads');
    expect(ch({ wbraid: 'WB1', utmSource: 'facebook', utmMedium: 'organic' })).toBe('Google Ads');
    expect(ch({ gbraid: 'GB1', twclid: 'T1', liFatId: 'L1', fbclid: 'F1' })).toBe('Google Ads');
    expect(ch({ gbraid: ' ', wbraid: '' })).toBe('Direct');
  });

  it('a click id wins over an organic medium and over a referrer', () => {
    expect(ch({ gclid: 'G1', utmMedium: 'email', referrer: 'https://www.reddit.com/r/x' })).toBe('Google Ads');
    expect(ch({ liFatId: 'L1', utmMedium: 'social' })).toBe('LinkedIn Ads');
  });

  it('fbclid beside a paid medium is Meta Ads, even without a Meta utm_source', () => {
    expect(ch({ fbclid: 'F1', utmMedium: 'cpc' })).toBe('Meta Ads');
    expect(ch({ fbclid: 'F1', utmMedium: 'paid_social', utmSource: 'facebook' })).toBe('Meta Ads');
  });

  it('a paid medium with another platform source and an fbclid follows the source', () => {
    expect(ch({ fbclid: 'F1', utmMedium: 'cpc', utmSource: 'google' })).toBe('Google Ads');
  });

  it('when signals disagree the order is Google, X, LinkedIn, Meta', () => {
    expect(ch({ gclid: 'G1', twclid: 'T1', liFatId: 'L1', fbclid: 'F1' })).toBe('Google Ads');
    expect(ch({ twclid: 'T1', liFatId: 'L1', utmSource: 'facebook', utmMedium: 'cpc' })).toBe('X Ads');
    expect(ch({ liFatId: 'L1', utmSource: 'facebook', utmMedium: 'cpc' })).toBe('LinkedIn Ads');
    expect(ch({ gclid: 'G1', utmSource: 'facebook', utmMedium: 'paid_social' })).toBe('Google Ads');
  });

  it('a click id that is only whitespace does not make a lead paid', () => {
    expect(ch({ gclid: '  ', twclid: '', liFatId: ' ' })).toBe('Direct');
  });

  it('a paid utm_source with an unpaid medium is not paid', () => {
    expect(ch({ utmSource: 'google', utmMedium: 'organic' })).toBe('Organic Search');
    expect(ch({ utmSource: 'facebook' })).toBe('Organic Social');
    expect(ch({ utmSource: 'google' })).toBe('Referral');
  });
});

describe('fbclid without a paid medium', () => {
  it('is Organic Social, not paid (Meta adds it to organic link clicks)', () => {
    expect(ch({ fbclid: 'F1' })).toBe('Organic Social');
    expect(ch({ fbclid: 'F1', utmSource: 'facebook' })).toBe('Organic Social');
    expect(ch({ fbclid: 'F1', referrer: 'https://l.facebook.com/' })).toBe('Organic Social');
  });

  it('still counts as Organic Social when the referrer is something else', () => {
    expect(ch({ fbclid: 'F1', referrer: 'https://example.org/post' })).toBe('Organic Social');
    expect(ch({ fbclid: 'F1', referrer: 'not a url' })).toBe('Organic Social');
  });

  it('an email or social utm_medium still decides first', () => {
    expect(ch({ fbclid: 'F1', utmMedium: 'email' })).toBe('Email');
    expect(ch({ fbclid: 'F1', utmMedium: 'social' })).toBe('Organic Social');
  });
});

describe('rule 2: email', () => {
  it('utm_medium=email', () => {
    expect(ch({ utmMedium: 'email' })).toBe('Email');
    expect(ch({ utmMedium: 'email', utmSource: 'newsletter' })).toBe('Email');
  });

  it.each(['email', 'newsletter', 'mailchimp', 'zoho_campaigns', 'Zoho Campaigns', 'zoho-campaigns', 'MailChimp'])('utm_source=%s is Email', (utmSource) => {
    expect(ch({ utmSource })).toBe('Email');
  });

  it.each(['dailymail', 'hotmail', 'gmail', 'Sendgrid-mail', 'mailer', 'email-marketing-network'])('a utm_source that merely contains "mail" (%s) is not Email', (utmSource) => {
    expect(ch({ utmSource })).toBe('Referral');
  });

  it('a paid medium still wins over a mail source', () => {
    expect(ch({ utmMedium: 'cpc', utmSource: 'mailchimp' })).toBe('Paid (other)');
  });
});

describe('rule 3: organic social medium', () => {
  it.each(['social', 'organic_social'])('utm_medium=%s', (utmMedium) => {
    expect(ch({ utmMedium })).toBe('Organic Social');
    expect(ch({ utmMedium, utmSource: 'linkedin' })).toBe('Organic Social');
  });
});

describe('rule 4: referrer', () => {
  it.each([
    'https://www.google.com/',
    'https://www.google.co.in/search?q=x',
    'https://google.com.au/',
    'https://www.bing.com/search?q=x',
    'https://duckduckgo.com/',
    'https://search.yahoo.com/search',
    'https://in.search.yahoo.com/',
    'https://yandex.ru/',
    'https://www.ecosia.org/',
  ])('search engine %s -> Organic Search', (referrer) => {
    expect(ch({ referrer })).toBe('Organic Search');
  });

  it.each([
    'https://t.co/abc',
    'https://x.com/someone',
    'https://twitter.com/someone',
    'https://www.facebook.com/',
    'https://m.facebook.com/',
    'https://l.facebook.com/l.php?u=x',
    'https://www.instagram.com/',
    'https://l.instagram.com/?u=x',
    'https://www.linkedin.com/feed/',
    'https://lnkd.in/abc',
    'https://www.youtube.com/watch?v=1',
    'https://api.whatsapp.com/send',
    'https://wa.me/123',
    'https://www.reddit.com/r/x',
  ])('social site %s -> Organic Social', (referrer) => {
    expect(ch({ referrer })).toBe('Organic Social');
  });

  it.each(['https://mail.google.com/mail/u/0/', 'https://outlook.live.com/mail/0/', 'https://mail.yahoo.com/d/folders/1', 'https://MAIL.GOOGLE.COM/'])('webmail %s -> Email', (referrer) => {
    expect(ch({ referrer })).toBe('Email');
  });

  it.each([
    'https://www.googleadservices.com/pagead/aclk?x=1',
    'https://googleadservices.com/',
    'https://tpc.googlesyndication.com/safeframe',
    'https://pagead2.googlesyndication.com/',
    'https://ad.doubleclick.net/ddm/clk',
    'https://googleads.g.doubleclick.net/',
  ])('Google ad network %s -> Google Ads', (referrer) => {
    expect(ch({ referrer })).toBe('Google Ads');
  });

  it.each([
    'https://docs.google.com/document/d/1',
    'https://drive.google.com/',
    'https://sites.google.com/view/x',
    'https://news.google.com/',
    'https://play.google.com/store',
    'https://login.yahoo.com/',
    'https://www.yahoo.com/',
    'https://mail.yandex.ru/',
  ])('%s is a Referral, not a search engine', (referrer) => {
    expect(ch({ referrer })).toBe('Referral');
  });

  it.each([
    ['android-app://com.google.android.gm', 'Email'],
    ['android-app://com.google.android.gm/', 'Email'],
    ['android-app://com.google.android.googlequicksearchbox', 'Organic Search'],
    ['android-app://com.google.android.googlequicksearchbox/https/www.google.com', 'Organic Search'],
    ['android-app://com.linkedin.android', 'Organic Social'],
    ['android-app://com.twitter.android', 'Organic Social'],
    ['android-app://com.instagram.android', 'Organic Social'],
    ['android-app://com.facebook.katana', 'Organic Social'],
    ['android-app://com.whatsapp', 'Organic Social'],
    ['ANDROID-APP://COM.WHATSAPP', 'Organic Social'],
    ['android-app://com.example.reader', 'Referral'],
    ['android-app://org.telegram.messenger', 'Referral'],
  ])('%s -> %s', (referrer, channel) => {
    expect(ch({ referrer })).toBe(channel);
  });

  it('any other site is a Referral', () => {
    expect(ch({ referrer: 'https://news.ycombinator.com/item?id=1' })).toBe('Referral');
    expect(ch({ referrer: 'https://partner.example/blog' })).toBe('Referral');
  });

  it('does not match a lookalike host or a domain that merely contains the name', () => {
    expect(ch({ referrer: 'https://notgoogle.com/' })).toBe('Referral');
    expect(ch({ referrer: 'https://google.evil.example/' })).toBe('Referral');
    expect(ch({ referrer: 'https://facebook.com.evil.example/' })).toBe('Referral');
    expect(ch({ referrer: 'https://nott.co/' })).toBe('Referral');
  });

  it('the site itself is ignored: Direct, from the fixed host or from the landing URL', () => {
    expect(ch({ referrer: 'https://consulting.tridha.net/book' })).toBe('Direct');
    expect(ch({ referrer: 'https://www.consulting.tridha.net/' })).toBe('Direct');
    expect(ch({ referrer: 'https://preview-abc.vercel.app/', landingUrl: 'https://preview-abc.vercel.app/?x=1' })).toBe('Direct');
    expect(ch({ referrer: 'https://preview-abc.vercel.app/', landingUrl: 'https://other.example/' })).toBe('Referral');
  });

  it('an own-site referrer does not hide an organic or paid signal', () => {
    expect(ch({ referrer: 'https://consulting.tridha.net/', gclid: 'G1' })).toBe('Google Ads');
    expect(ch({ referrer: 'https://consulting.tridha.net/', utmMedium: 'email' })).toBe('Email');
  });

  it('utm_source=google with utm_medium=organic is Organic Search, whatever the referrer', () => {
    expect(ch({ utmSource: 'google', utmMedium: 'organic', referrer: 'https://www.google.com/' })).toBe('Organic Search');
    expect(ch({ utmSource: 'google', utmMedium: 'organic', referrer: 'https://partner.example/' })).toBe('Organic Search');
    expect(ch({ utmSource: 'google', utmMedium: 'organic' })).toBe('Organic Search');
    for (const utmSource of ['Bing', 'duckduckgo', 'yahoo', 'yandex', 'ecosia']) expect(ch({ utmSource, utmMedium: 'Organic' }), utmSource).toBe('Organic Search');
  });

  it('a search-engine utm_source without medium organic is not Organic Search on its own', () => {
    expect(ch({ utmSource: 'bing', utmMedium: 'banner' })).toBe('Referral');
    expect(ch({ utmSource: 'bing', utmMedium: 'banner', referrer: 'https://www.bing.com/' })).toBe('Organic Search');
  });

  it('a utm_source that is a social network, with no paid medium, is Organic Social', () => {
    for (const utmSource of ['facebook', 'Instagram', 'meta', 'x', 'twitter', 'LinkedIn', 'lnkd', 'youtube', 'whatsapp', 'reddit']) {
      expect(ch({ utmSource }), utmSource).toBe('Organic Social');
      expect(ch({ utmSource, utmMedium: 'bio-link', referrer: 'https://partner.example/' }), utmSource).toBe('Organic Social');
    }
  });

  it('tagged traffic is never Direct: any other utm_source is a Referral unless another rule applies', () => {
    expect(ch({ utmSource: 'partner-newsletter-x' })).toBe('Referral');
    expect(ch({ utmSource: 'partner', utmMedium: 'banner-swap' })).toBe('Referral');
    expect(ch({ utmSource: 'partner', referrer: 'https://consulting.tridha.net/' })).toBe('Referral');
    expect(ch({ utmSource: 'partner', referrer: 'https://partner.example/' })).toBe('Referral');
    expect(ch({ utmSource: 'partner', referrer: 'https://www.google.com/' })).toBe('Organic Search');
    expect(ch({ utmSource: '   ' })).toBe('Direct');
  });

  it('is not case sensitive, and ignores surrounding space', () => {
    expect(ch({ referrer: 'HTTPS://WWW.GOOGLE.COM/' })).toBe('Organic Search');
    expect(ch({ referrer: '  https://T.CO/x  ' })).toBe('Organic Social');
  });

  it('a malformed or non-web referrer counts as no referrer', () => {
    for (const referrer of ['not a url', 'google.com', '://x', 'http://', 'android-app://', 'javascript:alert(1)', 'about:blank', '   ']) {
      expect(ch({ referrer }), referrer).toBe('Direct');
    }
  });
});

describe('rule 5: direct, and case handling', () => {
  it('no attribution at all is Direct', () => {
    expect(ch({})).toBe('Direct');
    expect(ch({ referrer: '', landingUrl: '', utmSource: '', utmMedium: '' })).toBe('Direct');
  });

  it('utm values are matched ignoring case and surrounding space', () => {
    expect(ch({ utmMedium: ' CPC ', utmSource: 'GoogleAds' })).toBe('Google Ads');
    expect(ch({ utmMedium: 'Paid_Social', utmSource: 'LinkedIn' })).toBe('LinkedIn Ads');
    expect(ch({ utmMedium: 'EMAIL' })).toBe('Email');
    expect(ch({ utmMedium: 'Social' })).toBe('Organic Social');
    expect(ch({ utmMedium: 'Paid_Social', utmSource: 'FB' })).toBe('Meta Ads');
    expect(ch({ utmMedium: 'Paid_Social', utmSource: 'X' })).toBe('X Ads');
  });

  it('an unrecognised utm_medium does not stop the referrer rules', () => {
    expect(ch({ utmMedium: 'banner-swap', referrer: 'https://www.google.com/' })).toBe('Organic Search');
  });
});
