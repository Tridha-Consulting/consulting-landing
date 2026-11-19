/* Single place for owner-editable settings. Empty ID = that ad tag is never loaded. */
window.TRIDHA_CONFIG = Object.freeze({
  THANK_YOU_TEXT: 'Thank you \u2014 our team will call you shortly.',
  BOOKED_TEXT: 'You\u2019re booked. Your confirmation and Google Meet link are on their way to your email. If you don’t see them, check the Updates or Promotions tab.',
  FALLBACK_CONTACT: 'contact@tridha.net',
  // DRAFT consent notice (DPDP Act 2023), shown just above the form's Submit button: wording for the owner to approve.
  // Its email address becomes a mailto link. Empty = no notice.
  CONSENT_TEXT: 'By submitting this form, you consent to Tridha using your name, email, phone number and answers to contact you about a consulting call and to schedule it. To book the call, we share your name, email, phone number and company name with Cal.com, our scheduling tool. To withdraw your consent or ask us to delete your details, email consulting@tridha.net.',
  CAL_LINK: 'tridha-consulting/exploration-call', // Cal.com booking link as <user>/<event>. Empty = no booking step, the form ends with the thank-you text
  CAL_ORIGIN: 'https://app.cal.com', // embed host. A self-hosted Cal is a one-line change: set this to its origin, e.g. 'https://cal.example.com'
  TURNSTILE_SITE_KEY: '',
  TAGS_HOSTNAME: 'consulting.tridha.net', // ad tags load only on this host, so local and preview visits never reach the pixels
  META_PIXEL_ID: '',
  GA4_ID: '',                  // e.g. G-XXXXXXXXXX
  GOOGLE_ADS_ID: '',           // e.g. AW-123456789
  GOOGLE_ADS_LEAD_LABEL: '',   // conversion label, e.g. AbC-D_efG-h12
  LINKEDIN_PARTNER_ID: '',
  LINKEDIN_CONVERSION_ID: '',
  X_PIXEL_ID: 're613',         // X (Twitter) base pixel, loaded after window load exactly as on the old page
  X_LEAD_EVENT_ID: 'tw-re613-re62p', // X conversion event id for a lead, e.g. tw-xxxxx-yyyyy. Empty = no lead event
  X_BOOKED_EVENT_ID: 'tw-re613-rjhhw', // X conversion event id for a booked call. Empty = no booking event
});
