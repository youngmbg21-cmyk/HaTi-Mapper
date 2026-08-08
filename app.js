/* HaTi-Mapper — the front end.
 *
 * This file renders; it does not analyse. Every number on the page comes from
 * one of two server routes, and where the server says a thing could not be
 * derived, the page says "not detected" rather than filling the space with
 * something plausible.
 *
 * Nothing is fetched until there is a session. The page shows a sign-in card
 * first and only draws the dashboard once the server confirms the login, which
 * matters because what it draws is HaTi's file paths, its addresses that work
 * without logging in, and its known weaknesses.
 *
 * The secrets the server needs — the GitHub token, HaTi's MAPPER_TOKEN and the
 * Anthropic key — stay in the server's environment or its state directory and
 * are never sent to the browser. The key is only ever echoed back as its last
 * four characters.
 */
(function () {
  'use strict';

  var scan = null;
  var pulse = null;

  /* ------------------------------------------------------------- helpers */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var $ = function (id) { return document.getElementById(id); };

  function kb(bytes) {
    if (bytes == null) return '—';
    return Math.round(bytes / 1024) + ' KB';
  }
  function num(n) { return n == null ? '—' : Number(n).toLocaleString('en-GB'); }

  /* Anything the scan could not work out renders the same way everywhere. */
  function nd(label) { return '<span class="nd">' + esc(label || 'not detected') + '</span>'; }

  function skeleton(rows) {
    var out = '';
    for (var i = 0; i < (rows || 5); i++) {
      out += '<div class="sk" style="width:' + (58 + (i * 37) % 42) + '%"></div>';
    }
    return out;
  }

  function fmtDate(iso, withTime) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    // Seconds are shown with the time because pressing Rescan twice inside a
    // minute must visibly move the timestamp, not appear to do nothing.
    var opts = withTime
      ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : { day: 'numeric', month: 'short' };
    return d.toLocaleString('en-GB', opts);
  }

  /* ------------------------------------------------------------- the login */

  /* Four states in one card: sign in, first-time set up, ask for a reset link,
     and set a new password from a link. `authState` says which. */
  var authState = 'login';
  var authInfo = null;

  /* One sender for every write. It takes the method explicitly, because the
     routes are not all POST — /api/ai/config is a PUT, and a helper that
     silently assumed otherwise is exactly how that save came to 404. */
  function send(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.text().then(function (raw) {
        var b = null;
        try { b = JSON.parse(raw); } catch (e) {}
        if (!b) throw new Error('The server is not reachable. If this page has just been redeployed, wait a moment and try again.');
        if (!res.ok) { var e2 = new Error(b.error || 'That did not work.'); e2.body = b; throw e2; }
        return b;
      });
    });
  }

  var post = function (path, body) { return send('POST', path, body); };

  function authMsg(kind, text) {
    var el = $('authMsg');
    if (!text) { el.hidden = true; return; }
    el.className = 'msg ' + kind;
    el.innerHTML = text;
    el.hidden = false;
  }

  function resetTokenFromUrl() {
    var m = String(location.hash || '').match(/^#reset=(.+)$/);
    return m ? m[1] : null;
  }

  function showAuth(state) {
    authState = state;
    $('app').hidden = true;
    $('ask').hidden = true;
    $('askLaunch').hidden = true;
    $('auth').hidden = false;
    authMsg(null);

    var title = $('authTitle'), lede = $('authLede'), go = $('authGo'), alt = $('authAlt');
    var showEmail = true, showPw = true, showConfirm = false, showForgot = false;

    if (state === 'setup') {
      title.textContent = 'Set up your account';
      lede.innerHTML = authInfo && authInfo.expectsEmail
        ? 'This Mapper is set up for <b>' + esc(authInfo.expectsEmail) + '</b>. Choose a password and you are in.'
        : 'Nobody has claimed this Mapper yet. Set your email and password now — until you do, anyone who finds this address could claim it.';
      go.textContent = 'Create account';
      showConfirm = true;
      $('hPassword').hidden = false;
      $('lPassword').textContent = 'Choose a password';
      $('authPassword').setAttribute('autocomplete', 'new-password');
      alt.hidden = true;
    } else if (state === 'login') {
      title.textContent = 'Sign in';
      lede.textContent = 'This page describes how HaTi is built, so it is behind a login.';
      go.textContent = 'Sign in';
      $('hPassword').hidden = true;
      $('lPassword').textContent = 'Password';
      $('authPassword').setAttribute('autocomplete', 'current-password');
      showForgot = true;
      alt.hidden = true;
    } else if (state === 'forgot') {
      title.textContent = 'Reset your password';
      lede.textContent = 'Enter your email and we will send you a link to set a new password.';
      go.textContent = 'Send the link';
      showPw = false;
      alt.hidden = false;
      alt.textContent = 'Back to sign in';
    } else if (state === 'reset') {
      title.textContent = 'Choose a new password';
      lede.textContent = 'This link works once. Setting a new password signs you out everywhere.';
      go.textContent = 'Save new password';
      showEmail = false;
      showConfirm = true;
      $('hPassword').hidden = false;
      $('lPassword').textContent = 'New password';
      $('authPassword').setAttribute('autocomplete', 'new-password');
      alt.hidden = false;
      alt.textContent = 'Back to sign in';
    }

    $('fEmail').hidden = !showEmail;
    $('fPassword').hidden = !showPw;
    $('fConfirm').hidden = !showConfirm;
    $('authFoot').hidden = !showForgot;

    if (authInfo && authInfo.expectsEmail && state === 'setup') $('authEmail').value = authInfo.expectsEmail;
    $('authPassword').value = '';
    $('authConfirm').value = '';
    setTimeout(function () {
      var first = showEmail && !$('authEmail').value ? $('authEmail') : (showPw ? $('authPassword') : $('authEmail'));
      if (first) first.focus();
    }, 60);
  }

  function showApp(info) {
    authInfo = info || authInfo;
    $('auth').hidden = true;
    $('app').hidden = false;
    $('askLaunch').hidden = false;

    /* The chip in the corner says who is signed in. There is only ever one
       account, so the initials come from the address itself. */
    var email = (authInfo && authInfo.email) || '';
    if (email) {
      $('whoName').textContent = email;
      $('whoName').title = email;
      $('whoAv').textContent = email.slice(0, 2).toUpperCase();
    }
  }

  $('authForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('authEmail').value.trim();
    var password = $('authPassword').value;
    var confirm = $('authConfirm').value;
    var go = $('authGo');
    authMsg(null);

    if ((authState === 'setup' || authState === 'reset') && password !== confirm) {
      return authMsg('bad', 'The two passwords do not match.');
    }

    go.disabled = true;
    var was = go.textContent;
    go.textContent = 'Working…';
    var done = function () { go.disabled = false; go.textContent = was; };

    if (authState === 'forgot') {
      post('/api/auth/forgot', { email: email })
        .then(function (b) {
          done();
          authMsg(b.emailSent ? 'good' : 'info', esc(b.note));
        })
        .catch(function (err) { done(); authMsg('bad', esc(err.message)); });
      return;
    }

    if (authState === 'reset') {
      post('/api/auth/reset', { token: resetTokenFromUrl(), password: password })
        .then(function () {
          done();
          location.hash = '';
          showAuth('login');
          authMsg('good', 'Your password is set. Sign in with it now.');
        })
        .catch(function (err) { done(); authMsg('bad', esc(err.message)); });
      return;
    }

    var route = authState === 'setup' ? '/api/auth/setup' : '/api/auth/login';
    post(route, { email: email, password: password })
      .then(function (b) {
        done();
        return boot(b);
      })
      .catch(function (err) { done(); authMsg('bad', esc(err.message)); });
  });

  $('authForgot').addEventListener('click', function () { showAuth('forgot'); });
  $('authAlt').addEventListener('click', function () { location.hash = ''; showAuth('login'); });

  function signOut(everywhere) {
    return post(everywhere ? '/api/auth/sign-out-everywhere' : '/api/auth/logout', {})
      .catch(function () {})
      .then(function () { location.reload(); });
  }

  /* ---------------------------------------------------------- requests */

  function apiGet(path) {
    return fetch(path, { cache: 'no-store', credentials: 'same-origin' }).then(function (res) {
      /* The session expired or was signed out elsewhere — back to the login
         rather than showing a broken page. */
      if (res.status === 401) {
        var e0 = new Error('Your session has ended.');
        e0.needsAuth = true;
        showAuth('login');
        authMsg('info', 'Your session has ended. Sign in again.');
        throw e0;
      }
      return res.text().then(function (raw) {
        var body = null;
        try { body = JSON.parse(raw); } catch (e) { /* handled below */ }

        /* The Mapper's own server always answers these routes with JSON, so a
           non-JSON body means something other than the Node process replied —
           almost always a static host or proxy sitting where the backend
           should be. It serves index.html and app.js perfectly well, which is
           why the page renders at all, but it has no /api/* to answer. Say
           that, rather than surfacing "Unexpected token 'N'". */
        if (body === null) {
          var snippet = raw.trim().slice(0, 60).replace(/\s+/g, ' ');
          var e2 = new Error(
            'The page is being served, but its API is not. ' + path + ' returned ' +
            res.status + (snippet ? ' “' + snippet + '”' : '') + ' instead of JSON. ' +
            'That is what a static host or proxy replies when there is no Node server behind it — ' +
            'this needs to run as a web service (npm start), not as a static site.');
          e2.noBackend = true;
          throw e2;
        }

        if (!res.ok) {
          var e3 = new Error(body.detail || body.error || ('Request failed (' + res.status + ')'));
          e3.body = body;
          throw e3;
        }
        return body;
      });
    });
  }

  /* -------------------------------------------------------------- panels */

  /* Every control that opens a panel, wherever it sits — the pill row carries
     most of them, and Settings is the gear in the top right corner. */
  var tabs = document.querySelectorAll('[data-p]');
  var panels = document.querySelectorAll('.panel');

  function showPanel(name) {
    var hold = window.scrollY;
    tabs.forEach(function (x) { x.setAttribute('aria-selected', String(x.getAttribute('data-p') === name)); });
    panels.forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== name; });
    /* Swapping the panels changes the height of the document, and a browser
       will shift the scroll position when that happens. Put it back. */
    if (window.scrollY !== hold) window.scrollTo({ top: hold, behavior: 'auto' });
  }

  /* Switching tabs does not move the page. Full stop.
   *
   * Every panel begins at the same line, directly under the pinned tab row, so
   * holding the scroll position where it is puts the new panel's heading
   * exactly where the old one's was — the eye stays level and the tabs stay
   * under the cursor. Anything cleverer than this is a jump: sending you to
   * the panel's start moves you when you were reading further down, and
   * restoring a remembered position moves you when you were not.
   *
   * The only case that cannot be honoured is a panel too short to hold the
   * current position. The browser clamps to the end of that panel, because the
   * content genuinely is not there to scroll to.
   */
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { showPanel(t.getAttribute('data-p')); });
  });

  /* ------------------------------------------------------------ the theme
     Dark is the resting state. The choice is remembered in this browser only —
     it is a preference about a screen, not a fact about HaTi, so it never
     reaches the server. */
  var SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function applyTheme(mode) {
    var light = mode === 'light';
    document.body.classList.toggle('light', light);
    document.documentElement.style.background = light ? '#f1f5f9' : '#020617';
    /* The button shows what pressing it gets you, not what you already have. */
    $('themeBtn').innerHTML = light ? MOON : SUN;
    /* Everything on this page is themed by CSS and follows on its own. A
       canvas does not: it holds pixels, and the colours it drew with were read
       off the page at the moment it drew. Left alone, a chart in an answer
       keeps the dark palette on a light card. */
    repaintCharts();
  }

  var savedTheme = null;
  try { savedTheme = localStorage.getItem('mapper.theme'); } catch (e) { /* private mode */ }
  applyTheme(savedTheme === 'light' ? 'light' : 'dark');

  $('themeBtn').addEventListener('click', function () {
    var next = document.body.classList.contains('light') ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem('mapper.theme', next); } catch (e) { /* private mode */ }
  });

  var TOWER_IDS = ['towerBurn', 'towerCal', 'towerDoors', 'towerAttention', 'towerGrip', 'towerMap', 'towerWeight'];

  function setLoading() {
    TOWER_IDS.concat(['screensBody', 'costBody', 'dataBody', 'blastBody', 'gapsBody',
      'doorsBody', 'weightBody', 'orphanBody', 'watchBody', 'digestBody'])
      .forEach(function (id) { $(id).innerHTML = skeleton(5); });
    $('capsBody').innerHTML = skeleton(4);
    $('screensBody').innerHTML = skeleton(6) +
      '<p class="loading-note"><b>Downloading HaTi and reading its source.</b> This is one repository download, then everything is parsed here. ' +
      'A warm scan takes a second or two; a cold one — the first after this service has been idle, which spins it down — has to start the server first and can take up to a minute.</p>';
  }

  /* ==================================================================== */
  /*  The control tower                                                    */
  /*                                                                       */
  /*  One screen that answers "is anything wrong this morning?" without     */
  /*  opening a tab. Every figure on it is read from the same scan the      */
  /*  tabs below use — nothing here is illustrative, and where a reading    */
  /*  needs history the Mapper has not gathered yet, the card says so       */
  /*  rather than drawing a shape that means nothing.                      */
  /* ==================================================================== */

  var trends = null;   // the measurement series, once /api/trends answers
  var watchData = null; // the watch log for the Changes panel's chosen range
  /* The same log over the widest window the archive keeps. The tower's
     calendar draws a whole month, so it cannot be fed by the Changes panel's
     range: at that panel's default of 72 hours the month would be marked from
     three days of log and counted from three days of events, while the days it
     shades as "scanned" come from 90 days of readings. One picture, two
     windows, and the shorter one silently wins. */
  var towerWatch = null;
  var doorsResult = null; // the last live door check, if the owner ran one

  function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }

  /* A line drawn through however many readings there are. Returns the two
     paths the design wants — a filled area and the stroke over it. */
  function areaPath(values, w, h, pad) {
    if (!values.length) return null;
    var lo = Math.min.apply(null, values), hi = Math.max.apply(null, values);
    var span = hi - lo || 1;
    var step = values.length > 1 ? w / (values.length - 1) : 0;
    var pts = values.map(function (v, i) {
      return [i * step, pad + (h - pad * 2) * (1 - (v - lo) / span)];
    });
    var line = pts.map(function (p, i) {
      return (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1);
    }).join(' ');
    return { line: line, area: line + ' L' + w + ',' + h + ' L0,' + h + ' Z', points: pts };
  }

  /* ---- today's burn ---- */
  function renderTowerBurn() {
    var c = scan.cost || {};
    var live = pulse && pulse.available;
    var used = live && pulse.usage ? pulse.usage.count : null;
    var limit = live && pulse.usage ? pulse.usage.dailyLimit : null;
    if (limit == null) {
      var lim = (scan.ai.caps || []).filter(function (x) { return x.key === 'aiDailyLimit'; })[0];
      limit = lim ? lim.codeDefault : null;
    }

    var spend = c.dailyMixedUsd;
    var ceiling = c.dailyCeilingUsd;

    var html = '<div class="chead"><h3>Today\'s burn</h3>' +
      '<div class="seg"><button type="button" class="on">A whole day</button></div></div>' +
      '<div class="duo">' +
      '<div><span class="bignum">' + (spend == null ? '—' : usd(spend)) + '</span>' +
      (ceiling == null ? '' : '<span class="delta flat">max ' + usd(ceiling) + '</span>') +
      '<div class="subnum">a whole day at HaTi\'s own caps — a roof, not a bill</div></div>' +
      '<div><span class="bignum">' + (used == null ? num(limit) : num(used)) + '</span>' +
      (used == null
        ? '<span class="delta flat">the cap</span>'
        : (limit == null ? '' : '<span class="delta ' + (used / limit > 0.7 ? 'bad' : 'good') + '">of ' + num(limit) + '</span>')) +
      '<div class="subnum">' + (used == null
        ? 'AI requests a day at most — counting today\u2019s needs a running HaTi'
        : 'AI requests against the daily cap') + '</div></div>' +
      '</div>';

    /* The line is the estimated cost of a day at the caps, one reading per
       scan that found something different. Below three readings there is no
       shape to see, so nothing is drawn. */
    var series = trends && trends.points
      ? trends.points.map(function (p) { return p.dailyCostUsd; }).filter(function (v) { return typeof v === 'number'; })
      : [];

    if (series.length >= 3) {
      var p = areaPath(series, 420, 120, 12);
      var last = p.points[p.points.length - 1];
      html += '<div class="chartwrap">' +
        '<span class="chip" style="right:0;top:0"><i style="background:var(--lav)"></i>' + usd(series[series.length - 1]) + ' now</span>' +
        '<svg viewBox="0 0 420 120" width="100%" height="120" preserveAspectRatio="none" role="img" ' +
        'aria-label="What a full day at HaTi\'s caps would cost, across the last ' + series.length + ' readings">' +
        '<defs><linearGradient id="gl" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="var(--lav)" stop-opacity=".28"/><stop offset="1" stop-color="var(--lav)" stop-opacity="0"/>' +
        '</linearGradient></defs>' +
        '<path d="' + p.area + '" fill="url(#gl)"/>' +
        '<path d="' + p.line + '" fill="none" stroke="var(--lav)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="4" fill="var(--lav)" stroke="var(--card)" stroke-width="2"/>' +
        '</svg>' +
        '<div class="axis"><span>oldest</span><span>' + series.length + ' readings</span><span>now</span></div>' +
        '</div>';
    } else {
      html += '<div class="note">A line needs at least three scans that found something different. The Mapper has ' +
        series.length + '. Come back after a few days and this fills in.</div>';
    }

    $('towerBurn').innerHTML = html;
  }

  /* ---- the scan calendar ---- */

  /* Which days the Mapper looked, and which of those days it found something.
     Both come from the watch log, so an empty calendar means an empty log —
     never a quiet failure. */
  function renderTowerCal() {
    var now = new Date();
    var year = now.getFullYear(), month = now.getMonth();
    var monthName = now.toLocaleString('en-GB', { month: 'long', year: 'numeric' });

    var looked = {}, found = {};
    (trends && trends.points ? trends.points : []).forEach(function (p) {
      var d = new Date(p.at);
      if (d.getFullYear() === year && d.getMonth() === month) looked[d.getDate()] = true;
    });
    /* Only this month's rounds, because this month is what is drawn above the
       number. A round carries its changes as `events` — counting `changes`
       here read a field the API has never sent, so the figure was zero however
       much had moved. */
    var changeCount = 0;
    (towerWatch && towerWatch.rounds ? towerWatch.rounds : []).forEach(function (r) {
      var d = new Date(r.at);
      if (d.getFullYear() !== year || d.getMonth() !== month) return;
      changeCount += (r.events || []).length;
      found[d.getDate()] = true;
      looked[d.getDate()] = true;
    });

    var first = new Date(year, month, 1).getDay();      // 0 = Sunday
    var lead = (first + 6) % 7;                          // weeks start Monday
    var days = new Date(year, month + 1, 0).getDate();
    var today = now.getDate();

    var dows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      .map(function (d) { return '<div class="dow">' + d[0] + '</div>'; }).join('');
    var cells = '';
    for (var i = 0; i < lead; i++) cells += '<div class="d blank"></div>';
    for (var day = 1; day <= days; day++) {
      var cls = 'd';
      if (found[day]) cls += ' hot';
      else if (looked[day]) cls += ' scan';
      if (day === today) cls += ' today';
      cells += '<div class="' + cls + '" title="' +
        (found[day] ? 'Something changed' : looked[day] ? 'Scanned, nothing new' : 'No scan recorded') + '">' + day + '</div>';
    }

    $('towerCal').innerHTML =
      '<div class="head"><span class="mon">' + esc(monthName) + '</span>' +
      '<button class="iconbtn" type="button" data-p="changes" style="width:30px;height:30px" title="Open the change log" aria-label="Open the change log">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg></button></div>' +
      '<div class="dows">' + dows + '</div>' +
      '<div class="days">' + cells + '</div>' +
      '<div class="foot"><div><div class="v">' + (towerWatch ? changeCount : '—') + ' change' + (changeCount === 1 ? '' : 's') + '</div>' +
      '<div class="l">noticed this month · teal days moved</div></div>' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="color:var(--tx3)"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg></div>';

    /* The arrow in the corner is a panel switch like any pill, so it needs the
       same listener the pills got at start-up. */
    var jump = $('towerCal').querySelector('[data-p]');
    if (jump) jump.addEventListener('click', function () { showPanel('changes'); });
  }

  /* ---- open doors ---- */
  function renderTowerDoors() {
    var open = scan.public.routes.length;
    var hashes = scan.public.hashes.length;

    var html = '<div class="chead"><h3>Open doors</h3>' +
      '<button class="iconbtn go" type="button" style="width:30px;height:30px" title="Open the Doors screen" aria-label="Open the Doors screen">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg></button></div>' +
      '<span class="bignum">' + open + '</span>' +
      '<div class="subnum">of ' + scan.public.totalRoutes + ' server routes carry no login check · ' +
      hashes + ' URL hash' + (hashes === 1 ? ' is' : 'es are') + ' handled before any session exists</div>';

    /* What the live check actually found, once the owner has run one. Until
       then the card says so rather than showing a zero that reads as "clean". */
    if (doorsResult && doorsResult.results) {
      var asWritten = doorsResult.results.filter(function (r) { return r.verdict === 'as-expected'; }).length;
      var gave = doorsResult.results.filter(function (r) { return r.verdict !== 'as-expected'; }).length;
      html += '<div class="minis">' +
        '<div class="mini"><span class="ic ok"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>' +
        '<div><b>' + asWritten + '</b><span>as written</span></div></div>' +
        '<div class="mini"><span class="ic no"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg></span>' +
        '<div><b>' + gave + '</b><span>gave data</span></div></div>' +
        '</div>';
    } else {
      /* Short, because this tile is a fixed height and the sentence is the
         part of it that would be cut. What the button actually does is said
         in full on the Doors screen, next to the button itself. */
      html += '<div class="note">Nobody has knocked on these doors yet — the Doors screen has a button that asks.</div>';
    }

    /* Seven readings of how many routes were open, so a door that appeared is
       visible as a step rather than a sentence. */
    var series = trends && trends.points
      ? trends.points.map(function (p) { return p.openRoutes; }).filter(function (v) { return typeof v === 'number'; }).slice(-7)
      : [];
    if (series.length >= 2) {
      var top = Math.max.apply(null, series) || 1;
      html += '<div class="bars">' + series.map(function (v, i) {
        var isLast = i === series.length - 1;
        var grew = i > 0 && v > series[i - 1];
        return '<div class="bcol">' +
          (isLast || grew ? '<span class="bval">' + v + '</span>' : '') +
          '<span class="bar' + (isLast ? ' hi' : grew ? ' au' : '') + '" style="height:' + Math.max(4, pct(v, top)) + '%"></span></div>';
      }).join('') + '</div>' +
        '<div class="blabels">' + series.map(function (v, i) {
          return '<span>' + (i === series.length - 1 ? 'now' : '−' + (series.length - 1 - i)) + '</span>';
        }).join('') + '</div>';
    }

    $('towerDoors').innerHTML = html;
    var go = $('towerDoors').querySelector('.go');
    if (go) go.addEventListener('click', function () { showPanel('public'); });
  }

  /* ---- needs attention ---- */

  /* Everything on this page that is asking for something, gathered into one
     list and sorted worst-first. Nothing here is new information — it is the
     same facts the tabs carry, arranged so the morning question is one glance
     rather than eight. */
  function renderTowerAttention() {
    var items = [];
    var ICONS = {
      lock: '<path d="M3 11h18v10H3z" fill="none"/><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
      chart: '<path d="M3 3v18h18"/><path d="M19 9l-5 5-3-3-4 4"/>',
      file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    };
    function push(sev, icon, title, tags, chip, go) {
      items.push({ sev: sev, icon: icon, title: title, tags: tags, chip: chip, go: go });
    }

    /* 1. A door that answered when the code said it would not. The single
          worst thing this page can find, so it leads whenever it exists. */
    if (doorsResult && doorsResult.results) {
      doorsResult.results.filter(function (r) { return r.verdict === 'unexpected-data'; }).forEach(function (r) {
        push(3, 'lock', 'A door opened with no login', [['Security', 'hi'], [r.address, '']], 'live', 'public');
      });
    }

    /* 2. Is what we are describing what is actually running? */
    if (pulse && pulse.drift && pulse.drift.state === 'different') {
      push(3, 'clock', 'This is not what is live', [['Freshness', 'hi'],
        [(pulse.drift.behind != null ? pulse.drift.behind + ' behind' : 'live differs'), '']], 'now', null);
    } else if (pulse && !pulse.available) {
      push(2, 'clock', 'Can’t tell whether this is live', [['Freshness', '']], '—', null);
    }

    /* 3. The scan itself getting older. */
    var ageH = scan.scannedAt ? (Date.now() - new Date(scan.scannedAt).getTime()) / 36e5 : null;
    if (ageH != null && ageH > 24) {
      push(2, 'clock', 'The scan is more than a day old', [['Freshness', '']], Math.round(ageH) + 'h', null);
    }

    /* 4. The scanner losing its grip on HaTi's source. */
    var h = scan.health;
    if (h && h.percent != null && h.percent < 95) {
      push(h.percent < 85 ? 3 : 2, 'chart', 'Grip slipped to ' + h.percent + '%',
        [['Decay', h.percent < 85 ? 'hi' : ''], [(h.attempts - h.resolved) + ' not detected', '']], h.percent + '%', null);
    }

    /* 5. Files that have outgrown comfortable. */
    var w = scan.weight;
    if (w && w.overThreshold) {
      var biggest = w.files[0];
      push(1, 'file', biggest.path + ' past ' + kb(biggest.bytes),
        [['Tidiness', ''], [w.overThreshold + ' file' + (w.overThreshold === 1 ? '' : 's') + ' over', '']], kb(biggest.bytes), 'weight');
    }

    /* 6. Gaps the documents themselves mark as serious. */
    (scan.gaps.gaps || []).filter(function (g) { return g.severity === 'high'; }).slice(0, 2).forEach(function (g) {
      push(2, 'chart', g.title, [['Not finished', '']], 'gap', 'changes');
    });

    if (!items.length) {
      $('towerAttention').innerHTML = '<div class="note"><b>Nothing is asking for you.</b> ' +
        'No door answered unexpectedly, the scan is fresh, the scanner read everything it looks for, and no file has outgrown comfortable.</div>';
      return;
    }

    items.sort(function (a, b) { return b.sev - a.sev; });
    $('towerAttention').innerHTML = '<div class="rows">' + items.slice(0, 6).map(function (x) {
      var sev = x.sev === 3 ? 'sev-hi' : x.sev === 2 ? 'sev-md' : 'sev-lo';
      return '<div class="row"' + (x.go ? ' data-go="' + x.go + '" style="cursor:pointer"' : '') + '>' +
        '<span class="ic ' + sev + '"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[x.icon] + '</svg></span>' +
        '<div class="bd"><b>' + esc(x.title) + '</b>' +
        x.tags.map(function (t) { return '<span class="tag' + (t[1] ? ' ' + t[1] : '') + '">' + esc(t[0]) + '</span>'; }).join(' ') +
        '</div><span class="kchip">' + esc(x.chip) + '</span></div>';
    }).join('') + '</div>';

    $('towerAttention').querySelectorAll('[data-go]').forEach(function (el) {
      el.addEventListener('click', function () { showPanel(el.getAttribute('data-go')); });
    });
  }

  /* ---- scanner grip ---- */

  /* Every panel is built by matching patterns against source somebody else is
     free to change. When that changes shape nothing breaks loudly — the panels
     just fill up with "not detected". This is the number that makes that
     visible before it matters. */
  function renderTowerGrip() {
    var h = scan.health;
    var html = '<div class="chead"><h3>Scanner grip</h3></div>';

    if (!h || h.percent == null) {
      $('towerGrip').innerHTML = html + '<div class="note">The scan did not report a grip figure this time.</div>';
      return;
    }

    var missed = h.attempts - h.resolved;
    var missPct = 100 - h.percent;

    /* Three circles, sized by what they stand for: what was read, what was
       not, and the warnings raised along the way. */
    /* Sized to clear the floor of the shortest tile the frame will give this
       card, so no circle is ever cut off by the edge of its own box. */
    var miss = 66 + Math.min(34, Math.round(missPct * 1.8));
    /* The complete warning list, so the circle, the popup and the Settings
       card all count the same thing. */
    var warnCount = (scan.warnings || []).length;
    html += '<div class="bubbles">' +
      '<div class="bub" style="left:2%;top:22%;width:104px;height:104px;background:var(--lav);color:var(--onlav);font-size:23px">' +
      '<b>' + h.percent + '%</b><span>facts resolved<br>' + h.resolved + ' of ' + h.attempts + '</span></div>' +
      '<div class="bub" style="right:6%;bottom:2%;width:' + miss + 'px;height:' + miss + 'px;' +
      'background:var(--gold);color:var(--ongold);font-size:17px"><b>' + missPct + '%</b><span>not detected</span></div>' +
      /* A button, not a decoration: these warnings are listed in full in the
         popup this opens, and a count you cannot get the detail of is an alarm
         with the label torn off.

         Counted from scan.warnings — the whole list — not h.warnings, which is
         only the panel-level ones the health figure is built from. The popup
         and the Settings card both show scan.warnings, so keying the circle to
         a different number would open "7 warnings" onto eight. The scan's
         late-added warnings (a failed commit-history fetch, stale prices) are
         exactly the ones worth surfacing here. */
      (warnCount ? '<button class="bub gowarn" type="button" title="See what the scan could not work out" ' +
        'style="right:20%;top:3%;width:56px;height:56px;font-size:13px;border:0;cursor:pointer">' +
        '<b>' + warnCount + '</b><span>warning' + (warnCount === 1 ? '' : 's') + '</span></button>' : '') +
      '</div>';

    var series = trends && trends.points
      ? trends.points.map(function (p) { return p.health; }).filter(function (v) { return typeof v === 'number'; }) : [];
    var was = series.length > 1 ? series[0] : null;
    html += '<div class="subnum gripnote">' +
      (missed === 0
        ? 'Everything it looks for, it found. '
        : missed + ' of the ' + num(h.attempts) + ' things it looks for came back “not detected” or with a warning. ') +
      (was != null && was !== h.percent
        ? 'Was ' + was + '% at the start of the log — HaTi moved under the patterns.'
        : h.percent < 85 ? '<b>That is low enough to be worth a look.</b>' : '') +
      '</div>';

    $('towerGrip').innerHTML = html;
    var gowarn = $('towerGrip').querySelector('.gowarn');
    if (gowarn) gowarn.addEventListener('click', openWarnPop);
  }

  /* ---- where the weight sits ---- */

  /* One dot field per folder, sized by the bytes inside it. A treemap would be
     more precise and less readable; the point of this card is which corner of
     HaTi is heavy, not by exactly how much. */
  function renderTowerMap() {
    var files = (scan.weight && scan.weight.files) || [];
    var html = '<div class="chead"><h3>Where the weight sits</h3></div>';
    if (!files.length) {
      $('towerMap').innerHTML = html + '<div class="note">No file sizes were read this scan.</div>';
      return;
    }

    var byArea = {};
    files.forEach(function (f) {
      var parts = String(f.path).split('/');
      var area = parts.length > 1 ? parts[0] + '/' : f.path;
      byArea[area] = (byArea[area] || 0) + (f.bytes || 0);
    });
    var areas = Object.keys(byArea).map(function (k) { return { name: k, bytes: byArea[k] }; })
      .sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, 6);
    var total = areas.reduce(function (n, a) { return n + a.bytes; }, 0) || 1;

    /* Rows of at most three, each row as tall as its share of the whole and
       each field as wide as its share of its row. Laid out from the numbers
       rather than from fixed coordinates, so two folders fill the box exactly
       as convincingly as six and nothing can collide with a label. */
    var W = 340, LABEL = 13, GAP = 8;
    var rows = [];
    for (var i = 0; i < areas.length; i += 3) rows.push(areas.slice(i, i + 3));
    var bodyH = 150 - (rows.length - 1) * GAP - rows.length * LABEL;

    var rects = '', y = LABEL;
    rows.forEach(function (row) {
      var rowBytes = row.reduce(function (n, a) { return n + a.bytes; }, 0) || 1;
      var h = Math.max(30, Math.round((rowBytes / total) * bodyH));
      var x = 0;
      var usable = W - (row.length - 1) * GAP;
      row.forEach(function (a, j) {
        var w = j === row.length - 1
          ? W - x
          : Math.max(58, Math.round((a.bytes / rowBytes) * usable));
        var share = a.bytes / total;
        var fill = share > 0.3 ? 'dotsL' : share > 0.18 ? 'dotsG' : 'dots';
        rects +=
          '<text x="' + (x + 3) + '" y="' + (y - 4) + '" font-size="10" fill="var(--tx3)" font-family="IBM Plex Mono">' +
          esc(a.name) + ' · ' + kb(a.bytes) + '</text>' +
          '<rect x="' + x + '" y="' + y + '" width="' + Math.max(30, w) + '" height="' + h + '" rx="9" fill="url(#' + fill + ')"/>';
        x += w + GAP;
      });
      y += h + LABEL + GAP;
    });

    html += '<svg viewBox="0 0 ' + W + ' ' + y + '" width="100%" height="' + Math.min(y, 200) + '" role="img" ' +
      'aria-label="Dot map of HaTi\'s weight by folder">' +
      '<defs>' +
      '<pattern id="dots" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.5" fill="var(--tx3)" opacity=".55"/></pattern>' +
      '<pattern id="dotsL" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.5" fill="var(--lav)"/></pattern>' +
      '<pattern id="dotsG" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.5" fill="var(--gold)"/></pattern>' +
      '</defs>' + rects + '</svg>' +
      '<div class="subnum">One dot field per folder, sized by the bytes inside it. Teal is the heaviest corner of HaTi, amber the next.</div>';

    $('towerMap').innerHTML = html;
  }

  /* ---- the whole of HaTi, and its heaviest files ---- */
  function renderTowerWeight() {
    var w = scan.weight;
    var files = (w && w.files) || [];
    var total = files.reduce(function (n, f) { return n + (f.bytes || 0); }, 0);

    var series = trends && trends.points
      ? trends.points.map(function (p) { return p.bytes; }).filter(function (v) { return typeof v === 'number'; }) : [];
    var grew = series.length > 1 ? total - series[0] : null;

    var html = '<div class="statehead"><span class="bignum" style="font-size:26px">' + kb(total) + '</span>' +
      '<button class="iconbtn go" type="button" style="width:30px;height:30px;margin-left:auto" title="Open Getting bulky" aria-label="Open Getting bulky">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg></button></div>' +
      '<div class="subnum" style="margin-bottom:10px">the whole of HaTi, across ' + files.length + ' files' +
      (grew == null ? '' : ' · ' + (grew >= 0 ? 'grew ' : 'shrank ') + kb(Math.abs(grew)) + ' over the log') + '</div>';

    var max = files.length ? files[0].bytes : 1;
    html += '<div class="tfill">' + files.slice(0, 5).map(function (f) {
      var share = f.bytes / max;
      var colour = share > 0.7 ? 'var(--lav)' : share > 0.45 ? 'var(--gold)' : 'var(--tile2)';
      return '<div class="filerow"><span class="sw" style="background:' + colour + '"></span>' +
        '<span class="nm" title="' + esc(f.path) + '">' + esc(f.path) + '</span>' +
        '<span class="kb">' + kb(f.bytes) + '</span></div>';
    }).join('') + '</div>';

    $('towerWeight').innerHTML = html;
    var go = $('towerWeight').querySelector('.go');
    if (go) go.addEventListener('click', function () { showPanel('weight'); });
  }

  function renderTower() {
    renderTowerBurn();
    renderTowerCal();
    renderTowerDoors();
    renderTowerAttention();
    renderTowerGrip();
    renderTowerMap();
    renderTowerWeight();
  }

  /* ---- 1. screens ---- */
  /* ==================================================================== */
  /*  The counter row every redesigned tab opens with                      */
  /*                                                                       */
  /*  The answer arrives before the picture. Each card is a number, a       */
  /*  traffic light saying whether that number is fine, and — where the     */
  /*  Mapper genuinely has an earlier reading to compare against — how it   */
  /*  has moved in a week. Where it has no such reading the arrow is        */
  /*  omitted entirely rather than drawn as a zero, because "no change"     */
  /*  and "nothing to compare with" are different facts.                    */
  /* ==================================================================== */

  /* A reading from roughly a week ago, out of the archive the sparklines
     already use. Null when the archive does not go back that far. */
  function weekAgo(field) {
    var pts = (trends && trends.points) || [];
    var cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    var best = null;
    for (var i = 0; i < pts.length; i++) {
      var v = pts[i][field];
      if (typeof v !== 'number' || !isFinite(v)) continue;
      if (new Date(pts[i].at).getTime() > cutoff) break;
      best = v;
    }
    return best;
  }

  /* The arrow. `worseIsUp` says which direction is bad news, because a rising
     open-door count and a rising grip percentage mean opposite things. */
  function trendChip(field, now, opts) {
    if (typeof now !== 'number' || !isFinite(now)) return '';
    var then = weekAgo(field);
    if (then == null) return '';
    var diff = now - then;
    var o = opts || {};
    if (Math.abs(diff) < (o.epsilon || 0.5)) {
      return '<span class="trend flat" title="Unchanged since a week ago">same as last week</span>';
    }
    var rising = diff > 0;
    var bad = o.worseIsUp === false ? !rising : rising;
    var shown = o.format ? o.format(Math.abs(diff)) : String(Math.round(Math.abs(diff)));
    return '<span class="trend ' + (bad ? 'up' : 'down') + '" title="Against the Mapper’s reading from about a week ago">' +
      (rising ? '▲' : '▼') + ' ' + esc(shown) + '</span>';
  }

  /* One card. `tone` is 'ok' | 'warn' | 'bad' — the same three the tower uses,
     so a colour means one thing everywhere on this page. */
  function sumCard(n, tone, caption, extra) {
    return '<div class="sum"><div class="top">' +
      '<span class="tl' + (tone === 'bad' ? ' bad' : tone === 'warn' ? ' warn' : '') + '"></span>' +
      '<span class="n">' + n + '</span>' + (extra || '') + '</div>' +
      '<div class="cap">' + caption + '</div></div>';
  }

  /* ---- 1. every screen in HaTi ---- */

  var screensSort = 'size';

  function renderScreens() {
    var multiScreen = (scan.moduleFacts || []).filter(function (m) { return m.multiScreen; });
    var multiJob = (scan.moduleFacts || []).filter(function (m) { return m.multiJob; });
    var open = scan.screens.filter(function (s) { return s.entry === 'hash'; });
    var unresolved = scan.screens.filter(function (s) { return !s.module; });
    var shared = scan.screens.filter(function (s) { return (s.sharedWith || []).length; });
    var grip = scan.health && scan.health.percent != null ? scan.health.percent : null;

    $('screensLede').textContent =
      scan.screens.length + ' screens, ' + open.length + ' of them reachable without a login. ' +
      'Grouped by the job they do.';

    /* ---- the four counters ---- */
    $('screensSums').innerHTML =
      sumCard(scan.screens.length, unresolved.length ? 'warn' : 'ok',
        unresolved.length
          ? '<b>' + unresolved.length + ' could not be traced to a file.</b> The rest were found where the menu says they are.'
          : 'Every screen the menu can open was found in a file. Nothing is hiding.',
        unresolved.length ? '' : '<span class="trend flat">all matched</span>') +
      sumCard(open.length, open.length ? 'warn' : 'ok',
        open.length
          ? 'Open without a login: ' + esc(open.map(function (s) { return s.label; }).join(', ')) +
            '. Expected — one more would not be.'
          : 'Nothing works without logging in.',
        trendChip('hashRoutes', open.length, { epsilon: 0.5 })) +
      sumCard(shared.length, shared.length ? 'warn' : 'ok',
        shared.length
          ? 'Screens sharing a file with another screen. Change one, risk the other.'
          : 'No screen shares its file with another. A change to one cannot reach another.') +
      sumCard(grip == null ? '—' : grip + '%', grip == null ? 'warn' : grip < 90 ? 'bad' : grip < 95 ? 'warn' : 'ok',
        'Of this page could be read from HaTi’s own code. Anything it could not read is listed under the gear.',
        trendChip('health', grip, { worseIsUp: false, epsilon: 0.5, format: function (d) { return Math.round(d) + '%'; } }));

    /* ---- the board: HaTi's own menu sections, in HaTi's own order ---- */
    var maxBytes = scan.screens.reduce(function (n, s) { return Math.max(n, s.bytes || 0); }, 0) || 1;
    var groups = scan.screenGroups || [];

    $('screensBoard').innerHTML = groups.map(function (g) {
      var mine = scan.screens.filter(function (s) { return (s.group || 'other') === g.id; });
      return '<div class="gcol"><div class="glab">' + esc(g.label) + '</div>' +
        mine.map(function (s) {
          var isOpen = s.entry === 'hash';
          var w = ((s.bytes || 0) / maxBytes) * 100;
          return '<div class="scard' + (isOpen ? ' open' : '') + '">' +
            '<div class="t">' + esc(s.label) +
            (isOpen ? '<span class="badge gold">no login</span>' : '') +
            ((s.sharedWith || []).length
              ? '<span class="badge" title="This file also draws: ' + esc(s.sharedWith.join(', ')) + '">shares its file</span>'
              : '') +
            '</div>' +
            '<div class="d">' + (s.does ? esc(s.does) : nd()) + '</div>' +
            '<div class="wt" title="' + (s.bytes != null ? esc(kb(s.bytes)) + ' of code behind this screen' : 'size not detected') + '">' +
            '<i style="width:' + w.toFixed(1) + '%"></i></div></div>';
        }).join('') + '</div>';
    }).join('');

    renderScreensTable();

    /* The two facts that need a sentence rather than a shape. They sit under
       the table because they are about files, which is what the table is
       about — not about screens, which is what the board above is about. */
    var bits = [];
    multiScreen.forEach(function (m) {
      bits.push('<div style="margin-bottom:4px"><b>' + esc(m.module.replace(/^js\//, '')) + '</b> backs ' +
        m.screens.length + ' screens — ' + esc(m.screens.join(' and ')) +
        ' — so a change meant for one lands on the other.</div>');
    });
    multiJob.forEach(function (m) {
      bits.push('<div style="margin-bottom:4px"><b>' + esc(m.module.replace(/^js\//, '')) + '</b> carries ' +
        m.sections.length + ' separate jobs in one file, by its own section headings — ' +
        esc(m.sections.map(function (s) { return s.replace(/^VIEW:\s*/, ''); }).join('; ')) +
        ' — across ' + kb(m.bytes) + ' and ' + m.exportCount + ' exported names.</div>');
    });
    if (bits.length) {
      $('screensBody').insertAdjacentHTML('beforeend', '<div class="note"><b>Worth knowing.</b> ' + bits.join('') + '</div>');
    }

    /* Value streams get their own card, because they are a different question
       from "which screen lives where". */
    $('streamsBody').innerHTML =
      '<div style="display:flex;flex-wrap:wrap;gap:8px">' + scan.streams.map(function (s) {
        return '<span class="stream2" title="' + esc(s.desc) + '"><i style="background:' + esc(s.color) + '"></i>' +
          esc(s.name.split(/\s*[&(]/)[0].trim()) + '</span>';
      }).join('') + '</div>' +
      (scan.customStreamsNote ? '<div class="note">' + esc(scan.customStreamsNote) + '</div>' : '');
    $('streamsCard').hidden = false;
  }

  /* The table under the board. Same fields it has always carried; the size
     column is drawn as a bar as well as written, so "which is the heavy one"
     is answered by looking rather than by reading five numbers. */
  function renderScreensTable() {
    var list = scan.screens.slice();
    var order = (scan.screenGroups || []).map(function (g) { return g.id; });
    if (screensSort === 'size') {
      list.sort(function (a, b) { return (b.bytes || 0) - (a.bytes || 0); });
    } else if (screensSort === 'az') {
      list.sort(function (a, b) { return String(a.label).localeCompare(String(b.label)); });
    } else {
      list.sort(function (a, b) {
        var d = order.indexOf(a.group || 'other') - order.indexOf(b.group || 'other');
        return d !== 0 ? d : (b.bytes || 0) - (a.bytes || 0);
      });
    }
    var max = list.reduce(function (n, s) { return Math.max(n, s.bytes || 0); }, 0) || 1;

    $('screensBody').innerHTML =
      '<table class="tbl"><thead><tr><th style="width:190px">Screen</th><th>What a person does here</th>' +
      '<th style="width:160px">Lives in</th><th style="width:180px">Size</th></tr></thead><tbody>' +
      list.map(function (s) {
        var flags = '';
        if ((s.sharedWith || []).length) {
          flags += ' <span class="badge" title="This file also draws: ' + esc(s.sharedWith.join(', ')) + '">shares its file</span>';
        }
        if (s.entry === 'hash') flags += ' <span class="badge gold" title="Reached by a URL hash, not a menu button">no login</span>';
        /* A screen whose file is drawn by another screen higher up the table
           says so rather than repeating the same bar and the same number. */
        var dupe = s.bytes != null && (s.sharedWith || []).length &&
          list.some(function (o) { return o !== s && o.module === s.module && list.indexOf(o) < list.indexOf(s); });
        return '<tr>' +
          '<td><b>' + esc(s.label) + '</b>' + flags + '</td>' +
          '<td class="dim">' + (s.does ? esc(s.does) : nd()) + '</td>' +
          '<td>' + (s.module ? '<span class="codechip">' + esc(s.module.replace(/^js\//, '')) + '</span>' : nd()) + '</td>' +
          '<td>' + (s.bytes == null
            ? '<span class="nd">—</span>'
            : dupe
              ? '<span class="nd">shares the file above</span>'
              : '<div style="display:flex;align-items:center;gap:9px">' +
                '<div class="mbar" style="flex:1;height:8px"><i style="width:' + (((s.bytes / max) * 100).toFixed(1)) + '%"></i></div>' +
                '<span class="mono" style="font-size:12px;white-space:nowrap">' + esc(kb(s.bytes)) + '</span></div>') +
          '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  $('screensSort').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-s]');
    if (!b || !scan) return;
    screensSort = b.getAttribute('data-s');
    this.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    renderScreensTable();
  });

  /* ---- 2. where the money goes ---- */

  /* Money, at the precision the number deserves. A fifth of a cent shown as
     "$0.01" would round a real difference away. */
  function usd(n) {
    if (n == null) return null;
    if (n >= 100) return '$' + Math.round(n).toLocaleString('en-GB');
    if (n >= 1) return '$' + n.toFixed(2);
    if (n >= 0.01) return '$' + n.toFixed(3);
    return '$' + n.toFixed(4);
  }

  function costFor(feature) {
    var c = scan.cost;
    if (!c) return null;
    return c.features.filter(function (x) { return x.feature === feature; })[0] || null;
  }

  function renderCost() {
    renderMoneyRoof();
    renderMoneyWeek();
    renderMoneyTrust();
    renderMoneyFeatures();
    renderMoneySplit();
    renderCaps();
  }

  /* ---- the headline: the most today could cost, and how much is used ----

     The day's ceiling used to be the first sentence of a paragraph under the
     table. It is the number the whole panel exists to give, so it leads. */
  function renderMoneyRoof() {
    var c = scan.cost || {};
    var live = pulse && pulse.available && pulse.usage;
    var html = '<div class="chead"><h3>The most today could cost</h3>' +
      trendChip('dailyCostUsd', c.dailyCeilingUsd, {
        epsilon: 0.005,
        format: function (d) { return usd(d).replace('$', '$') + ' on last week'; },
      }).replace('<span class="trend', '<span style="margin-left:auto" class="trend') + '</div>';

    if (c.dailyCeilingUsd == null) {
      html += '<div class="note"><b>A daily total could not be worked out.</b> ' +
        'That needs both a daily request limit in HaTi’s code and a price on file for at least one model it uses. ' +
        'Nothing is guessed in its place.</div>';
      $('moneyRoof').innerHTML = html;
      return;
    }

    html += '<div class="bignum">' + esc(usd(c.dailyCeilingUsd)) + '</div>' +
      '<div class="cap" style="font-size:12.5px;color:var(--tx2);margin-top:8px;line-height:1.5">' +
      'If all ' + num(c.dailyLimit) + ' of today’s allowed requests were the dearest kind (' + esc(c.dearest || 'unknown') + ').' +
      (c.dailyMixedUsd != null
        ? ' Spread evenly across the features it is nearer <b>' + esc(usd(c.dailyMixedUsd)) + '</b>.'
        : '') + '</div>';

    /* Used so far today. This is the one figure on the panel that is a real
       count rather than a ceiling, and it only exists when HaTi is answering. */
    if (live && pulse.usage.dailyLimit) {
      var used = pulse.usage.count || 0;
      var lim = pulse.usage.dailyLimit;
      var frac = Math.min(used / lim, 1);
      html += '<div style="margin-top:16px;display:flex;align-items:baseline;gap:10px;font-size:11.5px;color:var(--tx3)">' +
        '<span>Used so far today</span>' +
        '<span style="margin-left:auto" class="mono">' + num(used) + ' of ' + num(lim) + ' requests</span></div>' +
        '<div class="mbar" style="height:9px;margin-top:6px"><i class="' + (frac > 0.7 ? 'over' : '') +
        '" style="width:' + (frac * 100).toFixed(1) + '%"></i></div>' +
        (c.dailyCeilingUsd != null
          ? '<div class="barnote">About <b>' + esc(usd(c.dailyCeilingUsd * frac)) + '</b> of the roof used.</div>'
          : '');
    } else {
      html += '<div class="note" style="margin-top:14px">Counting what has actually been used today needs a running HaTi to ask. ' +
        esc((pulse && pulse.reason) || 'The Mapper could not reach it.') + '</div>';
    }
    $('moneyRoof').innerHTML = html;
  }

  /* ---- the week in bars, from the readings the archive already holds ---- */
  function renderMoneyWeek() {
    var pts = ((trends && trends.points) || [])
      .filter(function (p) { return typeof p.dailyCostUsd === 'number' && isFinite(p.dailyCostUsd); })
      .slice(-7);

    var html = '<div class="chead"><h3>The last seven days</h3>' +
      '<span class="sublab" style="margin-left:auto">daily ceiling</span></div>';

    if (pts.length < 2) {
      html += '<div class="note">The Mapper records one reading each time a scan finds something different, and it has ' +
        pts.length + '. A week of bars fills in after a few days of scanning.</div>';
      $('moneyWeek').innerHTML = html;
      return;
    }

    var top = Math.max.apply(null, pts.map(function (p) { return p.dailyCostUsd; })) || 1;
    var dearestIdx = pts.reduce(function (bi, p, i) { return p.dailyCostUsd > pts[bi].dailyCostUsd ? i : bi; }, 0);

    html += '<div class="days7">' + pts.map(function (p, i) {
      var isNow = i === pts.length - 1;
      var h = Math.max(6, (p.dailyCostUsd / top) * 100);
      var d = new Date(p.at);
      return '<div class="d7' + (isNow ? ' now' : i === dearestIdx ? ' top' : '') + '" title="' +
        esc(fmtDate(p.at, true)) + ' — ' + esc(usd(p.dailyCostUsd)) + ' a day at the caps">' +
        '<i style="height:' + h.toFixed(1) + '%"></i>' +
        '<span>' + esc(isNow ? 'now' : d.toLocaleString('en-GB', { weekday: 'short' })) + '</span></div>';
    }).join('') + '</div>';

    html += '<div class="barnote">' +
      (dearestIdx === pts.length - 1
        ? 'The latest reading is the highest of the seven.'
        : esc(fmtDate(pts[dearestIdx].at)) + ' carried the highest ceiling of the seven, at ' +
          esc(usd(pts[dearestIdx].dailyCostUsd)) + ' a day.') +
      ' Each bar is what a whole day at HaTi’s caps would have cost on that reading — not what was spent.</div>';
    $('moneyWeek').innerHTML = html;
  }

  /* ---- can these numbers be trusted? ----

     Three facts that decide whether anything else on this panel means what it
     says: how old the price list is, whether any model in use has no price at
     all, and whether the caps came from the running product or from its code.
     All three existed already, as clauses in a paragraph nobody read. */
  function renderMoneyTrust() {
    var c = scan.cost || {};
    var live = pulse && pulse.available;
    var rows = '';

    var ageTone = c.stale ? 'warn' : 'ok';
    rows += '<div class="trust"><span class="tl ' + ageTone + '"></span><div class="bd">' +
      '<b>Prices checked ' + (c.ageDays == null ? 'at an unknown date' : c.ageDays + ' day' + (c.ageDays === 1 ? '' : 's') + ' ago') + '</b>' +
      '<span>' + (c.stale
        ? 'Written down by hand and good for 90 days. These are past that, so they may be out of date.'
        : 'They are written down by hand in data/pricing.js and good for 90 days.') + '</span></div></div>';

    var noPrice = (c.modelsWithoutPrice || []);
    rows += '<div class="trust"><span class="tl ' + (noPrice.length ? 'warn' : 'ok') + '"></span><div class="bd">' +
      '<b>' + (noPrice.length
        ? noPrice.length + ' model' + (noPrice.length === 1 ? ' has' : 's have') + ' no price on file'
        : 'Every model in use has a price on file') + '</b>' +
      '<span>' + (noPrice.length
        ? esc(noPrice.join(', ')) + ' — nothing is guessed for ' + (noPrice.length === 1 ? 'it' : 'them') + ', so any feature using ' +
          (noPrice.length === 1 ? 'it' : 'them') + ' shows no figure at all.'
        : 'Nothing on this panel is an unpriced guess.') + '</span></div></div>';

    rows += '<div class="trust"><span class="tl ' + (live ? 'ok' : 'warn') + '"></span><div class="bd">' +
      '<b>' + (live ? 'Caps read from the live site' : 'Caps read from the code, not the live site') + '</b>' +
      '<span>' + (live
        ? esc(fmtDate(pulse.fetchedAt, true)) + ', from build ' + esc(pulse.version || 'unknown') + '.'
        : esc((pulse && pulse.reason) || 'The Mapper could not reach the running HaTi.') +
          ' The figures below are HaTi’s code defaults, which may not be what is running.') + '</span></div></div>';

    $('moneyTrust').innerHTML = '<div class="chead"><h3>Can these numbers be trusted?</h3></div>' + rows +
      '<div class="barnote" style="margin-top:10px">' + esc(c.assumption || '') + '</div>';
  }

  /* ---- every feature, dearest first ----

     One row per feature rather than two: the "Used by" line that used to be a
     second table row is folded into the row it belongs to. */
  function renderMoneyFeatures() {
    var priced = scan.ai.features.map(function (f) {
      var c = costFor(f.feature);
      return { f: f, c: c, per: c && c.perRequestUsd != null ? c.perRequestUsd : null };
    }).sort(function (a, b) {
      if (a.per == null && b.per == null) return 0;
      if (a.per == null) return 1;
      if (b.per == null) return -1;
      return b.per - a.per;
    });

    var top = priced.reduce(function (n, x) { return Math.max(n, x.per || 0); }, 0) || 1;

    var html = priced.map(function (x) {
      var f = x.f, c = x.c;
      var used = f.usedBy.length
        ? 'Used on ' + esc(f.usedBy.map(function (s) { return callSiteName(s); })
          .filter(function (v, i, a) { return a.indexOf(v) === i; }).join(' and '))
        : '<span style="color:var(--badtx)">Nothing on the front end calls this</span>';

      var barW = x.per == null ? 6 : Math.max(3, (x.per / top) * 100);
      var barCls = x.per == null ? 'none' : (f.tiers.indexOf('deep') > -1 ? 'over' : '');

      return '<div class="rank">' +
        '<div class="rwho"><b>' + esc(f.label || f.feature) + '</b>' +
        '<div class="d">' + used + '</div>' +
        '<div class="m"><span class="codechip">' + esc(f.route) + '</span>' +
        '<span style="font-size:11px;color:var(--tx3)">' +
        (f.cap == null ? 'no cap detected' : 'capped at ' + num(f.cap) + ' per ' + (scan.ai.windowMinutes || 15) + ' min') +
        '</span></div></div>' +
        '<div><div class="mbar" style="height:10px"><i class="' + barCls + '" style="width:' + barW.toFixed(1) + '%"></i></div>' +
        '<div class="barnote">' +
        (f.tiers.length
          ? f.tiers.map(function (t) { return '<span class="badge ' + (t === 'deep' ? 'gold' : 'lav') + '">' + esc(t) + '</span>'; }).join(' ')
          : nd()) +
        ' <span class="mono" style="margin-left:6px">' + (f.models.length ? esc(f.models.join(' / ')) : esc('model not detected')) + '</span>' +
        '</div></div>' +
        '<div class="amt">' +
        (x.per == null
          ? '<span class="nd">' + (c && c.unpricedModels.length ? 'no price' : 'no ceiling') + '</span>' +
            (f.usedBy.length ? '' : '<div style="margin-top:5px">' + fixButton('ai-unused', f.feature) + '</div>')
          : '<span class="v">' + esc(usd(x.per)) + '</span>' +
            (c.perWindowUsd != null ? '<span class="s">' + esc(usd(c.perWindowUsd)) + ' at the cap</span>' : '') +
            (f.usedBy.length ? '' : '<div style="margin-top:5px">' + fixButton('ai-unused', f.feature) + '</div>')) +
        '</div></div>';
    }).join('');

    if (scan.ai.nonBillingAiRoutes && scan.ai.nonBillingAiRoutes.length) {
      html += '<div class="note">Another ' + scan.ai.nonBillingAiRoutes.length + ' route' +
        (scan.ai.nonBillingAiRoutes.length === 1 ? '' : 's') + ' under <code>/api/ai/</code> never call Anthropic — ' +
        'they read and set configuration, so they cost nothing: ' +
        scan.ai.nonBillingAiRoutes.map(function (r) { return '<span class="codechip">' + esc(r.label || r.path) + '</span>'; }).join(' ') + '.</div>';
    }
    $('costBody').innerHTML = html;
  }

  /* ---- where the spend sits ----

     Which features the ceiling is actually made of. Weighted by what one use
     costs times what the cap allows, because a cheap feature nobody may call
     often is not where the money is. */
  function renderMoneySplit() {
    var parts = scan.ai.features.map(function (f) {
      var c = costFor(f.feature);
      var weight = c && c.perWindowUsd != null ? c.perWindowUsd
        : (c && c.perRequestUsd != null ? c.perRequestUsd : 0);
      return { label: f.label || f.feature, weight: weight };
    }).filter(function (p) { return p.weight > 0; })
      .sort(function (a, b) { return b.weight - a.weight; });

    var total = parts.reduce(function (n, p) { return n + p.weight; }, 0);
    if (!total || parts.length < 2) { $('moneySplitCard').hidden = true; return; }
    $('moneySplitCard').hidden = false;

    /* Everything past the top three is one slice: a legend of nine features is
       not a picture of anything. */
    var shown = parts.slice(0, 3);
    var restW = parts.slice(3).reduce(function (n, p) { return n + p.weight; }, 0);
    if (restW > 0) shown.push({ label: 'Everything else', weight: restW, rest: true });

    var COLOURS = ['var(--gold)', 'var(--lav)', 'var(--lavd)', 'var(--tile2)'];
    $('moneySplit').innerHTML =
      '<div class="split">' + shown.map(function (p, i) {
        return '<i style="width:' + ((p.weight / total) * 100).toFixed(1) + '%;background:' + COLOURS[i] + '"></i>';
      }).join('') + '</div>' +
      '<div class="legend">' + shown.map(function (p, i) {
        return '<div class="lg"><i style="background:' + COLOURS[i] + '"></i>' + esc(p.label) +
          '<span class="p">' + Math.round((p.weight / total) * 100) + '%</span></div>';
      }).join('') + '</div>' +
      '<div class="barnote" style="margin-top:10px">Shares of the ceiling, not of a bill — each feature weighted by what one use costs times what its own rate limit allows.</div>';
  }

  /* Name a screen rather than a file path wherever possible. A view module is
     its screen; a shared module is named by the screens that reach it. */
  function screenNameFor(modulePath) {
    var hit = scan.screens.filter(function (s) { return s.module === modulePath; });
    if (hit.length) return hit.map(function (s) { return s.label; }).join(' / ');
    return modulePath.replace(/^js\//, '');
  }

  function callSiteName(site) {
    if (site.via && site.via.length) {
      var screens = site.via.map(screenNameFor).filter(function (v, i, a) { return a.indexOf(v) === i; });
      return screens.join(', ');
    }
    return screenNameFor(site.module);
  }

  /* The one panel that needs a running HaTi. If the pulse is unavailable it
     falls back to the code defaults with a plain note — it never blanks. */
  function renderCaps() {
    var live = pulse && pulse.available;
    var caps = scan.ai.caps;
    var lede = $('capsLede');
    var html = '';

    /* The badge beside the heading answers the question the numbers cannot:
       are these the values running right now, or the defaults in the code? */
    var flag = $('capsLive');
    flag.className = 'badge ' + (live ? 'good' : 'gold');
    flag.textContent = live ? 'live' : 'from the code';

    if (!live) {
      var why = (pulse && pulse.reason) || 'The Mapper could not reach the running HaTi.';
      lede.innerHTML = '<b>Showing code defaults, not live values.</b> ' + esc(why) +
        ' Everything else on this page is read from HaTi\u2019s source and is unaffected.';
    } else {
      lede.innerHTML = 'Set in Team &amp; Settings. These are the values live on this workspace, not the defaults. ' +
        'Read from the running HaTi at ' + esc(fmtDate(pulse.fetchedAt, true)) +
        ', build <code>' + esc(pulse.version || 'unknown') + '</code>. ' +
        'That endpoint returns caps and counts only \u2014 no contract, party or user data of any kind crosses it.';
    }

    html += caps.map(function (c) {
      var value = live && pulse.caps && pulse.caps[c.key] != null ? pulse.caps[c.key] : c.codeDefault;
      var suffix = c.key === 'aiMaxChars' ? ' chars' : (c.key === 'aiDailyLimit' ? ' requests' : '');
      var differs = live && pulse.caps && pulse.caps[c.key] != null && c.codeDefault != null && pulse.caps[c.key] !== c.codeDefault;
      return '<div class="caprow"><div class="bd"><b>' + esc(c.label) + '</b>' +
        '<span>' + esc(c.note) + (differs ? ' \u00b7 code default ' + num(c.codeDefault) : '') + '</span></div>' +
        '<span class="v">' + (value == null ? nd() : num(value) + suffix) + '</span></div>';
    }).join('');

    /* What was actually used today now leads the panel, on the headline card,
       so it is not repeated here as one row among the settings. */

    if (live) {
      html += '<div class="caprow"><div class="bd"><b>AI key configured</b>' +
        '<span>Whether a provider key is set \u2014 the key itself never leaves HaTi.</span></div>' +
        '<span class="badge ' + (pulse.aiKeyConfigured ? 'good' : 'gold') + '">' +
        (pulse.aiKeyConfigured ? 'yes' : 'no') + '</span></div>';
    }

    /* The tap that actually moves the ceiling, and by how much. A cap is only
       useful if you can see what turning it down would buy you. */
    var c = scan.cost || {};
    if (c.dailyCeilingUsd != null && c.dailyLimit) {
      var halved = c.dailyCeilingUsd / 2;
      var busiest = null;
      (trends && trends.points ? trends.points : []).forEach(function (p) {
        if (typeof p.dailyCostUsd === 'number') busiest = Math.max(busiest == null ? 0 : busiest, p.dailyCostUsd);
      });
      html += '<div class="note">Halving the daily limit would put the worst case at <b>' + esc(usd(halved)) + '</b>. ' +
        (live && pulse.usage && pulse.usage.count != null
          ? 'Today\u2019s count so far is ' + num(pulse.usage.count) + ' of ' + num(c.dailyLimit) + '.'
          : 'What has actually been used needs a running HaTi to count, so this is the roof rather than the reality.') +
        '</div>';
    }

    $('capsBody').innerHTML = html;
  }


  /* ---- 3. where things are kept ----

     A card per table rather than a row per table. A table of tables reads like
     a database tool; each card leads with what the thing holds, in a sentence,
     and demotes the file and line to the corner where an address belongs. */
  function renderData() {
    var st = scan.storage;
    var cols = st.tables.reduce(function (n, t) { return n + t.columns.length; }, 0);
    var blobs = st.blobs || [];

    /* Tables that changed shape lately, from the Mapper's own change log — the
       one figure on this panel that is an observation rather than a reading. */
    var schemaMoves = 0;
    ((towerWatch && towerWatch.rounds) || []).forEach(function (r) {
      (r.events || []).forEach(function (e) { if (e.kind === 'data') schemaMoves++; });
    });

    $('dataSums').innerHTML =
      sumCard(st.tables.length, 'ok', 'Tables, all in one file on the server.') +
      sumCard(cols, 'ok', 'Columns between them — the shape of everything HaTi remembers.') +
      sumCard(blobs.length, blobs.length ? 'bad' : 'ok',
        blobs.length
          ? 'Place' + (blobs.length === 1 ? '' : 's') + ' storing something big inside a single row.'
          : 'Nothing is stored as a whole collection inside one row.') +
      sumCard(schemaMoves, schemaMoves ? 'warn' : 'ok',
        schemaMoves
          ? 'Times a table changed shape in what the Mapper has watched.'
          : 'Tables have changed shape in what the Mapper has watched.');

    var html = '';

    /* The one finding on this panel, out of a footnote and into a red card
       with the button that does something about it. */
    if (blobs.length) {
      html += blobs.map(function (b) {
        return '<div class="warncard"><span class="ic">' + ICON_WARN + '</span><div class="bd">' +
          '<b>' + esc(sentenceCase(b.field)) + ' is all kept inside one row</b>' +
          '<div class="d">' + esc(b.note) +
          (st.rewritesWholeRecord ? ' The settings route writes the whole record back on every save, so this is not theoretical.' : '') +
          ' Fine at two. Not fine at thirty with version history — saves get slower and slower, and one bad save takes all of them. ' +
          '<code>server/server.js:' + b.line + '</code></div></div>' +
          '<span style="flex:none">' + fixButton('gap', b.note) + '</span></div>';
      }).join('');
    }

    html += '<div class="tcards">' + st.tables.map(function (t) {
      var blob = blobs.filter(function (b) { return t.name === 'settings' && b.record; })[0];
      var shown = t.columns.slice(0, 8);
      var rest = t.columns.length - shown.length;
      return '<div class="tcard"><div class="h">' +
        '<b>' + esc(sentenceCase(t.name)) + '</b>' +
        '<span class="sub">' + t.columns.length + ' column' + (t.columns.length === 1 ? '' : 's') + '</span>' +
        '<span class="src">server.js:' + t.line + '</span></div>' +
        '<div class="say">' + (t.holds ? esc(t.holds) : nd('no plain-English note yet')) +
        (blob ? ' <b>Including ' + esc(blob.field) + ', in full.</b>' : '') + '</div>' +
        '<div class="chips">' + shown.map(function (c) {
          return '<span class="codechip">' + esc(c) + '</span>';
        }).join('') + (rest > 0 ? '<span class="codechip">+ ' + rest + ' more</span>' : '') + '</div></div>';
    }).join('') + '</div>';

    if (st.settingKeys && st.settingKeys.length) {
      html += '<div class="note">The <code>settings</code> table is a name-and-value store. ' +
        'The names written to it are: ' + st.settingKeys.map(function (k) { return '<span class="codechip">' + esc(k) + '</span>'; }).join(' ') + '.</div>';
    }
    $('dataBody').innerHTML = html;
  }

  /* ---- 4. what breaks what ---- */
  var currentPick = null;
  /* The picking and the lighting-up are unchanged — same picks, same
     on/risk/off states. What changed is the shape around them: the tiles are
     grouped into HaTi's three parts so the grid reads as an anatomy rather
     than an alphabet, the two counts come before the picture, and the sentence
     the whole panel exists to deliver is a card rather than a grey footnote. */
  function renderBlast() {
    var d = scan.dependencies;
    var groups = (d.groups || []).length
      ? d.groups
      : [{ id: null, title: 'Everything that reads HaTi’s data' }];

    var html =
      '<div class="blastwrap">' +
      '<div class="card" style="margin:0">' +
      '<div class="glab">If I change…</div>' +
      '<div class="picks2" id="picks">' +
      d.items.map(function (it, i) {
        return '<button class="pick2" type="button" aria-pressed="' + (i === 0) + '" data-k="' + esc(it.key) + '">' + esc(it.label) +
          '<small>' + esc((it.fields || []).join(' · ')) + '</small></button>';
      }).join('') +
      '</div></div>' +

      '<div><div class="trio" id="blastCounts"></div>' +
      '<div class="card">' +
      '<div class="board" style="align-items:start">' +
      groups.map(function (g) {
        var mine = d.subsystems.filter(function (s) { return g.id == null || s.group === g.id; });
        return '<div class="gcol"><div class="glab">' + esc(g.title) + '</div>' +
          mine.map(function (s) {
            return '<div class="dep2" data-d="' + esc(s.id) + '"><div class="t">' + esc(s.title) + '</div>' +
              '<div class="d">' + esc(s.desc) + '</div></div>';
          }).join('') + '</div>';
      }).join('') +
      '</div></div>' +
      '<div id="blastNote"></div>' +
      '</div></div>';

    if (d.warnings && d.warnings.length) {
      html += '<div class="note"><b>This map is out of date in ' + d.warnings.length + ' place' + (d.warnings.length === 1 ? '' : 's') + '.</b><ul style="margin:6px 0 0;padding-left:18px">' +
        d.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>';
    }
    html += '<div class="note">These relationships are judgements about meaning, not something a parser can read out of code, so they are written by hand in <code>' +
      esc(d.source) + '</code>. Every subsystem, group and field named above is checked against HaTi’s source on each scan; anything stale is listed rather than quietly shown as fact.</div>';

    $('blastBody').innerHTML = html;

    var picks = $('blastBody').querySelectorAll('.pick2');
    picks.forEach(function (p) {
      p.addEventListener('click', function () {
        picks.forEach(function (x) { x.setAttribute('aria-pressed', String(x === p)); });
        applyBlast(p.getAttribute('data-k'));
      });
    });
    if (d.items.length) applyBlast(d.items[0].key);
  }

  function applyBlast(key) {
    var item = scan.dependencies.items.filter(function (i) { return i.key === key; })[0];
    if (!item) return;
    currentPick = key;
    var risk = item.risk || [], on = item.reads || [];
    $('blastBody').querySelectorAll('.dep2').forEach(function (d) {
      var id = d.getAttribute('data-d');
      var isRisk = risk.indexOf(id) > -1;
      var isOn = isRisk || on.indexOf(id) > -1;
      d.classList.toggle('on', isOn);
      d.classList.toggle('risk', isRisk);
      d.classList.toggle('off', !isOn);
    });

    /* The answer, before the picture that evidences it. */
    var reads = on.length, breaks = risk.length;
    $('blastCounts').innerHTML =
      '<div class="sum"><div class="top"><span class="n">' + reads + '</span></div>' +
      '<div class="cap">part' + (reads === 1 ? '' : 's') + ' of HaTi read this. Change it and every one of them has to be checked.</div></div>' +
      '<div class="sum"><div class="top"><span class="tl' + (breaks ? ' bad' : '') + '"></span>' +
      '<span class="n">' + breaks + '</span></div>' +
      '<div class="cap">' + (breaks
        ? 'of them can break something <b>already signed</b>.'
        : 'of them can break anything already signed.') + '</div></div>' +
      '<div class="sum"><div class="keyline" style="margin:0;flex-direction:column;align-items:flex-start;gap:7px">' +
      '<span><span class="sw" style="background:var(--lav)"></span>reads it</span>' +
      '<span><span class="sw" style="background:var(--bad)"></span>can break a signed contract</span>' +
      '<span><span class="sw" style="background:var(--tile2)"></span>not affected</span>' +
      '</div></div>';

    /* Promoted out of a grey footnote. It is the sentence the whole panel
       exists to deliver, and where the change can reach something already
       signed it is carried in red. */
    $('blastNote').innerHTML = breaks
      ? '<div class="warncard" style="margin:14px 0 0"><span class="ic">' + ICON_WARN + '</span>' +
        '<div class="bd"><div class="d" style="margin:0">' + item.note + '</div></div></div>'
      : '<div class="card" style="margin:14px 0 0"><div style="font-size:12.5px;color:var(--tx2);line-height:1.6">' +
        item.note + '</div></div>';
  }

  /* ---- 5. not finished ---- */

  function gapRow(x) {
    var cls = x.severity === 'high' ? ' hi' : x.severity === 'medium' ? ' md' : '';
    var title = x.severity ? 'Severity: ' + x.severity : 'The source does not state a severity';
    return '<div class="gline"><span class="dot' + cls + '" title="' + esc(title) + '"></span>' +
      '<div><b>' + esc(x.title) + (x.marker ? ' <span class="badge">' + esc(x.marker) + '</span>' : '') + '</b>' +
      '<span>' + esc(x.source) + (x.severity ? ' · marked ' + esc(x.severity) : '') +
      (x.detail ? ' · ' + esc(x.detail) : '') + '</span></div>' +
      '<span style="margin-left:auto;flex:none">' + fixButton('gap', x.title) + '</span></div>';
  }

  function renderGaps() {
    var g = scan.gaps;
    var html = '';

    /* The ones the documents rank, in full, with the fix button on its own at
       the end of the row rather than trailing the source line — it is an
       action, and reading it as part of a sentence is how it got missed. */
    var ranked = g.gaps.filter(function (x) { return !!x.severity; });
    var unranked = g.gaps.filter(function (x) { return !x.severity; });

    html += ranked.map(gapRow).join('');

    /* Everything the documents say nothing about, collapsed into one line.
       Listing twenty unranked gaps at the same weight as three ranked ones
       buries the three. */
    if (unranked.length) {
      html += '<div class="gline"><span class="dot"></span><div>' +
        '<b>' + unranked.length + ' more with no severity stated</b>' +
        '<span>Kept in the order the documents list them — nothing is guessed. ' +
        '<button class="showall" type="button" data-act="gaps">Show them</button></span>' +
        '</div></div><div id="unrankedGaps" hidden>' + unranked.map(gapRow).join('') + '</div>';
    }

    if (g.markerNote) html += '<div class="note">' + esc(g.markerNote) + '</div>';

    /* How the list has moved lately — the one thing on this panel that comes
       from the Mapper's own archive rather than from HaTi's source. */
    var mv = scan.gapMovement;
    if (mv && (mv.opened || mv.closed)) {
      html += '<div class="note"><b>' +
        (mv.closed ? mv.closed + ' closed' : 'None closed') +
        ', ' + (mv.opened ? mv.opened + ' opened' : 'none opened') +
        ' in the last ' + mv.days + ' days.</b> Counted from the change log, so it only covers the time the Mapper has been watching.</div>';
    } else if (mv) {
      html += '<div class="note">Nothing on this list has opened or closed in the last ' + mv.days +
        ' days' + (mv.watchedSince ? ', across the looks the Mapper has taken since ' + esc(fmtDate(mv.watchedSince)) : '') + '.</div>';
    }

    if (g.ranked) {
      var sc = g.severityCounts;
      html += '<div class="note">Ranked by the severity the documents state: ' +
        sc.high + ' high, ' + sc.medium + ' medium, ' + sc.low + ' low' +
        (sc.unstated ? ', and ' + sc.unstated + ' that say nothing — those keep their source order underneath' : '') + '.</div>';
    } else {
      html += '<div class="note">None of these sources states a severity, so none is shown. ' +
        'The order is the order the sources list them in, not a ranking. ' +
        'To rank them, start a bullet in HaTi’s README or SECURITY.md with <code>[high]</code>, ' +
        '<code>[medium]</code> or <code>[low]</code> — nothing else needs to change here.</div>';
    }
    $('gapsBody').innerHTML = html;
  }

  /* ---- 6. the doors ----

     One list, not two. The code's claim about a door and what the live site
     actually did when knocked on are two halves of one fact, and showing them
     in separate cards meant reading the same twelve addresses twice and doing
     the join in your head. They are joined here on the address — the same
     "METHOD /path" string lib/doors.mjs builds — so a disagreement between
     the two is a single row that cannot be missed. */

  var doorsFilter = 'all';

  /* What the code alone says about one route. */
  function routeClaim(r) {
    var qual = [];
    if (r.servesShell) qual.push('serves the app shell, no data');
    if (r.tokenGuarded) qual.push('checks its own secret in the handler');
    if (r.tokenInPath) qual.push('needs an unguessable code in the link');
    if (r.middleware.length) qual.push('rate limited by ' + r.middleware.join(', '));
    return { qual: qual, bare: !qual.length };
  }

  /* Every door, from both sources, with the live verdict attached where there
     is one. Nothing here is invented: a door that has never been knocked on
     says so rather than being assumed fine. */
  function doorList() {
    var p = scan.public || { routes: [], hashes: [] };
    var last = doorsResult;
    var byAddress = {};
    var skipped = {};
    if (last) {
      (last.results || []).forEach(function (r) { byAddress[r.address] = r; });
      (last.skipped || []).forEach(function (s) { skipped[s.address] = s; });
    }

    var out = [];

    p.hashes.forEach(function (h) {
      out.push({
        kind: 'hash',
        title: h.label || (h.hash + '=…'),
        claim: (h.detail || 'The scan could not read what this one does.') +
          (h.beforeSession ? ' Handled in js/app.js:' + h.line + ', before the session is checked.' : ''),
        address: null, where: 'js/app.js:' + h.line,
        chip: h.hash + '=…',
        bare: false, result: null, skipped: null,
      });
    });

    p.routes.forEach(function (r) {
      var address = r.method + ' ' + r.path;
      var c = routeClaim(r);
      out.push({
        kind: 'route',
        /* The title says which of the two kinds of door this is; the line
           under it says what actually guards it. Making the title the first
           guard made both lines identical whenever there was only one. */
        title: c.bare ? 'Nothing guards this address' : 'Open by design',
        claim: c.bare
          ? 'Nothing in the handler checks who is asking — no login, no secret, no rate limit the scan could find.'
          : sentenceCase(c.qual.join('; ')) + '.',
        address: address, where: 'server/server.js:' + r.line,
        chip: address,
        bare: c.bare,
        result: byAddress[address] || null,
        skipped: skipped[address] || null,
      });
    });

    return out;
  }

  function sentenceCase(s) {
    var t = String(s || '');
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  /* Surprises first, then anything the code leaves unguarded, then the rest.
     A door that disagreed with its own code is the only thing on this panel
     that could need doing something about tonight. */
  function doorWeight(d) {
    var v = d.result && d.result.verdict;
    if (v === 'unexpected-data' || v === 'needs-login') return 0;
    if (v === 'missing' || v === 'error') return 1;
    if (d.bare) return 2;
    if (v === 'unreachable') return 3;
    return 4;
  }

  function renderPublic() {
    var p = scan.public;
    $('publicLede').textContent =
      p.routes.length + ' of HaTi’s ' + p.totalRoutes + ' server routes carry no login check, and ' +
      p.hashes.length + ' URL hashes are handled before any session exists. ' +
      'Short list by design — if it grows, that is the finding.';
    renderDoorsPanel();
  }

  /* The three counters, the list, and the button that knocks. All three read
     the same array, so they cannot disagree with each other. */
  function renderDoorsPanel() {
    if (!scan) return;
    var doors = doorList();
    var last = doorsResult;
    var surprises = doors.filter(function (d) { return doorWeight(d) <= 1; });
    var asWritten = doors.filter(function (d) { return d.result && d.result.verdict === 'as-expected'; });
    var state = doorsState || {};

    /* Card 1 — the only one that can be urgent. */
    var c1 = surprises.length
      ? '<div class="sum" style="background:var(--bad);border-color:transparent">' +
        '<div class="top"><span class="tl bad"></span><span class="n" style="font-size:19px;color:var(--badtx)">' +
        surprises.length + ' door' + (surprises.length === 1 ? '' : 's') + ' behaved worse than the code says</span></div>' +
        '<div class="cap" style="color:var(--badtx)">' +
        esc(surprises.map(function (d) { return d.result ? d.result.says : ''; }).filter(Boolean)[0] || '') + '</div></div>'
      : sumCard(last ? asWritten.length : doors.length, last ? 'ok' : 'warn',
        last
          ? 'Doors behaved exactly as written. Nothing answered that should not have.'
          : 'Doors the code says are open. Nobody has knocked on them yet, so this is a promise rather than a fact.');

    /* Card 2 — the shape of the whole set at a glance. */
    var c2 = '<div class="sum"><div class="top">' +
      '<span class="tl' + (doors.length > 14 ? ' warn' : '') + '"></span>' +
      '<span class="n">' + doors.length + '</span></div>' +
      '<div class="cap">Of HaTi’s ' + (scan.public.totalRoutes || 0) + ' addresses, these need no login. ' +
      'Short by design.</div>' +
      '<div style="display:flex;gap:4px;margin-top:11px;flex-wrap:wrap">' +
      doors.map(function (d) {
        var w = doorWeight(d);
        var bg = w <= 1 ? 'var(--badtx)' : w === 2 ? 'var(--gold)' : d.result ? 'var(--lav)' : 'var(--tile2)';
        return '<i title="' + esc(d.chip) + '" style="display:block;width:22px;height:6px;border-radius:3px;background:' + bg + '"></i>';
      }).join('') + '</div></div>';

    /* Card 3 — the button, and what the last knock cost. */
    var c3;
    if (!state.available) {
      c3 = sumCard('—', 'warn',
        esc(state.reason || 'The Mapper does not know where the live HaTi is, so it cannot knock on anything.'));
    } else if (!last) {
      c3 = '<div class="sum"><div class="top"><span class="tl warn"></span>' +
        '<span class="n" style="font-size:19px">Never knocked</span></div>' +
        '<div class="cap">One request at a time, ' + ((state.throttleMs || 500) / 1000) + ' seconds apart, ' +
        (state.cap || 12) + ' at most. Nothing here ever runs on its own.</div>' +
        '<div style="margin-top:12px"><button class="btn btn-primary" data-act="knock" type="button">Check the live site</button></div></div>';
    } else {
      c3 = '<div class="sum"><div class="top"><span class="tl' + (surprises.length ? ' bad' : '') + '"></span>' +
        '<span class="n" style="font-size:19px">Last checked ' + esc(fmtDate(last.at, true)) + '</span></div>' +
        '<div class="cap">' + last.requests + ' plain request' + (last.requests === 1 ? '' : 's') + ' to ' + esc(last.site) +
        ', one at a time, taking ' + Math.round(last.tookMs / 1000) + ' seconds. ' +
        'Only a status code and a rough size came back.</div>' +
        '<div style="margin-top:12px"><button class="btn" data-act="knock" type="button">Check the live site again</button></div></div>';
    }

    $('doorsSums').innerHTML = c1 + c2 + c3;
    renderDoorRows(doors);
  }

  function renderDoorRows(doors) {
    var list = doors.slice().sort(function (a, b) {
      var d = doorWeight(a) - doorWeight(b);
      return d !== 0 ? d : String(a.chip).localeCompare(String(b.chip));
    });

    if (doorsFilter === 'surprise') list = list.filter(function (d) { return doorWeight(d) <= 2; });
    if (doorsFilter === 'unknocked') list = list.filter(function (d) { return !d.result; });

    if (!list.length) {
      $('doorsBody').innerHTML = '<div class="note">Nothing matches that filter.</div>';
    } else {
      $('doorsBody').innerHTML = list.map(function (d) {
        var v = d.result ? (VERDICT[d.result.verdict] || { cls: '', label: d.result.verdict }) : null;
        var w = doorWeight(d);
        var isBad = w <= 1;
        /* An address with no guard at all is not a surprise — the code says so
           — but it is not a green tick either. It gets its own middle state. */
        var isWarn = !isBad && w === 2;
        var badge = v
          ? '<span class="badge ' + v.cls + '">' + esc(v.label) + '</span>'
          : d.skipped
            ? '<span class="badge">left alone</span>'
            : '<span class="badge' + (isWarn ? ' gold' : '') + '">not knocked</span>';

        return '<div class="door' + (isBad ? ' bad' : isWarn ? ' warn' : '') + '">' +
          '<span class="ic">' + (isBad || isWarn ? ICON_WARN : ICON_TICK) + '</span>' +
          '<div class="bd"><b>' + esc(d.title) + '</b>' +
          '<div class="d">' + esc(d.claim) +
          (d.result ? ' <b>' + esc(d.result.says) + '</b>' : '') +
          (d.skipped ? ' ' + esc(sentenceCase(d.skipped.reason)) + '.' : '') +
          '</div>' +
          '<div class="w"><span class="codechip">' + esc(d.chip) + '</span>' +
          '<span>' + esc(d.where) + '</span></div></div>' +
          '<div class="rt">' + badge +
          (isBad ? (d.kind === 'route' ? fixButton('door', d.chip) : '') : '') + '</div></div>';
      }).join('');
    }

    $('doorsNote').innerHTML = 'Derived by listing every <code>app.get/post/put/patch/delete</code> whose middleware chain ' +
      'does not include <code>auth</code>. "No login check" is not the same as "anyone can read it" — each row says what ' +
      'actually guards it. Where the live site was knocked on, what it answered is in bold beside the code’s claim; ' +
      'nothing but a status code and a rough size ever came back, so nothing of HaTi’s is on this screen.';
  }

  var ICON_TICK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  var ICON_WARN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>';

  $('doorsFilter').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-f]');
    if (!b || !scan) return;
    doorsFilter = b.getAttribute('data-f');
    this.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    renderDoorRows(doorList());
  });

  /* ---- 6b. knocking on those doors for real ---- */

  /* The list above is what HaTi's source says. This is what the running site
     answers. Nothing here happens unless the owner presses the button, and the
     server never sends back a response body — only a status and a size band —
     so there is nothing here that could carry HaTi's data onto this page. */
  var VERDICT = {
    'as-expected':      { cls: 'good', label: 'as written' },
    'needs-login':      { cls: 'bad',  label: 'wants login' },
    'unexpected-data':  { cls: 'bad',  label: 'gave data' },
    'missing':          { cls: 'bad',  label: 'not there' },
    'error':            { cls: 'bad',  label: 'errored' },
    'unreachable':      { cls: '',     label: 'no answer' },
  };

  /* Whether the Mapper knows where HaTi is, and the limits it knocks under. */
  var doorsState = null;

  function renderDoors(state) {
    if (!state) return;
    doorsState = state;
    if (state.last) {
      /* The tower leads with anything that answered when the code said it
         would not, so it needs this as soon as there is one. */
      doorsResult = state.last;
      if (scan) { renderTowerDoors(); renderTowerAttention(); }
    }
    if (scan) renderDoorsPanel();
  }

  function loadDoors() {
    return apiGet('/api/public-check').then(renderDoors, function () {});
  }

  /* Delegated, because the button now lives inside a card that is redrawn
     every time the list changes — a listener bound to the element itself
     would be thrown away with the first repaint. */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('button[data-act="knock"]');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Knocking…';
    $('doorsBody').innerHTML = skeleton(4);
    post('/api/public-check', {})
      .then(function (last) {
        renderDoors({ available: true, cap: last.cap, throttleMs: last.throttleMs, timeoutMs: last.timeoutMs, last: last });
      })
      .catch(function (err) {
        $('doorsBody').innerHTML = '<div class="note bad"><b>The check could not run.</b> ' + esc(err.message) + '</div>';
      });
  });

  /* ---- 7a. what the Mapper has watched change (72 hours) ---- */
  var KIND_LABEL = {
    screens: 'screens', ai: 'AI cost', data: 'storage',
    public: 'open door', gaps: 'gaps', weight: 'file size', map: 'the map',
    watch: 'you asked',
  };

  /* How far back the panel is looking. 72 hours is the working set; the longer
     ranges are served from the archive. */
  var watchHours = 72;
  /* Mirrors MAX_HISTORY_HOURS in lib/history.mjs. Asking for more than the
     server keeps is not an error — it clamps — so this only ever needs to be
     at least as large as the archive's retention. */
  var MAX_WATCH_HOURS = 2160;
  var RANGE_LABEL = { 72: 'the last 72 hours', 168: 'the last 7 days', 720: 'the last 30 days', 2160: 'the last 90 days' };
  function rangeLabel() { return RANGE_LABEL[watchHours] || ('the last ' + watchHours + ' hours'); }

  function renderWatch(watch) {
    var lede = $('watchLede');
    var body = $('watchBody');
    if (!watch) { body.innerHTML = skeleton(4); return; }
    watchData = watch;

    if (!watch.watching) {
      lede.textContent = 'Every scan is compared with the one before, and anything that moved is kept here.';
      body.innerHTML = '<div class="note"><b>Just started watching.</b> This is the first scan, so there is nothing to compare it against yet. ' +
        'Come back after the next one and anything that has moved will be listed here.</div>';
      return;
    }

    var total = watch.rounds.reduce(function (n, r) { return n + r.events.length; }, 0);

    /* "Watching since" claimed two things that were not true: that the Mapper
       watches continuously — it looks when this page is opened and at no other
       time — and that the date was when it started, when it is really the
       oldest snapshot still kept, which creeps forward as old ones are pruned.
       When it last looked is a fact it actually holds. */
    var lookedAt = watch.lastLookedAt ? fmtDate(watch.lastLookedAt, true) : null;
    lede.textContent = (total === 0
      ? 'Nothing has moved in HaTi in ' + rangeLabel() + '.'
      : total + (total === 1 ? ' change' : ' changes') + ' in ' + rangeLabel() + ', newest first.') +
      (lookedAt ? ' The Mapper last looked ' + lookedAt + '.' : '');

    var html = '';
    renderChangesSums();

    /* An empty list has two very different causes and used to be given only
       the flattering one. Two looks finding nothing and two hundred looks
       finding nothing are opposite facts, and the page asserted the second
       while holding the evidence for neither — it was counting snapshots,
       which only exist when something DID change. */
    var looks = watch.looks || 0;
    var sinceLook = watch.lastLookedAt ? (Date.now() - new Date(watch.lastLookedAt).getTime()) / 36e5 : null;

    if (total === 0) {
      html += '<div class="note"><b>Nothing has moved' + (watchHours > 72 ? ' in ' + rangeLabel() : '') + '.</b> ' +
        'The Mapper has looked ' + looks + ' time' + (looks === 1 ? '' : 's') + ' altogether' +
        (lookedAt ? ', most recently ' + esc(lookedAt) : '') + '. ' +
        'It looks when you open this page, and at no other time — there is no schedule behind it, so opening the Mapper is what makes it watch. ' +
        (looks < 3
          ? '<b>That is too few looks to call this quiet.</b> An empty list here can just as easily mean nobody has opened the Mapper since HaTi last changed.'
          : 'Each of those found HaTi unchanged.') +
        (sinceLook != null && sinceLook > 24
          ? ' <b>Its last look was ' + Math.round(sinceLook / 24) + ' day' + (Math.round(sinceLook / 24) === 1 ? '' : 's') +
            ' ago</b>, so anything that has moved since then is not here yet — press Rescan to bring it up to date.'
          : '') +
        '</div>';
    } else {
      /* A timeline rather than a stack of cards: the round's time and code
         version sit on a rail down the left, its events on the right, so the
         rounds read as a sequence. */
      html += '<div class="tl2">' + watch.rounds.map(function (r) {
        var worst = r.events.reduce(function (n, e) { return Math.max(n, e.weight || 1); }, 1);
        return '<div class="when"><b>' + esc(fmtDate(r.at, true)) + '</b>' +
          (r.commit ? 'version ' + esc(r.commit) : 'no code version recorded') + '</div>' +
          '<div class="rail"><i class="' + (worst >= 3 ? 'bad' : worst === 2 ? 'warn' : '') + '"></i></div>' +
          '<div class="evs">' + r.events.map(function (e) {
            var w = e.weight || 1;
            return '<div class="ev"><span class="badge' + (w >= 3 ? ' bad' : w === 2 ? ' gold' : '') + '">' +
              esc(KIND_LABEL[e.kind] || e.kind) + '</span>' +
              '<span class="x">' + esc(e.text) + '</span></div>';
          }).join('') + '</div>';
      }).join('') + '</div>';
    }

    lede.innerHTML = esc(lede.textContent) + ' <br>A scan that finds nothing changed adds nothing here, so this stays a list of real events rather than a list of look-ups. ' +
      'Everything noticed is kept for up to 90 days' +
      (watch.keptSince ? ' — this log goes back to ' + esc(fmtDate(watch.keptSince, true)) : '') + '.' +
      (watch.durable ? '' : ' <b>This log is being held in memory only</b> — it will be lost if the service restarts.') +
      (watch.durable && !watch.archiveDurable ? ' <b>Nothing older than 72 hours can be kept</b> — the archive file cannot be written.' : '');

    body.innerHTML = html;
  }

  /* ---- 7c. last night ---- */

  /* The question the owner actually asks each morning. The same events the log
     below lists, grouped into one report so it reads as an answer rather than
     as a feed. */
  /* The four counters over the Changes tab. They come from three different
     places — the night's report, the watch log and the scan — so they are
     drawn once, here, rather than by whichever renderer happens to run last. */
  var digestData = null;

  function renderChangesSums() {
    if (!scan) return;
    var d = digestData;
    var w = watchData;
    var commits = d && d.commits ? d.commits.length : null;
    var observed = w ? w.rounds.reduce(function (n, r) { return n + r.events.length; }, 0) : null;
    var gaps = scan.gaps ? scan.gaps.gaps.length : 0;
    var high = scan.gaps ? (scan.gaps.severityCounts || {}).high || 0 : 0;
    var mv = scan.gapMovement;
    var looks = w ? (w.looks || 0) : null;

    $('changesSums').innerHTML =
      sumCard(commits == null ? '—' : commits, commits ? 'warn' : 'ok',
        commits == null
          ? 'The night’s report has not arrived yet.'
          : commits
            ? 'Code updates ' + esc(d.label) + ' — read from the repository’s own record, not from the Mapper’s watching.'
            : 'No code updates ' + esc(d.label) + '. If a session was meant to run, that is worth knowing too.') +
      sumCard(observed == null ? '—' : observed, observed ? 'warn' : 'ok',
        observed == null
          ? 'The watch log has not arrived yet.'
          : observed
            ? 'Things the Mapper noticed move on its own, in ' + rangeLabel() + '.'
            : 'Nothing has moved that the Mapper could see, in ' + rangeLabel() + '.') +
      sumCard(gaps, high ? 'bad' : gaps ? 'warn' : 'ok',
        gaps
          ? 'Things still unfinished' + (high ? ', ' + high + ' of them marked high' : '') +
            (mv && (mv.opened || mv.closed) ? ' · ' + mv.closed + ' closed, ' + mv.opened + ' opened this month' : '') + '.'
          : 'Nothing in HaTi’s documents is written down as unfinished.') +
      sumCard(looks == null ? '—' : looks + (looks === 1 ? ' look' : ' looks'), 'ok',
        looks == null
          ? 'The watch log has not arrived yet.'
          : 'The Mapper has taken' + (w && w.lastLookedAt ? ', the last one ' + esc(fmtDate(w.lastLookedAt, true)) : '') +
            '. It looks when you open this page and at no other time.');
  }

  /* The heaviest thing the Mapper observed last night, and — only where the
     evidence is actually there — the code update that most likely caused it.
     The tie is made on a distinctive word shared between the event and a
     commit subject, and where nothing matches the card says so rather than
     picking one. It is a lead, never a verdict. */
  var STOPWORDS = {
    the: 1, and: 1, that: 1, this: 1, with: 1, from: 1, into: 1, have: 1, been: 1, were: 1, was: 1,
    for: 1, its: 1, now: 1, out: 1, more: 1, than: 1, over: 1, file: 1, files: 1, code: 1, name: 1,
    names: 1, added: 1, moved: 1, changed: 1, longer: 1, without: 1, anything: 1, something: 1,
  };

  function distinctiveWords(s) {
    var out = {};
    String(s || '').toLowerCase().replace(/[^a-z0-9/._-]+/g, ' ').split(' ').forEach(function (w) {
      if (w.length >= 5 && !STOPWORDS[w]) out[w] = true;
    });
    return out;
  }

  function digestSpotlight(d) {
    var events = [];
    (d.sections || []).forEach(function (s) {
      (s.events || []).forEach(function (e) { events.push(e); });
    });
    if (!events.length) return null;
    var worst = events.reduce(function (a, b) { return (b.weight || 1) > (a.weight || 1) ? b : a; });
    if ((worst.weight || 1) < 2) return null;    // nothing here rises above routine

    var words = distinctiveWords(worst.text);
    var hit = null;
    (d.commits || []).forEach(function (c) {
      if (hit) return;
      var cw = distinctiveWords(c.subject);
      for (var k in words) if (cw[k]) { hit = c; return; }
    });
    return { event: worst, commit: hit };
  }

  function renderDigest(d) {
    var body = $('digestBody');
    if (!d) { body.innerHTML = skeleton(3); return; }
    digestData = d;
    renderChangesSums();

    $('digestLede').textContent = 'Everything that moved ' + d.label + ', in one place.';

    if (d.quiet) {
      $('digestBadge').hidden = true;
      $('digestLede').hidden = false;
      body.innerHTML = '<div class="note"><b>Nothing moved ' + esc(d.label) + '.</b> No screens, no addresses, no tables, no commits. ' +
        'If a session was supposed to run, that is worth knowing too.</div>';
      return;
    }

    /* "Busy" is not a field the server sends — it is simply how many things
       moved, which is the only thing that word could honestly mean here.

       How busy a night was fairly counts both what the Mapper saw and what was
       saved to the repository. Labelling that total "N changes" did not: the
       calendar counts only the first of those, so the two sat on screen
       disagreeing while both were right. The badge now names whichever it is
       counting, and only says "changes" when it means them. */
    var observed = d.sections.reduce(function (n, s) { return n + s.events.length; }, 0);
    var moved = observed + d.commits.length;
    var badge = observed && d.commits.length
      ? observed + ' change' + (observed === 1 ? '' : 's') + ' · ' + d.commits.length + ' update' + (d.commits.length === 1 ? '' : 's')
      : observed
        ? observed + ' change' + (observed === 1 ? '' : 's')
        : d.commits.length + ' code update' + (d.commits.length === 1 ? '' : 's');
    $('digestBadge').textContent = moved >= 6 ? 'busy night' : badge;
    $('digestBadge').className = 'badge' + (moved >= 4 ? ' lav' : '');
    $('digestBadge').hidden = false;

    var html = '<div style="font-size:14px;font-weight:600;margin-bottom:10px">' + esc(d.headline) + '</div>';

    html += d.sections.map(function (s) {
      return s.events.map(function (e) {
        var w = e.weight || 1;
        return '<div class="evrow"><span class="badge' + (w >= 3 ? ' bad' : w === 2 ? ' gold' : '') + '">' +
          esc(s.title) + '</span><span class="x">' + esc(e.text) + '</span></div>';
      }).join('');
    }).join('');

    var spotlight = digestSpotlight(d);

    /* Numbered in the order the work happened, so the list reads as the story
       of the session rather than as an undifferentiated pile. The date sits
       above them because "since midnight" is relative and a date is not. */
    if (d.commits.length) {
      html += '<div class="commits" style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px">' +
        /* "Code updates", not "changes". These are times someone saved work,
           read out of GitHub's record — not things the Mapper watched move.
           Calling both "changes" is what left this card and the tower's
           calendar contradicting each other in the same word. */
        '<h5>The ' + d.commits.length + (d.commits.length === 1 ? ' code update' : ' code updates') +
        ', in the order they happened</h5>' +
        '<div class="day">' + esc(fmtDate(d.commits[0].date)) + '</div>' +
        d.commits.map(function (c) {
          var lit = spotlight && spotlight.commit && spotlight.commit.sha === c.sha;
          return '<div class="commit2"' + (lit ? ' style="background:var(--bad);border-radius:9px"' : '') + '>' +
            '<span class="n">' + c.n + '</span>' +
            '<span class="t">' + esc(c.subject) + '</span>' +
            '<span class="h" title="The reference number for this code update">' + esc(c.sha) + '</span></div>';
        }).join('') + '</div>';
    }

    /* The one thing on this card worth acting on, said once and in red. It is
       the heaviest thing the Mapper actually observed, and where a code update
       from the same night plausibly caused it, that update is named. */
    if (spotlight) {
      html += '<div class="warncard" style="margin-top:12px">' +
        '<span class="ic">' + ICON_WARN + '</span><div class="bd">' +
        '<b>' + (spotlight.commit
          ? 'Update ' + spotlight.commit.n + ' is the one to look at.'
          : 'One thing here is worth a look.') + '</b>' +
        '<div class="d">' + esc(spotlight.event.text) +
        (spotlight.commit
          ? ' That update is the only one last night whose description mentions it.'
          : ' No code update last night names it, so what caused it is not on this card.') +
        '</div></div></div>';
    }

    /* Every other code update the scan can see, folded in here rather than
       repeated in a card of its own. They are the same commits — a second
       panel listing them again read as a second, disagreeing answer. */
    var nightShas = {};
    d.commits.forEach(function (c) { nightShas[c.sha] = true; });
    var earlier = (scan && scan.changes ? scan.changes : []).filter(function (c) { return !nightShas[c.sha]; });
    if (earlier.length) {
      html += '<div style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px">' +
        '<button class="showall" type="button" data-act="earlier">' +
        'Show the ' + earlier.length + ' earlier code update' + (earlier.length === 1 ? '' : 's') + '</button>' +
        '<div id="earlierCommits" hidden style="margin-top:8px">' +
        earlier.map(function (c) {
          var files = c.fileCount != null ? c.fileCount + ' file' + (c.fileCount === 1 ? '' : 's') : null;
          var what = c.areas === null ? 'areas not detected'
            : c.areas.length ? 'touched ' + c.areas.join(', ') + (files ? ' · ' + files : '')
              : (files || 'files') + ', none in the tracked areas';
          return '<div class="gline"><span class="dot"></span><div><b>' + esc(c.subject) + '</b>' +
            '<span>' + esc(fmtDate(c.date)) + ' · ' + esc(what) + ' · ' + esc(c.sha) + '</span></div></div>';
        }).join('') + '</div></div>';
    } else if (!d.commits.length && scan && !scan.changes.length) {
      html += '<div class="note"><b>No commit history.</b> The scan could not read the repository’s record, ' +
        'so no code updates can be listed. Everything else on this page comes from the source itself and is unaffected.</div>';
    }

    var foot = [];
    if (d.health) {
      foot.push(d.health.delta == null
        ? 'The scanner could read ' + d.health.to + '% of what it looks for.'
        : 'The scanner could read ' + d.health.to + '% of what it looks for, against ' + d.health.from + '% at the start of the window.');
    }
    if (d.bytesGrown != null && Math.abs(d.bytesGrown) >= 1024) {
      foot.push('The whole thing ' + (d.bytesGrown > 0 ? 'grew' : 'shrank') + ' by about ' + kb(Math.abs(d.bytesGrown)) + '.');
    }
    /* "0 scans" printed under a list of 16 commits reads as broken, though both
       halves are true: the commits come from GitHub's record, and the Mapper's
       own observations only exist once it has looked. Say which is which. */
    if (d.scanCount === 0) {
      foot.push(d.commits.length
        ? 'The code updates above come straight from GitHub’s record. The Mapper itself has not taken a look yet ' +
          d.label + ' — anything it notices of its own will appear here after the next scan.'
        : 'The Mapper has not taken a look yet ' + d.label + '.');
    } else {
      foot.push('Put together from ' + d.scanCount + ' look' + (d.scanCount === 1 ? '' : 's') +
        ' the Mapper took ' + d.label + '.');
    }
    html += '<div class="foot">' + esc(foot.join(' ')) + '</div>';
    body.innerHTML = html;
    /* The footer says everything the intro would have, so the intro steps
       aside rather than repeating it word for word. */
    $('digestLede').hidden = true;
  }

  function loadDigest() {
    return apiGet('/api/digest').then(renderDigest, function () {
      $('digestBody').innerHTML = '<div class="note">The summary could not be put together just now.</div>';
    });
  }

  function loadWatch() {
    return apiGet('/api/changes?hours=' + watchHours).then(renderWatch, function () {
      $('watchBody').innerHTML = '<div class="note">The change log could not be read just now.</div>';
    });
  }

  /* The tower's own copy, over the archive's whole 90 days, so the calendar's
     marks and its count describe the month it is drawing rather than whatever
     range the Changes panel happens to be set to. A failure is not worth
     reporting here — the calendar shows an em dash until it arrives. */
  function loadTowerWatch() {
    return apiGet('/api/changes?hours=' + MAX_WATCH_HOURS).then(function (w) {
      towerWatch = w;
      if (scan) renderTowerCal();
    }, function () {});
  }

  $('watchRange').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-h]');
    if (!b) return;
    watchHours = Number(b.getAttribute('data-h'));
    $('watchRange').querySelectorAll('button').forEach(function (x) {
      x.setAttribute('aria-pressed', String(x === b));
    });
    $('watchBody').innerHTML = skeleton(4);
    loadWatch();
  });

  /* The code updates older than last night live inside the "Last night" card,
     behind this toggle. They used to be a fourth panel of their own, which
     read as a second answer to the question that card already answers. */
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-act="earlier"]');
    if (!b) return;
    var box = $('earlierCommits');
    if (!box) return;
    box.hidden = !box.hidden;
    b.textContent = box.hidden
      ? 'Show the ' + box.children.length + ' earlier code update' + (box.children.length === 1 ? '' : 's')
      : 'Hide the earlier code updates';
  });

  /* The gaps the documents say nothing about, behind their own toggle. */
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-act="gaps"]');
    if (!b) return;
    var box = $('unrankedGaps');
    if (!box) return;
    box.hidden = !box.hidden;
    b.textContent = box.hidden ? 'Show them' : 'Hide them';
  });

  /* ---- 8. getting bulky ----

     Same fields as before, a different shape. "Over the line" used to be a
     badge, which says only yes or no; it is a POSITION now — the line is drawn
     on every bar at threshold/maxBytes, so how far over is visible at a
     glance. And only the heaviest few are shown: the long tail of small files
     is never the answer to "what has outgrown comfortable". */

  var weightShowAll = false;

  function renderWeight() {
    var w = scan.weight;
    var max = w.files.length ? w.files[0].bytes : 1;
    var totalBytes = w.totalBytes != null
      ? w.totalBytes
      : w.files.reduce(function (n, f) { return n + f.bytes; }, 0);

    $('weightSums').innerHTML =
      '<div class="sum"><div class="top">' +
      '<span class="n">' + esc(totalBytes >= 1048576 ? (totalBytes / 1048576).toFixed(2) + ' MB' : kb(totalBytes)) + '</span>' +
      trendChip('bytes', totalBytes, { epsilon: 1024, format: function (d) { return kb(d); } }) +
      '</div><div class="cap">All of HaTi, across ' + w.files.length + ' files.</div></div>' +
      sumCard(w.overThreshold, w.overThreshold ? 'warn' : 'ok',
        'Files past the comfortable line of ' + kb(w.threshold) +
        (w.overThreshold ? '.' : '. Nothing has outgrown it.')) +
      sumCard(w.orphans.length, w.orphans.length ? 'bad' : 'ok',
        w.orphans.length
          ? 'Names published for other code to use, that nothing uses.'
          : 'Every published name is used somewhere. Nothing to remove.') +
      sumCard(w.files.length - w.overThreshold, 'ok', 'Files comfortably under the line.');

    $('weightLede').textContent = 'the line is ' + kb(w.threshold) +
      ' — past it, a file is hard for a person or an AI session to hold in mind';

    /* Anything over the line is always shown, however many that is; the tail
       is behind the toggle. */
    var over = w.files.filter(function (f) { return f.bytes > w.threshold; });
    var shown = weightShowAll ? w.files : w.files.slice(0, Math.max(4, over.length));
    var markAt = max ? Math.min((w.threshold / max) * 100, 100) : 0;

    var html = shown.map(function (f) {
      var big = f.bytes > w.threshold;
      var times = Math.round((f.bytes / w.threshold) * 10) / 10;
      return '<div class="rank">' +
        '<div class="rwho"><b>' + (f.name ? esc(f.name) : nd('no plain-English note yet')) + '</b>' +
        (f.does ? '<div class="d">' + esc(f.does) + '</div>' : '') +
        '<div class="m"><span class="codechip" title="Where this file lives in HaTi">' + esc(f.path) + '</span></div></div>' +
        '<div><div class="mbar"><i class="' + (big ? 'over' : '') + '" style="width:' +
        ((f.bytes / max) * 100).toFixed(1) + '%"></i>' +
        '<span class="mark" title="The comfortable line, ' + esc(kb(w.threshold)) + '" style="left:' + markAt.toFixed(1) + '%"></span>' +
        '</div><div class="barnote">' +
        (big ? esc(times + '× the comfortable line.') : 'Under the line. Nothing to do.') +
        '</div></div>' +
        '<div class="amt"><span class="v"' + (big ? ' style="color:var(--gold)"' : '') + '>' + esc(kb(f.bytes)) + '</span>' +
        (big ? '<div style="margin-top:6px">' + fixButton('file-size', f.path) + '</div>' : '') +
        '</div></div>';
    }).join('');

    if (w.files.length > shown.length || weightShowAll) {
      html += '<div style="margin-top:12px;font-size:12px;color:var(--tx3)">' +
        (weightShowAll
          ? 'Showing all ' + w.files.length + ' files. '
          : 'Showing the ' + shown.length + ' heaviest of ' + w.files.length + ' files. ') +
        '<button class="showall" type="button" data-act="weight">' +
        (weightShowAll ? 'Show fewer' : 'Show all') + '</button></div>';
    }

    /* The panel explains its own unit rather than assuming KB is common
       knowledge, and says in words what the gold means. Both belong here
       whatever shape the rows take. */
    html += '<div class="note"><b>What the sizes mean.</b> ' +
      'KB is how much text a file holds — ' + kb(w.threshold) + ' is roughly fifteen to twenty printed pages of code. ' +
      'Past that a file gets hard for a person, or for an AI session, to hold in mind at once, which is when mistakes creep in. ' +
      'That is all the gold colouring and the line on each bar say: this one has outgrown comfortable.</div>';

    var worst = (scan.moduleFacts || []).filter(function (m) { return m.multiJob; })
      .sort(function (a, b) { return b.bytes - a.bytes; })[0];
    if (worst) {
      html += '<div class="note"><b>' + esc(worst.module) + '</b> carries ' + worst.sections.length +
        ' separately-banner-ed jobs and ' + worst.exportCount + ' exported names in ' + kb(worst.bytes) +
        '. Splitting it would make every future session on that area faster and safer.</div>';
    }

    $('weightBody').innerHTML = html;
    renderOrphans();
  }

  /* Chips grouped by the file they come from, and one button that drafts a
     prompt covering all of them — one button per name was thirty presses. */
  function renderOrphans() {
    var w = scan.weight;
    $('orphanTitle').textContent = w.orphans.length
      ? w.orphans.length + ' name' + (w.orphans.length === 1 ? '' : 's') + ' nothing uses'
      : 'Names nothing uses';

    if (!w.orphans.length) {
      $('orphanAct').innerHTML = '';
      $('orphanBody').innerHTML = '<div class="note">Every one of the ' + w.exportCount +
        ' names attached to <code>window</code> is referenced somewhere else in the repository. Nothing to remove.</div>';
      return;
    }

    $('orphanAct').innerHTML = fixButton('orphan-all', 'all', null,
      'Draft one fix for all ' + w.orphans.length);

    var byFile = {};
    w.orphans.forEach(function (o) { (byFile[o.exportedFrom] = byFile[o.exportedFrom] || []).push(o.name); });

    /* Each chip is itself the button for its own name. The bulk button above
       covers the common case — they are all the same decision — but losing the
       ability to ask about one name would have been a capability traded away
       for tidiness. */
    $('orphanBody').innerHTML = '<div class="ocards">' + Object.keys(byFile).map(function (f) {
      return '<div class="ocard"><div class="f">' + esc(f) + '</div><div class="chips">' +
        byFile[f].map(function (n) {
          return '<button class="codechip chipbtn" type="button" data-fix="orphan" data-id="' + esc(n) + '"' +
            ' title="Write a prompt about ' + esc(n) + ' I can paste into a Claude Code session">' + esc(n) + '</button>';
        }).join('') +
        '</div></div>';
    }).join('') + '</div>' +
      '<div class="note">' + w.orphans.length + ' of ' + w.exportCount +
      ' published names. Each appears exactly once in the whole of HaTi — where it is declared — so nothing calls it. ' +
      'Worth a look before assuming any of them is holding something up.</div>';
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-act="weight"]');
    if (!b || !scan) return;
    weightShowAll = !weightShowAll;
    renderWeight();
  });

  /* ------------------------------------------------------------- the run */

  function stampText() {
    var el = $('stamp');
    var when = new Date(scan.scannedAt);
    var ageMs = Date.now() - when.getTime();
    var dayOld = ageMs > 24 * 60 * 60 * 1000;
    el.innerHTML = 'Scanned ' + esc(fmtDate(scan.scannedAt, true)) +
      (scan.cached ? ' · cached' : '') +
      (dayOld ? ' · <b style="color:var(--gold)">over a day old</b>' : '');
    el.style.color = dayOld || scan.stale ? 'var(--gold)' : '';
    el.title = scan.requestCount != null
      ? scan.requestCount + ' GitHub requests, ' + scan.fileCount + ' files read, ' + (scan.tookMs || 0) + ' ms'
      : '';
  }

  /* ---- is this what's live? ---- */

  /* The one way this whole dashboard could quietly mislead: every panel
     accurate about code nobody is running. The server compares the commit the
     scan read with the commit the running HaTi was built from and says which
     of three things is true. Never a guess — when it cannot tell, it says so. */
  function renderDrift() {
    var el = $('drift');
    var d = (pulse && pulse.drift) || {
      state: 'unknown',
      message: 'Can’t tell whether this is what’s live — the Mapper could not ask HaTi.',
    };
    el.className = 'drift ' + (d.state === 'match' ? 'ok' : d.state === 'different' ? 'warn' : 'unknown');
    $('driftText').textContent = d.message;
    el.title = d.scannedCommit
      ? 'Reading ' + d.scannedCommit + (d.liveCommit ? ' · live is ' + d.liveCommit : ' · the live version is unknown')
      : (d.reason || '');
    el.hidden = false;
  }

  /* How much of HaTi the scanner could read now lives on the control tower,
     as the "Scanner grip" card — see renderTowerGrip. */

  /* The measurement series has no card of its own. It is read by four of the
     tower's tiles — the spend line, the calendar, the "was X% at the start of
     the log" line and the growth figure — so it is fetched for them and for
     nothing else. A failure is not worth reporting: each of those tiles is
     written to stand up without it. */
  function loadTrends() {
    return apiGet('/api/trends?days=90').then(function (t) {
      trends = t;
      if (scan) renderTower();
    }, function () {});
  }

  /* ---- what the scan could not work out ----

     Every panel that cannot read something it looked for writes a sentence
     into scan.warnings, and until now nothing displayed them. The control
     tower counted them — "7 warnings", in a circle, next to the grip figure —
     so the one number on the page whose whole job is to say "some of what you
     are reading may be wrong" came with no way to find out which part. The
     answer had been sitting in the payload the entire time. */
  /* ---- the warnings popup ----
     Opened from the circle on the grip card. The full list also stays on its
     Settings card — the popup is for the moment of noticing, the card for
     whoever goes looking later. */
  var warnPopOpener = null;   // where focus goes back to on close

  /* Thirty-four warnings in one list is a wall, not an answer, so they are
     grouped by what would actually be done about them. The test is on the
     wording the scan itself uses, and anything that matches nothing falls
     through to the last group rather than being dropped — the text is always
     shown exactly as the scan wrote it, whichever group it lands in. */
  var WARN_GROUPS = [
    {
      id: 'stale',
      title: 'Written down here, gone from HaTi',
      why: 'Something in the Mapper’s own notes describes a part of HaTi that no longer exists. Harmless, but the note should go.',
      test: function (w) { return /no longer (exists|has an endpoint)|that no longer/i.test(w); },
    },
    {
      id: 'missing',
      title: 'In HaTi, not yet described here',
      why: 'New parts of HaTi with no plain-English note written for them yet. They show as “not detected” until one is.',
      test: function (w) { return /has no plain-English description|with no name in/i.test(w); },
    },
    {
      id: 'unread',
      title: 'The scanner could not read this',
      why: 'HaTi is written in a shape the Mapper does not recognise here, so a figure on the page is missing rather than wrong.',
      test: function (w) { return /could not be (derived|resolved|worked out|read)|not derived|no .* call found|could not be/i.test(w); },
    },
    {
      id: 'map',
      title: 'The “what breaks what” map is out of step',
      why: 'The hand-written map points at something HaTi has moved or renamed.',
      test: function (w) { return /Subsystem "|dependencies\.js|points at the subsystem/i.test(w); },
    },
    {
      id: 'prices',
      title: 'The price list needs a look',
      why: 'The money figures are only as good as the prices written down for them.',
      test: function (w) { return /pricing\.js|prices/i.test(w); },
    },
    { id: 'other', title: 'Everything else', why: 'Things that do not fall into any of the above.', test: function () { return true; } },
  ];

  function groupWarnings(list) {
    var out = WARN_GROUPS.map(function (g) { return { g: g, items: [] }; });
    list.forEach(function (w) {
      for (var i = 0; i < WARN_GROUPS.length; i++) {
        if (WARN_GROUPS[i].test(w)) { out[i].items.push(w); return; }
      }
    });
    return out.filter(function (x) { return x.items.length; });
  }

  /* File paths, identifiers and quoted names inside a warning are addresses,
     so they are set as addresses. Escaped first — a warning carries text read
     out of HaTi's source, so it is untrusted like anything else from there. */
  function warnText(w) {
    return esc(w)
      .replace(/(&quot;|&#39;)([^&<]{1,60})\1/g, '<code>$2</code>')
      .replace(/\b([\w./-]+\.(?:js|mjs|html|md))\b/g, '<code>$1</code>')
      .replace(/\b(\/api\/[\w/:.-]+)/g, '<code>$1</code>');
  }

  /* The whole list as plain text, ready to paste into a session, an email or a
     note. It carries what was scanned and when, because a list of warnings
     with no idea which scan produced them is not much use to anyone. */
  function warningsAsText() {
    var list = (scan && scan.warnings) || [];
    var head = [
      'HaTi-Mapper — what the scan could not work out',
      list.length + (list.length === 1 ? ' warning' : ' warnings'),
      'Repository: ' + ((scan && scan.repo) || 'unknown') + (scan && scan.commit ? ' @ ' + scan.commit : ''),
      'Scanned: ' + ((scan && scan.scannedAt) ? new Date(scan.scannedAt).toISOString() : 'unknown'),
      '',
    ];
    var body = [];
    groupWarnings(list).forEach(function (grp) {
      body.push(grp.g.title.toUpperCase() + ' (' + grp.items.length + ')');
      grp.items.forEach(function (w) { body.push('  - ' + w); });
      body.push('');
    });
    return head.concat(body).join('\n').trim() + '\n';
  }

  var ICON_COPY = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

  function openWarnPop() {
    var list = (scan && scan.warnings) || [];
    if (!list.length) return;
    warnPopOpener = document.activeElement;

    $('warnPopSub').textContent = list.length + (list.length === 1 ? ' thing' : ' things') +
      ' the Mapper looked for and could not read' +
      (scan && scan.scannedAt ? ' · scanned ' + fmtDate(scan.scannedAt, true) : '');

    var groups = groupWarnings(list);
    $('warnPopBody').innerHTML =
      '<div class="lede">Each of these is something the scan set out to establish and could not. ' +
      'Anything they touch may be missing or wrong on the page — that is what the circle on the ' +
      '“Scanner grip” card is counting, and it is why the grip score is below 100%.</div>' +
      groups.map(function (grp) {
        return '<div class="wgroup"><div class="gh"><b>' + esc(grp.g.title) + '</b><i></i>' +
          '<span class="n">' + grp.items.length + '</span></div>' +
          '<div class="wgroup-why" style="font-size:11.5px;color:var(--tx3);line-height:1.5;margin:-2px 0 8px">' +
          esc(grp.g.why) + '</div>' +
          grp.items.map(function (w) {
            return '<div class="wrow"><span class="dot"></span>' +
              '<span class="tx">' + warnText(w) + '</span>' +
              '<button class="copy1" type="button" data-copy1="' + esc(w) + '" ' +
              'title="Copy this one" aria-label="Copy this warning">' + ICON_COPY + '</button></div>';
          }).join('') + '</div>';
      }).join('');

    $('warnPop').hidden = false;
    $('warnPopClose').focus();
  }

  /* Copy the whole list, or one line of it. */
  function copyText(text, said) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast(said); },
        function () { toast('Could not copy — select the text and copy it by hand'); });
    } else {
      toast('This browser will not let the page copy for you — select the text and copy it by hand');
    }
  }

  $('warnPopCopy').addEventListener('click', function () {
    var n = ((scan && scan.warnings) || []).length;
    copyText(warningsAsText(), 'All ' + n + ' copied');
  });

  $('warnPopBody').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-copy1]');
    if (b) copyText(b.getAttribute('data-copy1'), 'Copied');
  });

  function closeWarnPop() {
    $('warnPop').hidden = true;
    if (warnPopOpener && warnPopOpener.focus) warnPopOpener.focus();
    warnPopOpener = null;
  }

  $('warnPopClose').addEventListener('click', closeWarnPop);
  // Clicking the dark veil closes; clicking inside the dialog does not.
  $('warnPop').addEventListener('click', function (e) { if (e.target === $('warnPop')) closeWarnPop(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('warnPop').hidden) { e.stopPropagation(); closeWarnPop(); }
  }, true);

  function renderScanWarnings() {
    var list = (scan && scan.warnings) || [];
    $('scanWarnCard').hidden = list.length === 0;
    if (!list.length) return;
    $('scanWarnCount').textContent = list.length + (list.length === 1 ? ' warning' : ' warnings');
    /* Grouped the same way the popup groups them, and copyable the same way.
       It is the same list; showing it two different shapes in two places is
       how a reader comes to think they are two different lists. */
    $('scanWarnBody').innerHTML = groupWarnings(list).map(function (grp) {
      return '<div class="wgroup"><div class="gh"><b>' + esc(grp.g.title) + '</b><i></i>' +
        '<span class="n">' + grp.items.length + '</span></div>' +
        grp.items.map(function (w) {
          return '<div class="wrow"><span class="dot"></span>' +
            '<span class="tx">' + warnText(w) + '</span>' +
            '<button class="copy1" type="button" data-copy1="' + esc(w) + '" ' +
            'title="Copy this one" aria-label="Copy this warning">' + ICON_COPY + '</button></div>';
        }).join('') + '</div>';
    }).join('');
  }

  $('scanWarnCopy').addEventListener('click', function () {
    var n = ((scan && scan.warnings) || []).length;
    copyText(warningsAsText(), 'All ' + n + ' copied');
  });

  $('scanWarnBody').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-copy1]');
    if (b) copyText(b.getAttribute('data-copy1'), 'Copied');
  });

  function renderAll() {
    renderDrift();
    renderScanWarnings();
    renderTower();
    renderScreens();
    renderCost();
    renderData();
    renderBlast();
    renderGaps();
    renderPublic();
    renderWeight();
    stampText();
  }

  function load(refresh) {
    setLoading();
    /* The Rescan control is an icon, so its "working" state is the icon
       turning rather than its label changing — setting textContent here would
       throw the SVG away and leave an empty circle. */
    $('rescan').disabled = true;
    $('rescan').classList.add('spin');
    $('stamp').textContent = refresh ? 'rescanning…' : 'scanning…';
    $('stamp').style.color = '';

    /* The two routes are independent on purpose: the seven code-derived panels
       must render whether or not a HaTi is running, so a pulse failure never
       blocks or rejects the scan. */
    var pulsed = apiGet('/api/pulse').then(function (p) { pulse = p; }, function () {
      pulse = { available: false, reason: 'The Mapper could not reach the running HaTi.' };
    });

    return Promise.all([apiGet('/api/scan' + (refresh ? '?refresh=1' : '')), pulsed])
      .then(function (r) {
        scan = r[0];
        renderAll();
        // A rescan may have noticed something new, so refresh both the
        // summary and the log below it.
        loadWatch();
        loadTowerWatch();
        loadDigest();
        loadWatchRules();
        loadTrends();
        $('rescan').disabled = false;
        $('rescan').classList.remove('spin');
      })
      .catch(function (e) {
        $('rescan').disabled = false;
        $('rescan').classList.remove('spin');
        $('stamp').textContent = e.noBackend ? 'no backend' : 'scan failed';
        $('stamp').style.color = 'var(--badtx)';
        /* Rescan retries the same request, so it only helps when the backend
           is there and the scan itself failed. Offering it for a missing
           backend just invites the same error again. */
        var headline = e.noBackend ? 'This page has no backend.' : 'The scan failed.';
        var footer = e.noBackend
          ? 'Rescan will not help until the service is running as a web service.'
          : 'Nothing on this page is current. Press Rescan to try again.';
        // Repeated failures raise a banner of their own; go and look.
        loadWatchRules();
        var msg = '<div class="note bad"><b>' + headline + '</b> ' + esc(e.message || 'Unknown error') +
          '<br>' + footer + '</div>';
        TOWER_IDS.concat(['screensBody', 'costBody', 'dataBody', 'blastBody', 'gapsBody',
          'doorsBody', 'weightBody', 'orphanBody', 'capsBody'])
          .forEach(function (id) { $(id).innerHTML = msg; });
      });
  }

  $('rescan').addEventListener('click', function () { load(true); });

  /* ==================================================================== */
  /*  The assistant                                                        */
  /*                                                                       */
  /*  Same shape as HaTi's own Copilot, with one difference that matters:  */
  /*  it is told to answer in plain English. It reads only what this page  */
  /*  already shows, so it has no route to HaTi's contract data.           */
  /* ==================================================================== */

  var chat = { history: [], busy: false, brain: null, seq: 0 };

  /* ==================================================================== */
  /*  PLAIN or TECHNICAL — the register                                    */
  /*                                                                       */
  /*  Not a tone and not a personality. It decides what an answer is       */
  /*  allowed to LEAVE OUT: plain leaves out the machine detail, and never */
  /*  leaves out a caveat, a warning or a "someone should look at this".   */
  /*                                                                       */
  /*  Read through currentRegister() at the moment of every call, never    */
  /*  captured into a variable when this file loads. A captured value      */
  /*  freezes whichever register was current at load, and every flip after */
  /*  that moves the button and nothing else.                              */
  /* ==================================================================== */

  var REGISTER_KEY = 'hati-mapper.answerRegister';
  var REGISTERS = ['plain', 'technical'];

  function normalizeRegister(v) {
    var s = String(v == null ? '' : v).toLowerCase().trim();
    return REGISTERS.indexOf(s) >= 0 ? s : 'plain';
  }

  /* The browser's copy is authoritative for what the page draws; the server's
     copy exists so the choice follows the owner onto their next device. */
  function currentRegister() {
    try { return normalizeRegister(localStorage.getItem(REGISTER_KEY)); }
    catch (e) { return 'plain'; }
  }

  function setRegister(next, persistToServer) {
    var reg = normalizeRegister(next);
    try { localStorage.setItem(REGISTER_KEY, reg); } catch (e) { /* private mode */ }
    paintRegisterToggle();
    if (persistToServer) {
      send('PUT', '/api/preferences', { answerRegister: reg }).catch(function () {
        /* The page keeps working on the local copy alone. Nothing here is
           worth interrupting a conversation over. */
      });
    }
    return reg;
  }

  function paintRegisterToggle() {
    var reg = currentRegister();
    var row = $('askRegister');
    if (!row) return;
    row.querySelectorAll('button[data-reg]').forEach(function (b) {
      var on = b.getAttribute('data-reg') === reg;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  /* ==================================================================== */
  /*  Rendering the model's reply                                          */
  /*                                                                       */
  /*  The reply is untrusted input. Log lines and error messages from the  */
  /*  monitored system flow through here, so the escaping below is the     */
  /*  security boundary rather than a nicety: every chunk that is not      */
  /*  markdown is escaped — quotes and apostrophes included, because       */
  /*  chunks end up inside attribute values — and link schemes are checked */
  /*  against an allow-list rather than a block-list. javascript: and      */
  /*  data: are the two everybody remembers; the next one has not been     */
  /*  invented yet, so nothing is clickable unless it is on the list.      */
  /* ==================================================================== */

  /* https, http, mailto, an in-page #anchor, or a path on this origin. A bare
     "//host" is deliberately excluded: it looks like a path and is not one. */
  function safeHref(raw) {
    var u = String(raw == null ? '' : raw).trim();
    if (!u || /[\u0000-\u0020\u007f<>"']/.test(u)) return null;
    if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
    if (u.charAt(0) === '#') return u;
    if (u.charAt(0) === '/' && u.charAt(1) !== '/') return u;
    return null;
  }

  /* The marker that stands in for a lifted-out block while the rest of the
     reply is parsed. It is a printable character the escaper leaves alone, and
     any copy of it arriving from the model is stripped before parsing starts,
     so a reply cannot forge one. */
  var SENT = '␞';

  /* Blocks lifted out before anything else runs, so no later pass — bold,
     colour markers, link detection — can reach inside them. */
  function stasher() {
    var kept = [];
    return {
      put: function (html) { kept.push(html); return SENT + 'K' + (kept.length - 1) + SENT; },
      restore: function (s) {
        return s.replace(new RegExp(SENT + 'K(\\d+)' + SENT, 'g'), function (_, i) { return kept[Number(i)] || ''; });
      },
    };
  }

  function inline(text, keep) {
    /* Code spans first, and stashed, so ** inside a code span stays literal. */
    var s = text.replace(/`([^`\n]+)`/g, function (_, code) {
      return keep.put('<code>' + code + '</code>');
    });
    /* Links. The label is already escaped; the address has to earn its href. */
    s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, function (whole, label, href) {
      /* The address arrives escaped, so &amp; has to come back before it is
         judged and before it is used. */
      var raw = href.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      var ok = safeHref(raw);
      if (!ok) return label + ' (' + href + ')';   // still readable, no longer clickable
      return keep.put('<a href="' + esc(ok) + '" target="_blank" rel="noopener noreferrer nofollow">' +
        (label || esc(ok)) + '</a>');
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
    return s;
  }

  /* Colour emphasis for short spans — a status, a deadline, a figure, a risk.
     Applied AFTER the markdown has run, on text that is already escaped, and
     deliberately unable to match across a tag: no < or > may appear inside a
     marker, so it can never wrap half of one element and half of another. */
  var MARKS = { '+': 'good', '-': 'bad', '!': 'warn', '~': 'aside' };

  function colourMarks(html) {
    return html.replace(/\{([+\-!~])([^{}<>]{1,240})\}/g, function (_, sign, body) {
      return '<span class="mk mk-' + MARKS[sign] + '">' + body + '</span>';
    });
  }

  function tableRow(line) {
    var t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return t.split('|').map(function (c) { return c.trim(); });
  }

  /* The renderer proper. Returns the html and the chart requests found in it;
     md() is the shorthand for the callers that cannot contain a chart. */
  function renderMarkdown(src, msgId) {
    var charts = [];
    var mid = msgId == null ? 'x' : String(msgId);
    var keep = stasher();
    /* The sentinel below is a real character, so any of it arriving from the
       model is removed before it can be mistaken for one of ours. */
    var text = String(src == null ? '' : src).split(SENT).join('').trim();

    /* 1. Fenced blocks, before anything is escaped. A monitor-chart block
          becomes a placeholder and its contents are recorded; every other
          fence becomes an escaped, inert code block. */
    text = text.replace(/```([^\n`]*)\r?\n([\s\S]*?)```/g, function (_, info, body) {
      var lang = String(info || '').trim().toLowerCase();
      if (lang === 'monitor-chart') {
        charts.push(body);
        return '\n\n' + SENT + 'C' + (charts.length - 1) + SENT + '\n\n';
      }
      return '\n\n' + keep.put('<pre class="codeblock"' + (lang ? ' data-lang="' + esc(lang) + '"' : '') +
        '><code>' + esc(body.replace(/\r?\n$/, '')) + '</code></pre>') + '\n\n';
    });

    /* 2. Everything that is left is escaped. Nothing after this point can
          introduce markup that the model wrote. */
    text = esc(text);

    /* 3. Blocks. */
    var lines = text.split('\n');
    var out = [], list = null, quote = false, i = 0;

    function closeList() { if (list) { out.push('</' + list + '>'); list = null; } }
    function closeQuote() { if (quote) { out.push('</blockquote>'); quote = false; } }
    function closeAll() { closeList(); closeQuote(); }

    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      var t = line.trim();

      var slot = t.match(new RegExp('^' + SENT + 'C(\\d+)' + SENT + '$'));
      if (slot) {
        closeAll();
        out.push('<div class="chartslot" data-msg="' + esc(mid) + '" data-chart="' + Number(slot[1]) +
          '" data-key="' + esc(mid + ':' + Number(slot[1])) + '"></div>');
        continue;
      }
      var kept = t.match(new RegExp('^' + SENT + 'K(\\d+)' + SENT + '$'));
      if (kept) { closeAll(); out.push(t); continue; }

      if (!t) { closeAll(); continue; }

      if (/^(---+|\*\*\*+|___+)$/.test(t)) { closeAll(); out.push('<hr>'); continue; }

      var head = t.match(/^(#{1,4})\s+(.*)$/);
      if (head) {
        closeAll();
        var level = Math.min(head[1].length + 2, 6);   // # becomes h3 inside a bubble
        out.push('<h' + level + '>' + inline(head[2], keep) + '</h' + level + '>');
        continue;
      }

      /* A table: a header row, a |---|---| rule under it, then body rows. */
      if (t.indexOf('|') >= 0 && i + 1 < lines.length && /^\s*\|?[\s:-]*-[-\s|:]*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
        closeAll();
        var header = tableRow(t);
        var rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
          rows.push(tableRow(lines[i]));
          i++;
        }
        i--;
        out.push('<div class="tblscroll"><table><thead><tr>' +
          header.map(function (c) { return '<th>' + inline(c, keep) + '</th>'; }).join('') +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + inline(c, keep) + '</td>'; }).join('') + '</tr>';
          }).join('') +
          '</tbody></table></div>');
        continue;
      }

      var q = t.match(/^&gt;\s?(.*)$/);
      if (q) {
        closeList();
        if (!quote) { out.push('<blockquote>'); quote = true; }
        out.push('<p>' + inline(q[1], keep) + '</p>');
        continue;
      }
      closeQuote();

      var ul = t.match(/^[-*+]\s+(.*)$/);
      var ol = t.match(/^\d+[.)]\s+(.*)$/);
      if (ul) {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + inline(ul[1], keep) + '</li>');
      } else if (ol) {
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + inline(ol[1], keep) + '</li>');
      } else {
        closeList();
        out.push('<p>' + inline(t, keep) + '</p>');
      }
    }
    closeAll();

    /* 4. Colour markers, then the stashed blocks go back in last of all so
          nothing above could have reached inside them. */
    return { html: keep.restore(colourMarks(out.join(''))), charts: charts };
  }

  function md(src) { return renderMarkdown(src).html; }

  /* ==================================================================== */
  /*  Charts inside an answer                                              */
  /*                                                                       */
  /*  THE MODEL NEVER SUPPLIES THE DATA. It names a kind; renderMarkdown   */
  /*  lifts the block out before the reply is drawn and leaves a           */
  /*  placeholder; the recipes below fill that placeholder from the SAME   */
  /*  live records the dashboard beside it is drawn from. So a chart in an */
  /*  answer cannot drift from the tab it came from, cannot go stale, and  */
  /*  cannot be hallucinated. A model that invents a number gets to invent */
  /*  a SENTENCE, which the reader can weigh — never a CHART, which the    */
  /*  reader reads as measured fact.                                       */
  /*                                                                       */
  /*  The one exception is "quoted", which draws figures the model has     */
  /*  already stated in the same reply and is labelled on screen as its    */
  /*  own figures rather than as a measurement.                            */
  /* ==================================================================== */

  function trendSeries(field, scale) {
    var pts = (trends && trends.points) || [];
    var out = [];
    pts.forEach(function (p) {
      var v = p[field];
      if (typeof v !== 'number' || !isFinite(v)) return;
      out.push({ label: fmtDate(p.at), value: scale ? scale(v) : v });
    });
    return out;
  }

  var TREND_TOO_SHORT = 'The Mapper has fewer than three readings to draw a line through. ' +
    'It records one every time a scan finds something different, so this fills in after a few days.';

  function watchRounds() {
    return (towerWatch && towerWatch.rounds) || (watchData && watchData.rounds) || [];
  }

  /* Each recipe answers with points, or with a reason there are none. Neither
     answer is ever a blank box. */
  var CHART_RECIPES = {
    'cost-trend': {
      title: 'What a full day at HaTi’s caps would cost',
      unit: 'US dollars', type: 'line',
      from: 'the same readings as the “Today’s burn” line on the control tower — this dashboard’s own estimate, a roof rather than a bill',
      build: function () {
        var s = trendSeries('dailyCostUsd');
        return s.length >= 3 ? { points: s } : { empty: TREND_TOO_SHORT };
      },
    },
    'cost-by-feature': {
      title: 'Estimated cost of one use, per AI feature',
      unit: 'US dollars', type: 'hbar',
      from: 'the Money tab — HaTi’s own caps priced at list rates, not a bill',
      build: function () {
        var f = ((scan && scan.cost && scan.cost.features) || [])
          .filter(function (x) { return typeof x.perRequestUsd === 'number'; })
          .sort(function (a, b) { return b.perRequestUsd - a.perRequestUsd; })
          .slice(0, 12)
          .map(function (x) { return { label: x.label || x.feature, value: x.perRequestUsd }; });
        return f.length ? { points: f } : { empty: 'No AI feature in the latest scan could be priced, so there is nothing to draw.' };
      },
    },
    'ai-caps': {
      title: 'How often each AI feature may be used',
      unit: 'requests per 15 minutes', type: 'hbar',
      from: 'the Money tab — the limits written into HaTi’s own code',
      build: function () {
        var f = ((scan && scan.ai && scan.ai.features) || [])
          .filter(function (x) { return typeof x.cap === 'number'; })
          .sort(function (a, b) { return b.cap - a.cap; })
          .slice(0, 12)
          .map(function (x) { return { label: x.label || x.feature, value: x.cap }; });
        return f.length ? { points: f } : { empty: 'The scan could not read a usage cap off any AI feature, so there is nothing to draw.' };
      },
    },
    'open-doors-trend': {
      title: 'Addresses that work without logging in',
      unit: 'addresses', type: 'line',
      from: 'the change log’s own readings, the same ones behind the Open to the public tab',
      build: function () {
        var s = trendSeries('openRoutes');
        return s.length >= 3 ? { points: s } : { empty: TREND_TOO_SHORT };
      },
    },
    'scan-health-trend': {
      title: 'How much of HaTi the scanner could read',
      unit: 'percent', type: 'line',
      from: 'the “Scanner grip” reading on the control tower',
      build: function () {
        var s = trendSeries('health');
        return s.length >= 3 ? { points: s } : { empty: TREND_TOO_SHORT };
      },
    },
    'code-size-trend': {
      title: 'The total size of everything scanned',
      unit: 'kilobytes', type: 'line',
      from: 'the same readings as the “Getting bulky” tab',
      build: function () {
        var s = trendSeries('bytes', function (v) { return v / 1024; });
        return s.length >= 3 ? { points: s } : { empty: TREND_TOO_SHORT };
      },
    },
    'gaps-trend': {
      title: 'Known gaps written down',
      unit: 'gaps', type: 'line',
      from: 'the same readings as the “Not finished” panel',
      build: function () {
        var s = trendSeries('gaps');
        return s.length >= 3 ? { points: s } : { empty: TREND_TOO_SHORT };
      },
    },
    'changes-per-day': {
      title: 'Changes the Mapper observed, by day',
      unit: 'changes', type: 'bar',
      from: 'the watch log — what the Mapper saw move between one scan and the next, not the git history',
      build: function () {
        var rounds = watchRounds();
        if (!rounds.length) return { empty: 'The Mapper has not observed anything change yet, so there is nothing to draw. That is a real answer, not a missing one — it needs two scans to compare.' };
        var byDay = {};
        rounds.forEach(function (r) {
          var d = new Date(r.at);
          if (isNaN(d)) return;
          var key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
          byDay[key] = (byDay[key] || 0) + (r.events || []).length;
        });
        var pts = [], now = new Date();
        for (var i = 13; i >= 0; i--) {
          var d2 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
          var k = d2.getFullYear() + '-' + (d2.getMonth() + 1) + '-' + d2.getDate();
          pts.push({ label: d2.toLocaleString('en-GB', { day: 'numeric', month: 'short' }), value: byDay[k] || 0 });
        }
        return { points: pts };
      },
    },
    'changes-by-area': {
      title: 'Changes the Mapper observed, by area',
      unit: 'changes', type: 'hbar',
      from: 'the watch log — what the Mapper saw move between one scan and the next',
      build: function () {
        var rounds = watchRounds(), tally = {};
        rounds.forEach(function (r) {
          (r.events || []).forEach(function (e) {
            var k = KIND_LABEL[e.kind] || e.kind || 'other';
            tally[k] = (tally[k] || 0) + 1;
          });
        });
        var pts = Object.keys(tally).map(function (k) { return { label: k, value: tally[k] }; })
          .sort(function (a, b) { return b.value - a.value; });
        return pts.length ? { points: pts }
          : { empty: 'The Mapper has not observed anything change yet, so there is nothing to group. It needs two scans to compare.' };
      },
    },
    'biggest-files': {
      title: 'The largest files in HaTi',
      unit: 'kilobytes', type: 'hbar',
      from: 'the “Getting bulky” tab, the same file sizes',
      build: function () {
        var f = ((scan && scan.weight && scan.weight.files) || [])
          .slice()
          .sort(function (a, b) { return b.bytes - a.bytes; })
          .slice(0, 10)
          .map(function (x) { return { label: x.path, value: x.bytes / 1024 }; });
        return f.length ? { points: f } : { empty: 'The latest scan recorded no file sizes, so there is nothing to draw.' };
      },
    },
  };

  /* Published so the verification can hold what this page can actually draw
     against what the server offers the model. Two lists in two languages that
     must never drift apart — a kind the model is offered and the page cannot
     draw is an error card the reader did nothing to deserve. */
  window.__mapperChartKinds = Object.keys(CHART_RECIPES);

  /* The one place the model's own numbers are allowed through, and they are
     labelled as its numbers wherever they appear. */
  function buildQuoted(spec) {
    var pts = Array.isArray(spec.points) ? spec.points : [];
    var clean = pts.filter(function (p) {
      return p && typeof p.value === 'number' && isFinite(p.value);
    }).slice(0, 12).map(function (p) {
      return { label: String(p.label == null ? '' : p.label).slice(0, 40), value: p.value };
    });
    if (clean.length < 2) {
      return { error: 'The assistant asked for a chart of its own figures but gave fewer than two of them.' };
    }
    return {
      title: typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim().slice(0, 90) : 'The assistant’s own figures',
      unit: typeof spec.unit === 'string' ? spec.unit.slice(0, 30) : '',
      type: clean.length > 6 ? 'bar' : 'hbar',
      from: null,
      quoted: true,
      points: clean,
    };
  }

  /* ---- the library, fetched the first time an answer actually wants one ---- */

  var chartLibPromise = null;

  function loadChartLib() {
    if (window.MapperCharts) return Promise.resolve(window.MapperCharts);
    if (chartLibPromise) return chartLibPromise;
    chartLibPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/charts.js';
      s.async = true;
      s.onload = function () {
        if (window.MapperCharts) resolve(window.MapperCharts);
        else reject(new Error('loaded but empty'));
      };
      s.onerror = function () {
        /* Cleared so a later question can try again — a chart library that
           failed to arrive once is usually a blip, not a permanent state. */
        chartLibPromise = null;
        s.parentNode && s.parentNode.removeChild(s);
        reject(new Error('could not be fetched'));
      };
      document.head.appendChild(s);
    });
    return chartLibPromise;
  }

  /* ---- the registry ----

     Every live chart is in here, keyed by the message it belongs to. An
     instance holds a canvas, two listeners, a resize observer and possibly an
     animation frame; dropping the markup without calling destroy() leaks all
     of them, so nothing drops markup without coming through here. */

  var liveCharts = {};      // key -> chart instance
  var chartSpecs = {};      // message id -> the raw blocks found in that reply
  var chartWatcher = null;  // one observer for every slot on screen

  function destroyChart(key) {
    var c = liveCharts[key];
    if (!c) return;
    try { c.destroy(); } catch (e) {}
    delete liveCharts[key];
  }

  /* Redraw every live chart with the colours currently on the page. Guarded
     because the theme is applied while this file is still being read, long
     before any chart exists. */
  function repaintCharts() {
    if (!liveCharts) return;
    Object.keys(liveCharts).forEach(function (key) {
      var c = liveCharts[key];
      if (c && typeof c.draw === 'function') { try { c.draw(); } catch (e) {} }
    });
  }

  function destroyAllCharts() {
    Object.keys(liveCharts).forEach(destroyChart);
    chartSpecs = {};
    if (chartWatcher) { chartWatcher.disconnect(); chartWatcher = null; }
  }

  /* Anything whose canvas is no longer in the document is gone as far as the
     reader is concerned and must not still be holding listeners. Run after
     every repaint of the feed, because a repaint replaces the markup wholesale
     and every chart in it is detached in one go. */
  function sweepCharts() {
    Object.keys(liveCharts).forEach(function (key) {
      var c = liveCharts[key];
      if (!c || !c.canvas || !document.body.contains(c.canvas)) destroyChart(key);
    });
  }

  function chartCard(inner, extraClass) {
    return '<figure class="chartcard' + (extraClass ? ' ' + extraClass : '') + '">' + inner + '</figure>';
  }

  function chartNotice(slot, headline, detail) {
    slot.setAttribute('data-settled', '1');
    slot.innerHTML = chartCard(
      '<figcaption>' + esc(headline) + '</figcaption>' +
      '<div class="chartnote">' + esc(detail) + '</div>', 'flat');
  }

  /* One slot, from its block to something on screen. Every failure below ends
     in a card that says what happened; none of them ends in a blank box or a
     broken panel. */
  function fillChartSlot(slot) {
    var key = slot.getAttribute('data-key');
    if (liveCharts[key]) return;
    /* A card that says why there is no chart has nothing to rebuild, so it is
       written once rather than on every scroll past it. */
    if (slot.getAttribute('data-settled') === '1') return;

    var raw = (chartSpecs[slot.getAttribute('data-msg')] || [])[Number(slot.getAttribute('data-chart'))];
    var index = Number(slot.getAttribute('data-chart'));

    if (index > 0) {
      return chartNotice(slot, 'Only the first chart is drawn',
        'The assistant asked for more than one chart in a single answer. One chart per answer is the rule, so the rest are not drawn.');
    }

    var spec = null;
    try { spec = JSON.parse(String(raw || '')); } catch (e) { spec = null; }
    if (!spec || typeof spec !== 'object' || typeof spec.kind !== 'string') {
      return chartNotice(slot, 'That chart could not be read',
        'The assistant asked for a chart but did not name a kind the page understands. Nothing was drawn, and nothing else in the answer is affected.');
    }

    var kind = spec.kind.trim();
    var recipe = CHART_RECIPES[kind];
    var built;

    if (kind === 'quoted') {
      built = buildQuoted(spec);
      if (built.error) return chartNotice(slot, 'That chart could not be drawn', built.error);
    } else if (!recipe) {
      return chartNotice(slot, 'Unknown chart: “' + kind + '”',
        'The assistant asked for a kind of chart this dashboard does not draw. The rest of the answer is unaffected.');
    } else {
      var data = recipe.build();
      if (data.empty) return chartNotice(slot, recipe.title, data.empty);
      built = {
        title: typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim().slice(0, 90) : recipe.title,
        unit: recipe.unit, type: recipe.type, from: recipe.from, points: data.points, quoted: false,
      };
    }

    if (!built.points || !built.points.length) {
      return chartNotice(slot, built.title || 'Nothing to draw', 'There are no readings behind this chart yet.');
    }

    var height = built.type === 'hbar' ? Math.max(90, Math.min(built.points.length * 24 + 10, 300)) : 150;
    slot.innerHTML = chartCard(
      '<figcaption>' + esc(built.title) +
      (built.unit ? '<span class="unit">' + esc(built.unit) + '</span>' : '') + '</figcaption>' +
      '<div class="chartbox" style="height:' + height + 'px"><canvas></canvas></div>' +
      '<figcaption class="src">' +
      (built.quoted
        ? '<b>The assistant’s own figures</b>, from the answer above — not measured by this dashboard.'
        : 'Drawn by this page from ' + esc(built.from) + '.') +
      '</figcaption>');

    var canvas = slot.querySelector('canvas');
    loadChartLib().then(function (lib) {
      if (!document.body.contains(canvas)) return;    // the feed repainted while we waited
      destroyChart(key);
      liveCharts[key] = lib.create(canvas, {
        type: built.type, unit: built.unit, points: built.points,
      });
    }, function () {
      chartNotice(slot, built.title,
        'The chart could not be drawn because its drawing code did not load. Everything the answer says in words is unaffected — try asking again in a moment.');
    });
  }

  function releaseChartSlot(slot) {
    destroyChart(slot.getAttribute('data-key'));
  }

  /* Charts are created when their card is on screen and destroyed when it is
     well past it, so a long conversation holds a handful of canvases rather
     than one per answer ever given. A card that scrolls back into view is
     rebuilt from its own block, so nothing leaves a hole behind it. */
  function hydrateCharts() {
    sweepCharts();
    var feed = $('askFeed');
    if (!feed) return;
    var slots = feed.querySelectorAll('.chartslot');
    if (!slots.length) {
      if (chartWatcher) { chartWatcher.disconnect(); chartWatcher = null; }
      return;
    }

    /* Rebuilt rather than reused: a repaint replaces every slot element, and
       an observer kept across repaints goes on holding references to elements
       that left the document. */
    if (chartWatcher) chartWatcher.disconnect();
    if (window.IntersectionObserver) {
      chartWatcher = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) fillChartSlot(en.target);
          else releaseChartSlot(en.target);
        });
      }, { root: feed, rootMargin: '400px' });
    }

    slots.forEach(function (slot) {
      if (chartWatcher) chartWatcher.observe(slot);
      else fillChartSlot(slot);       // no observer: draw them all and rely on the sweep
    });

    /* And once more after the browser has actually painted, because that is
       when a canvas that lost its place is finally detached. */
    requestAnimationFrame(sweepCharts);
  }

  function askOpen(open) {
    $('ask').hidden = !open;
    $('askLaunch').hidden = open;
    if (open) {
      refreshBrain();
      paintRegisterToggle();
      setExpanded(rememberedExpanded());   // restore the remembered width
      if (!chat.history.length) renderFeed();
      setTimeout(function () { var i = $('askInput'); if (i && !$('askKey').hidden === false) i.focus(); }, 60);
    }
  }

  /* ---- expand / shrink, remembered between visits ---- */

  var EXPAND_KEY = 'hati-mapper.chatExpanded';

  function rememberedExpanded() {
    try { return localStorage.getItem(EXPAND_KEY) === '1'; } catch (e) { return false; }
  }

  /* Chevrons that point the way the panel will move: outward to grow, inward
     to shrink — the same cue HaTi's own Copilot uses. */
  var CHEV_GROW = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/></svg>';
  var CHEV_SHRINK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 17l5-5-5-5"/><path d="M6 17l5-5-5-5"/></svg>';

  function setExpanded(want) {
    $('ask').classList.toggle('expanded', !!want);
    var b = $('askExpand');
    b.innerHTML = want ? CHEV_SHRINK : CHEV_GROW;
    b.title = want ? 'Shrink the panel' : 'Expand the panel';
    b.setAttribute('aria-label', b.title);
    try { localStorage.setItem(EXPAND_KEY, want ? '1' : '0'); } catch (e) {}
  }

  /* ---- a brief confirmation for actions that are easy to miss ---- */
  var toastTimer = null;
  function toast(text) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = text;
    requestAnimationFrame(function () { el.classList.add('on'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 2200);
  }

  /* Cleared straight away, no confirm — the conversation is local and cheap to
     start again, and a prompt for something this reversible is just friction.
     The charts go with it: they are the one part of a conversation that keeps
     holding listeners and a canvas after its markup is gone. */
  function clearChat() {
    if (!chat.history.length) return toast('Nothing to delete yet');
    destroyAllCharts();
    chat.history = [];
    renderFeed();
    toast('Conversation deleted');
  }

  function refreshBrain() {
    return apiGet('/api/ai/config').then(function (cfg) {
      chat.brain = cfg;
      var el = $('askBrain');
      el.className = 'brain' + (cfg.configured ? ' live' : '');
      el.querySelector('span').textContent = cfg.configured
        ? 'Claude is answering · ' + cfg.model
        : 'No AI key yet — add one to switch it on';
      el.title = cfg.configured
        ? 'Answers come from Claude, called by this service. The key stays on the server.'
        : 'Add an Anthropic key to switch the assistant on.';

      var needsKey = !cfg.configured;
      $('askKey').hidden = !needsKey;
      $('askFeed').hidden = needsKey;
      $('askFoot').hidden = needsKey;

      if (cfg.configured) {
        $('askKeyState').textContent = 'Saved: ' + cfg.hint +
          (cfg.source === 'environment' ? ' (from the service environment)' : '');
      } else {
        $('askKeyState').textContent = 'You can also set this on the Settings tab.';
      }
      if (cfg.budget && cfg.budget.limit) {
        $('askNote').innerHTML = 'It can see how HaTi is built — never what is inside it. No contracts, clients or figures reach it.<br>' +
          'Questions today: ' + cfg.budget.used + ' of ' + cfg.budget.limit + '.' +
          /* Two ways to lose a key, and the second one used to go unmentioned:
             a directory that takes the write and is then replaced by the next
             deploy. Both are worth the same warning. */
          (!cfg.storageIsWritable
            ? ' The key is held in memory only and will be lost if this service restarts — set ANTHROPIC_API_KEY in the dashboard to make it permanent.'
            : cfg.storageIsMounted
              ? ''
              : ' The key is saved, but to a directory this service replaces on every deploy — see Settings.');
      }
      return cfg;
    }, function () { /* the config route is optional to the rest of the page */ });
  }

  /* Saying so while it works.

     The assistant answers in a single request: it decides what it needs, reads
     those parts of the dashboard's own data, and comes back once with the
     finished answer. Nothing reports progress from inside that, so this page
     cannot honestly narrate the steps — it does not know which one is running.
     What it can say truthfully is that the assistant is working, that looking
     things up is part of answering, and that the wait is still going. The
     wording moves on as the wait grows so a long answer never looks stalled,
     and none of it claims to know more than it does. */
  var THINKING = [
    [0, 'Reading your question'],
    [3500, 'Looking things up on this page'],
    [14000, 'Still going — a wide question takes a few more looks'],
    [35000, 'Still going. A long answer can take about a minute'],
  ];
  var thinkingAt = 0, thinkingTimer = null;

  function thinkingLabel() {
    if (!thinkingAt) return THINKING[0][1];
    var ms = Date.now() - thinkingAt;
    var out = THINKING[0][1];
    for (var i = 0; i < THINKING.length; i++) if (ms >= THINKING[i][0]) out = THINKING[i][1];
    return out;
  }

  /* Updated in place rather than by re-rendering the feed: a full re-render
     every second would throw away the reader's scroll position while they are
     reading back over the answer above. */
  function startThinking() {
    thinkingAt = Date.now();
    clearInterval(thinkingTimer);
    thinkingTimer = setInterval(function () {
      var el = document.querySelector('#askFeed .typing .say');
      if (el) el.textContent = thinkingLabel();
    }, 1000);
  }

  function stopThinking() {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
    thinkingAt = 0;
  }

  var WELCOME = 'Hello. I watch how your platform is doing and I can answer questions about it — ' +
    '**is anything broken right now**, what changed since yesterday, what it is costing you to run, ' +
    'whether anything is open that should not be.\n\n' +
    'Use the **Plain / Technical** buttons below to choose how much machine detail you want back. ' +
    'You can flip them over an answer that is already on screen and I will say the same thing the other way.\n\n' +
    'I read the same information the tabs above show. {~I never see the contracts inside HaTi.}';

  /* The text of one assistant message in the register currently chosen, if
     there is a version of it in that register. Read at call time. */
  function bodyFor(m) {
    var reg = currentRegister();
    if (m.versions && m.versions[reg]) return m.versions[reg];
    return m.content;
  }

  function renderFeed(typing) {
    var feed = $('askFeed');
    var html = '';

    /* Every repaint replaces this markup wholesale, so anything a previous
       repaint left holding a canvas is released here rather than lingering
       until the sweep happens to run. */
    var seenCharts = {};

    if (!chat.history.length) {
      html += '<div class="msg bot"><div class="body">' + md(WELCOME) + '</div></div>';
    }

    chat.history.forEach(function (m) {
      if (m.role === 'user') {
        html += '<div class="msg me">' + esc(m.content) + '</div>';
        return;
      }
      var text = bodyFor(m);
      var drawn = renderMarkdown(text, m.id);
      chartSpecs[m.id] = drawn.charts;
      seenCharts[m.id] = true;

      html += '<div class="msg bot' + (m.error ? ' err' : '') + '"' +
        (m.id ? ' data-msg="' + esc(m.id) + '"' : '') + '>' +
        '<div class="body">' + drawn.html;
      if (m.watchOut) html += '<div class="watch">' + esc(m.watchOut) + '</div>';
      html += '</div>';
      if (m.restating) {
        html += '<div class="restating" role="status" aria-live="polite">Saying that again, ' +
          esc(currentRegister() === 'technical' ? 'in full detail' : 'in plain English') + '…</div>';
      }
      /* A drafted prompt exists to be pasted somewhere else, so the only thing
         that matters is getting it out of here intact. */
      if (m.copyable) {
        html += '<div class="srcs"><button class="copy" data-copy="' + esc(text) + '">Copy this prompt</button></div>';
      }
      if (m.sources && m.sources.length) {
        html += '<div class="srcs">' + m.sources.map(function (s) {
          return '<button data-tab="' + esc(s.tab) + '" title="' + esc(s.note || '') + '">See “' + esc(s.label) + '”</button>';
        }).join('') + '</div>';
      }
      html += '</div>';
    });

    /* Announced to a screen reader as well as drawn, since "it is working" is
       exactly the kind of thing an animation alone never tells anyone. */
    if (typing) {
      html += '<div class="typing" role="status" aria-live="polite">' +
        '<span class="dots"><i></i><i></i><i></i></span>' +
        '<span class="say">' + esc(thinkingLabel()) + '</span></div>';
    }
    feed.innerHTML = html;
    feed.scrollTop = feed.scrollHeight;

    /* Blocks belonging to messages that are no longer in the conversation go
       too, so this map cannot grow for the life of the tab. */
    Object.keys(chartSpecs).forEach(function (id) { if (!seenCharts[id]) delete chartSpecs[id]; });
    hydrateCharts();
  }

  function nextMsgId() { chat.seq += 1; return 'm' + chat.seq; }

  /* Every request to the assistant goes through here, so there is exactly one
     place that decides which register is being asked for — and it decides it
     now, from currentRegister(), rather than from anything captured earlier. */
  function askServer(body) {
    return send('POST', '/api/chat', Object.assign({ register: currentRegister() }, body || {}));
  }

  function sendQuestion(q) {
    if (chat.busy || !q.trim()) return;
    var question = q.trim();
    chat.busy = true;
    chat.history.push({ role: 'user', content: question });
    startThinking();
    renderFeed(true);
    $('askSend').disabled = true;
    $('askInput').value = '';
    $('askInput').style.height = '';

    var payload = chat.history
      .filter(function (m) { return !m.error; })
      .map(function (m) { return { role: m.role, content: m.role === 'assistant' ? bodyFor(m) : m.content }; });

    askServer({ messages: payload })
      .then(function (b) {
        var versions = {};
        versions[normalizeRegister(b.register)] = b.answer;
        chat.history.push({
          id: nextMsgId(), role: 'assistant', content: b.answer,
          sources: b.sources, watchOut: b.watchOut,
          question: question, versions: versions,
        });
        if (b.budget) refreshBrain();
      })
      .catch(function (e) {
        chat.history.push({ id: nextMsgId(), role: 'assistant', content: e.message, error: true });
        if (e.body && e.body.needsKey) refreshBrain();
      })
      .then(function () {
        chat.busy = false;
        $('askSend').disabled = false;
        stopThinking();
        renderFeed(false);
        reconcileRegister();
      });
  }

  /* ---- flipping the toggle over an answer already on screen ----

     The toggle is not only a preference for the next question. Flipping it
     re-says the answer the reader is looking at, in place, in the register
     they have just chosen. Both versions are kept once they exist, so flipping
     back is instant and never asks the model again.

     The existing bubble is REPLACED, never joined by a second one. One
     explanation wearing two registers is one thing; two bubbles read as two
     opinions. */

  /* If the toggle was flipped while an answer was in the air, that answer
     arrives written in the register that was current when it was asked, and
     the toggle now says something else. Rather than leave the two disagreeing,
     the answer is put into the register the reader is actually looking at. */
  function reconcileRegister() {
    var m = lastAnswer();
    if (!m || !m.versions) return;
    if (m.versions[currentRegister()]) return;
    restateOnScreen();
  }

  function lastAnswer() {
    for (var i = chat.history.length - 1; i >= 0; i--) {
      var m = chat.history[i];
      if (m.role === 'assistant' && !m.error) return m;
    }
    return null;
  }

  function restateOnScreen() {
    var m = lastAnswer();
    if (!m) return;                       // nothing on screen to restate
    /* A drafted fix prompt is not an explanation, it is an artefact to paste
       into another session. Re-saying it in plainer words would damage the
       thing itself, so the toggle leaves it alone and only remembers. */
    if (m.copyable) return;
    var reg = currentRegister();
    if (m.versions && m.versions[reg]) { renderFeed(false); return; }   // cached: instant
    if (chat.busy) { renderFeed(false); return; }

    chat.busy = true;
    m.restating = true;
    $('askSend').disabled = true;
    renderFeed(false);

    askServer({ restate: { question: m.question || '', answer: m.content } })
      .then(function (b) {
        var got = normalizeRegister(b.register);
        m.versions = m.versions || {};
        m.versions[got] = b.answer;
        /* Only the words change. The sources and the warning belong to the
           finding, not to the register it was said in. */
        if (b.watchOut) m.watchOut = b.watchOut;
        if (b.sources && b.sources.length) m.sources = b.sources;
        if (b.budget) refreshBrain();
      })
      .catch(function (e) {
        toast('Could not say that again: ' + e.message);
      })
      .then(function () {
        m.restating = false;
        chat.busy = false;
        $('askSend').disabled = false;
        renderFeed(false);
      });
  }

  /* ---- draft a fix prompt ----

     The dashboard is good at showing what is wrong and was useless at helping
     do anything about it: the next step is always describing the finding
     accurately to an overnight session, and that means naming files and
     identifiers nobody should be expected to remember. The server builds the
     instruction from the scan, so the paths in it are the ones that were
     actually scanned. */

  /* `label` is read by a screen reader only, so two of these buttons on one
     screen are distinguishable. `text` replaces the visible wording, for the
     one button that covers a whole list rather than a single finding. */
  function fixButton(kind, id, label, text) {
    return '<button class="fixbtn" data-fix="' + esc(kind) + '" data-id="' + esc(id) + '"' +
      ' title="Write a prompt I can paste into a Claude Code session">' +
      esc(text || 'Draft a fix prompt') + (label ? '<span class="sr">' + esc(label) + '</span>' : '') + '</button>';
  }

  function draftFix(kind, id) {
    if (chat.busy) return;
    askOpen(true);
    chat.busy = true;
    chat.history.push({ role: 'user', content: 'Draft a fix prompt for this.' });
    startThinking();
    renderFeed(true);
    $('askSend').disabled = true;

    /* Through askServer like every other request, so the drafted prompt is
       shaped by the same toggle as everything else. */
    askServer({ draft: { kind: kind, id: id } })
      .then(function (b) {
        var versions = {};
        versions[normalizeRegister(b.register)] = b.answer;
        chat.history.push({
          id: nextMsgId(), role: 'assistant', content: b.answer,
          sources: b.sources, watchOut: b.watchOut, copyable: true,
          question: 'Draft a fix prompt for this.', versions: versions,
        });
        if (b.budget) refreshBrain();
      })
      .catch(function (e) {
        chat.history.push({ id: nextMsgId(), role: 'assistant', content: e.message, error: true });
        if (e.body && e.body.needsKey) refreshBrain();
      })
      .then(function () {
        chat.busy = false;
        $('askSend').disabled = false;
        stopThinking();
        renderFeed(false);
      });
  }

  /* One listener for every panel — the buttons are rendered inside markup that
     is replaced on each scan, so binding them individually would leak. */
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-fix]');
    if (!b) return;
    draftFix(b.getAttribute('data-fix'), b.getAttribute('data-id'));
  });

  /* --- wiring --- */

  /* The toggle. Flipping it saves the choice, repaints the buttons, and then
     re-says whatever answer is already on screen in the register just chosen.
     If there is nothing on screen, it does nothing more than remember. */
  $('askRegister').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-reg]');
    if (!b) return;
    var want = normalizeRegister(b.getAttribute('data-reg'));
    if (want === currentRegister()) return;
    setRegister(want, true);
    restateOnScreen();
  });

  $('askLaunch').addEventListener('click', function () { askOpen(true); });
  $('askClose').addEventListener('click', function () { askOpen(false); });
  $('askExpand').addEventListener('click', function () {
    setExpanded(!$('ask').classList.contains('expanded'));
  });
  $('askClear').addEventListener('click', clearChat);

  /* Escape shrinks an expanded panel first, then closes it — so the key never
     loses a conversation you were only trying to make smaller. */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || $('ask').hidden) return;
    if ($('ask').classList.contains('expanded')) setExpanded(false);
    else askOpen(false);
  });

  $('askForm').addEventListener('submit', function (e) {
    e.preventDefault();
    sendQuestion($('askInput').value);
  });

  $('askInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuestion(this.value); }
  });
  $('askInput').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 110) + 'px';
  });

  /* "See <panel>" jumps to that tab, so an answer always has somewhere to
     land rather than being the end of the conversation. */
  $('askFeed').addEventListener('click', function (e) {
    var c = e.target.closest('button[data-copy]');
    if (c) {
      var text = c.getAttribute('data-copy');
      var done = function () { toast('Prompt copied — paste it into a session'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { toast('Could not copy — select the text and copy it by hand'); });
      } else {
        toast('This browser will not let the page copy for you — select the text and copy it by hand');
      }
      return;
    }
    var b = e.target.closest('button[data-tab]');
    if (!b) return;
    var tab = document.querySelector('.pills button[data-p="' + b.getAttribute('data-tab') + '"]');
    if (tab) { tab.click(); askOpen(false); }
  });

  $('askKeySave').addEventListener('click', function () {
    var key = $('askKeyInput').value.trim();
    var err = $('askKeyErr');
    err.hidden = true;
    if (!key) { err.textContent = 'Paste the key first.'; err.hidden = false; return; }
    this.disabled = true;
    this.textContent = 'Saving…';
    var btn = this;
    send('PUT', '/api/ai/config', { key: key })
      .then(function () {
        $('askKeyInput').value = '';
        return refreshBrain();
      })
      .catch(function (e) { err.textContent = e.message; err.hidden = false; })
      .then(function () { btn.disabled = false; btn.textContent = 'Save key'; });
  });

  /* ==================================================================== */
  /*  Settings                                                             */
  /* ==================================================================== */

  function renderSettings(cfg) {
    if (!cfg) return;
    $('setModel').textContent = cfg.model || '—';
    $('setBudget').textContent = cfg.budget
      ? cfg.budget.used + ' of ' + cfg.budget.limit + ' today'
      : '—';
    var st = $('setKeyState');
    if (cfg.configured) {
      st.className = 'state';
      st.style.color = 'var(--goodtx)';
      st.textContent = 'Saved · ' + cfg.hint +
        (cfg.source === 'environment' ? ' (from this service’s environment)' : '');
    } else {
      st.className = 'state';
      st.style.color = '';
      st.textContent = cfg.environmentFallback
        ? 'Not set here — falling back to the service environment.'
        : 'Not set. The assistant cannot answer until you add one.';
    }
    $('setEmail').textContent = (authInfo && authInfo.email) || '—';
    /* Three states. The middle one used to be reported as the good one, on the
       strength of writes succeeding — which they do right up until the deploy
       that throws the directory away. */
    var where = cfg.storagePath ? ' <code>' + esc(cfg.storagePath) + '</code>' : '';
    $('setStorageNote').innerHTML = !cfg.storageIsWritable
      ? '<b>Nothing is being saved.</b> This service cannot write to its state directory, so your account, your key and the change log are held in memory only and go when it restarts.'
      : cfg.storageIsMounted
        ? 'Your account, your key, the day’s question count and the change log are written to' + where +
          ', which is outside this service’s own directory — so a redeploy does not touch them. ' +
          'That is how a mounted disk looks from in here; it is not proof of one, so if that path is not your disk, it is not permanent.'
        : '<b>This is not a permanent disk.</b> Everything is being written to' + where +
          ', inside the service’s own directory, which your host replaces on every deploy. Writing works, and then it is thrown away — ' +
          'so your account, your key and the change log start again each time you ship, and the change log can never hold more than the time since the last deploy. ' +
          'Attach a disk in your hosting dashboard and point <code>MAPPER_DATA</code> at it.';
  }

  function settingsState(id, kind, text) {
    var el = $(id);
    el.className = 'state' + (kind ? ' ' + kind : '');
    el.textContent = text;
  }

  $('setKeySave').addEventListener('click', function () {
    var key = $('setKey').value.trim();
    if (!key) return settingsState('setKeyState', 'bad', 'Paste the key first.');
    var btn = this; btn.disabled = true;
    settingsState('setKeyState', '', 'Saving…');
    send('PUT', '/api/ai/config', { key: key })
      .then(function () { $('setKey').value = ''; return refreshBrain(); })
      .then(function (cfg) { renderSettings(cfg); })
      .catch(function (e) { settingsState('setKeyState', 'bad', e.message); })
      .then(function () { btn.disabled = false; });
  });

  $('setKeyClear').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    settingsState('setKeyState', '', 'Removing…');
    send('PUT', '/api/ai/config', { clear: true })
      .then(function () { return refreshBrain(); })
      .then(function (cfg) { renderSettings(cfg); })
      .catch(function (e) { settingsState('setKeyState', 'bad', e.message); })
      .then(function () { btn.disabled = false; });
  });

  $('setPwSave').addEventListener('click', function () {
    var current = $('setPwCurrent').value, next = $('setPwNew').value;
    if (!current || !next) return settingsState('setPwState', 'bad', 'Fill in both boxes.');
    var btn = this; btn.disabled = true;
    settingsState('setPwState', '', 'Changing…');
    post('/api/auth/change-password', { current: current, password: next })
      .then(function () {
        $('setPwCurrent').value = ''; $('setPwNew').value = '';
        settingsState('setPwState', 'good', 'Changed. Other devices were signed out.');
      })
      .catch(function (e) { settingsState('setPwState', 'bad', e.message); })
      .then(function () { btn.disabled = false; });
  });

  /* ==================================================================== */
  /*  Tripwires                                                            */
  /*                                                                       */
  /*  Things the owner decides once and then stops thinking about. The     */
  /*  banner stays pinned to the top of the page until it is dismissed,    */
  /*  because a warning that scrolls away is a warning that was missed.    */
  /* ==================================================================== */

  var watch = null;

  var TRIP_ICON = '<svg width="18" height="18" style="flex:none;margin-top:2px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>';

  function renderTripped(tripped, trouble) {
    var el = $('tripped');
    var list = tripped || [];
    var html = '';

    /* The Mapper failing to read HaTi is not a rule the owner set, and there
       is nothing to dismiss — it stays until a scan works again. It goes
       first, because while it is showing, everything below it is stale. */
    if (trouble) {
      html += '<div class="trip" id="scanTrouble">' + TRIP_ICON + '<div class="bd">' +
        '<b>The Mapper cannot read HaTi’s code</b>' +
        '<div>It has failed ' + trouble.failedScans + ' times in a row, since ' + esc(fmtDate(trouble.since, true)) + '. ' +
        'Reason: ' + esc(trouble.reason || 'not recorded') + '. ' +
        'Everything on this page is the last scan that worked, so it will look correct while describing older code.' +
        (trouble.emailed ? ' You have been emailed about this once; there will not be another until a scan succeeds.' : '') +
        '</div></div></div>';
    }

    html += list.map(function (t) {
      return '<div class="trip">' + TRIP_ICON + '<div class="bd">' +
        '<b>' + esc(t.title) + '</b>' +
        '<div>' + esc(t.text) + '</div>' +
        '<div class="when">noticed ' + esc(fmtDate(t.at, true)) + ' ' + fixButton('tripped', t.key) + '</div>' +
        '</div><button type="button" data-key="' + esc(t.key) + '">Dismiss</button></div>';
    }).join('');

    el.innerHTML = html;
    el.hidden = !html;
  }

  $('tripped').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-key]');
    if (!b) return;
    b.disabled = true;
    post('/api/watch/dismiss', { key: b.getAttribute('data-key') })
      .then(function (r) { renderTripped(r.tripped, watch && watch.scanTrouble); })
      .catch(function () { b.disabled = false; });
  });

  function renderWatchRules(w) {
    if (!w) return;
    watch = w;
    renderTripped(w.tripped, w.scanTrouble);

    $('watchRules').innerHTML = w.rules.map(function (r) {
      var say = esc(r.plain);
      if (r.unit) {
        say += ' <input type="number" min="1" data-th="' + esc(r.name) + '" value="' + esc(r.threshold) + '"' +
          (r.on ? '' : ' disabled') + '> ' + esc(r.unit);
      }
      var why = r.why;
      if (r.name === 'aiRequests' && !w.canWatchLiveUsage) {
        why += ' Right now the Mapper cannot reach the running HaTi, so this one cannot be checked.';
      }
      return '<div class="rule"><div class="bd"><b>' + say + '</b>' +
        '<div class="subnum">' + esc(why) + '</div></div>' +
        '<button type="button" class="toggle" data-rule="' + esc(r.name) + '" aria-pressed="' + (r.on ? 'true' : 'false') + '">' +
        (r.on ? 'On' : 'Off') + '</button></div>';
    }).join('');
  }

  function loadWatchRules() {
    return apiGet('/api/watch').then(renderWatchRules, function () {});
  }

  function saveRule(name, patch) {
    return send('PUT', '/api/watch', { name: name, on: patch.on, threshold: patch.threshold })
      .then(function (r) {
        renderWatchRules({
          rules: r.rules, tripped: r.tripped,
          canWatchLiveUsage: watch && watch.canWatchLiveUsage,
          scanTrouble: watch && watch.scanTrouble,
        });
      });
  }

  $('watchRules').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-rule]');
    if (!b) return;
    b.disabled = true;
    saveRule(b.getAttribute('data-rule'), { on: b.getAttribute('aria-pressed') !== 'true' })
      .catch(function () { b.disabled = false; });
  });

  $('watchRules').addEventListener('change', function (e) {
    var i = e.target.closest('input[data-th]');
    if (!i) return;
    saveRule(i.getAttribute('data-th'), { threshold: Number(i.value) }).catch(function () {});
  });

  /* ---- being told about things ---- */

  var prefs = null;

  function renderPrefs(p) {
    if (!p) return;
    prefs = p;

    /* The register the owner last chose, as the server remembers it. A browser
       that has never been told adopts it, so the choice follows them onto a new
       device; a browser that has its own answer keeps it, because whatever they
       last pressed on THIS screen is the more recent instruction. */
    var localReg = null;
    try { localReg = localStorage.getItem(REGISTER_KEY); } catch (e) {}
    if (!localReg && p.answerRegister) setRegister(p.answerRegister, false);
    paintRegisterToggle();

    var b = $('setDigest');
    b.textContent = p.digestEmail ? 'On' : 'Off';
    b.setAttribute('aria-pressed', String(!!p.digestEmail));
    b.className = 'btn' + (p.digestEmail ? ' btn-primary' : '');

    var state = $('setDigestState');
    if (!p.canEmail) {
      state.className = 'state';
      state.textContent = p.digestEmail
        ? 'Switched on, but no email provider is set up on this service, so nothing will be sent. The same summary is on the “What changed” tab.'
        : 'No email provider is set up on this service. Add RESEND_API_KEY in your hosting dashboard to switch this on.';
      return;
    }
    state.className = 'state' + (p.digestEmail ? ' good' : '');
    state.textContent = p.digestEmail
      ? 'On. Sent once a day, on the first scan after 6am.' +
        (p.lastDigestDate ? ' Last sent ' + p.lastDigestDate + '.' : '')
      : 'Off. The summary is still on the “What changed” tab.';
  }

  function loadPrefs() {
    return apiGet('/api/preferences').then(renderPrefs, function () {});
  }

  $('setDigest').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    send('PUT', '/api/preferences', { digestEmail: !(prefs && prefs.digestEmail) })
      .then(function (p) {
        // The write route answers with what it changed; keep the rest.
        var merged = { digestEmail: p.digestEmail, canEmail: p.canEmail, durable: p.durable };
        merged.lastDigestDate = prefs ? prefs.lastDigestDate : null;
        renderPrefs(merged);
      })
      .catch(function (e) { settingsState('setDigestState', 'bad', e.message); })
      .then(function () { btn.disabled = false; });
  });

  $('setSignOut').addEventListener('click', function () { signOut(false); });
  $('setSignOutAll').addEventListener('click', function () { signOut(true); });

  /* --------------------------------------------------------------- boot */

  /* Everything the dashboard does needs a session, so nothing is fetched
     until we know there is one. */
  function boot(after) {
    return fetch('/api/auth/status', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (info) {
        authInfo = info;
        if (after && after.email) authInfo.email = after.email;

        var resetToken = resetTokenFromUrl();
        if (resetToken && !info.signedIn) return showAuth('reset');
        if (!info.claimed) return showAuth('setup');
        if (!info.signedIn && !(after && after.ok)) return showAuth('login');

        showApp(authInfo);
        load(false);
        loadWatch();
        loadTowerWatch();
        loadDigest();
        loadWatchRules();
        loadTrends();
        refreshBrain().then(renderSettings, function () {});
        loadPrefs();
        loadWatchRules();
        // Only what the last check found; knocking needs the button.
        loadDoors();
      })
      /* This used to report every failure as "the server did not answer",
         including a fault in the page's own drawing code — which sent anyone
         debugging it looking at the network for a bug that was on this side
         of it. A page fault is now re-thrown so it reaches the console as
         itself, and only a genuine failure to reach the server gets that
         message. */
      .catch(function (e) {
        showAuth('login');
        var reachable = authInfo !== null;
        if (reachable) {
          authMsg('bad', 'This page hit a fault while drawing itself. Reload; if it keeps happening the details are in the browser console.');
          setTimeout(function () { throw e; }, 0);
          return;
        }
        authMsg('bad', 'The server did not answer. If this page has just been redeployed, wait a moment and reload.');
      });
  }

  boot();
})();
