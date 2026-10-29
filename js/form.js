/* Lead form: modal with every question on one scrolling page, one POST to /api/lead. Never navigates. */
(function () {
  'use strict';

  var CFG = window.TRIDHA_CONFIG || {};
  var ENDPOINT = '/api/lead';
  var ATTR_KEY = 'tridha_attribution';
  var ATTR_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'li_fat_id'];

  /* Same rule names as lib/schema.ts (fullName, email, phone, designation, company, website, attribution).
     email.pattern is a copy of zod's email regex used by lib/schema.ts (z.regexes.email); the server
     is the contract, so any change must be made there first. tests/client-parity.test.ts enforces it. */
  var RULES = {
    fullName: { min: 1, max: 120 },
    designation: { min: 1, max: 120 },
    company: { min: 1, max: 120 },
    website: { min: 1, max: 200 },
    email: { max: 254, pattern: /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/ },
    phone: { minDigits: 6, maxDigits: 15 },
    attribution: { max: 500 }
  };

  /* Answer options in display order. Copies of the lists exported by lib/schema.ts, which is the
     contract; tests/client-parity.test.ts compares them string for string. */
  var OPTIONS = {
    revenue: [
      'Upto ₹5 Crores',
      '₹5 Crores – ₹20 Crores',
      '₹20 Crores – ₹50 Crores',
      '₹50 Crores+'
    ],
    budget: [
      'Less than ₹5 Lakhs',
      '₹5 Lakhs – ₹15 Lakhs',
      '₹15 Lakhs – ₹50 Lakhs',
      '₹50 Lakhs+'
    ],
    bottleneck: [
      'High manual labor/payroll costs in operations or customer support',
      'Slow turnaround times (sales follow-ups, client deliverables, manual data entry)',
      'Lack of a senior technical leader (CTO) to guide our tech roadmap',
      "Inefficient internal systems that don't speak to each other"
    ],
    techTeam: [
      'Yes, we have a full dev team.',
      'Yes, but they lack AI expertise/are overwhelmed.',
      'No, we rely entirely on external vendors or manual processes.'
    ],
    timeline: [
      'Immediately (Within the next 15-30 days)',
      'Within the next 2-3 months',
      'Just researching/No immediate timeline'
    ],
    decisionMaker: [
      'Yes, I sign off on budgets.',
      'No'
    ]
  };
  var MAX_BOTTLENECKS = 2;

  /* Question text of each choice group. A group is a fieldset of radios, or of checkboxes for bottleneck. */
  var QUESTIONS = {
    revenue: "What is your company's current annual revenue?",
    budget: 'To implement custom AI or scale your tech infrastructure, what is your approved investment budget for the next 3-6 months?',
    bottleneck: "What is the biggest operational bottleneck currently slowing down your company's growth? (Select up to two)",
    techTeam: 'Do you have an in-house development/tech team?',
    timeline: 'If we identify a clear ROI path to automate your bottlenecks, how soon are you looking to initiate the project?',
    decisionMaker: 'Are you the primary decision-maker for financial investments in your company?'
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

  /* Control characters are dropped: each JSON-escapes to six bytes, so a crafted link could push the
  request body past the server's size cap, and the stored attribution would repeat that on every retry. */
  function clip(v) { return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').slice(0, RULES.attribution.max); }

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
    } else if (field === 'designation') {
      if (v.length < RULES.designation.min) return 'Please enter your designation.';
      if (v.length > RULES.designation.max) return 'Designation is too long.';
    } else if (field === 'company') {
      if (v.length < RULES.company.min) return 'Please enter your company name.';
      if (v.length > RULES.company.max) return 'Company name is too long.';
    } else if (field === 'website') {
      if (v.length < RULES.website.min) return 'Please enter your company website.';
      if (v.length > RULES.website.max) return 'Website is too long.';
    } else if (field === 'email') {
      if (!v) return 'Please enter your email address.';
      if (v.length > RULES.email.max || !RULES.email.pattern.test(v)) return 'Please enter a valid email address.';
    } else if (field === 'phone') {
      var national = nationalDigits(dial, v);
      if (!national) return 'Please enter your phone number.';
      /* India: cheap subset of the server's libphonenumber check (a 10-digit mobile starting 6-9). */
      if (dial === '91' && !/^[6-9]\d{9}$/.test(national)) return 'Please enter a valid 10-digit mobile number.';
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
  var overlay, card, form, closeBtn, submitBtn, submitErr, lastTrigger, root;
  /* inputs[k] is the control that carries aria-invalid (the input, or the fieldset of a choice group);
     choices[k] lists the radios/checkboxes of a group; wraps[k] is the element scrolled into view. */
  var inputs = {}, errs = {}, choices = {}, wraps = {}, busy = false, sent = false, doneEl = null;
  var tsToken = '', tsLoaded = false, tsWidgetId = null;
  var FIELD_ORDER = ['fullName', 'designation', 'phone', 'email', 'company', 'website',
    'revenue', 'budget', 'bottleneck', 'techTeam', 'timeline', 'decisionMaker'];

  function build() {
    var uid = 'trd-' + Math.random().toString(36).slice(2, 7);

    function errorEl(name) {
      var err = el('div', { class: 'trd-error', id: uid + '-' + name + '-err', 'aria-live': 'polite' });
      errs[name] = err;
      return err;
    }

    function field(name, label, input, control) {
      var err = errorEl(name);
      inputs[name] = input;
      input.setAttribute('aria-describedby', err.id);
      wraps[name] = el('div', { class: 'trd-field' }, [
        el('label', { class: 'trd-label', for: input.id, text: label + ' *' }), control || input, err
      ]);
      return wraps[name];
    }

    function textField(name, id, label, attrs) {
      var base = { class: 'trd-input', id: uid + '-' + id, type: 'text', name: name, required: '' };
      Object.keys(attrs).forEach(function (k) { base[k] = attrs[k]; });
      return field(name, label, el('input', base));
    }

    /* One question: a fieldset whose legend is the question and whose options are radios (one answer)
       or checkboxes (bottleneck: one or two). */
    function group(name) {
      var multi = name === 'bottleneck';
      var err = errorEl(name);
      var boxes = [];
      var list = el('div', { class: 'trd-options' });
      OPTIONS[name].forEach(function (text, i) {
        var box = el('input', { class: 'trd-choice', id: uid + '-' + name + '-' + i, type: multi ? 'checkbox' : 'radio', name: name, value: text });
        boxes.push(box);
        list.appendChild(el('label', { class: 'trd-option', for: box.id }, [box, el('span', { class: 'trd-option-text', text: text })]));
      });
      var fs = el('fieldset', { class: 'trd-field trd-group', 'aria-describedby': err.id }, [
        el('legend', { class: 'trd-label', text: QUESTIONS[name] + ' *' }), list, err
      ]);
      if (!multi) { fs.setAttribute('role', 'radiogroup'); fs.setAttribute('aria-required', 'true'); }
      choices[name] = boxes;
      inputs[name] = fs;
      wraps[name] = fs;
      fs.addEventListener('change', function () {
        if (multi) limitBottlenecks();
        setError(name, '');
        submitErr.textContent = '';
      });
      return fs;
    }

    var fullName = textField('fullName', 'name', 'Full Name', { autocomplete: 'name', placeholder: 'Enter your full name', maxlength: String(RULES.fullName.max) });
    var designation = textField('designation', 'designation', 'Designation', { autocomplete: 'organization-title', placeholder: 'Your role, e.g. Founder', maxlength: String(RULES.designation.max) });

    var sel = el('select', { class: 'trd-select', id: uid + '-dial', 'aria-label': 'Country code' });
    COUNTRIES.forEach(function (c) { sel.appendChild(el('option', { value: c[1], text: c[0] + ' (+' + c[1] + ')' })); });
    sel.value = '91';
    var tel = el('input', { class: 'trd-input', id: uid + '-phone', type: 'tel', name: 'phone', autocomplete: 'tel-national', inputmode: 'tel', placeholder: 'Phone number', required: '' });
    inputs.dial = sel;
    var phone = field('phone', 'Phone', tel, el('div', { class: 'trd-phone' }, [sel, tel]));

    var email = field('email', 'Email', el('input', { class: 'trd-input', id: uid + '-email', type: 'email', name: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'your@email.com', required: '' }));
    var company = textField('company', 'company', 'Company Name', { autocomplete: 'organization', placeholder: 'Your company name', maxlength: String(RULES.company.max) });
    var website = textField('website', 'website', 'Company Website', { autocomplete: 'url', inputmode: 'url', autocapitalize: 'none', spellcheck: 'false', placeholder: 'yourcompany.com', maxlength: String(RULES.website.max) });

    /* Honeypot. Its DOM name is deliberately not "company_website": browser autofill would fill a
       field of that name from the visible Company Website and the lead would be dropped as spam.
       The request key is still company_website (see send). */
    var hp = el('div', { class: 'trd-hp', 'aria-hidden': 'true' }, [
      el('input', { type: 'text', name: 'trd_extra', tabindex: '-1', autocomplete: 'off' })
    ]);
    inputs.hp = hp.firstChild;

    submitErr = el('div', { class: 'trd-submit-error', role: 'alert' });
    submitBtn = el('button', { type: 'submit', class: 'trd-btn', text: 'Submit' });
    var actions = el('div', { class: 'trd-actions' }, [el('span', { class: 'trd-spacer' }), submitBtn]);

    form = el('form', { novalidate: '', autocomplete: 'on' }, [
      fullName, designation, phone, email, company, website,
      group('revenue'), group('budget'), group('bottleneck'), group('techTeam'), group('timeline'), group('decisionMaker'),
      el('div', { class: 'trd-ts' }), hp, submitErr, actions
    ]);
    closeBtn = el('button', { type: 'button', class: 'trd-close', 'aria-label': 'Close', text: '×' });
    var title = el('h2', { id: uid + '-title', class: 'trd-hp', text: 'Book a free call' });
    card = el('div', { class: 'trd-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title.id }, [title, closeBtn, form]);
    overlay = el('div', { class: 'trd-overlay' }, [card]);
    document.body.appendChild(overlay);

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    form.addEventListener('submit', onSubmit);
    FIELD_ORDER.forEach(function (k) {
      if (choices[k]) return;
      inputs[k].addEventListener('input', function () { setError(k, ''); submitErr.textContent = ''; if (k === 'email') keptEmail = null; });
    });
    inputs.dial.addEventListener('change', function () { setError('phone', ''); });
    overlay.addEventListener('keydown', trapTab);
  }

  /* "Select up to two": with two ticked, the rest are disabled until one is unticked. */
  function limitBottlenecks() {
    var boxes = choices.bottleneck;
    var full = boxes.filter(function (b) { return b.checked; }).length >= MAX_BOTTLENECKS;
    boxes.forEach(function (b) { b.disabled = full && !b.checked; });
  }

  function setError(k, msg) {
    errs[k].textContent = msg;
    errs[k].classList.remove('is-hint');
    inputs[k].classList.toggle('is-invalid', !!msg);
    if (msg) inputs[k].setAttribute('aria-invalid', 'true'); else inputs[k].removeAttribute('aria-invalid');
  }

  /* Current answer of a field: the trimmed text, the chosen option, or for bottleneck the ticked
     options (in option order). */
  function answer(k) {
    if (!choices[k]) return inputs[k].value.trim();
    var picked = choices[k].filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    return k === 'bottleneck' ? picked : (picked[0] || '');
  }

  function fieldMessage(k) {
    if (k === 'bottleneck') {
      var n = answer(k).length;
      return n < 1 || n > MAX_BOTTLENECKS ? 'Select one or two.' : '';
    }
    if (choices[k]) return answer(k) ? '' : 'Please choose an option.';
    return validate(k, inputs[k].value, inputs.dial.value);
  }

  /* Validates every field, shows every error, and returns the first invalid field (or ''). */
  function validateAll() {
    var first = '';
    FIELD_ORDER.forEach(function (k) {
      var msg = fieldMessage(k);
      setError(k, msg);
      if (msg && !first) first = k;
    });
    return first;
  }

  /* Focuses a field's first control; with scroll, first brings the field to the middle of the view
     (the card scrolls inside the overlay). */
  function focusField(k, scroll) {
    var target = choices[k] ? (choices[k].filter(function (b) { return b.checked; })[0] || choices[k][0]) : inputs[k];
    if (!target) return;
    if (scroll) {
      try { wraps[k].scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
      try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    } else {
      target.focus();
    }
  }

  /* Typo advice for the email field. Returns true when a suggestion was shown (caller must not send).
     The address the user has already been asked about is remembered so submitting again keeps it. */
  var keptEmail = null;
  function emailHintShown() {
    var v = inputs.email.value.trim();
    if (v === keptEmail || typeof window.trdSuggestEmail !== 'function') return false;
    var s;
    try { s = window.trdSuggestEmail(v); } catch (e) { return false; }
    if (!s || s === v) return false;
    keptEmail = v;
    var btn = el('button', { type: 'button', class: 'trd-suggest', text: s });
    btn.addEventListener('click', function () {
      inputs.email.value = s;
      setError('email', '');
      inputs.email.focus();
    });
    errs.email.textContent = '';
    errs.email.classList.add('is-hint');
    errs.email.appendChild(document.createTextNode('Did you mean '));
    errs.email.appendChild(btn);
    errs.email.appendChild(document.createTextNode('?'));
    focusField('email', true);
    return true;
  }

  /* Every error is shown at once and the first invalid field gets focus. The typo hint is checked
     only once the rest is valid, so it never competes with an error for the focus. */
  function onSubmit(e) {
    e.preventDefault();
    if (busy || sent) return;
    submitErr.textContent = '';
    var first = validateAll();
    if (first) { focusField(first, true); return; }
    if (emailHintShown()) return;
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
  function resetSubmit() {
    busy = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit';
  }

  function fail() {
    resetSubmit();
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
    submitBtn.disabled = true;
    submitBtn.textContent = '';
    submitBtn.appendChild(el('span', { class: 'trd-spinner', 'aria-hidden': 'true' }));
    submitBtn.appendChild(document.createTextNode('Submitting'));
    submitErr.textContent = '';

    var pre = CFG.TURNSTILE_SITE_KEY ? waitForToken(8000) : Promise.resolve('');
    pre.then(function (token) {
      var body = attributionPayload();
      FIELD_ORDER.forEach(function (k) {
        body[k] = k === 'phone' ? normalisePhone(inputs.dial.value, inputs.phone.value) : answer(k);
      });
      body.company_website = inputs.hp.value;
      if (token) body.turnstileToken = token;
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin'
      });
    }).then(function (res) {
      if (res.ok) {
        /* The lead is saved at this point: a body that cannot be read only costs the booking prefill. */
        return res.json().then(function (d) { return d && d.leadId; }, function () { return ''; }).then(success);
      }
      if (res.status === 400) {
        return res.json().then(function (data) {
          if (!showServerFieldErrors(data)) throw new Error('HTTP 400');
        });
      }
      throw new Error('HTTP ' + res.status);
    }).catch(fail);
  }

  /* Server validation_failed: put each message on its field and jump to the first affected field.
     Returns false when nothing maps to a visible field, so the caller falls back to the generic error. */
  function showServerFieldErrors(data) {
    var fields = data && data.error === 'validation_failed' && data.fields;
    if (!fields) return false;
    var first = '';
    FIELD_ORDER.forEach(function (k) {
      var msgs = fields[k];
      if (msgs && msgs.length) {
        setError(k, String(msgs[0]));
        if (!first) first = k;
      }
    });
    if (!first) return false;
    resetSubmit();
    if (tsWidgetId !== null && window.turnstile) {
      try { window.turnstile.reset(tsWidgetId); tsToken = ''; } catch (e) { /* ignore */ }
    }
    focusField(first, true);
    return true;
  }

  function showThanks() {
    var msg = el('div', { class: 'trd-thanks', role: 'status', tabindex: '-1', text: CFG.THANK_YOU_TEXT || 'Thank you.' });
    card.appendChild(msg);
    doneEl = msg;
    msg.focus();
  }

  /* With CAL_LINK set (and js/booking.js loaded) the card turns into the Cal.com calendar, prefilled and tagged
     with the saved lead's id. Returns false when that is not possible so the caller shows the thank-you. */
  function showBooking(leadId) {
    if (!CFG.CAL_LINK || !window.trdBooking || typeof window.trdBooking.mount !== 'function') return false;
    var title = el('p', { class: 'trd-booking-title', tabindex: '-1', text: 'Pick a time for your call' });
    var host = el('div', { class: 'trd-booking-host' });
    var wrap = el('div', { class: 'trd-booking' }, [title, host]);
    card.appendChild(wrap);
    card.classList.add('is-booking');
    overlay.classList.add('has-booking');
    var started = false;
    try {
      started = window.trdBooking.mount(host, {
        name: inputs.fullName.value.trim(),
        email: inputs.email.value.trim(),
        phone: normalisePhone(inputs.dial.value, inputs.phone.value),
        company: inputs.company.value.trim(),
        leadId: leadId ? String(leadId) : ''
      }, {
        /* The calendar did not render: the card reverts to thank-you sizing and wording until/unless it does. */
        onFallback: function () {
          var fb = host.querySelector('.trd-fallback');
          var hadFocus = document.activeElement === title;
          title.hidden = true;
          card.classList.remove('is-booking');
          overlay.classList.remove('has-booking');
          if (fb) { doneEl = fb; if (hadFocus) fb.focus(); }
        },
        onReady: function (info) {
          title.hidden = false;
          card.classList.add('is-booking');
          overlay.classList.add('has-booking');
          doneEl = title;
          if (info && info.focusWasInFallback) title.focus();
        },
        onBooked: function () {
          if (title.parentNode) title.parentNode.removeChild(title);
          card.classList.remove('is-booking');
          overlay.classList.remove('has-booking');
          doneEl = host.querySelector('.trd-thanks');
        }
      }, { fallbackText: CFG.THANK_YOU_TEXT || 'Thank you.' });
    } catch (e) { started = false; }
    if (!started) {
      card.removeChild(wrap);
      card.classList.remove('is-booking');
      overlay.classList.remove('has-booking');
      return false;
    }
    doneEl = title;
    title.focus();
    return true;
  }

  function success(leadId) {
    sent = true;
    busy = false;
    card.removeChild(form);
    /* The form was long: the next state (calendar or thank-you) starts at the top of the overlay. */
    overlay.scrollTop = 0;
    if (!showBooking(leadId)) showThanks();
    try { if (window.track && window.track.lead) window.track.lead(); } catch (e) { /* tracking must never break the flow */ }
  }

  /* ---------- open / close / focus trap ---------- */
  /* Tabbable elements inside the modal, recomputed on every Tab because the form, booking and
     thank-you states swap content and bottleneck options disable themselves. The trap is bound to
     the overlay, which is never replaced. */
  function focusables() {
    return Array.prototype.filter.call(
      overlay.querySelectorAll('a[href], button:not([disabled]), iframe, input:not([disabled]):not([tabindex="-1"]), select:not([disabled])'),
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
    try { if (window.trdBooking && window.trdBooking.warm) window.trdBooking.warm(); } catch (e) { /* the calendar loads at submit instead */ }
    overlay.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    if (root) root.setAttribute('inert', '');
    ensureTurnstile();
    if (sent) { if (doneEl) doneEl.focus(); }
    else focusField('fullName');
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
