'use strict';
/**
 * Big screen — spec §6.2. Projected, read at 10 metres.
 *
 * The ticker is the public-credit / public-shame instrument: it names sectors,
 * never individuals. This view receives no fault detail and no inventory —
 * the server never sends it (see lib/visibility.js).
 */
(function bigscreen() {
  const U = window.Undercity;
  const $ = (id) => document.getElementById(id);
  const DIAL_CIRCUMFERENCE = 2 * Math.PI * 50;

  let state = null;

  const CTX = U.context();

  U.connect({
    hello: { type: 'hello', role: 'bigscreen', session: CTX.session, token: null },
    onState: render,
    onMessage: (msg) => { if (msg.type === 'sting') U.playSting(msg.sound); },
  });

  // Ladder rungs down the central access shaft — drawn once.
  (function drawRungs() {
    const g = $('rungs');
    for (let y = 118; y < 505; y += 17) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', 489); line.setAttribute('x2', 511);
      line.setAttribute('y1', y);   line.setAttribute('y2', y);
      g.appendChild(line);
    }
  })();

  function render(next) {
    state = next;
    renderTop();
    renderZones();
    renderRail();
    renderTelemetry();
    renderTicker();
    renderCouncil();
  }

  function renderTop() {
    const core = state.core_integrity;
    $('core-value').textContent = core;

    const arc = $('dial-arc');
    arc.style.strokeDasharray = DIAL_CIRCUMFERENCE;
    arc.style.strokeDashoffset = DIAL_CIRCUMFERENCE * (1 - core / 100);
    arc.className.baseVal = `dial-arc ${core < 30 ? 'critical' : core < 60 ? 'warn' : ''}`;

    const body = $('core-body');
    body.setAttribute('class', `core-body ${core < 30 ? 'critical' : core < 60 ? 'warn' : ''}`);

    $('round').textContent = `CYCLE ${state.period_number}`;
    const clock = $('clock');
    clock.textContent = U.mmss(state.round_clock.remaining_s);
    clock.classList.toggle('low', state.round_clock.remaining_s <= 60 && state.round_clock.running);
    $('mode').textContent = state.mode;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function text(cls, x, y, content) {
    const el = document.createElementNS(SVG_NS, 'text');
    el.setAttribute('class', cls);
    el.setAttribute('x', x);
    el.setAttribute('y', y);
    el.textContent = content;
    return el;
  }

  function renderZones() {
    for (const zone of document.querySelectorAll('.zone')) {
      const code = zone.dataset.sector;
      const s = state.sectors[code];
      if (!s) continue;

      const cx = Number(zone.dataset.x);
      const cy = Number(zone.dataset.y);

      // Status drives the zone's whole look; BROWNOUT is its own state, not a
      // shade of CRITICAL, so a triage victim reads differently from a failure.
      const cls =
        s.status === 'DARK' ? 'dark'
        : s.status === 'BROWNOUT' ? 'brownout'
        : U.integrityClass(s.integrity);
      zone.setAttribute('class', `zone ${cls}`);

      for (const old of zone.querySelectorAll('text')) old.remove();

      if (s.status === 'DARK') {
        zone.appendChild(text('z-code', cx, cy - 22, code));
        zone.appendChild(text('z-stencil', cx, cy + 10, 'SECTOR DARK'));
        continue;
      }

      zone.appendChild(text('z-code', cx, cy - 28, code));
      zone.appendChild(text('z-name', cx, cy - 8, s.name.toUpperCase()));
      zone.appendChild(text('z-value', cx, cy + 24, Math.round(s.integrity)));
      if (s.unresolved_faults > 0) {
        zone.appendChild(text(
          'z-faults', cx, cy + 42,
          `${s.unresolved_faults} UNRESOLVED`
        ));
      }
    }
  }

  function renderRail() {
    $('rail').innerHTML = Object.values(state.sectors).map((s) => {
      const value = Math.round(s.integrity);
      const cls = s.status === 'DARK' ? 'dark' : U.integrityClass(value);
      return `<div class="rail-row">
          <div class="rail-head">
            <span class="rail-code" style="color:${s.colour}">${s.code}</span>
            <span class="rail-wf">&#128100;${s.workforce.active}${
              s.workforce.injured ? ` &#9855;${s.workforce.injured}` : ''}</span>
            <span class="rail-val">${value}</span>
          </div>
          <div class="bar ${cls}"><i style="width:${Math.max(0, value)}%"></i></div>
          <div class="rail-status ${s.status}">${s.status}${
            s.unresolved_faults ? ` · ${s.unresolved_faults} FAULT${s.unresolved_faults > 1 ? 'S' : ''}` : ''
          }</div>
        </div>`;
    }).join('');
  }

  /**
   * WTR reservoir pressure reads 290 here. The WTR binder prints 340. Both
   * resolve F-201, and the two numbers are never reconciled — that mismatch
   * is the psychological safety probe (contract §7).
   */
  function renderTelemetry() {
    const labels = {
      wtr_reservoir_pressure: 'WTR RESERVOIR',
      core_output_pct: 'CORE OUTPUT',
    };
    const units = { core_output_pct: '%' };
    $('telemetry').innerHTML = Object.entries(state.telemetry).map(([k, v]) =>
      `<div class="tel-row"><span class="k">${labels[k] || k.toUpperCase()}</span>
        <span class="v">${v}${units[k] || ''}</span></div>`).join('');
  }

  function renderTicker() {
    const items = state.ticker.slice(0, 14);
    if (!items.length) {
      $('ticker').innerHTML = '<span class="tick">HAVEN-9 NOMINAL</span>';
      $('ticker').style.animation = 'none';
      return;
    }
    const run = items.map((e) =>
      `<span class="tick ${U.escapeHtml(e.kind)}">
         <span class="tm">${new Date(e.t).toLocaleTimeString([], { hour12: false })}</span>
         ${U.escapeHtml(e.text)}</span>`).join('');

    // The run is duplicated so the marquee wraps without a visible seam.
    $('ticker').innerHTML = run + run;
    $('ticker').style.animation = `marquee ${Math.max(24, items.length * 4.5)}s linear infinite`;
  }

  function renderCouncil() {
    const on = state.mode === 'COUNCIL';
    $('council').classList.toggle('hidden', !on);
    if (!on) return;

    const remaining = state.council_clock.remaining_s;
    const clock = $('c-clock');
    clock.textContent = U.mmss(remaining);
    clock.classList.toggle('low', remaining <= 60);

    // R3's council is the triage vote; R2's is information pooling.
    $('c-agenda').textContent =
      state.round === 'R3' ? 'CONTINUITY ORDER DUE' : 'COUNCIL IN SESSION';
  }
})();
