/* Pure "did you mean" helper: suggests a corrected address for a likely typo in the email domain. Advice only: the server never rejects on it. */
(function () {
  'use strict';

  var KNOWN = [
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com', 'rocketmail.com',
    'outlook.com', 'outlook.in', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
    'aol.com', 'rediffmail.com', 'zohomail.in', 'zoho.com', 'protonmail.com', 'proton.me', 'mail.com',
    'gmx.com', 'yandex.com',
    // Real domains one or two edits from a target that the fuzzy rule would otherwise "correct".
    'email.com', 'cloud.com', 'ecloud.com', 'gail.com'
  ];

  var TARGETS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'rediffmail.com'];

  var TYPOS = {};
  function addTypos(correct, list) {
    list.forEach(function (d) { TYPOS[d] = correct; });
  }
  addTypos('gmail.com', ['gmial.com', 'gmai.com', 'gmil.com', 'gmaill.com', 'gamil.com', 'gnail.com', 'gmile.com',
    'gmali.com', 'gmal.com', 'gmail.co', 'gmail.con', 'gmail.cm', 'gmail.om', 'gmail.comh', 'gmail.coom', 'gmail.in']);
  addTypos('yahoo.com', ['yaho.com', 'yahooo.com', 'yahho.com', 'yhoo.com', 'yahoo.co', 'yahoo.con']);
  addTypos('hotmail.com', ['hotmial.com', 'hotmal.com', 'hotmai.com', 'hotmail.co', 'hotmail.con']);
  addTypos('outlook.com', ['outlok.com', 'outllook.com', 'outlook.co', 'outlook.con']);
  addTypos('icloud.com', ['icloud.co', 'iclod.com', 'icoud.com']);
  addTypos('rediffmail.com', ['rediffmail.co', 'redifmail.com', 'rediffmai.com']);

  /* A provider name on a different TLD (yahoo.ca, hotmail.no, outlook.cz) is usually a real regional
     domain, so the fuzzy rule corrects the TLD only when it looks like a slip on ".com". */
  function looksLikeComSlip(tld) {
    return tld.indexOf('com') === 0 || ['co', 'con', 'cm', 'om', 'cpm', 'xom', 'vom', 'cim', 'ocm', 'cmo'].indexOf(tld) !== -1;
  }

  /* Optimal string alignment distance (Levenshtein plus adjacent transpositions). */
  function distance(a, b) {
    var i, j, d = [];
    for (i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (j = 1; j <= b.length; j++) { d[0][j] = j; }
    for (i = 1; i <= a.length; i++) {
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length];
  }

  function suggestEmail(email) {
    var s = String(email == null ? '' : email).trim();
    var at = s.lastIndexOf('@');
    if (at < 1) return null;
    var local = s.slice(0, at);
    var domain = s.slice(at + 1).trim().toLowerCase();
    if (!domain || KNOWN.indexOf(domain) !== -1) return null;

    var fix = Object.prototype.hasOwnProperty.call(TYPOS, domain) ? TYPOS[domain] : null;
    if (!fix) {
      var dot = domain.indexOf('.');
      var name = domain.slice(0, dot), tld = domain.slice(dot + 1);
      var best = 3;
      for (var i = 0; i < TARGETS.length; i++) {
        if (dot > 0 && name === TARGETS[i].split('.')[0] && !looksLikeComSlip(tld)) continue;
        var dist = distance(domain, TARGETS[i]);
        if (dist >= 1 && dist <= 2 && dist < best) { best = dist; fix = TARGETS[i]; }
      }
    }
    return fix ? local + '@' + fix : null;
  }

  if (typeof window !== 'undefined') window.trdSuggestEmail = suggestEmail;
  if (typeof module !== 'undefined' && module.exports) module.exports = suggestEmail;
})();
