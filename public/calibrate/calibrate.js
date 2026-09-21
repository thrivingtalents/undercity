/**
 * MAP CALIBRATION (2026-09-21) — a human measuring the city once, so no screen
 * has to guess it ever again.
 *
 * Everything on this page is normalised: a click at the middle of the video's
 * image is 0.5, 0.5 whatever the window is doing. The picture's real rectangle
 * comes from the same shared module the Big Screen uses (MapOverlay.track), so
 * a point dropped here lands in the same place on a 4K projector.
 *
 * Nothing is inferred. No edge detection, no centroids standing in for a
 * measurement, no coordinates carried over from the painted map this video
 * replaced. What is saved is what was clicked.
 */
(function () {
  'use strict';

  const M = window.MapOverlay;
  const $ = (id) => document.getElementById(id);
  const MEDIA_URL = '/config/big-screen-map.json';
  const SECTORS = [
    ['POW', 'Power Grid'], ['WTR', 'Water & Filtration'], ['MED', 'Medical Bay'],
    ['TRN', 'Transport & Tunnels'], ['AGR', 'Agriculture'], ['COM', 'Comms & Sensors'],
  ];
  const NAME = Object.fromEntries(SECTORS);
  const HINTS = {
    point: "Click the corners of this sector's platform. Drag any point to move it. The polygon closes itself.",
    label: 'Click where the status word should sit — usually just above the platform, clear of the artwork.',
    'core-from': 'Click where the connection to the Core leaves this sector.',
    'core-to': 'Click where it meets the Core.',
  };

  let token = '';
  let session = '';
  let doc = { version: 1, sectors: {} };      // the working copy
  let saved = '{}';                           // what the server last confirmed
  let current = 'POW';
  let mode = 'point';
  let previewState = 'brownout';
  let previewAll = false;
  let dragging = null;
  let tracker = null;

  // -- context ----------------------------------------------------------------

  (function readContext() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts[0] === 's' && parts[1]) session = parts[1].toUpperCase();
    const qs = new URLSearchParams(location.search);
    token = qs.get('token') || '';
  }());

  const api = (path) => `${path}?${new URLSearchParams({ token, ...(session ? { session } : {}) })}`;

  // -- the gate ---------------------------------------------------------------

  function openTool() {
    $('token-gate').classList.add('hidden');
    $('shell').classList.remove('hidden');
    start();
  }

  $('token-form').addEventListener('submit', (e) => {
    e.preventDefault();
    token = $('token-input').value.trim();
    if (!token) return;
    // The token is proven by asking the gated endpoint for the file it guards.
    fetch(api('/api/content')).then((r) => {
      if (!r.ok) { $('token-error').classList.remove('hidden'); return; }
      const url = new URL(location.href);
      url.searchParams.set('token', token);
      history.replaceState(null, '', url);
      openTool();
    }).catch(() => $('token-error').classList.remove('hidden'));
  });

  if (token) openTool(); else $('token-input').focus();

  // -- the stage --------------------------------------------------------------

  function start() {
    buildTabs();
    wireControls();

    const video = $('map-video');
    fetch(MEDIA_URL, { cache: 'no-cache' })
      .then((r) => r.json())
      .then((cfg) => {
        const m = (cfg && cfg.mapDisplay) || {};
        if (m.source) video.src = m.source;
        video.style.objectFit = m.fit || 'contain';
        video.style.objectPosition = m.position || 'center';
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
        setText($('media-note'), `${m.source || 'no media'} · fit ${m.fit || 'contain'}`);
      })
      .catch(() => setText($('media-note'), 'map media config unavailable'));

    // The overlay, the labels and the editing handles all sit on the video's
    // real image rectangle — not on the element, which is letterboxed.
    tracker = M.track($('media'), video, $('overlay'), {
      onChange: (rect) => {
        for (const el of [$('labels'), $('editor')]) {
          el.style.left = `${rect.x}px`;
          el.style.top = `${rect.y}px`;
          el.style.width = `${rect.width}px`;
          el.style.height = `${rect.height}px`;
        }
        readout();
      },
    });

    $('editor').addEventListener('pointerdown', onPointerDown);
    $('editor').addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKey);

    reload();
  }

  function reload() {
    M.loadRegions().then((d) => {
      doc = { version: d.version || 1, media: d.media, sectors: d.sectors || {} };
      saved = JSON.stringify(doc.sectors);
      render();
    });
  }

  // -- controls ---------------------------------------------------------------

  function buildTabs() {
    const host = $('sector-tabs');
    host.innerHTML = '';
    for (const [code, label] of SECTORS) {
      const b = document.createElement('button');
      b.dataset.sector = code;
      b.innerHTML = `<b>${code}</b><span>${label}</span>`;
      b.addEventListener('click', () => { current = code; mode = 'point'; render(); });
      host.appendChild(b);
    }
  }

  function wireControls() {
    for (const b of $('modes').querySelectorAll('[data-mode]')) {
      b.addEventListener('click', () => { mode = b.dataset.mode; render(); });
    }
    for (const b of $('states').querySelectorAll('[data-state]')) {
      b.addEventListener('click', () => { previewState = b.dataset.state; render(); });
    }
    $('preview-all').addEventListener('change', (e) => { previewAll = e.target.checked; render(); });
    $('btn-undo').addEventListener('click', undoPoint);
    $('btn-clear').addEventListener('click', () => { region(current).polygon = []; render(); });
    $('btn-close-poly').addEventListener('click', () => { mode = 'label'; render(); });
    $('btn-clear-label').addEventListener('click', () => { delete region(current).statusLabel; render(); });
    $('btn-clear-core').addEventListener('click', () => { delete region(current).coreConnection; render(); });
    $('btn-reset').addEventListener('click', () => {
      if (dirty() && !confirm('Throw away every unsaved change and reload the saved regions?')) return;
      reload();
    });
    $('btn-save').addEventListener('click', save);
    $('btn-apply-json').addEventListener('click', applyJson);
  }

  function onKey(e) {
    if ($('shell').classList.contains('hidden')) return;
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undoPoint(); }
    if (e.key === 'Escape') { mode = 'point'; render(); }
    const i = Number(e.key);
    if (i >= 1 && i <= 6) { current = SECTORS[i - 1][0]; render(); }
  }

  // -- the working document ---------------------------------------------------

  function region(code) {
    if (!doc.sectors[code]) doc.sectors[code] = { id: code, label: NAME[code], polygon: [] };
    if (!Array.isArray(doc.sectors[code].polygon)) doc.sectors[code].polygon = [];
    doc.sectors[code].label = doc.sectors[code].label || NAME[code];
    return doc.sectors[code];
  }
  const dirty = () => JSON.stringify(doc.sectors) !== saved;
  function undoPoint() {
    const r = region(current);
    if (r.polygon.length) r.polygon.pop();
    render();
  }

  // -- pointer work on the image ----------------------------------------------

  /** A pointer event in normalised image coordinates, clamped to the picture. */
  function at(e) {
    const box = $('editor').getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
    return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
  }

  function onPointerDown(e) {
    const p = at(e);
    if (!p) return;
    const handle = e.target && e.target.getAttribute && e.target.getAttribute('data-handle');
    if (handle !== null && handle !== undefined && handle !== '') {
      dragging = Number(handle);
      $('editor').setPointerCapture(e.pointerId);
      return;
    }
    const r = region(current);
    if (mode === 'point') r.polygon.push(p);
    else if (mode === 'label') r.statusLabel = { x: p[0], y: p[1] };
    else if (mode === 'core-from') r.coreConnection = { from: p, to: (r.coreConnection && r.coreConnection.to) || p };
    else if (mode === 'core-to') r.coreConnection = { from: (r.coreConnection && r.coreConnection.from) || p, to: p };
    render();
  }

  function onPointerMove(e) {
    const p = at(e);
    if (!p) return;
    readout(p);
    if (dragging === null || dragging === undefined) return;
    const r = region(current);
    if (r.polygon[dragging]) { r.polygon[dragging] = p; render(); }
  }

  function onPointerUp() { dragging = null; }

  function readout(p) {
    const rect = tracker ? tracker.rect : { width: 0, height: 0 };
    const where = p ? `x ${p[0].toFixed(4)}  y ${p[1].toFixed(4)}` : 'move over the map';
    setText($('readout'), `${where}   ·   image ${Math.round(rect.width)}×${Math.round(rect.height)} px   ·   ${region(current).polygon.length} point(s) on ${current}`);
  }

  // -- render -----------------------------------------------------------------

  function render() {
    for (const b of $('sector-tabs').querySelectorAll('[data-sector]')) {
      b.classList.toggle('on', b.dataset.sector === current);
      b.classList.toggle('done', M.isCalibrated(doc.sectors[b.dataset.sector]));
    }
    for (const b of $('modes').querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === mode);
    for (const b of $('states').querySelectorAll('[data-state]')) b.classList.toggle('on', b.dataset.state === previewState);
    setText($('sel-name'), `${current} — ${NAME[current]}`);
    setText($('mode-hint'), HINTS[mode]);
    $('dirty-pill').hidden = !dirty();

    // The preview: the shared painter, exactly as the Big Screen calls it.
    const states = {};
    if (previewAll) for (const [code] of SECTORS) states[code] = previewState;
    else states[current] = previewState;
    M.paint($('overlay'), $('labels'), doc, states);

    drawEditor();
    drawStatus();
    $('json-view').value = JSON.stringify(doc.sectors, null, 2);
    readout();
  }

  /** The handles: the polygon being built, its points, the anchor, the core link. */
  function drawEditor() {
    const svg = $('editor');
    svg.innerHTML = '';
    const r = doc.sectors[current] || { polygon: [] };
    const poly = r.polygon || [];
    if (poly.length >= 2) {
      const shape = document.createElementNS(M.NS, 'polygon');
      shape.setAttribute('class', 'cal-shape');
      shape.setAttribute('points', M.points(poly));
      shape.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(shape);
    }
    poly.forEach(([x, y], i) => {
      const h = document.createElementNS(M.NS, 'circle');
      h.setAttribute('class', 'cal-handle');
      h.setAttribute('data-handle', String(i));
      h.setAttribute('cx', x);
      h.setAttribute('cy', y);
      // The handle is drawn in normalised space, so its radius is given in the
      // two axes separately to keep it round whatever the picture's shape is.
      h.setAttribute('r', 0.008);
      h.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(h);
    });
    if (r.statusLabel) {
      const a = document.createElementNS(M.NS, 'circle');
      a.setAttribute('class', 'cal-anchor');
      a.setAttribute('cx', r.statusLabel.x);
      a.setAttribute('cy', r.statusLabel.y);
      a.setAttribute('r', 0.006);
      a.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(a);
    }
    if (r.coreConnection) {
      const l = document.createElementNS(M.NS, 'line');
      l.setAttribute('class', 'cal-core');
      l.setAttribute('x1', r.coreConnection.from[0]); l.setAttribute('y1', r.coreConnection.from[1]);
      l.setAttribute('x2', r.coreConnection.to[0]); l.setAttribute('y2', r.coreConnection.to[1]);
      l.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(l);
    }
  }

  function drawStatus() {
    const host = $('status-list');
    host.innerHTML = '';
    let done = 0;
    for (const [code, label] of SECTORS) {
      const r = doc.sectors[code];
      const ok = M.isCalibrated(r);
      if (ok) done += 1;
      const row = document.createElement('div');
      row.className = `st-row${ok ? ' ok' : ''}`;
      row.innerHTML = `<b>${code}</b><span>${label}</span><i>${ok ? `${r.polygon.length} pts${r.statusLabel ? ' · anchor' : ''}` : 'NOT CALIBRATED'}</i>`;
      host.appendChild(row);
    }
    const head = document.createElement('div');
    head.className = 'st-count';
    head.textContent = `${done} of 6 calibrated`;
    host.prepend(head);
  }

  // -- save -------------------------------------------------------------------

  function save() {
    const body = { document: { version: doc.version || 1, media: doc.media, sectors: doc.sectors } };
    fetch(api('/api/map-regions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) { note(`REFUSED — ${j.error}${j.detail ? ` (${j.detail})` : ''}`, true); return; }
        doc.sectors = j.document.sectors;
        saved = JSON.stringify(doc.sectors);
        note(`SAVED · ${6 - (j.missing || []).length} of 6 calibrated${(j.missing || []).length ? ` · missing ${j.missing.join(', ')}` : ''}`);
        render();
      })
      .catch((err) => note(`SAVE FAILED — ${err.message}`, true));
  }

  function applyJson() {
    try {
      const parsed = JSON.parse($('json-view').value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object of sectors');
      doc.sectors = parsed;
      note('JSON applied to the working copy — SAVE writes it');
      render();
    } catch (err) {
      note(`BAD JSON — ${err.message}`, true);
    }
  }

  function note(text, bad = false) {
    const el = $('json-note');
    setText(el, text);
    el.classList.toggle('bad', !!bad);
  }

  function setText(el, s) { if (el && el.textContent !== s) el.textContent = s; }
}());
