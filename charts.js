/* HaTi-Mapper — the assistant's charts.
 *
 * This file is NOT loaded with the page. app.js fetches it the first time an
 * answer actually asks for a chart, which most sessions never do, and never
 * fetches it twice. It is served from this origin because the page's script
 * policy allows scripts from here and nowhere else; a library on a CDN would
 * be refused by the browser before it ran.
 *
 * What it draws is never what the model said. app.js pulls the model's chart
 * block out of the reply, throws its contents away, and hands this file
 * numbers it has read from the same live records the dashboard beside it is
 * drawn from. A model that invents a number gets to invent a sentence, which
 * the reader can weigh. It never gets to invent a chart, which the reader
 * reads as a measurement.
 *
 * Every instance owns three things that outlive the markup around it: a
 * canvas, two event listeners and an animation frame. So every instance has a
 * destroy(), and app.js keeps a registry so that dropping a message from the
 * page cannot leave any of the three behind.
 */
(function () {
  'use strict';

  var DPR = function () { return Math.min(window.devicePixelRatio || 1, 2); };

  function reduceMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  /* The panel is themed with CSS custom properties and both themes are live at
     runtime, so the colours are read off the page rather than written in here.
     A chart that kept its own palette would go unreadable the moment somebody
     pressed the light/dark button. */
  function token(name, fallback) {
    try {
      var v = getComputedStyle(document.body).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  function fmt(value, unit) {
    if (value == null || !isFinite(value)) return '—';
    if (unit === 'US dollars') return '$' + (value < 1 ? value.toFixed(3) : value.toFixed(2));
    if (unit === 'percent') return Math.round(value) + '%';
    if (unit === 'kilobytes') return Math.round(value) + ' KB';
    var r = Math.round(value * 100) / 100;
    return String(r);
  }

  /* Rounded "nice" ceiling, so the top gridline is a number a person would
     say out loud rather than 1873.4. */
  function niceTop(max) {
    if (max <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log(max) / Math.LN10));
    var n = max / mag;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * mag;
  }

  function truncate(ctx, text, maxWidth) {
    var s = String(text == null ? '' : text);
    if (ctx.measureText(s).width <= maxWidth) return s;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
    return s + '…';
  }

  function Chart(canvas, spec) {
    this.canvas = canvas;
    this.spec = spec;
    this.points = (spec.points || []).filter(function (p) {
      return p && typeof p.value === 'number' && isFinite(p.value);
    });
    this.ctx = canvas.getContext('2d');
    this.frame = null;
    this.hover = -1;
    this.progress = reduceMotion() ? 1 : 0;
    this.dead = false;

    var self = this;
    this.onResize = function () { self.draw(); };
    this.onMove = function (e) {
      var idx = self.hitTest(e);
      if (idx === self.hover) return;
      self.hover = idx;
      self.draw();
    };
    this.onLeave = function () {
      if (self.hover === -1) return;
      self.hover = -1;
      self.draw();
    };

    window.addEventListener('resize', this.onResize);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerleave', this.onLeave);

    /* Watching the box rather than only the window, because the panel has an
       expand button that changes this canvas's width without the window
       moving at all. */
    if (window.ResizeObserver) {
      this.observer = new ResizeObserver(function () { self.draw(); });
      this.observer.observe(canvas.parentNode || canvas);
    }

    if (this.progress === 1) this.draw();
    else this.animate();
  }

  Chart.prototype.animate = function () {
    var self = this;
    var start = null;
    var tick = function (ts) {
      if (self.dead) return;
      if (start === null) start = ts;
      var t = Math.min((ts - start) / 420, 1);
      self.progress = 1 - Math.pow(1 - t, 3);
      self.draw();
      if (t < 1) self.frame = requestAnimationFrame(tick);
      else self.frame = null;
    };
    this.frame = requestAnimationFrame(tick);
  };

  Chart.prototype.box = function () {
    var rect = this.canvas.getBoundingClientRect();
    return {
      w: Math.max(rect.width || this.canvas.clientWidth || 320, 80),
      h: Math.max(rect.height || this.canvas.clientHeight || 150, 60),
    };
  };

  Chart.prototype.prepare = function () {
    var b = this.box(), dpr = DPR();
    if (this.canvas.width !== Math.round(b.w * dpr) || this.canvas.height !== Math.round(b.h * dpr)) {
      this.canvas.width = Math.round(b.w * dpr);
      this.canvas.height = Math.round(b.h * dpr);
    }
    var ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, b.w, b.h);
    ctx.font = '11px ' + (token('--font', 'system-ui, sans-serif'));
    ctx.textBaseline = 'middle';
    return b;
  };

  Chart.prototype.hitTest = function (e) {
    if (!this.points.length) return -1;
    var rect = this.canvas.getBoundingClientRect();
    var b = this.box();
    if (this.spec.type === 'hbar') {
      var y = e.clientY - rect.top;
      var rowH = (b.h - 8) / this.points.length;
      var i = Math.floor((y - 4) / rowH);
      return i >= 0 && i < this.points.length ? i : -1;
    }
    var x = e.clientX - rect.left;
    var left = this.padLeft(), right = b.w - 8;
    if (x < left || x > right) return -1;
    var span = right - left;
    var n = this.points.length;
    var idx = n === 1 ? 0 : Math.round(((x - left) / span) * (n - 1));
    return Math.max(0, Math.min(n - 1, idx));
  };

  Chart.prototype.padLeft = function () {
    return this.spec.type === 'hbar' ? 0 : 46;
  };

  Chart.prototype.draw = function () {
    if (this.dead) return;
    var b = this.prepare();
    if (!this.points.length) return;
    if (this.spec.type === 'hbar') this.drawHBar(b);
    else if (this.spec.type === 'bar') this.drawBar(b);
    else this.drawLine(b);
  };

  /* ---- shared furniture ---- */

  Chart.prototype.grid = function (b, top, padL, padB) {
    var ctx = this.ctx;
    var line = token('--line', 'rgba(128,128,128,.25)');
    var dim = token('--tx3', '#8b93a7');
    ctx.strokeStyle = line;
    ctx.fillStyle = dim;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    for (var i = 0; i <= 2; i++) {
      var v = top * (1 - i / 2);
      var y = 8 + ((b.h - 8 - padB) - 8) * (i / 2) + 4;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(b.w - 8, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillText(fmt(v, this.spec.unit), padL - 6, y);
    }
  };

  Chart.prototype.readout = function (b, idx) {
    if (idx < 0 || idx >= this.points.length) return;
    var p = this.points[idx], ctx = this.ctx;
    var label = (p.label ? p.label + ': ' : '') + fmt(p.value, this.spec.unit);
    ctx.textAlign = 'left';
    ctx.font = '600 11px ' + token('--font', 'system-ui, sans-serif');
    var w = ctx.measureText(label).width + 14;
    var x = Math.min(b.w - w - 4, Math.max(4, (this.lastX || 8) - w / 2));
    ctx.fillStyle = token('--tx', '#e6e9f0');
    ctx.globalAlpha = 0.92;
    roundRect(ctx, x, 2, w, 20, 6);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = token('--sh', '#0b1020');
    ctx.fillText(label, x + 7, 12);
  };

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---- a line through a series of readings ---- */

  Chart.prototype.drawLine = function (b) {
    var ctx = this.ctx, pts = this.points;
    var padL = this.padLeft(), padB = 16;
    var values = pts.map(function (p) { return p.value; });
    var top = niceTop(Math.max.apply(null, values));
    this.grid(b, top, padL, padB);

    var x0 = padL, x1 = b.w - 8, y0 = 12, y1 = b.h - padB;
    var step = pts.length > 1 ? (x1 - x0) / (pts.length - 1) : 0;
    var accent = token('--lav', '#7c8cf8');
    var at = function (i) {
      return [x0 + i * step, y1 - (y1 - y0) * (values[i] / (top || 1)) * 1];
    };

    var shown = Math.max(1, Math.ceil(pts.length * this.progress));
    ctx.beginPath();
    for (var i = 0; i < shown; i++) {
      var p = at(i);
      if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.lineTo(at(shown - 1)[0], y1);
    ctx.lineTo(x0, y1);
    ctx.closePath();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 1;

    var last = at(shown - 1);
    ctx.beginPath();
    ctx.arc(last[0], last[1], 3.5, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();

    ctx.fillStyle = token('--tx3', '#8b93a7');
    ctx.textAlign = 'left';
    ctx.fillText(truncate(ctx, pts[0].label || '', 90), x0, y1 + 8);
    if (pts.length > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(truncate(ctx, pts[pts.length - 1].label || '', 90), x1, y1 + 8);
    }

    if (this.hover >= 0) {
      var h = at(this.hover);
      this.lastX = h[0];
      ctx.strokeStyle = token('--tx3', '#8b93a7');
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(h[0], y0);
      ctx.lineTo(h[0], y1);
      ctx.stroke();
      ctx.globalAlpha = 1;
      this.readout(b, this.hover);
    }
  };

  /* ---- upright bars, for a count per day ---- */

  Chart.prototype.drawBar = function (b) {
    var ctx = this.ctx, pts = this.points;
    var padL = this.padLeft(), padB = 16;
    var values = pts.map(function (p) { return p.value; });
    var top = niceTop(Math.max.apply(null, values));
    this.grid(b, top, padL, padB);

    var x0 = padL, x1 = b.w - 8, y1 = b.h - padB, y0 = 12;
    var slot = (x1 - x0) / pts.length;
    var w = Math.max(2, Math.min(slot - 4, 34));
    var accent = token('--lav', '#7c8cf8');

    for (var i = 0; i < pts.length; i++) {
      var h = (y1 - y0) * (values[i] / (top || 1)) * this.progress;
      var x = x0 + slot * i + (slot - w) / 2;
      ctx.fillStyle = accent;
      ctx.globalAlpha = this.hover === -1 || this.hover === i ? 1 : 0.45;
      roundRect(ctx, x, y1 - h, w, Math.max(h, 1), Math.min(3, w / 2));
      ctx.fill();
      ctx.globalAlpha = 1;
      if (this.hover === i) this.lastX = x + w / 2;
    }

    ctx.fillStyle = token('--tx3', '#8b93a7');
    ctx.textAlign = 'left';
    ctx.fillText(truncate(ctx, pts[0].label || '', 90), x0, y1 + 8);
    if (pts.length > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(truncate(ctx, pts[pts.length - 1].label || '', 90), x1, y1 + 8);
    }
    if (this.hover >= 0) this.readout(b, this.hover);
  };

  /* ---- bars on their sides, for things with long names ---- */

  Chart.prototype.drawHBar = function (b) {
    var ctx = this.ctx, pts = this.points;
    var values = pts.map(function (p) { return p.value; });
    var top = Math.max.apply(null, values) || 1;
    var rowH = (b.h - 8) / pts.length;
    var labelW = Math.min(Math.max(b.w * 0.42, 70), 190);
    var accent = token('--lav', '#7c8cf8');
    var dim = token('--tx2', '#c7ccd8');

    for (var i = 0; i < pts.length; i++) {
      var y = 4 + rowH * i;
      var barH = Math.max(6, Math.min(rowH - 7, 16));
      var full = (b.w - labelW - 56);
      var w = Math.max(1, full * (values[i] / top) * this.progress);

      ctx.fillStyle = dim;
      ctx.textAlign = 'left';
      ctx.globalAlpha = this.hover === -1 || this.hover === i ? 1 : 0.5;
      ctx.fillText(truncate(ctx, pts[i].label || '', labelW - 8), 2, y + rowH / 2);

      ctx.fillStyle = accent;
      roundRect(ctx, labelW, y + (rowH - barH) / 2, w, barH, Math.min(3, barH / 2));
      ctx.fill();

      ctx.fillStyle = token('--tx3', '#8b93a7');
      ctx.textAlign = 'left';
      ctx.fillText(fmt(values[i], this.spec.unit), labelW + w + 6, y + rowH / 2);
      ctx.globalAlpha = 1;
    }
  };

  /* ---- the one thing every instance must have ---- */

  Chart.prototype.destroy = function () {
    if (this.dead) return;
    this.dead = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
    try { this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); } catch (e) {}
    this.ctx = null;
    this.points = [];
  };

  window.MapperCharts = {
    version: 1,
    create: function (canvas, spec) { return new Chart(canvas, spec || {}); },
  };
}());
