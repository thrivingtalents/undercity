/**
 * THE MAP OVERLAY (2026-09-21) — normalised sector regions drawn on the exact
 * rectangle the map media actually occupies.
 *
 * The problem this solves: the map is a fixed-camera video shown with
 * `object-fit: contain`, so the image inside the element is letterboxed by
 * whatever the viewport happens to be. An overlay pinned to the ELEMENT drifts
 * off the city the moment the window is not the video's aspect ratio; an
 * overlay pinned to the IMAGE never does. Everything here exists to find that
 * image rectangle and keep the SVG on it — on resize, on fullscreen, on an
 * orientation change, and when the video's own dimensions arrive late.
 *
 * Coordinates are normalised 0..1 of the image. Nothing in here knows a pixel
 * of anybody's monitor, and nothing here guesses where a sector is: regions
 * come from mapConfig/haven9-map-regions.json, measured by hand at /calibrate.
 *
 * Both the Big Screen and the calibration tool use this same file, so what the
 * facilitator clicks is, to the pixel, what the room sees.
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const REGIONS_URL = '/config/haven9-map-regions.json';
  const SECTOR_IDS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];

  /**
   * The rectangle the media's IMAGE occupies inside its element, for
   * `object-fit: contain`. Returns pixel offsets relative to the element's own
   * box, plus the scale, so a caller can place an absolutely positioned SVG
   * exactly on the picture and nowhere else.
   */
  function containRect(boxW, boxH, mediaW, mediaH) {
    const bw = Math.max(0, Number(boxW) || 0);
    const bh = Math.max(0, Number(boxH) || 0);
    const mw = Number(mediaW) || 0;
    const mh = Number(mediaH) || 0;
    if (!bw || !bh || !mw || !mh) return { x: 0, y: 0, width: bw, height: bh, scale: 1 };
    const scale = Math.min(bw / mw, bh / mh);
    const width = mw * scale;
    const height = mh * scale;
    return { x: (bw - width) / 2, y: (bh - height) / 2, width, height, scale };
  }

  /** The intrinsic size of whatever is showing: the video, or an image fallback. */
  function mediaSize(media) {
    if (!media) return null;
    const w = Number(media.videoWidth || media.naturalWidth || 0);
    const h = Number(media.videoHeight || media.naturalHeight || 0);
    return w > 0 && h > 0 ? { w, h } : null;
  }

  /**
   * Keep an absolutely positioned overlay element sitting exactly on the
   * media's displayed image. Recomputes on every event that can move it and
   * returns a handle with { update, stop, rect }.
   */
  function track(container, media, overlay, { onChange = null } = {}) {
    let rect = { x: 0, y: 0, width: 0, height: 0, scale: 1 };

    function update() {
      if (!container || !overlay) return rect;
      const box = container.getBoundingClientRect();
      const size = mediaSize(media) || { w: 16, h: 9 };   // before metadata lands, 16:9 is the shape of the clip
      const next = containRect(box.width, box.height, size.w, size.h);
      const same = Math.abs(next.x - rect.x) < 0.5 && Math.abs(next.y - rect.y) < 0.5
        && Math.abs(next.width - rect.width) < 0.5 && Math.abs(next.height - rect.height) < 0.5;
      rect = next;
      if (same) return rect;
      overlay.style.position = 'absolute';
      overlay.style.left = `${next.x}px`;
      overlay.style.top = `${next.y}px`;
      overlay.style.width = `${next.width}px`;
      overlay.style.height = `${next.height}px`;
      if (onChange) onChange(rect);
      return rect;
    }

    const events = [
      [global, 'resize'], [global, 'orientationchange'],
      [document, 'fullscreenchange'], [document, 'webkitfullscreenchange'], [document, 'visibilitychange'],
    ];
    for (const [target, ev] of events) target.addEventListener(ev, update);
    // The video's own dimensions arrive after the element does; a fallback
    // image's arrive on load. Both move the picture, so both re-measure.
    if (media) for (const ev of ['loadedmetadata', 'loadeddata', 'load', 'resize', 'playing']) media.addEventListener(ev, update);
    // A panel that changes size without the window changing — a sidebar
    // opening, a takeover appearing — is the case events alone never catch.
    let ro = null;
    if (global.ResizeObserver && container) {
      ro = new global.ResizeObserver(update);
      ro.observe(container);
    }
    // A layout settles over more than one frame — a fullscreen change, a panel
    // animating, a video whose metadata lands late — so the frame after a move
    // is re-measured too.
    const settle = () => global.requestAnimationFrame(() => update());
    for (const [target, ev] of events) target.addEventListener(ev, settle);
    // And a last guarantee for a screen nobody is watching: a cheap check twice
    // a second that costs one getBoundingClientRect and writes nothing unless
    // the picture has actually moved. A projector left running all evening can
    // never end up with the city dimmed in the wrong place.
    const beat = global.setInterval(update, 2000);
    update();

    return {
      update,
      get rect() { return rect; },
      stop() {
        global.clearInterval(beat);
        for (const [target, ev] of events) { target.removeEventListener(ev, update); target.removeEventListener(ev, settle); }
        if (media) for (const ev of ['loadedmetadata', 'loadeddata', 'load', 'resize', 'playing']) media.removeEventListener(ev, update);
        if (ro) ro.disconnect();
      },
    };
  }

  /**
   * An overlay SVG whose user space IS the normalised image: viewBox 0 0 1 1,
   * `preserveAspectRatio="none"`. Because the element is sized to the image by
   * `track()`, a point at 0.5,0.5 is the middle of the picture at every
   * resolution, and no renderer ever touches a pixel.
   */
  function createOverlay(className = 'map-overlay') {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 1 1');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    svg.style.pointerEvents = 'none';
    return svg;
  }

  const points = (poly) => (poly || []).map(([x, y]) => `${x},${y}`).join(' ');

  /** Centroid of a polygon — used only where a region has no saved label anchor. */
  function centroid(poly) {
    if (!poly || !poly.length) return { x: 0.5, y: 0.5 };
    let x = 0; let y = 0;
    for (const [px, py] of poly) { x += px; y += py; }
    return { x: x / poly.length, y: y / poly.length };
  }

  /** Where a sector's status word belongs: its saved anchor, or its centre. */
  function labelAnchor(region) {
    if (region && region.statusLabel && typeof region.statusLabel.x === 'number') {
      return { x: region.statusLabel.x, y: region.statusLabel.y };
    }
    return centroid(region && region.polygon);
  }

  function isCalibrated(region) {
    return !!(region && Array.isArray(region.polygon) && region.polygon.length >= 3
      && region.polygon.every((p) => Array.isArray(p) && p.length === 2
        && p.every((n) => typeof n === 'number' && n >= 0 && n <= 1)));
  }

  /** Fetch the calibrated regions. A build with none reads as an empty set, never as a guess. */
  function loadRegions(url = REGIONS_URL) {
    return fetch(url, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((doc) => ({ ...doc, sectors: (doc && doc.sectors) || {} }))
      .catch(() => ({ version: 0, sectors: {} }));
  }

  /**
   * THE STATE VISUALS, in one place so the calibration tool and the Big Screen
   * cannot drift apart. One group per sector, drawn only from that sector's own
   * saved polygon: two sectors in BROWNOUT are two overlays and two labels,
   * never one shape stretched across the space between them.
   *
   * NORMAL draws nothing at all. An uncalibrated sector draws nothing either,
   * and is returned in `missing` so Admin can be told.
   */
  const STATE_WORD = { brownout: 'BROWNOUT', dark: 'DARK', critical: 'CRITICAL', degraded: '', normal: '', stable: '' };

  function paint(svg, labelLayer, regions, states, { showLabels = true } = {}) {
    const sectors = (regions && regions.sectors) || {};
    const missing = [];
    const seen = new Set();

    for (const [code, raw] of Object.entries(states || {})) {
      const state = String(raw || 'normal').toLowerCase();
      const region = sectors[code];
      if (!isCalibrated(region)) {
        // A missing region is reported, never invented: a wrong overlay tells
        // the room a lie about which part of the city is in trouble.
        if (state !== 'normal' && state !== 'stable') missing.push(code);
        continue;
      }
      seen.add(code);
      let g = svg.querySelector(`[data-region="${code}"]`);
      if (!g) {
        g = document.createElementNS(NS, 'g');
        g.setAttribute('data-region', code);
        g.setAttribute('class', 'mo-region');
        const dim = document.createElementNS(NS, 'polygon');
        dim.setAttribute('class', 'mo-dim');
        const edge = document.createElementNS(NS, 'polygon');
        edge.setAttribute('class', 'mo-edge');
        edge.setAttribute('vector-effect', 'non-scaling-stroke');
        const link = document.createElementNS(NS, 'line');
        link.setAttribute('class', 'mo-link');
        link.setAttribute('vector-effect', 'non-scaling-stroke');
        g.appendChild(dim); g.appendChild(edge); g.appendChild(link);
        svg.appendChild(g);
      }
      const pts = points(region.polygon);
      g.querySelector('.mo-dim').setAttribute('points', pts);
      g.querySelector('.mo-edge').setAttribute('points', pts);
      const link = g.querySelector('.mo-link');
      if (region.coreConnection) {
        link.setAttribute('x1', region.coreConnection.from[0]);
        link.setAttribute('y1', region.coreConnection.from[1]);
        link.setAttribute('x2', region.coreConnection.to[0]);
        link.setAttribute('y2', region.coreConnection.to[1]);
        link.style.display = '';
      } else {
        link.style.display = 'none';
      }
      if (g.dataset.state !== state) g.dataset.state = state;
    }

    // A sector no longer in the frame leaves the map with it.
    for (const g of [...svg.querySelectorAll('[data-region]')]) {
      if (!seen.has(g.getAttribute('data-region'))) g.remove();
    }

    if (labelLayer && showLabels) paintLabels(labelLayer, sectors, states);
    return { missing };
  }

  /**
   * The status words. HTML, not SVG text: the overlay's user space is the
   * normalised image, which is deliberately non-uniform, and a word stretched
   * by the viewport's aspect ratio would be unreadable. These sit on the same
   * rectangle and are positioned as a percentage of it, so they scale with the
   * picture and stay the right shape.
   */
  function paintLabels(layer, sectors, states) {
    const wanted = new Map();
    for (const [code, raw] of Object.entries(states || {})) {
      const state = String(raw || 'normal').toLowerCase();
      const word = STATE_WORD[state] || '';
      if (!word) continue;
      const region = sectors[code];
      if (!isCalibrated(region)) continue;
      wanted.set(code, { word, state, at: labelAnchor(region) });
    }
    for (const el of [...layer.querySelectorAll('[data-label]')]) {
      if (!wanted.has(el.getAttribute('data-label'))) el.remove();
    }
    for (const [code, spec] of wanted) {
      let el = layer.querySelector(`[data-label="${code}"]`);
      if (!el) {
        el = document.createElement('div');
        el.setAttribute('data-label', code);
        el.className = 'mo-word';
        layer.appendChild(el);
      }
      if (el.textContent !== spec.word) el.textContent = spec.word;
      if (el.dataset.state !== spec.state) el.dataset.state = spec.state;
      el.style.left = `${spec.at.x * 100}%`;
      el.style.top = `${spec.at.y * 100}%`;
    }
  }

  const api = {
    NS, REGIONS_URL, SECTOR_IDS, STATE_WORD,
    containRect, mediaSize, track, createOverlay, points, centroid, labelAnchor, isCalibrated, loadRegions,
    paint, paintLabels,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MapOverlay = api;
}(typeof globalThis !== 'undefined' ? globalThis : window));
