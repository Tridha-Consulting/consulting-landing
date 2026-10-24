/* Ad tags: each loads only if its ID is set, and only after window load. */
(function () {
  'use strict';
  var C = window.TRIDHA_CONFIG || {};
  var fired = false;

  function addScript(src) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    document.head.appendChild(s);
  }

  // Queues are defined up front so track.lead() works even before a tag has finished loading.
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

  function loadMeta() {
    if (!C.META_PIXEL_ID) return;
    if (!window.fbq) {
      var n = window.fbq = function () { if (n.callMethod) n.callMethod.apply(n, arguments); else n.queue.push(arguments); };
      if (!window._fbq) window._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      addScript('https://connect.facebook.net/en_US/fbevents.js');
    }
    window.fbq('init', C.META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }

  function loadGtag() {
    var first = C.GA4_ID || C.GOOGLE_ADS_ID;
    if (!first) return;
    addScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(first));
    window.gtag('js', new Date());
    if (C.GA4_ID) window.gtag('config', C.GA4_ID);
    if (C.GOOGLE_ADS_ID) window.gtag('config', C.GOOGLE_ADS_ID);
  }

  function loadLinkedIn() {
    if (!C.LINKEDIN_PARTNER_ID) return;
    window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];
    window._linkedin_data_partner_ids.push(C.LINKEDIN_PARTNER_ID);
    if (!window.lintrk) {
      window.lintrk = function (a, b) { window.lintrk.q.push([a, b]); };
      window.lintrk.q = [];
    }
    addScript('https://snap.licdn.com/li.lms-analytics/insight.min.js');
  }

  function loadX() {
    if (!C.X_PIXEL_ID) return;
    if (!window.twq) {
      var t = window.twq = function () { if (t.exe) t.exe.apply(t, arguments); else t.queue.push(arguments); };
      t.version = '1.1';
      t.queue = [];
      addScript('https://static.ads-twitter.com/uwt.js');
    }
    window.twq('config', C.X_PIXEL_ID);
  }

  function loadAll() {
    if (location.hostname !== C.TAGS_HOSTNAME) return;
    loadMeta(); loadGtag(); loadLinkedIn(); loadX();
  }

  if (document.readyState === 'complete') setTimeout(loadAll, 0);
  else window.addEventListener('load', function () { setTimeout(loadAll, 0); });

  function lead() {
    if (fired) return;
    fired = true;
    try { if (C.META_PIXEL_ID && window.fbq) window.fbq('track', 'Lead'); } catch (e) { /* ignore */ }
    try { if (C.GA4_ID) window.gtag('event', 'generate_lead'); } catch (e) { /* ignore */ }
    try {
      if (C.GOOGLE_ADS_ID && C.GOOGLE_ADS_LEAD_LABEL) {
        window.gtag('event', 'conversion', { send_to: C.GOOGLE_ADS_ID + '/' + C.GOOGLE_ADS_LEAD_LABEL });
      }
    } catch (e) { /* ignore */ }
    try {
      if (C.LINKEDIN_PARTNER_ID && C.LINKEDIN_CONVERSION_ID && window.lintrk) {
        window.lintrk('track', { conversion_id: Number(C.LINKEDIN_CONVERSION_ID) });
      }
    } catch (e) { /* ignore */ }
    try {
      if (C.X_PIXEL_ID && C.X_LEAD_EVENT_ID && window.twq) window.twq('event', C.X_LEAD_EVENT_ID, {});
    } catch (e) { /* ignore */ }
  }

  window.track = { lead: lead };
})();
