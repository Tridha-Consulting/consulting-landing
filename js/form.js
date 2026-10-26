/* Lead form: modal, 3 client-side steps, one POST to /api/lead. Never navigates. */
(function () {
  'use strict';

  var CFG = window.TRIDHA_CONFIG || {};
  var ENDPOINT = '/api/lead';
  var ATTR_KEY = 'tridha_attribution';
  var ATTR_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'li_fat_id'];

  /* Same rule names as lib/schema.ts (fullName, email, phone, attribution).
     email.pattern is a copy of zod's email regex used by lib/schema.ts (z.regexes.email); the server
     is the contract, so any change must be made there first. tests/client-parity.test.ts enforces it. */
  var RULES = {
    fullName: { min: 1, max: 120 },
    email: { max: 254, pattern: /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/ },
    phone: { minDigits: 6, maxDigits: 15 },
    attribution: { max: 500 }
  };

  var COUNTRIES = [
    ['India', '91'], ['United States / Canada', '1'], ['United Kingdom', '44'], ['United Arab Emirates', '971'],
    ['Singapore', '65'], ['Australia', '61'], ['Saudi Arabia', '966'], ['Qatar', '974'], ['Kuwait', '965'],
    ['Bahrain', '973'], ['Oman', '968'], ['Germany', '49'], ['France', '33'], ['Netherlands', '31'],
    ['Switzerland', '41'], ['Italy', '39'], ['Spain', '34'], ['Ireland', '353'], ['Malaysia', '60'],
    ['Hong Kong', '852'], ['Japan', '81'], ['China', '86'], ['Indonesia', '62'], ['Thailand', '66'],
    ['New Zealand', '64'], ['South Africa', '27'], ['Nigeria', '234'], ['Kenya', '254'],
    ['Bangladesh', '880'], ['Sri Lanka', '94'], ['Nepal', '977'], ['Pakistan', '92']
  ];

  /* ---------- storage (every call guarded) ---------- */
  var memAttr = null;
  function storeGet() {
    try { return window.sessionStorage.getItem(ATTR_KEY); } catch (e) { return null; }
  }
  function storeSet(v) {
    try { window.sessionStorage.setItem(ATTR_KEY, v); } catch (e) { /* ignore */ }
  }

  function clip(v) { return String(v == null ? '' : v).slice(0, RULES.attribution.max); }

  /* A URL carrying any campaign/click id replaces what is stored (an ad click after an organic
     visit in the same tab must win). Otherwise the stored record is kept; capture fresh if none. */
  function captureAttribution() {
    var out = {}, carriesCampaign = false;
    try {
      var q = new URLSearchParams(window.location.search);
      ATTR_PARAMS.forEach(function (k) { var v = q.get(k); if (v) { out[k] = clip(v); carriesCampaign = true; } });
    } catch (e) { /* ignore */ }
    if (!carriesCampaign) {
      var existing = storeGet();
      if (existing) {
        try { memAttr = JSON.parse(existing); return; } catch (e) { /* recapture below */ }
      }
    }
    try { out.referrer = clip(document.referrer); } catch (e) { out.referrer = ''; }
    try { out.landing_url = clip(window.location.href); } catch (e) { out.landing_url = ''; }
    memAttr = out;
    storeSet(JSON.stringify(out));
  }

  function attributionPayload() {
    var a = memAttr || {};
    return {
      utmSource: a.utm_source, utmMedium: a.utm_medium, utmCampaign: a.utm_campaign,
      utmContent: a.utm_content, utmTerm: a.utm_term, fbclid: a.fbclid, gclid: a.gclid,
      liFatId: a.li_fat_id, referrer: a.referrer, landingUrl: a.landing_url
    };
  }

  /* ---------- validation ---------- */
  function digitsOnly(s) { return String(s).replace(/\D/g, ''); }

  /* One leading trunk 0 is dropped for every country except Italy (+39), whose numbers keep it.
     Counterpart: normalisePhone in lib/schema.ts. */
  function nationalDigits(dial, value) {
    var n = digitsOnly(value);
    return dial === '39' ? n : n.replace(/^0/, '');
  }

  function validate(field, value, dial) {
    var v = String(value || '').trim();
    if (field === 'fullName') {
      if (v.length < RULES.fullName.min) return 'Please enter your full name.';
      if (v.length > RULES.fullName.max) return 'Name is too long.';
    } else if (field === 'email') {
      if (!v) return 'Please enter your email address.';
      if (v.length > RULES.email.max || !RULES.email.pattern.test(v)) return 'Please enter a valid email address.';
    } else if (field === 'phone') {
      var national = nationalDigits(dial, v);
      if (!national) return 'Please enter your phone number.';
      var total = (dial + national).length;
      if (total < RULES.phone.minDigits || total > RULES.phone.maxDigits || national.length < 4) {
        return 'Please enter a valid phone number.';
      }
    }
    return '';
  }

  function normalisePhone(dial, value) { return '+' + dial + nationalDigits(dial, value); }

  /* ---------- DOM helpers ---------- */
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  /* ---------- modal state ---------- */
  var overlay, card, form, closeBtn, nextBtn, backBtn, submitErr, lastTrigger, root;
  var inputs = {}, errs = {}, steps = [], stepIndex = 0, busy = false, sent = false;
  var tsToken = '', tsLoaded = false, tsWidgetId = null;
  var FIELD_ORDER = ['fullName', 'email', 'phone'];

  function build() {
    var uid = 'trd-' + Math.random().toString(36).slice(2, 7);

    function field(name, label, input, control) {
      var err = el('div', { class: 'trd-error', id: uid + '-' + name + '-err', 'aria-live': 'polite' });
      errs[name] = err;
      inputs[name] = input;
      input.setAttribute('aria-describedby', err.id);
      return el('div', { class: 'trd-step' }, [
        el('label', { class: 'trd-label', for: input.id, text: label }), control || input, err
      ]);
    }

    var name = el('input', { class: 'trd-input', id: uid + '-name', type: 'text', name: 'fullName', autocomplete: 'name', placeholder: 'Enter your full name', required: '', maxlength: String(RULES.fullName.max) });
    var email = el('input', { class: 'trd-input', id: uid + '-email', type: 'email', name: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'your@email.com', required: '' });
    var sel = el('select', { class: 'trd-select', id: uid + '-dial', 'aria-label': 'Country code' });
    COUNTRIES.forEach(function (c) { sel.appendChild(el('option', { value: c[1], text: c[0] + ' (+' + c[1] + ')' })); });
    sel.value = '91';
    var tel = el('input', { class: 'trd-input', id: uid + '-phone', type: 'tel', name: 'phone', autocomplete: 'tel-national', inputmode: 'tel', placeholder: 'Phone number', required: '' });
    inputs.dial = sel;

    var s1 = field('fullName', 'Full Name *', name);
    var s2 = field('email', 'Email *', email);
    var s3 = field('phone', 'Phone *', tel, el('div', { class: 'trd-phone' }, [sel, tel]));
    s3.appendChild(el('div', { class: 'trd-ts' }));
    steps = [s1, s2, s3];

    var hp = el('div', { class: 'trd-hp', 'aria-hidden': 'true' }, [
      el('input', { type: 'text', name: 'company_website', tabindex: '-1', autocomplete: 'off' })
    ]);
    inputs.hp = hp.firstChild;

    submitErr = el('div', { class: 'trd-submit-error', role: 'alert' });
    backBtn = el('button', { type: 'button', class: 'trd-btn trd-btn-back', text: '← Back' });
    nextBtn = el('button', { type: 'submit', class: 'trd-btn', text: 'Next →' });
    var actions = el('div', { class: 'trd-actions' }, [backBtn, el('span', { class: 'trd-spacer' }), nextBtn]);

    form = el('form', { novalidate: '', autocomplete: 'on' }, [s1, s2, s3, hp, submitErr, actions]);
    closeBtn = el('button', { type: 'button', class: 'trd-close', 'aria-label': 'Close', text: '×' });
    var title = el('h2', { id: uid + '-title', class: 'trd-hp', text: 'Book a free call' });
    card = el('div', { class: 'trd-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title.id }, [title, closeBtn, form]);
    overlay = el('div', { class: 'trd-overlay' }, [card]);
    document.body.appendChild(overlay);

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    backBtn.addEventListener('click', function () { if (!busy && stepIndex > 0) showStep(stepIndex - 1); });
    form.addEventListener('submit', onSubmit);
    FIELD_ORDER.forEach(function (k) {
      inputs[k].addEventListener('input', function () { setError(k, ''); submitErr.textContent = ''; });
    });
    overlay.addEventListener('keydown', trapTab);
    showStep(0, true);
  }

  function setError(k, msg) {
    errs[k].textContent = msg;
    if (msg) inputs[k].setAttribute('aria-invalid', 'true'); else inputs[k].removeAttribute('aria-invalid');
  }

  function showStep(i, noFocus) {
    stepIndex = i;
    steps.forEach(function (s, n) { s.classList.toggle('is-active', n === i); });
    backBtn.style.visibility = i === 0 ? 'hidden' : 'visible';
    var last = i === steps.length - 1;
    nextBtn.textContent = last ? 'Submit' : 'Next →';
    submitErr.textContent = '';
    if (last) ensureTurnstile();
    if (!noFocus) focusStep();
  }

  function focusStep() {
    var f = inputs[FIELD_ORDER[stepIndex]];
    if (f) f.focus();
  }

  function stepValid(i) {
    var k = FIELD_ORDER[i];
    var msg = validate(k, inputs[k].value, inputs.dial.value);
    setError(k, msg);
    if (msg) inputs[k].focus();
    return !msg;
  }

  function onSubmit(e) {
    e.preventDefault();
    if (busy || sent) return;
    if (!stepValid(stepIndex)) return;
    if (stepIndex < steps.length - 1) { showStep(stepIndex + 1); return; }
    for (var i = 0; i < steps.length - 1; i++) {
      if (!stepValid(i)) { showStep(i); return; }
    }
    send();
  }

  /* ---------- Turnstile (only when a site key is configured) ---------- */
  function ensureTurnstile() {
    if (!CFG.TURNSTILE_SITE_KEY || tsLoaded) return;
    tsLoaded = true;
    window.__trdTsReady = function () {
      try {
        tsWidgetId = window.turnstile.render(card.querySelector('.trd-ts'), {
          sitekey: CFG.TURNSTILE_SITE_KEY,
          appearance: 'interaction-only',
          callback: function (t) { tsToken = t; },
          'expired-callback': function () { tsToken = ''; },
          'error-callback': function () { tsToken = ''; }
        });
      } catch (e) { /* server decides */ }
    };
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__trdTsReady';
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }

  function waitForToken(ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function poll() {
        if (tsToken || Date.now() - t0 > ms) resolve(tsToken);
        else setTimeout(poll, 150);
      })();
    });
  }

  /* ---------- submit ---------- */
  function fail() {
    busy = false;
    nextBtn.disabled = false;
    nextBtn.textContent = 'Submit';
    submitErr.textContent = '';
    submitErr.appendChild(document.createTextNode('Sorry, something went wrong and your details were not sent. Please try again, or contact us at '));
    var c = CFG.FALLBACK_CONTACT || '';
    if (/@/.test(c)) submitErr.appendChild(el('a', { href: 'mailto:' + c, text: c }));
    else submitErr.appendChild(document.createTextNode(c));
    submitErr.appendChild(document.createTextNode('.'));
    if (tsWidgetId !== null && window.turnstile) {
      try { window.turnstile.reset(tsWidgetId); tsToken = ''; } catch (e) { /* ignore */ }
    }
  }

  function send() {
    busy = true;
    nextBtn.disabled = true;
    nextBtn.textContent = '';
    nextBtn.appendChild(el('span', { class: 'trd-spinner', 'aria-hidden': 'true' }));
    nextBtn.appendChild(document.createTextNode('Submitting'));
    submitErr.textContent = '';

    var pre = CFG.TURNSTILE_SITE_KEY ? waitForToken(8000) : Promise.resolve('');
    pre.then(function (token) {
      var body = attributionPayload();
      body.fullName = inputs.fullName.value.trim();
      body.email = inputs.email.value.trim();
      body.phone = normalisePhone(inputs.dial.value, inputs.phone.value);
      body.company_website = inputs.hp.value;
      if (token) body.turnstileToken = token;
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin'
      });
    }).then(function (res) {
      if (res.ok) { success(); return; }
      if (res.status === 400) {
        return res.json().then(function (data) {
          if (!showServerFieldErrors(data)) throw new Error('HTTP 400');
        });
      }
      throw new Error('HTTP ' + res.status);
    }).catch(fail);
  }

  /* Server validation_failed: put each message on its field and jump to the first affected step.
     Returns false when nothing maps to a visible field, so the caller falls back to the generic error. */
  function showServerFieldErrors(data) {
    var fields = data && data.error === 'validation_failed' && data.fields;
    if (!fields) return false;
    var first = -1;
    FIELD_ORDER.forEach(function (k, i) {
      var msgs = fields[k];
      if (msgs && msgs.length) {
        setError(k, String(msgs[0]));
        if (first === -1) first = i;
      }
    });
    if (first === -1) return false;
    busy = false;
    nextBtn.disabled = false;
    if (tsWidgetId !== null && window.turnstile) {
      try { window.turnstile.reset(tsWidgetId); tsToken = ''; } catch (e) { /* ignore */ }
    }
    showStep(first);
    return true;
  }

  function success() {
    sent = true;
    busy = false;
    var msg = el('div', { class: 'trd-thanks', role: 'status', tabindex: '-1', text: CFG.THANK_YOU_TEXT || 'Thank you.' });
    card.removeChild(form);
    card.appendChild(msg);
    msg.focus();
    try { if (window.track && window.track.lead) window.track.lead(); } catch (e) { /* tracking must never break the flow */ }
  }

  /* ---------- open / close / focus trap ---------- */
  /* Tabbable elements inside the modal, recomputed on every Tab because steps and the
     thank-you state swap content. The trap is bound to the overlay, which is never replaced. */
  function focusables() {
    return Array.prototype.filter.call(
      overlay.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled])'),
      function (n) { return n.getClientRects().length > 0 && window.getComputedStyle(n).visibility !== 'hidden'; }
    );
  }

  function trapTab(e) {
    if (e.key !== 'Tab') return;
    var f = focusables();
    if (!f.length) { e.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1], a = document.activeElement;
    var i = f.indexOf(a);
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (i === -1 || a === last)) { e.preventDefault(); first.focus(); }
  }

  function open(trigger) {
    if (!overlay) build();
    lastTrigger = trigger || document.activeElement;
    overlay.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    if (root) root.setAttribute('inert', '');
    if (sent) { var t = card.querySelector('.trd-thanks'); if (t) t.focus(); }
    else focusStep();
  }

  function close() {
    if (!overlay || !overlay.classList.contains('is-open')) return;
    overlay.classList.remove('is-open');
    document.body.style.overflow = '';
    if (root) root.removeAttribute('inert');
    if (lastTrigger && lastTrigger.focus) lastTrigger.focus();
  }

  function init() {
    captureAttribution();
    root = document.querySelector('.trd-lp');
    Array.prototype.forEach.call(document.querySelectorAll('.trd-book-btn'), function (b) {
      b.setAttribute('role', 'button');
      b.setAttribute('aria-haspopup', 'dialog');
      b.addEventListener('click', function (e) { e.preventDefault(); open(b); });
      b.addEventListener('keydown', function (e) { if (e.key === ' ') { e.preventDefault(); open(b); } });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
