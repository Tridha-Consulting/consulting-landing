/* Single place for owner-editable settings. Empty ID = that ad tag is never loaded. */
window.TRIDHA_CONFIG = Object.freeze({
  THANK_YOU_TEXT: 'Thank you \u2014 our team will call you shortly.',
  FALLBACK_CONTACT: 'contact@tridha.net',
  PRIVACY_URL: '',
  TURNSTILE_SITE_KEY: '',
  TAGS_HOSTNAME: 'consulting.tridha.net', // ad tags load only on this host, so local and preview visits never reach the pixels
  META_PIXEL_ID: '',
  GA4_ID: '',                  // e.g. G-XXXXXXXXXX
  GOOGLE_ADS_ID: '',           // e.g. AW-123456789
  GOOGLE_ADS_LEAD_LABEL: '',   // conversion label, e.g. AbC-D_efG-h12
  LINKEDIN_PARTNER_ID: '',
  LINKEDIN_CONVERSION_ID: '',
  X_PIXEL_ID: 're613',         // X (Twitter) base pixel, loaded after window load exactly as on the old page
  X_LEAD_EVENT_ID: '',         // X conversion event id for a lead, e.g. tw-xxxxx-yyyyy. Empty = no lead event
});
