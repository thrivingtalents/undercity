'use strict';
/**
 * CITY WALL — the projector view: a living picture of HAVEN-9, not a dashboard.
 *
 * It answers four questions and nothing else:
 *   1 how is the city doing        → CITY / CORE in the HUD, and the Core's glow
 *   2 which sector has a problem   → the district itself: lighting, marker, badges
 *   3 how much time do we have     → NEXT CYCLE (or the council clock)
 *   4 what just happened           → one temporary toast, then it fades
 *
 * Everything on screen comes from the wall frame (lib/visibility.js →
 * forBigscreen). Nothing the server withholds is reconstructed here, and
 * nothing is shown while it is normal: a healthy district is simply lit.
 * There is no "NO ACTIVE FAULTS" anywhere — quiet is the message.
 *
 * Rendering split:
 *   buildMap()  once — the isometric city is drawn procedurally into the SVG
 *   render()    per state frame — keyed updates of texts, classes and badges
 *   tick()      every 250 ms — countdown texts, toast timing, the alert mode
 */
(function wall() {
  const U = window.Undercity;
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const CTX = U.context();

  const ALERT_FULL_S = 8;      // mirrors alert_full_screen_s; the frame carries the real value
  const TICK_MS = 250;
  const TOAST_MS = 3600;
  const SHOCK_MS = 4500;
  const RING_R = 13;
  const RING_LEN = 2 * Math.PI * RING_R;

  /** Where each district sits (platform centre, map units) and its identity. */
  const DISTRICTS = {
    WTR: { x: 960,  y: 200, colour: '#3A8FE8', glyph: '💧', name: 'WATER & FILTRATION' },
    POW: { x: 380,  y: 400, colour: '#E8B33A', glyph: '⚡', name: 'POWER GRID' },
    COM: { x: 1540, y: 400, colour: '#B07AD8', glyph: '📡', name: 'COMMS & SENSORS' },
    MED: { x: 520,  y: 735, colour: '#E85A5A', glyph: '⚕', name: 'MEDICAL BAY' },
    TRN: { x: 960,  y: 765, colour: '#9A9A9A', glyph: '🚇', name: 'TRANSPORT & TUNNELS' },
    AGR: { x: 1400, y: 735, colour: '#5AB86A', glyph: '🌱', name: 'AGRICULTURE' },
  };
  const ORDER = ['WTR', 'POW', 'COM', 'MED', 'TRN', 'AGR'];
  const CORE = { x: 960, y: 470 };
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

  // -- isometric drawing ---------------------------------------------------------------

  /** Ground point (u, v) at height z → screen. 2:1-ish projection. */
  const iso = (u, v, z = 0) => [(u - v) * 0.9, (u + v) * 0.5 - z];
  const P = (list) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

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
  /** Darken (f < 1) or lighten (f > 1) a #rrggbb colour. */
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const c = (x) => Math.max(0, Math.min(255, Math.round(x * f)));
    return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
  }
  /** An isometric block on the ground at (u, v), footprint w×d, height h. */
  function box(u, v, w, d, h, fill, cls = '') {
    return el('g', { class: `box ${cls}`.trim() }, [
      el('polygon', { points: P([iso(u, v + d, h), iso(u + w, v + d, h), iso(u + w, v + d, 0), iso(u, v + d, 0)]), fill: shade(fill, 0.62) }),
      el('polygon', { points: P([iso(u + w, v, h), iso(u + w, v + d, h), iso(u + w, v + d, 0), iso(u + w, v, 0)]), fill: shade(fill, 0.42) }),
      el('polygon', { points: P([iso(u, v, h), iso(u + w, v, h), iso(u + w, v + d, h), iso(u, v + d, h)]), fill }),
    ]);
  }
  /** A tank or turbine housing: an isometric cylinder. */
  function cylinder(u, v, r, h, fill, cls = '') {
    const [cx, cy] = iso(u, v, 0);
    const rx = r * 0.9;
    const ry = r * 0.5;
    return el('g', { class: `cyl ${cls}`.trim() }, [
      el('path', { d: `M ${cx - rx} ${cy} A ${rx} ${ry} 0 0 0 ${cx + rx} ${cy} L ${cx + rx} ${cy - h} A ${rx} ${ry} 0 0 1 ${cx - rx} ${cy - h} Z`, fill: shade(fill, 0.55) }),
      el('ellipse', { cx, cy: cy - h, rx, ry, fill }),
    ]);
  }
  function lamp(u, v, z) {
    const [x, y] = iso(u, v, z);
    return el('circle', { class: 'warnlight', cx: x.toFixed(1), cy: y.toFixed(1), r: 4 });
  }
  /** Platform corners relative to a district centre (the top face of the slab). */
  const CORNER = { top: [-45, -111], right: [171, 9], bottom: [45, 79], left: [-171, -41] };
  const corner = (code, which) => [DISTRICTS[code].x + CORNER[which][0], DISTRICTS[code].y + CORNER[which][1]];

  // -- the map ------------------------------------------------------------------------

  function buildDefs() {
    const defs = el('defs');
    const radial = (id, stops) => el('radialGradient', { id },
      stops.map(([o, c, a]) => el('stop', { offset: o, 'stop-color': c, 'stop-opacity': a })));
    defs.appendChild(radial('gRock', [['0%', '#171d23', 1], ['100%', '#07090b', 1]]));
    for (const [code, d] of Object.entries(DISTRICTS)) {
      defs.appendChild(radial(`glow-${code}`, [['0%', d.colour, 0.5], ['60%', d.colour, 0.12], ['100%', d.colour, 0]]));
    }
    defs.appendChild(radial('gAlarm', [['0%', '#E85A5A', 0.6], ['60%', '#E85A5A', 0.15], ['100%', '#E85A5A', 0]]));
    defs.appendChild(radial('gHeat', [['0%', '#ffd88a', 0.6], ['45%', '#e8963a', 0.18], ['100%', '#e8963a', 0]]));
    defs.appendChild(radial('gOrb', [['0%', '#fff6d6', 1], ['55%', '#f0b64a', 1], ['100%', '#b0641c', 1]]));
    defs.appendChild(radial('gOrbWarn', [['0%', '#ffe2b0', 1], ['55%', '#f08a2a', 1], ['100%', '#8a3a10', 1]]));
    defs.appendChild(radial('gOrbCrit', [['0%', '#ffd0d0', 1], ['55%', '#e85a5a', 1], ['100%', '#5a1414', 1]]));
    defs.appendChild(el('linearGradient', { id: 'gSweep', x1: '0', y1: '0', x2: '1', y2: '0' }, [
      el('stop', { offset: '0%', 'stop-color': '#d9c8ff', 'stop-opacity': 0.5 }),
      el('stop', { offset: '100%', 'stop-color': '#d9c8ff', 'stop-opacity': 0 }),
    ]));
    return defs;
  }

  function buildBackground() {
    const g = el('g', { class: 'bg' });
    g.appendChild(el('rect', { x: 0, y: 0, width: 1920, height: 900, fill: 'url(#gRock)' }));
    // rock strata: a few slow waves, barely there
    for (let i = 0; i < 7; i += 1) {
      const y = 60 + i * 125;
      const a = (i % 2 ? 1 : -1) * 22;
      g.appendChild(el('path', { class: 'strata', d: `M 0 ${y} C 380 ${y + a}, 640 ${y - a}, 960 ${y} S 1560 ${y + a}, 1920 ${y - a / 2}` }));
    }
    // two boulders of darker rock, for depth
    g.appendChild(el('ellipse', { class: 'rock', cx: 240, cy: 120, rx: 260, ry: 90 }));
    g.appendChild(el('ellipse', { class: 'rock', cx: 1700, cy: 780, rx: 220, ry: 80 }));
    return g;
  }

  /** Tunnels, cables, pipes, rails and the data link — drawn under the districts. */
  function buildLinks() {
    const g = el('g', { class: 'links' });
    const seg = (cls, [x1, y1], [x2, y2]) =>
      el('path', { class: `link ${cls}`, d: `M ${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2} ${x2} ${y2}`, fill: 'none' });

    g.appendChild(seg('service', corner('POW', 'bottom'), corner('MED', 'top')));
    g.appendChild(seg('service', corner('COM', 'bottom'), corner('AGR', 'top')));

    // Tunnel 7: Transport to the Core. Quiet until a breach names it.
    const [tx, ty] = corner('TRN', 'top');
    const t7 = `M ${tx} ${ty} L ${CORE.x - 20} ${CORE.y + 92}`;
    g.appendChild(el('path', { class: 'link tunnel', d: t7, fill: 'none' }));
    g.appendChild(el('path', { class: 'link tunnel-core', d: t7, fill: 'none' }));
    g.appendChild(text('TUNNEL 7', (tx + CORE.x) / 2 - 70, (ty + CORE.y + 92) / 2 + 6, 't7-label', 'end'));

    g.appendChild(seg('cable', corner('POW', 'right'), [CORE.x - 140, CORE.y + 26]));
    g.appendChild(seg('cable-flow', corner('POW', 'right'), [CORE.x - 140, CORE.y + 26]));
    g.appendChild(seg('pipe', corner('WTR', 'bottom'), [CORE.x + 10, CORE.y - 66]));
    g.appendChild(seg('pipe-flow', corner('WTR', 'bottom'), [CORE.x + 10, CORE.y - 66]));
    g.appendChild(seg('data', corner('COM', 'left'), [CORE.x + 140, CORE.y + 26]));
    g.appendChild(seg('data-flow', corner('COM', 'left'), [CORE.x + 140, CORE.y + 26]));

    // The rail: Medical → Transport → Agriculture, corner to corner.
    const rail = [corner('MED', 'right'), corner('TRN', 'left'), corner('TRN', 'right'), corner('AGR', 'left')];
    const d = rail.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ');
    g.appendChild(el('path', { class: 'link rail', d, fill: 'none' }));
    g.appendChild(el('path', { class: 'link rail-line', d, fill: 'none' }));
    g.dataset.rail = `${d} ${rail.slice(0, -1).reverse().map(([x, y]) => `L ${x} ${y}`).join(' ')}`;
    return g;
  }

  /** The train shuttles Medical ↔ Agriculture through Transport, above the platforms. */
  function buildVehicles(railPath) {
    const g = el('g', { class: 'vehicles' });
    const train = el('g', { class: 'train-group' }, [
      el('rect', { class: 'train', x: -16, y: -7, width: 32, height: 14, rx: 4 }),
      el('rect', { class: 'train-window', x: -10, y: -4, width: 6, height: 5, rx: 1 }),
      el('rect', { class: 'train-window', x: -1, y: -4, width: 6, height: 5, rx: 1 }),
      el('rect', { class: 'train-window', x: 8, y: -4, width: 6, height: 5, rx: 1 }),
    ]);
    const motion = el('animateMotion', { dur: '22s', repeatCount: 'indefinite', rotate: 'auto', path: railPath });
    train.appendChild(motion);
    g.appendChild(train);
    return g;
  }

  /** The buildings and machinery of one district, in its own iso coordinates. */
  function structures(code, lights) {
    const g = el('g', { class: 'structures' });
    switch (code) {
      case 'POW': {
        g.appendChild(box(-95, -45, 80, 70, 44, '#8a6b22'));
        g.appendChild(el('polygon', { points: P([iso(-95, -45, 44.5), iso(-15, -45, 44.5), iso(-15, -32, 44.5), iso(-95, -32, 44.5)]), fill: '#3a2c0c' }));
        for (const [u, v] of [[38, -38], [38, 18]]) {
          g.appendChild(cylinder(u, v, 20, 26, '#6e5f36'));
          const [tx, ty] = iso(u, v, 26);
          const turbine = el('g', { class: 'turbine' }, [el('circle', { r: 20, fill: 'none' })]);
          for (const a of [0, 120, 240]) turbine.appendChild(el('rect', { x: -3, y: -19, width: 6, height: 19, rx: 2, fill: '#f2d27a', transform: `rotate(${a})` }));
          turbine.appendChild(el('circle', { r: 4, fill: '#fff3c4' }));
          g.appendChild(el('g', { transform: `translate(${tx.toFixed(1)},${ty.toFixed(1)})` }, [turbine]));
          for (let i = 0; i < 3; i += 1) lights.appendChild(el('circle', { class: 'spark', cx: (tx + (i - 1) * 9).toFixed(1), cy: (ty - 16 - i * 4).toFixed(1), r: 2.5, fill: '#ffd36b' }));
        }
        g.appendChild(box(-30, 26, 34, 26, 18, '#5c5548'));
        g.appendChild(el('polyline', { class: 'cable-local', points: P([iso(-40, -10, 30), iso(-25, 15, 24), iso(-13, 26, 18)]), fill: 'none' }));
        lights.appendChild(lamp(-55, -40, 47));
        break;
      }
      case 'WTR': {
        g.appendChild(cylinder(-55, -10, 34, 40, '#2f6fb5'));
        { const [cx, cy] = iso(-55, -10, 40); g.appendChild(el('ellipse', { cx: cx.toFixed(1), cy: cy.toFixed(1), rx: 24, ry: 12, fill: '#6fb3ff', opacity: 0.85 })); }
        g.appendChild(cylinder(18, 32, 26, 32, '#2f6fb5'));
        { const [cx, cy] = iso(18, 32, 32); g.appendChild(el('ellipse', { cx: cx.toFixed(1), cy: cy.toFixed(1), rx: 17, ry: 8.5, fill: '#6fb3ff', opacity: 0.85 })); }
        g.appendChild(box(30, -58, 62, 46, 30, '#3e5c7c'));
        const pipe = P([iso(-20, -10, 14), iso(30, -28, 14), iso(62, -58, 14)]);
        g.appendChild(el('polyline', { class: 'pipe-local', points: pipe, fill: 'none' }));
        g.appendChild(el('polyline', { class: 'pipe-flow', points: pipe, fill: 'none' }));
        for (let i = 0; i < 3; i += 1) {
          const [lx, ly] = iso(-25, 14, 12);
          lights.appendChild(el('circle', { class: 'leak', cx: (lx + i * 7).toFixed(1), cy: (ly + i * 4).toFixed(1), r: 2.5, fill: '#7dc0ff' }));
        }
        lights.appendChild(lamp(58, -54, 33));
        break;
      }
      case 'MED': {
        g.appendChild(box(-75, -45, 105, 72, 40, '#7d3d3d'));
        g.appendChild(el('polygon', { points: P([iso(-35, -25, 41), iso(-15, -25, 41), iso(-15, 15, 41), iso(-35, 15, 41)]), fill: '#ffe1e1' }));
        g.appendChild(el('polygon', { points: P([iso(-45, -15, 41), iso(-5, -15, 41), iso(-5, 5, 41), iso(-45, 5, 41)]), fill: '#ffe1e1' }));
        g.appendChild(box(40, -5, 50, 48, 26, '#6d4b4b'));
        const [bx, by] = iso(65, 19, 27);
        lights.appendChild(el('rect', { x: (bx - 2).toFixed(1), y: (by - 8).toFixed(1), width: 4, height: 8, fill: '#3a2222' }));
        lights.appendChild(el('circle', { class: 'beacon', cx: bx.toFixed(1), cy: (by - 10).toFixed(1), r: 5, fill: '#ff6b6b' }));
        lights.appendChild(lamp(-60, -40, 43));
        break;
      }
      case 'TRN': {
        // rails run corner to corner across the slab, exactly where the city rail arrives
        const [lx, ly] = CORNER.left;
        const [rx, ry] = CORNER.right;
        for (const off of [-5, 5]) {
          g.appendChild(el('line', { class: 'rail-local', x1: lx + 4, y1: ly + off, x2: rx - 4, y2: ry + off }));
        }
        for (let t = 0.06; t < 0.95; t += 0.06) {
          const x = lx + (rx - lx) * t;
          const y = ly + (ry - ly) * t;
          g.appendChild(el('line', { class: 'tie', x1: x.toFixed(1), y1: (y - 8).toFixed(1), x2: x.toFixed(1), y2: (y + 8).toFixed(1) }));
        }
        g.appendChild(el('ellipse', { class: 'tunnel-mouth', cx: lx + 10, cy: ly - 6, rx: 11, ry: 14 }));
        g.appendChild(el('ellipse', { class: 'tunnel-mouth', cx: rx - 10, cy: ry - 6, rx: 11, ry: 14 }));
        g.appendChild(box(-70, -58, 130, 40, 34, '#535c66'));
        g.appendChild(box(20, -58, 40, 26, 50, '#454d55'));
        lights.appendChild(lamp(-60, -52, 36));
        break;
      }
      case 'AGR': {
        for (let i = 0; i < 3; i += 1) {
          const v = -52 + i * 34;
          g.appendChild(box(-95, v, 135, 24, 18, '#2f6a3c'));
          for (let u = -85; u <= 30; u += 30) {
            const [lx, ly] = iso(u, v + 12, 19);
            lights.appendChild(el('rect', { class: 'growlight', x: (lx - 7).toFixed(1), y: (ly - 3).toFixed(1), width: 14, height: 5, rx: 2, fill: '#ff8bd6' }));
          }
        }
        g.appendChild(cylinder(70, 22, 20, 28, '#3f6f8f'));
        lights.appendChild(lamp(-88, -50, 20));
        break;
      }
      case 'COM': {
        g.appendChild(box(-80, -15, 60, 52, 26, '#5b4a75'));
        g.appendChild(box(-10, 28, 34, 28, 16, '#4a3d5e'));
        // The mast stands on the near-right of the slab, short enough to stay
        // below the district label.
        const [mx, my] = iso(62, 42, 0);
        g.appendChild(el('rect', { x: (mx - 3).toFixed(1), y: (my - 100).toFixed(1), width: 6, height: 100, fill: '#8d7aa8' }));
        for (const dy of [84, 60, 36]) g.appendChild(el('rect', { x: (mx - 16).toFixed(1), y: (my - dy).toFixed(1), width: 32, height: 3, fill: '#7a6893' }));
        g.appendChild(el('ellipse', { cx: (mx + 13).toFixed(1), cy: (my - 90).toFixed(1), rx: 13, ry: 8, fill: '#c9b8e6', transform: `rotate(-25 ${(mx + 13).toFixed(1)} ${(my - 90).toFixed(1)})` }));
        const sweep = el('g', { class: 'sweep' }, [
          el('circle', { r: 56, fill: 'none' }),
          el('path', { d: 'M 0 0 L 56 -15 A 56 56 0 0 1 56 15 Z', fill: 'url(#gSweep)' }),
        ]);
        g.appendChild(el('g', { transform: `translate(${mx.toFixed(1)},${(my - 102).toFixed(1)})` }, [sweep]));
        lights.appendChild(el('circle', { class: 'signal', cx: mx.toFixed(1), cy: (my - 102).toFixed(1), r: 6, fill: 'none', stroke: '#d9c8ff', 'stroke-width': 2 }));
        lights.appendChild(el('circle', { cx: mx.toFixed(1), cy: (my - 102).toFixed(1), r: 3.5, fill: '#fff' }));
        lights.appendChild(lamp(-70, -10, 27));
        break;
      }
      default: break;
    }
    return g;
  }

  function buildDistrict(code) {
    const d = DISTRICTS[code];
    const g = el('g', { class: 'district', id: `d-${code}`, 'data-sector': code, 'data-state': 'stable', transform: `translate(${d.x},${d.y})` });
    g.style.setProperty('--accent', d.colour);

    g.appendChild(el('ellipse', { class: 'glow', cx: 0, cy: 10, rx: 230, ry: 115, fill: `url(#glow-${code})` }));
    g.appendChild(el('ellipse', { class: 'glow-alarm', cx: 0, cy: 10, rx: 230, ry: 115, fill: 'url(#gAlarm)' }));
    g.appendChild(box(-120, -70, 240, 140, 16, '#1e252c', 'platform'));
    g.appendChild(el('polygon', { class: 'platform-edge', points: P([iso(-120, -70, 16), iso(120, -70, 16), iso(120, 70, 16), iso(-120, 70, 16)]) }));

    const lights = el('g', { class: 'lights' });
    g.appendChild(structures(code, lights));
    g.appendChild(lights);

    g.appendChild(el('g', { class: 'badges' }));
    g.appendChild(text(`${d.glyph} ${d.name}`, 0, -124, 'd-label'));

    const marker = el('g', { class: 'marker', transform: 'translate(0,94)' });
    marker.appendChild(el('rect', { class: 'm-bg', x: -80, y: -22, width: 160, height: 44, rx: 22 }));
    marker.appendChild(el('circle', { class: 'ring-bg', cx: -50, cy: 0, r: RING_R }));
    marker.appendChild(el('circle', { class: 'ring-fg', cx: -50, cy: 0, r: RING_R, transform: 'rotate(-90 -50 0)', 'stroke-dasharray': `${RING_LEN} ${RING_LEN}` }));
    marker.appendChild(text('--', -28, 10, 'd-int', 'start'));
    marker.appendChild(text('', 40, 7, 'd-word', 'start'));
    g.appendChild(marker);
    return g;
  }

  function buildCore() {
    const g = el('g', { class: 'core', transform: `translate(${CORE.x},${CORE.y})` });
    g.appendChild(el('ellipse', { class: 'core-floor', cx: 0, cy: 34, rx: 160, ry: 80 }));
    g.appendChild(el('ellipse', { class: 'core-ring', cx: 0, cy: 34, rx: 124, ry: 60 }));
    g.appendChild(el('ellipse', { class: 'core-ring core-ring-inner', cx: 0, cy: 34, rx: 86, ry: 42 }));
    g.appendChild(el('circle', { class: 'core-heat', cx: 0, cy: 0, r: 120 }));
    g.appendChild(el('circle', { class: 'core-orb', cx: 0, cy: -6, r: 46 }));
    g.appendChild(el('circle', { class: 'core-orb-inner', cx: 0, cy: -6, r: 22 }));
    // Caption up and to the left of the orb: clear of the water main on the
    // right and of Transport's label below.
    g.appendChild(text('GEOTHERMAL CORE', -48, -112, 'core-label', 'end'));
    return g;
  }

  function buildMap() {
    const svg = $('map');
    svg.appendChild(buildDefs());
    svg.appendChild(buildBackground());
    const links = buildLinks();
    svg.appendChild(links);
    svg.appendChild(buildCore());
    for (const code of ORDER) {
      const g = buildDistrict(code);
      districtEls[code] = g;
      svg.appendChild(g);
    }
    svg.appendChild(buildVehicles(links.dataset.rail));
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
      // A round cap on a zero-length dash still paints a dot; an empty ring must be empty.
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
      renderBadges(g, badges);
    }
  }

  /** Size the marker pill to its text: ring, number, then the word if any. */
  function fitMarker(g) {
    const marker = g.querySelector('.marker');
    const num = marker.querySelector('.d-int');
    const word = marker.querySelector('.d-word');
    const numW = num.getComputedTextLength();
    const wordW = word.textContent ? word.getComputedTextLength() : 0;
    const width = 20 + RING_R * 2 + 14 + numW + (wordW ? 14 + wordW : 0) + 20;
    const left = -width / 2;
    const sig = `${numW.toFixed(0)}|${wordW.toFixed(0)}`;
    if (marker.dataset.sig === sig) return;
    marker.dataset.sig = sig;
    marker.querySelector('.m-bg').setAttribute('x', left.toFixed(1));
    marker.querySelector('.m-bg').setAttribute('width', width.toFixed(1));
    const ringX = left + 20 + RING_R;
    for (const c of marker.querySelectorAll('circle')) c.setAttribute('cx', ringX.toFixed(1));
    marker.querySelector('.ring-fg').setAttribute('transform', `rotate(-90 ${ringX.toFixed(1)} 0)`);
    num.setAttribute('x', (ringX + RING_R + 14).toFixed(1));
    word.setAttribute('x', (ringX + RING_R + 14 + numW + 14).toFixed(1));
  }

  function renderBadges(g, badges) {
    const host = g.querySelector('.badges');
    const sig = badges.map((b) => `${b.cls}|${b.text}|${b.extra}|${b.clock || ''}`).join('~');
    if (host.dataset.sig === sig) return;
    host.dataset.sig = sig;
    host.innerHTML = '';
    badges.forEach((b, i) => {
      const y = -160 - i * 38;
      const badge = el('g', { class: `badge ${b.cls}` });
      const t = text(`${b.text}${b.extra}`, 0, y + 8, 'badge-text');
      if (b.clock) { t.dataset.clock = b.clock; t.dataset.extra = b.extra; }
      const rect = el('rect', { x: -60, y: y - 17, width: 120, height: 34, rx: 8 });
      badge.appendChild(rect);
      badge.appendChild(t);
      host.appendChild(badge);
      const w = t.getComputedTextLength() + 30;
      rect.setAttribute('x', (-w / 2).toFixed(1));
      rect.setAttribute('width', w.toFixed(1));
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
