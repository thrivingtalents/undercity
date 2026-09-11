'use strict';
/**
 * CITY WALL — the projector view: a living picture of HAVEN-9, not a dashboard.
 *
 * The city itself is the illustration in public/wall/art/haven9-map.png
 * (prepared from ./Asset by tools/prepare-wall-art.js). Everything alive is
 * drawn OVER it in an SVG that uses the illustration's own pixel grid
 * (1672×941) as its coordinate system, so every overlay is traced straight
 * from the artwork:
 *
 *   · a live label with the sector's icon sits exactly on the painted callout
 *     and replaces it;
 *   · a compact marker (integrity ring, number, and a word only when it is
 *     not STABLE) and a badge stack (fault clock, low stock, injured) sit on
 *     the rock beside it, only when something is wrong;
 *   · each district's footprint carries the state: an amber tint when
 *     degraded, a red pulse when critical, flickering darkness in brownout,
 *     and a greyscale copy of the artwork when dark;
 *   · the Geothermal Core glows, dims and finally flickers with core output.
 *
 * It answers four questions and nothing else: how is the city (CITY / CORE
 * and the Core's glow), which district (the district itself), how long
 * (NEXT CYCLE or the council clock), what just happened (one toast).
 * Nothing says "no active faults": a healthy district is simply lit.
 *
 * Rendering split:
 *   buildMap()  once — backdrop, defs, districts, core, tunnel 7
 *   render()    per state frame — keyed updates of texts, classes and badges
 *   tick()      every 250 ms — countdown texts, toast timing, the alert mode
 */
(function wall() {
  const U = window.Undercity;
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const CTX = U.context();

  const ALERT_FULL_S = 8;      // mirrors alert_full_screen_s; the frame carries the real value
  const TICK_MS = 250;
  const TOAST_MS = 3600;
  const SHOCK_MS = 4500;
  const RING_R = 13;
  const RING_LEN = 2 * Math.PI * RING_R;
  const ART = '/assets/wall/art';
  const MAP = { w: 1672, h: 941, src: `${ART}/haven9-map.png` };
  const DEBUG = /[?&]debug/.test(location.search);

  /**
   * Where things are on the illustration, in its pixels.
   *   footprint  the platform outline (state tints, the dark clip)
   *   label      the painted callout's centre and width — the live label covers it
   *   marker     integrity pill, on rock beside the label
   *   badges     where the warning stack starts and which way it grows
   */
  const DISTRICTS = {
    POW: { colour: '#E8B33A', name: 'POWER GRID',
      footprint: [[124, 290], [268, 206], [470, 208], [552, 292], [518, 396], [352, 444], [172, 412], [108, 348]],
      label: { x: 240, y: 147, w: 262 }, marker: { x: 240, y: 100 }, badges: { x: 240, y: 62, dir: 'up' } },
    WTR: { colour: '#3A8FE8', name: 'WATER & FILTRATION',
      footprint: [[572, 142], [698, 74], [1002, 78], [1088, 176], [1030, 266], [760, 286], [598, 236]],
      // markers beside a label are anchored by their inner edge, so a word never overlaps the name
      label: { x: 837, y: 40, w: 340 }, marker: { x: 1017, y: 40, anchor: 'left' }, badges: { x: 560, y: 40, dir: 'left' } },
    COM: { colour: '#B07AD8', name: 'COMMS & SENSORS',
      footprint: [[1194, 292], [1300, 210], [1566, 220], [1660, 322], [1600, 426], [1330, 426], [1210, 376]],
      label: { x: 1425, y: 152, w: 316 }, marker: { x: 1257, y: 152, anchor: 'right' }, badges: { x: 1425, y: 105, dir: 'up' } },
    MED: { colour: '#E85A5A', name: 'MEDICAL BAY',
      footprint: [[104, 562], [240, 470], [500, 480], [586, 588], [520, 722], [270, 746], [120, 682]],
      label: { x: 172, y: 490, w: 252 }, marker: { x: 172, y: 445 }, badges: { x: 430, y: 500, dir: 'up' } },
    TRN: { colour: '#9A9A9A', name: 'TRANSPORT & TUNNELS',
      footprint: [[520, 692], [660, 596], [1000, 596], [1140, 702], [1060, 862], [720, 892], [560, 812]],
      label: { x: 840, y: 855, w: 356 }, marker: { x: 1028, y: 855, anchor: 'left' }, badges: { x: 570, y: 855, dir: 'left' } },
    AGR: { colour: '#5AB86A', name: 'AGRICULTURE',
      footprint: [[1096, 592], [1210, 462], [1600, 472], [1656, 602], [1560, 766], [1260, 792], [1128, 700]],
      label: { x: 1530, y: 493, w: 254 }, marker: { x: 1530, y: 446 }, badges: { x: 1400, y: 520, dir: 'up' } },
  };
  const ORDER = ['WTR', 'POW', 'COM', 'MED', 'TRN', 'AGR'];
  const CORE = { x: 836, y: 398, r: 96, label: { x: 855, y: 295, w: 300 }, tunnel7: [[838, 548], [838, 612]] };
  const ROUND_LABEL = { R0: 'ORIENTATION', R1: 'ROUND 1', R2: 'ROUND 2', R3: 'ROUND 3', R4: 'AFTERSHOCK' };
  const WORD = { stable: '', degraded: '⚠ DEGRADED', critical: '⚠ CRITICAL', brownout: 'BROWNOUT', dark: 'OFFLINE' };

  let frame = null;
  let frameAt = 0;
  let prevCore = null;
  let alertRenderedId = null;
  let urgentKey = null;
  let shockUntil = 0;
  const districtEls = {};

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
  /** Status word: never colour alone. The server computes it from the thresholds. */
  function statusWord(s) {
    if (s.status_word) return s.status_word;
    if (s.status === 'DARK' || s.status === 'BROWNOUT' || s.status === 'CRITICAL') return s.status;
    return s.integrity >= 60 ? 'STABLE' : s.integrity >= 30 ? 'DEGRADED' : 'CRITICAL';
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
  function coreBand(v) {
    if (v >= 85) return 'healthy';
    if (v >= 70) return 'weaker';
    if (v >= 50) return 'warning';
    if (v >= 30) return 'unstable';
    return 'critical';
  }
  function lowKeys(inventory) {
    const thresholds = (frame && frame.thresholds) || {};
    return Object.entries(inventory)
      .filter(([k, v]) => Number(v) <= 0 || Number(v) < Number(thresholds[k] ?? 0))
      .map(([k]) => k);
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

  // -- the map ------------------------------------------------------------------------

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

    const marker = el('g', { class: 'marker', transform: `translate(${d.marker.x},${d.marker.y})` });
    marker.appendChild(el('rect', { class: 'm-bg', x: -80, y: -22, width: 160, height: 44, rx: 22 }));
    marker.appendChild(el('circle', { class: 'ring-bg', cx: -50, cy: 0, r: RING_R }));
    marker.appendChild(el('circle', { class: 'ring-fg', cx: -50, cy: 0, r: RING_R, transform: 'rotate(-90 -50 0)', 'stroke-dasharray': `${RING_LEN} ${RING_LEN}` }));
    marker.appendChild(text('--', -28, 10, 'd-int', 'start'));
    marker.appendChild(text('', 40, 7, 'd-word', 'start'));
    g.appendChild(marker);

    if (DEBUG) {
      g.appendChild(el('circle', { cx: d.badges.x, cy: d.badges.y, r: 6, fill: '#0ff' }));
    }
    return g;
  }

  function buildCore() {
    const g = el('g', { class: 'core' });
    g.appendChild(el('circle', { class: 'core-dim', cx: CORE.x, cy: CORE.y, r: CORE.r * 1.5 }));
    g.appendChild(el('circle', { class: 'core-glow', cx: CORE.x, cy: CORE.y, r: CORE.r }));
    g.appendChild(el('circle', { class: 'core-alarm', cx: CORE.x, cy: CORE.y, r: CORE.r * 1.35 }));
    // Tunnel 7: quiet until a breach names it
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
    for (const code of ORDER) {
      const g = buildDistrict(code);
      districtEls[code] = g;
      svg.appendChild(g);
    }
  }

  // -- per-frame render ------------------------------------------------------------------

  function render() {
    if (!frame) return;
    renderHud();
    renderDistricts();
    renderCore();
    renderUrgent();
    renderCouncil();
    renderAlert();
    renderDebrief();
    renderPaused();
    renderFeed();
    tick();
  }

  function renderHud() {
    const label = frame.mode === 'DEBRIEF' ? 'DEBRIEF' : (ROUND_LABEL[frame.round] || frame.round || '');
    setText($('phase-name'), label);
    setStat('hud-city', 'stability', frame.city_stability);
    setStat('hud-core', 'core-output', frame.core_output);
    setText($('time-label'), inCouncil() ? 'COUNCIL' : 'NEXT CYCLE');
    show($('tag-blackout'), !!(frame.blackout && frame.blackout.active));
    show($('tag-breather'), !!frame.breather);
    show($('tag-sensors'), !!frame.telemetry_degraded);
  }
  function setStat(id, valueId, v) {
    setText($(valueId), Number.isFinite(v) ? String(v) : '--');
    const cls = `hud-stat ${U.integrityClass(v)}`;
    if ($(id).className !== cls) $(id).className = cls;
  }

  function renderDistricts() {
    for (const code of ORDER) {
      const g = districtEls[code];
      const s = frame.sectors && frame.sectors[code];
      if (!g || !s) continue;
      if (s.colour) g.style.setProperty('--accent', s.colour);

      const word = statusWord(s);
      const state = word.toLowerCase();
      if (g.dataset.state !== state) g.dataset.state = state;
      const unresolved = Number(s.unresolved_faults) || 0;
      const tf = s.top_fault || null;
      g.classList.toggle('has-fault', unresolved > 0);

      // marker: ring + number, and the word only when it is not STABLE
      const integrity = clamp(s.integrity);
      const ring = g.querySelector('.ring-fg');
      ring.setAttribute('stroke-dasharray', `${((RING_LEN * integrity) / 100).toFixed(1)} ${RING_LEN.toFixed(1)}`);
      ring.setAttribute('stroke-linecap', integrity > 0 ? 'round' : 'butt');
      setText(g.querySelector('.d-int'), `${integrity}%`);
      setText(g.querySelector('.d-word'), WORD[state] ?? '');
      fitMarker(g);

      // badges: only problems
      const badges = [];
      if (tf) {
        const crisis = Number(tf.severity) >= 3;
        badges.push({
          cls: crisis ? 'b-fault b-crisis' : 'b-fault',
          text: tf.expired ? '⚠ DEADLINE PASSED' : tf.deadline_remaining_s == null ? `⚠ ${tf.code}` : `⚠ ${U.mmss(tf.deadline_remaining_s)}`,
          clock: !tf.expired && tf.deadline_remaining_s != null ? code : null,
          extra: unresolved > 1 ? ` ×${unresolved}` : '',
        });
      } else if (unresolved > 0) {
        badges.push({ cls: 'b-fault', text: `⚠ ×${unresolved}`, extra: '' });
      }
      if (s.inventory && typeof s.inventory === 'object') {
        const low = lowKeys(s.inventory);
        if (low.length) badges.push({ cls: 'b-low', text: `${low.map((k) => U.GLYPH[k] || k.toUpperCase()).join(' ')} LOW`, extra: '' });
      }
      if (s.workforce && Number(s.workforce.injured) > 0) {
        badges.push({ cls: 'b-injured', text: `⚕ ${s.workforce.injured} INJURED`, extra: '' });
      }
      renderBadges(g, DISTRICTS[code].badges, badges);
    }
  }

  /** Size the marker pill to its text: ring, number, then the word if any. */
  function fitMarker(g) {
    const marker = g.querySelector('.marker');
    const num = marker.querySelector('.d-int');
    const word = marker.querySelector('.d-word');
    const numW = num.getComputedTextLength();
    const wordW = word.textContent ? word.getComputedTextLength() : 0;
    const sig = `${numW.toFixed(0)}|${wordW.toFixed(0)}`;
    if (marker.dataset.sig === sig) return;
    marker.dataset.sig = sig;
    const width = 20 + RING_R * 2 + 14 + numW + (wordW ? 14 + wordW : 0) + 20;
    const left = -width / 2;
    // Anchor: 'left' pins the pill's left edge at x (it grows rightwards),
    // 'right' pins its right edge; otherwise the pill is centred on x.
    const spec = DISTRICTS[g.dataset.sector].marker;
    const cx = spec.anchor === 'left' ? spec.x + width / 2 : spec.anchor === 'right' ? spec.x - width / 2 : spec.x;
    marker.setAttribute('transform', `translate(${cx.toFixed(1)},${spec.y})`);
    marker.querySelector('.m-bg').setAttribute('x', left.toFixed(1));
    marker.querySelector('.m-bg').setAttribute('width', width.toFixed(1));
    const ringX = left + 20 + RING_R;
    for (const c of marker.querySelectorAll('circle')) c.setAttribute('cx', ringX.toFixed(1));
    marker.querySelector('.ring-fg').setAttribute('transform', `rotate(-90 ${ringX.toFixed(1)} 0)`);
    num.setAttribute('x', (ringX + RING_R + 14).toFixed(1));
    word.setAttribute('x', (ringX + RING_R + 14 + numW + 14).toFixed(1));
  }

  /** The warning stack for one district, grown up, left or right from its anchor. */
  function renderBadges(g, anchor, badges) {
    const host = g.querySelector('.badges');
    const sig = badges.map((b) => `${b.cls}|${b.text}|${b.extra}|${b.clock || ''}`).join('~');
    if (host.dataset.sig === sig) return;
    host.dataset.sig = sig;
    host.innerHTML = '';
    let cursor = anchor.dir === 'up' ? anchor.y : anchor.x;
    badges.forEach((b) => {
      const badge = el('g', { class: `badge ${b.cls}` });
      const t = text(`${b.text}${b.extra}`, 0, 8, 'badge-text');
      if (b.clock) { t.dataset.clock = b.clock; t.dataset.extra = b.extra; }
      const rect = el('rect', { x: -60, y: -17, width: 120, height: 34, rx: 8 });
      badge.appendChild(rect);
      badge.appendChild(t);
      host.appendChild(badge);
      const w = t.getComputedTextLength() + 30;
      rect.setAttribute('x', (-w / 2).toFixed(1));
      rect.setAttribute('width', w.toFixed(1));
      let cx = anchor.x;
      let cy = anchor.y;
      if (anchor.dir === 'up') { cy = cursor; cursor -= 40; }
      else if (anchor.dir === 'left') { cx = cursor - w / 2; cursor = cx - w / 2 - 10; }
      else { cx = cursor + w / 2; cursor = cx + w / 2 + 10; }
      badge.setAttribute('transform', `translate(${cx.toFixed(1)},${cy.toFixed(1)})`);
    });
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

  /** CRISIS beats EMERGENCY beats INCIDENT; within a severity the shortest clock wins. */
  function urgentFault() {
    let best = null;
    for (const code of ORDER) {
      const s = frame.sectors && frame.sectors[code];
      const tf = s && s.top_fault;
      if (!tf) continue;
      const rem = tf.expired ? -1 : (tf.deadline_remaining_s == null ? Infinity : Number(tf.deadline_remaining_s));
      const cand = { code, tf, sev: Number(tf.severity) || 1, rem };
      if (!best || cand.sev > best.sev || (cand.sev === best.sev && cand.rem < best.rem)) best = cand;
    }
    return best;
  }

  function renderUrgent() {
    const best = urgentFault();
    const bar = $('urgent');
    if (!best) { show(bar, false); urgentKey = null; return; }
    const key = `${best.code}:${best.tf.code}`;
    const s = frame.sectors[best.code];
    setText($('urgent-sector'), sectorName(best.code));
    setText($('urgent-code'), best.tf.code);
    setText($('urgent-name'), String(best.tf.name || '').toUpperCase());
    setText($('urgent-sev'), U.severityName(best.sev));
    bar.style.setProperty('--accent', (s && s.colour) || DISTRICTS[best.code].colour);
    const cls = `urgent sev-${best.sev}`;
    if (bar.className !== cls && !(bar.className === `${cls} swap` && key === urgentKey)) bar.className = cls;
    if (key !== urgentKey) {
      urgentKey = key;
      bar.classList.remove('swap');
      void bar.offsetWidth;
      bar.classList.add('swap');
    }
    bar.dataset.code = best.code;
    show(bar, true);
  }

  function renderCouncil() {
    const on = inCouncil();
    const elc = $('council');
    show(elc, on && !frame.debrief);
    if (!on) return;
    const c = frame.council || {};
    const sub = $('council-sub');
    let subText = 'CHIEFS + LIAISONS REPORT TO CENTRAL COUNCIL';
    let warn = false;
    if (c.no_order) { subText = 'NO CONTINUITY ORDER RECEIVED'; warn = true; }
    else if (Number(frame.core_output) <= 60) { subText = 'CORE CAPACITY INSUFFICIENT — 2 SECTORS MUST ENTER BROWNOUT'; warn = true; }
    setText(sub, subText);
    sub.classList.toggle('warn', warn);
    const order = frame.continuity_order;
    const orderEl = $('council-order');
    if (order && Array.isArray(order.order)) {
      orderEl.hidden = false;
      orderEl.innerHTML = `<span class="ok-tag">CONTINUITY ORDER ACCEPTED</span>${order.order.map(U.escapeHtml).join(' › ')}${
        order.brownout && order.brownout.length ? `<span class="bo-tag">BROWNOUT: ${order.brownout.map(U.escapeHtml).join(' ')}</span>` : ''}`;
    } else {
      orderEl.hidden = true;
    }
  }

  function renderAlert() {
    const a = frame.alert;
    if (!a) {
      show($('alert-full'), false);
      show($('strip-alert'), false);
      alertRenderedId = null;
      return;
    }
    if (a.id !== alertRenderedId) {
      setText($('alert-title'), a.title || '');
      setText($('alert-sub'), a.subtitle || '');
      setText($('alert-big'), a.big || '');
      show($('alert-big'), !!a.big);
      setText($('strip-alert-title'), a.title || '');
      setText($('strip-alert-sub'), a.subtitle ? ` — ${a.subtitle}` : '');
      setText($('strip-alert-big'), a.big || '');
      alertRenderedId = a.id;
    }
    applyAlertMode();
  }
  function applyAlertMode() {
    if (!frame || !frame.alert) return;
    const full = alertIsFull();
    show($('alert-full'), full);
    show($('strip-alert'), !full);
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

  function renderPaused() {
    show($('paused'), !!frame.paused);
  }

  // -- notifications: the feed becomes one toast at a time ------------------------------

  const seenFeed = new Set();
  let feedSeeded = false;
  const toastQueue = [];
  let toastUntil = 0;
  let toastLeaving = false;

  function renderFeed() {
    const feed = Array.isArray(frame.ticker) ? frame.ticker : (frame.feed || []);
    const fresh = [];
    for (const e of feed) {
      const key = `${e.t}|${e.kind}|${e.text}`;
      if (seenFeed.has(key)) continue;
      seenFeed.add(key);
      fresh.push(e);
    }
    if (seenFeed.size > 600) {
      seenFeed.clear();
      for (const e of feed) seenFeed.add(`${e.t}|${e.kind}|${e.text}`);
    }
    // Do not replay history on connect: the room already lived it.
    if (!feedSeeded) { feedSeeded = true; return; }
    for (const e of fresh.reverse()) {
      const t = toastFor(e);
      if (t) toastQueue.push(t);
    }
    while (toastQueue.length > 4) toastQueue.shift();
  }

  /** Turn a feed line into a short, readable notice — or nothing. */
  function toastFor(e) {
    const text = String(e.text || '');
    let m;
    switch (e.kind) {
      case 'fault':
        if ((m = text.match(/^(\w{3}) fault detected: (F-\d+)/))) return { icon: '⚠', cls: 'bad', text: `${sectorName(m[1])} · ${m[2]} DETECTED` };
        return { icon: '⚠', cls: 'bad', text: text.toUpperCase() };
      case 'resolve':
        if ((m = text.match(/^(\w{3}) resolved (F-\d+)/))) return { icon: '✓', cls: 'ok', text: `${sectorName(m[1])} · ${m[2]} RESOLVED` };
        return { icon: '✓', cls: 'ok', text: text.toUpperCase() };
      case 'clear':
        if ((m = text.match(/^(\w{3}) (F-\d+) cleared/))) return { icon: '✓', cls: 'ok', text: `${sectorName(m[1])} · ${m[2]} CLEARED` };
        return null;
      case 'expired':
        if ((m = text.match(/^(\w{3}) (F-\d+) DEADLINE PASSED/))) return { icon: '⚠', cls: 'bad', text: `${sectorName(m[1])} · ${m[2]} DEADLINE PASSED` };
        return { icon: '⚠', cls: 'bad', text: text.toUpperCase() };
      case 'status':
        if ((m = text.match(/^(\w{3}) CRITICAL$/))) return { icon: '⚠', cls: 'bad', text: `${sectorName(m[1])} ENTERED CRITICAL STATE` };
        if ((m = text.match(/^(\w{3}) IS DARK$/))) return { icon: '⚠', cls: 'bad', text: `${sectorName(m[1])} OFFLINE` };
        if ((m = text.match(/^(\w{3}) → (\w+)$/))) {
          if (m[2] === 'ACTIVE') return { icon: '✓', cls: 'ok', text: `${sectorName(m[1])} RESTORED` };
          if (m[2] === 'DARK') return { icon: '⚠', cls: 'bad', text: `${sectorName(m[1])} OFFLINE` };
          return { icon: '⚠', cls: '', text: `${sectorName(m[1])} ${m[2]}` };
        }
        return { icon: '⚠', cls: '', text: text.toUpperCase() };
      case 'transfer':
        if ((m = text.match(/^TRN stamped (\w{3}) → (\w{3}): (\d+) (\w+)/))) return { icon: '✓', cls: 'ok', text: `${sectorName(m[1])} → ${sectorName(m[2])} TRANSFER COMPLETE` };
        if ((m = text.match(/^Delivered (\w{3}) → (\w{3})/))) return { icon: '✓', cls: 'ok', text: `${sectorName(m[1])} → ${sectorName(m[2])} DELIVERED` };
        return null;   // requests are not news for the room
      case 'injury':
        if ((m = text.match(/^(\w{3}): (\d+) workers? (injured|recovered)/))) {
          const hurt = m[3] === 'injured';
          return { icon: hurt ? '⚠' : '✓', cls: hurt ? 'bad' : 'ok', text: `${sectorName(m[1])} · ${m[2]} WORKER${m[2] === '1' ? '' : 'S'} ${m[3].toUpperCase()}` };
        }
        return null;
      case 'core':
        if ((m = text.match(/^CORE OUTPUT (\d+)%/))) return { icon: '⚠', cls: '', text: `CORE OUTPUT ${m[1]}%` };
        return { icon: '⚠', cls: '', text: text.toUpperCase() };
      case 'cycle':
        if ((m = text.match(/^CORE CYCLE (\d+) PROCESSED/))) return { icon: '●', cls: 'info', text: `CYCLE ${m[1]} COMPLETE` };
        if ((m = text.match(/^(\w{3}) missed upkeep/))) return { icon: '⚠', cls: '', text: `${sectorName(m[1])} MISSED UPKEEP` };
        return null;
      case 'council':
        if (/SUMMONED/i.test(text)) return { icon: '⚠', cls: 'council', text: 'COUNCIL SUMMONED' };
        if (/NO CONTINUITY/i.test(text)) return { icon: '⚠', cls: 'bad', text: 'NO CONTINUITY ORDER RECEIVED' };
        if (/ENDED/i.test(text)) return { icon: '●', cls: 'council', text: 'COUNCIL ENDED' };
        return { icon: '●', cls: 'council', text: text.toUpperCase() };
      case 'order':
        return { icon: '✓', cls: 'council', text: 'CONTINUITY ORDER ACCEPTED' };
      case 'blackout':
        return { icon: '⚠', cls: 'bad', text: text.toUpperCase() };
      case 'event':
        return { icon: '⚠', cls: '', text: text.toUpperCase() };
      case 'announce':
        return { icon: '●', cls: 'info', text: text.toUpperCase() };
      case 'phase':
        return { icon: '●', cls: 'info', text: text.toUpperCase() };
      default:
        return null;   // pause, round, breather: the overlays already say it
    }
  }

  function tickToast(now) {
    const toast = $('toast');
    if (!toast.hidden) {
      if (now >= toastUntil && !toastLeaving) {
        toastLeaving = true;
        toast.classList.add('leaving');
        toastUntil = now + 450;
      } else if (now >= toastUntil && toastLeaving) {
        toast.hidden = true;
        toast.classList.remove('leaving');
        toastLeaving = false;
      }
      return;
    }
    if (toastQueue.length) {
      const t = toastQueue.shift();
      $('toast-icon').textContent = t.icon;
      $('toast-text').textContent = t.text;
      toast.className = `toast ${t.cls || ''}`.trim();
      toast.hidden = false;
      toastUntil = now + TOAST_MS;
    }
  }

  // -- the 250 ms tick: countdown texts only ------------------------------------------

  function tick() {
    if (!frame) return;
    const now = performance.now();
    const frozen = !!frame.frozen;

    // HUD time: the council clock while the Council sits, else the next cycle.
    const council = inCouncil();
    const clockObj = council ? frame.council_clock : frame.cycle;
    const secs = U.countdown(clockObj, frozen);
    const running = !!(clockObj && clockObj.running) && !frozen;
    const hud = $('hud-time');
    setText($('cycle-clock'), U.mmss(secs));
    const cls = `hud-stat hud-time${council ? ' council' : ''}${running && secs < 30 ? ' pulse strong' : running && secs < 60 ? ' strong' : running && secs < 120 ? ' warn' : ''}`;
    if (hud.className !== cls) hud.className = cls;

    // The final ten seconds of a cycle, as a number the whole room can count.
    const cyc = U.countdown(frame.cycle, frozen);
    const finalOn = !council && !!(frame.cycle && frame.cycle.running) && !frozen && cyc > 0 && cyc <= 10;
    const fc = $('final-count');
    if (finalOn) {
      const digit = String(Math.ceil(cyc));
      if (fc.textContent !== digit) { fc.textContent = digit; fc.hidden = true; void fc.offsetWidth; }
      fc.hidden = false;
    } else if (!fc.hidden) {
      fc.hidden = true;
      fc.textContent = '';
    }

    // Council takeover clock.
    if (council) {
      const cc = U.countdown(frame.council_clock, frozen);
      const c = $('council-clock');
      setText(c, U.mmss(cc));
      c.classList.toggle('pulse', cc < 30);
    }

    // District fault badges and the urgent line.
    for (const t of document.querySelectorAll('[data-clock]')) {
      const s = frame.sectors && frame.sectors[t.dataset.clock];
      const tf = s && s.top_fault;
      if (!tf || tf.expired || tf.deadline_remaining_s == null) continue;
      const left = U.countdown({ running: !frozen, remaining_s: tf.deadline_remaining_s }, frozen);
      setText(t, `⚠ ${U.mmss(left)}${t.dataset.extra || ''}`);
    }
    const bar = $('urgent');
    if (!bar.hidden) {
      const s = frame.sectors && frame.sectors[bar.dataset.code];
      const tf = s && s.top_fault;
      const c = $('urgent-clock');
      if (tf && tf.expired) { setText(c, 'DEADLINE PASSED'); c.className = 'u-clock clock passed'; }
      else if (tf && tf.deadline_remaining_s != null) {
        const left = U.countdown({ running: !frozen, remaining_s: tf.deadline_remaining_s }, frozen);
        setText(c, U.mmss(left));
        c.className = `u-clock clock${left < 30 ? ' danger' : left < 120 ? ' warn' : ''}`;
      } else { setText(c, ''); c.className = 'u-clock clock'; }
    }

    // Overlays with a life of their own.
    if (!$('core-shock').hidden && now >= shockUntil) show($('core-shock'), false);
    $('wall').classList.toggle('dimmed', !$('core-shock').hidden || council || !!frame.paused || alertIsFull());
    applyAlertMode();
    tickToast(now);
  }

  buildMap();
  setInterval(tick, TICK_MS);
})();
