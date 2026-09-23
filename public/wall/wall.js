'use strict';
/**
 * CITY WALL — the participant Big Screen of HAVEN-9. Display-only.
 *
 * Four bands, top to bottom: the command bar (phase, CURRENT ROUND, CORE
 * STABILITY, MASTER TIME, LIVE), an alert strip drawn only while something
 * needs the room, the city beside its six health monitors, and COM's city
 * broadcast. The city is the hero: the illustration in
 * public/wall/art/haven9-map.png with everything alive drawn over it in an
 * SVG that uses the artwork's own pixel grid (1672×941), so each overlay is
 * traced straight from the painting — a live label on each callout, a state
 * tint on each district's footprint, a state word under the label when a
 * district is CRITICAL, DARK or in BROWNOUT, a fault badge on the rock, a
 * route that lights only while a transfer moves, and a Core that glows with
 * its stability.
 *
 * Every value is the server's: sector health and its status word, the round
 * and its clock, core stability, the COM board with its round stamp, open
 * transfers. Presentation — a card's state, the alerts and their order, the
 * freshness line, a route's phase — is DERIVED on the way to the screen by
 * /shared/bigscreen.js, which the tests run too. Nothing here is stored as a
 * second truth, and nothing here reads real inventory.
 *
 * Rendering split:
 *   buildMap() / buildCards()  once
 *   render()                   per state frame — keyed updates only
 *   tick()                     every 250 ms — clocks, timed overlays, routes
 */
(function wall() {
  const U = window.Undercity;
  const B = window.UndercityBigscreen;
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const CTX = U.context();

  const ALERT_FULL_S = 8;        // mirrors alert_full_screen_s; the frame carries the real value
  const TICK_MS = 250;
  const SHOCK_MS = 4500;
  const CYCLE_FLASH_MS = 3500;
  const ROUND_FLASH_MS = 3000;      // the spec's ceiling, and long enough to read four characters
  const ROUTE_S = 2.6;           // a packet's journey along its route
  const SWEEP_S = 1.4;           // the confirmation sweep at the destination
  const FADE_S = 1.2;            // a cancelled route fading out
  const ART = '/assets/wall/art';
  const MAP = { w: 1672, h: 941, src: `${ART}/haven9-map.png` };
  const MAP_MEDIA_URL = '/config/big-screen-map.json';   // the map's media settings, in one file
  const DEBUG = /[?&]debug/.test(location.search);

  /**
   * Where things are on the illustration, in its pixels.
   *   footprint  the platform outline (state tints, the dark clip, the route anchor)
   *   label      the painted callout's centre and width — the live label covers it
   *   badge      where the fault indicator sits
   */
  const DISTRICTS = {
    POW: { colour: '#E8B33A', name: 'POWER GRID',
      footprint: [[124, 290], [268, 206], [470, 208], [552, 292], [518, 396], [352, 444], [172, 412], [108, 348]],
      label: { x: 240, y: 147, w: 262 }, badge: { x: 240, y: 92 } },
    WTR: { colour: '#3A8FE8', name: 'WATER & FILTRATION',
      footprint: [[572, 142], [698, 74], [1002, 78], [1088, 176], [1030, 266], [760, 286], [598, 236]],
      label: { x: 837, y: 40, w: 340 }, badge: { x: 1120, y: 40 } },
    COM: { colour: '#B07AD8', name: 'COMMS & SENSORS',
      footprint: [[1194, 292], [1300, 210], [1566, 220], [1660, 322], [1600, 426], [1330, 426], [1210, 376]],
      label: { x: 1425, y: 152, w: 316 }, badge: { x: 1425, y: 97 } },
    MED: { colour: '#E85A5A', name: 'MEDICAL BAY',
      footprint: [[104, 562], [240, 470], [500, 480], [586, 588], [520, 722], [270, 746], [120, 682]],
      label: { x: 172, y: 490, w: 252 }, badge: { x: 172, y: 435 } },
    TRN: { colour: '#9A9A9A', name: 'TRANSPORT & TUNNELS',
      footprint: [[520, 692], [660, 596], [1000, 596], [1140, 702], [1060, 862], [720, 892], [560, 812]],
      label: { x: 840, y: 855, w: 356 }, badge: { x: 1120, y: 855 } },
    AGR: { colour: '#5AB86A', name: 'AGRICULTURE',
      footprint: [[1096, 592], [1210, 462], [1600, 472], [1656, 602], [1560, 766], [1260, 792], [1128, 700]],
      label: { x: 1530, y: 493, w: 254 }, badge: { x: 1530, y: 438 } },
  };
  const PANEL_ORDER = B.SECTOR_ORDER;                                // fixed: the room learns where each one lives
  const IDENTITY = B.SECTOR_COLOUR;                                  // who a sector is — never how it is doing
  // The sector gauge, in its own little coordinate space: a ring drawn from
  // twelve o'clock, filled to the sector's health.
  const RING = { box: 100, c: 50, r: 42, circ: Math.round(2 * Math.PI * 42 * 10) / 10 };
  const BUILD_ORDER = ['WTR', 'POW', 'COM', 'MED', 'TRN', 'AGR'];   // paint order on the map
  const CORE = { x: 836, y: 398, r: 96, label: { x: 855, y: 295, w: 300 }, tunnel7: [[838, 548], [838, 612]] };

  let frame = null;
  let frameAt = 0;
  let prevCore = null;
  let prevCycle = null;
  let alertRenderedId = null;
  let shockUntil = 0;
  let cycleFlashUntil = 0;
  let roundFlashUntil = 0;
  let prevRound = null;             // the round the wall last showed
  let broadcastKey = null;
  let booted = false;             // the first frame paints without entry animations
  const districtEls = {};
  const cardEls = {};
  const chipEls = new Map();       // alert key -> element
  const routeEls = new Map();      // transfer id -> { g, path, packet, phase }
  let regions = null;              // the calibrated sector regions, once loaded
  let stateTracker = null;         // keeps the overlay on the video's image
  let missingSig = null;           // what was last reported as uncalibrated

  U.connect({
    hello: { type: 'hello', role: 'bigscreen', session: CTX.session, token: null },
    onState: (next) => { frame = next; frameAt = performance.now(); render(); },
    onMessage: (msg) => { if (msg.type === 'sting') U.playSting(msg.sound); },
    onStatus: (status) => {
      $('live').dataset.status = status;
      setText($('live-text'), status === 'down' ? 'RECONNECTING' : status === 'stale' ? 'DELAYED' : 'LIVE');
    },
  });

  // Audio unlocks on the first interaction the room happens to make. No prompt
  // is drawn for it: a browser instruction on the audience screen breaks the
  // fiction, and the facilitator's own console can always start the sound.
  (function unlockAudio() {
    const noop = () => {};
    window.addEventListener('pointerdown', noop, { once: true });
    window.addEventListener('keydown', noop, { once: true });
  })();

  // -- small helpers ----------------------------------------------------------------

  const clamp = B.clamp;
  function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; }
  function show(node, on) { if (node && node.hidden === !!on) node.hidden = !on; }
  function sectorName(code) {
    const s = frame && frame.sectors && frame.sectors[code];
    return String((s && s.name) || (DISTRICTS[code] && DISTRICTS[code].name) || code).toUpperCase();
  }
  const inCouncil = () => !!(frame && ((frame.council && frame.council.active) || frame.mode === 'COUNCIL'));
  function alertAge() {
    if (!frame || !frame.alert) return 0;
    return (Number(frame.alert.age_s) || 0) + (performance.now() - frameAt) / 1000;
  }
  function alertIsFull() {
    if (!frame || !frame.alert) return false;
    return !!(frame.alert.full_screen && alertAge() < (Number(frame.alert.full_s) || ALERT_FULL_S));
  }
  /** Seconds since a server timestamp, on the server's own clock plus what has elapsed here. */
  function ageOf(iso) {
    if (!iso || !frame) return Infinity;
    const base = (Date.parse(frame.server_time) - Date.parse(iso)) / 1000;
    return Math.max(0, base + (performance.now() - frameAt) / 1000);
  }
  function coreBand(v) {
    if (v >= 85) return 'healthy';
    if (v >= 70) return 'weaker';
    if (v >= 50) return 'warning';
    if (v >= 30) return 'unstable';
    return 'critical';
  }
  function centroid(pts) {
    let x = 0; let y = 0;
    for (const [px, py] of pts) { x += px; y += py; }
    return [x / pts.length, y / pts.length];
  }

  // -- SVG helpers ------------------------------------------------------------------

  const P = (list) => list.map(([x, y]) => `${x},${y}`).join(' ');
  function el(tag, attrs = {}, children = []) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
    for (const c of children) if (c) node.appendChild(c);
    return node;
  }
  function text(str, x, y, cls, anchor = 'middle') {
    const t = el('text', { x, y, class: cls, 'text-anchor': anchor });
    t.textContent = str;
    return t;
  }
  function image(href, attrs) {
    const node = el('image', attrs);
    node.setAttribute('href', href);
    node.setAttributeNS(XLINK, 'xlink:href', href);
    return node;
  }

  // -- the map (built once) -----------------------------------------------------------

  function buildDefs() {
    const defs = el('defs');
    const radial = (id, stops) => el('radialGradient', { id },
      stops.map(([o, c, a]) => el('stop', { offset: o, 'stop-color': c, 'stop-opacity': a })));
    defs.appendChild(radial('gCoreGlow', [['0%', '#fff1c4', 0.75], ['40%', '#f0b64a', 0.35], ['100%', '#e8963a', 0]]));
    defs.appendChild(radial('gAlarm', [['0%', '#ff8a8a', 0.7], ['55%', '#E85A5A', 0.2], ['100%', '#E85A5A', 0]]));
    for (const [code, d] of Object.entries(DISTRICTS)) {
      defs.appendChild(el('clipPath', { id: `clip-${code}` }, [el('polygon', { points: P(d.footprint) })]));
    }
    return defs;
  }

  /** One label pill: the sector's icon and name, sized to cover the painted callout. */
  function pill(code, { x, y, w }, name, cls = '') {
    const h = 46;
    const g = el('g', { class: `label ${cls}`.trim(), transform: `translate(${x},${y})` });
    g.appendChild(el('rect', { class: 'l-bg', x: -w / 2, y: -h / 2, width: w, height: h, rx: 3 }));
    g.appendChild(image(`${ART}/icon-${code}.png`, { class: 'l-icon', x: -w / 2 + 11, y: -15, width: 30, height: 30 }));
    g.appendChild(text(name, -w / 2 + 52, 7, 'l-text', 'start'));
    // the same condition the card shows, as one light — the label never shouts
    g.appendChild(el('circle', { class: 'l-state', cx: w / 2 - 14, cy: 0, r: 5 }));
    return g;
  }

  /** The state word under a label — CRITICAL, DARK or BROWNOUT — so the map never relies on colour alone. */
  function stateTag({ x, y }) {
    const w = 170; const h = 32;
    const g = el('g', { class: 'state-tag', transform: `translate(${x},${y + 46})` });
    g.appendChild(el('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: 6 }));
    g.appendChild(text('', 0, 7, 'state-text'));
    return g;
  }

  function buildDistrict(code) {
    const d = DISTRICTS[code];
    const g = el('g', { class: 'district', id: `d-${code}`, 'data-sector': code, 'data-state': 'stable' });
    g.style.setProperty('--accent', IDENTITY[code] || d.colour);
    const pts = P(d.footprint);
    // state overlays on the artwork: greyscale copy when dark, then tint, dim, edge
    g.appendChild(image(MAP.src, { class: 'd-dark', x: 0, y: 0, width: MAP.w, height: MAP.h, 'clip-path': `url(#clip-${code})` }));
    g.appendChild(el('polygon', { class: 'd-tint', points: pts }));
    g.appendChild(el('polygon', { class: 'd-dim', points: pts }));
    g.appendChild(el('polygon', { class: 'd-edge', points: pts }));
    g.appendChild(el('g', { class: 'badges' }));
    g.appendChild(pill(code, d.label, d.name));
    g.appendChild(stateTag(d.label));
    if (DEBUG) g.appendChild(el('circle', { cx: d.badge.x, cy: d.badge.y, r: 6, fill: '#0ff' }));
    return g;
  }

  function buildCore() {
    const g = el('g', { class: 'core' });
    g.appendChild(el('circle', { class: 'core-dim', cx: CORE.x, cy: CORE.y, r: CORE.r * 1.5 }));
    g.appendChild(el('circle', { class: 'core-glow', cx: CORE.x, cy: CORE.y, r: CORE.r }));
    g.appendChild(el('circle', { class: 'core-alarm', cx: CORE.x, cy: CORE.y, r: CORE.r * 1.35 }));
    const [[x1, y1], [x2, y2]] = CORE.tunnel7;
    g.appendChild(el('line', { class: 'tunnel-7', x1, y1, x2, y2 }));
    g.appendChild(text('TUNNEL 7', x1 - 22, (y1 + y2) / 2 + 6, 't7-label', 'end'));
    // The city's centre, named twice: what it is, and what it is for. The
    // subtitle sits ABOVE the label so neither line covers the animated core.
    g.appendChild(text('PRIMARY ENERGY SOURCE', CORE.label.x, CORE.label.y - 38, 'core-sub', 'middle'));
    g.appendChild(pill('CORE', CORE.label, 'GEOTHERMAL CORE', 'core-label'));
    return g;
  }

  function buildMap() {
    const svg = $('map');
    svg.setAttribute('viewBox', `0 0 ${MAP.w} ${MAP.h}`);
    if (DEBUG) svg.classList.add('debug');
    svg.appendChild(buildDefs());
    svg.appendChild(image(MAP.src, { class: 'backdrop', x: 0, y: 0, width: MAP.w, height: MAP.h }));
    svg.appendChild(buildCore());
    for (const code of BUILD_ORDER) {
      const g = buildDistrict(code);
      districtEls[code] = g;
      svg.appendChild(g);
    }
    svg.appendChild(el('g', { id: 'routes' }));   // transfers draw on top of everything
  }

  /**
   * Six monitors in a fixed order. Built once; the frame only changes their
   * text and state. Code, name, HEALTH %, the status word, what COM reported
   * (or NO REPORT), and how fresh that report is — nothing to press.
   */
  function buildCards() {
    const host = $('h-cards');
    for (const code of PANEL_ORDER) {
      const d = DISTRICTS[code];
      const card = document.createElement('div');
      card.className = 'shc';
      card.dataset.sector = code;
      card.dataset.state = 'stable';
      card.style.setProperty('--accent', IDENTITY[code] || d.colour);
      card.dataset.report = 'none';
      // A gauge, the way a monitoring wall draws one: a dark track, an arc of
      // the sector's condition, and the figure in the middle of it.
      card.innerHTML =
        `<div class="shc-id"><img class="shc-icon" src="${ART}/icon-${code}.png" alt=""><b class="shc-code">${code}</b></div>` +
        `<div class="shc-name">${d.name}<i class="shc-cap"></i></div>` +
        '<div class="shc-gauge">' +
          `<svg class="ring" viewBox="0 0 ${RING.box} ${RING.box}" aria-hidden="true">` +
            `<circle class="ring-track" cx="${RING.c}" cy="${RING.c}" r="${RING.r}"></circle>` +
            `<circle class="ring-arc" cx="${RING.c}" cy="${RING.c}" r="${RING.r}" stroke-dasharray="0 ${RING.circ}"></circle>` +
          '</svg>' +
          '<div class="shc-health"><span class="shc-num"><b class="shc-pct">—</b><small>%</small></span><span class="k">SYSTEM HEALTH</span></div>' +
        '</div>' +
        '<div class="shc-status"><i class="shc-dot"></i><span class="shc-word">—</span></div>' +
        '<div class="shc-rep"><span class="k">FIELD REPORT</span><span class="rep-said"></span><span class="rep-fresh" data-fresh="CURRENT"></span><b class="rep-none">AWAITING</b></div>';
      host.appendChild(card);
      cardEls[code] = card;
    }
  }

  // -- per-frame render -----------------------------------------------------------------

  function render() {
    if (!frame) return;
    renderHud();
    renderDistricts();
    renderStateOverlay();
    renderCore();
    renderCards();
    renderFocus();
    renderMovement();
    renderAlerts();
    renderBroadcast();
    renderModes();
    renderAlertTakeover();
    renderPaused();
    renderRoundFlash();
    renderCycle();
    tick();
    booted = true;
  }

  /**
   * The command bar. Continuous gameflow (2026-09-21): the wall never names a
   * round or a phase. Before live play it says BRIEFING; once the shift is
   * running it counts OPERATING CYCLES, and the clock beside it is MASTER
   * TIME. The Core keeps the middle and the largest type on the bar.
   */
  function renderHud() {
    // The round, as a number. The wall never names one: the room reads
    // ROUND 3 and learns nothing about what Round 3 is going to do to it.
    const n = Number(frame.round_number);
    const ended = frame.mode === 'ENDED';
    setText($('phase-label'), ended ? 'STATUS' : 'CURRENT ROUND');
    setText($('phase-value'), ended ? 'ENDED' : Number.isFinite(n) ? `ROUND ${n}` : '—');

    // CORE STABILITY: the value, and the condition in the same words the
    // sectors use. The bands are the wall's existing ones.
    const core = Number(frame.core_output);
    setText($('core-output'), Number.isFinite(core) ? String(core) : '--');
    const cs = B.coreStatus(core);
    setText($('core-state'), cs.label);
    const hudCore = $('hud-core');
    if (hudCore.dataset.state !== cs.state) hudCore.dataset.state = cs.state;

    setText($('time-label'), inCouncil() ? 'COUNCIL ENDS IN' : 'MASTER TIME');
    show($('tag-blackout'), !!(frame.blackout && frame.blackout.active));
    show($('tag-sensors'), !!frame.telemetry_degraded);
  }

  /** District state, its word when it is not fine, and the one fault indicator. */
  /**
   * THE CALIBRATED STATE OVERLAY (2026-09-21).
   *
   * Where a sector IS on the map is no longer inferred from the painted map
   * the video replaced — it is read from mapConfig/haven9-map-regions.json,
   * measured by hand at /calibrate and stored normalised, and drawn onto the
   * rectangle the video's image actually occupies. That rectangle is
   * recomputed on resize, on fullscreen and on an orientation change, so the
   * dim over a browned-out sector stays on that sector at every size.
   *
   * A sector with no region draws nothing and is named in the console for the
   * facilitator. A missing overlay is honest; a guessed one tells the room the
   * wrong part of the city is failing.
   */
  function startStateOverlay() {
    const city = $('city');
    const video = $('map-video');
    const svg = $('map-state');
    const words = $('map-words');
    if (!city || !svg || !words || !window.MapOverlay) return;
    stateTracker = window.MapOverlay.track(city, video, svg, {
      onChange: (rect) => {
        words.style.left = `${rect.x}px`;
        words.style.top = `${rect.y}px`;
        words.style.width = `${rect.width}px`;
        words.style.height = `${rect.height}px`;
      },
    });
    window.MapOverlay.loadRegions().then((doc) => {
      regions = doc;
      const known = Object.keys(doc.sectors || {}).length;
      if (!known) console.warn('[map] no calibrated sector regions — state overlays are off. Calibrate at /calibrate.');
      renderStateOverlay();
    });
  }

  /** One group and one word per sector, each from its own saved region. */
  function renderStateOverlay() {
    const svg = $('map-state');
    if (!svg || !regions || !window.MapOverlay) return;
    const states = {};
    for (const code of BUILD_ORDER) {
      const s = frame && frame.sectors && frame.sectors[code];
      if (s) states[code] = B.healthState(s);
    }
    const { missing } = window.MapOverlay.paint(svg, $('map-words'), regions, states);
    renderOverlayBadges();
    // Said once per set of sectors, not once a frame: a projector left running
    // for an evening must not fill a console with the same line.
    const sig = missing.sort().join(',');
    if (sig !== missingSig) {
      missingSig = sig;
      if (sig) console.warn(`[map] not calibrated, so nothing is drawn for: ${sig}. Calibrate at /calibrate.`);
    }
  }

  /**
   * Which map is showing decides who draws the state: under the clip it is the
   * calibrated overlay, under the painting it is the painted districts, whose
   * footprints were traced on that very artwork. Called the moment the media
   * changes — not on the next state frame, which can be ten seconds away and
   * would leave the old district shapes sitting on the video.
   */
  function syncMapLayers() {
    const painted = $('city').dataset.map !== 'video';
    $('map').dataset.districts = painted ? 'on' : 'off';
    if (!painted && regions) renderStateOverlay();
  }

  function renderDistricts() {
    if ($('city').dataset.map === 'video') { $('map').dataset.districts = 'off'; return; }
    $('map').dataset.districts = 'on';
    for (const code of BUILD_ORDER) {
      const g = districtEls[code];
      const s = frame.sectors && frame.sectors[code];
      if (!g || !s) continue;
      if (s.colour) g.style.setProperty('--accent', s.colour);
      const state = B.healthState(s);
      if (g.dataset.state !== state) g.dataset.state = state;
      setText(g.querySelector('.state-text'), state === 'stable' || state === 'degraded' ? '' : B.STATE_WORD[state]);
      const unresolved = Number(s.unresolved_faults) || 0;
      g.classList.toggle('has-fault', unresolved > 0);
      renderFaultBadge(g, DISTRICTS[code].badge, s.top_fault || null, unresolved);
    }
  }

  /**
   * The fault badge on the calibrated map. It hangs from the same measured
   * anchor as the status word, just under it, so it is on the sector it
   * belongs to — the painted badge positions are the old artwork's and are
   * not used while the clip is running.
   */
  function renderOverlayBadges() {
    const layer = $('map-words');
    if (!layer || !regions) return;
    const sectors = (regions.sectors) || {};
    const wanted = new Map();
    for (const code of BUILD_ORDER) {
      const s = frame && frame.sectors && frame.sectors[code];
      const region = sectors[code];
      if (!s || !window.MapOverlay.isCalibrated(region)) continue;
      const unresolved = Number(s.unresolved_faults) || 0;
      if (!unresolved) continue;
      const tf = s.top_fault || null;
      wanted.set(code, {
        text: tf ? `\u26a0 ${tf.code}${unresolved > 1 ? ` \u00d7${unresolved}` : ''}` : `\u26a0 \u00d7${unresolved}`,
        crisis: !!(tf && Number(tf.severity) >= 3),
        at: window.MapOverlay.labelAnchor(region),
      });
    }
    for (const el of [...layer.querySelectorAll('[data-badge]')]) {
      if (!wanted.has(el.getAttribute('data-badge'))) el.remove();
    }
    for (const [code, spec] of wanted) {
      let el = layer.querySelector(`[data-badge="${code}"]`);
      if (!el) {
        el = document.createElement('div');
        el.setAttribute('data-badge', code);
        el.className = 'mo-badge';
        layer.appendChild(el);
      }
      if (el.textContent !== spec.text) el.textContent = spec.text;
      el.classList.toggle('crisis', spec.crisis);
      el.style.left = `${spec.at.x * 100}%`;
      el.style.top = `${spec.at.y * 100}%`;
    }
  }

  /** One badge on the rock while a fault is open: its code, or how many. Never the fix. */
  function renderFaultBadge(g, anchor, tf, unresolved) {
    const host = g.querySelector('.badges');
    let spec = null;
    if (tf) {
      spec = { cls: Number(tf.severity) >= 3 ? 'badge b-crisis' : 'badge', text: `⚠ ${tf.code}${unresolved > 1 ? ` ×${unresolved}` : ''}` };
    } else if (unresolved > 0) {
      spec = { cls: 'badge', text: `⚠ ×${unresolved}` };
    }
    const sig = spec ? `${spec.cls}|${spec.text}` : '';
    if (host.dataset.sig === sig) return;
    host.dataset.sig = sig;
    host.innerHTML = '';
    if (!spec) return;
    const badge = el('g', { class: spec.cls, transform: `translate(${anchor.x},${anchor.y})` });
    const t = text(spec.text, 0, 8, 'badge-text');
    const rect = el('rect', { x: -60, y: -17, width: 120, height: 34, rx: 8 });
    badge.appendChild(rect);
    badge.appendChild(t);
    host.appendChild(badge);
    const w = t.getComputedTextLength() + 30;
    rect.setAttribute('x', (-w / 2).toFixed(1));
    rect.setAttribute('width', w.toFixed(1));
  }

  function renderCore() {
    const band = coreBand(Number(frame.core_output) || 0);
    if ($('wall').dataset.core !== band) $('wall').dataset.core = band;
    // A fall in core stability is an event the room should feel, not read.
    const core = Number(frame.core_output);
    if (prevCore !== null && core < prevCore && (prevCore - core >= 10 || core <= B.CORE_INSUFFICIENT)) {
      setText($('shock-value'), `${core}%`);
      shockUntil = performance.now() + SHOCK_MS;
      show($('core-shock'), true);
    }
    prevCore = core;
    const breach = !!(frame.alert && /BIOLOGICAL|BREACH|TUNNEL 7/i.test(`${frame.alert.title} ${frame.alert.subtitle}`));
    $('map').classList.toggle('breach', breach);
  }

  /**
   * The six monitors: HEALTH %, the status word, what COM reported and how
   * old that is — a round, never a clock. The card and the district share
   * one state, decided once in B.healthState.
   */
  /**
   * The six monitors. Identity and condition are kept apart on purpose: the
   * icon, the code and the left edge say WHO the sector is, and only the dot,
   * the word and the health figure say HOW it is. Medical stays red without
   * ever looking critical. A sector COM has not reported says so once, in
   * place of its numbers, instead of repeating it in two lines.
   */
  /**
    * SECTOR FOCUS. Eight seconds of COMM pointing at one sector: the card
    * lifts and the calibrated region takes a bright edge. It is drawn UNDER
    * the system's own state — the brownout dim, the DARK wash, the critical
    * edge all keep their opacity — so COMM can draw the eye and can never
    * hide what the city is actually doing.
    */
  function renderFocus() {
    const f = (frame.broadcast && frame.broadcast.focus) || null;
    const code = f ? f.sector : null;
    for (const [c, card] of Object.entries(cardEls)) card.classList.toggle('focused', c === code);
    const svg = $('map-state');
    if (!svg) return;
    for (const g of svg.querySelectorAll('[data-region]')) {
      g.classList.toggle('focused', g.getAttribute('data-region') === code);
    }
  }

  function renderCards() {
    const rows = (frame.broadcast && frame.broadcast.rows) || {};
    setText($('h-reports'), B.reportSummary(rows, PANEL_ORDER).text);
    for (const code of PANEL_ORDER) {
      const card = cardEls[code];
      const s = frame.sectors && frame.sectors[code];
      if (!card || !s) continue;
      setText(card.querySelector('.shc-name'), sectorName(code));
      const state = B.healthState(s);
      if (card.dataset.state !== state) card.dataset.state = state;
      const value = B.healthValue(s);
      setText(card.querySelector('.shc-pct'), value);   // never a fabricated 100
      // the arc follows the figure; an unknown health leaves the track empty
      const pct = value === '—' ? 0 : Number(value);
      const arc = card.querySelector('.ring-arc');
      const dash = `${Math.round((pct / 100) * RING.circ * 10) / 10} ${RING.circ}`;
      if (arc.getAttribute('stroke-dasharray') !== dash) arc.setAttribute('stroke-dasharray', dash);
      setText(card.querySelector('.shc-word'), B.CARD_WORD[state]);
      // what the city has built, where the whole room can weigh it in Council
      const gen = s && s.generator;
      setText(card.querySelector('.shc-cap'), gen ? `L${gen.level}/${gen.max}` : '');

      // whether COM has reported, and how fresh it is — the numbers themselves
      // live on the sector consoles and the facilitator's screen
      const rep = B.reportLine(rows[code]);
      if (card.dataset.report !== (rep.none ? 'none' : 'yes')) card.dataset.report = rep.none ? 'none' : 'yes';
      const fresh = B.freshnessShort(rows[code]);
      const fe = card.querySelector('.rep-fresh');
      setText(fe, fresh.text);
      if (fe.dataset.fresh !== fresh.level) fe.dataset.fresh = fresh.level;

      /*
        What COMM says the sector's condition is. It sits inside FIELD REPORT,
        beside the freshness and under the card's own SYSTEM HEALTH — never on
        top of them. The gap between the two is the point: a card reading 24%
        CRITICAL with a field report of STABLE is a finding, and the room can
        see both at once.
      */
      const said = (rows[code] || {}).status || '';
      const se = card.querySelector('.rep-said');
      setText(se, said);
      if (se.dataset.said !== said) se.dataset.said = said;
      const disagrees = !!said && said !== B.CARD_WORD[state] && !(said === 'STABLE' && state === 'stable');
      se.classList.toggle('differs', disagrees);
    }
  }

  // -- movement: a delivery travels its route once TRN has approved it --------------

  function routePoints(from, to) {
    const c = (code) => centroid(DISTRICTS[code].footprint);
    const pts = [c(from)];
    if (from !== 'TRN' && to !== 'TRN') pts.push(c('TRN'));
    pts.push(c(to));
    return pts;
  }

  /** Source to Transport to destination, each leg bowed towards the Core like the tunnels. */
  function routeD(pts) {
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length; i += 1) {
      const [x1, y1] = pts[i - 1];
      const [x2, y2] = pts[i];
      const cx = (x1 + x2) / 2 + (CORE.x - (x1 + x2) / 2) * 0.55;
      const cy = (y1 + y2) / 2 + (CORE.y - (y1 + y2) / 2) * 0.55;
      d += ` Q ${cx.toFixed(0)} ${cy.toFixed(0)} ${x2} ${y2}`;
    }
    return d;
  }

  /** The phase a transfer is in for the animation, from its status and its age. */
  function routePhase(t) {
    if (t.status === 'PENDING_TRN_APPROVAL') return 'pending';
    if (t.status === 'APPROVED' || t.status === 'DELIVERED') {
      const age = ageOf(t.approved_at || t.updated_at);
      if (age < ROUTE_S) return 'moving';
      if (age < ROUTE_S + SWEEP_S) return 'sweep';
      return null;
    }
    if (['DECLINED_BY_TRN', 'CANCELLED', 'EXPIRED'].includes(t.status)) return ageOf(t.updated_at) < FADE_S ? 'fade' : null;
    return null;
  }

  function renderMovement() {
    const host = $('routes');
    const transfers = frame.transfers || [];
    const seen = new Set();
    const lit = new Set();
    const sweeping = new Set();

    for (const t of transfers) {
      const phase = routePhase(t);
      if (!phase || !DISTRICTS[t.from] || !DISTRICTS[t.to]) continue;
      seen.add(t.id);
      let r = routeEls.get(t.id);
      if (!r) {
        const pts = routePoints(t.from, t.to);
        const g = el('g', { class: 'route-g' });
        g.style.setProperty('--accent', DISTRICTS[t.from].colour);
        const path = el('path', { id: `route-${t.id}`, class: 'route', d: routeD(pts) });
        g.appendChild(path);
        host.appendChild(g);
        r = { g, path, packet: null, phase: null };
        routeEls.set(t.id, r);
      }
      if (r.phase !== phase) {
        r.phase = phase;
        r.path.setAttribute('class', `route ${phase === 'sweep' ? 'moving' : phase}`);
        if (phase === 'moving' && !r.packet) {
          // the resource, travelling source → Transport → destination
          const packet = el('circle', { class: 'packet', r: 11 });
          const motion = el('animateMotion', { dur: `${ROUTE_S}s`, repeatCount: '1', fill: 'freeze', begin: 'indefinite' });
          const mpath = el('mpath');
          mpath.setAttribute('href', `#route-${t.id}`);
          mpath.setAttributeNS(XLINK, 'xlink:href', `#route-${t.id}`);
          motion.appendChild(mpath);
          packet.appendChild(motion);
          r.g.appendChild(packet);
          r.packet = packet;
          if (typeof motion.beginElement === 'function') motion.beginElement();
        }
        if (phase !== 'moving' && r.packet) { r.packet.remove(); r.packet = null; }
      }
      if (phase === 'moving') { lit.add(t.from); lit.add('TRN'); lit.add(t.to); }
      if (phase === 'sweep') { sweeping.add(t.to); lit.add(t.to); }
    }
    for (const [id, r] of routeEls) {
      if (!seen.has(id)) { r.g.remove(); routeEls.delete(id); }
    }
    // the districts and cards echo a delivery, briefly
    for (const code of PANEL_ORDER) {
      districtEls[code].classList.toggle('sweep', sweeping.has(code));
      cardEls[code].classList.toggle('lit', lit.has(code));
      cardEls[code].classList.toggle('sweep', sweeping.has(code));
    }
  }

  // -- the alert strip: only while something needs the room --------------------------

  function renderAlerts() {
    const chips = B.buildAlerts(frame);
    const host = $('alerts');
    const keys = new Set(chips.map((c) => c.key));
    for (const [key, node] of chipEls) {
      if (!keys.has(key)) { node.remove(); chipEls.delete(key); }
    }
    chips.forEach((c, i) => {
      let node = chipEls.get(c.key);
      if (!node) {
        node = document.createElement('div');
        node.className = `chip ${c.kind}${booted ? ' enter' : ''}`;
        node.dataset.accent = c.accent;
        node.innerHTML = '<b class="c-head"></b><span class="c-detail"></span>';
        chipEls.set(c.key, node);
      }
      setText(node.querySelector('.c-head'), c.head);
      setText(node.querySelector('.c-detail'), c.detail || '');
      if (host.children[i] !== node) host.insertBefore(node, host.children[i] || null);
    });
    show(host, chips.length > 0);
    $('wall').classList.toggle('has-alerts', chips.length > 0);
  }

  // -- the city broadcast: COM's announcement, or the fact that there is none --------

  function renderBroadcast() {
    const a = frame.broadcast && frame.broadcast.announcement;
    const live = !!(a && (a.headline || a.message));
    const key = live ? `${a.round}|${a.headline}|${a.message}` : 'none';
    const bc = $('broadcast');
    if (key !== broadcastKey) {
      broadcastKey = key;
      if (booted && live) {          // one entrance, then it stays still
        bc.classList.remove('enter');
        void bc.offsetWidth;
        bc.classList.add('enter');
      }
    }
    if (bc.dataset.state !== (live ? 'live' : 'none')) bc.dataset.state = live ? 'live' : 'none';
    if (live) {
      setText($('bc-head'), String(a.headline || a.message));
      setText($('bc-msg'), a.headline ? String(a.message || '') : '');
      setText($('bc-by'), `— COMMS & SENSORS · CYCLE ${a.round_number} · ${a.freshness}`);
    } else {
      setText($('bc-head'), 'STANDBY');      // compact: the band is quiet until COM speaks
      setText($('bc-msg'), '');
      setText($('bc-by'), '');
    }
  }

  /** Whole-screen modes that colour more than one band. */
  function renderModes() {
    const w = $('wall');
    w.classList.toggle('council', inCouncil());
    w.classList.toggle('core-low', Number(frame.core_output) <= B.CORE_INSUFFICIENT);
  }

  function renderAlertTakeover() {
    const a = frame.alert;
    if (!a) { show($('alert-full'), false); alertRenderedId = null; return; }
    if (a.id !== alertRenderedId) {
      setText($('alert-title'), a.title || '');
      setText($('alert-sub'), a.subtitle || '');
      setText($('alert-big'), a.big || '');
      show($('alert-big'), !!a.big);
      alertRenderedId = a.id;
    }
    show($('alert-full'), alertIsFull());
  }

  function renderPaused() { show($('paused'), !!frame.paused); }

  /** The operating cycle: 3.5 seconds of UPKEEP PROCESSED, with what it cost. */
  /**
   * THE ROUND MARKER (2026-09-21). When the round number changes the wall says
   * so for three seconds and then stops saying it. No title, no objective, no
   * hint of what is coming: the number is the whole message. It pauses
   * nothing and covers nothing anybody needs to press.
   */
  function renderRoundFlash() {
    const n = Number(frame.round_number);
    if (!Number.isFinite(n)) return;
    if (prevRound !== null && n !== prevRound && frame.mode !== 'ENDED') {
      setText($('round-flash-text'), `ROUND ${n}`);
      roundFlashUntil = performance.now() + ROUND_FLASH_MS;
      show($('round-flash'), true);
    }
    prevRound = n;
  }

  function renderCycle() {
    const n = Number(frame.cycle && frame.cycle.number);
    if (prevCycle !== null && Number.isFinite(n) && n > prevCycle) {
      const feed = Array.isArray(frame.ticker) ? frame.ticker : (frame.feed || []);
      const cost = feed.filter((e) => e.kind === 'cycle' && ageOf(e.t) < 6 && /missed upkeep/i.test(e.text))
        .map((e) => `${e.text.slice(0, 3)} MISSED UPKEEP`);
      setText($('cycle-flash-title'), 'OPERATING CYCLE — UPKEEP PROCESSED');
      setText($('cycle-flash-sub'), cost.length ? cost.join('  ·  ') : '');
      cycleFlashUntil = performance.now() + CYCLE_FLASH_MS;
      show($('cycle-flash'), true);
    }
    if (Number.isFinite(n)) prevCycle = n;
  }

  // -- the 250 ms tick: clocks and timed overlays ------------------------------------

  function tick() {
    if (!frame) return;
    const now = performance.now();
    const frozen = !!frame.frozen;

    // Command bar time: the council clock while the Council sits, else the round clock — upkeep falls due when it ends.
    const council = inCouncil();
    const clockObj = council ? frame.council_clock : frame.round_clock;
    const secs = U.countdown(clockObj, frozen);
    const running = !!(clockObj && clockObj.running) && !frozen;
    setText($('round-clock'), U.mmss(secs));
    const urgency = !running ? '' : secs <= 10 ? ' final' : secs <= 20 ? ' danger' : secs <= 60 ? ' warn' : '';
    const cls = `hud-time${council ? ' council' : ''}${urgency}`;
    const hud = $('hud-time');
    if (hud.className !== cls) hud.className = cls;

    // The final ten seconds of a round, as a number the whole room can count.
    const cyc = U.countdown(frame.round_clock, frozen);
    const finalOn = !council && !!(frame.round_clock && frame.round_clock.running) && !frozen && cyc > 0 && cyc <= 10;
    const fc = $('final-count');
    if (finalOn) {
      const digit = String(Math.ceil(cyc));
      if (fc.textContent !== digit) { fc.textContent = digit; fc.hidden = true; void fc.offsetWidth; }
      fc.hidden = false;
    } else if (!fc.hidden) { fc.hidden = true; fc.textContent = ''; }

    // Overlays and routes with a life of their own.
    if (!$('core-shock').hidden && now >= shockUntil) show($('core-shock'), false);
    if (!$('cycle-flash').hidden && now >= cycleFlashUntil) show($('cycle-flash'), false);
    if (!$('round-flash').hidden && now >= roundFlashUntil) show($('round-flash'), false);
    if (routeEls.size || (frame.transfers || []).length) renderMovement();
    show($('alert-full'), !!frame.alert && alertIsFull());
    $('wall').classList.toggle('dimmed', !$('core-shock').hidden || !!frame.paused || alertIsFull());
  }

  /**
   * THE CITY ANIMATION (2026-09-20). The map is a looping video laid under
   * the overlays; the painting the overlays were traced on is its fallback
   * and stays visible until the video is genuinely playing.
   *
   * Everything about the media — the file, the fit, the playback flags —
   * comes from config/big-screen-map.json, so a projector that should run on
   * the painting alone is a one-word edit there and no code change here.
   *
   * It loops NATIVELY: no timer restarts it, nothing rebuilds it, and it is
   * never reloaded, so a screen left on for an evening plays one continuous
   * animation. A browser that refuses to autoplay even a muted video gets one
   * more try on the room's first touch — the same gesture that unlocks sound.
   */
  function startMapAnimation() {
    const city = $('city');
    const video = $('map-video');
    if (!city || !video) return;
    const painting = () => { city.dataset.map = 'image'; syncMapLayers(); };
    painting();
    // A painting-only wall keeps its tags: nothing else would name the districts.
    city.dataset.labels = 'on';
    fetch(MAP_MEDIA_URL, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((cfg) => {
        const m = (cfg && cfg.mapDisplay) || {};
        // The painting is the fallback, and the config names it: if it names a
        // different one, the backdrop and the dark-sector copy both follow.
        if (m.fallbackImage && m.fallbackImage !== MAP.src) {
          for (const img of $('map').querySelectorAll('.backdrop, .d-dark')) {
            img.setAttribute('href', m.fallbackImage);
            img.setAttributeNS(XLINK, 'xlink:href', m.fallbackImage);
          }
        }
        // The clip carries its own district names, so the overlay tags stay off
        // unless the config says this cut has none. Only the names go: every
        // live overlay — state words, fault badges, tints, routes — stays.
        city.dataset.labels = m.overlayLabels === true ? 'on' : 'off';
        if (m.type !== 'video' || !m.source) { video.remove(); return; }   // configured off
        video.loop = m.loop !== false;
        video.muted = m.muted !== false;              // muted is what lets a browser autoplay at all
        video.controls = m.controls === true;
        video.playsInline = m.playsInline !== false;
        video.preload = m.preload || 'auto';
        if (m.fit) video.style.objectFit = m.fit;
        if (m.position) video.style.objectPosition = m.position;
        // Ask again on the events that mean it could work now, never on a
        // timer: the file became playable, the projector came back to the
        // foreground, someone touched the room. A browser that refuses muted
        // autoplay outright therefore still starts on the first touch, and
        // until it does the painting is what the room sees.
        let playing = false;        // running right now
        let everPlayed = false;     // it has run at least once
        const play = () => {
          if (playing) return;
          const p = video.play();
          if (p && p.catch) p.catch(painting);
        };
        video.addEventListener('playing', () => {
          playing = true;
          everPlayed = true;
          if (city.dataset.map !== 'video') { city.dataset.map = 'video'; syncMapLayers(); }   // the loop re-fires this; write nothing
        });
        // Nothing on this screen can pause it: there are no controls. So a
        // pause is the browser's — a suspended tab, a power-saving nap — and
        // the room wants the city moving again.
        video.addEventListener('pause', () => { playing = false; if (everPlayed) play(); });
        video.addEventListener('error', painting);
        video.addEventListener('emptied', painting);
        for (const ev of ['loadeddata', 'canplay', 'canplaythrough']) video.addEventListener(ev, play);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') play(); });
        window.addEventListener('pointerdown', play);
        window.addEventListener('keydown', play);
        video.src = m.source;
        if (m.autoplay !== false) play();
      })
      .catch(painting);
  }

  buildMap();
  buildCards();
  startMapAnimation();
  startStateOverlay();
  setInterval(tick, TICK_MS);
})();
