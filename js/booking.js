/* Cal.com inline booking embed, shared by the lead modal (js/form.js) and /book (book.html).
   The Cal embed script is fetched only when mount() runs, never on page load.
   Never a blank screen: a loading state shows at once, and if Cal has not reported linkReady within
   READY_MS (or its script fails to load, or Cal reports linkFailed) a plain fallback with a link to the
   public booking page replaces it. A late linkReady still wins and removes the fallback. */
(function () {
  'use strict';

  var CFG = window.TRIDHA_CONFIG || {};
  var DEFAULT_ORIGIN = 'https://app.cal.com';
  var READY_MS = 8000;
  var seq = 0;
  var scriptState = '';       // '', 'loading', 'loaded', 'failed'
  var scriptWaiters = [];

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

  function origin() {
    return String(CFG.CAL_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');
  }

  /* Prefill keys are Cal's own: name, email, the default phone field slug attendeePhoneNumber,
     and metadata[key] (delivered to the booking webhook as payload.metadata.key). */
  function prefillParams(p) {
    var out = {};
    if (p.name) out.name = p.name;
    if (p.email) out.email = p.email;
    if (p.phone) out.attendeePhoneNumber = p.phone;
    if (p.leadId) out['metadata[leadId]'] = p.leadId;
    return out;
  }

  /* Public booking page for the same link and prefill: cal.com/<link> on Cal's hosted app, <origin>/<link> otherwise. */
  function bookingUrl(p) {
    var o = origin();
    var base = o === DEFAULT_ORIGIN ? 'https://cal.com' : o;
    var params = prefillParams(p);
    var q = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return base + '/' + String(CFG.CAL_LINK || '').replace(/^\/+/, '') + (q ? '?' + q : '');
  }

  /* The official Cal snippet's command queue, minus its own script tag: the script is added in loadScript so a
     load failure can be seen. The real embed.js replaces window.Cal and drains this queue. */
  function defineStub() {
    var C = window;
    var push = function (a, ar) { a.q.push(ar); };
    C.Cal = C.Cal || function () {
      var cal = C.Cal, ar = arguments;
      if (ar[0] === 'init') {
        var api = function () { push(api, arguments); };
        var namespace = ar[1];
        api.q = api.q || [];
        if (typeof namespace === 'string') {
          cal.ns[namespace] = cal.ns[namespace] || api;
          push(cal.ns[namespace], ar);
          push(cal, ['initNamespace', namespace]);
        } else push(cal, ar);
        return;
      }
      push(cal, ar);
    };
    /* embed.js refuses to start unless Cal.q already exists; the official snippet gets that from its first call. */
    if (!C.Cal.loaded) { C.Cal.ns = {}; C.Cal.q = C.Cal.q || []; C.Cal.loaded = true; }
  }

  function loadScript(cb) {
    if (scriptState === 'loaded' || scriptState === 'failed') { cb(scriptState === 'loaded'); return; }
    scriptWaiters.push(cb);
    if (scriptState === 'loading') return;
    scriptState = 'loading';
    defineStub();
    function settle(ok) {
      scriptState = ok ? 'loaded' : 'failed';
      var w = scriptWaiters.splice(0);
      w.forEach(function (f) { f(ok); });
    }
    var s = document.createElement('script');
    s.async = true;
    s.src = origin() + '/embed/embed.js';
    s.onload = function () { settle(true); };
    s.onerror = function () { settle(false); };
    document.head.appendChild(s);
  }

  /* mount(container, prefill, callbacks, options)
       prefill   { name, email, phone, leadId }
       callbacks { onReady({ focusWasInFallback }), onFallback(reason), onBooked() }  all optional
       options   { fallbackText | fallbackNode() }  text (or a node factory) shown above the "Open the booking page" link when the embed does not render
     Returns true when the embed was started, false when no CAL_LINK is configured (container untouched). */
  function mount(container, prefill, callbacks, options) {
    if (!container || !CFG.CAL_LINK) return false;
    prefill = prefill || {};
    callbacks = callbacks || {};
    options = options || {};

    var ns = 'trd' + (++seq);
    var state = 'loading';       // 'loading', 'fallback', 'ready', 'booked'
    var timer = null;
    var fallbackEl = null;

    function call(name, arg) {
      try { if (callbacks[name]) callbacks[name](arg); } catch (e) { /* UI callbacks must never break the embed */ }
    }

    container.textContent = '';
    var loading = el('div', { class: 'trd-loading', role: 'status' }, [
      el('span', { class: 'trd-spinner', 'aria-hidden': 'true' }),
      document.createTextNode('Loading the calendar')
    ]);
    var embed = el('div', { class: 'trd-embed is-pending' });
    container.appendChild(loading);
    container.appendChild(embed);

    function showFallback(reason) {
      if (state !== 'loading') return;
      state = 'fallback';
      if (timer) { clearTimeout(timer); timer = null; }
      if (loading.parentNode) loading.parentNode.removeChild(loading);
      fallbackEl = el('div', { class: 'trd-fallback', role: 'status', tabindex: '-1' }, [
        options.fallbackNode ? options.fallbackNode() : el('p', { text: options.fallbackText || '' }),
        el('p', {}, [el('a', { href: bookingUrl(prefill), target: '_blank', rel: 'noopener', text: 'Open the booking page' })])
      ]);
      container.insertBefore(fallbackEl, embed);
      call('onFallback', reason);
    }

    function ready() {
      if (state === 'ready' || state === 'booked') return;
      state = 'ready';
      if (timer) { clearTimeout(timer); timer = null; }
      /* Read before the fallback is removed: removing the focused element drops focus to <body>. */
      var focusWasInFallback = !!(fallbackEl && fallbackEl.contains(document.activeElement));
      if (loading.parentNode) loading.parentNode.removeChild(loading);
      if (fallbackEl && fallbackEl.parentNode) fallbackEl.parentNode.removeChild(fallbackEl);
      fallbackEl = null;
      embed.classList.remove('is-pending');
      call('onReady', { focusWasInFallback: focusWasInFallback });
    }

    function booked() {
      if (state === 'booked') return;
      state = 'booked';
      if (timer) { clearTimeout(timer); timer = null; }
      container.textContent = '';
      var msg = el('div', { class: 'trd-thanks', role: 'status', tabindex: '-1', text: CFG.BOOKED_TEXT || 'You are booked.' });
      container.appendChild(msg);
      msg.focus();
      try { if (window.track && window.track.booked) window.track.booked(); } catch (e) { /* tracking must never break the flow */ }
      call('onBooked');
    }

    timer = setTimeout(function () { showFallback('timeout'); }, READY_MS);

    loadScript(function (ok) {
      if (!ok) { showFallback('script'); return; }
      try {
        var config = prefillParams(prefill);
        config.layout = 'month_view';
        config.theme = 'light';
        window.Cal('init', ns, { origin: origin() });
        var api = window.Cal.ns[ns];
        api('inline', { elementOrSelector: embed, calLink: String(CFG.CAL_LINK), config: config });
        api('ui', { theme: 'light', hideEventTypeDetails: false, layout: 'month_view' });
        api('on', { action: 'linkReady', callback: ready });
        api('on', { action: 'linkFailed', callback: function () { showFallback('failed'); } });
        api('on', { action: 'bookingSuccessfulV2', callback: booked });
        api('on', { action: 'bookingSuccessful', callback: booked });
      } catch (e) { showFallback('error'); }
    });
    return true;
  }

  /* /book: any element with data-trd-booking is filled from the query string (name, email, phone). */
  function clip(v, n) { return String(v == null ? '' : v).slice(0, n); }

  function autoInit() {
    var host = document.querySelector('[data-trd-booking]');
    if (!host) return;
    var q;
    try { q = new URLSearchParams(window.location.search); } catch (e) { q = { get: function () { return ''; } }; }
    var prefill = { name: clip(q.get('name'), 120), email: clip(q.get('email'), 254), phone: clip(q.get('phone'), 20) };
    var contact = CFG.FALLBACK_CONTACT || '';
    function contactNode() {
      return /@/.test(contact) ? el('a', { href: 'mailto:' + contact, text: contact }) : document.createTextNode(contact);
    }
    function sentence(lead) {
      var p = el('p', {}, [document.createTextNode(lead + ' Email us at '), contactNode(), document.createTextNode(" and we'll set up a call.")]);
      return p;
    }
    if (!CFG.CAL_LINK) {
      host.textContent = '';
      host.appendChild(el('div', { class: 'trd-fallback', role: 'status' }, [sentence("Online booking isn't available right now.")]));
      return;
    }
    mount(host, prefill, {
      onReady: function (info) {
        var h = document.querySelector('h1');
        if (info && info.focusWasInFallback && h) { h.setAttribute('tabindex', '-1'); h.focus(); }
      }
    }, { fallbackNode: function () { return sentence("The booking calendar didn't load."); } });
  }

  window.trdBooking = { mount: mount, bookingUrl: bookingUrl };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoInit); else autoInit();
})();
