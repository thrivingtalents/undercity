'use strict';
/**
 * CITY WALL — the command centre view of HAVEN-9.
 *
 * Four bands, top to bottom: the command bar (round, CITY, CORE, NEXT ROUND),
 * ONE priority event, the city beside its six health monitors, and the last
 * four things that happened. The city is the hero: the illustration in
 * public/wall/art/haven9-map.png with everything alive drawn over it in an
 * SVG that uses the artwork's own pixel grid (1672×941), so each overlay is
 * traced straight from the painting — a live label on each callout, a state
 * tint on each district's footprint, a fault badge on the rock, a route that
 * lights only while a transfer moves, and a Core that glows with its output.
 *
 * Every value is the server's. Presentation states — a card's health word,
 * the banner's one event, a timer's urgency, a route's phase — are DERIVED
 * from the frame on the way to the screen, never stored as a second truth.
 *
 * Rendering split:
 *   buildMap() / buildCards()  once
 *   render()                   per state frame — keyed updates only
 *   tick()                     every 250 ms — clocks, timed overlays, routes
 */
(function wall() {
  const U = window.Undercity;
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const CTX = U.context();

  const ALERT_FULL_S = 8;        // mirrors alert_full_screen_s; the frame carries the real value
  const TICK_MS = 250;
  const SHOCK_MS = 4500;
  const CYCLE_FLASH_MS = 3500;
  const ROUTE_S = 2.6;           // a packet's journey along its route
  const SWEEP_S = 1.4;           // the confirmation sweep at the destination
  const FADE_S = 1.2;            // a cancelled route fading out
  const TICKER_MAX = 4;
  const CORE_INSUFFICIENT = 60;  // the same line the Council text already draws
  const ART = '/assets/wall/art';
  const MAP = { w: 1672, h: 941, src: `${ART}/haven9-map.png` };
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
  const PANEL_ORDER = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];   // fixed: the room learns where each one lives
  const BUILD_ORDER = ['WTR', 'POW', 'COM', 'MED', 'TRN', 'AGR'];   // paint order on the map
  const CORE = { x: 836, y: 398, r: 96, label: { x: 855, y: 295, w: 300 }, tunnel7: [[838, 548], [838, 612]] };
  const ROUND_LABEL = { R0: 'ORIENTATION', R1: 'ROUND 1', R2: 'ROUND 2', R3: 'ROUND 3', R4: 'AFTERSHOCK' };
  const STATE_WORD = { stable: 'STABLE', warning: 'WARNING', critical: 'CRITICAL', brownout: 'BROWNOUT', dark: 'DARK' };
  const RES_NAME = { power: 'POWER', water: 'WATER', parts: 'PARTS', med: 'MEDICAL', workers: 'WORKERS' };

  let frame = null;
  let frameAt = 0;
  let prevCore = null;
  let prevCycle = null;
  let alertRenderedId = null;
  let shockUntil = 0;
  let cycleFlashUntil = 0;
  let bannerKey = null;
  let booted = false;             // the first frame paints without entry animations
  const districtEls = {};
  const cardEls = {};
  const routeEls = new Map();      // transfer id -> { g, path, packet, phase }
  const prevHealth = {};           // sector -> health state last frame
  const derivedLines = [];         // WARNING / RESTORED transitions the server does not ticker

  U.connect({
    hello: { type: 'hello', role: 'bigscreen', session: CTX.session, token: null },
    onState: (next) => { frame = next; frameAt = performance.now(); render(); },
    onMessage: (msg) => { if (msg.type === 'sting') U.playSting(msg.sound); },
    onStatus: (status) => {
      $('conn').dataset.status = status;
      $('conn-text').textContent = status === 'down' ? 'RECONNECTING' : status === 'stale' ? 'DELAYED' : 'LIVE';
    },
  });

  (function soundHint() {
    const hide = () => { const h = $('sound-hint'); if (h) h.hidden = true; };
    window.addEventListener('pointerdown', hide, { once: true });
    window.addEventListener('keydown', hide, { once: true });
  })();

  // -- small helpers ----------------------------------------------------------------

  const clamp = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; }
  function show(node, on) { if (node && node.hidden === !!on) node.hidden = !on; }
  function sectorName(code) {
    const s = frame && frame.sectors && frame.sectors[code];
    return String((s && s.name) || (DISTRICTS[code] && DISTRICTS[code].name) || code).toUpperCase();
  }
  const resName = (k) => RES_NAME[k] || String(k || '').toUpperCase();
  const inCouncil = () => !!(frame && ((frame.council && frame.council.active) || frame.mode === 'COUNCIL'));

  /**
   * A sector's health state, from the server's status word so the wall never
   * disagrees with a laptop. The band below STABLE is printed as WARNING here.
   */
  function healthState(s) {
    if (!s) return 'stable';
    const w = String(s.status_word || s.status || '').toUpperCase();
    if (s.status === 'DARK' || w === 'DARK' || Number(s.integrity) <= 0) return 'dark';
    if (s.status === 'BROWNOUT' || w === 'BROWNOUT') return 'brownout';
    if (s.status === 'CRITICAL' || w === 'CRITICAL') return 'critical';
    if (w === 'DEGRADED' || w === 'WARNING') return 'warning';
    return 'stable';
  }
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
  const hhmm = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '--:--' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

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
    const h = 50;
    const g = el('g', { class: `label ${cls}`.trim(), transform: `translate(${x},${y})` });
    g.appendChild(el('rect', { class: 'l-bg', x: -w / 2, y: -h / 2, width: w, height: h, rx: 10 }));
    g.appendChild(image(`${ART}/icon-${code}.png`, { class: 'l-icon', x: -w / 2 + 12, y: -17, width: 34, height: 34 }));
    g.appendChild(text(name, -w / 2 + 58, 8, 'l-text', 'start'));
    return g;
  }

  function buildDistrict(code) {
    const d = DISTRICTS[code];
    const g = el('g', { class: 'district', id: `d-${code}`, 'data-sector': code, 'data-state': 'stable' });
    g.style.setProperty('--accent', d.colour);
    const pts = P(d.footprint);
    // state overlays on the artwork: greyscale copy when dark, then tint, dim, edge
    g.appendChild(image(MAP.src, { class: 'd-dark', x: 0, y: 0, width: MAP.w, height: MAP.h, 'clip-path': `url(#clip-${code})` }));
    g.appendChild(el('polygon', { class: 'd-tint', points: pts }));
    g.appendChild(el('polygon', { class: 'd-dim', points: pts }));
    g.appendChild(el('polygon', { class: 'd-edge', points: pts }));
    g.appendChild(el('g', { class: 'badges' }));
    g.appendChild(pill(code, d.label, d.name));
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

  /** Six monitors in a fixed order. Built once; the frame only changes their text and state. */
  function buildCards() {
    const host = $('h-cards');
    for (const code of PANEL_ORDER) {
      const d = DISTRICTS[code];
      const card = document.createElement('div');
      card.className = 'shc';
      card.dataset.sector = code;
      card.dataset.state = 'stable';
      card.style.setProperty('--accent', d.colour);
      card.innerHTML =
        `<img class="shc-icon" src="${ART}/icon-${code}.png" alt="">` +
        `<div class="shc-id"><b class="shc-code">${code}</b><span class="shc-name">${d.name}</span></div>` +
        `<div class="shc-int"><b class="shc-pct">--</b><small>%</small></div>` +
        `<div class="shc-status"><i class="shc-dot"></i><span class="shc-word">—</span></div>` +
        `<div class="shc-flags"><span class="f f-fault" hidden></span><span class="f f-req" hidden>REQUEST</span>` +
        `<span class="f f-trn" hidden>TRANSFER</span><span class="f f-inj" hidden></span></div>` +
        `<div class="shc-rep"><span class="rep-vals"></span><i class="rep-fresh"></i></div>`;
      host.appendChild(card);
      cardEls[code] = card;
    }
  }

  // -- per-frame render -----------------------------------------------------------------

  function render() {
    if (!frame) return;
    renderHud();
    renderDistricts();
    renderCore();
    renderCards();
    renderMovement();
    renderBanner();
    renderModes();
    renderAlert();
    renderDebrief();
    renderPaused();
    renderCycle();
    renderTicker();
    tick();
    booted = true;
  }

  function renderHud() {
    const label = frame.mode === 'DEBRIEF' ? 'DEBRIEF' : (ROUND_LABEL[frame.round] || frame.round || '');
    setText($('phase-name'), label);
    setStat('hud-city', 'stability', frame.city_stability);
    setStat('hud-core', 'core-output', frame.core_output);
    setText($('time-label'), inCouncil() ? 'COUNCIL' : 'NEXT ROUND');
    show($('tag-blackout'), !!(frame.blackout && frame.blackout.active));
    show($('tag-breather'), !!frame.breather);
    show($('tag-sensors'), !!frame.telemetry_degraded);
  }
  function setStat(id, valueId, v) {
    setText($(valueId), Number.isFinite(v) ? String(v) : '--');
    const cls = `hud-stat ${U.integrityClass(v)}`;
    if ($(id).className !== cls) $(id).className = cls;
  }

  /** District state and the one fault indicator; WARNING / RESTORED lines derived here. */
  function renderDistricts() {
    for (const code of BUILD_ORDER) {
      const g = districtEls[code];
      const s = frame.sectors && frame.sectors[code];
      if (!g || !s) continue;
      if (s.colour) g.style.setProperty('--accent', s.colour);
      const state = healthState(s);
      if (g.dataset.state !== state) g.dataset.state = state;
      const unresolved = Number(s.unresolved_faults) || 0;
      g.classList.toggle('has-fault', unresolved > 0);
      renderFaultBadge(g, DISTRICTS[code].badge, code, s.top_fault || null, unresolved);

      const before = prevHealth[code];
      if (before && before !== state) {
        if (state === 'warning' && before === 'stable') {
          derivedLines.push({ t: frame.server_time, key: `w|${code}|${frame.server_time}`, cls: 'warn', text: `${code} ENTERED WARNING` });
        } else if (state === 'stable' && (before === 'warning' || before === 'critical')) {
          derivedLines.push({ t: frame.server_time, key: `r|${code}|${frame.server_time}`, cls: 'ok', text: `${code} RESTORED TO ${clamp(s.integrity)}%` });
        }
      }
      prevHealth[code] = state;
    }
    while (derivedLines.length > 20) derivedLines.shift();
  }

  /** One badge on the rock while a fault is open: its clock, or its code, or how many. */
  function renderFaultBadge(g, anchor, code, tf, unresolved) {
    const host = g.querySelector('.badges');
    let spec = null;
    if (tf) {
      spec = {
        cls: Number(tf.severity) >= 3 ? 'badge b-crisis' : 'badge',
        text: `⚠ ${tf.code}`,
        clock: null,
        extra: unresolved > 1 ? ` ×${unresolved}` : '',
      };
    } else if (unresolved > 0) {
      spec = { cls: 'badge', text: `⚠ ×${unresolved}`, clock: null, extra: '' };
    }
    const sig = spec ? `${spec.cls}|${spec.text}|${spec.extra}|${spec.clock || ''}` : '';
    if (host.dataset.sig === sig) return;
    host.dataset.sig = sig;
    host.innerHTML = '';
    if (!spec) return;
    const badge = el('g', { class: spec.cls, transform: `translate(${anchor.x},${anchor.y})` });
    const t = text(`${spec.text}${spec.extra}`, 0, 8, 'badge-text');
    if (spec.clock) { t.dataset.clock = spec.clock; t.dataset.extra = spec.extra; }
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
    // A fall in core output is an event the room should feel, not read.
    const core = Number(frame.core_output);
    if (prevCore !== null && core < prevCore && (prevCore - core >= 10 || core <= 60)) {
      setText($('shock-value'), `${core}%`);
      shockUntil = performance.now() + SHOCK_MS;
      show($('core-shock'), true);
    }
    prevCore = core;
    const breach = !!(frame.alert && /BIOLOGICAL|BREACH|TUNNEL 7/i.test(`${frame.alert.title} ${frame.alert.subtitle}`));
    $('map').classList.toggle('breach', breach);
  }

  /** The six monitors: integrity, word, indicator, small flags, and what COM reported. */
  function renderCards() {
    const requests = frame.requests || [];
    const transfers = frame.transfers || [];
    const rows = (frame.broadcast && frame.broadcast.rows) || {};
    for (const code of PANEL_ORDER) {
      const card = cardEls[code];
      const s = frame.sectors && frame.sectors[code];
      if (!card || !s) continue;
      if (s.colour) card.style.setProperty('--accent', s.colour);
      setText(card.querySelector('.shc-name'), sectorName(code));
      const state = healthState(s);
      if (card.dataset.state !== state) card.dataset.state = state;
      setText(card.querySelector('.shc-pct'), String(clamp(s.integrity)));
      setText(card.querySelector('.shc-word'), STATE_WORD[state]);

      // flags: only what is true
      const tf = s.top_fault || null;
      const fault = card.querySelector('.f-fault');
      const unresolved = Number(s.unresolved_faults) || 0;
      show(fault, unresolved > 0);
      if (unresolved > 0) {
        fault.classList.toggle('crisis', !!(tf && Number(tf.severity) >= 3));
        const more = unresolved > 1 ? ` ×${unresolved}` : '';
        const sig = `${tf ? tf.code : ''}|${more}`;
        if (fault.dataset.sig !== sig) {
          fault.dataset.sig = sig;
          fault.textContent = `⚠ ${tf ? tf.code : ''}${more}`.replace(/\s+/g, ' ');
        }
      }
      show(card.querySelector('.f-req'), requests.some((r) => r.status === 'REQUESTED' && r.requester === code));
      show(card.querySelector('.f-trn'), transfers.some((t) => ['PENDING_TRN_APPROVAL', 'APPROVED'].includes(t.status)
        && (t.from === code || t.to === code || code === 'TRN')));
      const injured = s.workforce ? Number(s.workforce.injured) || 0 : 0;
      const inj = card.querySelector('.f-inj');
      show(inj, injured > 0);
      if (injured > 0) setText(inj, `⚕ ${injured}`);

      // what COM last reported, and how old that is — a round, never a clock
      const row = rows[code];
      const vals = card.querySelector('.rep-vals');
      const fresh = card.querySelector('.rep-fresh');
      if (row) {
        const html = ['power', 'water', 'med', 'parts']
          .map((k) => `${U.GLYPH[k]}<b>${row[k] === null || row[k] === undefined ? '—' : row[k]}</b>`).join(' ');
        if (vals.dataset.sig !== html) { vals.dataset.sig = html; vals.innerHTML = html; }
        const word = row.freshness === 'NOT UPDATED' ? 'NO REPORT' : `R${row.round_number} ${row.freshness}`;
        setText(fresh, word);
        fresh.dataset.fresh = row.freshness;
      } else {
        show(card.querySelector('.shc-rep'), false);
      }
    }
  }

  // -- movement: requests pulse, Transport waits, a delivery travels ------------------

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
    const requests = frame.requests || [];
    const seen = new Set();
    const lit = new Set();
    const sweeping = new Set();
    let trnPending = false;

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
      if (phase === 'pending') trnPending = true;
      if (phase === 'moving') { lit.add(t.from); lit.add('TRN'); lit.add(t.to); }
      if (phase === 'sweep') { sweeping.add(t.to); lit.add(t.to); }
    }
    for (const [id, r] of routeEls) {
      if (!seen.has(id)) { r.g.remove(); routeEls.delete(id); }
    }

    // the districts and cards echo it
    const asked = new Set();
    for (const rq of requests) if (rq.status === 'REQUESTED') { asked.add(rq.requester); asked.add(rq.supplier); }
    for (const code of PANEL_ORDER) {
      const g = districtEls[code];
      const card = cardEls[code];
      g.classList.toggle('req', asked.has(code));
      g.classList.toggle('trn-pending', code === 'TRN' && trnPending);
      g.classList.toggle('sweep', sweeping.has(code));
      card.classList.toggle('lit', lit.has(code) || asked.has(code));
      card.classList.toggle('sweep', sweeping.has(code));
    }
  }

  // -- the one priority event ------------------------------------------------------

  /**
   * The single most important thing happening, in the spec's order: a timed
   * emergency, a DARK sector, a CRITICAL sector, core insufficiency, the
   * Council, a resource request, a transfer waiting on Transport, a fault,
   * COM's broadcast — else the city is fine.
   */
  function priorityEvent() {
    const f = frame;
    const sec = (code) => f.sectors && f.sectors[code];
    const faults = PANEL_ORDER.map((code) => ({ code, tf: sec(code) && sec(code).top_fault })).filter((x) => x.tf);

    if (f.alert) {
      return { key: `alert:${f.alert.id}`, level: 1, accent: 'red', sev: 'MAJOR EMERGENCY',
        head: String(f.alert.title || ''), route: String(f.alert.subtitle || ''), clock: f.alert.big ? { kind: 'text', text: f.alert.big } : null };
    }    const dark = PANEL_ORDER.find((c) => healthState(sec(c)) === 'dark');
    if (dark) {
      return { key: `dark:${dark}`, level: 2, accent: 'red', sev: 'SECTOR OFFLINE',
        head: `${sectorName(dark)} IS DARK`, route: 'INTEGRITY AT ZERO', clock: null, sector: dark };
    }
    const crit = PANEL_ORDER.filter((c) => healthState(sec(c)) === 'critical').sort((a, b) => sec(a).integrity - sec(b).integrity)[0];
    if (crit) {
      return { key: `crit:${crit}`, level: 3, accent: 'red', sev: 'SECTOR CRITICAL',
        head: `${sectorName(crit)} CRITICAL`, route: `INTEGRITY ${clamp(sec(crit).integrity)}%`, clock: null, sector: crit };
    }
    if (Number(f.core_output) <= CORE_INSUFFICIENT) {
      return { key: 'core', level: 4, accent: 'amber', sev: 'CORE INSUFFICIENCY DETECTED',
        head: `CORE OUTPUT ${f.core_output}%`, route: 'CAPACITY INSUFFICIENT — SECTORS MUST ENTER BROWNOUT', clock: null };
    }
    if (inCouncil()) {
      const c = f.council || {};
      const order = f.continuity_order && Array.isArray(f.continuity_order.order) ? f.continuity_order : null;
      const route = order
        ? `CONTINUITY ORDER: ${order.order.join(' › ')}${order.brownout && order.brownout.length ? ` · BROWNOUT ${order.brownout.join(' ')}` : ''}`
        : (Number(f.core_output) <= CORE_INSUFFICIENT ? 'CORE CAPACITY INSUFFICIENT — 2 SECTORS MUST ENTER BROWNOUT' : 'CHIEFS + LIAISONS REPORT TO CENTRAL COUNCIL');
      return { key: `council:${c.count || 0}:${c.no_order ? 'no' : ''}:${order ? 'o' : ''}`, level: 5, accent: 'purple', sev: 'CENTRAL COUNCIL',
        head: c.no_order ? 'NO CONTINUITY ORDER RECEIVED' : 'COUNCIL CONVENED', route, clock: { kind: 'council' } };
    }
    const req = (f.requests || []).find((r) => r.status === 'REQUESTED');
    if (req) {
      return { key: `req:${req.id}`, level: 6, accent: 'amber', sev: 'RESOURCE REQUEST',
        head: `${sectorName(req.requester)} NEEDS ${req.amount} ${resName(req.resource)}`,
        route: `${req.supplier} → TRN → ${req.requester}`, clock: null, sector: req.requester };
    }
    const moving = (f.transfers || []).find((t) => routePhase(t) === 'moving' || routePhase(t) === 'sweep');
    if (moving) {
      return { key: `move:${moving.id}`, level: 7, accent: 'green', sev: 'TRANSFER IN PROGRESS',
        head: `${moving.amount} ${resName(moving.resource)} · ${sectorName(moving.from)} → ${sectorName(moving.to)}`,
        route: `${moving.from} → TRN → ${moving.to}`, clock: null };
    }
    const pending = (f.transfers || []).find((t) => t.status === 'PENDING_TRN_APPROVAL');
    if (pending) {
      return { key: `pend:${pending.id}`, level: 7, accent: 'grey', sev: 'TRANSFER WAITING FOR TRANSPORT',
        head: `${pending.amount} ${resName(pending.resource)} · ${sectorName(pending.from)} → ${sectorName(pending.to)}`,
        route: `${pending.from} → TRN → ${pending.to}`, clock: null };
    }
    const major = faults.sort((a, b) => Number(b.tf.severity) - Number(a.tf.severity))[0];
    if (major) {
      const sev = Number(major.tf.severity) || 1;
      return { key: `fault:${major.code}:${major.tf.code}`, level: 8, accent: sev >= 3 ? 'red' : 'amber', sev: U.severityName(sev),
        head: `${sectorName(major.code)} · ${major.tf.code} ${String(major.tf.name || '').toUpperCase()}`,
        route: 'RESOLUTION REQUIRED',
        clock: null,
        sector: major.code };
    }
    const a = f.broadcast && f.broadcast.announcement;
    if (a) {
      return { key: `bc:${a.round}:${a.headline}:${a.message}`, level: 9, accent: 'amber', sev: `CITY BROADCAST · ROUND ${a.round_number} ${a.freshness}`,
        head: String(a.headline || a.message || ''), route: a.headline ? String(a.message || '') : '', clock: null };
    }
    return { key: 'normal', level: 10, accent: 'green', sev: 'STATUS', head: 'CITY OPERATIONS NORMAL', route: 'ALL SECTORS REPORTING', clock: null };
  }

  let bannerClock = null;
  function renderBanner() {
    const ev = priorityEvent();
    const banner = $('banner');
    if (banner.dataset.accent !== ev.accent) banner.dataset.accent = ev.accent;
    if (banner.dataset.level !== String(ev.level)) banner.dataset.level = String(ev.level);
    setText($('b-sev'), ev.sev);
    setText($('b-head'), ev.head);
    setText($('b-route'), ev.route || '');
    bannerClock = ev.clock || null;
    const c = $('b-clock');
    if (!bannerClock) { show(c, false); }
    else if (bannerClock.kind === 'text') { setText(c, bannerClock.text); c.className = `b-clock clock ${bannerClock.cls || ''}`.trim(); show(c, true); }
    else show(c, true);
    if (ev.key !== bannerKey) {
      bannerKey = ev.key;
      if (booted) {
        banner.classList.remove('swap');
        void banner.offsetWidth;
        banner.classList.add('swap');
      }
    }
  }

  /** Whole-screen modes that colour more than one band. */
  function renderModes() {
    const w = $('wall');
    w.classList.toggle('council', inCouncil() && !frame.debrief);
    w.classList.toggle('core-low', Number(frame.core_output) <= CORE_INSUFFICIENT);
  }

  function renderAlert() {
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

  function renderDebrief() {
    const d = frame.debrief;
    show($('debrief'), !!d);
    if (!d) return;
    const fmt = (v, unit) => (v == null ? '—' : unit === 's' ? U.mmss(v) : unit === '%' ? `${v}%` : String(v));
    $('debrief-rows').innerHTML = (Array.isArray(d.rows) ? d.rows : []).map((r) => `<tr>
        <td class="metric">${U.escapeHtml(r.label)}</td>
        <td>${U.escapeHtml(fmt(d.R3 ? d.R3[r.key] : null, r.unit))}</td>
        <td>${U.escapeHtml(fmt(d.R4 ? d.R4[r.key] : null, r.unit))}</td>
      </tr>`).join('');
  }

  function renderPaused() { show($('paused'), !!frame.paused); }

  /** The round's upkeep pass: 3.5 seconds of UPKEEP PROCESSED, with what it cost. */
  function renderCycle() {
    const n = Number(frame.cycle && frame.cycle.number);
    if (prevCycle !== null && Number.isFinite(n) && n > prevCycle) {
      const feed = Array.isArray(frame.ticker) ? frame.ticker : (frame.feed || []);
      const cost = feed.filter((e) => e.kind === 'cycle' && ageOf(e.t) < 6 && /missed upkeep/i.test(e.text))
        .map((e) => `${e.text.slice(0, 3)} MISSED UPKEEP`);
      setText($('cycle-flash-title'), 'ROUND UPKEEP PROCESSED');
      setText($('cycle-flash-sub'), cost.length ? cost.join('  ·  ') : '');
      cycleFlashUntil = performance.now() + CYCLE_FLASH_MS;
      show($('cycle-flash'), true);
    }
    if (Number.isFinite(n)) prevCycle = n;
  }

  // -- the ticker: the last four things worth knowing ---------------------------------

  /** Turn a feed line into a short, readable event — or nothing. */
  function tickerLine(e) {
    const t = String(e.text || '');
    let m;
    switch (e.kind) {
      case 'fault':
        if ((m = t.match(/^(\w{3}) fault detected: (F-\d+)/))) return { cls: 'bad', text: `${m[1]} ${m[2]} DETECTED` };
        return { cls: 'bad', text: t.toUpperCase() };
      case 'resolve':
        if ((m = t.match(/^(\w{3}) resolved (F-\d+)/))) return { cls: 'ok', text: `${m[1]} ${m[2]} RESOLVED` };
        return { cls: 'ok', text: t.toUpperCase() };
      case 'clear':
        if ((m = t.match(/^(\w{3}) (F-\d+) cleared/))) return { cls: 'ok', text: `${m[1]} ${m[2]} CLEARED` };
        return null;      case 'status':
        if ((m = t.match(/^(\w{3}) CRITICAL$/))) return { cls: 'bad', text: `${m[1]} ENTERED CRITICAL` };
        if ((m = t.match(/^(\w{3}) IS DARK$/))) return { cls: 'bad', text: `${m[1]} WENT DARK` };
        if ((m = t.match(/^(\w{3}) → (\w+)$/))) {
          if (m[2] === 'ACTIVE') return { cls: 'ok', text: `${m[1]} RESTORED` };
          if (m[2] === 'DARK') return { cls: 'bad', text: `${m[1]} WENT DARK` };
          if (m[2] === 'BROWNOUT') return { cls: 'warn', text: `${m[1]} BROWNOUT` };
          return { cls: 'warn', text: `${m[1]} ${m[2]}` };
        }
        return { cls: 'warn', text: t.toUpperCase() };
      case 'transfer':
        if ((m = t.match(/^TRN approved (\w{3}) → (\w{3}): (\d+) (\w+)/))) return { cls: 'ok', text: `${m[1]} → ${m[2]} ${m[3]} ${resName(m[4])} DELIVERED` };
        if ((m = t.match(/^Delivered (\w{3}) → (\w{3}): (\d+) (\w+)/))) return { cls: 'ok', text: `${m[1]} → ${m[2]} ${m[3]} ${resName(m[4])} DELIVERED` };
        return null;   // asks, fulfilments and refusals are the banner's business, not history
      case 'core':
        if ((m = t.match(/^CORE OUTPUT (\d+)%/))) return { cls: 'warn', text: `CORE OUTPUT ${m[1]}%` };
        return { cls: 'warn', text: t.toUpperCase() };
      case 'cycle':
        if ((m = t.match(/^(R\d+) UPKEEP PROCESSED/))) return { cls: 'info', text: `${m[1]} UPKEEP PROCESSED` };
        if ((m = t.match(/^(\w{3}) missed upkeep/))) return { cls: 'warn', text: `${m[1]} MISSED UPKEEP` };
        return null;
      case 'council':
        if (/SUMMONED/i.test(t)) return { cls: 'council', text: 'COUNCIL CONVENED' };
        if (/NO CONTINUITY/i.test(t)) return { cls: 'bad', text: 'NO CONTINUITY ORDER RECEIVED' };
        if (/ENDED/i.test(t)) return { cls: 'council', text: 'COUNCIL CONCLUDED' };
        return { cls: 'council', text: t.toUpperCase() };
      case 'order':
        return { cls: 'council', text: 'CONTINUITY ORDER ACCEPTED' };
      case 'blackout':
        return { cls: 'bad', text: t.toUpperCase() };
      case 'event':
        return { cls: 'warn', text: t.toUpperCase() };
      case 'announce':
        if ((m = t.match(/^COM: (.*)$/))) return { cls: 'info', text: `BROADCAST · ${m[1].toUpperCase()}` };
        if ((m = t.match(/^AGR intervention: (.*)$/))) return { cls: 'info', text: `AGR INTERVENTION · ${m[1].toUpperCase()}` };
        return { cls: 'info', text: t.toUpperCase() };
      case 'phase':
        return { cls: 'info', text: t.toUpperCase() };
      default:
        return null;   // pause, round, breather, injury: the bands already say it
    }
  }

  const tickerRows = new Map();   // key -> element
  function renderTicker() {
    const feed = Array.isArray(frame.ticker) ? frame.ticker : (frame.feed || []);
    const lines = [];
    for (const e of feed) {
      const line = tickerLine(e);
      if (line) lines.push({ key: `${e.t}|${e.kind}|${e.text}`, t: e.t, ...line });
    }
    for (const d of derivedLines) lines.push(d);
    lines.sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
    const keep = lines.slice(0, TICKER_MAX);
    const host = $('ticker');
    const keys = new Set(keep.map((l) => l.key));
    for (const [key, node] of tickerRows) {
      if (!keys.has(key)) { node.remove(); tickerRows.delete(key); }
    }
    keep.forEach((l, i) => {
      let node = tickerRows.get(l.key);
      if (!node) {
        node = document.createElement('div');
        node.className = `tk ${l.cls || ''}${booted ? ' enter' : ''}`.trim();
        node.innerHTML = `<time>${hhmm(l.t)}</time><span></span>`;
        node.querySelector('span').textContent = l.text;
        tickerRows.set(l.key, node);
      }
      if (host.children[i] !== node) host.insertBefore(node, host.children[i] || null);
    });
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
    setText($('cycle-clock'), U.mmss(secs));
    const urgency = !running ? '' : secs <= 10 ? ' final' : secs <= 60 ? ' danger' : secs <= 120 ? ' warn' : '';
    const cls = `hud-stat hud-time${council ? ' council' : ''}${urgency}`;
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

    // The banner's clock: the council countdown.
    if (bannerClock && bannerClock.kind !== 'text') {
      const c = $('b-clock');
      if (bannerClock.kind === 'council') {
        const cc = U.countdown(frame.council_clock, frozen);
        setText(c, U.mmss(cc));
        c.className = `b-clock clock${cc < 30 ? ' danger' : cc < 60 ? ' warn' : ''}`;      }
    }

    // Overlays and routes with a life of their own.
    if (!$('core-shock').hidden && now >= shockUntil) show($('core-shock'), false);
    if (!$('cycle-flash').hidden && now >= cycleFlashUntil) show($('cycle-flash'), false);
    if (routeEls.size || (frame.transfers || []).length) renderMovement();
    show($('alert-full'), !!frame.alert && alertIsFull());
    $('wall').classList.toggle('dimmed', !$('core-shock').hidden || !!frame.paused || alertIsFull());
  }

  buildMap();
  buildCards();
  setInterval(tick, TICK_MS);
})();
