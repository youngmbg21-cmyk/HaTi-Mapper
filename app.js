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
  function nd(label) { return '<span class="none">' + esc(label || 'not detected') + '</span>'; }

  function skeleton(rows) {
    var out = '<div class="skel">';
    for (var i = 0; i < (rows || 5); i++) out += '<i></i>';
    return out + '</div>';
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

  var tabs = document.querySelectorAll('.nav button');
  var panels = document.querySelectorAll('.panel');
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      tabs.forEach(function (x) { x.setAttribute('aria-selected', String(x === t)); });
      panels.forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== t.getAttribute('data-p'); });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  function setLoading() {
    $('glance').innerHTML = '';
    ['screensBody', 'costBody', 'dataBody', 'blastBody', 'gapsBody', 'publicBody', 'changesBody', 'weightBody', 'orphanBody', 'watchBody', 'digestBody']
      .forEach(function (id) { $(id).innerHTML = skeleton(5); });
    $('capsBody').innerHTML = skeleton(4);
    $('screensBody').innerHTML = skeleton(6) +
      '<p class="loading-note"><b>Downloading HaTi and reading its source.</b> This is one repository download, then everything is parsed here. ' +
      'A warm scan takes a second or two; a cold one — the first after this service has been idle, which spins it down — has to start the server first and can take up to a minute.</p>';
  }

  /* ---- headline strip ---- */
  function renderGlance() {
    var g = [
      { n: scan.screens.length, l: 'Screens' },
      { n: scan.ai.features.length, l: 'AI features' },
      { n: scan.ai.modelsInUse.length, l: 'Models in use' },
      { n: scan.storage.tables.length, l: 'Data tables' },
      { n: scan.public.routes.length, l: 'Open to the public', warn: true },
      { n: scan.gaps.gaps.length, l: 'Known gaps', warn: true },
    ];
    $('glance').innerHTML = g.map(function (x) {
      return '<div class="g' + (x.warn ? ' warn' : '') + '"><div class="n">' + x.n + '</div><div class="l">' + esc(x.l) + '</div></div>';
    }).join('');
  }

  /* ---- 1. screens ---- */
  function renderScreens() {
    var multiScreen = (scan.moduleFacts || []).filter(function (m) { return m.multiScreen; });
    var multiJob = (scan.moduleFacts || []).filter(function (m) { return m.multiJob; });

    $('screensLede').textContent =
      scan.screens.length + ' screens, ' + scan.streams.length + ' built-in value streams. ' +
      'The file each one lives in is on the right.';

    var rows = scan.screens.map(function (s) {
      var flags = '';
      if (s.sharedWith && s.sharedWith.length) {
        flags += '<span class="flag" title="This module also renders: ' + esc(s.sharedWith.join(', ')) + '">shares its file</span>';
      }
      if (s.entry === 'hash') flags += '<span class="flag info" title="Reached by a URL hash, not a nav entry">no login</span>';
      return '<tr>' +
        '<td><b>' + esc(s.label) + '</b>' + flags + '</td>' +
        '<td>' + (s.does ? esc(s.does) : nd()) + '</td>' +
        '<td class="path">' + (s.module ? esc(s.module.replace(/^js\//, '')) : nd()) +
        (s.bytes != null ? '<div style="color:var(--n400)">' + kb(s.bytes) + '</div>' : '') + '</td>' +
        '</tr>';
    }).join('');

    var html =
      '<table><thead><tr><th style="width:170px">Screen</th><th>What a person does here</th><th style="width:150px">Lives in</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';

    if (multiScreen.length || multiJob.length) {
      var bits = [];
      multiScreen.forEach(function (m) {
        bits.push('<div style="margin-bottom:4px"><b>' + esc(m.module.replace(/^js\//, '')) + '</b> backs ' +
          m.screens.length + ' screens — ' + esc(m.screens.join(' and ')) + '.</div>');
      });
      multiJob.forEach(function (m) {
        bits.push('<div style="margin-bottom:4px"><b>' + esc(m.module.replace(/^js\//, '')) + '</b> carries ' +
          m.sections.length + ' separate jobs in one file, by its own section headings — ' +
          esc(m.sections.map(function (s) { return s.replace(/^VIEW:\s*/, ''); }).join('; ')) +
          ' — across ' + kb(m.bytes) + ' and ' + m.exportCount + ' exported names.</div>');
      });
      html += '<div class="blast-note">' + bits.join('') + '</div>';
    }

    html += '<div class="streams"><span class="eyebrow" style="margin-right:2px">Value streams</span>' +
      scan.streams.map(function (s) {
        return '<span class="stream" title="' + esc(s.desc) + '"><i style="background:' + esc(s.color) + '"></i>' +
          esc(s.name.split(/\s*[&(]/)[0].trim()) + '</span>';
      }).join('') + '</div>';

    if (scan.customStreamsNote) {
      html += '<div class="blast-note" style="margin-top:9px">' + esc(scan.customStreamsNote) + '</div>';
    }

    $('screensBody').innerHTML = html;
  }

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
    var rows = scan.ai.features.map(function (f) {
      var tiers = f.tiers.length
        ? f.tiers.map(function (t) { return '<span class="tier ' + esc(t) + '">' + esc(t) + '</span>'; }).join(' ')
        : nd();
      var models = f.models.length
        ? f.models.map(function (m) { return esc(m); }).join('<br>')
        : nd();
      var used = f.usedBy.length
        ? f.usedBy.map(function (c) { return esc(callSiteName(c)); }).join(', ')
        : '<span class="none">not called from the front end</span>';
      /* What one use of this feature could cost at most. Never a bill — the
         assumption behind it is printed under the table. */
      var c = costFor(f.feature);
      var money;
      if (!c || c.perRequestUsd == null) {
        money = nd(c && c.unpricedModels.length ? 'price not on file' : 'no ceiling in the code');
      } else {
        money = '<b>' + esc(usd(c.perRequestUsd)) + '</b>' +
          (c.perWindowUsd != null
            ? '<div style="color:var(--n500)">' + esc(usd(c.perWindowUsd)) + ' if one person hits the cap</div>'
            : '');
      }

      return '<tr>' +
        '<td><b>' + esc(f.label || f.feature) + '</b>' +
        '<div class="path">' + (f.does ? esc(f.does) : nd()) + '</div>' +
        '<div class="path" style="color:var(--n400)">' + esc(f.route) + '</div></td>' +
        '<td>' + tiers + '</td>' +
        '<td class="path">' + models + '</td>' +
        '<td class="num">' + (f.cap == null ? '—' : num(f.cap)) + '</td>' +
        '<td class="num">' + money + '</td>' +
        '</tr>' +
        '<tr><td colspan="5" style="padding-top:0;border-bottom:1px solid var(--divider)">' +
        '<span class="path">Used by: </span><span style="font-size:11.5px;color:var(--n600)">' + used + '</span></td></tr>';
    }).join('');

    var html = '<table><thead><tr><th style="width:190px">Feature</th><th style="width:70px">Tier</th><th>Model</th>' +
      '<th class="num" style="width:88px">Cap / ' + (scan.ai.windowMinutes || 15) + ' min</th>' +
      '<th class="num" style="width:120px">Roughly, per use</th></tr></thead><tbody>' + rows + '</tbody></table>';

    html += renderCostNote();

    if (scan.ai.nonBillingAiRoutes && scan.ai.nonBillingAiRoutes.length) {
      html += '<div class="blast-note">Another ' + scan.ai.nonBillingAiRoutes.length + ' routes sit under <span class="path">/api/ai/</span> ' +
        'but never call Anthropic — they read and set configuration, so they cost nothing: ' +
        scan.ai.nonBillingAiRoutes.map(function (r) { return '<span class="path">' + esc(r.label || r.path) + '</span>'; }).join(', ') + '.</div>';
    }
    $('costBody').innerHTML = html;
    renderCaps();
  }

  /* The honesty label, the day's ceiling, and whether the price list itself is
     still trustworthy. All three belong together — a number without them is
     the thing this panel was careful not to become. */
  function renderCostNote() {
    var c = scan.cost;
    if (!c) return '';
    var out = '<div class="blast-note">';

    if (c.dailyCeilingUsd != null) {
      out += '<b>A whole day, at the limits the code sets: at most about ' + esc(usd(c.dailyCeilingUsd)) + '.</b> ' +
        'That is ' + num(c.dailyLimit) + ' requests, every one of them the most expensive kind (' + esc(c.dearest) + '). ' +
        (c.dailyMixedUsd != null
          ? 'Spread across the features more evenly it is nearer ' + esc(usd(c.dailyMixedUsd)) + '. '
          : '');
    } else {
      out += '<b>A daily total could not be worked out.</b> ' +
        'That needs both a daily request limit in the code and a price for at least one model in use. ';
    }

    out += esc(c.assumption);

    if (c.modelsWithoutPrice.length) {
      out += ' <span style="color:var(--danger)">' + c.modelsWithoutPrice.length + ' model' +
        (c.modelsWithoutPrice.length === 1 ? ' has' : 's have') + ' no price on file — ' +
        c.modelsWithoutPrice.map(function (m) { return esc(m); }).join(', ') +
        '. Nothing is guessed for them.</span>';
    }

    out += '<div style="margin-top:6px;color:var(--n500)">Prices last checked ' + esc(fmtDate(c.asOf)) +
      ' and written down by hand in <span class="path">data/pricing.js</span>.' +
      (c.stale ? ' <b style="color:var(--amber)">That is over ' + c.ageDays + ' days ago — they may be out of date.</b>' : '') +
      '</div></div>';
    return out;
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

    if (!live) {
      var why = (pulse && pulse.reason) || 'The Mapper could not reach the running HaTi.';
      lede.textContent = 'Live values are unavailable, so these are the defaults written in HaTi’s code.';
      html += '<div class="notice"><div><b>Showing code defaults, not live values.</b> ' + esc(why) +
        ' Everything else on this page is read from HaTi’s source and is unaffected.</div></div>';
    } else {
      lede.textContent = 'Set in Team & Settings. These are the values live on this workspace, not the defaults.';
    }

    var rows = caps.map(function (c) {
      var value = live && pulse.caps && pulse.caps[c.key] != null ? pulse.caps[c.key] : c.codeDefault;
      var suffix = c.key === 'aiMaxChars' ? ' chars' : (c.key === 'aiDailyLimit' ? ' requests' : '');
      var differs = live && pulse.caps && pulse.caps[c.key] != null && c.codeDefault != null && pulse.caps[c.key] !== c.codeDefault;
      return '<tr><td style="width:250px"><b>' + esc(c.label) + '</b>' +
        '<div class="path">' + esc(c.key) + (c.envVar ? ' · ' + esc(c.envVar) : '') + '</div></td>' +
        '<td class="path">' + esc(c.note) + (differs ? '<div style="color:var(--amber)">code default ' + num(c.codeDefault) + '</div>' : '') + '</td>' +
        '<td class="num" style="width:130px">' + (value == null ? nd() : num(value) + suffix) + '</td></tr>';
    }).join('');

    var usage = '';
    if (live && pulse.usage) {
      var pct = pulse.usage.dailyLimit ? pulse.usage.count / pulse.usage.dailyLimit : 0;
      usage = '<tr><td><b>Used so far today</b><div class="path">' + esc(pulse.usage.date || '') + '</div></td>' +
        '<td class="path">Counted from the spend ledger, so a restart does not reset it</td>' +
        '<td class="num"' + (pct > 0.7 ? ' style="color:var(--amber)"' : '') + '>' +
        num(pulse.usage.count) + ' / ' + num(pulse.usage.dailyLimit) + '</td></tr>';
    } else {
      usage = '<tr><td><b>Used so far today</b></td><td class="path">Needs a running HaTi</td><td class="num">' + nd() + '</td></tr>';
    }

    var key = '';
    if (live) {
      key = '<tr><td><b>AI key configured</b></td><td class="path">Whether a provider key is set — the key itself never leaves HaTi</td>' +
        '<td class="num" style="color:' + (pulse.aiKeyConfigured ? 'var(--emerald)' : 'var(--amber)') + '">' +
        (pulse.aiKeyConfigured ? 'yes' : 'no') + '</td></tr>';
    }

    html += '<table><tbody>' + rows + usage + key + '</tbody></table>';

    if (live) {
      html += '<div class="blast-note">Read from the running HaTi at ' + esc(fmtDate(pulse.fetchedAt, true)) +
        ', build <span class="path">' + esc(pulse.version || 'unknown') + '</span>. ' +
        'That endpoint returns caps and counts only — no contract, party or user data of any kind crosses it.</div>';
    }
    $('capsBody').innerHTML = html;
  }

  /* ---- 3. where things are kept ---- */
  function renderData() {
    var st = scan.storage;
    var rows = st.tables.map(function (t) {
      var blob = (st.blobs || []).filter(function (b) { return b.record === 'appSettings' && t.name === 'settings'; })[0];
      return '<tr>' +
        '<td><b>' + esc(t.name) + '</b><div class="path">' + t.columns.length + ' columns</div></td>' +
        '<td>' + t.columns.map(function (c) { return '<span class="path">' + esc(c) + '</span>'; }).join(', ') +
        (blob ? '<div style="margin-top:4px;color:var(--danger);font-size:11.5px">— and every custom template, in full</div>' : '') + '</td>' +
        '<td class="path"' + (blob ? ' style="color:var(--danger)"' : '') + '>' + (blob ? 'see below' : 'server/server.js:' + t.line) + '</td>' +
        '</tr>';
    }).join('');

    var html = '<table><thead><tr><th style="width:150px">Holds</th><th>What’s inside</th><th style="width:140px">Note</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';

    if (st.blobs && st.blobs.length) {
      html += st.blobs.map(function (b) {
        return '<div class="blast-note"><b>Worth knowing.</b> ' + esc(b.note) +
          (st.rewritesWholeRecord ? ' The settings route writes the whole record back on every save, so this is not theoretical.' : '') +
          ' Fine at two templates. Not fine at thirty with version history. ' +
          '<span class="path">server/server.js:' + b.line + '</span></div>';
      }).join('');
    }

    if (st.settingKeys && st.settingKeys.length) {
      html += '<div class="blast-note">The <span class="path">settings</span> table is a key/value store. ' +
        'The keys written to it are: ' + st.settingKeys.map(function (k) { return '<span class="path">' + esc(k) + '</span>'; }).join(', ') + '.</div>';
    }
    $('dataBody').innerHTML = html;
  }

  /* ---- 4. what breaks what ---- */
  var currentPick = null;
  function renderBlast() {
    var d = scan.dependencies;

    /* Three visual states, none of them obvious without being told. */
    var html =
      '<div class="key">' +
        '<span class="k"><span class="sw on"></span><b>Reads it</b> — uses this data</span>' +
        '<span class="k"><span class="sw risk"></span><b>Can break something already signed</b></span>' +
        '<span class="k"><span class="sw off"></span>Not affected</span>' +
      '</div>';

    html += '<div class="blast"><div class="picks" id="picks">' +
      d.items.map(function (it, i) {
        return '<button class="pick" aria-pressed="' + (i === 0) + '" data-k="' + esc(it.key) + '">' + esc(it.label) +
          '<small>' + esc((it.fields || []).join(' · ')) + '</small></button>';
      }).join('') +
      '</div><div class="deps" id="deps">' +
      d.subsystems.map(function (s) {
        return '<div class="dep" data-d="' + esc(s.id) + '"><div class="t">' + esc(s.title) + '</div>' +
          '<div class="d">' + esc(s.desc) + '</div></div>';
      }).join('') +
      '</div></div><div class="blast-note" id="blastNote"></div>';

    if (d.warnings && d.warnings.length) {
      html += '<div class="warns"><h5>This map is out of date in ' + d.warnings.length + ' place' + (d.warnings.length === 1 ? '' : 's') + '</h5><ul>' +
        d.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>';
    }
    html += '<div class="blast-note" style="color:var(--n500)">These relationships are judgements about meaning, not something a parser can read out of code, so they are written by hand in <span class="path">' +
      esc(d.source) + '</span>. Every subsystem and field named above is checked against HaTi’s source on each scan; anything stale is listed rather than quietly shown as fact.</div>';

    $('blastBody').innerHTML = html;

    var picks = $('blastBody').querySelectorAll('.pick');
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
    $('blastBody').querySelectorAll('.dep').forEach(function (d) {
      var id = d.getAttribute('data-d');
      var isRisk = risk.indexOf(id) > -1;
      var isOn = isRisk || on.indexOf(id) > -1;
      d.classList.toggle('on', isOn);
      d.classList.toggle('risk', isRisk);
      d.classList.toggle('off', !isOn);
    });
    $('blastNote').innerHTML = item.note;
  }

  /* ---- 5. not finished ---- */
  function renderGaps() {
    var g = scan.gaps;
    var html = '';
    if (g.markerNote) {
      html += '<div class="notice" style="background:var(--a100);border-color:var(--a300);color:var(--a800)"><div>' + esc(g.markerNote) + '</div></div>';
    }
    html += '<div class="gaps">' + g.gaps.map(function (x) {
      var cls = x.severity === 'high' ? 'hi' : x.severity === 'medium' ? 'md' : x.severity === 'low' ? 'lo' : 'unset';
      var title = x.severity ? 'Severity: ' + x.severity : 'The source does not state a severity';
      return '<div class="gap"><span class="dot ' + cls + '" title="' + esc(title) + '"></span><div>' +
        '<div class="t">' + esc(x.title) + (x.marker ? '<span class="flag">' + esc(x.marker) + '</span>' : '') + '</div>' +
        (x.detail ? '<div class="d">' + esc(x.detail) + '</div>' : '') +
        '<div class="src">' + esc(x.source) + '</div></div></div>';
    }).join('') + '</div>';

    /* How the list has moved lately — the one thing on this panel that comes
       from the Mapper's own archive rather than from HaTi's source. */
    var mv = scan.gapMovement;
    if (mv && (mv.opened || mv.closed)) {
      html += '<div class="blast-note"><b>' +
        (mv.closed ? mv.closed + ' closed' : 'None closed') +
        ', ' + (mv.opened ? mv.opened + ' opened' : 'none opened') +
        ' in the last ' + mv.days + ' days.</b> Counted from the change log, so it only covers the time the Mapper has been watching.</div>';
    } else if (mv) {
      html += '<div class="blast-note">Nothing on this list has opened or closed in the last ' + mv.days +
        ' days' + (mv.watchedSince ? ', and the Mapper has been watching since ' + esc(fmtDate(mv.watchedSince)) : '') + '.</div>';
    }

    if (g.ranked) {
      var sc = g.severityCounts;
      html += '<div class="blast-note" style="color:var(--n500)">Ranked by the severity the documents state: ' +
        sc.high + ' high, ' + sc.medium + ' medium, ' + sc.low + ' low' +
        (sc.unstated ? ', and ' + sc.unstated + ' that say nothing — those keep their source order underneath' : '') + '.</div>';
    } else {
      html += '<div class="blast-note" style="color:var(--n500)">None of these sources states a severity, so none is shown. ' +
        'The order is the order the sources list them in, not a ranking. ' +
        'To rank them, start a bullet in HaTi’s README or SECURITY.md with <span class="path">[high]</span>, ' +
        '<span class="path">[medium]</span> or <span class="path">[low]</span> — nothing else needs to change here.</div>';
    }
    $('gapsBody').innerHTML = html;
  }

  /* ---- 6. open to the public ---- */
  function renderPublic() {
    var p = scan.public;
    $('publicLede').textContent =
      p.routes.length + ' of HaTi’s ' + p.totalRoutes + ' server routes carry no login check, and ' +
      p.hashes.length + ' URL hashes are handled before any session exists. Short list by design — if it grows, that is the finding.';

    var html = p.hashes.map(function (h) {
      return '<div class="pub"><span class="u">' + esc(h.hash) + '=…</span><div>' +
        '<div class="t"><b>' + esc(h.label || h.hash) + '</b></div>' +
        '<div class="d">' + (h.detail ? esc(h.detail) : nd()) +
        (h.beforeSession ? ' Handled in <span class="path">js/app.js:' + h.line + '</span>, before the session is checked.' : '') +
        '</div></div></div>';
    }).join('');

    html += p.routes.map(function (r) {
      var qual = [];
      if (r.servesShell) qual.push('serves the app shell, no data');
      if (r.tokenGuarded) qual.push('checks its own bearer token in the handler');
      if (r.tokenInPath) qual.push('needs an unguessable token in the URL');
      if (r.middleware.length) qual.push('rate limited by ' + r.middleware.join(', '));
      return '<div class="pub"><span class="u">' + esc(r.method) + ' ' + esc(r.path) + '</span><div>' +
        '<div class="d">' + (qual.length ? esc(qual.join('; ')) + '.' : 'No login check and no other guard in the handler.') +
        ' <span class="path">server/server.js:' + r.line + '</span></div></div></div>';
    }).join('');

    html += '<div class="blast-note" style="color:var(--n500)">Derived by listing every <span class="path">app.get/post/put/patch/delete</span> ' +
      'whose middleware chain does not include <span class="path">auth</span>. "No login check" is not the same as "anyone can read it" — ' +
      'the qualifiers above say what actually guards each one.</div>';

    $('publicBody').innerHTML = html;
  }

  /* ---- 7a. what the Mapper has watched change (72 hours) ---- */
  var KIND_LABEL = {
    screens: 'screens', ai: 'AI cost', data: 'storage',
    public: 'open door', gaps: 'gaps', weight: 'file size', map: 'the map',
    watch: 'you asked',
  };

  /* How far back the panel is looking. 72 hours is the working set; the longer
     ranges are served from the archive. */
  var watchHours = 72;
  var RANGE_LABEL = { 72: 'the last 72 hours', 168: 'the last 7 days', 720: 'the last 30 days', 2160: 'the last 90 days' };
  function rangeLabel() { return RANGE_LABEL[watchHours] || ('the last ' + watchHours + ' hours'); }

  function renderWatch(watch) {
    var lede = $('watchLede');
    var body = $('watchBody');
    if (!watch) { body.innerHTML = skeleton(4); return; }

    if (!watch.watching) {
      lede.textContent = 'Every scan is compared with the one before, and anything that moved is kept here.';
      body.innerHTML = '<div class="notice" style="background:var(--a100);border-color:var(--a300);color:var(--a800)"><div>' +
        '<b>Just started watching.</b> This is the first scan, so there is nothing to compare it against yet. ' +
        'Come back after the next one and anything that has moved will be listed here.</div></div>';
      return;
    }

    var total = watch.rounds.reduce(function (n, r) { return n + r.events.length; }, 0);
    lede.textContent = total === 0
      ? 'Nothing has changed in HaTi in ' + rangeLabel() + '. Watching since ' + fmtDate(watch.since, true) + '.'
      : total + (total === 1 ? ' change' : ' changes') + ' in ' + rangeLabel() + ', newest first. Watching since ' + fmtDate(watch.since, true) + '.';

    var html = '';
    if (total === 0) {
      html += '<div class="notice" style="background:var(--a100);border-color:var(--a300);color:var(--a800)"><div>' +
        '<b>Nothing has moved' + (watchHours > 72 ? ' in ' + rangeLabel() : '') + '.</b> The Mapper has looked ' +
        watch.snapshots + ' time' + (watch.snapshots === 1 ? '' : 's') +
        ' and found HaTi unchanged each time. That is a good sign, not a broken page.</div></div>';
    } else {
      html += watch.rounds.map(function (r) {
        return '<div class="round"><div class="when">' + esc(fmtDate(r.at, true)) +
          (r.commit ? ' · code version ' + esc(r.commit) : '') + '</div>' +
          r.events.map(function (e) {
            return '<div class="ev w' + (e.weight || 1) + '"><span class="k">' + esc(KIND_LABEL[e.kind] || e.kind) + '</span>' +
              '<span class="x">' + esc(e.text) + '</span></div>';
          }).join('') + '</div>';
      }).join('');
    }

    html += '<div class="blast-note" style="color:var(--n500)">A scan that finds nothing changed adds nothing here, so this stays a list of real events rather than a list of look-ups. ' +
      'Everything noticed is kept for up to 90 days' +
      (watch.keptSince ? ' — this log goes back to ' + esc(fmtDate(watch.keptSince, true)) : '') + '.' +
      (watch.durable ? '' : ' <b>This log is being held in memory only</b> — it will be lost if the service restarts.') +
      (watch.durable && !watch.archiveDurable ? ' <b>Nothing older than 72 hours can be kept</b> — the archive file cannot be written.' : '') +
      '</div>';

    body.innerHTML = html;
  }

  /* ---- 7c. last night ---- */

  /* The question the owner actually asks each morning. The same events the log
     below lists, grouped into one report so it reads as an answer rather than
     as a feed. */
  function renderDigest(d) {
    var body = $('digestBody');
    if (!d) { body.innerHTML = skeleton(3); return; }

    $('digestLede').textContent = 'Everything that moved ' + d.label + ', in one place.';

    if (d.quiet) {
      body.innerHTML = '<div class="notice" style="background:var(--a100);border-color:var(--a300);color:var(--a800)"><div>' +
        '<b>Nothing moved ' + esc(d.label) + '.</b> No screens, no addresses, no tables, no commits. ' +
        'If a session was supposed to run, that is worth knowing too.</div></div>';
      return;
    }

    var html = '<div class="digest"><div class="head-line">' + esc(d.headline) + '</div>';

    html += d.sections.map(function (s) {
      return '<div class="sect"><h5>' + esc(s.title) + '</h5>' +
        s.events.map(function (e) {
          return '<p' + ((e.weight || 1) >= 3 ? ' class="big"' : '') + '>' + esc(e.text) + '</p>';
        }).join('') + '</div>';
    }).join('');

    if (d.commits.length) {
      html += '<div class="sect"><h5>Commits</h5>' + d.commits.map(function (c) {
        return '<p>' + esc(c.subject) + ' <span class="path">' + esc(c.sha) + '</span></p>';
      }).join('') + '</div>';
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
    foot.push('Put together from ' + d.scanCount + ' scan' + (d.scanCount === 1 ? '' : 's') + ' in that window.');
    html += '<div class="foot">' + esc(foot.join(' ')) + '</div></div>';

    body.innerHTML = html;
  }

  function loadDigest() {
    return apiGet('/api/digest').then(renderDigest, function () {
      $('digestBody').innerHTML = '<div class="notice"><div>The summary could not be put together just now.</div></div>';
    });
  }

  function loadWatch() {
    return apiGet('/api/changes?hours=' + watchHours).then(renderWatch, function () {
      $('watchBody').innerHTML = '<div class="notice"><div>The change log could not be read just now.</div></div>';
    });
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

  /* ---- 7b. what changed in the code ---- */
  function renderChanges() {
    if (!scan.changes.length) {
      $('changesBody').innerHTML = '<div class="notice"><div><b>No commit history.</b> The scan could not read the repository’s commits, so this panel has nothing to show. Everything else on this page comes from the source itself and is unaffected.</div></div>';
      return;
    }
    $('changesBody').innerHTML = scan.changes.map(function (c) {
      var files = c.fileCount != null ? c.fileCount + ' file' + (c.fileCount === 1 ? '' : 's') : null;
      var what;
      if (c.areas === null) what = '<span class="none">areas not detected</span>';
      else if (c.areas.length) what = 'Touched ' + esc(c.areas.join(', ')) + (files ? ' · ' + files : '');
      else what = (files || 'Files') + ', none in the tracked areas';
      return '<div class="chg"><span class="when">' + esc(fmtDate(c.date)) + '</span><div>' +
        '<div class="t">' + esc(c.subject) + '</div>' +
        '<div class="d">' + what + ' <span class="path">' + esc(c.sha) + '</span></div></div></div>';
    }).join('');
  }

  /* ---- 8. getting bulky ---- */
  function renderWeight() {
    var w = scan.weight;
    var max = w.files.length ? w.files[0].bytes : 1;
    var markPct = (w.threshold / max) * 100;

    var html = '<div class="bars">' + w.files.map(function (f) {
      var big = f.bytes > w.threshold;
      return '<div class="bar' + (big ? ' big' : '') + '"><span class="f" title="' + esc(f.path) + '">' + esc(f.path.replace(/^js\//, '')) + '</span>' +
        '<span class="track"><span class="fill" style="width:' + ((f.bytes / max) * 100).toFixed(1) + '%"></span></span>' +
        '<span class="s">' + kb(f.bytes) + '</span></div>';
    }).join('') +
      '<div class="bar"><span class="f"></span><span class="mark"><i style="left:' + markPct.toFixed(1) + '%"></i>' +
      '<span style="left:' + markPct.toFixed(1) + '%">60 KB</span></span><span class="s"></span></div>' +
      '</div>';

    var worst = (scan.moduleFacts || []).filter(function (m) { return m.multiJob; })
      .sort(function (a, b) { return b.bytes - a.bytes; })[0];
    html += '<div class="blast-note"><b>' + w.overThreshold + ' file' + (w.overThreshold === 1 ? ' is' : 's are') + ' past the comfortable line.</b>' +
      (worst ? ' <span class="path">' + esc(worst.module) + '</span> carries ' + worst.sections.length +
        ' separately-banner-ed jobs and ' + worst.exportCount + ' exported names in ' + kb(worst.bytes) +
        '. Splitting it would make every future session on that area faster and safer.' : '') + '</div>';

    $('weightBody').innerHTML = html;

    if (!w.orphans.length) {
      $('orphanBody').innerHTML = '<div class="notice" style="background:var(--a100);border-color:var(--a300);color:var(--a800)"><div>' +
        'Every one of the ' + w.exportCount + ' names attached to <code>window</code> is referenced somewhere else in the repository. Nothing to remove.</div></div>';
      return;
    }
    var byFile = {};
    w.orphans.forEach(function (o) { (byFile[o.exportedFrom] = byFile[o.exportedFrom] || []).push(o.name); });
    $('orphanBody').innerHTML = '<table><thead><tr><th style="width:220px">Exported from</th><th>Never referenced anywhere else</th></tr></thead><tbody>' +
      Object.keys(byFile).map(function (f) {
        return '<tr><td class="path">' + esc(f) + '</td><td>' +
          byFile[f].map(function (n) { return '<span class="path">' + esc(n) + '</span>'; }).join(', ') + '</td></tr>';
      }).join('') +
      '</tbody></table><div class="blast-note">' + w.orphans.length + ' of ' + w.exportCount +
      ' exported names. Each appears exactly once outside the export blocks — its own declaration — so nothing calls it. ' +
      'Worth a look before assuming any of them is load-bearing.</div>';
  }

  /* ------------------------------------------------------------- the run */

  function stampText() {
    var el = $('stamp');
    var when = new Date(scan.scannedAt);
    var ageMs = Date.now() - when.getTime();
    var dayOld = ageMs > 24 * 60 * 60 * 1000;
    el.textContent = 'scanned ' + fmtDate(scan.scannedAt, true) +
      (scan.cached ? ' · cached' : '') + (dayOld ? ' · over a day old' : '');
    el.className = 'stamp' + (dayOld || scan.stale ? ' old' : '');
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
      : '';
    el.hidden = false;
  }

  /* ---- how much of HaTi the scanner could read ---- */

  /* Every panel is built by matching patterns against source somebody else is
     free to change. When that changes shape nothing breaks loudly — the panels
     just fill up with "not detected". This is the number that makes that
     visible before it matters. */
  function renderHealth() {
    var el = $('health');
    var h = scan.health;
    if (!h || h.percent == null) { el.hidden = true; return; }

    var grade = h.percent >= 95 ? 'good' : h.percent >= 85 ? 'fair' : 'poor';
    var missed = h.attempts - h.resolved;
    var tail = h.percent === 100
      ? 'Everything it looks for, it found.'
      : missed + ' of the ' + num(h.attempts) + ' things it looks for came back as “not detected” or with a warning. ' +
        (grade === 'poor'
          ? '<b>That is low enough to be worth a look</b> — usually it means HaTi moved and the patterns here need updating.'
          : 'Usually that means HaTi has moved slightly since these patterns were written.');

    el.className = 'health ' + grade;
    el.innerHTML = '<span class="pct">' + h.percent + '%</span><span>' +
      '<b>The scanner could read ' + h.percent + '% of what it looks for.</b> ' + tail + '</span>';
    el.title = h.resolved + ' of ' + h.attempts + ' facts resolved · ' + h.warnings +
      ' warning' + (h.warnings === 1 ? '' : 's');
    el.hidden = false;
  }

  /* ==================================================================== */
  /*  Which way things are moving                                          */
  /*                                                                       */
  /*  Six lines, drawn by hand in SVG — no chart library, because this      */
  /*  service has one runtime dependency and it is going to stay that way.  */
  /*  The insight is the direction, not the axes, so there are no axes.     */
  /* ==================================================================== */

  var SPARK_W = 150, SPARK_H = 34;

  function sparkline(values) {
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = (max - min) || 1;
    var pad = 3;
    var step = values.length > 1 ? (SPARK_W - pad * 2) / (values.length - 1) : 0;

    var pts = values.map(function (v, i) {
      var x = pad + i * step;
      var y = SPARK_H - pad - ((v - min) / span) * (SPARK_H - pad * 2);
      return { x: x, y: y };
    });
    var line = pts.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
    var area = pts[0].x.toFixed(1) + ',' + (SPARK_H - pad) + ' ' + line + ' ' +
      pts[pts.length - 1].x.toFixed(1) + ',' + (SPARK_H - pad);
    var last = pts[pts.length - 1];

    return '<svg width="' + SPARK_W + '" height="' + SPARK_H + '" viewBox="0 0 ' + SPARK_W + ' ' + SPARK_H +
      '" role="img" aria-hidden="true" focusable="false">' +
      '<polygon class="area" points="' + area + '"></polygon>' +
      '<polyline class="line" points="' + line + '"></polyline>' +
      '<circle class="dot" cx="' + last.x.toFixed(1) + '" cy="' + last.y.toFixed(1) + '" r="2.2"></circle>' +
      '</svg>';
  }

  /* Which way, and how much, in words. "Up 4%" is a fact; "a fifth bigger
     than a month ago" is the thing worth knowing. */
  function direction(values, days, opts) {
    var first = values[0], last = values[values.length - 1];
    if (first === last) return { klass: '', text: 'Unchanged over the last ' + days + ' days.' };
    var up = last > first;
    var pct = first === 0 ? null : Math.round(Math.abs(last - first) / Math.abs(first) * 100);
    var word = up ? (opts.upIsBad ? 'bigger' : 'higher') : (opts.upIsBad ? 'smaller' : 'lower');
    var body = pct == null
      ? 'Moved ' + (up ? 'up' : 'down') + ' from nothing over the last ' + days + ' days.'
      : pct + '% ' + word + ' than ' + days + ' days ago.';
    // Colour by whether the movement is the direction the owner would want.
    var bad = opts.upIsBad ? up : !up;
    return { klass: bad ? 'up' : 'down', text: body };
  }

  var TREND_SERIES = [
    { key: 'bytes', label: 'Everything, all together', upIsBad: true, fmt: function (v) { return kb(v); } },
    { key: 'largest', label: 'The biggest single file', upIsBad: true, fmt: function (v) { return kb(v); } },
    { key: 'openRoutes', label: 'Doors that need no login', upIsBad: true, fmt: function (v) { return String(v); } },
    { key: 'gaps', label: 'Things not finished', upIsBad: true, fmt: function (v) { return String(v); } },
    { key: 'health', label: 'How much the scanner can read', upIsBad: false, fmt: function (v) { return v + '%'; } },
    { key: 'dailyCostUsd', label: 'A day at the caps, in money', upIsBad: true, fmt: function (v) { return usd(v); } },
  ];

  function renderTrends(t) {
    var el = $('trends');
    if (!t) { el.hidden = true; return; }

    if (!t.enough) {
      el.innerHTML = '<h3>Which way things are moving</h3>' +
        '<p class="lede">Not enough history yet. Lines need at least three scans that found something different; ' +
        'the Mapper has ' + t.points.length + '. ' +
        (t.watchedSince ? 'It has been watching since ' + esc(fmtDate(t.watchedSince, true)) + '.' : '') +
        ' Come back after a few days and this fills in.</p>';
      el.hidden = false;
      return;
    }

    var cards = TREND_SERIES.map(function (s) {
      var values = t.points.map(function (p) { return p[s.key]; }).filter(function (v) { return typeof v === 'number'; });
      if (values.length < 3) {
        return '<div class="spark"><div class="t">' + esc(s.label) + '</div>' +
          '<div class="v">' + (values.length ? esc(s.fmt(values[values.length - 1])) : '—') + '</div>' +
          '<div class="d">Not measured for long enough to draw.</div></div>';
      }
      var dir = direction(values, t.days, s);
      return '<div class="spark ' + dir.klass + '"><div class="t">' + esc(s.label) + '</div>' +
        '<div class="v">' + esc(s.fmt(values[values.length - 1])) + '</div>' +
        sparkline(values) +
        '<div class="d">' + esc(dir.text) + '</div></div>';
    }).join('');

    el.innerHTML = '<h3>Which way things are moving</h3>' +
      '<p class="lede">Each line is one reading per scan that found something different, over the last ' + t.days + ' days. ' +
      'The shape is the point; the numbers underneath are where it stands now.</p>' +
      '<div class="spark-grid">' + cards + '</div>' +
      '<div class="foot">Drawn from ' + t.points.length + ' readings kept in the change log’s archive — counts and byte sizes only, ' +
      'no names and no paths.</div>';
    el.hidden = false;
  }

  function loadTrends() {
    return apiGet('/api/trends?days=90').then(renderTrends, function () { $('trends').hidden = true; });
  }

  function renderAll() {
    renderDrift();
    renderGlance();
    renderHealth();
    renderScreens();
    renderCost();
    renderData();
    renderBlast();
    renderGaps();
    renderPublic();
    renderChanges();
    renderWeight();
    stampText();
  }

  function load(refresh) {
    setLoading();
    $('rescan').disabled = true;
    $('rescan').textContent = refresh ? 'Rescanning…' : 'Rescan';
    $('stamp').textContent = refresh ? 'rescanning…' : 'scanning…';
    $('stamp').className = 'stamp';

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
        loadDigest();
        loadWatchRules();
        loadTrends();
        $('rescan').disabled = false;
        $('rescan').textContent = 'Rescan';
      })
      .catch(function (e) {
        $('rescan').disabled = false;
        $('rescan').textContent = 'Rescan';
        $('stamp').textContent = e.noBackend ? 'no backend' : 'scan failed';
        $('stamp').className = 'stamp old';
        /* Rescan retries the same request, so it only helps when the backend
           is there and the scan itself failed. Offering it for a missing
           backend just invites the same error again. */
        var headline = e.noBackend ? 'This page has no backend.' : 'The scan failed.';
        var footer = e.noBackend
          ? 'Rescan will not help until the service is running as a web service.'
          : 'Nothing on this page is current. Press Rescan to try again.';
        // Repeated failures raise a banner of their own; go and look.
        loadWatchRules();
        var msg = '<div class="notice bad"><div><b>' + headline + '</b> ' + esc(e.message || 'Unknown error') +
          '<br>' + footer + '</div></div>';
        ['screensBody', 'costBody', 'dataBody', 'blastBody', 'gapsBody', 'publicBody', 'changesBody', 'weightBody', 'orphanBody']
          .forEach(function (id) { $(id).innerHTML = msg; });
        $('capsBody').innerHTML = msg;
        $('glance').innerHTML = '';
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

  var chat = { history: [], busy: false, brain: null };

  var SUGGESTIONS = [
    'What should I be worried about?',
    'What changed in the last day?',
    'What is this costing me to run?',
    'What works without logging in?',
    'What would be risky to change?',
  ];

  /* A small, safe markdown renderer — bold, code, lists, paragraphs. Enough
     for the assistant's answers, and it escapes everything first so nothing
     the model writes can inject markup. */
  function md(src) {
    var text = esc(String(src || '').trim());
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    var lines = text.split('\n'), out = [], list = null;
    function closeList() { if (list) { out.push('</' + list + '>'); list = null; } }
    lines.forEach(function (line) {
      var t = line.trim();
      var ul = t.match(/^[-*]\s+(.*)$/);
      var ol = t.match(/^\d+[.)]\s+(.*)$/);
      if (ul) {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + ul[1] + '</li>');
      } else if (ol) {
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + ol[1] + '</li>');
      } else if (!t) {
        closeList();
      } else {
        closeList();
        out.push('<p>' + t + '</p>');
      }
    });
    closeList();
    return out.join('');
  }

  function askOpen(open) {
    $('ask').hidden = !open;
    $('askLaunch').hidden = open;
    if (open) {
      refreshBrain();
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
     start again, and a prompt for something this reversible is just friction. */
  function clearChat() {
    if (!chat.history.length) return toast('Nothing to delete yet');
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
      $('askSugg').hidden = needsKey;
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
          (cfg.storageIsDurable ? '' : ' The key is held in memory only and will be lost if this service restarts — set ANTHROPIC_API_KEY in the dashboard to make it permanent.');
      }
      return cfg;
    }, function () { /* the config route is optional to the rest of the page */ });
  }

  function renderFeed(typing) {
    var feed = $('askFeed');
    var html = '';

    if (!chat.history.length) {
      html += '<div class="msg bot"><div class="body">' +
        md('Hello. I can explain anything on this page — what your platform contains, what it costs to run, what has changed lately, and what is worth keeping an eye on.\n\nI read the same information the tabs above show. I never see the contracts inside HaTi.') +
        '</div></div>';
    }

    chat.history.forEach(function (m) {
      if (m.role === 'user') {
        html += '<div class="msg me">' + esc(m.content) + '</div>';
        return;
      }
      html += '<div class="msg bot' + (m.error ? ' err' : '') + '"><div class="body">' + md(m.content);
      if (m.watchOut) html += '<div class="watch">' + esc(m.watchOut) + '</div>';
      html += '</div>';
      if (m.sources && m.sources.length) {
        html += '<div class="srcs">' + m.sources.map(function (s) {
          return '<button data-tab="' + esc(s.tab) + '" title="' + esc(s.note || '') + '">See “' + esc(s.label) + '”</button>';
        }).join('') + '</div>';
      }
      html += '</div>';
    });

    if (typing) html += '<div class="typing"><i></i><i></i><i></i></div>';
    feed.innerHTML = html;
    feed.scrollTop = feed.scrollHeight;

    $('askSugg').innerHTML = chat.history.length
      ? ''
      : SUGGESTIONS.map(function (s) { return '<button data-q="' + esc(s) + '">' + esc(s) + '</button>'; }).join('');
  }

  function sendQuestion(q) {
    if (chat.busy || !q.trim()) return;
    chat.busy = true;
    chat.history.push({ role: 'user', content: q.trim() });
    renderFeed(true);
    $('askSend').disabled = true;
    $('askInput').value = '';

    var payload = chat.history
      .filter(function (m) { return !m.error; })
      .map(function (m) { return { role: m.role, content: m.content }; });

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ messages: payload }),
    })
      .then(function (res) {
        return res.text().then(function (raw) {
          var b = null;
          try { b = JSON.parse(raw); } catch (e) {}
          if (!b) throw new Error('The assistant is not reachable — this page may be running without its server.');
          if (!res.ok) { var e2 = new Error(b.error || 'That did not work.'); e2.needsKey = b.needsKey; throw e2; }
          return b;
        });
      })
      .then(function (b) {
        chat.history.push({ role: 'assistant', content: b.answer, sources: b.sources, watchOut: b.watchOut });
        if (b.budget) refreshBrain();
      })
      .catch(function (e) {
        chat.history.push({ role: 'assistant', content: e.message, error: true });
        if (e.needsKey) refreshBrain();
      })
      .then(function () {
        chat.busy = false;
        $('askSend').disabled = false;
        renderFeed(false);
      });
  }

  /* --- wiring --- */
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

  $('askSugg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-q]');
    if (b) sendQuestion(b.getAttribute('data-q'));
  });

  /* "See <panel>" jumps to that tab, so an answer always has somewhere to
     land rather than being the end of the conversation. */
  $('askFeed').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tab]');
    if (!b) return;
    var tab = document.querySelector('.nav button[data-p="' + b.getAttribute('data-tab') + '"]');
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
      st.className = 'state good';
      st.textContent = 'Saved · ' + cfg.hint +
        (cfg.source === 'environment' ? ' (from this service’s environment)' : '');
    } else {
      st.className = 'state';
      st.textContent = cfg.environmentFallback
        ? 'Not set here — falling back to the service environment.'
        : 'Not set. The assistant cannot answer until you add one.';
    }
    $('setEmail').textContent = (authInfo && authInfo.email) || '—';
    $('setStorageNote').innerHTML = cfg.storageIsDurable
      ? 'Your account, your key, the day’s question count and the change log are written to this service’s disk.'
      : '<b>This service has no permanent disk.</b> Your account, your key and the change log are held in memory, so they will be lost when it restarts or redeploys. Attach a disk in your hosting dashboard and point <code style="font-family:var(--mono)">MAPPER_DATA</code> at it to make them permanent.';
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

  var TRIP_ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>';

  function renderTripped(tripped, trouble) {
    var el = $('tripped');
    var list = tripped || [];
    var html = '';

    /* The Mapper failing to read HaTi is not a rule the owner set, and there
       is nothing to dismiss — it stays until a scan works again. It goes
       first, because while it is showing, everything below it is stale. */
    if (trouble) {
      html += '<div class="trip"' + ' id="scanTrouble">' + TRIP_ICON + '<div class="body">' +
        '<h4>The Mapper cannot read HaTi’s code</h4>' +
        '<p>It has failed ' + trouble.failedScans + ' times in a row, since ' + esc(fmtDate(trouble.since, true)) + '. ' +
        'Reason: ' + esc(trouble.reason || 'not recorded') + '. ' +
        'Everything on this page is the last scan that worked, so it will look correct while describing older code.' +
        (trouble.emailed ? ' You have been emailed about this once; there will not be another until a scan succeeds.' : '') +
        '</p></div></div>';
    }

    html += list.map(function (t) {
      return '<div class="trip">' + TRIP_ICON + '<div class="body">' +
        '<h4>' + esc(t.title) + '</h4>' +
        '<p>' + esc(t.text) + '</p>' +
        '<div class="when">noticed ' + esc(fmtDate(t.at, true)) + '</div>' +
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
      return '<div class="rule"><div class="body"><div class="say">' + say + '</div>' +
        '<div class="why">' + esc(why) + '</div></div>' +
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
        loadDigest();
        loadWatchRules();
        loadTrends();
        refreshBrain().then(renderSettings, function () {});
        loadPrefs();
        loadWatchRules();
      })
      .catch(function () {
        showAuth('login');
        authMsg('bad', 'The server did not answer. If this page has just been redeployed, wait a moment and reload.');
      });
  }

  boot();
})();
