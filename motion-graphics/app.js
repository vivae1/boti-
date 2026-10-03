/* Gallery UI: builds the clip grid, filters, the ruler, and the player dialog.
   All animation goes through one requestAnimationFrame loop; only clips that are
   on screen get drawn, and the grid pauses while the player is open. */
(function () {
  'use strict';

  const { CATS, STYLES } = window.MG_DATA;
  const MGR = window.MG_RENDER;
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  root.lang = 'he';
  root.dir = 'rtl';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const catById = Object.fromEntries(CATS.map((c) => [c.id, c]));
  const LEVELS = ['', 'בסיסית', 'בינונית', 'גבוהה'];
  const GRID_DPR = 1.5;
  const VIEW_DPR = 2;

  const pad = (n) => String(n).padStart(2, '0');
  const num = (i) => pad(i + 1);
  const tcShort = (t, fps) => `${pad(Math.floor(t))}:${pad(Math.floor((t % 1) * fps))}`;
  const tcFull = (t, fps) => `00:00:${tcShort(t, fps)}`;
  const posterOf = (s) => (s.poster != null ? s.poster : s.dur * 0.5);
  const ytSearch = (s) => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(`${s.en} motion graphics`);

  function sizeCanvas(canvas, cssW, cssH, maxDpr) {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      return true;
    }
    return false;
  }

  function render(style, ctx, canvas, t, scratch) {
    try {
      MGR.draw(style.id, ctx, canvas.width, canvas.height, t, scratch);
    } catch (err) {
      if (!style._failed) {
        style._failed = true;
        console.error(`[${style.id}]`, err);
      }
      ctx.fillStyle = '#16181F';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  /* ---------------- grid ---------------- */
  const state = {
    cat: 'all',
    q: '',
    playing: !reduceMotion,
    started: !reduceMotion,
    time: 0,
  };

  const grid = $('grid');
  const clips = STYLES.map((s, i) => {
    const li = document.createElement('li');
    li.className = 'clip';
    li.id = 'clip-' + s.id;
    li.style.setProperty('--c', `var(--c-${s.cat})`);
    li.innerHTML = `
      <div class="screen"><canvas aria-hidden="true"></canvas></div>
      <div class="info">
        <div class="meta">
          <span dir="ltr">#${num(i)}</span><span dir="ltr">${s.fps} fps</span>
          <span class="tc"><span class="rec"></span><span class="tc-val" dir="ltr">00:00</span></span>
        </div>
        <h3><button type="button" aria-haspopup="dialog">${s.he}</button></h3>
        <p class="en" lang="en" dir="ltr">${s.en}</p>
        <p class="desc">${s.desc}</p>
        <div class="tagrow">
          <span class="dot"></span><span>${catById[s.cat].he}</span>
          <span class="level" role="img" aria-label="מורכבות ${LEVELS[s.level]}" title="מורכבות ${LEVELS[s.level]}">
            ${[1, 2, 3].map((k) => `<i class="${k <= s.level ? 'on' : ''}"></i>`).join('')}
          </span>
        </div>
      </div>`;
    grid.appendChild(li);
    const canvas = li.querySelector('canvas');
    const clip = {
      s, i, li, canvas,
      ctx: canvas.getContext('2d'),
      tcEl: li.querySelector('.tc-val'),
      btn: li.querySelector('h3 button'),
      scratch: {},
      offset: (i * 0.618 * s.dur) % s.dur,
      visible: false,
      hidden: false,
      dirty: true,
      lastF: -1,
      tcText: '',
    };
    clip.btn.addEventListener('click', () => openViewer(i));
    li.querySelector('.screen')._clip = clip;
    return clip;
  });

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const c = e.target._clip;
        c.visible = e.isIntersecting;
        if (c.visible) c.dirty = true;
      }
    },
    { rootMargin: '160px 0px' }
  );
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const c = e.target._clip;
      const box = e.contentRect;
      if (sizeCanvas(c.canvas, box.width, box.height, GRID_DPR)) c.dirty = true;
    }
  });
  clips.forEach((c) => {
    const screen = c.li.querySelector('.screen');
    io.observe(screen);
    ro.observe(screen);
  });

  function clipTime(c) {
    if (!state.started) return posterOf(c.s);
    return (state.time + c.offset) % c.s.dur;
  }
  function drawClip(c) {
    const t = clipTime(c), f = Math.floor(t * Math.min(c.s.fps, 30));
    if (f === c.lastF && !c.dirty) return;
    c.lastF = f;
    c.dirty = false;
    render(c.s, c.ctx, c.canvas, t, c.scratch);
    const tc = tcShort(t, c.s.fps);
    if (tc !== c.tcText) {
      c.tcEl.textContent = tc;
      c.tcText = tc;
    }
  }
  const markAllDirty = () => clips.forEach((c) => (c.dirty = true));

  /* ---------------- filters ---------------- */
  const normalize = (str) =>
    str.toLowerCase().replace(/[֑-ׇ]/g, '').replace(/[׳״'"’`]/g, '').replace(/\s+/g, ' ').trim();
  const index = STYLES.map((s) =>
    normalize([s.he, s.en, s.desc, s.uses, s.how, s.tools.join(' '), catById[s.cat].he, catById[s.cat].en].join(' '))
  );

  const chipsEl = $('chips');
  const chipDefs = [{ id: 'all', he: 'הכול', n: STYLES.length }].concat(
    CATS.map((c) => ({ ...c, n: STYLES.filter((s) => s.cat === c.id).length }))
  );
  const chips = chipDefs.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('aria-pressed', c.id === 'all' ? 'true' : 'false');
    if (c.id !== 'all') b.style.setProperty('--c', `var(--c-${c.id})`);
    b.innerHTML = `${c.id !== 'all' ? '<span class="dot"></span>' : ''}<span>${c.he}</span><span class="n">${c.n}</span>`;
    b.addEventListener('click', () => {
      state.cat = c.id;
      chips.forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      applyFilter();
    });
    chipsEl.appendChild(b);
    return b;
  });

  const ruler = $('ruler'), playhead = $('playhead');
  const ticks = STYLES.map((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.tabIndex = -1;
    b.className = 'tick' + ((i + 1) % 5 === 0 || i === 0 ? ' major' : '');
    b.style.setProperty('--c', `var(--c-${s.cat})`);
    b.title = `#${num(i)} ${s.he}`;
    if ((i + 1) % 5 === 0 || i === 0) b.innerHTML = `<span class="n">${num(i)}</span>`;
    b.addEventListener('click', () => openViewer(i));
    ruler.appendChild(b);
    return b;
  });

  const qInput = $('q');
  qInput.addEventListener('input', () => {
    state.q = qInput.value;
    applyFilter();
  });
  $('reset').addEventListener('click', () => {
    qInput.value = '';
    state.q = '';
    state.cat = 'all';
    chips.forEach((x, k) => x.setAttribute('aria-pressed', k === 0 ? 'true' : 'false'));
    applyFilter();
    qInput.focus();
  });

  function applyFilter() {
    const words = normalize(state.q).split(' ').filter(Boolean);
    let shown = 0;
    clips.forEach((c, i) => {
      const ok = (state.cat === 'all' || c.s.cat === state.cat) && words.every((w) => index[i].includes(w));
      c.hidden = !ok;
      c.li.hidden = !ok;
      ticks[i].classList.toggle('dim', !ok);
      if (ok) {
        shown++;
        c.dirty = true;
      }
    });
    $('count').textContent = `${shown} / ${STYLES.length}`;
    $('empty').hidden = shown > 0;
    if (!shown) $('empty-text').textContent = `לא נמצא סגנון שמתאים ל"${state.q.trim()}" בקטגוריה שנבחרה.`;
    queuePlayhead();
  }

  /* playhead follows the first card in view */
  let phQueued = false;
  function queuePlayhead() {
    if (phQueued) return;
    phQueued = true;
    requestAnimationFrame(() => {
      phQueued = false;
      const tb = document.querySelector('.toolbar').getBoundingClientRect();
      const top = getComputedStyle(document.querySelector('.toolbar')).position === 'sticky' ? tb.bottom : 0;
      let target = null;
      for (const c of clips) {
        if (c.hidden) continue;
        const r = c.li.getBoundingClientRect();
        if (r.bottom > top + 40) { target = c; break; }
      }
      if (!target) return;
      const tk = ticks[target.i];
      playhead.style.left = `${tk.offsetLeft + tk.offsetWidth / 2}px`;
    });
  }
  window.addEventListener('scroll', queuePlayhead, { passive: true });
  window.addEventListener('resize', queuePlayhead);

  /* play / pause all */
  const playAllBtn = $('play-all');
  const PAUSE_ICON = '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
  const PLAY_ICON = '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z"/>';
  function syncPlayAll() {
    $('play-all-icon').innerHTML = state.playing ? PAUSE_ICON : PLAY_ICON;
    $('play-all-label').textContent = state.playing ? 'השהיית הקליפים' : 'הפעלת הקליפים';
    playAllBtn.setAttribute('aria-pressed', state.playing ? 'false' : 'true');
  }
  playAllBtn.addEventListener('click', () => {
    state.playing = !state.playing;
    state.started = true;
    syncPlayAll();
    markAllDirty();
  });
  syncPlayAll();

  /* theme */
  const themeBtn = $('theme-btn');
  const isDark = () => {
    const a = root.getAttribute('data-theme');
    return a ? a === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const syncTheme = () => ($('theme-label').textContent = isDark() ? 'מצב בהיר' : 'מצב כהה');
  try {
    const saved = localStorage.getItem('mg-theme');
    if (saved && !root.hasAttribute('data-theme')) root.setAttribute('data-theme', saved);
  } catch (e) { /* storage unavailable */ }
  themeBtn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('mg-theme', next); } catch (e) { /* storage unavailable */ }
    syncTheme();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', syncTheme);
  new MutationObserver(syncTheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  syncTheme();

  /* ---------------- viewer ---------------- */
  const dlg = $('viewer');
  const vCanvas = $('v-canvas');
  const V = {
    open: false,
    idx: 0,
    t: 0,
    playing: !reduceMotion,
    speed: 1,
    ctx: vCanvas.getContext('2d'),
    scratch: {},
    dirty: true,
    lastF: -1,
    scrubbing: false,
    mode: 'live',
  };

  new ResizeObserver((entries) => {
    const box = entries[0].contentRect;
    if (sizeCanvas(vCanvas, box.width, box.height, VIEW_DPR)) V.dirty = true;
  }).observe(vCanvas);

  function navList() {
    const visible = clips.filter((c) => !c.hidden).map((c) => c.i);
    return visible.includes(V.idx) ? visible : clips.map((c) => c.i);
  }
  function neighbor(step) {
    const list = navList(), k = list.indexOf(V.idx);
    return list[(k + step + list.length) % list.length];
  }

  function openViewer(i) {
    const s = STYLES[i];
    V.idx = i;
    V.t = V.playing ? 0 : posterOf(s);
    V.scratch = {};
    V.dirty = true;
    V.lastF = -1;
    $('v-no').textContent = `#${num(i)} / ${STYLES.length}`;
    const cat = $('v-cat');
    cat.style.setProperty('--c', `var(--c-${s.cat})`);
    cat.lastElementChild.textContent = catById[s.cat].he;
    $('v-title').textContent = s.he;
    $('v-en').textContent = s.en;
    $('v-desc').textContent = s.desc;
    $('v-fps').textContent = `${s.fps} fps`;
    $('v-len').textContent = `${s.dur} שנ׳`;
    $('v-level').textContent = LEVELS[s.level];
    $('v-uses').textContent = s.uses;
    $('v-how').textContent = s.how;
    $('v-tools').innerHTML = '';
    s.tools.forEach((tool) => {
      const li = document.createElement('li');
      li.textContent = tool;
      $('v-tools').appendChild(li);
    });
    $('v-yt').href = ytSearch(s);
    $('v-dur').textContent = tcFull(s.dur, s.fps);
    $('v-prev-name').textContent = STYLES[neighbor(-1)].he;
    $('v-next-name').textContent = STYLES[neighbor(1)].he;
    setupVideo(s);
    syncViewerPlay();
    if (!dlg.open) {
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    }
    V.open = true;
    try { history.replaceState(null, '', '#' + s.id); } catch (e) { /* sandboxed */ }
  }

  function closeViewer() {
    if (dlg.open) dlg.close();
  }
  dlg.addEventListener('close', () => {
    V.open = false;
    setVideo(null);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* sandboxed */ }
    const c = clips[V.idx];
    if (!c.hidden) {
      c.li.scrollIntoView({ block: 'nearest' });
      c.btn.focus({ preventScroll: true });
    }
    markAllDirty();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) closeViewer();
  });
  $('v-close').addEventListener('click', closeViewer);
  $('v-prev').addEventListener('click', () => openViewer(neighbor(-1)));
  $('v-next').addEventListener('click', () => openViewer(neighbor(1)));

  /* optional real video per style */
  function youTubeId(url) {
    const m = String(url).match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{11})/);
    return m ? m[1] : null;
  }
  function setVideo(s) {
    const box = $('v-video');
    box.innerHTML = '';
    if (!s || !s.video) return;
    const yt = youTubeId(s.video);
    if (yt) {
      const f = document.createElement('iframe');
      f.src = `https://www.youtube-nocookie.com/embed/${yt}?rel=0`;
      f.title = s.he;
      f.allow = 'accelerometer; autoplay; encrypted-media; picture-in-picture; fullscreen';
      f.allowFullscreen = true;
      f.style.cssText = 'width:100%;height:100%;border:0';
      box.appendChild(f);
    } else {
      const v = document.createElement('video');
      v.src = s.video;
      v.controls = true;
      v.playsInline = true;
      v.style.cssText = 'width:100%;height:100%;background:#000';
      box.appendChild(v);
    }
  }
  function setupVideo(s) {
    const has = Boolean(s.video);
    $('v-tabs').hidden = !has;
    setMode('live');
    setVideo(has ? s : null);
  }
  function setMode(mode) {
    V.mode = mode;
    $('tab-live').setAttribute('aria-selected', mode === 'live' ? 'true' : 'false');
    $('tab-video').setAttribute('aria-selected', mode === 'video' ? 'true' : 'false');
    $('v-video').hidden = mode !== 'video';
    vCanvas.hidden = mode === 'video';
    $('v-transport').hidden = mode === 'video';
    if (mode === 'video') {
      V.playing = false;
      syncViewerPlay();
    }
  }
  $('tab-live').addEventListener('click', () => setMode('live'));
  $('tab-video').addEventListener('click', () => setMode('video'));

  /* transport */
  const vPlay = $('v-play'), scrub = $('v-scrub');
  function syncViewerPlay() {
    $('v-play-icon').innerHTML = V.playing ? PAUSE_ICON : PLAY_ICON;
    vPlay.setAttribute('aria-label', V.playing ? 'השהיה' : 'ניגון');
  }
  function togglePlay() {
    V.playing = !V.playing;
    syncViewerPlay();
  }
  function stepFrame(dir) {
    const s = STYLES[V.idx];
    V.playing = false;
    syncViewerPlay();
    const f = Math.round(V.t * s.fps) + dir, total = Math.round(s.dur * s.fps);
    V.t = (((f % total) + total) % total) / s.fps;
    V.dirty = true;
  }
  vPlay.addEventListener('click', togglePlay);
  scrub.addEventListener('pointerdown', () => (V.scrubbing = true));
  window.addEventListener('pointerup', () => (V.scrubbing = false));
  scrub.addEventListener('input', () => {
    V.t = (scrub.value / 1000) * STYLES[V.idx].dur * 0.9999;
    V.dirty = true;
  });
  document.querySelectorAll('.speed button').forEach((b) => {
    b.addEventListener('click', () => {
      V.speed = Number(b.dataset.speed);
      document.querySelectorAll('.speed button').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    });
  });
  const vScreen = $('v-screen'), fsBtn = $('v-fs');
  if (!document.fullscreenEnabled || !vScreen.requestFullscreen) fsBtn.hidden = true;
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else vScreen.requestFullscreen().catch(() => {});
  });

  dlg.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    const inRange = e.target === scrub;
    if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'A') {
      e.preventDefault();
      togglePlay();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !inRange) {
      e.preventDefault();
      // In Hebrew the next item sits to the left.
      openViewer(neighbor(e.key === 'ArrowLeft' ? 1 : -1));
    } else if (e.key === ',' || e.key === '.') {
      e.preventDefault();
      stepFrame(e.key === '.' ? 1 : -1);
    }
  });

  function tickViewer(dt) {
    const s = STYLES[V.idx];
    if (V.mode !== 'live') return;
    if (V.playing && !V.scrubbing) {
      V.t = (V.t + dt * V.speed) % s.dur;
    }
    const f = Math.floor(V.t * Math.max(s.fps, 60));
    if (f === V.lastF && !V.dirty) return;
    V.lastF = f;
    V.dirty = false;
    render(s, V.ctx, vCanvas, V.t, V.scratch);
    $('v-tc').textContent = tcFull(V.t, s.fps);
    if (!V.scrubbing) scrub.value = String(Math.round((V.t / s.dur) * 1000));
  }

  /* ---------------- main loop ---------------- */
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    // While the player is open the grid holds still, but clips that scrolled into view still get one frame.
    if (V.open) tickViewer(dt);
    else if (state.playing) state.time += dt;
    for (const c of clips) if (c.visible && !c.hidden) drawClip(c);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* Redraw once the web fonts arrive, since canvas text doesn't reflow by itself. */
  const fontLoads = document.fonts && document.fonts.load
    ? Promise.all([
        document.fonts.load('700 40px "Karantina"', 'אבג ABC'),
        document.fonts.load('400 40px "IBM Plex Sans Hebrew"', 'אבג ABC'),
        document.fonts.load('500 40px "IBM Plex Sans Hebrew"', 'אבג ABC'),
        document.fonts.load('600 40px "IBM Plex Sans Hebrew"', 'אבג ABC'),
        document.fonts.load('700 40px "IBM Plex Sans Hebrew"', 'אבג ABC'),
        document.fonts.load('500 40px "IBM Plex Mono"', 'ABC 123'),
      ])
    : Promise.resolve();
  Promise.race([fontLoads, new Promise((r) => setTimeout(r, 3000))])
    .catch(() => {})
    .then(() => {
      MGR.fontsReady++;
      markAllDirty();
      V.dirty = true;
    });

  applyFilter();

  /* deep link: #glitch opens that clip */
  const fromHash = decodeURIComponent(location.hash.slice(1));
  const linked = STYLES.findIndex((s) => s.id === fromHash);
  if (linked >= 0) openViewer(linked);
})();
