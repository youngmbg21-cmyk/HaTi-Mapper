/* HaTi-Mapper — the front end.
 *
 * This file renders; it does not analyse. Every number on the page comes from
 * one of two server routes, and where the server says a thing could not be
 * derived, the page says "not detected" rather than filling the space with
 * something plausible.
 *
 * The page loads straight into the data — there is no access prompt. The
 * secrets the server needs (the GitHub token and HaTi's MAPPER_TOKEN) stay in
 * the server's environment and are never sent to the browser, but the page
 * itself is reachable by anyone who reaches the URL, so keep the URL private.
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

  /* ---------------------------------------------------------- requests */

  function apiGet(path) {
    return fetch(path, { cache: 'no-store' })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) { var e = new Error(body && body.detail ? body.detail : 'Request failed'); e.body = body; throw e; }
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
    ['screensBody', 'costBody', 'dataBody', 'blastBody', 'gapsBody', 'publicBody', 'changesBody', 'weightBody', 'orphanBody']
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
      return '<tr>' +
        '<td><b>' + esc(f.label || f.feature) + '</b>' +
        '<div class="path">' + (f.does ? esc(f.does) : nd()) + '</div>' +
        '<div class="path" style="color:var(--n400)">' + esc(f.route) + '</div></td>' +
        '<td>' + tiers + '</td>' +
        '<td class="path">' + models + '</td>' +
        '<td class="num">' + (f.cap == null ? '—' : num(f.cap)) + '</td>' +
        '</tr>' +
        '<tr><td colspan="4" style="padding-top:0;border-bottom:1px solid var(--divider)">' +
        '<span class="path">Used by: </span><span style="font-size:11.5px;color:var(--n600)">' + used + '</span></td></tr>';
    }).join('');

    var html = '<table><thead><tr><th style="width:210px">Feature</th><th style="width:78px">Tier</th><th>Model</th>' +
      '<th class="num" style="width:96px">Cap / ' + (scan.ai.windowMinutes || 15) + ' min</th></tr></thead><tbody>' + rows + '</tbody></table>';

    if (scan.ai.nonBillingAiRoutes && scan.ai.nonBillingAiRoutes.length) {
      html += '<div class="blast-note">Another ' + scan.ai.nonBillingAiRoutes.length + ' routes sit under <span class="path">/api/ai/</span> ' +
        'but never call Anthropic — they read and set configuration, so they cost nothing: ' +
        scan.ai.nonBillingAiRoutes.map(function (r) { return '<span class="path">' + esc(r.label || r.path) + '</span>'; }).join(', ') + '.</div>';
    }
    $('costBody').innerHTML = html;
    renderCaps();
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
    var html = '<div class="blast"><div class="picks" id="picks">' +
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

    html += '<div class="blast-note" style="color:var(--n500)">None of these sources states a severity, so none is shown. ' +
      'The order is the order the sources list them in, not a ranking.</div>';
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

  /* ---- 7. what changed ---- */
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

  function renderAll() {
    renderGlance();
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
        $('rescan').disabled = false;
        $('rescan').textContent = 'Rescan';
      })
      .catch(function (e) {
        $('rescan').disabled = false;
        $('rescan').textContent = 'Rescan';
        $('stamp').textContent = 'scan failed';
        $('stamp').className = 'stamp old';
        var msg = '<div class="notice bad"><div><b>The scan failed.</b> ' + esc(e.message || 'Unknown error') +
          '<br>Nothing on this page is current. Press Rescan to try again.</div></div>';
        ['screensBody', 'costBody', 'dataBody', 'blastBody', 'gapsBody', 'publicBody', 'changesBody', 'weightBody', 'orphanBody']
          .forEach(function (id) { $(id).innerHTML = msg; });
        $('capsBody').innerHTML = msg;
        $('glance').innerHTML = '';
      });
  }

  $('rescan').addEventListener('click', function () { load(true); });

  load(false);
})();
