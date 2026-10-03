/* ==========================================================================
   Motion Graphics renderers: one tiny canvas animation per style (55).

   Every renderer is a pure function of time:  draw(g, w, h, t, s)
     g    CanvasRenderingContext2D
     w,h  canvas size in device pixels
     t    seconds, already wrapped to [0, dur)
     s    scratch object owned by one canvas (offscreen buffers, caches)

   Because nothing depends on the previous frame, the player can pause,
   scrub and loop any clip exactly.
   ========================================================================== */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const FONT = {
    display: '"Karantina", "Arial Narrow", "Arial Hebrew", sans-serif',
    sans: '"IBM Plex Sans Hebrew", "Arial Hebrew", Arial, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
  };

  /* ---------- math ---------- */
  const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, k) => a + (b - a) * k;
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const E = {
    inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    out: (k) => 1 - Math.pow(1 - k, 3),
    in: (k) => k * k * k,
    sine: (k) => 0.5 - Math.cos(k * Math.PI) / 2,
    back: (k) => {
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
    },
    elastic: (k) =>
      k <= 0 ? 0 : k >= 1 ? 1 : Math.pow(2, -10 * k) * Math.sin((k * 10 - 0.75) * (TAU / 3)) + 1,
  };
  const hash = (n) => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const hash2 = (a, b) => hash(a * 57.31 + b * 113.97);
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }
  const norm3 = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  function rotXYZ(p, ax, ay, az) {
    let [x, y, z] = p;
    let c = Math.cos(ax), s = Math.sin(ax);
    [y, z] = [y * c - z * s, y * s + z * c];
    c = Math.cos(ay); s = Math.sin(ay);
    [x, z] = [x * c + z * s, -x * s + z * c];
    c = Math.cos(az); s = Math.sin(az);
    [x, y] = [x * c - y * s, x * s + y * c];
    return [x, y, z];
  }

  /* ---------- colour ---------- */
  const hexRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const mixRgb = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
  const rgb = (c, m = 1) =>
    `rgb(${clamp(c[0] * m, 0, 255) | 0},${clamp(c[1] * m, 0, 255) | 0},${clamp(c[2] * m, 0, 255) | 0})`;
  const shade = (hex, m) => rgb(hexRgb(hex), m);

  /* ---------- drawing ---------- */
  const font = (g, px, fam = 'display', wt = 700) => {
    g.font = `${wt} ${Math.max(1, px).toFixed(1)}px ${FONT[fam]}`;
  };
  const bg = (g, w, h, c) => {
    g.fillStyle = c;
    g.fillRect(0, 0, w, h);
  };
  function rrect(g, x, y, w, h, r) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r);
    else g.rect(x, y, w, h);
  }
  function circle(g, x, y, r) {
    g.beginPath();
    g.arc(x, y, Math.max(0, r), 0, TAU);
  }
  function poly(g, pts, close = true) {
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
    if (close) g.closePath();
  }
  function vgrad(g, y1, stops, y0 = 0) {
    const gr = g.createLinearGradient(0, y0, 0, y1);
    stops.forEach((c, i) => gr.addColorStop(i / (stops.length - 1), c));
    return gr;
  }
  // Lay out a string right-to-left, one glyph at a time (Hebrew letters don't join).
  function lettersRTL(g, str, cx, spacing = 0) {
    const chars = [...str];
    const ws = chars.map((ch) => g.measureText(ch).width);
    const total = ws.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
    let x = cx + total / 2;
    const out = chars.map((ch, i) => {
      const o = { ch, i, w: ws[i], x: x - ws[i] / 2 };
      x -= ws[i] + spacing;
      return o;
    });
    out.total = total;
    return out;
  }
  function arcPts(cx, cy, r, a0, a1, n = 32) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = lerp(a0, a1, i / n);
      out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return out;
  }
  function quadPts(a, c, b, n = 30) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const k = i / n, u = 1 - k;
      out.push([u * u * a[0] + 2 * u * k * c[0] + k * k * b[0], u * u * a[1] + 2 * u * k * c[1] + k * k * b[1]]);
    }
    return out;
  }
  function heartPts(cx, cy, size, n = 40) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const x = 16 * Math.pow(Math.sin(a), 3);
      const y = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
      out.push([cx + (x * size) / 17, cy + (y * size) / 17]);
    }
    return out;
  }
  function polyLen(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return L;
  }
  // Stroke the first k (0..1) of a polyline; returns the pen tip.
  function strokePartial(g, pts, k) {
    if (k <= 0 || pts.length < 2) return null;
    const L = polyLen(pts) * clamp(k);
    let acc = 0, tip = pts[0];
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const d = Math.hypot(x1 - x0, y1 - y0);
      if (acc + d >= L) {
        const r = d ? (L - acc) / d : 0;
        tip = [x0 + (x1 - x0) * r, y0 + (y1 - y0) * r];
        g.lineTo(tip[0], tip[1]);
        break;
      }
      g.lineTo(x1, y1);
      acc += d;
      tip = pts[i];
    }
    g.stroke();
    return tip;
  }
  // Several polylines drawn one after another, sharing one progress value.
  function strokeSeq(g, paths, k) {
    const lens = paths.map(polyLen), total = lens.reduce((a, b) => a + b, 0);
    let rem = clamp(k) * total, tip = null;
    for (let i = 0; i < paths.length && rem > 0; i++) {
      tip = strokePartial(g, paths[i], Math.min(1, rem / lens[i])) || tip;
      rem -= lens[i];
    }
    return tip;
  }
  // Point and heading at fraction k along a polyline.
  function pathPoint(pts, k) {
    const L = polyLen(pts) * clamp(k);
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const d = Math.hypot(x1 - x0, y1 - y0);
      if (acc + d >= L) {
        const r = d ? (L - acc) / d : 0;
        return [x0 + (x1 - x0) * r, y0 + (y1 - y0) * r, Math.atan2(y1 - y0, x1 - x0)];
      }
      acc += d;
    }
    const n = pts.length;
    return [pts[n - 1][0], pts[n - 1][1], Math.atan2(pts[n - 1][1] - pts[n - 2][1], pts[n - 1][0] - pts[n - 2][0])];
  }
  function buf(s, key, w, h) {
    let b = s[key];
    if (!b || b.c.width !== w || b.c.height !== h) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      b = s[key] = { c, g: c.getContext('2d') };
    }
    return b;
  }

  const R = {};

  /* ======================================================================
     Typography
     ====================================================================== */

  R['kinetic-type'] = (g, w, h, t) => {
    const words = [
      ['תנועה', '#FFD23F', '#16161D'],
      ['היא', '#16161D', '#FFD23F'],
      ['השפה', '#FF4D4D', '#FFF7E8'],
      ['החדשה', '#3DDBD9', '#16161D'],
    ];
    const slot = 1.5, i = Math.floor(t / slot) % words.length, lt = (t - i * slot) / slot;
    const [word, back, ink] = words[i];
    const next = words[(i + 1) % words.length];
    bg(g, w, h, back);
    const pin = E.back(seg(lt, 0, 0.3)), pout = E.in(seg(lt, 0.8, 1));

    font(g, h * 0.06, 'mono', 500);
    g.fillStyle = ink;
    g.globalAlpha = 0.7;
    g.textBaseline = 'top';
    g.fillText(`0${i + 1} / 04`, w * 0.04, h * 0.06);
    g.globalAlpha = 1;

    g.save();
    g.translate(w / 2 - pout * w * 0.12, h * 0.52);
    g.rotate((i % 2 ? -1 : 1) * 0.14 * (1 - pin));
    const sc = Math.max(0.001, lerp(0.3, 1, pin) * (1 + seg(lt, 0.3, 0.8) * 0.06));
    g.scale(sc, sc);
    font(g, h * 0.6);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = ink;
    g.fillText(word, 0, 0);
    g.restore();

    const ul = E.out(seg(lt, 0.18, 0.5));
    g.fillStyle = ink;
    g.fillRect(w * 0.7 - w * 0.4 * ul, h * 0.84, w * 0.4 * ul, h * 0.022);
    if (pout > 0) {
      g.fillStyle = next[1];
      g.fillRect(w * (1 - pout), 0, w * pout + 1, h);
    }
  };

  R.typewriter = (g, w, h, t) => {
    bg(g, w, h, '#F3EEE3');
    const lines = ['פעם, לפני הרבה פריימים,', 'כל אנימציה התחילה', 'במילה אחת שהוקלדה.'];
    const lh = h * 0.18, top = h * 0.34, right = w * 0.87;
    g.lineWidth = Math.max(1, h * 0.004);
    g.strokeStyle = 'rgba(40,70,140,0.14)';
    g.beginPath();
    for (let k = 0; k < 4; k++) {
      const y = top + k * lh + lh * 0.14;
      g.moveTo(w * 0.05, y);
      g.lineTo(w * 0.95, y);
    }
    g.stroke();
    g.strokeStyle = 'rgba(214,64,64,0.4)';
    g.beginPath();
    g.moveTo(w * 0.91, 0);
    g.lineTo(w * 0.91, h);
    g.stroke();

    const total = lines.reduce((a, l) => a + l.length, 0);
    const typed = Math.floor(seg(t, 0.4, 5.4) * total);
    font(g, h * 0.095, 'sans', 500);
    g.direction = 'rtl';
    g.textAlign = 'right';
    g.fillStyle = '#1F1F26';
    let left = typed, cur = null;
    lines.forEach((line, k) => {
      const n = Math.max(0, Math.min(left, line.length)), y = top + k * lh;
      if (n > 0) g.fillText(line.slice(0, n), right, y);
      if (cur === null && left <= line.length) cur = { x: right - g.measureText(line.slice(0, n)).width, y };
      left -= n;
    });
    if (cur && (typed < total || Math.floor(t * 2.4) % 2 === 0)) {
      g.fillStyle = '#E2412E';
      g.fillRect(cur.x - h * 0.045, cur.y - h * 0.08, h * 0.03, h * 0.095);
    }
    font(g, h * 0.05, 'mono', 500);
    g.direction = 'ltr';
    g.textAlign = 'left';
    g.fillStyle = 'rgba(31,31,38,.5)';
    g.fillText(`${String(typed).padStart(2, '0')}/${total} CHR`, w * 0.05, h * 0.14);
  };

  R['wave-text'] = (g, w, h, t) => {
    const ph = (t / 4) * TAU;
    g.fillStyle = vgrad(g, h, ['#0B1F4D', '#0A5C8C']);
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(189,239,255,.22)';
    g.lineWidth = Math.max(1, h * 0.006);
    for (let r = 0; r < 3; r++) {
      g.beginPath();
      for (let x = 0; x <= w + 1; x += w / 60) {
        const y = h * (0.74 + r * 0.08) + Math.sin((x / w) * TAU * 3 + ph * (r + 1)) * h * 0.012;
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    font(g, h * 0.3);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const L = lettersRTL(g, 'זורם כמו מים', w / 2);
    for (const o of L) {
      if (o.ch === ' ') continue;
      const wave = ph * 2 - o.i * 0.55;
      const y = h * 0.44 + Math.sin(wave) * h * 0.09;
      g.save();
      g.translate(o.x, y);
      g.rotate(Math.cos(wave) * 0.18);
      g.fillStyle = `hsl(${185 + Math.sin(ph - o.i * 0.4) * 25}, 90%, ${72 + Math.sin(wave) * 12}%)`;
      g.fillText(o.ch, 0, 0);
      g.restore();
      g.save();
      g.translate(o.x, h * 0.86 - (y - h * 0.44) * 0.4);
      g.scale(1, -0.32);
      g.globalAlpha = 0.16;
      g.fillStyle = '#BDEFFF';
      g.fillText(o.ch, 0, 0);
      g.restore();
    }
  };

  R['mask-reveal'] = (g, w, h, t) => {
    bg(g, w, h, '#0E0E12');
    font(g, h * 0.42);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const word = 'חשיפה', tw = g.measureText(word).width, pad = h * 0.04;
    const x0 = w / 2 - tw / 2 - pad, x1 = w / 2 + tw / 2 + pad, W = x1 - x0, y0 = h * 0.2, y1 = h * 0.64;
    const a = E.inOut(seg(t, 0.2, 0.9)), b = E.inOut(seg(t, 0.9, 1.6));
    const c = E.inOut(seg(t, 3.6, 4.2)), d = E.inOut(seg(t, 4.2, 4.8));
    let bar = null, vis = null;
    if (t < 0.9) bar = [x1 - W * a, x1];
    else if (t < 1.6) { bar = [x0, x1 - W * b]; vis = [x1 - W * b, x1]; }
    else if (t < 3.6) vis = [x0, x1];
    else if (t < 4.2) { bar = [x1 - W * c, x1]; vis = [x0, x1 - W * c]; }
    else bar = [x0, x1 - W * d];
    if (vis) {
      g.save();
      g.beginPath();
      g.rect(vis[0], 0, vis[1] - vis[0], h);
      g.clip();
      g.fillStyle = '#F5F2EA';
      g.fillText(word, w / 2, (y0 + y1) / 2 + h * 0.02);
      g.restore();
    }
    if (bar && bar[1] - bar[0] > 0.5) {
      g.fillStyle = '#FF5A36';
      g.fillRect(bar[0], y0, bar[1] - bar[0], y1 - y0);
    }
    const sub = E.out(seg(t, 1.4, 2.0)) - E.in(seg(t, 3.3, 3.7));
    if (sub > 0) {
      g.save();
      g.beginPath();
      g.rect(0, h * 0.7, w, h * 0.12);
      g.clip();
      font(g, h * 0.065, 'sans', 500);
      g.fillStyle = '#A9A6B8';
      g.fillText('המסכה קובעת מה נראה ומתי', w / 2, h * 0.76 + (1 - sub) * h * 0.1);
      g.restore();
    }
  };

  R['extruded-text'] = (g, w, h, t) => {
    const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, '#FF8A5B');
    gr.addColorStop(1, '#FF3D8B');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
    const ph = (t / 6) * TAU, ang = Math.PI * 0.25 + Math.sin(ph) * 0.9, depth = h * 0.11, n = 24;
    font(g, h * 0.5);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const cx = w / 2, cy = h * 0.5 + Math.sin(ph * 2) * h * 0.02;
    g.fillStyle = 'rgba(80,10,40,.25)';
    g.beginPath();
    g.ellipse(cx + Math.cos(ang) * depth, h * 0.86, w * 0.3, h * 0.035, 0, 0, TAU);
    g.fill();
    for (let k = n; k >= 1; k--) {
      const d = (depth * k) / n;
      g.fillStyle = `hsl(${255 - k * 2}, 48%, ${16 + (n - k) * 1.3}%)`;
      g.fillText('עומק', cx + Math.cos(ang) * d, cy + Math.sin(ang) * d);
    }
    g.fillStyle = '#FFF4E0';
    g.fillText('עומק', cx, cy);
  };

  R['split-flap'] = (g, w, h, t) => {
    bg(g, w, h, '#111216');
    const cities = ['לונדון', 'טוקיו', 'ניו יורק'], times = ['18:40', '21:15', '23:05'];
    const pool = 'אבגדהוזחטיכלמנסעפצקרשת', digits = '0123456789';
    const cyc = 2, idx = Math.floor(t / cyc) % 3, lt = t - idx * cyc, prev = (idx + 2) % 3;
    const cw = w * 0.085, ch = h * 0.24, gap = w * 0.01, flapT = 0.07;
    font(g, ch * 0.62, 'sans', 600);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const cell = (x, y, from, to, j, r, set) => {
      const start = 0.05 * j + 0.15 * r;
      const flips = 3 + Math.floor(hash(j * 7 + r * 31 + idx) * 4);
      const local = lt - start;
      let shown = to, sy = 1;
      if (from !== to) {
        if (local < 0) shown = from;
        else if (local < flips * flapT) {
          const m = Math.floor(local / flapT), f = (local - m * flapT) / flapT;
          const rnd = (q) => set[Math.floor(hash(q * 13 + j * 3 + r * 17 + idx * 5) * set.length)];
          const a = m === 0 ? from : rnd(m), b = m === flips - 1 ? to : rnd(m + 1);
          shown = f < 0.5 ? a : b;
          sy = Math.abs(Math.cos(f * Math.PI));
        }
      }
      rrect(g, x, y, cw, ch, cw * 0.1);
      g.fillStyle = '#25272E';
      g.fill();
      g.save();
      g.translate(x + cw / 2, y + ch / 2);
      g.scale(1, Math.max(0.04, sy));
      g.fillStyle = '#F2EEDF';
      g.fillText(shown, 0, ch * 0.03);
      g.restore();
      g.fillStyle = '#0B0B0E';
      g.fillRect(x, y + ch / 2 - Math.max(1, h * 0.004), cw, Math.max(2, h * 0.008));
    };
    const N = 8, totalW = N * cw + (N - 1) * gap, xr = w / 2 + totalW / 2;
    const a = [...cities[prev].padEnd(N)], b = [...cities[idx].padEnd(N)];
    for (let j = 0; j < N; j++) cell(xr - (j + 1) * cw - j * gap, h * 0.2, a[j], b[j], j, 0, pool);
    const M = 5, xl = w / 2 - (M * cw + (M - 1) * gap) / 2;
    for (let j = 0; j < M; j++) cell(xl + j * (cw + gap), h * 0.6, times[prev][j], times[idx][j], j, 1, digits);
    font(g, h * 0.05, 'sans', 500);
    g.direction = 'rtl';
    g.textAlign = 'right';
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#8B8E99';
    g.fillText('יעד', xr, h * 0.16);
    g.fillText('המראה', xl + M * cw + (M - 1) * gap, h * 0.56);
  };

  R['text-scramble'] = (g, w, h, t) => {
    bg(g, w, h, '#F4F4F0');
    const phrases = ['קוד סודי', 'מפוענח'];
    const slot = 3, i = Math.floor(t / slot) % 2, lt = t - i * slot;
    const pool = 'אבגדהוזחטיכלמנסעפצקרשת#%&@*?';
    font(g, h * 0.24, 'sans', 700);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const L = lettersRTL(g, phrases[i], w / 2);
    let done = 0, count = 0;
    for (const o of L) {
      if (o.ch === ' ') continue;
      count++;
      const res = 0.25 + o.i * 0.12 + hash(o.i + i * 20) * 0.35;
      const outT = 2.45 + o.i * 0.04;
      let ch = o.ch, ok = true;
      if (lt < res || lt > outT) {
        ok = false;
        ch = pool[Math.floor(hash(Math.floor(lt * 18) + o.i * 7 + i * 91) * pool.length)];
      } else done++;
      g.fillStyle = ok ? '#141418' : '#E2412E';
      g.fillText(ch, o.x, h * 0.46);
    }
    const pct = Math.round((done / count) * 100);
    font(g, h * 0.05, 'mono', 500);
    g.textAlign = 'left';
    g.fillStyle = '#777';
    g.fillText(`DECODE ${String(pct).padStart(3, '0')}%`, w * 0.06, h * 0.82);
    g.fillStyle = '#DDDDD6';
    g.fillRect(w * 0.06, h * 0.87, w * 0.88, h * 0.012);
    g.fillStyle = '#E2412E';
    g.fillRect(w * 0.06, h * 0.87, w * 0.88 * (done / count), h * 0.012);
  };

  /* ======================================================================
     2D & illustration
     ====================================================================== */

  R['flat-design'] = (g, w, h, t) => {
    const p = t / 8, ph = p * TAU;
    bg(g, w, h, '#8FD3C7');
    const sx = w * 0.74, sy = h * 0.32, sr = h * 0.11;
    g.save();
    g.translate(sx, sy);
    g.rotate(ph / 4);
    g.fillStyle = '#FFD166';
    for (let k = 0; k < 12; k++) {
      g.rotate(TAU / 12);
      g.fillRect(sr * 1.3, -sr * 0.07, sr * 0.45, sr * 0.14);
    }
    g.restore();
    circle(g, sx, sy, sr);
    g.fillStyle = '#FFD166';
    g.fill();
    const cloud = (x, y, s) => {
      g.fillStyle = '#FFFFFF';
      circle(g, x, y, s); g.fill();
      circle(g, x + s * 0.9, y + s * 0.25, s * 0.72); g.fill();
      circle(g, x - s * 0.9, y + s * 0.3, s * 0.66); g.fill();
      rrect(g, x - s * 1.5, y + s * 0.15, s * 3.1, s * 0.8, s * 0.4); g.fill();
    };
    for (let k = 0; k < 3; k++) {
      const s = h * (0.05 + 0.018 * k), span = w + s * 6;
      cloud(((p * ((k % 2) + 1) + k * 0.37) % 1) * span - s * 3, h * (0.14 + 0.1 * k), s);
    }
    const hillY = (x, base, amp, f, phs) => h * base + Math.sin((x / w) * TAU * f + phs) * h * amp;
    const hill = (base, amp, f, phs, col) => {
      g.beginPath();
      g.moveTo(0, h);
      for (let x = 0; x <= w + 1; x += w / 48) g.lineTo(x, hillY(x, base, amp, f, phs));
      g.lineTo(w, h);
      g.closePath();
      g.fillStyle = col;
      g.fill();
    };
    hill(0.64, 0.05, 1, 0.6, '#4FB286');
    // tree
    const tx = w * 0.52, ty = hillY(tx, 0.78, 0.035, 1.5, 2.2) + h * 0.01;
    g.save();
    g.translate(tx, ty);
    g.rotate(Math.sin(ph * 2) * 0.05);
    g.fillStyle = '#8D5A3B';
    g.fillRect(-h * 0.015, -h * 0.2, h * 0.03, h * 0.2);
    circle(g, 0, -h * 0.25, h * 0.09);
    g.fillStyle = '#06A77D';
    g.fill();
    g.restore();
    hill(0.78, 0.035, 1.5, 2.2, '#2D8F6F');
    // house
    const hx = w * 0.26, hy = hillY(hx, 0.78, 0.035, 1.5, 2.2) + h * 0.02, hw = h * 0.22, hh = h * 0.15;
    g.fillStyle = '#FFF4E0';
    g.fillRect(hx - hw / 2, hy - hh, hw, hh);
    g.fillStyle = '#EF476F';
    poly(g, [[hx - hw * 0.62, hy - hh], [hx, hy - hh - h * 0.12], [hx + hw * 0.62, hy - hh]]);
    g.fill();
    g.fillStyle = '#118AB2';
    g.fillRect(hx - hw * 0.12, hy - hh * 0.6, hw * 0.24, hh * 0.6);
    g.fillStyle = Math.sin(ph) > 0.6 ? '#FFD166' : '#073B4C';
    g.fillRect(hx + hw * 0.2, hy - hh * 0.72, hw * 0.18, hh * 0.28);
  };

  R.character = (g, w, h, t) => {
    const s = h / 100, ph = t * TAU, p = t / 4;
    bg(g, w, h, '#F7E8CC');
    const ground = h * 0.8;
    for (let k = 0; k < 7; k++) {
      const bw = w * (0.1 + hash(k) * 0.06), bh = h * (0.2 + hash(k + 3) * 0.3);
      const x = ((k / 7 + p) % 1) * w * 1.3 - w * 0.15;
      g.fillStyle = k % 2 ? '#EBC88F' : '#E3B577';
      g.fillRect(x, ground - bh, bw, bh);
      g.fillStyle = 'rgba(255,255,255,.35)';
      for (let wy = ground - bh + h * 0.04; wy < ground - h * 0.07; wy += h * 0.07)
        for (let wx = x + bw * 0.15; wx < x + bw * 0.8; wx += bw * 0.3) g.fillRect(wx, wy, bw * 0.14, h * 0.035);
    }
    g.fillStyle = '#5C4B51';
    g.fillRect(0, ground, w, h - ground);
    g.fillStyle = '#D8C3A5';
    const sp = w * 0.08, off = ((t * sp * 2) % sp);
    for (let x = -sp + off; x < w; x += sp) g.fillRect(x, ground + h * 0.08, sp * 0.5, h * 0.015);

    const cx = w * 0.5;
    const stance = Math.abs(Math.sin(ph)) * 0.55;
    const hip = [cx, ground - 30 * s * Math.cos(stance) - 1.5 * s];
    g.fillStyle = 'rgba(0,0,0,.15)';
    g.beginPath();
    g.ellipse(cx, ground + s, 14 * s, 2.5 * s, 0, 0, TAU);
    g.fill();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const leg = (phase, col) => {
      const a = Math.sin(phase) * 0.55, bend = Math.max(0, Math.cos(phase)) * 0.9;
      const knee = [hip[0] - Math.sin(a) * 15 * s, hip[1] + Math.cos(a) * 15 * s];
      const a2 = a - bend;
      const foot = [knee[0] - Math.sin(a2) * 15 * s, knee[1] + Math.cos(a2) * 15 * s];
      g.strokeStyle = col;
      g.lineWidth = 5 * s;
      g.beginPath();
      g.moveTo(hip[0], hip[1]);
      g.lineTo(knee[0], knee[1]);
      g.lineTo(foot[0], foot[1]);
      g.stroke();
      g.fillStyle = '#1D1D1D';
      g.beginPath();
      g.ellipse(foot[0] - 2.5 * s, foot[1] + 0.5 * s, 4.5 * s, 2.2 * s, 0, 0, TAU);
      g.fill();
    };
    const sh = [hip[0], hip[1] - 20 * s];
    const arm = (phase, col) => {
      const a = -Math.sin(phase) * 0.6;
      const el = [sh[0] - Math.sin(a) * 10 * s, sh[1] + Math.cos(a) * 10 * s];
      const hand = [el[0] - Math.sin(a + 0.6) * 9 * s, el[1] + Math.cos(a + 0.6) * 9 * s];
      g.strokeStyle = col;
      g.lineWidth = 4 * s;
      g.beginPath();
      g.moveTo(sh[0], sh[1]);
      g.lineTo(el[0], el[1]);
      g.lineTo(hand[0], hand[1]);
      g.stroke();
    };
    arm(ph + Math.PI, '#B4533C');
    leg(ph + Math.PI, '#1B3440');
    leg(ph, '#264653');
    rrect(g, hip[0] - 6.5 * s, hip[1] - 25 * s, 13 * s, 27 * s, 6 * s);
    g.fillStyle = '#E76F51';
    g.fill();
    const hx = hip[0] - s, hy = hip[1] - 34 * s;
    circle(g, hx, hy, 8 * s);
    g.fillStyle = '#F2C6A0';
    g.fill();
    g.fillStyle = '#2B2D42';
    g.beginPath();
    g.arc(hx, hy - 0.5 * s, 8.4 * s, Math.PI * 1.02, Math.PI * 2.02);
    g.fill();
    g.fillRect(hx - 13 * s, hy - 2 * s, 7 * s, 2 * s);
    const blink = t % 2 > 1.2 && t % 2 < 1.3;
    g.fillStyle = '#1D1D1D';
    if (blink) g.fillRect(hx - 5 * s, hy + 1 * s, 2.4 * s, 0.6 * s);
    else { circle(g, hx - 4 * s, hy + 1.2 * s, 1 * s); g.fill(); }
    arm(ph, '#E76F51');
  };

  R.whiteboard = (g, w, h, t) => {
    bg(g, w, h, '#FBFBF7');
    const s = h / 100, cx = w * 0.7, cy = h * 0.38, r = 17 * s, ink = '#1E2A44';
    const bulb = arcPts(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25, 40).concat([
      [cx + 0.42 * r, cy + 1.2 * r],
      [cx - 0.42 * r, cy + 1.2 * r],
      [cx - Math.SQRT1_2 * r, cy + Math.SQRT1_2 * r],
    ]);
    const fil = [
      [cx - 0.3 * r, cy + 1.15 * r], [cx - 0.25 * r, cy + 0.15 * r], [cx - 0.1 * r, cy + 0.4 * r],
      [cx, cy + 0.12 * r], [cx + 0.1 * r, cy + 0.4 * r], [cx + 0.25 * r, cy + 0.15 * r], [cx + 0.3 * r, cy + 1.15 * r],
    ];
    const base1 = [[cx - 0.4 * r, cy + 1.42 * r], [cx + 0.4 * r, cy + 1.42 * r]];
    const base2 = [[cx - 0.28 * r, cy + 1.62 * r], [cx + 0.28 * r, cy + 1.62 * r]];
    const rays = [];
    for (let k = 0; k < 5; k++) {
      const a = Math.PI * (1.1 + k * 0.2);
      rays.push([[cx + Math.cos(a) * r * 1.35, cy + Math.sin(a) * r * 1.35], [cx + Math.cos(a) * r * 1.7, cy + Math.sin(a) * r * 1.7]]);
    }
    g.globalAlpha = 1 - seg(t, 6.3, 6.9);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = 1.6 * s;
    g.strokeStyle = ink;
    let tip = strokeSeq(g, [bulb, fil, base1, base2], seg(t, 0.3, 2.8));
    g.strokeStyle = '#F2A500';
    tip = strokeSeq(g, rays, seg(t, 2.8, 3.5)) || tip;
    const k = seg(t, 3.6, 4.8);
    font(g, h * 0.24);
    g.direction = 'rtl';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    const word = 'רעיון!', tx = w * 0.47, ty = h * 0.42, tw = g.measureText(word).width;
    if (k > 0) {
      g.save();
      g.beginPath();
      g.rect(tx - tw * k, 0, tw * k + 2, h);
      g.clip();
      g.fillStyle = ink;
      g.fillText(word, tx, ty);
      g.restore();
      if (k < 1) tip = [tx - tw * k, ty + h * 0.06];
    }
    const u = seg(t, 4.8, 5.3);
    if (u > 0) {
      g.strokeStyle = '#E63946';
      const pts = [];
      for (let i = 0; i <= 20; i++) pts.push([tx - (tw * i) / 20, ty + h * 0.15 + Math.sin(i * 1.3) * h * 0.008]);
      const tp = strokePartial(g, pts, u);
      if (u < 1) tip = tp;
    }
    g.globalAlpha = 1;
    if (tip && t > 0.3 && t < 5.35) {
      g.save();
      g.translate(tip[0], tip[1]);
      g.rotate(-0.75);
      g.fillStyle = '#E63946';
      poly(g, [[0, 0], [4 * s, -1.6 * s], [4 * s, 1.6 * s]]);
      g.fill();
      rrect(g, 4 * s, -2.4 * s, 24 * s, 4.8 * s, 1.2 * s);
      g.fillStyle = '#2B2D42';
      g.fill();
      g.fillStyle = '#E63946';
      g.fillRect(22 * s, -2.4 * s, 6 * s, 4.8 * s);
      g.restore();
    }
  };

  R.doodle = (g, w, h, t) => {
    const fr = Math.floor(t * 8), boil = fr % 3, tq = fr / 8, s = h / 100;
    bg(g, w, h, '#FFFDF4');
    g.strokeStyle = 'rgba(70,120,200,.18)';
    g.lineWidth = Math.max(1, h * 0.004);
    g.beginPath();
    for (let y = h * 0.12; y < h; y += h * 0.1) { g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
    g.strokeStyle = 'rgba(230,80,80,.35)';
    g.beginPath();
    g.moveTo(w * 0.92, 0);
    g.lineTo(w * 0.92, h);
    g.stroke();
    const J = 1.8 * s;
    const jit = (pts, seed) =>
      pts.map((p, i) => [p[0] + (hash2(seed + i, boil) - 0.5) * J, p[1] + (hash2(seed + i + 500, boil) - 0.5) * J]);
    const pen = (pts, col, lw, close) => {
      g.strokeStyle = col;
      g.lineWidth = lw;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      poly(g, pts, close);
      g.stroke();
    };
    const bob = Math.sin(tq * Math.PI) * 3 * s;
    const star = [], sx = w * 0.17, sy = h * 0.38 + bob;
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 5 + Math.sin(tq * Math.PI) * 0.12;
      const rr = k % 2 ? 7 * s : 16 * s;
      star.push([sx + Math.cos(a) * rr, sy + Math.sin(a) * rr]);
    }
    pen(jit(star, 10), '#F4A300', 2.2 * s, true);
    const hs = 15 * s * (1 + 0.08 * Math.sin(tq * TAU));
    pen(jit(heartPts(w * 0.47, h * 0.36 - bob, hs, 32), 80), '#E63946', 2.4 * s, true);
    const spi = [], spx = w * 0.76, spy = h * 0.38;
    for (let a = 0; a < Math.PI * 5; a += 0.3) {
      const rr = 1.2 * s * a, aa = a + tq * Math.PI;
      spi.push([spx + Math.cos(aa) * rr, spy + Math.sin(aa) * rr]);
    }
    pen(jit(spi, 200), '#2449B8', 2 * s, false);
    const arrow = [];
    for (let i = 0; i <= 16; i++) arrow.push([w * 0.12 + (i / 16) * w * 0.26, h * 0.79 + Math.sin(i * 0.9) * 3 * s]);
    const ae = arrow[arrow.length - 1];
    pen(jit(arrow, 300), '#2449B8', 2 * s, false);
    pen(jit([[ae[0] - 5 * s, ae[1] - 4 * s], ae, [ae[0] - 5 * s, ae[1] + 4 * s]], 340), '#2449B8', 2 * s, false);
    g.save();
    g.translate(w * 0.64 + (hash(boil) - 0.5) * s, h * 0.79 + (hash(boil + 4) - 0.5) * s);
    g.rotate(-0.05 + (hash(boil + 9) - 0.5) * 0.05);
    font(g, h * 0.2);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#1E2A44';
    g.fillText('שרבוטים', 0, 0);
    g.restore();
  };

  R.cel = (g, w, h, t) => {
    const fps = 12, fr = Math.floor(t * fps), total = 4 * fps;
    bg(g, w, h, '#FFF5E1');
    g.fillStyle = '#E9D8B8';
    rrect(g, w / 2 - h * 0.035, h * 0.03, h * 0.07, h * 0.035, h * 0.017);
    g.fill();
    circle(g, w / 2 - h * 0.18, h * 0.048, h * 0.018); g.fill();
    circle(g, w / 2 + h * 0.18, h * 0.048, h * 0.018); g.fill();
    g.strokeStyle = 'rgba(120,100,70,.12)';
    g.lineWidth = 1;
    g.strokeRect(w * 0.05, h * 0.1, w * 0.9, h * 0.78);
    const ground = h * 0.8;
    g.strokeStyle = '#3B3B3B';
    g.lineWidth = Math.max(1, h * 0.006);
    g.beginPath();
    g.moveTo(w * 0.06, ground);
    g.lineTo(w * 0.94, ground);
    g.stroke();
    const R0 = h * 0.07, H = h * 0.5;
    const ball = (f) => {
      const tt = f / fps, p = tt % 1, x = w * 0.86 - (tt / 4) * w * 0.72;
      let sx = 1, sy = 1;
      if (p < 0.05) { sx = 1.35; sy = 0.68; }
      else {
        const st = Math.abs(1 - 2 * p) * 0.3;
        sy = 1 + st;
        sx = 1 - st * 0.55;
      }
      return { x, y: ground - 4 * H * p * (1 - p) - R0 * sy, sx, sy };
    };
    const b0 = ball(fr);
    g.fillStyle = 'rgba(0,0,0,.12)';
    g.beginPath();
    g.ellipse(b0.x, ground + h * 0.01, R0 * (1.3 - (ground - b0.y) / h), R0 * 0.2, 0, 0, TAU);
    g.fill();
    for (let k = 3; k >= 1; k--) {
      if (fr - k < 0) continue;
      const b = ball(fr - k);
      g.strokeStyle = `rgba(67,97,238,${0.12 + (3 - k) * 0.1})`;
      g.lineWidth = Math.max(1, h * 0.006);
      g.beginPath();
      g.ellipse(b.x, b.y, R0 * b.sx, R0 * b.sy, 0, 0, TAU);
      g.stroke();
    }
    g.fillStyle = '#F94144';
    g.strokeStyle = '#222';
    g.lineWidth = Math.max(1, h * 0.008);
    g.beginPath();
    g.ellipse(b0.x, b0.y, R0 * b0.sx, R0 * b0.sy, 0, 0, TAU);
    g.fill();
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,.6)';
    g.beginPath();
    g.ellipse(b0.x - R0 * 0.3 * b0.sx, b0.y - R0 * 0.35 * b0.sy, R0 * 0.22, R0 * 0.14, -0.5, 0, TAU);
    g.fill();
    font(g, h * 0.05, 'mono', 500);
    g.fillStyle = '#7A6A50';
    g.textBaseline = 'alphabetic';
    g.fillText(`FRAME ${String(fr + 1).padStart(2, '0')} / ${total}`, w * 0.06, h * 0.95);
    g.textAlign = 'right';
    g.fillText('12 FPS · ON TWOS', w * 0.94, h * 0.95);
  };

  R['anime-speed'] = (g, w, h, t) => {
    const f = Math.floor(t * 12);
    bg(g, w, h, '#FFFFFF');
    const cx = w / 2, cy = h / 2, Rr = Math.hypot(w, h) * 0.6;
    g.fillStyle = '#121212';
    g.beginPath();
    for (let i = 0; i < 110; i++) {
      const a = (i / 110) * TAU + (hash2(i, f) - 0.5) * 0.06;
      const inner = Rr * (0.36 + hash2(i + 7, f) * 0.3);
      const wd = 0.004 + hash2(i + 13, f) * 0.014;
      g.moveTo(cx + Math.cos(a - wd) * Rr, cy + Math.sin(a - wd) * Rr);
      g.lineTo(cx + Math.cos(a + wd) * Rr, cy + Math.sin(a + wd) * Rr);
      g.lineTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      g.closePath();
    }
    g.fill();
    const pop = Math.max(0.001, E.back(seg(t % 1.5, 0, 0.22)));
    g.save();
    g.translate(cx + (hash(f * 3.1) - 0.5) * h * 0.025, cy + (hash(f * 7.3) - 0.5) * h * 0.025);
    g.rotate(-0.06);
    g.scale(pop, pop);
    font(g, h * 0.34);
    g.direction = 'rtl';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = h * 0.05;
    g.strokeStyle = '#FFFFFF';
    g.strokeText('פתאום!', 0, 0);
    g.lineWidth = h * 0.018;
    g.strokeStyle = '#121212';
    g.strokeText('פתאום!', 0, 0);
    g.fillStyle = '#E8352E';
    g.fillText('פתאום!', 0, 0);
    g.restore();
  };

  /* ======================================================================
     3D & depth
     ====================================================================== */

  const CUBE_V = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  const CUBE_F = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [4, 5, 1, 0], [3, 2, 6, 7]];

  R['3d-shapes'] = (g, w, h, t) => {
    const ph = (t / 8) * TAU;
    const gr = g.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, w * 0.7);
    gr.addColorStop(0, '#2E2160');
    gr.addColorStop(1, '#0A0820');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.beginPath();
    g.ellipse(w / 2, h * 0.84, h * 0.38, h * 0.05, 0, 0, TAU);
    g.fill();
    const D = 6, F = h * 1.25, L = norm3([-0.45, -0.75, -0.5]);
    const faces = [];
    const addCube = (c, size, ax, ay, az, hue) => {
      const verts = CUBE_V.map((v) => {
        const r = rotXYZ([v[0] * size, v[1] * size, v[2] * size], ax, ay, az);
        return [r[0] + c[0], r[1] + c[1], r[2] + c[2]];
      });
      CUBE_F.forEach((f) => {
        const pts = f.map((i) => verts[i]);
        const m = pts.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4], [0, 0, 0]);
        const n = norm3([m[0] - c[0], m[1] - c[1], m[2] - c[2]]);
        if (n[0] * m[0] + n[1] * m[1] + n[2] * (m[2] + D) > 0) return;
        faces.push({ pts, z: m[2], hue, lum: clamp(n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) });
      });
    };
    addCube([0, 0, 0], 1, ph, ph * 2, 0, 262);
    for (let k = 0; k < 2; k++) {
      const a = ph + k * Math.PI;
      addCube([Math.cos(a) * 2.3, 0.15 + Math.sin(a * 2) * 0.2, Math.sin(a) * 2.3], 0.36, -ph * 2, ph * 3, 0, k ? 190 : 18);
    }
    faces.sort((a, b) => b.z - a.z);
    for (const f of faces) {
      const P = f.pts.map((p) => [w / 2 + (p[0] * F) / (p[2] + D), h * 0.46 + (p[1] * F) / (p[2] + D)]);
      g.fillStyle = `hsl(${f.hue}, 72%, ${16 + f.lum * 52}%)`;
      g.strokeStyle = g.fillStyle;
      g.lineWidth = 1;
      poly(g, P);
      g.fill();
      g.stroke();
    }
  };

  R.isometric = (g, w, h, t) => {
    const ph = (t / 6) * TAU;
    bg(g, w, h, '#22223B');
    const N = 6, tw = Math.min(w * 0.06, h * 0.1), th = tw * 0.5, ox = w / 2, oy = h * 0.32, maxH = h * 0.2;
    for (let sum = 0; sum <= 2 * (N - 1); sum++) {
      for (let i = 0; i < N; i++) {
        const j = sum - i;
        if (j < 0 || j >= N) continue;
        const x = ox + (i - j) * tw, y = oy + (i + j) * th;
        const d = Math.hypot(i - (N - 1) / 2, j - (N - 1) / 2);
        const wave = 0.5 + 0.5 * Math.sin(ph - d * 1.1);
        const z = h * 0.03 + wave * maxH;
        g.fillStyle = '#F28482';
        poly(g, [[x - tw, y - z], [x, y + th - z], [x, y + th], [x - tw, y]]);
        g.fill();
        g.fillStyle = '#84A59D';
        poly(g, [[x + tw, y - z], [x, y + th - z], [x, y + th], [x + tw, y]]);
        g.fill();
        g.fillStyle = `hsl(42, 92%, ${74 + wave * 16}%)`;
        poly(g, [[x, y - th - z], [x + tw, y - z], [x, y + th - z], [x - tw, y - z]]);
        g.fill();
      }
    }
  };

  R['low-poly'] = (g, w, h, t) => {
    const ph = (t / 8) * TAU, cols = 12, rows = 7, cw = w / cols, chh = h / rows;
    const P = [];
    for (let j = -1; j <= rows + 1; j++) {
      const row = [];
      for (let i = -1; i <= cols + 1; i++) {
        const jx = (hash2(i, j) - 0.5) * cw * 0.7, jy = (hash2(i + 50, j) - 0.5) * chh * 0.7;
        const mx = Math.sin(ph + hash2(i, j + 9) * TAU) * cw * 0.07;
        const my = Math.cos(ph + hash2(i + 3, j) * TAU) * chh * 0.07;
        row.push([i * cw + jx + mx, j * chh + jy + my]);
      }
      P.push(row);
    }
    const sky = ['#1B1446', '#5B2A86', '#C2417A', '#F79256'].map(hexRgb);
    const mnt = ['#164B58', '#0F3540', '#0A222B'].map(hexRgb);
    const ridge = (x) => h * (0.55 + 0.11 * Math.sin((x / w) * Math.PI * 2.2 + 0.8) + 0.05 * Math.sin((x / w) * Math.PI * 5.3));
    const pal = (arr, k) => {
      k = clamp(k) * (arr.length - 1);
      const i = Math.min(arr.length - 2, Math.floor(k));
      return mixRgb(arr[i], arr[i + 1], k - i);
    };
    const skyT = [], mntT = [];
    for (let j = 0; j < P.length - 1; j++) {
      for (let i = 0; i < P[j].length - 1; i++) {
        const a = P[j][i], b = P[j][i + 1], c = P[j + 1][i + 1], d = P[j + 1][i];
        const tris = hash2(i, j + 77) > 0.5 ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]];
        tris.forEach((tri, k) => {
          const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3, cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
          const inM = cy > ridge(cx);
          const col = inM ? pal(mnt, (cy - ridge(cx)) / (h * 0.45)) : pal(sky, cy / (h * 0.62));
          const light = 0.9 + (hash2(i * 2 + k, j) - 0.5) * 0.22 + 0.13 * Math.sin(ph + (cx / w) * TAU - (cy / h) * 2);
          (inM ? mntT : skyT).push([tri, rgb(col, light)]);
        });
      }
    }
    const paint = ([tri, c]) => {
      g.fillStyle = c;
      g.strokeStyle = c;
      g.lineWidth = 1;
      poly(g, tri);
      g.fill();
      g.stroke();
    };
    skyT.forEach(paint);
    const sx = w * 0.68, sy = h * 0.34, sr = h * 0.11;
    for (let k = 0; k < 8; k++) {
      const a0 = (k / 8) * TAU + ph / 8, a1 = ((k + 1) / 8) * TAU + ph / 8;
      g.fillStyle = k % 2 ? '#FFD07B' : '#FFC15E';
      poly(g, [[sx, sy], [sx + Math.cos(a0) * sr, sy + Math.sin(a0) * sr], [sx + Math.cos(a1) * sr, sy + Math.sin(a1) * sr]]);
      g.fill();
    }
    mntT.forEach(paint);
  };

  R.wireframe = (g, w, h, t) => {
    const ph = (t / 8) * TAU;
    bg(g, w, h, '#081129');
    const U = 32, V = 16, Rr = 1, r = 0.42, D = 4.2, F = h * 1.2;
    const P = [];
    for (let i = 0; i < U; i++) {
      const u = (i / U) * TAU, row = [];
      for (let j = 0; j < V; j++) {
        const v = (j / V) * TAU;
        const q = rotXYZ([(Rr + r * Math.cos(v)) * Math.cos(u), (Rr + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)], ph, ph * 2, 0);
        row.push([w / 2 + (q[0] * F) / (q[2] + D), h * 0.47 + (q[1] * F) / (q[2] + D), q[2]]);
      }
      P.push(row);
    }
    const buckets = [[], [], [], []];
    const add = (a, b) => {
      const z = (a[2] + b[2]) / 2;
      buckets[clamp(Math.floor(((z + 1.42) / 2.84) * 4), 0, 3)].push(a, b);
    };
    for (let i = 0; i < U; i++) for (let j = 0; j < V; j++) {
      add(P[i][j], P[(i + 1) % U][j]);
      add(P[i][j], P[i][(j + 1) % V]);
    }
    g.lineWidth = Math.max(1, h * 0.004);
    buckets.forEach((segs, k) => {
      g.strokeStyle = `rgba(207,224,255,${[0.95, 0.65, 0.38, 0.18][k]})`;
      g.beginPath();
      for (let n = 0; n < segs.length; n += 2) {
        g.moveTo(segs[n][0], segs[n][1]);
        g.lineTo(segs[n + 1][0], segs[n + 1][1]);
      }
      g.stroke();
    });
    font(g, h * 0.045, 'mono', 500);
    g.fillStyle = 'rgba(207,224,255,.55)';
    g.fillText(`TORUS  V:${U * V}  E:${U * V * 2}`, w * 0.04, h * 0.94);
  };

  R.parallax = (g, w, h, t) => {
    const p = t / 8;
    g.fillStyle = vgrad(g, h, ['#28307A', '#7B4F9E', '#F49A7C', '#FFD3A5']);
    g.fillRect(0, 0, w, h);
    circle(g, w * 0.3, h * 0.46, h * 0.11);
    g.fillStyle = '#FFE9B8';
    g.fill();
    for (let k = 0; k < 3; k++) {
      const x = ((k * 0.31 + p) % 1) * w * 1.2 - w * 0.1, y = h * (0.2 + k * 0.06), flap = Math.sin(t * TAU * 2 + k) * h * 0.012;
      g.strokeStyle = '#3B2A5C';
      g.lineWidth = Math.max(1, h * 0.006);
      g.beginPath();
      g.moveTo(x - h * 0.025, y - flap);
      g.lineTo(x, y);
      g.lineTo(x + h * 0.025, y - flap);
      g.stroke();
    }
    const layers = [
      { base: 0.52, amp: 0.07, col: '#B07DB0', sp: 1 },
      { base: 0.62, amp: 0.08, col: '#80568F', sp: 2 },
      { base: 0.73, amp: 0.07, col: '#53386F', sp: 3 },
      { base: 0.86, amp: 0.06, col: '#2B1D45', sp: 4 },
    ];
    layers.forEach((L, k) => {
      g.beginPath();
      g.moveTo(0, h);
      for (let x = 0; x <= w + 1; x += w / 90) {
        const u = (x / w - p * L.sp) * TAU;
        g.lineTo(x, h * (L.base - L.amp * (0.6 * Math.sin(u + k * 1.7) + 0.3 * Math.sin(u * 3 + k) + 0.15 * Math.sin(u * 7 + k * 2.3))));
      }
      g.lineTo(w, h);
      g.closePath();
      g.fillStyle = L.col;
      g.fill();
    });
  };

  R['infinite-zoom'] = (g, w, h, t) => {
    const pal = ['#FF5F5D', '#3F7CAC', '#FFD166', '#06D6A0'];
    const k0 = t / 4, z = Math.pow(2, 2 * k0), diag = Math.hypot(w, h), S = diag * 0.5;
    g.translate(w / 2, h / 2);
    g.rotate((k0 * Math.PI) / 2);
    for (let k = -8; k < 48; k++) {
      const size = S * z * Math.pow(Math.SQRT1_2, k);
      if (size > diag * 2.2) continue;
      if (size < 1) break;
      g.save();
      g.rotate((k * Math.PI) / 4);
      g.fillStyle = pal[((k % 4) + 4) % 4];
      g.fillRect(-size / 2, -size / 2, size, size);
      g.restore();
    }
  };

  /* ======================================================================
     Retro
     ====================================================================== */

  R.synthwave = (g, w, h, t) => {
    const hz = h * 0.6;
    const sky = vgrad(g, hz, ['#0D0221', '#3B0F6B', '#B21F7A', '#FF6A7A']);
    g.fillStyle = sky;
    g.fillRect(0, 0, w, hz);
    for (let i = 0; i < 40; i++) {
      g.globalAlpha = 0.3 + 0.5 * (0.5 + 0.5 * Math.sin((t / 2) * TAU + i));
      g.fillStyle = '#FFFFFF';
      g.fillRect(hash(i) * w, hash(i + 40) * hz * 0.5, Math.max(1, h * 0.004), Math.max(1, h * 0.004));
    }
    g.globalAlpha = 1;
    const sr = h * 0.25, sx = w / 2, sy = hz - h * 0.03;
    g.save();
    circle(g, sx, sy, sr);
    g.clip();
    const sg = g.createLinearGradient(0, sy - sr, 0, sy + sr);
    sg.addColorStop(0, '#FFE66D');
    sg.addColorStop(0.55, '#FF8E53');
    sg.addColorStop(1, '#FF2E88');
    g.fillStyle = sg;
    g.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
    g.fillStyle = sky;
    const off = (t / 4) % 1;
    for (let k = 0; k < 7; k++) {
      const yy = sy - sr * 0.05 + (k + off) * sr * 0.17;
      g.fillRect(sx - sr, yy, sr * 2, sr * 0.022 * (k + off + 0.6));
    }
    g.restore();
    g.fillStyle = '#1B0638';
    g.beginPath();
    g.moveTo(0, hz);
    for (let x = 0; x <= w + 1; x += w / 40) {
      const m = Math.abs(Math.sin((x / w) * 7.3)) * 0.6 + Math.abs(Math.sin((x / w) * 17.1)) * 0.4;
      g.lineTo(x, hz - h * (0.02 + 0.07 * m * (Math.abs(x - w / 2) > w * 0.22 ? 1 : 0.25)));
    }
    g.lineTo(w, hz);
    g.closePath();
    g.fill();
    g.fillStyle = vgrad(g, h, ['#1A0533', '#05010F'], hz);
    g.fillRect(0, hz, w, h - hz);
    g.save();
    g.beginPath();
    g.rect(0, hz, w, h - hz);
    g.clip();
    g.strokeStyle = '#FF3CAC';
    g.lineWidth = Math.max(1, h * 0.006);
    g.shadowColor = '#FF3CAC';
    g.shadowBlur = h * 0.025;
    g.beginPath();
    for (let i = -14; i <= 14; i++) {
      g.moveTo(w / 2 + i * w * 0.012, hz);
      g.lineTo(w / 2 + i * w * 0.16, h);
    }
    const ph = ((t / 4) * 4) % 1;
    for (let k = 0; k < 16; k++) {
      const zz = k + 1 - ph;
      const y = hz + ((h - hz) * 0.9) / zz;
      if (y > h + 2) continue;
      g.moveTo(0, y);
      g.lineTo(w, y);
    }
    g.stroke();
    g.restore();
    g.fillStyle = '#FF9BD2';
    g.fillRect(0, hz - 1, w, Math.max(1, h * 0.004));
  };

  R.vaporwave = (g, w, h, t) => {
    const ph = (t / 6) * TAU, hz = h * 0.6, s = h / 100;
    g.fillStyle = vgrad(g, hz, ['#FF9ED2', '#FFC4E1', '#A0E7FF']);
    g.fillRect(0, 0, w, hz);
    const sg = g.createLinearGradient(0, h * 0.15, 0, h * 0.45);
    sg.addColorStop(0, '#FFF6A9');
    sg.addColorStop(1, '#FF8DC7');
    circle(g, w * 0.22, h * 0.3, h * 0.15);
    g.fillStyle = sg;
    g.fill();
    g.save();
    g.beginPath();
    g.rect(0, hz, w, h - hz);
    g.clip();
    g.fillStyle = '#2E1A47';
    g.fillRect(0, hz, w, h - hz);
    const F = (h - hz) * 0.5, scroll = (t / 6) * 2, fr = scroll % 1, base = Math.floor(scroll);
    const P = (x, z) => [w / 2 + (x * F * 1.6) / z, hz + F / z];
    g.fillStyle = '#C77DFF';
    for (let n = 0; n < 22; n++) {
      let zA = n - fr, zB = zA + 1;
      if (zB < 0.3) continue;
      zA = Math.max(zA, 0.3);
      for (let i = -14; i < 14; i++) {
        if ((n + i + base) & 1) continue;
        poly(g, [P(i, zA), P(i + 1, zA), P(i + 1, zB), P(i, zB)]);
        g.fill();
      }
    }
    g.restore();
    g.fillStyle = 'rgba(255,255,255,.8)';
    g.fillRect(0, hz - 1, w, Math.max(1, h * 0.004));
    // rotating wire pyramid
    const pv = [[-1, 0.6, -1], [1, 0.6, -1], [1, 0.6, 1], [-1, 0.6, 1], [0, -1, 0]].map((v) => rotXYZ(v, 0.25, ph, 0));
    const pp = pv.map((v) => [w * 0.16 + v[0] * h * 0.09, h * 0.7 + v[1] * h * 0.09]);
    g.strokeStyle = '#FFFFFF';
    g.lineWidth = Math.max(1, h * 0.006);
    g.beginPath();
    [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 4], [2, 4], [3, 4]].forEach(([a, b]) => {
      g.moveTo(pp[a][0], pp[a][1]);
      g.lineTo(pp[b][0], pp[b][1]);
    });
    g.stroke();
    // Windows 95 style window (RTL: title on the right, buttons on the left)
    const wx = w * 0.42, wy = h * 0.18 + Math.sin(ph) * h * 0.03, ww = w * 0.46, wh = h * 0.4, b = Math.max(1, s * 0.6);
    g.fillStyle = '#C3C3C3';
    g.fillRect(wx, wy, ww, wh);
    g.fillStyle = '#FFFFFF';
    g.fillRect(wx, wy, ww, b);
    g.fillRect(wx, wy, b, wh);
    g.fillStyle = '#404040';
    g.fillRect(wx, wy + wh - b, ww, b);
    g.fillRect(wx + ww - b, wy, b, wh);
    const tg = g.createLinearGradient(wx + ww, 0, wx, 0);
    tg.addColorStop(0, '#000080');
    tg.addColorStop(1, '#1084D0');
    g.fillStyle = tg;
    g.fillRect(wx + 3 * b, wy + 3 * b, ww - 6 * b, h * 0.07);
    font(g, h * 0.045, 'sans', 600);
    g.fillStyle = '#FFFFFF';
    g.direction = 'rtl';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.fillText('ויפורווייב', wx + ww - 6 * b, wy + 3 * b + h * 0.035);
    for (let k = 0; k < 3; k++) {
      const bx = wx + 5 * b + k * h * 0.055;
      g.fillStyle = '#C3C3C3';
      g.fillRect(bx, wy + 5 * b, h * 0.045, h * 0.045);
      g.fillStyle = '#404040';
      g.fillRect(bx + h * 0.012, wy + 5 * b + h * 0.03, h * 0.02, Math.max(1, b));
    }
    font(g, h * 0.05, 'sans', 500);
    g.fillStyle = '#111';
    g.fillText('טוען אסתטיקה…', wx + ww - 8 * b, wy + h * 0.17);
    const bx0 = wx + 8 * b, bw0 = ww - 16 * b, by0 = wy + h * 0.24, bh0 = h * 0.07;
    g.fillStyle = '#FFFFFF';
    g.fillRect(bx0, by0, bw0, bh0);
    g.fillStyle = '#808080';
    g.fillRect(bx0, by0, bw0, b);
    g.fillRect(bx0, by0, b, bh0);
    const n = Math.floor(((t / 6) * 1.25 % 1) * 17), cell = (bw0 - 4 * b) / 16;
    g.fillStyle = '#000080';
    for (let k = 0; k < Math.min(16, n); k++) g.fillRect(bx0 + bw0 - 2 * b - (k + 1) * cell + b, by0 + 3 * b, cell - 2 * b, bh0 - 6 * b);
  };

  const HERO = [
    ['...RRRR.', '..RRRRRR', '..HHSSK.', '.HSSSSS.', '..BBRB..', '.SBBBBS.', '..BB.BB.', '.KK...KK'],
    ['...RRRR.', '..RRRRRR', '..HHSSK.', '.HSSSSS.', '..BBRB..', '.SBBBBS.', '...BBB..', '...KKK..'],
  ];
  const HERO_COL = { R: '#E52521', H: '#6B3A1E', S: '#FFC890', K: '#1A1A1A', B: '#2038EC' };

  R['pixel-art'] = (g, w, h, t, s) => {
    const W = 64, H = 36, b = buf(s, 'px', W, H), q = b.g;
    q.fillStyle = '#5C94FC';
    q.fillRect(0, 0, W, H);
    q.fillStyle = '#FFFFFF';
    for (let k = 0; k < 2; k++) {
      const x = Math.round(80 - ((t * 20 + k * 40) % 80)) - 12, y = 4 + k * 5;
      q.fillRect(x + 2, y, 6, 1);
      q.fillRect(x + 1, y + 1, 9, 1);
      q.fillRect(x, y + 2, 12, 2);
    }
    q.fillStyle = '#2E9E3C';
    for (let x = 0; x < W; x++) {
      const hh = Math.round(5 * Math.abs(Math.sin((((x + Math.floor(t * 8)) % 32) / 32) * Math.PI)));
      q.fillRect(x, 28 - hh, 1, hh);
    }
    const scroll = Math.floor(t * 24);
    for (let y = 28; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (y === 28) q.fillStyle = '#58D854';
        else {
          const r = y - 29, mortar = r % 4 === 3 || (x + scroll + ((r >> 2) & 1) * 4) % 8 === 0;
          q.fillStyle = mortar ? '#7A2E05' : '#C84C0C';
        }
        q.fillRect(x, y, 1, 1);
      }
    }
    const spin = [4, 2, 1, 2][Math.floor(t * 8) % 4];
    for (let k = 0; k < 8; k++) {
      const x = ((((k * 12 - t * 24) % 96) + 96) % 96) - 8;
      q.fillStyle = '#FCBC3C';
      q.fillRect(Math.round(x + (4 - spin) / 2), 12, spin, 5);
    }
    const px = Math.round(72 - ((t * 24) % 96));
    q.fillStyle = '#00A800';
    q.fillRect(px, 20, 8, 8);
    q.fillRect(px - 1, 18, 10, 3);
    q.fillStyle = '#B8F818';
    q.fillRect(px + 1, 21, 1, 7);
    q.fillRect(px, 19, 1, 1);
    let hy = 20;
    const jp = seg(t, 1.5, 2.6);
    if (jp > 0 && jp < 1) hy -= Math.round(16 * 4 * jp * (1 - jp));
    const spr = HERO[jp > 0 && jp < 1 ? 1 : Math.floor(t * 10) % 2];
    for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) {
      const c = spr[yy][xx];
      if (c === '.') continue;
      q.fillStyle = HERO_COL[c];
      q.fillRect(20 + xx, hy + yy, 1, 1);
    }
    g.imageSmoothingEnabled = false;
    g.drawImage(b.c, 0, 0, w, h);
    font(g, h * 0.055, 'mono', 500);
    g.fillStyle = '#FFFFFF';
    g.textBaseline = 'top';
    g.fillText('SCORE 005500', w * 0.04, h * 0.04);
    g.textAlign = 'right';
    g.fillText('×' + String(Math.floor(t * 2) + 3).padStart(2, '0'), w * 0.96, h * 0.04);
  };

  R.vhs = (g, w, h, t, s) => {
    const b = buf(s, 'vhs', w, h), q = b.g;
    q.fillStyle = vgrad(q, h * 0.62, ['#2B1055', '#D53A9D', '#FFA770']);
    q.fillRect(0, 0, w, h * 0.62);
    circle(q, w * 0.55, h * 0.58, h * 0.16);
    q.fillStyle = '#FFE29A';
    q.fill();
    q.fillStyle = vgrad(q, h, ['#3A1C71', '#0F0C29'], h * 0.62);
    q.fillRect(0, h * 0.62, w, h * 0.38);
    q.fillStyle = 'rgba(255,226,154,.55)';
    for (let k = 0; k < 7; k++) {
      const ww = h * (0.22 - k * 0.025) * (0.8 + 0.2 * Math.sin(t * 6 + k));
      q.fillRect(w * 0.55 - ww / 2, h * (0.65 + k * 0.045), ww, h * 0.012);
    }
    q.strokeStyle = '#120722';
    q.fillStyle = '#120722';
    q.lineCap = 'round';
    q.lineWidth = h * 0.03;
    const top = [w * 0.2, h * 0.3];
    q.beginPath();
    q.moveTo(w * 0.14, h);
    q.quadraticCurveTo(w * 0.15, h * 0.6, top[0], top[1]);
    q.stroke();
    q.lineWidth = h * 0.02;
    for (let k = 0; k < 6; k++) {
      const a = -Math.PI * 0.95 + k * 0.42 + Math.sin(t * 2 + k) * 0.04, L = h * 0.2;
      q.beginPath();
      q.moveTo(top[0], top[1]);
      q.quadraticCurveTo(top[0] + Math.cos(a) * L * 0.6, top[1] + Math.sin(a) * L * 0.6 - h * 0.05, top[0] + Math.cos(a) * L, top[1] + Math.sin(a) * L + h * 0.06);
      q.stroke();
    }
    bg(g, w, h, '#000');
    const band = (((t / 6) * 1.7) % 1) * h * 1.3 - h * 0.15, bandH = h * 0.08, fr = Math.floor(t * 30);
    const sl = Math.max(2, Math.round(h / 90));
    for (let y = 0; y < h; y += sl) {
      let dx = Math.sin(y * 0.05 + t * 9) * h * 0.003;
      if (y > band && y < band + bandH) dx += (hash2(y, fr) - 0.5) * h * 0.06;
      g.drawImage(b.c, 0, y, w, Math.min(sl, h - y), dx, y, w, Math.min(sl, h - y));
    }
    g.fillStyle = 'rgba(255,255,255,.5)';
    for (let k = 0; k < 60; k++) g.fillRect(hash2(k, fr) * w, band + hash2(k + 7, fr) * bandH, h * 0.02 * hash2(k + 3, fr), Math.max(1, h * 0.004));
    g.fillStyle = 'rgba(0,0,0,.2)';
    const ls = Math.max(1, Math.round(h / 180));
    for (let y = 0; y < h; y += ls * 3) g.fillRect(0, y, w, ls);
    const osd = (str, x, y, align) => {
      font(g, h * 0.07, 'mono', 500);
      g.textAlign = align;
      g.textBaseline = 'top';
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = 'rgba(255,0,60,.7)';
      g.fillText(str, x - h * 0.006, y);
      g.fillStyle = 'rgba(0,200,255,.7)';
      g.fillText(str, x + h * 0.006, y);
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = '#F4F4F4';
      g.fillText(str, x, y);
    };
    osd('PLAY ▶', w * 0.06, h * 0.07, 'left');
    osd(`SP 0:00:${String(Math.floor(t) + 12).padStart(2, '0')}`, w * 0.06, h * 0.84, 'left');
    osd('OCT. 03 1996', w * 0.94, h * 0.84, 'right');
  };

  R['film-noir'] = (g, w, h, t) => {
    const fr = Math.floor(t * 24);
    const lg = g.createRadialGradient(w * 0.35, h * 0.4, 0, w * 0.35, h * 0.4, w * 0.8);
    lg.addColorStop(0, '#3C3C3C');
    lg.addColorStop(1, '#0E0E0E');
    g.fillStyle = lg;
    g.fillRect(0, 0, w, h);
    g.save();
    g.translate(w * 0.12 + Math.sin((t / 6) * TAU) * w * 0.01, 0);
    g.transform(1, 0, -0.45, 1, 0, 0);
    g.fillStyle = 'rgba(235,235,225,.2)';
    for (let k = 0; k < 9; k++) g.fillRect(w * 0.05, h * (0.08 + k * 0.095), w * 0.55, h * 0.05);
    g.restore();
    const mx = w * 0.7;
    g.fillStyle = '#050505';
    g.beginPath();
    g.ellipse(mx, h * 1.03, h * 0.3, h * 0.24, 0, Math.PI, TAU);
    g.fill();
    g.fillRect(mx - h * 0.045, h * 0.62, h * 0.09, h * 0.2);
    g.beginPath();
    g.ellipse(mx, h * 0.56, h * 0.085, h * 0.11, 0, 0, TAU);
    g.fill();
    g.beginPath();
    g.ellipse(mx, h * 0.47, h * 0.17, h * 0.03, -0.05, 0, TAU);
    g.fill();
    rrect(g, mx - h * 0.09, h * 0.33, h * 0.18, h * 0.15, h * 0.03);
    g.fill();
    const ex = mx - h * 0.12, ey = h * 0.66;
    g.strokeStyle = '#DDD';
    g.lineWidth = h * 0.008;
    g.beginPath();
    g.moveTo(mx - h * 0.06, h * 0.655);
    g.lineTo(ex, ey);
    g.stroke();
    circle(g, ex, ey, h * 0.007);
    g.fillStyle = `rgba(255,170,90,${0.7 + 0.3 * hash(fr)})`;
    g.fill();
    for (let i = 0; i < 16; i++) {
      const life = ((t / 6) * 3 + i / 16) % 1;
      const x = ex - life * h * 0.06 + Math.sin(life * 7 + i) * h * 0.035 * life;
      circle(g, x, ey - life * h * 0.5, h * (0.01 + life * 0.05));
      g.fillStyle = `rgba(210,210,210,${(1 - life) * 0.14})`;
      g.fill();
    }
    g.fillStyle = `rgba(0,0,0,${0.04 + hash(fr) * 0.08})`;
    g.fillRect(0, 0, w, h);
    const gs = Math.max(1, h * 0.004);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = hash2(i + 31, fr) > 0.5 ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.25)';
      g.fillRect(hash2(i, fr) * w, hash2(i + 999, fr) * h, gs, gs);
    }
    if (hash(fr * 1.7) > 0.72) {
      g.strokeStyle = 'rgba(230,230,230,.35)';
      g.lineWidth = Math.max(1, h * 0.002);
      const x = hash(fr * 3.3) * w;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + (hash(fr) - 0.5) * h * 0.02, h);
      g.stroke();
    }
    const vg = g.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, w * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,.8)');
    g.fillStyle = vg;
    g.fillRect(0, 0, w, h);
  };

  R['pop-art'] = (g, w, h, t) => {
    bg(g, w, h, '#FFE14D');
    const step = h * 0.065, cx = w / 2, cy = h / 2;
    g.fillStyle = '#FF3B6B';
    g.beginPath();
    for (let j = 0, y = step / 2; y < h + step; y += step * 0.87, j++) {
      for (let x = (j % 2) * (step / 2); x < w + step; x += step) {
        const d = Math.hypot(x - cx, y - cy) / h;
        const r = step * 0.46 * clamp(0.15 + 0.85 * (0.5 + 0.5 * Math.sin(d * 9 - (t / 4) * TAU * 2)));
        g.moveTo(x + r, y);
        g.arc(x, y, r, 0, TAU);
      }
    }
    g.fill();
    const lt = t % 2, pop = E.back(seg(lt, 0.05, 0.4)), R0 = h * 0.4 * pop * (1 + 0.025 * Math.sin(t * 30));
    if (R0 > 1) {
      const pts = [];
      for (let k = 0; k < 32; k++) {
        const a = (k / 32) * TAU + 0.1, rr = k % 2 ? R0 * 0.66 : R0 * (0.95 + 0.1 * hash(k));
        pts.push([cx + Math.cos(a) * rr * 1.3, cy + Math.sin(a) * rr]);
      }
      g.fillStyle = '#FFFFFF';
      g.strokeStyle = '#111';
      g.lineWidth = h * 0.014;
      poly(g, pts);
      g.fill();
      g.stroke();
    }
    const tp = Math.max(0.001, E.back(seg(lt, 0.15, 0.45)));
    g.save();
    g.translate(cx, cy + h * 0.02);
    g.rotate(-0.08);
    g.scale(tp, tp);
    font(g, h * 0.3);
    g.direction = 'rtl';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.fillStyle = '#111';
    g.fillText('בום!', h * 0.02, h * 0.025);
    g.lineWidth = h * 0.02;
    g.strokeStyle = '#111';
    g.strokeText('בום!', 0, 0);
    g.fillStyle = '#1F5EFF';
    g.fillText('בום!', 0, 0);
    g.restore();
    g.lineWidth = h * 0.03;
    g.strokeStyle = '#111';
    g.strokeRect(h * 0.015, h * 0.015, w - h * 0.03, h - h * 0.03);
  };

  R.memphis = (g, w, h, t) => {
    const ph = (t / 6) * TAU, s = h / 100;
    bg(g, w, h, '#FFF3E2');
    const shapes = {
      zig: (c) => {
        const pts = [];
        for (let k = 0; k <= 6; k++) pts.push([-15 * s + k * 5 * s, k % 2 ? -4 * s : 4 * s]);
        g.strokeStyle = c; g.lineWidth = 2.6 * s; g.lineJoin = 'round'; g.lineCap = 'round';
        poly(g, pts, false); g.stroke();
      },
      tri: (c) => { g.fillStyle = c; poly(g, [[0, -11 * s], [10 * s, 7 * s], [-10 * s, 7 * s]]); g.fill(); },
      circle: (c, ink) => {
        circle(g, 0, 0, 12 * s); g.fillStyle = c; g.fill();
        if (!ink) { g.strokeStyle = '#1B1B1B'; g.lineWidth = 0.8 * s; g.stroke(); }
      },
      half: (c) => { g.fillStyle = c; g.beginPath(); g.arc(0, 0, 9 * s, Math.PI, TAU); g.closePath(); g.fill(); },
      ring: (c) => { g.strokeStyle = c; g.lineWidth = 2.6 * s; circle(g, 0, 0, 7 * s); g.stroke(); },
      stripes: (c, ink) => {
        g.save(); g.beginPath(); g.rect(-10 * s, -7 * s, 20 * s, 14 * s); g.clip();
        g.fillStyle = ink ? c : '#FFFFFF'; g.fillRect(-10 * s, -7 * s, 20 * s, 14 * s);
        if (!ink) {
          g.strokeStyle = c; g.lineWidth = 1.4 * s; g.beginPath();
          for (let k = -6; k < 8; k++) { g.moveTo(k * 3 * s - 10 * s, 8 * s); g.lineTo(k * 3 * s + 4 * s, -8 * s); }
          g.stroke();
        }
        g.restore();
        if (!ink) { g.strokeStyle = '#1B1B1B'; g.lineWidth = 0.8 * s; g.strokeRect(-10 * s, -7 * s, 20 * s, 14 * s); }
      },
      squig: (c) => {
        g.strokeStyle = c; g.lineWidth = 1.6 * s; g.lineCap = 'round'; g.beginPath();
        for (let k = 0; k <= 30; k++) { const x = -15 * s + k * s, y = Math.sin(k * 0.6) * 3 * s; k ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.stroke();
      },
    };
    g.fillStyle = '#845EC2';
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) { circle(g, w * 0.24 + i * 3.6 * s, h * 0.68 + j * 3.6 * s, 1.2 * s); g.fill(); }
    const items = [
      [0.14, 0.26, 'zig', '#FF6F91', 1], [0.84, 0.24, 'tri', '#00C9A7', -1], [0.5, 0.5, 'circle', '#FFC75F', 0],
      [0.72, 0.74, 'half', '#FF6F91', 1], [0.92, 0.6, 'ring', '#845EC2', 0], [0.12, 0.62, 'stripes', '#00C9A7', -1],
      [0.55, 0.16, 'squig', '#1B1B1B', 0], [0.36, 0.36, 'tri', '#845EC2', 1], [0.32, 0.86, 'zig', '#00C9A7', -1],
    ];
    items.forEach(([x, y, type, col, rot], i) => {
      const draw = (ink) => {
        g.save();
        g.translate(w * x, h * y + Math.sin(ph + i) * 3 * s);
        g.rotate(rot * ph + i);
        if (type === 'circle') g.scale(1 + 0.06 * Math.sin(ph * 2), 1 + 0.06 * Math.sin(ph * 2));
        shapes[type](ink ? '#1B1B1B' : col, ink);
        g.restore();
      };
      if (type !== 'squig') {
        g.save();
        g.translate(1.2 * s, 1.2 * s);
        draw(true);
        g.restore();
      }
      draw(false);
    });
  };

  /* ======================================================================
     Abstract & geometric
     ====================================================================== */

  R['shape-anim'] = (g, w, h, t) => {
    bg(g, w, h, '#1F2041');
    const pal = ['#FF6B6B', '#FFD93D', '#6BCB77', '#4D96FF'];
    const cell = h * 0.24, cx = w / 2, cy = h / 2, A = E.inOut(seg(t, 2.6, 3.6)) * (Math.PI / 2);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const k = i * 3 + j, d = Math.hypot(i - 1, j - 1);
      const pin = E.back(seg(t, 0.2 + d * 0.22, 0.75 + d * 0.22));
      const pout = E.in(seg(t, 4.7 + (2.83 - d) * 0.15, 5.3 + (2.83 - d) * 0.15));
      const sc = pin * (1 - pout);
      if (sc <= 0.001) continue;
      const x = (j - 1) * cell * 1.15, y = (i - 1) * cell * 1.15;
      const spin = E.inOut(seg(t, 1.4 + k * 0.05, 2.3 + k * 0.05));
      g.save();
      g.translate(cx + x * Math.cos(A) - y * Math.sin(A), cy + x * Math.sin(A) + y * Math.cos(A));
      g.scale(sc, sc);
      g.fillStyle = pal[k % 4];
      const r = cell * 0.4, type = k % 3;
      if (type === 0) { g.rotate((spin * Math.PI) / 2); g.fillRect(-r, -r, 2 * r, 2 * r); }
      else if (type === 1) { circle(g, 0, 0, r * (1 + 0.25 * Math.sin(spin * Math.PI))); g.fill(); }
      else { g.rotate((spin * TAU) / 3); poly(g, [[0, -r * 1.15], [r, r * 0.6], [-r, r * 0.6]]); g.fill(); }
      g.restore();
    }
  };

  function rayHit(verts, a) {
    const dx = Math.cos(a), dy = Math.sin(a);
    let best = Infinity;
    for (let i = 0; i < verts.length; i++) {
      const [x1, y1] = verts[i], [x2, y2] = verts[(i + 1) % verts.length];
      const ex = x2 - x1, ey = y2 - y1, den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const tt = (x1 * ey - y1 * ex) / den, u = (x1 * dy - y1 * dx) / den;
      if (tt > 0 && u >= -1e-6 && u <= 1 + 1e-6 && tt < best) best = tt;
    }
    return best === Infinity ? 1 : best;
  }
  const MORPH = (() => {
    const N = 180;
    const radial = (verts) => Float32Array.from({ length: N }, (_, k) => rayHit(verts, (k / N) * TAU));
    const ngon = (n, r, a0) => Array.from({ length: n }, (_, k) => [Math.cos(a0 + (k * TAU) / n) * r, Math.sin(a0 + (k * TAU) / n) * r]);
    const star = Array.from({ length: 10 }, (_, k) => {
      const r = k % 2 ? 0.52 : 1.28, a = -Math.PI / 2 + (k * Math.PI) / 5;
      return [Math.cos(a) * r, Math.sin(a) * r];
    });
    return {
      N,
      shapes: [new Float32Array(N).fill(1), radial(ngon(4, 1.18, Math.PI / 4)), radial(ngon(3, 1.32, -Math.PI / 2)), radial(star)],
      cols: ['#FF477E', '#FFBE0B', '#3A86FF', '#8338EC'].map(hexRgb),
    };
  })();

  R.morphing = (g, w, h, t) => {
    bg(g, w, h, '#F1F0F6');
    const shapeAt = (tt) => {
      tt = ((tt % 8) + 8) % 8;
      const i = Math.floor(tt / 2), e = E.inOut(seg(tt - i * 2, 0.7, 2));
      const A = MORPH.shapes[i], B = MORPH.shapes[(i + 1) % 4];
      return { A, B, e, col: mixRgb(MORPH.cols[i], MORPH.cols[(i + 1) % 4], e), rot: (tt / 8) * TAU };
    };
    const path = (st, R0) => {
      g.beginPath();
      for (let k = 0; k <= MORPH.N; k++) {
        const kk = k % MORPH.N, a = (kk / MORPH.N) * TAU + st.rot, r = lerp(st.A[kk], st.B[kk], st.e) * R0;
        const x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r;
        k ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
    };
    const R0 = h * 0.28;
    for (let j = 3; j >= 1; j--) {
      const st = shapeAt(t - j * 0.07);
      path(st, R0);
      g.strokeStyle = rgb(st.col);
      g.globalAlpha = 0.12 * (4 - j);
      g.lineWidth = Math.max(1, h * 0.006);
      g.stroke();
    }
    g.globalAlpha = 1;
    const st = shapeAt(t);
    path(st, R0);
    g.fillStyle = rgb(st.col);
    g.fill();
  };

  R.bauhaus = (g, w, h, t) => {
    bg(g, w, h, '#EFE6D2');
    const cols = 4, rows = 2, size = Math.min((w * 0.9) / cols, (h * 0.86) / rows);
    const ox = (w - size * cols) / 2, oy = (h - size * rows) / 2;
    const Rd = '#D7372F', Y = '#F2B714', B = '#1F3A93', K = '#151515', C = '#EFE6D2';
    const tiles = [
      [B, Y, 'quarter'], [Rd, C, 'half'], [K, Rd, 'circle'], [Y, B, 'tri'],
      [C, K, 'quarter2'], [Y, Rd, 'ring'], [B, C, 'half'], [Rd, K, 'quarter'],
    ];
    const stepI = Math.floor(t / 2), lt = t - stepI * 2;
    tiles.forEach(([bgc, fg, type], k) => {
      const i = k % cols, j = Math.floor(k / cols), s2 = size / 2;
      const delay = (i + j) * 0.12 + (k % 3) * 0.05, dir = k % 2 ? 1 : -1;
      const ang = (stepI + E.inOut(seg(lt, 0.3 + delay, 1.1 + delay))) * (Math.PI / 2) * dir;
      g.save();
      g.translate(ox + i * size + s2, oy + j * size + s2);
      g.beginPath();
      g.rect(-s2, -s2, size, size);
      g.clip();
      g.fillStyle = bgc;
      g.fillRect(-s2, -s2, size, size);
      g.rotate(ang);
      g.fillStyle = fg;
      if (type === 'quarter') { g.beginPath(); g.moveTo(-s2, -s2); g.arc(-s2, -s2, size, 0, Math.PI / 2); g.closePath(); g.fill(); }
      else if (type === 'quarter2') {
        g.beginPath(); g.moveTo(-s2, -s2); g.arc(-s2, -s2, s2, 0, Math.PI / 2); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(s2, s2); g.arc(s2, s2, s2, Math.PI, Math.PI * 1.5); g.closePath(); g.fill();
      } else if (type === 'half') { g.beginPath(); g.arc(0, s2, s2, Math.PI, TAU); g.closePath(); g.fill(); }
      else if (type === 'circle') { circle(g, 0, 0, s2 * 0.7); g.fill(); g.fillStyle = Y; circle(g, s2 * 0.35, -s2 * 0.35, s2 * 0.2); g.fill(); }
      else if (type === 'tri') { poly(g, [[-s2, s2], [s2, s2], [-s2, -s2]]); g.fill(); }
      else if (type === 'ring') { circle(g, 0, 0, s2 * 0.75); g.fill(); g.fillStyle = bgc; circle(g, 0, 0, s2 * 0.38); g.fill(); }
      g.restore();
    });
  };

  R.liquid = (g, w, h, t, s) => {
    const W = clamp(Math.round(w / 4), 96, 240), H = Math.round((W * h) / w), b = buf(s, 'liq', W, H);
    if (!b.img || b.img.width !== W || b.img.height !== H) b.img = b.g.createImageData(W, H);
    const d = b.img.data, ph = (t / 6) * TAU, n = 7, bx = new Float32Array(n), by = new Float32Array(n), br = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      bx[k] = W * (0.5 + 0.32 * Math.sin(ph * (1 + (k % 3)) + k * 1.9));
      by[k] = H * (0.5 + 0.3 * Math.sin(ph * (1 + ((k + 1) % 2)) + k * 2.7));
      br[k] = Math.pow(H * (0.095 + 0.03 * (k % 3)), 2);
    }
    const c1 = [0, 245, 212], c2 = [155, 93, 229], bk = [20, 8, 46];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let f = 0;
        for (let k = 0; k < n; k++) {
          const dx = x - bx[k], dy = y - by[k];
          f += br[k] / (dx * dx + dy * dy + 1);
        }
        const a = clamp((f - 1) * 3), rim = clamp(1 - (f - 1) * 1.4) * a * 70, m = (x / W) * 0.6 + (y / H) * 0.4;
        const i4 = (y * W + x) * 4;
        d[i4] = lerp(bk[0], Math.min(255, lerp(c1[0], c2[0], m) + rim), a);
        d[i4 + 1] = lerp(bk[1], Math.min(255, lerp(c1[1], c2[1], m) + rim), a);
        d[i4 + 2] = lerp(bk[2], Math.min(255, lerp(c1[2], c2[2], m) + rim), a);
        d[i4 + 3] = 255;
      }
    }
    b.g.putImageData(b.img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(b.c, 0, 0, w, h);
  };

  R.particles = (g, w, h, t) => {
    bg(g, w, h, '#05060F');
    const ph = (t / 6) * TAU, cx = w / 2, cy = h / 2;
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, h * 0.5);
    glow.addColorStop(0, 'rgba(120,90,255,.35)');
    glow.addColorStop(1, 'rgba(120,90,255,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    const cols = ['rgba(255,205,130,.9)', 'rgba(150,175,255,.8)', 'rgba(110,235,255,.65)'];
    for (let band = 0; band < 3; band++) {
      g.strokeStyle = cols[band];
      g.lineWidth = Math.max(1, h * (0.008 - band * 0.0015));
      g.beginPath();
      for (let i = 0; i < 360; i++) {
        const rr = 0.05 + Math.pow(hash(i * 1.3), 0.8) * 0.95;
        if ((rr < 0.35 ? 0 : rr < 0.68 ? 1 : 2) !== band) continue;
        const k = 3 - band, a0 = (i % 2) * Math.PI + rr * 5 + (hash(i * 7.7) - 0.5) * 0.7;
        const Rr = rr * h * 0.62 * (1 + 0.05 * Math.sin(ph * 2 + i));
        const a = a0 + ph * k, ap = a - 0.12;
        g.moveTo(cx + Math.cos(ap) * Rr * 1.35, cy + Math.sin(ap) * Rr * 0.7);
        g.lineTo(cx + Math.cos(a) * Rr * 1.35, cy + Math.sin(a) * Rr * 0.7);
      }
      g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
  };

  R.generative = (g, w, h, t) => {
    bg(g, w, h, '#F6F1E7');
    const ph = (t / 10) * TAU, ox = Math.cos(ph) * 0.8, oy = Math.sin(ph) * 0.8;
    const pal = ['#264653', '#2A9D8F', '#E9C46A', '#F4A261', '#E76F51'];
    const f = 2.2 / h, stepL = h * 0.014;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let i = 0; i < 150; i++) {
      let x = hash(i * 1.17) * w, y = hash(i * 2.31 + 4) * h;
      g.strokeStyle = pal[i % pal.length];
      g.lineWidth = h * (0.004 + hash(i + 9) * 0.008);
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 28; k++) {
        const a = vnoise(x * f + ox, y * f + oy) * TAU * 1.5;
        x += Math.cos(a) * stepL;
        y += Math.sin(a) * stepL;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  };

  R['op-art'] = (g, w, h, t) => {
    bg(g, w, h, '#F7F7F2');
    const ph = (t / 4) * TAU, M = 26, sw = w / M;
    g.fillStyle = '#111';
    for (let i = 0; i < M; i++) {
      const L = [], Rr = [], cxn = (i + 0.5) / M, bulge = Math.exp(-Math.pow(cxn - 0.5, 2) * 6);
      for (let k = 0; k <= 40; k++) {
        const y = (k / 40) * h, yy = y / h;
        const dx = Math.sin(yy * TAU * 1.2 + ph + i * 0.22) * sw * 1.2 * bulge;
        const half = sw * (0.22 + 0.16 * Math.sin(yy * TAU + ph + cxn * 6));
        const x = (i + 0.5) * sw + dx;
        L.push([x - half, y]);
        Rr.push([x + half, y]);
      }
      poly(g, L.concat(Rr.reverse()));
      g.fill();
    }
  };

  R['gradient-mesh'] = (g, w, h, t) => {
    const ph = (t / 8) * TAU;
    bg(g, w, h, '#2A1B5C');
    const blobs = [
      ['255,107,154', 0.25, 0.3, 1, 2], ['255,184,107', 0.75, 0.35, 2, 1], ['107,211,255', 0.55, 0.75, 1, 1],
      ['157,107,255', 0.2, 0.8, 2, 1], ['107,255,184', 0.85, 0.8, 1, 2],
    ];
    blobs.forEach(([c, bx, by, fx, fy], k) => {
      const x = w * (bx + 0.18 * Math.sin(ph * fx + k)), y = h * (by + 0.2 * Math.cos(ph * fy + k * 1.7));
      const r = h * (0.65 + 0.1 * Math.sin(ph + k));
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${c},.95)`);
      gr.addColorStop(0.55, `rgba(${c},.45)`);
      gr.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
    });
    const fr = Math.floor(t * 12), gs = Math.max(1, h * 0.004);
    for (let i = 0; i < 500; i++) {
      g.fillStyle = i % 2 ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.08)';
      g.fillRect(hash2(i, fr) * w, hash2(i + 501, fr) * h, gs, gs);
    }
  };

  R.minimal = (g, w, h, t) => {
    bg(g, w, h, '#F4F3EF');
    const y = h * 0.6, x0 = w * 0.22, x1 = w * 0.78;
    const grow = E.inOut(seg(t, 0.3, 1.2)), shrink = E.inOut(seg(t, 5.0, 5.8));
    const xa = lerp(x1, x0, grow), xr = lerp(x1, x0, shrink);
    if (xr - xa > 0.5) {
      g.fillStyle = '#1A1A1A';
      g.fillRect(xa, y - Math.max(0.5, h * 0.002), xr - xa, Math.max(1, h * 0.004));
    }
    const dm = E.inOut(seg(t, 1.2, 3.0)), dx = lerp(x1, x0, dm);
    const da = seg(t, 1.0, 1.2) * (1 - seg(t, 4.8, 5.1));
    if (da > 0) {
      g.globalAlpha = da;
      circle(g, dx, y, h * 0.022);
      g.fillStyle = '#E63946';
      g.fill();
      g.globalAlpha = 1;
    }
    const ta = seg(t, 3.2, 3.8) * (1 - seg(t, 4.6, 5.0));
    if (ta > 0) {
      g.globalAlpha = ta;
      font(g, h * 0.065, 'sans', 400);
      g.direction = 'rtl';
      g.textAlign = 'right';
      g.textBaseline = 'alphabetic';
      g.fillStyle = '#1A1A1A';
      g.fillText('פחות זה יותר', x1, y - h * 0.08 + (1 - E.out(seg(t, 3.2, 3.8))) * h * 0.02);
      g.globalAlpha = 1;
    }
  };

  /* ======================================================================
     Digital & tech
     ====================================================================== */

  R.glitch = (g, w, h, t, s) => {
    const b = buf(s, 'gl', w, h), q = b.g;
    const fr = Math.floor(t * 15), burst = hash(fr * 1.31) > 0.62 || t % 2 < 0.25;
    q.globalCompositeOperation = 'source-over';
    q.fillStyle = '#07070A';
    q.fillRect(0, 0, w, h);
    q.globalCompositeOperation = 'lighter';
    font(q, h * 0.46);
    q.textAlign = 'center';
    q.textBaseline = 'middle';
    const dx = h * 0.01 + (burst ? h * 0.03 * hash(fr * 2.1) : 0);
    q.fillStyle = '#FF0000';
    q.fillText('תקלה', w / 2 - dx, h * 0.46);
    q.fillStyle = '#00FF00';
    q.fillText('תקלה', w / 2, h * 0.46 + (burst ? h * 0.01 : 0));
    q.fillStyle = '#0000FF';
    q.fillText('תקלה', w / 2 + dx, h * 0.46);
    q.globalCompositeOperation = 'source-over';
    font(q, h * 0.055, 'mono', 500);
    q.fillStyle = '#9A9AA8';
    q.fillText('ERR_0x37 · SIGNAL LOST', w / 2, h * 0.82);
    bg(g, w, h, '#07070A');
    let y = 0, n = 0;
    while (y < h) {
      const sh = Math.min(h - y, Math.max(2, h * (0.02 + hash2(n, fr) * 0.08)));
      const off = burst && hash2(n + 7, fr) > 0.55 ? (hash2(n + 3, fr) - 0.5) * w * 0.18 : 0;
      g.drawImage(b.c, 0, y, w, sh, off, y, w, sh);
      y += sh;
      n++;
    }
    if (burst) {
      for (let k = 0; k < 5; k++) {
        g.fillStyle = k % 2 ? 'rgba(0,255,240,.55)' : 'rgba(255,0,200,.5)';
        g.fillRect(hash2(k, fr) * w, hash2(k + 9, fr) * h, w * (0.04 + hash2(k + 5, fr) * 0.2), h * (0.02 + hash2(k + 2, fr) * 0.04));
      }
    }
    g.fillStyle = 'rgba(0,0,0,.25)';
    const ls = Math.max(1, Math.round(h / 140));
    for (let yy = 0; yy < h; yy += ls * 2) g.fillRect(0, yy, w, ls);
  };

  R.hud = (g, w, h, t) => {
    bg(g, w, h, '#051320');
    const C = '#3FF0FF', O = '#FF9F43', ph = (t / 6) * TAU, s = h / 100, cx = w * 0.36, cy = h * 0.52;
    g.strokeStyle = 'rgba(63,240,255,.06)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x < w; x += h / 12) { g.moveTo(x, 0); g.lineTo(x, h); }
    for (let y = 0; y < h; y += h / 12) { g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
    g.save();
    g.translate(cx, cy);
    g.strokeStyle = C;
    g.lineWidth = Math.max(1, 0.5 * s);
    g.save();
    g.rotate(ph);
    g.setLineDash([4 * s, 2.5 * s]);
    circle(g, 0, 0, 38 * s);
    g.stroke();
    g.restore();
    g.save();
    g.rotate(-ph);
    g.lineWidth = 1.6 * s;
    for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(0, 0, 32 * s, (k * TAU) / 3, (k * TAU) / 3 + 1.4); g.stroke(); }
    g.restore();
    g.lineWidth = Math.max(1, 0.4 * s);
    g.beginPath();
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * TAU, r1 = 24 * s, r2 = (k % 6 ? 26 : 28) * s;
      g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      g.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
    }
    g.stroke();
    const sa = ph * 2;
    for (let k = 0; k < 14; k++) {
      g.fillStyle = `rgba(63,240,255,${0.18 * (1 - k / 14)})`;
      g.beginPath();
      g.moveTo(0, 0);
      g.arc(0, 0, 22 * s, sa - (k + 1) * 0.06, sa - k * 0.06);
      g.closePath();
      g.fill();
    }
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(Math.cos(sa) * 22 * s, Math.sin(sa) * 22 * s);
    g.stroke();
    [[0.7, 14], [2.4, 9], [4.1, 17], [5.3, 12]].forEach(([a, r]) => {
      const since = (((sa - a) % TAU) + TAU) % TAU, al = Math.max(0, 1 - since / 2.5);
      circle(g, Math.cos(a) * r * s, Math.sin(a) * r * s, 1.3 * s);
      g.fillStyle = `rgba(255,159,67,${0.2 + al * 0.8})`;
      g.fill();
    });
    g.strokeStyle = 'rgba(63,240,255,.5)';
    g.beginPath();
    [[-46, 0, -40, 0], [40, 0, 46, 0], [0, -46, 0, -40], [0, 40, 0, 46]].forEach(([a, b2, c, d]) => {
      g.moveTo(a * s, b2 * s);
      g.lineTo(c * s, d * s);
    });
    g.stroke();
    g.restore();
    const px = w * 0.64, pw = w * 0.3;
    ['סריקה', 'אנרגיה', 'מגן', 'מטרה', 'קשר'].forEach((lb, k) => {
      const y = h * 0.22 + k * h * 0.13, v = 0.35 + 0.6 * (0.5 + 0.5 * Math.sin(ph * ((k % 2) + 1) + k * 1.3));
      font(g, 4.4 * s, 'sans', 600);
      g.direction = 'rtl';
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.fillStyle = C;
      g.fillText(lb, px + pw, y);
      g.strokeStyle = 'rgba(63,240,255,.35)';
      g.lineWidth = Math.max(1, 0.3 * s);
      g.strokeRect(px, y + 3 * s, pw, 2.4 * s);
      g.fillStyle = k === 3 ? O : C;
      g.fillRect(px + pw * (1 - v), y + 3 * s, pw * v, 2.4 * s);
      font(g, 3.8 * s, 'mono', 500);
      g.direction = 'ltr';
      g.textAlign = 'left';
      g.fillStyle = 'rgba(63,240,255,.75)';
      g.fillText(String(Math.round(v * 100)).padStart(3, '0') + '%', px, y);
    });
    g.strokeStyle = C;
    g.lineWidth = Math.max(1, 0.6 * s);
    const m = 4 * s, L = 8 * s;
    g.beginPath();
    [[m, m, 1, 1], [w - m, m, -1, 1], [m, h - m, 1, -1], [w - m, h - m, -1, -1]].forEach(([x, y, sx, sy]) => {
      g.moveTo(x, y + sy * L);
      g.lineTo(x, y);
      g.lineTo(x + sx * L, y);
    });
    g.stroke();
    font(g, 3.6 * s, 'mono', 500);
    g.fillStyle = 'rgba(63,240,255,.7)';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillText(`T+${t.toFixed(2)}  LAT 32.08  LON 34.78`, 7 * s, 7 * s);
  };

  R['code-rain'] = (g, w, h, t) => {
    bg(g, w, h, '#020805');
    const rows = 16, cs = h / rows, cols = Math.ceil(w / cs);
    font(g, cs * 0.86, 'sans', 600);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const chars = 'אבגדהוזחטיכלמנסעפצקרשת0123456789', flick = Math.floor(t * 8);
    for (let c = 0; c < cols; c++) {
      const k = 1 + Math.floor(hash(c * 1.7) * 2), trail = 6 + Math.floor(hash(c * 2.9) * 10), period = rows + trail;
      const hr = Math.floor(((((t / 6) * k + hash(c * 4.3)) % 1)) * period);
      for (let j = 0; j <= trail; j++) {
        const r = hr - j;
        if (r < 0 || r >= rows) continue;
        const ch = chars[Math.floor(hash2(c * 31 + r, j === 0 ? flick : Math.floor(flick / 3)) * chars.length)];
        g.fillStyle = j === 0 ? '#E8FFEE' : `rgba(30,255,120,${(1 - j / (trail + 1)) * 0.9})`;
        g.fillText(ch, c * cs + cs / 2, r * cs + cs / 2);
      }
    }
  };

  R.ascii = (g, w, h, t) => {
    bg(g, w, h, '#0D0A06');
    const cols = 64, rows = 24, cw = w / cols, ch = h / rows;
    const A = (t / 6) * TAU, B = (t / 6) * TAU * 2;
    const cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B);
    const out = new Int8Array(cols * rows).fill(-1), zb = new Float32Array(cols * rows);
    const K2 = 5, K1y = rows * 0.62, K1x = K1y * (ch / cw);
    for (let th = 0; th < TAU; th += 0.12) {
      const ct = Math.cos(th), st = Math.sin(th);
      for (let p = 0; p < TAU; p += 0.04) {
        const cp = Math.cos(p), sp = Math.sin(p), cx2 = 2 + ct, cy2 = st;
        const x = cx2 * (cB * cp + sA * sB * sp) - cy2 * cA * sB;
        const y = cx2 * (sB * cp - sA * cB * sp) + cy2 * cA * cB;
        const ooz = 1 / (K2 + cA * cx2 * sp + cy2 * sA);
        const xp = Math.floor(cols / 2 + K1x * ooz * x), yp = Math.floor(rows / 2 - K1y * ooz * y);
        if (xp < 0 || xp >= cols || yp < 0 || yp >= rows) continue;
        const L = cp * ct * sB - cA * ct * sp - sA * st + cB * (cA * st - ct * sA * sp);
        const idx = xp + yp * cols;
        if (ooz > zb[idx]) {
          zb[idx] = ooz;
          out[idx] = L > 0 ? Math.min(11, Math.floor(L * 8)) : 0;
        }
      }
    }
    const ramp = '.,-~:;=!*#$@';
    font(g, ch * 0.95, 'mono', 500);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let lv = 0; lv < 12; lv++) {
      g.fillStyle = `rgba(255,176,0,${0.3 + (lv / 11) * 0.7})`;
      for (let i = 0; i < out.length; i++) {
        if (out[i] === lv) g.fillText(ramp[lv], ((i % cols) + 0.5) * cw, (Math.floor(i / cols) + 0.5) * ch);
      }
    }
    font(g, h * 0.045, 'mono', 400);
    g.textAlign = 'left';
    g.fillStyle = 'rgba(255,176,0,.45)';
    g.fillText('// donut.c', w * 0.03, h * 0.95);
  };

  R.neon = (g, w, h, t) => {
    bg(g, w, h, '#160F1E');
    g.strokeStyle = 'rgba(255,255,255,.045)';
    g.lineWidth = Math.max(1, h * 0.004);
    const bh = h / 12, bw = bh * 2.2;
    g.beginPath();
    for (let r = 0; r < 13; r++) {
      const y = r * bh;
      g.moveTo(0, y);
      g.lineTo(w, y);
      for (let x = (r % 2) * (bw / 2); x < w; x += bw) { g.moveTo(x, y); g.lineTo(x, y + bh); }
    }
    g.stroke();
    const on = t < 0.9 ? hash(Math.floor(t * 20) * 1.9) > 0.45 : true;
    if (on) {
      const gl = g.createRadialGradient(w / 2, h * 0.52, 0, w / 2, h * 0.52, h * 0.65);
      gl.addColorStop(0, 'rgba(255,60,200,.22)');
      gl.addColorStop(1, 'rgba(255,60,200,0)');
      g.fillStyle = gl;
      g.fillRect(0, 0, w, h);
    }
    const tube = (draw, col, glowCol, lit) => {
      g.save();
      g.lineJoin = 'round';
      g.lineCap = 'round';
      if (lit) {
        g.shadowColor = glowCol;
        g.shadowBlur = h * 0.05;
        g.strokeStyle = glowCol;
        g.lineWidth = h * 0.02;
        draw();
        g.shadowBlur = h * 0.02;
        g.strokeStyle = col;
        g.lineWidth = h * 0.009;
        draw();
      } else {
        g.strokeStyle = 'rgba(120,90,130,.35)';
        g.lineWidth = h * 0.012;
        draw();
      }
      g.restore();
    };
    tube(() => { rrect(g, w * 0.22, h * 0.17, w * 0.56, h * 0.66, h * 0.08); g.stroke(); }, '#C9FBFF', '#25E6FF', on);
    font(g, h * 0.07, 'sans', 600);
    g.direction = 'rtl';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    tube(() => g.strokeText('בר · קפה', w / 2, h * 0.28), '#C9FBFF', '#25E6FF', on);
    font(g, h * 0.36);
    const L = lettersRTL(g, 'פתוח', w / 2, h * 0.01);
    L.forEach((o) => {
      let lit = on;
      if (o.i === 2 && t > 3 && t < 3.7) lit = hash(Math.floor(t * 18) * 2.3) > 0.5;
      tube(() => g.strokeText(o.ch, o.x, h * 0.56), '#FFE1F7', '#FF3CC7', lit);
    });
  };

  R['audio-viz'] = (g, w, h, t) => {
    bg(g, w, h, '#0A0A12');
    const beat = (t % 0.5) / 0.5, kick = Math.exp(-beat * 7), ph = (t / 4) * TAU;
    const cx = w / 2, cy = h * 0.46, r = h * 0.16 * (1 + kick * 0.1), n = 72;
    g.lineCap = 'round';
    g.lineWidth = Math.max(2, h * 0.012);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU - Math.PI / 2, m = (i < n / 2 ? i : n - i) / (n / 2);
      const amp = clamp(0.15 + 0.55 * Math.abs(Math.sin(m * 7 + ph * 4)) * (0.6 + 0.4 * Math.sin(m * 3 - ph * 2)) + kick * 0.4 * (1 - m));
      const L = h * (0.02 + amp * 0.17), r0 = r + h * 0.02;
      g.strokeStyle = `hsl(${((i / n) * 300 + (t / 4) * 360) % 360}, 95%, 62%)`;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * (r0 + L), cy + Math.sin(a) * (r0 + L));
      g.stroke();
    }
    const cg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    cg.addColorStop(0, '#2B2B45');
    cg.addColorStop(1, '#14141F');
    circle(g, cx, cy, r);
    g.fillStyle = cg;
    g.fill();
    g.strokeStyle = `rgba(255,255,255,${0.2 + kick * 0.6})`;
    g.lineWidth = Math.max(1, h * 0.005);
    g.stroke();
    font(g, h * 0.05, 'mono', 500);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#E8E8F0';
    g.fillText('120 BPM', cx, cy);
    g.strokeStyle = 'rgba(255,255,255,.45)';
    g.lineWidth = Math.max(1, h * 0.004);
    g.beginPath();
    for (let x = 0; x <= w; x += w / 160) {
      const u = x / w, y = h * 0.92 + (Math.sin(u * 60 + ph * 8) * 0.6 + Math.sin(u * 23 - ph * 4) * 0.4) * h * 0.03 * (0.4 + kick) * Math.sin(u * Math.PI);
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  };

  R['led-matrix'] = (g, w, h, t, s) => {
    bg(g, w, h, '#0B0B0D');
    const rows = 16;
    if (!s.led || s.led.fonts !== API.fontsReady) {
      const msg = '   ברוכים הבאים • 55 סגנונות של מושן גרפיקס •   ';
      const c = document.createElement('canvas'), q = c.getContext('2d');
      q.font = `700 13px ${FONT.sans}`;
      q.direction = 'rtl';
      const tw = Math.ceil(q.measureText(msg).width);
      c.width = tw;
      c.height = rows;
      q.font = `700 13px ${FONT.sans}`;
      q.direction = 'rtl';
      q.textAlign = 'left';
      q.textBaseline = 'middle';
      q.fillStyle = '#fff';
      q.fillText(msg, 0, rows / 2 + 1);
      const data = q.getImageData(0, 0, tw, rows).data, mask = new Uint8Array(tw * rows);
      for (let i = 0; i < tw * rows; i++) mask[i] = data[i * 4 + 3] > 120 ? 1 : 0;
      s.led = { mask, tw, fonts: API.fontsReady };
    }
    const { mask, tw } = s.led;
    const cell = (h * 0.8) / rows, cols = Math.floor((w * 0.94) / cell);
    const ox = (w - cols * cell) / 2, oy = (h - rows * cell) / 2, period = tw + cols;
    // Hebrew signs scroll to the right, so the first letter enters first.
    const shift = Math.floor((t / 8) * period);
    const off = new Path2D(), lit = new Path2D(), halo = new Path2D();
    for (let c = 0; c < cols; c++) {
      const tx = (((c - shift) % period) + period) % period;
      for (let r = 0; r < rows; r++) {
        const x = ox + (c + 0.5) * cell, y = oy + (r + 0.5) * cell;
        if (tx < tw && mask[r * tw + tx]) {
          lit.moveTo(x + cell * 0.36, y);
          lit.arc(x, y, cell * 0.36, 0, TAU);
          halo.moveTo(x + cell * 0.62, y);
          halo.arc(x, y, cell * 0.62, 0, TAU);
        } else {
          off.moveTo(x + cell * 0.34, y);
          off.arc(x, y, cell * 0.34, 0, TAU);
        }
      }
    }
    g.fillStyle = '#2A1410';
    g.fill(off);
    g.fillStyle = 'rgba(255,90,40,.18)';
    g.fill(halo);
    g.fillStyle = '#FF6A2B';
    g.fill(lit);
  };

  /* ======================================================================
     Info & UI
     ====================================================================== */

  R.infographic = (g, w, h, t) => {
    bg(g, w, h, '#FFFFFF');
    const s = h / 100, ink = '#1C1D21', mut = '#6B7080';
    g.globalAlpha = 1 - E.in(seg(t, 5.3, 5.9));
    font(g, 7 * s, 'sans', 700);
    g.direction = 'rtl';
    g.textAlign = 'right';
    g.fillStyle = ink;
    g.fillText('צמיחה רבעונית', w - 6 * s, 14 * s);
    font(g, 4 * s, 'sans', 400);
    g.fillStyle = mut;
    g.fillText('מבקרים באתר, באלפים', w - 6 * s, 21 * s);
    const vals = [24, 38, 31, 52, 70], labels = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי'];
    const x1 = w - 6 * s, x0 = w * 0.44, base = h * 0.84, maxH = h * 0.5, bw = (x1 - x0) / vals.length;
    g.strokeStyle = '#E3E5EC';
    g.lineWidth = Math.max(1, 0.3 * s);
    g.beginPath();
    for (let v = 20; v <= 80; v += 20) {
      const y = base - (maxH * v) / 80;
      g.moveTo(x0, y);
      g.lineTo(x1, y);
    }
    g.stroke();
    vals.forEach((v, i) => {
      const e = E.out(seg(t, 0.4 + i * 0.15, 1.3 + i * 0.15)), bh = ((maxH * v) / 80) * e, x = x1 - (i + 1) * bw + bw * 0.18;
      g.fillStyle = i === vals.length - 1 ? '#FF6B3D' : '#3D5AFE';
      rrect(g, x, base - bh, bw * 0.64, bh, [s, s, 0, 0]);
      g.fill();
      font(g, 4 * s, 'mono', 500);
      g.direction = 'ltr';
      g.textAlign = 'center';
      g.fillStyle = ink;
      if (e > 0.02) g.fillText(String(Math.round(v * e)), x + bw * 0.32, base - bh - 2 * s);
      font(g, 3.6 * s, 'sans', 500);
      g.direction = 'rtl';
      g.fillStyle = mut;
      g.fillText(labels[i], x + bw * 0.32, base + 6 * s);
    });
    g.fillStyle = ink;
    g.fillRect(x0, base, x1 - x0, Math.max(1, 0.4 * s));
    const dcx = w * 0.2, dcy = h * 0.53, dr = h * 0.19, pct = 0.72 * E.inOut(seg(t, 1.2, 2.8));
    g.lineWidth = h * 0.06;
    g.strokeStyle = '#E8EAF0';
    circle(g, dcx, dcy, dr);
    g.stroke();
    if (pct > 0) {
      g.strokeStyle = '#00B894';
      g.beginPath();
      g.arc(dcx, dcy, dr, -Math.PI / 2, -Math.PI / 2 + TAU * pct);
      g.stroke();
    }
    font(g, 9 * s, 'mono', 500);
    g.direction = 'ltr';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = ink;
    g.fillText(Math.round(pct * 100) + '%', dcx, dcy);
    font(g, 3.8 * s, 'sans', 500);
    g.direction = 'rtl';
    g.fillStyle = mut;
    g.fillText('שביעות רצון', dcx, dcy + dr + 8 * s);
    g.globalAlpha = 1;
  };

  R['ui-micro'] = (g, w, h, t) => {
    bg(g, w, h, '#E8EBF4');
    const s = h / 100, pw = w * 0.36, ph2 = h * 0.36, gx = w * 0.04, gy = h * 0.06;
    const P = [
      [w / 2 + gx / 2, h / 2 - ph2 - gy / 2], [w / 2 - pw - gx / 2, h / 2 - ph2 - gy / 2],
      [w / 2 + gx / 2, h / 2 + gy / 2], [w / 2 - pw - gx / 2, h / 2 + gy / 2],
    ];
    P.forEach(([x, y]) => {
      g.save();
      g.shadowColor = 'rgba(30,40,80,.14)';
      g.shadowBlur = 3 * s;
      g.shadowOffsetY = s;
      rrect(g, x, y, pw, ph2, 3 * s);
      g.fillStyle = '#FFFFFF';
      g.fill();
      g.restore();
    });
    const c = (k) => [P[k][0] + pw / 2, P[k][1] + ph2 / 2];
    // 1. toggle (RTL: "on" moves the knob to the left)
    const on = clamp(E.back(seg(t, 1.0, 1.3)) - E.inOut(seg(t, 4.6, 4.9)), 0, 1.08);
    const [tx, ty] = c(0), tw = 22 * s, th = 12 * s;
    rrect(g, tx - tw / 2, ty - th / 2, tw, th, th / 2);
    g.fillStyle = rgb(mixRgb(hexRgb('#C9CDD8'), hexRgb('#34C759'), clamp(on)));
    g.fill();
    g.save();
    g.shadowColor = 'rgba(0,0,0,.25)';
    g.shadowBlur = 1.5 * s;
    circle(g, lerp(tx + tw / 2 - th / 2, tx - tw / 2 + th / 2, on), ty, th / 2 - 1.2 * s);
    g.fillStyle = '#FFFFFF';
    g.fill();
    g.restore();
    // 2. like
    const [hx, hy] = c(1), liked = t >= 1.6 && t < 5.2;
    const sc = liked ? 0.6 + 0.4 * E.elastic(seg(t, 1.6, 2.3)) : 1;
    const hp = heartPts(hx, hy, 9 * s * sc, 40);
    poly(g, hp);
    if (liked) { g.fillStyle = '#FF3B5C'; g.fill(); }
    else { g.strokeStyle = '#9097A9'; g.lineWidth = 1.2 * s; g.stroke(); }
    const bp = seg(t, 1.6, 2.1);
    if (bp > 0 && bp < 1) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU, rr = 8 * s + bp * 9 * s;
        circle(g, hx + Math.cos(a) * rr, hy + Math.sin(a) * rr, 1.2 * s * (1 - bp));
        g.fillStyle = k % 2 ? '#FFB020' : '#FF3B5C';
        g.fill();
      }
    }
    // 3. button → spinner → check
    const [bx, by] = c(2), bw = 28 * s, bh = 10 * s;
    const shrinkK = E.inOut(seg(t, 2.4, 2.7)) * (1 - E.inOut(seg(t, 5.2, 5.6)));
    const press = t > 2.2 && t < 2.4 ? 0.94 : 1;
    const curW = lerp(bw, bh, shrinkK) * press, curH = bh * press;
    const done = t >= 3.6 && t < 5.4;
    rrect(g, bx - curW / 2, by - curH / 2, curW, curH, curH / 2);
    g.fillStyle = done ? '#34C759' : '#3D5AFE';
    g.fill();
    const rp = seg(t, 2.2, 2.7);
    if (rp > 0 && rp < 1) {
      g.save();
      rrect(g, bx - curW / 2, by - curH / 2, curW, curH, curH / 2);
      g.clip();
      circle(g, bx, by, rp * bw * 0.6);
      g.fillStyle = `rgba(255,255,255,${0.35 * (1 - rp)})`;
      g.fill();
      g.restore();
    }
    if (shrinkK < 0.3) {
      font(g, 4.2 * s, 'sans', 600);
      g.direction = 'rtl';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = `rgba(255,255,255,${1 - shrinkK / 0.3})`;
      g.fillText('שליחה', bx, by + 0.3 * s);
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (t > 2.7 && t < 3.6) {
      g.strokeStyle = '#FFFFFF';
      g.lineWidth = 1 * s;
      const a = t * 9;
      g.beginPath();
      g.arc(bx, by, 2.6 * s, a, a + 4.2);
      g.stroke();
    }
    if (done) {
      g.strokeStyle = '#FFFFFF';
      g.lineWidth = 1.2 * s;
      strokePartial(g, [[bx - 2.4 * s, by], [bx - 0.6 * s, by + 1.8 * s], [bx + 2.6 * s, by - 2 * s]], seg(t, 3.6, 3.9));
    }
    // 4. upload progress
    const [px, py] = c(3), prog = E.inOut(seg(t, 0.5, 4.5)), barW = pw * 0.7;
    font(g, 4 * s, 'sans', 500);
    g.direction = 'rtl';
    g.textAlign = 'right';
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#1C1D21';
    g.fillText('מעלה קובץ', px + barW / 2, py - 3 * s);
    font(g, 3.8 * s, 'mono', 500);
    g.direction = 'ltr';
    g.textAlign = 'left';
    g.fillStyle = '#6B7080';
    g.fillText(Math.round(prog * 100) + '%', px - barW / 2, py - 3 * s);
    rrect(g, px - barW / 2, py, barW, 2.4 * s, 1.2 * s);
    g.fillStyle = '#E3E6EE';
    g.fill();
    if (prog > 0.01) {
      rrect(g, px + barW / 2 - barW * prog, py, barW * prog, 2.4 * s, 1.2 * s);
      g.fillStyle = prog >= 1 ? '#34C759' : '#3D5AFE';
      g.fill();
    }
    // cursor
    const way = [[0, [w * 0.5, h * 1.05]], [0.85, [tx - tw / 2 + th / 2 + s, ty + s]], [1.45, [hx + s, hy + 2 * s]], [2.1, [bx + 2 * s, by + s]], [2.9, [w * 0.55, h * 1.08]], [6, [w * 0.55, h * 1.08]]];
    let cp = way[way.length - 1][1];
    for (let i = 0; i < way.length - 1; i++) {
      const [ta, pa] = way[i], [tb, pb] = way[i + 1];
      if (t >= ta && t < tb) {
        const k = E.inOut(seg(t, ta, ta + Math.min(0.6, tb - ta)));
        cp = [lerp(pa[0], pb[0], k), lerp(pa[1], pb[1], k)];
        break;
      }
    }
    const click = [1.0, 1.6, 2.2].some((ct) => t > ct && t < ct + 0.12) ? 0.85 : 1;
    g.save();
    g.translate(cp[0], cp[1]);
    g.scale(click, click);
    poly(g, [[0, 0], [0, 7.5 * s], [2 * s, 5.6 * s], [3.4 * s, 8.6 * s], [4.6 * s, 8 * s], [3.2 * s, 5.1 * s], [5.6 * s, 5.1 * s]]);
    g.fillStyle = '#FFFFFF';
    g.fill();
    g.strokeStyle = '#111';
    g.lineWidth = Math.max(1, 0.45 * s);
    g.stroke();
    g.restore();
  };

  R['lower-thirds'] = (g, w, h, t) => {
    const ph = (t / 6) * TAU, s = h / 100;
    g.fillStyle = vgrad(g, h, ['#2C3E50', '#4A3B52', '#1B1F2A']);
    g.fillRect(0, 0, w, h);
    for (let k = 0; k < 14; k++) {
      const x = w * hash(k * 1.3) + Math.sin(ph + k) * w * 0.01, y = h * (0.1 + hash(k * 2.7) * 0.6), r = h * (0.04 + hash(k * 4.1) * 0.08);
      const col = ['255,200,120', '255,140,160', '140,200,255'][k % 3];
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${col},.35)`);
      gr.addColorStop(0.7, `rgba(${col},.18)`);
      gr.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = gr;
      circle(g, x, y, r);
      g.fill();
    }
    g.fillStyle = 'rgba(8,10,16,.6)';
    g.beginPath();
    g.ellipse(w * 0.42, h * 1.02, h * 0.34, h * 0.3, 0, Math.PI, TAU);
    g.fill();
    g.beginPath();
    g.ellipse(w * 0.42, h * 0.5, h * 0.11, h * 0.14, 0, 0, TAU);
    g.fill();
    g.setLineDash([1.5 * s, 1.5 * s]);
    g.lineWidth = Math.max(1, 0.25 * s);
    g.strokeStyle = 'rgba(255,255,255,.22)';
    g.strokeRect(w * 0.05, h * 0.05, w * 0.9, h * 0.9);
    g.strokeRect(w * 0.035, h * 0.035, w * 0.93, h * 0.93);
    g.setLineDash([]);
    font(g, 2.6 * s, 'mono', 400);
    g.fillStyle = 'rgba(255,255,255,.35)';
    g.textBaseline = 'top';
    g.fillText('TITLE SAFE 90%', w * 0.055, h * 0.06);
    const xr = w * 0.95, yb = h * 0.86;
    const bar = E.out(seg(t, 0.3, 0.6)) * (1 - E.in(seg(t, 5.0, 5.3)));
    const n1 = E.out(seg(t, 0.5, 1.0)) * (1 - E.in(seg(t, 4.6, 5.0)));
    const n2 = E.out(seg(t, 0.8, 1.3)) * (1 - E.in(seg(t, 4.4, 4.8)));
    const barW = 1.4 * s, nameH = 11 * s, titleH = 7 * s;
    g.fillStyle = '#FFB703';
    g.fillRect(xr - barW, yb - (nameH + titleH) * bar, barW, (nameH + titleH) * bar);
    const plate = (k, y, hh, fill, ink, text, px, wt) => {
      if (k <= 0) return;
      font(g, px, 'sans', wt);
      g.direction = 'rtl';
      const W = g.measureText(text).width + 8 * s;
      g.save();
      g.beginPath();
      g.rect(xr - barW - W * k, y, W * k, hh);
      g.clip();
      g.fillStyle = fill;
      g.fillRect(xr - barW - W, y, W, hh);
      g.fillStyle = ink;
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.fillText(text, xr - barW - 4 * s, y + hh / 2 + 0.3 * s);
      g.restore();
    };
    plate(n1, yb - nameH - titleH, nameH, '#FFFFFF', '#111', 'נועה לוי', 6.4 * s, 700);
    plate(n2, yb - titleH, titleH, '#023047', '#FFFFFF', 'מעצבת מושן ובמאית', 4 * s, 500);
  };

  R['logo-reveal'] = (g, w, h, t) => {
    bg(g, w, h, '#0D1B2A');
    const s = h / 100, fade = 1 - E.inOut(seg(t, 5.3, 5.9));
    g.globalAlpha = fade;
    const pal = ['#E0FBFC', '#EE6C4D', '#98C1D9', '#3D5A80'];
    const mv = E.inOut(seg(t, 1.6, 2.2));
    const lcx = lerp(w / 2, w * 0.7, mv), lcy = h * 0.5, R0 = lerp(16, 11, mv) * s;
    for (let k = 0; k < 4; k++) {
      const e = E.out(seg(t, 0.2 + k * 0.12, 1.1 + k * 0.12));
      const bis = (k * Math.PI) / 2 + Math.PI / 4, dx = Math.cos(bis), dy = Math.sin(bis);
      const gap = R0 * 0.07;
      g.save();
      g.translate(lcx + dx * (gap + (1 - e) * w * 0.7), lcy + dy * (gap + (1 - e) * h * 0.8));
      g.rotate((1 - e) * Math.PI * (k % 2 ? 1 : -1));
      g.fillStyle = pal[k];
      g.beginPath();
      g.moveTo(0, 0);
      g.arc(0, 0, R0, (k * Math.PI) / 2, ((k + 1) * Math.PI) / 2);
      g.closePath();
      g.fill();
      g.restore();
    }
    const fl = seg(t, 1.25, 1.6);
    if (fl > 0 && fl < 1) {
      circle(g, lcx, lcy, R0 * (1 + fl * 2.5));
      g.fillStyle = `rgba(255,255,255,${(1 - fl) * 0.8 * fade})`;
      g.fill();
    }
    const pp = seg(t, 1.25, 2.1);
    if (pp > 0 && pp < 1) {
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * TAU + hash(i) * 0.3, d = R0 + pp * h * 0.35 * (0.5 + hash(i + 3) * 0.5);
        circle(g, lcx + Math.cos(a) * d, lcy + Math.sin(a) * d, s * 0.9 * (1 - pp));
        g.fillStyle = pal[i % 4];
        g.fill();
      }
    }
    const te = E.out(seg(t, 2.0, 2.9));
    if (te > 0) {
      font(g, 14 * s);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#E0FBFC';
      g.globalAlpha = fade * te;
      const rightEdge = lcx - R0 - 7 * s;
      const L = lettersRTL(g, 'סטודיו תנועה', 0, lerp(4, 0.4, te) * s);
      const shift = rightEdge - L.total / 2;
      L.forEach((o) => g.fillText(o.ch, o.x + shift, lcy - 1.5 * s));
      g.globalAlpha = fade * seg(t, 2.6, 3.2);
      font(g, 3.8 * s, 'sans', 500);
      g.direction = 'rtl';
      g.textAlign = 'right';
      g.fillStyle = '#98C1D9';
      g.fillText('עיצוב · אנימציה · סאונד', rightEdge, lcy + 9 * s);
    }
    g.globalAlpha = 1;
  };

  R['map-route'] = (g, w, h, t) => {
    const S = h / 100;
    bg(g, w, h, '#A8D5E2');
    g.strokeStyle = 'rgba(255,255,255,.35)';
    g.lineWidth = Math.max(1, 0.25 * S);
    g.beginPath();
    for (let x = 0; x <= w; x += w / 8) { g.moveTo(x, 0); g.lineTo(x, h); }
    for (let y = 0; y <= h; y += h / 5) { g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
    const land = (cx, cy, rx, ry, seed) => {
      const pts = [];
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * TAU, n = 0.78 + 0.32 * vnoise(Math.cos(a) * 1.5 + seed, Math.sin(a) * 1.5 + seed);
        pts.push([cx + Math.cos(a) * rx * n, cy + Math.sin(a) * ry * n]);
      }
      return pts;
    };
    g.fillStyle = '#F3EBDD';
    g.strokeStyle = '#D9CCB4';
    g.lineWidth = 0.6 * S;
    [land(w * 0.78, h * 0.6, w * 0.24, h * 0.42, 3), land(w * 0.34, h * 0.36, w * 0.2, h * 0.32, 11), land(w * 0.15, h * 0.84, w * 0.1, h * 0.18, 7)].forEach((p) => {
      poly(g, p);
      g.fill();
      g.stroke();
    });
    const fade = 1 - seg(t, 6.3, 6.9);
    g.globalAlpha = fade;
    const A = [w * 0.78, h * 0.62], B = [w * 0.36, h * 0.34], C = [w * 0.16, h * 0.8];
    const route = quadPts(A, [w * 0.62, h * 0.12], B, 40).concat(quadPts(B, [w * 0.14, h * 0.4], C, 40).slice(1));
    const k = E.inOut(seg(t, 0.6, 4.2));
    g.strokeStyle = '#1D3557';
    g.lineWidth = 0.7 * S;
    g.lineCap = 'round';
    g.setLineDash([2 * S, 1.6 * S]);
    strokePartial(g, route, k);
    g.setLineDash([]);
    const pin = (p, t0, label) => {
      const e = seg(t, t0, t0 + 0.45);
      if (e <= 0) return;
      const drop = (1 - E.back(e)) * h * 0.12;
      const x = p[0], y = p[1] - drop;
      g.fillStyle = 'rgba(0,0,0,.18)';
      g.beginPath();
      g.ellipse(x, p[1] + 0.5 * S, 2.4 * S * e, 0.8 * S * e, 0, 0, TAU);
      g.fill();
      g.fillStyle = '#E63946';
      poly(g, [[x - 2.6 * S, y - 5 * S], [x + 2.6 * S, y - 5 * S], [x, y]]);
      g.fill();
      circle(g, x, y - 6.5 * S, 3.2 * S);
      g.fill();
      circle(g, x, y - 6.5 * S, 1.2 * S);
      g.fillStyle = '#FFFFFF';
      g.fill();
      font(g, 3.8 * S, 'sans', 700);
      g.direction = 'rtl';
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      g.lineJoin = 'round';
      g.lineWidth = 0.9 * S;
      g.strokeStyle = '#FFFFFF';
      g.strokeText(label, x, y - 11.5 * S);
      g.fillStyle = '#1D3557';
      g.fillText(label, x, y - 11.5 * S);
    };
    pin(A, 0.2, 'יציאה');
    pin(B, 2.3, 'עצירה');
    pin(C, 4.2, 'יעד');
    if (k > 0 && k < 1) {
      const [x, y, a] = pathPoint(route, k);
      g.save();
      g.translate(x, y);
      g.rotate(a);
      g.fillStyle = '#1D3557';
      poly(g, [[3.4 * S, 0], [-2.2 * S, -1 * S], [-2.2 * S, 1 * S]]);
      g.fill();
      poly(g, [[0.8 * S, 0], [-1 * S, -3.6 * S], [-1.8 * S, -3.6 * S], [-0.6 * S, 0], [-1.8 * S, 3.6 * S], [-1 * S, 3.6 * S]]);
      g.fill();
      g.restore();
    }
    g.globalAlpha = 1;
    const ccx = w * 0.06, ccy = h * 0.2;
    g.strokeStyle = '#1D3557';
    g.lineWidth = Math.max(1, 0.4 * S);
    circle(g, ccx, ccy, 5 * S);
    g.stroke();
    g.fillStyle = '#E63946';
    poly(g, [[ccx, ccy - 5 * S], [ccx + 1.4 * S, ccy], [ccx - 1.4 * S, ccy]]);
    g.fill();
    g.fillStyle = '#1D3557';
    poly(g, [[ccx, ccy + 5 * S], [ccx + 1.4 * S, ccy], [ccx - 1.4 * S, ccy]]);
    g.fill();
    font(g, 3 * S, 'mono', 500);
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillText('N', ccx, ccy - 5.6 * S);
    const sx1 = w * 0.95, sx0 = w * 0.95 - 24 * S, sy = h * 0.94;
    g.fillRect(sx0, sy, sx1 - sx0, Math.max(1, 0.5 * S));
    [0, 0.5, 1].forEach((f) => g.fillRect(sx0 + (sx1 - sx0) * f - 0.25 * S, sy - 1.4 * S, Math.max(1, 0.5 * S), 1.4 * S));
    font(g, 2.8 * S, 'sans', 500);
    g.direction = 'rtl';
    g.textAlign = 'right';
    g.fillText('100 ק״מ', sx1, sy - 2 * S);
  };

  R.transitions = (g, w, h, t) => {
    const scenes = [['#264653', '#E9C46A'], ['#E76F51', '#FFF3E0'], ['#2A9D8F', '#0B2B26'], ['#E9C46A', '#264653']];
    const names = ['איריס', 'ניגוב אלכסוני', 'דחיפה', 'תריסים'];
    const scene = (k, ox = 0) => {
      const [bgc, ink] = scenes[k];
      g.fillStyle = bgc;
      g.fillRect(ox, 0, w, h);
      font(g, h * 0.5);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = ink;
      g.fillText(String(k + 1), ox + w / 2, h * 0.44);
      font(g, h * 0.07, 'sans', 600);
      g.direction = 'rtl';
      g.fillText('סצנה ' + (k + 1), ox + w / 2, h * 0.76);
    };
    const slot = 2, i = Math.floor(t / slot) % 4, lt = t - i * slot, n = (i + 1) % 4;
    const p = E.inOut(seg(lt, 1.35, 1.95));
    if (p <= 0) scene(i);
    else if (i === 0) {
      scene(i);
      g.save();
      circle(g, w / 2, h / 2, (p * Math.hypot(w, h)) / 2);
      g.clip();
      scene(n);
      g.restore();
    } else if (i === 1) {
      scene(i);
      g.save();
      const d = p * (w + h * 0.5);
      poly(g, [[w - d, 0], [w, 0], [w, h], [w - d + h * 0.5, h]]);
      g.clip();
      scene(n);
      g.restore();
    } else if (i === 2) {
      scene(i, -p * w);
      scene(n, w - p * w);
    } else {
      scene(i);
      g.save();
      g.beginPath();
      const sw = w / 8;
      for (let k = 0; k < 8; k++) g.rect(k * sw + sw * (1 - p), 0, sw * p + 0.5, h);
      g.clip();
      scene(n);
      g.restore();
    }
    const la = Math.sin(seg(lt, 1.15, 2) * Math.PI);
    if (la > 0) {
      g.globalAlpha = la;
      font(g, h * 0.05, 'sans', 600);
      g.direction = 'rtl';
      const label = 'מעבר: ' + names[i], tw = g.measureText(label).width;
      rrect(g, w - tw - h * 0.1, h * 0.05, tw + h * 0.06, h * 0.09, h * 0.045);
      g.fillStyle = 'rgba(0,0,0,.45)';
      g.fill();
      g.fillStyle = '#FFFFFF';
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.fillText(label, w - h * 0.07, h * 0.095);
      g.globalAlpha = 1;
    }
  };

  R.glassmorphism = (g, w, h, t, s) => {
    const ph = (t / 8) * TAU;
    const scene = (q, W, H) => {
      q.fillStyle = '#1B1035';
      q.fillRect(0, 0, W, H);
      [['#FF5D8F', 0.3, 0.35, 0.22, 1, 2], ['#FFC145', 0.7, 0.3, 0.18, 2, 1], ['#5BC0EB', 0.62, 0.72, 0.24, 1, 1], ['#9D4EDD', 0.25, 0.75, 0.2, 1, 2]].forEach(
        ([c, x, y, r, fx, fy], k) => {
          q.fillStyle = c;
          q.beginPath();
          q.arc(W * (x + 0.12 * Math.sin(ph * fx + k)), H * (y + 0.14 * Math.cos(ph * fy + k * 2)), H * r * 1.25, 0, TAU);
          q.fill();
        }
      );
    };
    scene(g, w, h);
    const b = buf(s, 'glass', Math.max(8, Math.round(w / 14)), Math.max(5, Math.round(h / 14)));
    scene(b.g, b.c.width, b.c.height);
    const cw = w * 0.5, ch = h * 0.56, cx = w / 2 - cw / 2, cy = h / 2 - ch / 2 + Math.sin(ph) * h * 0.02, rad = h * 0.05;
    g.save();
    rrect(g, cx, cy, cw, ch, rad);
    g.clip();
    g.imageSmoothingEnabled = true;
    g.drawImage(b.c, 0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,.16)';
    g.fillRect(cx, cy, cw, ch);
    const sx = cx - cw * 0.6 + ((t / 8) * 2 % 1) * cw * 2.2;
    const sg = g.createLinearGradient(sx, cy, sx + cw * 0.4, cy + ch);
    sg.addColorStop(0, 'rgba(255,255,255,0)');
    sg.addColorStop(0.5, 'rgba(255,255,255,.22)');
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sg;
    g.fillRect(cx, cy, cw, ch);
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,.55)';
    g.lineWidth = Math.max(1, h * 0.004);
    rrect(g, cx, cy, cw, ch, rad);
    g.stroke();
    const p = h * 0.06;
    font(g, h * 0.06, 'sans', 600);
    g.direction = 'rtl';
    g.textAlign = 'right';
    g.textBaseline = 'top';
    g.fillStyle = '#FFFFFF';
    g.fillText('כרטיס זכוכית', cx + cw - p, cy + p);
    rrect(g, cx + p, cy + p, h * 0.1, h * 0.075, h * 0.015);
    g.fillStyle = 'rgba(255,217,138,.85)';
    g.fill();
    font(g, h * 0.06, 'mono', 500);
    g.direction = 'ltr';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = 'rgba(255,255,255,.95)';
    g.fillText('•••• 5555', cx + p, cy + ch - p);
    font(g, h * 0.04, 'sans', 500);
    g.direction = 'rtl';
    g.textAlign = 'right';
    g.fillStyle = 'rgba(255,255,255,.8)';
    g.fillText('תוקף 10/29', cx + cw - p, cy + ch - p);
  };

  /* ======================================================================
     Craft & texture
     ====================================================================== */

  R['paper-cut'] = (g, w, h, t) => {
    const ph = (t / 8) * TAU;
    bg(g, w, h, '#FDF3E7');
    circle(g, w * 0.7, h * 0.25, h * 0.12);
    g.fillStyle = '#F7B267';
    g.fill();
    const cols = ['#DDF2EA', '#B1E0CF', '#82C8B2', '#55AC95', '#348B79', '#1E695C'];
    const yAt = (k, x) =>
      h * (0.32 + k * 0.11) +
      Math.sin((x / w) * TAU * (1 + (k % 3) * 0.5) + ph * (k % 2 ? 1 : -1) + k * 1.3) * h * 0.035 +
      Math.sin((x / w) * TAU * 3 + ph * 2 + k) * h * 0.01;
    cols.forEach((c, k) => {
      g.save();
      g.shadowColor = 'rgba(40,30,20,.28)';
      g.shadowBlur = h * 0.03;
      g.shadowOffsetY = -h * 0.008;
      g.beginPath();
      g.moveTo(0, h);
      for (let x = 0; x <= w + 1; x += w / 70) g.lineTo(x, yAt(k, x));
      g.lineTo(w, h);
      g.closePath();
      g.fillStyle = c;
      g.fill();
      g.restore();
      if (k === 3) {
        const bx = w * 0.36 + Math.sin(ph) * w * 0.05, by = yAt(3, bx), a = Math.atan2(yAt(3, bx + 4) - yAt(3, bx - 4), 8);
        const S = h / 100;
        g.save();
        g.translate(bx, by + 1.5 * S);
        g.rotate(a);
        g.shadowColor = 'rgba(40,30,20,.25)';
        g.shadowBlur = h * 0.02;
        g.fillStyle = '#FFFFFF';
        poly(g, [[-9 * S, -4 * S], [9 * S, -4 * S], [6 * S, 0], [-6 * S, 0]]);
        g.fill();
        poly(g, [[0.5 * S, -5 * S], [0.5 * S, -17 * S], [8 * S, -5 * S]]);
        g.fill();
        g.fillStyle = '#F4F0EA';
        poly(g, [[-0.5 * S, -5 * S], [-0.5 * S, -14 * S], [-6 * S, -5 * S]]);
        g.fill();
        g.restore();
      }
    });
  };

  R['stop-motion'] = (g, w, h, t) => {
    const fps = 8, fr = Math.floor(t * fps), tq = fr / fps, S = h / 100;
    bg(g, w, h, '#C99A6B');
    g.strokeStyle = 'rgba(110,70,35,.18)';
    g.lineWidth = Math.max(1, 0.4 * S);
    g.beginPath();
    for (let k = 0; k < 14; k++) {
      const y0 = h * 0.45 + hash(k) * h * 0.55;
      for (let x = 0; x <= w; x += w / 30) {
        const y = y0 + Math.sin(x / (w * 0.08) + k) * S * 0.8;
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
    }
    g.stroke();
    g.fillStyle = '#EADBC8';
    g.fillRect(0, 0, w, h * 0.45);
    g.fillStyle = 'rgba(0,0,0,.08)';
    g.fillRect(0, h * 0.45, w, h * 0.02);
    const letters = ['ת', 'נ', 'ו', 'ע', 'ה'], cols = ['#E63946', '#F4A261', '#2A9D8F', '#457B9D', '#E9C46A'];
    const bs = h * 0.17, gap = bs * 0.12, floor = h * 0.74;
    letters.forEach((ch, i) => {
      const tx = w / 2 + (2 - i) * (bs + gap), t0 = 0.3 + i * 0.55, land = seg(tq, t0, t0 + 0.5);
      if (land <= 0) return;
      const leave = seg(tq, 4.1 + i * 0.1, 4.6 + i * 0.1);
      const y = floor - bs - (1 - E.out(land)) * h * 0.85 - E.in(leave) * h * 1.1;
      const jx = (hash2(i, fr) - 0.5) * S * 0.9, jy = (hash2(i + 9, fr) - 0.5) * S * 0.9;
      const rot = (hash(i * 3.3) - 0.5) * 0.12 + (hash2(i + 4, fr) - 0.5) * 0.025;
      const near = clamp(1 - (floor - bs - y) / (h * 0.5));
      g.fillStyle = `rgba(60,35,15,${0.25 * near})`;
      g.beginPath();
      g.ellipse(tx + S, floor + S * 0.5, bs * 0.62 * (0.5 + 0.5 * near), bs * 0.12, 0, 0, TAU);
      g.fill();
      g.save();
      g.translate(tx + jx, y + bs / 2 + jy);
      g.rotate(rot);
      rrect(g, -bs / 2, -bs / 2, bs, bs, bs * 0.08);
      g.fillStyle = cols[i];
      g.fill();
      g.fillStyle = shade(cols[i], 1.18);
      g.fillRect(-bs / 2 + bs * 0.06, -bs / 2 + bs * 0.04, bs * 0.88, bs * 0.08);
      g.fillStyle = shade(cols[i], 0.78);
      g.fillRect(-bs / 2 + bs * 0.06, bs / 2 - bs * 0.1, bs * 0.88, bs * 0.06);
      font(g, bs * 0.72);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#FFF8EC';
      g.fillText(ch, 0, bs * 0.04);
      g.restore();
    });
    g.fillStyle = `rgba(255,236,210,${hash(fr * 2.7) * 0.08})`;
    g.fillRect(0, 0, w, h);
    const vg = g.createRadialGradient(w / 2, h / 2, h * 0.4, w / 2, h / 2, w * 0.7);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(40,20,5,.45)');
    g.fillStyle = vg;
    g.fillRect(0, 0, w, h);
  };

  R.collage = (g, w, h, t) => {
    const fps = 12, fr = Math.floor(t * fps), tq = fr / fps, S = h / 100;
    bg(g, w, h, '#D8C29D');
    g.strokeStyle = 'rgba(120,90,50,.15)';
    g.lineWidth = Math.max(1, 0.3 * S);
    g.beginPath();
    for (let k = 0; k < 70; k++) {
      const x = hash(k) * w, y = hash(k + 70) * h, a = hash(k + 140) * TAU;
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * 2.5 * S, y + Math.sin(a) * 2.5 * S);
    }
    g.stroke();
    const jig = (k) => (hash2(k, fr) - 0.5) * 0.014;
    const pop = (a) => Math.max(0, E.back(seg(tq, a, a + 0.3)) * (1 - E.in(seg(tq, 5.2, 5.7))));
    const torn = (x0, y0, ww, hh, seed) => {
      const pts = [];
      for (let k = 0; k <= 24; k++) pts.push([x0 + (ww * k) / 24, y0 + (hash(seed + k) - 0.5) * hh * 0.18]);
      for (let k = 24; k >= 0; k--) pts.push([x0 + (ww * k) / 24, y0 + hh + (hash(seed + k + 40) - 0.5) * hh * 0.18]);
      return pts;
    };
    let p = pop(0.1);
    if (p > 0) {
      g.save();
      g.translate(w * 0.5, h * 0.2);
      g.rotate(-0.05 + jig(1));
      g.scale(1, p);
      poly(g, torn(-w * 0.46, -h * 0.1, w * 0.92, h * 0.2, 3));
      g.fillStyle = '#F1E8D6';
      g.fill();
      g.fillStyle = 'rgba(60,60,60,.28)';
      for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) {
        const lw = w * 0.13 * (0.6 + hash(r * 9 + c) * 0.4);
        g.fillRect(w * 0.42 - c * w * 0.15 - lw, -h * 0.065 + r * h * 0.04, lw, h * 0.014);
      }
      g.restore();
    }
    p = pop(0.4);
    if (p > 0) {
      g.save();
      g.translate(w * 0.26, h * 0.6);
      g.rotate(jig(2));
      g.scale(p, p);
      circle(g, 0, 0, h * 0.25);
      g.fillStyle = '#D62828';
      g.fill();
      g.clip();
      g.fillStyle = '#9E1B1B';
      const st = h * 0.035;
      for (let y = -h * 0.25; y < h * 0.25; y += st) for (let x = -h * 0.25; x < h * 0.25; x += st) {
        circle(g, x, y, st * 0.4 * clamp(0.2 + (x + y) / (h * 0.6) + 0.5));
        g.fill();
      }
      g.restore();
    }
    p = pop(0.7);
    if (p > 0) {
      g.save();
      g.translate(w * 0.8, h * 0.64);
      g.rotate(0.2 + jig(3));
      g.scale(p, p);
      poly(g, [[0, -h * 0.2], [h * 0.18, h * 0.13], [-h * 0.18, h * 0.13]]);
      g.fillStyle = '#1D3557';
      g.fill();
      g.restore();
    }
    const word = ['ק', 'ו', 'ל', 'א', 'ז', '׳'];
    const papers = ['#FFFFFF', '#FFD60A', '#F1E8D6', '#90E0EF', '#FFADAD', '#FFFFFF'];
    const inks = ['#111', '#D62828', '#1D3557', '#111', '#111', '#D62828'];
    const fams = ['display', 'sans', 'display', 'sans', 'display', 'sans'];
    word.forEach((ch, i) => {
      const e = pop(1.2 + i * 0.15);
      if (e <= 0) return;
      const sz = h * (0.17 + hash(i * 5.1) * 0.06), x = w * 0.7 - i * w * 0.085, y = h * 0.6 + (hash(i * 2.2) - 0.5) * h * 0.12;
      g.save();
      g.translate(x, y);
      g.rotate((hash(i * 7.7) - 0.5) * 0.4 + jig(i + 10));
      g.scale(e, e);
      g.fillStyle = 'rgba(0,0,0,.18)';
      g.fillRect(-sz * 0.45 + S * 0.6, -sz * 0.55 + S * 0.6, sz * 0.9, sz * 1.1);
      g.fillStyle = papers[i];
      g.fillRect(-sz * 0.45, -sz * 0.55, sz * 0.9, sz * 1.1);
      font(g, sz * (fams[i] === 'display' ? 0.95 : 0.7), fams[i], 700);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = inks[i];
      g.fillText(ch, 0, sz * 0.03);
      g.restore();
    });
    const tp = pop(0.25);
    if (tp > 0) {
      g.fillStyle = 'rgba(247,243,227,.7)';
      [[w * 0.08, h * 0.12, -0.6], [w * 0.92, h * 0.12, 0.6]].forEach(([x, y, a]) => {
        g.save();
        g.translate(x, y);
        g.rotate(a);
        g.fillRect(-w * 0.06 * tp, -h * 0.025, w * 0.12 * tp, h * 0.05);
        g.restore();
      });
    }
  };

  R.chalkboard = (g, w, h, t) => {
    const S = h / 100;
    bg(g, w, h, '#6B4423');
    const fx = 3.5 * S, bx = fx, by = fx, bw2 = w - fx * 2, bh2 = h - fx * 2 - 3 * S;
    g.fillStyle = '#26443A';
    g.fillRect(bx, by, bw2, bh2);
    for (let k = 0; k < 6; k++) {
      const x = hash(k * 3.1) * w, y = hash(k * 5.3) * h, r = h * (0.15 + hash(k) * 0.2);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,.05)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(bx, by, bw2, bh2);
    }
    g.fillStyle = '#4E3119';
    g.fillRect(0, h - 5 * S, w, 5 * S);
    g.fillStyle = '#F1EFE6';
    g.fillRect(w * 0.2, h - 4.4 * S, 6 * S, 1.6 * S);
    g.save();
    g.beginPath();
    g.rect(bx, by, bw2, bh2);
    g.clip();
    const chalk = 'rgba(245,245,235,.9)', board = '#26443A';
    const specks = (x0, y0, ww, hh, n, seed) => {
      g.fillStyle = 'rgba(38,68,58,.55)';
      for (let i = 0; i < n; i++) g.fillRect(x0 + hash(seed + i) * ww, y0 + hash(seed + i + 500) * hh, Math.max(1, S * 0.5), Math.max(1, S * 0.5));
    };
    const k1 = seg(t, 0.3, 1.8);
    font(g, 9 * S, 'sans', 600);
    g.direction = 'rtl';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    const title = 'שיעור 1: תנועה', tx = w - 10 * S, ty = 17 * S, tw = g.measureText(title).width;
    if (k1 > 0) {
      g.save();
      g.beginPath();
      g.rect(tx - tw * k1, 0, tw * k1, h);
      g.clip();
      g.fillStyle = chalk;
      g.fillText(title, tx, ty);
      specks(tx - tw, ty - 5 * S, tw, 10 * S, 160, 7);
      g.restore();
    }
    g.strokeStyle = chalk;
    g.lineCap = 'round';
    g.lineWidth = 0.8 * S;
    const ul = [];
    for (let i = 0; i <= 20; i++) ul.push([tx - (tw * i) / 20, ty + 7 * S + Math.sin(i * 1.7) * 0.5 * S]);
    strokePartial(g, ul, seg(t, 1.8, 2.2));
    const p0 = [w * 0.8, h * 0.78], p1 = [w * 0.3, h * 0.78], arc = quadPts(p0, [w * 0.55, h * 0.12], p1, 40);
    g.setLineDash([2 * S, 1.6 * S]);
    g.lineWidth = 0.7 * S;
    const k2 = seg(t, 2.2, 3.8);
    strokePartial(g, arc, k2);
    g.setLineDash([]);
    for (let i = 0; i <= 4; i++) {
      const f = i / 4;
      if (k2 >= f && k2 > 0) {
        const [x, y] = pathPoint(arc, f);
        circle(g, x, y, 2.2 * S);
        g.stroke();
      }
    }
    if (k2 >= 1) {
      const [x, y, a] = pathPoint(arc, 1);
      g.beginPath();
      g.moveTo(x - Math.cos(a - 0.5) * 4 * S, y - Math.sin(a - 0.5) * 4 * S);
      g.lineTo(x, y);
      g.lineTo(x - Math.cos(a + 0.5) * 4 * S, y - Math.sin(a + 0.5) * 4 * S);
      g.stroke();
    }
    const k3 = seg(t, 3.9, 4.6);
    if (k3 > 0) {
      font(g, 7 * S, 'mono', 500);
      g.direction = 'ltr';
      g.textAlign = 'left';
      const fx0 = w * 0.07, fy = h * 0.36, fw = g.measureText('v = Δx / Δt').width;
      g.save();
      g.beginPath();
      g.rect(fx0, 0, fw * k3, h);
      g.clip();
      g.fillStyle = chalk;
      g.fillText('v = Δx / Δt', fx0, fy);
      specks(fx0, fy - 4 * S, fw, 8 * S, 90, 31);
      g.restore();
    }
    const er = E.inOut(seg(t, 6.0, 6.9));
    if (er > 0) {
      const x = lerp(w + 12 * S, -24 * S, er);
      g.fillStyle = board;
      g.fillRect(x, by, w - x, bh2);
      g.fillStyle = 'rgba(255,255,255,.05)';
      for (let k = 0; k < 5; k++) g.fillRect(x, by + k * bh2 * 0.2 + bh2 * 0.05, w - x, bh2 * 0.06);
      const ey = h * 0.45 + Math.sin(er * 30) * 6 * S;
      rrect(g, x - 9 * S, ey - 5 * S, 20 * S, 10 * S, 1.5 * S);
      g.fillStyle = '#E8D5B5';
      g.fill();
      g.fillStyle = '#3B3B3B';
      g.fillRect(x - 9 * S, ey + 2.5 * S, 20 * S, 2.5 * S);
    }
    g.restore();
  };

  R.blueprint = (g, w, h, t) => {
    const S = h / 100;
    bg(g, w, h, '#0F4C81');
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,.07)';
    g.beginPath();
    for (let x = 0; x <= w; x += h / 40) { g.moveTo(x, 0); g.lineTo(x, h); }
    for (let y = 0; y <= h; y += h / 40) { g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.16)';
    g.beginPath();
    for (let x = 0; x <= w; x += h / 8) { g.moveTo(x, 0); g.lineTo(x, h); }
    for (let y = 0; y <= h; y += h / 8) { g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
    const ink = '#EAF4FF', cx = w * 0.62, cy = h * 0.45, ro = 26 * S, ri = 21 * S, Z = 12, tw = TAU / Z;
    g.globalAlpha = 1 - seg(t, 7.5, 8);
    const rot = E.inOut(seg(t, 4.6, 7.4)) * tw;
    const P = (r, a) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    const gear = [];
    for (let k = 0; k < Z; k++) {
      const a = k * tw + rot;
      gear.push(P(ri, a), P(ro, a + tw * 0.2), P(ro, a + tw * 0.5), P(ri, a + tw * 0.7));
    }
    gear.push(gear[0]);
    g.strokeStyle = 'rgba(234,244,255,.5)';
    g.lineWidth = Math.max(1, 0.3 * S);
    g.setLineDash([6 * S, 1.5 * S, 1 * S, 1.5 * S]);
    g.beginPath();
    g.moveTo(cx - 32 * S, cy);
    g.lineTo(cx + 32 * S, cy);
    g.moveTo(cx, cy - 32 * S);
    g.lineTo(cx, cy + 32 * S);
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = ink;
    g.lineWidth = Math.max(1, 0.55 * S);
    g.lineJoin = 'round';
    const tip = strokePartial(g, gear, E.inOut(seg(t, 0.3, 2.8)));
    strokePartial(g, arcPts(cx, cy, 8 * S, rot, rot + TAU, 48), seg(t, 2.8, 3.3));
    strokePartial(g, arcPts(cx, cy, 4 * S, rot, rot + TAU, 32), seg(t, 3.1, 3.5));
    const ha = seg(t, 3.3, 3.6);
    if (ha > 0) {
      g.globalAlpha = ha * (1 - seg(t, 7.5, 8));
      for (let k = 0; k < 4; k++) {
        const [x, y] = P(14 * S, rot + (k * Math.PI) / 2 + Math.PI / 4);
        circle(g, x, y, 1.6 * S);
        g.stroke();
      }
    }
    const da = seg(t, 3.6, 4.4);
    if (da > 0) {
      g.globalAlpha = da * (1 - seg(t, 7.5, 8));
      g.lineWidth = Math.max(1, 0.35 * S);
      const yd = cy + 33 * S;
      g.beginPath();
      g.moveTo(cx - ro, cy + 4 * S);
      g.lineTo(cx - ro, yd + 2 * S);
      g.moveTo(cx + ro, cy + 4 * S);
      g.lineTo(cx + ro, yd + 2 * S);
      g.moveTo(cx - ro, yd);
      g.lineTo(cx + ro, yd);
      g.stroke();
      g.fillStyle = ink;
      [[cx - ro, 1], [cx + ro, -1]].forEach(([x, d]) => {
        poly(g, [[x, yd], [x + d * 2.4 * S, yd - 0.9 * S], [x + d * 2.4 * S, yd + 0.9 * S]]);
        g.fill();
      });
      font(g, 3.6 * S, 'mono', 500);
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.fillText('Ø 52', cx, yd - 1 * S);
      g.beginPath();
      g.moveTo(cx + 5.7 * S, cy - 5.7 * S);
      g.lineTo(cx + 24 * S, cy - 31 * S);
      g.lineTo(cx + 34 * S, cy - 31 * S);
      g.stroke();
      g.textAlign = 'left';
      g.fillText('Ø 16', cx + 25 * S, cy - 31.5 * S);
    }
    g.globalAlpha = 1 - seg(t, 7.5, 8);
    if (tip && t < 2.8) {
      g.strokeStyle = 'rgba(255,214,102,.9)';
      g.lineWidth = Math.max(1, 0.3 * S);
      g.beginPath();
      g.moveTo(tip[0] - 3 * S, tip[1]);
      g.lineTo(tip[0] + 3 * S, tip[1]);
      g.moveTo(tip[0], tip[1] - 3 * S);
      g.lineTo(tip[0], tip[1] + 3 * S);
      g.stroke();
    }
    g.globalAlpha = 1;
    const tbx = 4 * S, tby = h - 24 * S, tbw = 50 * S, tbh = 20 * S;
    g.strokeStyle = ink;
    g.lineWidth = Math.max(1, 0.35 * S);
    g.strokeRect(tbx, tby, tbw, tbh);
    g.beginPath();
    g.moveTo(tbx, tby + tbh / 3);
    g.lineTo(tbx + tbw, tby + tbh / 3);
    g.moveTo(tbx, tby + (tbh * 2) / 3);
    g.lineTo(tbx + tbw, tby + (tbh * 2) / 3);
    g.moveTo(tbx + tbw / 2, tby + tbh / 3);
    g.lineTo(tbx + tbw / 2, tby + tbh);
    g.stroke();
    font(g, 3.2 * S, 'sans', 500);
    g.direction = 'rtl';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.fillStyle = ink;
    g.fillText('גלגל שיניים, Z=12', tbx + tbw - 1.5 * S, tby + tbh / 6);
    g.fillText('שרטוט 054', tbx + tbw - 1.5 * S, tby + tbh / 2);
    g.fillText('קנ״מ 1:2', tbx + tbw / 2 - 1.5 * S, tby + tbh / 2);
    g.fillText('יח׳: מ״מ', tbx + tbw - 1.5 * S, tby + (tbh * 5) / 6);
    g.fillText('גיליון 1/1', tbx + tbw / 2 - 1.5 * S, tby + (tbh * 5) / 6);
  };

  R.claymation = (g, w, h, t) => {
    const fps = 12, fr = Math.floor(t * fps), tq = fr / fps, S = h / 100;
    g.fillStyle = '#BFE3F7';
    g.fillRect(0, 0, w, h * 0.62);
    g.fillStyle = '#F6D7B0';
    g.fillRect(0, h * 0.62, w, h * 0.38);
    g.fillStyle = 'rgba(0,0,0,.05)';
    g.fillRect(0, h * 0.62, w, h * 0.03);
    const pebble = (x, y, r, col, seed) => {
      g.beginPath();
      for (let k = 0; k <= 24; k++) {
        const a = (k / 24) * TAU, rr = r * (1 + 0.06 * (vnoise(Math.cos(a) + seed, Math.sin(a) + fr * 0.6) - 0.5) * 2);
        const px = x + Math.cos(a) * rr * 1.3, py = y + Math.sin(a) * rr * 0.8;
        k ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.closePath();
      g.fillStyle = col;
      g.fill();
    };
    pebble(w * 0.16, h * 0.82, 5 * S, '#F28C8C', 3);
    pebble(w * 0.84, h * 0.86, 4 * S, '#8EC5FF', 9);
    const n = Math.floor(tq / 2), hop = (tq % 2) / 2;
    const xs = [0.4, 0.6];
    let lift = 0, sx = 1, sy = 1, x = w * xs[n % 2];
    if (hop < 0.2) {
      const k = E.sine(hop / 0.2);
      sy = 1 - 0.18 * k;
      sx = 1 + 0.14 * k;
    } else if (hop < 0.75) {
      const k = (hop - 0.2) / 0.55;
      lift = 4 * k * (1 - k) * h * 0.25;
      sy = 1 + 0.1 * Math.sin(k * Math.PI);
      sx = 1 - 0.07 * Math.sin(k * Math.PI);
      x = w * lerp(xs[n % 2], xs[(n + 1) % 2], E.sine(k));
    } else {
      x = w * xs[(n + 1) % 2];
      if (hop < 0.87) {
        const k = (hop - 0.75) / 0.12;
        sy = 1 - 0.22 * Math.sin(k * Math.PI);
        sx = 1 + 0.18 * Math.sin(k * Math.PI);
      }
    }
    const floorY = h * 0.8, R0 = 15 * S, cy = floorY - R0 * 1.1 * sy - lift;
    g.fillStyle = `rgba(80,50,20,${0.22 - lift / h})`;
    g.beginPath();
    g.ellipse(x, floorY, R0 * 1.1 * (1 - lift / h), R0 * 0.22, 0, 0, TAU);
    g.fill();
    g.beginPath();
    for (let k = 0; k <= 40; k++) {
      const a = (k / 40) * TAU;
      let r = R0 * (1 + 0.035 * (vnoise(Math.cos(a) * 1.3 + fr * 0.7, Math.sin(a) * 1.3) - 0.5) * 2);
      if (Math.sin(a) > 0) r *= 1.04;
      const px = x + Math.cos(a) * r * sx, py = cy + Math.sin(a) * r * 1.1 * sy;
      k ? g.lineTo(px, py) : g.moveTo(px, py);
    }
    g.closePath();
    const gr = g.createRadialGradient(x - R0 * 0.4, cy - R0 * 0.5, R0 * 0.1, x, cy, R0 * 1.3);
    gr.addColorStop(0, '#A8E383');
    gr.addColorStop(0.6, '#5BAF3A');
    gr.addColorStop(1, '#3B7F22');
    g.fillStyle = gr;
    g.fill();
    g.strokeStyle = 'rgba(30,60,15,.12)';
    g.lineWidth = Math.max(1, 0.5 * S);
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      g.arc(x + (hash(k) - 0.5) * R0, cy + (hash(k + 4) - 0.2) * R0 * 0.6, R0 * 0.18, 0.5 + hash2(k, fr % 3) * 0.3, 2.6);
      g.stroke();
    }
    const dir = hop >= 0.2 && hop < 0.75 ? (n % 2 ? -1 : 1) : 0;
    const blink = fr % 30 === 7 || fr % 30 === 8;
    [-1, 1].forEach((side) => {
      const ex = x + side * R0 * 0.36 * sx, ey = cy - R0 * 0.22 * sy;
      g.fillStyle = '#FFFFFF';
      g.beginPath();
      g.ellipse(ex, ey, R0 * 0.2, R0 * (blink ? 0.03 : 0.24), 0, 0, TAU);
      g.fill();
      if (!blink) {
        circle(g, ex + dir * R0 * 0.07, ey + R0 * 0.04, R0 * 0.1);
        g.fillStyle = '#1A1A1A';
        g.fill();
      }
    });
    g.strokeStyle = '#2B4A1E';
    g.lineWidth = Math.max(1, 1 * S);
    g.lineCap = 'round';
    g.beginPath();
    g.arc(x, cy + R0 * 0.22 * sy, R0 * 0.22, 0.3, Math.PI - 0.3);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,.35)';
    g.beginPath();
    g.ellipse(x - R0 * 0.45, cy - R0 * 0.6 * sy, R0 * 0.2, R0 * 0.1, -0.6, 0, TAU);
    g.fill();
    g.fillStyle = `rgba(255,240,220,${hash(fr * 1.9) * 0.06})`;
    g.fillRect(0, 0, w, h);
  };

  /* ---------- public API ---------- */
  const API = {
    fontsReady: 0,
    has: (id) => Object.prototype.hasOwnProperty.call(R, id),
    ids: () => Object.keys(R),
    draw(id, g, w, h, t, s) {
      const fn = R[id];
      if (!fn || w < 4 || h < 4) return false;
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.direction = 'ltr';
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      g.lineCap = 'butt';
      g.lineJoin = 'miter';
      g.setLineDash([]);
      g.shadowBlur = 0;
      g.shadowColor = 'rgba(0,0,0,0)';
      g.shadowOffsetX = 0;
      g.shadowOffsetY = 0;
      g.imageSmoothingEnabled = true;
      try {
        fn(g, w, h, t, s);
      } finally {
        g.restore();
      }
      return true;
    },
  };
  window.MG_RENDER = API;
})();
