'use strict';
/**
 * CITY WALL — the projector view at the front of the room.
 *
 * Read from 8–10 metres. Everything on this screen comes straight from the
 * wall frame (lib/visibility.js → forBigscreen); nothing is inferred and
 * nothing the server withholds is reconstructed here.
 *
 * Rendering split:
 *   render()  — full DOM rebuild on every state frame (at most every ~10 s,
 *               or on change).
 *   tick()    — every 250 ms, updates ONLY countdown texts and the
 *               time-driven alert full→reduced switch. Never touches layout.
 */
(function wall() {
  const U = window.Undercity;
  const $ = (id) => document.getElementById(id);
  const esc = U.escapeHtml;

  const ORDER = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
  const ALERT_FULL_S = 8;        // mirrors alert_full_screen_s default
  const TICK_MS = 250;

  let frame = null;      // latest state frame
  let frameAt = 0;       // performance.now() when it arrived
  let alertRenderedId = null;
  let debriefRendered = false;

  const CTX = U.context();

  U.connect({
    hello: { type: 'hello', role: 'bigscreen', session: CTX.session, token: null },
    onState: (next) => { frame = next; frameAt = performance.now(); render(); },
    onMessage: (msg) => { if (msg.type === 'sting') U.playSting(msg.sound); },
    onStatus: setConn,
  });

  // -- connection dot -----------------------------------------------------------

  function setConn(status) {
    const el = $('conn');
    el.dataset.status = status;
    $('conn-text').textContent =
      status === 'down' ? 'RECONNECTING' : status === 'stale' ? 'DELAYED' : 'LIVE';
  }

  // -- sound hint ------------------------------------------------------------------

  (function soundHint() {
    const hide = () => { const h = $('sound-hint'); if (h) h.hidden = true; };
    window.addEventListener('pointerdown', hide, { once: true });
    window.addEventListener('keydown', hide, { once: true });
  })();

  // -- helpers ---------------------------------------------------------------------

  /** Status word: never colour alone. The server computes it from the
   *  scenario thresholds; the fallback below only covers an older frame. */
  function statusWord(s) {
    if (s.status_word) return s.status_word;
    if (s.status === 'DARK') return 'DARK';
    if (s.status === 'BROWNOUT') return 'BROWNOUT';
    if (s.status === 'CRITICAL') return 'CRITICAL';
    if (s.integrity >= 60) return 'STABLE';
    if (s.integrity >= 30) return 'DEGRADED';
    return 'CRITICAL';
  }

  function stateClass(word) {
    return word.toLowerCase();
  }

  function hhmmss(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtDebrief(value, unit) {
    if (value === null || value === undefined) return '—';
    if (unit === 's') return U.mmss(value);
    if (unit === '%') return `${value}%`;
    return String(value);
  }

  const inCouncil = () => !!(frame && (frame.council?.active || frame.mode === 'COUNCIL'));

  /** Alert age right now, extrapolated from the last frame. */
  function alertAge() {
    if (!frame || !frame.alert) return 0;
    return (Number(frame.alert.age_s) || 0) + (performance.now() - frameAt) / 1000;
  }
  function alertIsFull() {
    if (!frame || !frame.alert) return false;
    const fullS = Number(frame.alert.full_s) || ALERT_FULL_S;
    return !!(frame.alert.full_screen && alertAge() < fullS);
  }

  // -- full render -----------------------------------------------------------------

  function render() {
    if (!frame) return;
    renderHeader();
    renderStrips();
    renderCards();
    renderCouncil();
    renderDebrief();
    renderFeed();
    renderTelemetry();
    renderAlert();
    renderPaused();
    tick();
  }

  function renderHeader() {
    $('phase-name').textContent = (frame.phase_name || frame.phase || '').toUpperCase();
    $('stability').textContent = Number.isFinite(frame.city_stability) ? frame.city_stability : '--';
    $('core-output').textContent = Number.isFinite(frame.core_output) ? frame.core_output : '--';
    $('cycle-no').textContent = frame.cycle && frame.cycle.number != null ? `· CYCLE ${frame.cycle.number}` : '';

    $('fig-stability').className = `fig ${U.integrityClass(frame.city_stability)}`;
    $('fig-core').className = `fig ${U.integrityClass(frame.core_output)}`;
  }

  function renderStrips() {
    const b = frame.blackout || {};
    const bo = $('strip-blackout');
    bo.hidden = !b.active;
    if (b.active) {
      const list = (b.current || []).join(' · ');
      $('strip-blackout-text').textContent =
        `ROLLING BLACKOUT IN PROGRESS${list ? ` — ${list}` : ''}`;
    }
    $('strip-breather').hidden = !frame.breather;
    syncStrips();
  }

  /** The strip row costs height; the page gives it back only while one shows. */
  function syncStrips() {
    const any = [...document.querySelectorAll('#strips .strip')].some((el) => !el.hidden);
    $('strips').hidden = !any;
    $('wall').classList.toggle('has-strip', any);
  }

  function renderCards() {
    const grid = $('grid');
    grid.innerHTML = ORDER.map((code) => {
      const s = frame.sectors && frame.sectors[code];
      if (!s) return `<article class="card empty"><div class="card-name">${code}</div></article>`;
      return cardHtml(code, s);
    }).join('');
    grid.classList.toggle('dimmed', inCouncil());
    grid.hidden = !!frame.debrief;
  }

  function cardHtml(code, s) {
    const word = statusWord(s);
    const cls = stateClass(word);
    const glyph = U.SECTOR_GLYPH[code] || '';
    const integrity = Math.max(0, Math.min(100, Number(s.integrity) || 0));
    const barCls = s.status === 'DARK' ? 'dark' : U.integrityClass(integrity);
    const wf = s.workforce || {};

    // Inventory: only when the server included it.
    let inv = '';
    if (s.inventory && typeof s.inventory === 'object') {
      inv = `<span class="res">${['power', 'water', 'parts', 'med']
        .filter((k) => k in s.inventory)
        .map((k) => `<span class="res-item"><span class="g">${U.GLYPH[k]}</span>${esc(s.inventory[k])}</span>`)
        .join('')}</span>`;
    }

    // Top fault: only when the server included the key.
    let fault = '';
    if ('top_fault' in s) {
      const tf = s.top_fault;
      if (tf) {
        let clock;
        if (tf.expired) clock = '<span class="fclock expired">DEADLINE PASSED</span>';
        else if (tf.deadline_remaining_s === null || tf.deadline_remaining_s === undefined) clock = '<span class="fclock none">NO DEADLINE</span>';
        else clock = `<span class="fclock" data-sector="${code}">${U.mmss(tf.deadline_remaining_s)}</span>`;
        const more = s.unresolved_faults > 1 ? `<span class="fmore">+${s.unresolved_faults - 1} MORE</span>` : '';
        fault = `<div class="fault sev-${Number(tf.severity) || 1}">
            <div class="fline"><span class="fcode">${esc(tf.code)}</span>${clock}</div>
            <div class="fname">${esc(String(tf.name || '').toUpperCase())}</div>
            <div class="fsev"><span>${U.severityPips(tf.severity)} ${U.severityName(tf.severity)}</span>${more}</div>
          </div>`;
      } else {
        fault = '<div class="fault quiet"><div class="fname">NO ACTIVE FAULTS</div></div>';
      }
    } else if (s.unresolved_faults > 0) {
      fault = `<div class="fault hidden-detail"><div class="fname">${s.unresolved_faults} UNRESOLVED FAULT${s.unresolved_faults > 1 ? 'S' : ''}</div><div class="fsev"><span>DETAIL UNAVAILABLE</span></div></div>`;
    } else {
      fault = '<div class="fault quiet"><div class="fname">NO ACTIVE FAULTS</div></div>';
    }

    // The status band is the banner: the word is always printed, never colour alone.
    const bandText = word === 'BROWNOUT' ? 'BROWNOUT — REDUCED' : word;
    const stencil = word === 'DARK' ? '<div class="stencil">SECTOR DARK</div>' : '';

    return `<article class="card ${cls}" data-sector="${code}" style="--accent:${esc(s.colour || '#7d8b97')}">
        <header class="card-head">
          <span class="card-glyph">${glyph}</span>
          <span class="card-name">${esc(String(s.name || code).toUpperCase())}</span>
          <span class="card-code">${code}</span>
        </header>
        <div class="integ">
          <span class="integ-label">INTEGRITY</span>
          <span class="integ-val">${integrity}<small>%</small></span>
        </div>
        <div class="bar ${barCls}"><i style="width:${integrity}%"></i></div>
        <div class="meta">
          ${inv}
          <span class="wf"><span class="g">${U.GLYPH.workers}</span>${esc(wf.available ?? '–')} <span class="wf-of">/ ${esc(wf.total ?? '–')}</span>${
            wf.injured ? `<span class="wf-inj">⚕ ${esc(wf.injured)} INJ</span>` : ''}</span>
        </div>
        ${fault}
        <footer class="status-band"><span class="status-light"></span>${bandText}</footer>
        ${stencil}
      </article>`;
  }

  function renderCouncil() {
    const on = inCouncil();
    const el = $('council');
    el.hidden = !on || !!frame.debrief;
    if (!on) return;
    $('council-note').hidden = !(frame.council && frame.council.no_order);
    const order = frame.continuity_order;
    const orderEl = $('council-order');
    if (order && Array.isArray(order.order)) {
      orderEl.hidden = false;
      orderEl.innerHTML = `<span class="ok-tag">CONTINUITY ORDER ACCEPTED</span> ${order.order.map(esc).join(' › ')}${
        order.brownout && order.brownout.length ? `<span class="bo-tag">BROWNOUT: ${order.brownout.map(esc).join(' ')}</span>` : ''}`;
    } else {
      orderEl.hidden = true;
    }
  }

  function renderDebrief() {
    const d = frame.debrief;
    const el = $('debrief');
    el.hidden = !d;
    if (!d) { debriefRendered = false; return; }
    const rows = Array.isArray(d.rows) ? d.rows : [];
    $('debrief-rows').innerHTML = rows.map((r) => `<tr>
        <td class="metric">${esc(r.label)}</td>
        <td class="num">${esc(fmtDebrief(d.R3 ? d.R3[r.key] : null, r.unit))}</td>
        <td class="num">${esc(fmtDebrief(d.R4 ? d.R4[r.key] : null, r.unit))}</td>
      </tr>`).join('');
    debriefRendered = true;
  }

  function renderFeed() {
    const feed = Array.isArray(frame.feed) ? frame.feed.slice(0, 6) : [];
    const el = $('feed');
    if (!feed.length) {
      el.innerHTML = '<li class="row quiet"><span class="tm">--:--:--</span><span class="tx">HAVEN-9 NOMINAL — NO EVENTS</span></li>';
    } else {
      el.innerHTML = feed.map((e) => `<li class="row k-${esc(e.kind)}">
          <span class="tm">${hhmmss(e.t)}</span>
          <span class="tx">${esc(e.text)}</span>
        </li>`).join('');
    }

    // Continuity order, shown compactly once it exists.
    const order = frame.continuity_order;
    const line = $('order-line');
    if (order && Array.isArray(order.order)) {
      line.hidden = false;
      line.innerHTML = `CONTINUITY ORDER: ${order.order.map(esc).join(' › ')}${
        order.brownout && order.brownout.length ? ` · BROWNOUT ${order.brownout.map(esc).join(' ')}` : ''}`;
    } else {
      line.hidden = true;
    }
  }

  function renderTelemetry() {
    const el = $('tel-rows');
    const tel = $('telemetry');
    if (frame.telemetry_degraded) {
      tel.classList.add('offline');
      el.innerHTML = '<div class="tel-offline">SENSORS OFFLINE</div>';
      return;
    }
    tel.classList.remove('offline');
    const t = frame.telemetry || {};
    const rows = [];
    if ('wtr_reservoir_pressure' in t) rows.push(['WTR RESERVOIR', t.wtr_reservoir_pressure, '']);
    if ('core_output_pct' in t) rows.push(['CORE OUTPUT', t.core_output_pct, '%']);
    el.innerHTML = rows.length
      ? rows.map(([k, v, u]) => `<div class="tel-row"><span class="k">${k}</span><span class="v">${esc(v)}${u}</span></div>`).join('')
      : '<div class="tel-row quiet"><span class="k">NO SENSOR DATA</span></div>';
  }

  function renderAlert() {
    const a = frame.alert;
    const full = $('alert-full');
    const strip = $('strip-alert');
    if (!a) {
      full.hidden = true;
      strip.hidden = true;
      alertRenderedId = null;
      syncStrips();
      return;
    }
    if (a.id !== alertRenderedId) {
      $('alert-title').textContent = a.title || '';
      $('alert-sub').textContent = a.subtitle || '';
      $('alert-big').textContent = a.big || '';
      $('alert-big').hidden = !a.big;
      $('strip-alert-title').textContent = a.title || '';
      $('strip-alert-sub').textContent = a.subtitle || '';
      $('strip-alert-big').textContent = a.big || '';
      $('strip-alert-big').hidden = !a.big;
      alertRenderedId = a.id;
    }
    applyAlertMode();
  }

  /** Full → reduced switch; cheap enough to run on the tick. */
  function applyAlertMode() {
    if (!frame || !frame.alert) return;
    const full = alertIsFull();
    $('alert-full').hidden = !full;
    if ($('strip-alert').hidden !== full) {
      $('strip-alert').hidden = full;
      syncStrips();
    }
  }

  function renderPaused() {
    $('paused').hidden = !frame.paused;
    document.body.classList.toggle('is-paused', !!frame.paused);
  }

  // -- 250 ms tick: countdown texts only -------------------------------------------

  function tick() {
    if (!frame) return;
    const frozen = !!frame.frozen;

    // Core cycle — the room's heartbeat.
    const cyc = U.countdown(frame.cycle, frozen);
    const cycEl = $('cycle-clock');
    cycEl.textContent = U.mmss(cyc);
    const fig = $('fig-cycle');
    fig.classList.toggle('urgent', cyc < 120 && cyc >= 30);
    fig.classList.toggle('pulse', cyc < 30);
    fig.classList.toggle('held', !frame.cycle || !frame.cycle.running);

    // Round clock.
    const rc = $('round-clock');
    rc.textContent = U.mmss(U.countdown(frame.round_clock, frozen));
    rc.classList.toggle('held', !frame.round_clock || !frame.round_clock.running);

    // Council clock.
    if (inCouncil()) {
      const cc = U.countdown(frame.council_clock, frozen);
      const el = $('council-clock');
      el.textContent = U.mmss(cc);
      el.classList.toggle('pulse', cc < 30);
    }

    // Per-card fault deadlines.
    for (const el of document.querySelectorAll('.fclock[data-sector]')) {
      const s = frame.sectors && frame.sectors[el.dataset.sector];
      const tf = s && s.top_fault;
      if (!tf || tf.expired || tf.deadline_remaining_s == null) continue;
      const left = U.countdown({ running: !frozen, remaining_s: tf.deadline_remaining_s }, frozen);
      el.textContent = U.mmss(left);
      el.classList.toggle('low', left < 60);
    }

    applyAlertMode();
  }

  setInterval(tick, TICK_MS);
})();
