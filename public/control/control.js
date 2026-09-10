'use strict';
/**
 * Facilitator console — the game master (spec §24–§31, §46).
 *
 * FACILITATOR EYES ON THE ROOM: the seven quick actions are always visible,
 * every common event is one or two clicks, nothing is nested, and only the
 * destructive controls confirm (RESET, DARK, Continuity Order, Blackout).
 *
 * The observation pad writes straight into runlog.jsonl beside the game
 * events — it is still the highest-value surface here.
 */
(function control() {
  const U = window.Undercity;
  const CTX = U.context();
  const params = new URLSearchParams(location.search);
  const TOKEN = params.get('token') || '';
  const $ = (id) => document.getElementById(id);
  const esc = U.escapeHtml;

  const TAGS = ['DOMINANCE', 'WITHDRAWAL', 'SAFETY+', 'SAFETY-', 'DISCREPANCY-SPOTTED'];
  const RESOURCES = ['power', 'water', 'parts', 'med'];
  const ANNOUNCE_PRESETS = [
    'Core output dropping. Council convenes in 10 minutes.',
    'Upkeep suspended this cycle.',
    'Core output dropping to 60 percent.',
    'Continuity Order due in 5 minutes.',
    'Transport capacity reduced — expect transfer delays.',
    'All sectors: report status to Council.',
  ];
  const ALERT_PRESETS = [
    { title: '⚠ CORE INSTABILITY DETECTED', subtitle: 'CORE OUTPUT FALLING' },
    { title: 'CORE OUTPUT', subtitle: '', big: '60%' },
    { title: 'COUNCIL SUMMONED', subtitle: 'CHIEFS + LIAISONS REPORT IMMEDIATELY' },
    { title: 'CONTINUITY ORDER REQUIRED', subtitle: '', big: '05:00' },
    { title: 'ROLLING BLACKOUT INITIATED', subtitle: 'ALL SECTORS AT RISK' },
    { title: 'BIOLOGICAL BREACH DETECTED', subtitle: 'TUNNEL 7' },
  ];

  // -- token gate ---------------------------------------------------------------

  if (!TOKEN) {
    $('token-gate').classList.remove('hidden');
    $('token-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const t = $('token-input').value.trim();
      if (!t) return;
      params.set('token', t);
      location.search = params.toString();
    });
    return;
  }

  let state = null;
  let content = null;
  let urls = null;
  let obsSector = null;
  let obsTag = null;
  let orderDraft = [];
  let activeTab = 'faults';
  let lastConfigJson = null;
  let debriefData = null;
  const openCards = new Set();

  // -- transport ----------------------------------------------------------------

  const qs = () => `session=${encodeURIComponent(CTX.session)}&token=${encodeURIComponent(TOKEN)}`;

  fetch(`/api/content?${qs()}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('forbidden'))))
    .then((data) => {
      content = data;
      urls = data.urls;
      buildStatics();
      renderInjects();
      if (state) render(state);
    })
    .catch(() => {
      $('injects').innerHTML = '<div class="hint">Content unavailable — check the token in the URL.</div>';
    });

  const socket = U.connect({
    hello: { type: 'hello', role: 'control', session: CTX.session, token: TOKEN },
    onState: render,
    onStatus: (status) => {
      $('conn').dataset.status = status;
      $('conn-text').textContent = status === 'live' ? 'LIVE' : status === 'stale' ? 'DELAYED' : 'RECONNECTING';
    },
    onMessage: (msg) => {
      if (msg.type === 'error' && msg.reason === 'bad_token') {
        $('token-gate').classList.remove('hidden');
        $('token-error').classList.remove('hidden');
        $('token-form').addEventListener('submit', (e) => {
          e.preventDefault();
          params.set('token', $('token-input').value.trim());
          location.search = params.toString();
        });
      }
      if (msg.type === 'observe_ack') { $('obs-note').value = ''; obsTag = null; renderObsTags(); }
      if (msg.type === 'export_ready') window.open(msg.url, '_blank');
      if (msg.type === 'welcome' && msg.urls) urls = msg.urls;
      if (msg.type === 'cycle_summary') showTab('core');
      if (msg.type === 'order_result' && !msg.ok) alert(`Order refused: ${msg.reason}`);
      if (msg.type === 'transfer_result' && msg.ok === false) toast(`Transfer: ${msg.reason}`);
      if (msg.type === 'fire_result' && msg.ok === false) toast(`Not fired: ${msg.reason}`);
      if (msg.type === 'event_result' && msg.ok === false) toast(`Event: ${msg.reason}`);
      if (msg.type === 'override_result' && msg.ok === false) toast(`Override: ${msg.reason}`);
    },
  });
  const send = (payload) => socket.send(payload);

  function toast(text) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;bottom:200px;left:50%;transform:translateX(-50%);background:#3a1616;border:1px solid #E85A5A;color:#ffd6d6;padding:8px 14px;font-size:12px;z-index:90';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  // -- statics ------------------------------------------------------------------

  function sectorCodes() { return content ? Object.keys(content.sectors.sectors) : Object.keys(state ? state.sectors : {}); }

  function buildStatics() {
    const codes = sectorCodes();
    for (const r of content.faults.meta.rounds) $('f-round').insertAdjacentHTML('beforeend', `<option value="${r}">${r}</option>`);
    for (const s of codes) {
      $('f-sector').insertAdjacentHTML('beforeend', `<option value="${s}">${s}</option>`);
      $('announce-target').insertAdjacentHTML('beforeend', `<option value="${s}">${s} ONLY</option>`);
      $('tr-from').insertAdjacentHTML('beforeend', `<option value="${s}">${s}</option>`);
      $('tr-to').insertAdjacentHTML('beforeend', `<option value="${s}">${s}</option>`);
    }
    $('tr-to').selectedIndex = 1;
    for (const id of ['f-round', 'f-sector', 'f-sev']) $(id).addEventListener('change', renderInjects);
    $('f-text').addEventListener('input', renderInjects);

    $('obs-sectors').innerHTML = codes.map((s) => `<button data-sector="${s}">${s}</button>`).join('');
    for (const btn of $('obs-sectors').querySelectorAll('button')) {
      btn.addEventListener('click', () => { obsSector = obsSector === btn.dataset.sector ? null : btn.dataset.sector; renderObsSectors(); });
    }
    $('presets').innerHTML = ANNOUNCE_PRESETS.map((p, i) => `<button data-preset="${i}">${esc(p)}</button>`).join('');
    for (const btn of $('presets').querySelectorAll('button')) {
      btn.addEventListener('click', () => send({ type: 'announce', text: ANNOUNCE_PRESETS[Number(btn.dataset.preset)], sector: $('announce-target').value || null }));
    }
    $('alert-presets').innerHTML = ALERT_PRESETS.map((p, i) => `<button data-alert="${i}">${esc(p.title)}${p.big ? ' ' + esc(p.big) : ''}</button>`).join('');
    for (const btn of $('alert-presets').querySelectorAll('button')) {
      btn.addEventListener('click', () => send({ type: 'alert', ...ALERT_PRESETS[Number(btn.dataset.alert)] }));
    }
    for (const s of content.scenarios || []) {
      $('scenario-select').insertAdjacentHTML('beforeend', `<option value="${esc(s.id)}">${esc(s.name)}${s.builtin ? '' : ' (saved)'}</option>`);
    }
    for (const f of content.faults.faults) {
      $('fo-fault').insertAdjacentHTML('beforeend', `<option value="${f.code}">${f.code} · ${f.sector} · ${esc(f.name)}</option>`);
    }
  }

  // -- top bar --------------------------------------------------------------------

  $('btn-start').addEventListener('click', () => send({ type: 'clock', which: 'round', action: state && state.round_clock.remaining_s > 0 && !state.round_clock.running && state.phase !== 'SETUP' ? 'resume' : 'start' }));
  $('btn-pause').addEventListener('click', togglePause);
  $('quick-pause').addEventListener('click', togglePause);
  function togglePause() { send({ type: state && state.paused ? 'resume' : 'pause' }); }
  $('btn-end-phase').addEventListener('click', () => {
    if (!confirm('END PHASE — stop the round clock and the core cycle?')) return;
    send({ type: 'clock', which: 'round', action: 'end' });
  });
  $('btn-next-phase').addEventListener('click', () => send({ type: 'next_phase' }));
  $('phase-select').addEventListener('change', (e) => { if (e.target.value) send({ type: 'set_phase', phase: e.target.value }); });
  $('btn-sound').addEventListener('click', () => send({ type: 'set_sound', on: !(state && state.sound_enabled) }));
  $('btn-snapshot').addEventListener('click', () => send({ type: 'snapshot' }));
  $('btn-export').addEventListener('click', () => send({ type: 'export_log' }));
  $('btn-export-2').addEventListener('click', () => send({ type: 'export_log' }));
  $('btn-reset').addEventListener('click', () => {
    if (!confirm('RESET RUN — wipe all live state and start a new run? The current log is kept under a dated name.')) return;
    const runId = prompt('New run id:', `${new Date().toISOString().slice(0, 10)}-c2`);
    if (!runId) return;
    if (!confirm(`Confirm reset to "${runId}". This cannot be undone.`)) return;
    send({ type: 'reset_run', run_id: runId, confirm: true });
  });
  $('btn-urls').addEventListener('click', () => {
    if (!urls) return;
    const hosts = (urls.hosts || []).length ? urls.hosts : [location.origin];
    $('urls-body').innerHTML = `
      <div class="url-hosts">Laptops join over the same Wi-Fi/LAN. Server address${hosts.length > 1 ? 'es' : ''}: <b>${hosts.map(esc).join(' · ')}</b></div>
      <div class="url-list">
        <b>WALL (projector)</b><code>${esc(hosts[0] + urls.wall)}</code>
        ${Object.entries(urls.sectors).map(([c, u]) => `<b>${c}</b><code>${esc(hosts[0] + u)}</code>`).join('')}
        <b>ADMIN</b><code>${esc(hosts[0] + urls.admin)}?token=…</code>
      </div>`;
    $('urls').classList.remove('hidden');
  });
  $('urls-close').addEventListener('click', () => $('urls').classList.add('hidden'));

  // -- quick actions + picker -------------------------------------------------------

  for (const btn of $('quick').querySelectorAll('button[data-quick]')) {
    btn.addEventListener('click', () => quick(btn.dataset.quick));
  }
  $('picker-close').addEventListener('click', closePicker);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePicker(); $('urls').classList.add('hidden'); } });

  function closePicker() { $('picker').classList.add('hidden'); }
  function openPicker(title, html) {
    $('picker-title').textContent = title;
    $('picker-body').innerHTML = html;
    $('picker').classList.remove('hidden');
    return $('picker-body');
  }

  function quick(action) {
    switch (action) {
      case 'fault': return pickFault();
      case 'core': return send({ type: 'adjust_core', delta: -10 });
      case 'injure': return pickSector('INJURE WORKER — which sector?', (s) => send({ type: 'injure_worker', sector: s, count: 1 }),
        (s) => `👤 ${state.sectors[s].workforce.active} active`);
      case 'council': return send({ type: 'call_council' });
      case 'brownout': return pickSector('BROWNOUT — toggle a sector', (s) => {
        const st = state.sectors[s];
        send({ type: 'set_status', sector: s, value: st.status === 'BROWNOUT' ? 'ACTIVE' : 'BROWNOUT' });
      }, (s) => (state.sectors[s].status === 'BROWNOUT' ? 'RESTORE' : state.sectors[s].status));
      case 'announce': {
        const body = openPicker('ANNOUNCEMENT', `
          <div class="pick-presets">${ANNOUNCE_PRESETS.map((p, i) => `<button data-i="${i}">${esc(p)}</button>`).join('')}</div>
          <div class="row"><input type="text" id="pk-announce" placeholder="custom announcement…" autocomplete="off"><button id="pk-send" class="primary">SEND CITY-WIDE</button></div>`);
        for (const b of body.querySelectorAll('[data-i]')) b.addEventListener('click', () => { send({ type: 'announce', text: ANNOUNCE_PRESETS[Number(b.dataset.i)] }); closePicker(); });
        const go = () => { const t = body.querySelector('#pk-announce').value.trim(); if (t) { send({ type: 'announce', text: t }); closePicker(); } };
        body.querySelector('#pk-send').addEventListener('click', go);
        body.querySelector('#pk-announce').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        body.querySelector('#pk-announce').focus();
        return;
      }
      case 'alert': {
        const body = openPicker('EMERGENCY OVERLAY', `
          <div class="pick-presets">${ALERT_PRESETS.map((p, i) => `<button data-i="${i}">${esc(p.title)}${p.big ? ' ' + esc(p.big) : ''}</button>`).join('')}</div>
          <div class="row"><button id="pk-dismiss">DISMISS CURRENT</button></div>`);
        for (const b of body.querySelectorAll('[data-i]')) b.addEventListener('click', () => { send({ type: 'alert', ...ALERT_PRESETS[Number(b.dataset.i)] }); closePicker(); });
        body.querySelector('#pk-dismiss').addEventListener('click', () => { send({ type: 'dismiss_alert' }); closePicker(); });
        return;
      }
      case 'pause': return togglePause();
      default: return null;
    }
  }

  function pickSector(title, onPick, subtitle) {
    const codes = sectorCodes();
    const body = openPicker(title, `<div class="pick-big">${codes.map((s) =>
      `<button data-s="${s}" style="border-color:${state.sectors[s].colour}">${U.SECTOR_GLYPH[s] || ''} ${s}<span class="sub">${esc(subtitle ? subtitle(s) : '')}</span></button>`).join('')}</div>`);
    for (const b of body.querySelectorAll('[data-s]')) b.addEventListener('click', () => { onPick(b.dataset.s); closePicker(); });
  }

  function pickFault(only = null) {
    if (!content) return;
    const codes = only ? [only] : sectorCodes();
    const active = activeFaultCodes();
    const presets = (state && state.scenario ? state.scenario.fault_presets : []) || [];
    const body = openPicker(only ? `TRIGGER FAULT — ${only}` : 'TRIGGER FAULT — one click fires it', `
      ${presets.length && !only ? `<div class="pick-presets">${presets.map((p) => `<button data-preset="${esc(p.id)}">▶ ${esc(p.name)}</button>`).join('')}</div>` : ''}
      <div class="pick-sectors">${codes.map((s) => `
        <div class="pick-sector"><h3 style="color:${state.sectors[s].colour}">${U.SECTOR_GLYPH[s] || ''} ${s}</h3>
          ${content.faults.faults.filter((f) => f.sector === s).map((f) => `
            <button class="pf${active.has(f.code) ? ' live' : ''}" data-fire="${f.code}" data-sector="${s}" title="${esc(f.name)}">
              <b>${f.code}</b><span class="nm">${esc(f.name)}</span><span class="rd">${f.round}</span><span class="sv">${U.severityPips(f.severity)}</span>
            </button>`).join('')}
        </div>`).join('')}
      </div>`);
    for (const b of body.querySelectorAll('[data-fire]')) {
      b.addEventListener('click', () => { send({ type: 'fire_fault', fault_code: b.dataset.fire, sector: b.dataset.sector }); closePicker(); });
    }
    for (const b of body.querySelectorAll('[data-preset]')) {
      b.addEventListener('click', () => { send({ type: 'fire_preset', preset_id: b.dataset.preset }); closePicker(); });
    }
  }

  function activeFaultCodes() {
    const out = new Set();
    if (!state) return out;
    for (const s of Object.values(state.sectors)) for (const f of s.faults) if (!f.resolved) out.add(f.code);
    return out;
  }

  // -- sector grid -----------------------------------------------------------------

  function renderSectors() {
    const host = $('sectors');
    host.innerHTML = '';
    for (const [code, s] of Object.entries(state.sectors)) {
      const el = document.createElement('div');
      el.className = `sec ${s.status}${openCards.has(code) ? ' open' : ''}`;
      el.dataset.sector = code;
      const live = s.faults.filter((f) => !f.resolved);

      const faults = live.map((f) => {
        const keys = f.valid_codes.length ? `<span class="keys" title="answer key">${f.valid_codes.join(' / ')}</span>`
          : '<span class="keys none">NO CODE — clear by hand</span>';
        const cd = f.deadline_remaining_s === null ? '<span class="cd">—</span>'
          : `<span class="cd${f.expired ? ' expired' : ''}" data-cd-fault="${code}:${f.code}">${f.expired ? 'EXPIRED' : U.mmss(f.deadline_remaining_s)}</span>`;
        return `<div class="sec-fault">
            <span class="c">${f.code}</span>${cd}${keys}
            <button data-time="${f.code}" data-sec="${code}" title="+1:00 on the deadline">+1m</button>
            <button data-acc="${f.code}" data-sec="${code}" title="double decay">FAST</button>
            <button data-clear="${f.code}" data-sec="${code}">CLEAR</button>
          </div>`;
      }).join('');

      el.innerHTML = `
        <div class="sec-head">
          <span class="sec-code" style="color:${s.colour}">${U.SECTOR_GLYPH[code] || ''} ${code}</span>
          <span class="sec-name">${esc(s.name.toUpperCase())}</span>
          <span class="sec-status ${s.status}">${s.status_word || s.status}</span>
        </div>
        <div class="sec-int"><b>${Math.round(s.integrity)}</b>
          <div class="bar ${U.integrityClass(s.integrity)}"><i style="width:${Math.max(0, s.integrity)}%"></i></div></div>
        <div class="sec-res">${RESOURCES.map((r) => `<span class="${s.low[r] ? 'low' : ''}">${U.GLYPH[r]} ${s.inventory[r]}</span>`).join('')}</div>
        <div class="sec-wf">👤 <b>${s.workforce.available}</b>/${s.workforce.total} available${s.workforce.injured ? ` · <b>${s.workforce.injured}</b> injured` : ''}${s.workforce.loaned ? ` · ${s.workforce.loaned} loaned` : ''} · ${live.length} fault${live.length === 1 ? '' : 's'}</div>
        <div class="sec-faults">${faults}</div>
        <div class="sec-actions">
          <button class="neg" data-int="-10">−10 INT</button><button class="neg" data-int="-5">−5</button>
          <button class="pos" data-int="5">+5</button><button class="pos" data-int="10">+10 INT</button>
          <button data-fault="1">+ FAULT</button>
          <button data-injure="1">INJURE</button>
          <button data-brown="1">${s.status === 'BROWNOUT' ? 'RESTORE' : 'BROWNOUT'}</button>
          <button data-dark="1" class="${s.status === 'DARK' ? '' : 'neg'}">${s.status === 'DARK' ? 'RESTORE' : 'DARK'}</button>
        </div>
        <button data-open="1" style="font-size:9px;padding:3px">${openCards.has(code) ? '▲ CLOSE' : '▼ OPEN — stock · workers · slider'}</button>
        <div class="sec-more">
          <div class="steppers">${RESOURCES.map((r) => `<span class="stepper"><span class="n">${U.GLYPH[r]} ${r}</span>
            <button data-inv="${r}" data-d="-1">−</button><b>${s.inventory[r]}</b><button data-inv="${r}" data-d="1">+</button></span>`).join('')}
          </div>
          <div class="steppers">
            <span class="stepper"><span class="n">active</span><button data-wf="-1">−</button><b>${s.workforce.active}</b><button data-wf="1">+</button></span>
            <span class="stepper"><span class="n">injured</span><button data-inj="-1">−</button><b>${s.workforce.injured}</b><button data-inj="1">+</button></span>
            <button data-recover="1" style="font-size:9px">RECOVER 1 (MED)</button>
          </div>
          <div class="steppers"><span class="n">integrity</span>
            <input type="range" min="0" max="100" value="${Math.round(s.integrity)}" data-slider="1" style="flex:1">
          </div>
        </div>`;
      host.appendChild(el);
      bindCard(el, code, s);
    }
  }

  function bindCard(el, code, s) {
    const on = (sel, fn) => { for (const b of el.querySelectorAll(sel)) b.addEventListener('click', () => fn(b)); };
    on('[data-int]', (b) => send({ type: 'adjust_integrity', sector: code, delta: Number(b.dataset.int) }));
    on('[data-fault]', () => pickFault(code));
    on('[data-injure]', () => send({ type: 'injure_worker', sector: code, count: 1 }));
    on('[data-recover]', () => send({ type: 'recover_worker', sector: code, count: 1 }));
    on('[data-brown]', () => send({ type: 'set_status', sector: code, value: s.status === 'BROWNOUT' ? 'ACTIVE' : 'BROWNOUT' }));
    on('[data-dark]', () => {
      if (s.status === 'DARK') return send({ type: 'set_status', sector: code, value: 'ACTIVE' });
      if (confirm(`Take ${code} DARK? Its console locks and its people become refugees.`)) send({ type: 'set_status', sector: code, value: 'DARK' });
    });
    on('[data-open]', () => { if (openCards.has(code)) openCards.delete(code); else openCards.add(code); renderSectors(); });
    on('[data-inv]', (b) => send({ type: 'adjust_inventory', sector: code, delta: { [b.dataset.inv]: Number(b.dataset.d) } }));
    on('[data-wf]', (b) => send({ type: 'adjust_workforce', sector: code, active: Number(b.dataset.wf), injured: 0 }));
    on('[data-inj]', (b) => send({ type: 'adjust_workforce', sector: code, active: 0, injured: Number(b.dataset.inj) }));
    on('[data-clear]', (b) => send({ type: 'clear_fault', sector: code, fault_code: b.dataset.clear, reason: 'facilitator cleared' }));
    on('[data-time]', (b) => send({ type: 'fault_add_time', sector: code, fault_code: b.dataset.time, seconds: 60 }));
    on('[data-acc]', (b) => {
      const f = s.faults.find((x) => x.code === b.dataset.acc && !x.resolved);
      if (f) send({ type: 'accelerate_fault', sector: code, fault_code: f.code, decay_per_min: Math.round(f.decay_per_min * 2 * 10) / 10 });
    });
    const slider = el.querySelector('[data-slider]');
    if (slider) slider.addEventListener('change', () => send({ type: 'set_integrity', sector: code, value: Number(slider.value) }));
  }

  // -- tabs -----------------------------------------------------------------------

  for (const btn of $('tabs').querySelectorAll('button')) btn.addEventListener('click', () => showTab(btn.dataset.tab));
  function showTab(name) {
    activeTab = name;
    for (const btn of $('tabs').querySelectorAll('button')) btn.classList.toggle('on', btn.dataset.tab === name);
    for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('on', tab.id === `tab-${name}`);
    if (name === 'debrief' && !debriefData) loadDebrief();
    if (name === 'settings' && state) renderSettings(true);
  }

  // -- faults tab -------------------------------------------------------------------

  function renderPresets() {
    const presets = (state.scenario && state.scenario.fault_presets) || [];
    $('fault-presets').innerHTML = presets.map((p) => `<button data-preset="${esc(p.id)}" title="${esc(p.items.map((i) => `${i.fault_code} +${i.delay_s}s`).join(', '))}">▶ ${esc(p.name)}</button>`).join('') || '<div class="hint">None in this scenario.</div>';
    for (const b of $('fault-presets').querySelectorAll('button')) b.addEventListener('click', () => send({ type: 'fire_preset', preset_id: b.dataset.preset }));

    const sc = state.scheduled || [];
    $('scheduled').innerHTML = sc.map((s) => `<div class="sc"><b>${U.mmss(s.in_s)}</b> ${s.kind === 'fault' ? `${s.fault_code} → ${s.sector}` : `event ${s.event_id}${s.target ? ' → ' + s.target : ''}`} <span class="hint">${esc(s.source || '')}</span><button data-cancel="${s.id}">CANCEL</button></div>`).join('') || '<div class="hint">Nothing queued.</div>';
    for (const b of $('scheduled').querySelectorAll('[data-cancel]')) b.addEventListener('click', () => send({ type: 'cancel_scheduled', id: b.dataset.cancel }));
  }

  function renderInjects() {
    if (!content) return;
    const round = $('f-round').value;
    const sector = $('f-sector').value;
    const sev = $('f-sev').value;
    const text = $('f-text').value.trim().toUpperCase();
    const active = activeFaultCodes();
    const rows = content.faults.faults.filter((f) =>
      (!round || f.round === round) && (!sector || f.sector === sector) &&
      (!sev || String(f.severity) === sev) && (!text || f.code.includes(text) || f.name.toUpperCase().includes(text)));

    $('injects').innerHTML = rows.map((f) => {
      const tags = [];
      if (f.valid_codes.length === 0) tags.push('<span class="tag ghost">GHOST</span>');
      if (f.valid_codes.length > 1) tags.push('<span class="tag multi">2 CODES</span>');
      if (f.injures_workforce > 0) tags.push(`<span class="tag injury">−${f.injures_workforce}👤</span>`);
      if ((f.spec_refs || []).some((r) => r.binder !== f.sector)) tags.push('<span class="tag cross">X-SECTOR</span>');
      return `<div class="inject${active.has(f.code) ? ' active' : ''}">
          <span class="code">${f.code}</span><span class="sec">${f.sector} ${f.round}</span>
          <span class="nm" title="${esc(f.name)}">${U.severityPips(f.severity)} ${esc(f.name)}</span>
          <span class="tags">${tags.join('')}<button data-fire="${f.code}" data-sector="${f.sector}">${active.has(f.code) ? 'LIVE' : 'FIRE'}</button></span>
        </div>`;
    }).join('') || '<div class="hint">No faults match.</div>';
    for (const btn of $('injects').querySelectorAll('button[data-fire]')) {
      btn.addEventListener('click', () => send({ type: 'fire_fault', fault_code: btn.dataset.fire, sector: btn.dataset.sector }));
    }
  }

  // -- timeline tab -------------------------------------------------------------------

  function describe(item) {
    switch (item.kind) {
      case 'fault': return `${item.fault_code} → ${item.sector}`;
      case 'event': return `EVENT ${item.event_id}${item.sector ? ' → ' + item.sector : ''}`;
      case 'council': return 'CALL COUNCIL';
      case 'core': return `CORE OUTPUT → ${item.value}%`;
      case 'announce': return `ANNOUNCE: ${item.text}`;
      case 'alert': return `ALERT: ${item.text}`;
      case 'cycle': return 'PROCESS CYCLE';
      default: return item.kind;
    }
  }

  function renderTimeline() {
    $('tl-round').textContent = `${state.round} — ${state.round_name}`;
    const items = state.timeline || [];
    let ready = 0;
    $('timeline').innerHTML = items.map((it) => {
      if (it.status === 'READY') ready += 1;
      return `<div class="tl ${it.status}">
        <span class="off">${U.mmss(it.offset_s)}</span>
        <span class="what"><b>${esc(describe(it))}</b>${it.note ? `<span class="nt">${esc(it.note)}</span>` : ''}<span class="md">${it.mode} · ${it.status === 'READY' ? 'READY TO FIRE' : it.status}${it.result ? ' · ' + esc(it.result) : ''}</span></span>
        <span class="acts">${it.status === 'PENDING' || it.status === 'READY'
          ? `<button class="fire" data-fire="${it.id}">${it.status === 'READY' ? 'FIRE NOW' : 'FIRE'}</button><button data-delay="${it.id}">+2:00</button><button data-skip="${it.id}">SKIP</button>` : ''}</span>
      </div>`;
    }).join('') || '<div class="hint">No script for this round. Author one in the scenario file under timelines.</div>';
    for (const b of $('timeline').querySelectorAll('[data-fire]')) b.addEventListener('click', () => send({ type: 'timeline_fire', id: b.dataset.fire }));
    for (const b of $('timeline').querySelectorAll('[data-skip]')) b.addEventListener('click', () => send({ type: 'timeline_skip', id: b.dataset.skip }));
    for (const b of $('timeline').querySelectorAll('[data-delay]')) b.addEventListener('click', () => send({ type: 'timeline_delay', id: b.dataset.delay, seconds: 120 }));
    $('tabs').querySelector('[data-tab=timeline]').classList.toggle('attn', ready > 0);
    $('tabs').querySelector('[data-tab=timeline]').textContent = ready ? `TIMELINE (${ready})` : 'TIMELINE';
  }

  // -- pressure tab ---------------------------------------------------------------

  for (const btn of $('dial').querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      const k = btn.dataset.dial;
      if (k === 'fault' || k === 'second') return pickFault();
      if (k === 'injure') return quick('injure');
      if (k === 'core') return send({ type: 'adjust_core', delta: -10 });
      if (k === 'council') return send({ type: 'call_council' });
      if (k === 'blackout') return startBlackout();
      if (k === 'cancel_supply') return pickSector('CANCEL SUPPLY — which sector?', (s) => send({ type: 'fire_event', event_id: 'cancel_supply', target: s }));
      return send({ type: 'fire_event', event_id: k });
    });
  }

  function startBlackout() {
    if (!confirm('INITIATE ROLLING BLACKOUT — brownout rotates through every sector until you end it. Continue?')) return;
    send({ type: 'rolling_blackout', confirm: true });
  }
  $('btn-blackout').addEventListener('click', startBlackout);
  $('btn-blackout-2').addEventListener('click', startBlackout);
  $('btn-end-blackout').addEventListener('click', () => send({ type: 'end_blackout' }));

  function renderEvents() {
    const events = (state.scenario && state.scenario.events) || [];
    const codes = sectorCodes();
    $('events').innerHTML = events.map((e) => `<div class="ev">
        <span class="nm">${esc(e.name)}</span>
        ${e.targets === 'PICK' ? `<select data-target="${esc(e.id)}">${codes.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>` : `<span class="hint">${Array.isArray(e.targets) ? e.targets.join('+') : e.targets}</span>`}
        <button data-event="${esc(e.id)}">FIRE</button>
        <span class="ds">${esc(e.description || '')} · ${esc(e.visibility || 'ADMIN_ONLY')}</span>
      </div>`).join('');
    for (const b of $('events').querySelectorAll('[data-event]')) {
      b.addEventListener('click', () => {
        const sel = $('events').querySelector(`[data-target="${b.dataset.event}"]`);
        send({ type: 'fire_event', event_id: b.dataset.event, target: sel ? sel.value : null });
      });
    }
    const eff = state.effects || [];
    $('effects').innerHTML = eff.map((e) => `<div class="ef"><b>${esc(e.kind)}</b> ${esc(e.target)} ${e.remaining_s != null ? `<span data-cd-effect="${e.id}">${U.mmss(e.remaining_s)}</span>` : ''}${e.cycles_remaining != null ? `${e.cycles_remaining} cycle(s)` : ''} <span class="hint">${esc(e.source || '')}</span></div>`).join('') || '<div class="hint">None.</div>';
  }

  $('btn-alert').addEventListener('click', () => {
    const title = $('alert-title').value.trim();
    if (!title) return;
    send({ type: 'alert', title, subtitle: $('alert-sub').value.trim(), big: $('alert-big').value.trim() });
    $('alert-title').value = ''; $('alert-sub').value = ''; $('alert-big').value = '';
  });
  $('btn-dismiss-alert').addEventListener('click', () => send({ type: 'dismiss_alert' }));
  $('btn-announce').addEventListener('click', () => {
    const text = $('announce-text').value.trim();
    if (!text) return;
    send({ type: 'announce', text, sector: $('announce-target').value || null });
    $('announce-text').value = '';
  });
  $('announce-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-announce').click(); });
  for (const btn of document.querySelectorAll('[data-sting]')) btn.addEventListener('click', () => send({ type: 'sting', sound: btn.dataset.sting }));
  $('btn-breather').addEventListener('click', () => send({ type: 'breather', on: !(state && state.breather) }));

  // -- council tab ----------------------------------------------------------------

  $('btn-call-council').addEventListener('click', () => send({ type: 'call_council' }));
  $('btn-end-council').addEventListener('click', () => send({ type: 'end_council' }));
  for (const btn of document.querySelectorAll('[data-council]')) {
    btn.addEventListener('click', () => send({ type: 'clock', which: 'council', action: btn.dataset.council, seconds: Number(btn.dataset.sec || 0) }));
  }
  $('btn-order-clear').addEventListener('click', () => { orderDraft = []; renderOrder(); });
  $('btn-order-submit').addEventListener('click', () => {
    if (orderDraft.length !== sectorCodes().length) return;
    const bottom = orderDraft.slice(-2).join(' and ');
    if (!confirm(`SUBMIT CONTINUITY ORDER\n\n${orderDraft.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n${bottom} enter BROWNOUT.\nThis decision cannot be recalled.`)) return;
    send({ type: 'continuity_order', order: orderDraft, confirm: true });
    orderDraft = [];
    renderOrder();
  });

  function renderOrder() {
    const codes = sectorCodes();
    $('order-pick').innerHTML = codes.map((c) => `<button data-o="${c}" ${orderDraft.includes(c) ? 'disabled' : ''} style="border-color:${state.sectors[c].colour}">${c}</button>`).join('');
    for (const b of $('order-pick').querySelectorAll('button')) b.addEventListener('click', () => { orderDraft.push(b.dataset.o); renderOrder(); });
    $('order-slots').innerHTML = codes.map((_, i) => {
      const c = orderDraft[i];
      return `<div class="slot${c ? ' filled' : ''}${i >= codes.length - 2 ? ' brown' : ''}"><span class="rk">${i + 1}${i >= codes.length - 2 ? ' · BROWNOUT' : ''}</span>${c || '—'}</div>`;
    }).join('');
    $('btn-order-submit').disabled = orderDraft.length !== codes.length;
  }

  function renderCouncil() {
    const c = state.council;
    const clk = $('council-status');
    clk.innerHTML = `<b id="council-big" class="${state.council_clock.remaining_s <= 30 && c.active ? 'low' : ''}">${U.mmss(U.countdown(state.council_clock, state.frozen))}</b>
      <div class="st">${c.active ? 'COUNCIL IN SESSION' : 'NO COUNCIL IN SESSION'} · SITTING ${c.count}${c.order_submitted ? ' · ORDER SUBMITTED' : ''}</div>`;
    $('no-order').classList.toggle('hidden', !c.no_order);
    $('btn-call-council').disabled = c.active;
    $('btn-end-council').disabled = !c.active;
    const b = state.blackout;
    $('blackout-status').textContent = b.active ? `ACTIVE — ${b.current.join(' + ')} browned out now` : 'Not active.';
    $('btn-blackout-2').classList.toggle('hidden', b.active);
    $('btn-end-blackout').classList.toggle('hidden', !b.active);
    const o = state.continuity_order_detail;
    $('last-order').innerHTML = o ? `${o.order.map((c2, i) => `${i + 1}. ${c2}`).join(' · ')}<br><span class="hint">${new Date(o.t).toLocaleTimeString()} · council #${o.council_count} · ${o.time_used_s != null ? U.mmss(o.time_used_s) + ' used' : ''} · ${o.brownout.join(' + ')} BROWNOUT</span>` : 'None yet.';
    $('tabs').querySelector('[data-tab=council]').classList.toggle('attn', c.active || c.no_order);
    if (!$('order-pick').children.length) renderOrder();
  }

  // -- core tab -------------------------------------------------------------------

  for (const btn of document.querySelectorAll('[data-core-delta]')) btn.addEventListener('click', () => send({ type: 'adjust_core', delta: Number(btn.dataset.coreDelta) }));
  $('btn-core-set').addEventListener('click', () => send({ type: 'set_core_output', value: Number($('core-input').value) }));
  $('btn-stab-set').addEventListener('click', () => send({ type: 'set_stability', mode: $('stab-mode').value, value: Number($('stab-value').value) }));
  $('stab-mode').addEventListener('change', () => send({ type: 'set_stability', mode: $('stab-mode').value, value: Number($('stab-value').value || state.city_stability) }));
  for (const btn of document.querySelectorAll('[data-cycle]')) btn.addEventListener('click', () => send({ type: 'cycle', action: btn.dataset.cycle, seconds: Number(btn.dataset.sec || 0) }));
  $('btn-tel-set').addEventListener('click', () => send({ type: 'set_telemetry', telemetry: { wtr_reservoir_pressure: Number($('tel-wtr').value) } }));

  function renderCore() {
    const presets = (state.config && state.config.core_output_presets) || [100, 90, 80, 70, 60, 50, 40];
    $('core-presets').innerHTML = presets.map((p) => `<button data-p="${p}" class="${state.core_output === p ? 'on' : ''}">${p}%</button>`).join('');
    for (const b of $('core-presets').querySelectorAll('button')) b.addEventListener('click', () => send({ type: 'set_core_output', value: Number(b.dataset.p) }));
    if (document.activeElement !== $('core-input')) $('core-input').value = state.core_output;
    if (document.activeElement !== $('stab-value')) $('stab-value').value = state.city_stability;
    if (document.activeElement !== $('stab-mode')) $('stab-mode').value = state.stability_mode;
    $('stab-hint').textContent = state.stability_mode === 'auto' ? 'auto: integrity + core, minus critical faults, dark, brownout, missed upkeep' : 'manual';
    $('cycle-number').textContent = `cycle ${state.cycle.number} · ${state.cycle.length_s}s · ${state.cycle.running ? 'running' : 'held'}`;
    if (document.activeElement !== $('tel-wtr')) $('tel-wtr').value = state.telemetry.wtr_reservoir_pressure;

    const sum = state.cycle_summary;
    if (sum) {
      const fmt = (o) => Object.entries(o || {}).map(([k, v]) => `${v}${U.GLYPH[k] || k}`).join(' ') || '—';
      $('cycle-summary').innerHTML = `<div class="label">CYCLE ${sum.cycle} COMPLETE · ${new Date(sum.t).toLocaleTimeString()}${sum.missed_upkeep_count ? ` · <span class="bad">${sum.missed_upkeep_count} missed upkeep</span>` : ''}</div>
        <table><tr><th>SECTOR</th><th>PRODUCED</th><th>UPKEEP</th><th>SHORT</th><th>INT</th><th>NOTES</th></tr>
        ${Object.entries(sum.sectors).map(([c, l]) => `<tr><td><b>${c}</b></td><td class="good">${fmt(l.produced)}</td><td>${fmt(l.upkeep)}</td><td class="bad">${fmt(l.shortfall)}</td><td class="${l.integrity_delta < 0 ? 'bad' : ''}">${l.integrity_delta || ''}</td><td>${esc((l.notes || []).join(', '))}${l.recovered ? ` +${l.recovered} recovered` : ''}</td></tr>`).join('')}
        </table>`;
    }
    $('intel').innerHTML = (state.intel || []).map((i) => `<div class="it"><span>${esc(i.label)}</span><input type="text" value="${esc(i.value)}" data-intel="${esc(i.key)}"><button data-intel-set="${esc(i.key)}">SET</button></div>`).join('') +
      `<div class="hint">COM sees these; ${state.com_blind ? 'COM IS BLIND right now' : 'brownout hides the flagged ones'}.</div>`;
    for (const b of $('intel').querySelectorAll('[data-intel-set]')) {
      b.addEventListener('click', () => send({ type: 'set_intel', key: b.dataset.intelSet, value: $('intel').querySelector(`[data-intel="${b.dataset.intelSet}"]`).value }));
    }
  }

  // -- transfers tab ---------------------------------------------------------------

  $('btn-tr-add').addEventListener('click', () => {
    send({ type: 'transfer_request', from: $('tr-from').value, to: $('tr-to').value, resource: $('tr-res').value, amount: Number($('tr-amt').value) });
  });

  function renderTransfers() {
    const cap = state.transfer_capacity;
    $('trn-cap').textContent = `${cap.used} / ${cap.capacity}`;
    const NEXT = { REQUESTED: ['AGREED', 'WAITING_TRN', 'STAMPED', 'CANCELLED'], AGREED: ['WAITING_TRN', 'STAMPED', 'CANCELLED'], WAITING_TRN: ['STAMPED', 'CANCELLED'], STAMPED: ['DELIVERED', 'CANCELLED'] };
    $('transfers').innerHTML = (state.transfers || []).map((t) => {
      const closed = ['DELIVERED', 'CANCELLED'].includes(t.status);
      const acts = (NEXT[t.status] || []).map((n) => n === 'STAMPED'
        ? `<button data-stamp="${t.id}">STAMP</button>` : `<button data-upd="${t.id}" data-st="${n}">${n.replace('_', ' ')}</button>`).join('');
      return `<div class="tr${closed ? ' closed' : ''}"><div class="who"><b>${t.from} → ${t.to}</b> · ${t.amount} ${t.resource}${t.moved != null && t.moved !== t.amount ? ` (moved ${t.moved})` : ''}<br><span class="st ${t.status}">${t.status.replace('_', ' ')} · ${new Date(t.requested_at).toLocaleTimeString()} · by ${esc(t.requested_by)}</span></div><div class="acts">${acts}</div></div>`;
    }).join('') || '<div class="hint">No transfers recorded.</div>';
    for (const b of $('transfers').querySelectorAll('[data-stamp]')) b.addEventListener('click', () => send({ type: 'transfer_stamp', id: b.dataset.stamp, force: true }));
    for (const b of $('transfers').querySelectorAll('[data-upd]')) b.addEventListener('click', () => send({ type: 'transfer_update', id: b.dataset.upd, status: b.dataset.st }));
  }

  // -- settings tab --------------------------------------------------------------

  const SETTINGS = [
    ['THRESHOLDS'],
    ['critical_below', 'Critical below integrity', 'n'], ['degraded_below', 'Degraded below integrity', 'n'],
    ['dark_at', 'Dark at integrity', 'n'],
    ['resolve_recovery', 'Integrity on resolve', 'n'], ['lockout_s', 'Console lockout (s)', 'n'],
    ['lockout_after_consecutive_invalid', 'Lockout after N wrong', 'n'], ['council_clock_s', 'Council clock (s)', 'n'],
    ['CORE & ROUND LENGTHS'],
    ['core_start_output', 'Core output at start (%) — applies on reset', 'n'],
    ['round_length_s.R0', 'R0 Onboarding (s)', 'n'], ['round_length_s.R1', 'R1 Stable Ops (s)', 'n'],
    ['round_length_s.R2', 'R2 Interdependence (s)', 'n'], ['round_length_s.R3', 'R3 Core Failure (s)', 'n'],
    ['round_length_s.R4', 'R4 Aftershock (s)', 'n'],
    ['ECONOMY'],
    ['auto_economy', 'Digital economy on (production, upkeep, stock moves)', 'b'],
    ['deduct_resources_on_resolve', 'Deduct resources on resolve', 'b'],
    ['resolve_requires_resources', 'Refuse resolve when short of stock', 'b'],
    ['cycle_length_s', 'Cycle length (s)', 'n'], ['cycle_autostart', 'Cycle runs with the round clock', 'b'],
    ['upkeep_shortfall_penalty', 'Penalty per missing upkeep unit', 'n'], ['upkeep_shortfall_penalty_cap', 'Penalty cap per cycle', 'n'],
    ['core_scales_power_production', 'Core output scales POW production', 'b'],
    ['injured_recovery_per_cycle', 'Injured recovered per cycle (MED)', 'n'], ['injured_recovery_costs_med', 'Med supplies per recovery', 'n'],
    ['trn_capacity_per_cycle', 'Transport capacity per cycle', 'n'], ['deliver_on_stamp', 'Stamp delivers immediately', 'b'],
    ['FAULTS'],
    ['deadline_default_s.2', 'Default deadline — EMERGENCY (s, blank = none)', 'n?'], ['deadline_default_s.3', 'Default deadline — CRISIS (s)', 'n?'],
    ['deadline_default_s.1', 'Default deadline — INCIDENT (s)', 'n?'],
    ['deadline_penalty.1', 'Expiry penalty — INCIDENT', 'n'], ['deadline_penalty.2', 'Expiry penalty — EMERGENCY', 'n'], ['deadline_penalty.3', 'Expiry penalty — CRISIS', 'n'],
    ['expired_faults_remain_solvable', 'Expired faults stay solvable', 'b'],
    ['BROWNOUT'],
    ['brownout_effects.production_multiplier', 'Production ×', 'f'], ['brownout_effects.upkeep_delivery_multiplier', 'Upkeep ×', 'f'],
    ['brownout_effects.fault_timer_multiplier', 'Fault timer ×', 'f'], ['brownout_effects.worker_penalty', 'Workers unavailable', 'n'],
    ['brownout_effects.decay_per_min', 'Integrity decay / min', 'f'],
    ['brownout_effects.per_sector.POW.production_multiplier', 'POW production ×', 'f'],
    ['brownout_effects.per_sector.TRN.transfer_capacity', 'TRN capacity under brownout', 'n'],
    ['brownout_effects.per_sector.COM.lose_telemetry', 'COM loses telemetry', 'b'],
    ['rolling_blackout.interval_s', 'Blackout rotation (s)', 'n'], ['rolling_blackout.sectors_at_a_time', 'Sectors browned out at a time', 'n'],
    ['auto_blackout_on_no_order', 'Auto blackout when no order', 'b'],
    ['STABILITY FORMULA'],
    ['stability.weights.integrity', 'Weight: avg integrity', 'f'], ['stability.weights.core_output', 'Weight: core output', 'f'],
    ['stability.weights.critical_fault', '− per critical fault', 'n'], ['stability.weights.dark_sector', '− per dark sector', 'n'],
    ['stability.weights.brownout_sector', '− per brownout sector', 'n'], ['stability.weights.missed_upkeep', '− per missed upkeep', 'n'],
    ['RESOURCE MINIMUMS'],
    ['resource_min_thresholds.power', 'Power', 'n'], ['resource_min_thresholds.water', 'Water', 'n'],
    ['resource_min_thresholds.parts', 'Parts', 'n'], ['resource_min_thresholds.med', 'Medical', 'n'],
    ['WALL & ROOM'],
    ['wall_shows_inventory', 'Wall shows resource summary', 'b'], ['wall_shows_faults', 'Wall shows worst fault', 'b'],
    ['com_dark_hides_wall_detail', 'COM dark hides wall detail', 'b'], ['wall_feed_max', 'Wall feed rows', 'n'],
    ['alert_full_screen_s', 'Overlay full-screen seconds', 'n'], ['delay_window_s', 'City feed delay (s)', 'n'],
    ['sound_enabled', 'Sound on wall + sectors', 'b'],
  ];

  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const setPath = (o, p, v) => { const ks = p.split('.'); let cur = o; for (const k of ks.slice(0, -1)) { cur[k] = cur[k] || {}; cur = cur[k]; } cur[ks.at(-1)] = v; return o; };

  function renderSettings(force = false) {
    const cfgJson = JSON.stringify(state.config);
    $('settings-scenario').textContent = `${state.scenario_name} (${state.scenario_id})`;
    if (!force && cfgJson === lastConfigJson) return;
    lastConfigJson = cfgJson;
    const cfg = state.config;
    $('settings').innerHTML = SETTINGS.map(([key, label, type]) => {
      if (!label) return `<div class="sg">${key}</div>`;
      const v = getPath(cfg, key);
      if (type === 'b') return `<label>${esc(label)}<input type="checkbox" data-key="${key}" data-type="b" ${v ? 'checked' : ''}></label>`;
      return `<label>${esc(label)}<input type="number" step="${type === 'f' ? '0.05' : '1'}" data-key="${key}" data-type="${type}" value="${v == null ? '' : v}"></label>`;
    }).join('');
    for (const input of $('settings').querySelectorAll('input')) {
      input.addEventListener('change', () => {
        let v;
        if (input.dataset.type === 'b') v = input.checked;
        else if (input.value === '' && input.dataset.type === 'n?') v = null;
        else v = Number(input.value);
        send({ type: 'set_config', patch: setPath({}, input.dataset.key, v) });
      });
    }

    const sc = state.scenario.sectors;
    $('sector-config').innerHTML = `<table><tr><th>SECTOR</th>${RESOURCES.map((r) => `<th>PROD ${U.GLYPH[r]}</th>`).join('')}${RESOURCES.map((r) => `<th>UPKEEP ${U.GLYPH[r]}</th>`).join('')}<th>START INT</th><th>WORKERS</th><th></th></tr>
      ${Object.entries(sc).map(([c, d]) => `<tr data-sc="${c}"><td><b>${c}</b></td>
        ${RESOURCES.map((r) => `<td><input type="number" data-prod="${r}" value="${d.production[r] || 0}"></td>`).join('')}
        ${RESOURCES.map((r) => `<td><input type="number" data-up="${r}" value="${d.upkeep[r] || 0}"></td>`).join('')}
        <td><input type="number" data-si value="${d.start_integrity}"></td><td><input type="number" data-sw value="${d.start_workforce}"></td>
        <td><button data-apply="${c}">APPLY</button></td></tr>`).join('')}</table>
      <div class="hint">Production and upkeep apply from the next cycle. Start values apply on the next reset. AGR/TRN/COM economies are unspecified by design — set them here once playtested.</div>`;
    for (const b of $('sector-config').querySelectorAll('[data-apply]')) {
      b.addEventListener('click', () => {
        const row = $('sector-config').querySelector(`[data-sc="${b.dataset.apply}"]`);
        const production = {}; const upkeep = {};
        for (const r of RESOURCES) {
          const p = Number(row.querySelector(`[data-prod="${r}"]`).value); if (p > 0) production[r] = p;
          const u = Number(row.querySelector(`[data-up="${r}"]`).value); if (u > 0) upkeep[r] = u;
        }
        send({ type: 'set_sector_config', sector: b.dataset.apply, patch: { production, upkeep, start_integrity: Number(row.querySelector('[data-si]').value), start_workforce: Number(row.querySelector('[data-sw]').value) } });
      });
    }

    // Per-fault overrides in force (spec §44): deadline, expiry penalty, extra accepted codes.
    const overrides = Object.entries(cfg.fault_overrides || {});
    $('fault-overrides').innerHTML = overrides.map(([code, o]) => `<div class="fo">
        <b>${esc(code)}</b>
        <span>${o.deadline_s != null ? `deadline ${U.mmss(o.deadline_s)}` : ''}${o.integrity_penalty != null ? ` · penalty −${esc(o.integrity_penalty)}` : ''}${(o.extra_valid_codes || []).length ? ` · also accepts ${esc(o.extra_valid_codes.join(', '))}` : ''}</span>
        <button data-fo-remove="${esc(code)}">REMOVE</button>
      </div>`).join('') || '<div class="hint">None. Faults use the content deadline, the severity defaults and the content answer.</div>';
    for (const b of $('fault-overrides').querySelectorAll('[data-fo-remove]')) {
      b.addEventListener('click', () => send({ type: 'set_fault_override', fault_code: b.dataset.foRemove, patch: null }));
    }
  }

  $('btn-fo-apply').addEventListener('click', () => {
    const code = $('fo-fault').value;
    if (!code) return;
    const patch = {};
    if ($('fo-deadline').value !== '') patch.deadline_s = Number($('fo-deadline').value);
    if ($('fo-penalty').value !== '') patch.integrity_penalty = Number($('fo-penalty').value);
    patch.extra_valid_codes = $('fo-extra').value.split(',').map((c) => c.trim()).filter(Boolean);
    send({ type: 'set_fault_override', fault_code: code, patch });
    $('fo-deadline').value = ''; $('fo-penalty').value = ''; $('fo-extra').value = '';
  });

  $('btn-save-scenario').addEventListener('click', async () => {
    const name = $('save-name').value.trim();
    if (!name) return;
    const res = await fetch(`/api/scenarios?${qs()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, from_live: true }) });
    const data = await res.json().catch(() => ({}));
    $('save-hint').textContent = res.ok ? `saved as ${data.id}` : (data.error || 'failed');
    if (res.ok) {
      $('scenario-select').innerHTML = data.scenarios.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.builtin ? '' : ' (saved)'}</option>`).join('');
      $('save-name').value = '';
    }
  });
  $('btn-load-scenario').addEventListener('click', () => {
    const id = $('scenario-select').value;
    if (!id) return;
    if (!confirm(`RESET RUN with scenario "${id}"? All live state is wiped; the log is rotated.`)) return;
    const runId = prompt('New run id:', `${new Date().toISOString().slice(0, 10)}-${id}`);
    if (!runId) return;
    send({ type: 'reset_run', run_id: runId, scenario_id: id, confirm: true });
    lastConfigJson = null;
  });

  // -- debrief tab -------------------------------------------------------------------

  $('btn-debrief-refresh').addEventListener('click', loadDebrief);
  $('btn-wall-debrief').addEventListener('click', () => send({ type: 'wall_debrief', on: !(state && state.wall_debrief) }));

  async function loadDebrief() {
    $('debrief-hint').textContent = 'folding the log…';
    try {
      const res = await fetch(`/api/debrief?${qs()}`);
      debriefData = await res.json();
      $('debrief-hint').textContent = `${debriefData.entries} log lines · ${new Date(debriefData.generated_at).toLocaleTimeString()}`;
      renderDebrief();
    } catch (err) {
      $('debrief-hint').textContent = 'failed to load';
    }
  }

  const fmtS = (v) => (v == null ? '—' : U.mmss(v));
  function renderDebrief() {
    const d = debriefData;
    if (!d) return;
    const o = d.overall;
    const stat = (v, l) => `<div class="stat"><b>${v == null ? '—' : v}</b><span>${l}</span></div>`;
    const cmp = d.comparison;
    const cell = (R, row) => { if (!R || R[row.key] == null) return '—'; return row.unit === 's' ? U.mmss(R[row.key]) : `${R[row.key]}${row.unit}`; };
    $('debrief').innerHTML = `
      <div class="stat-grid">
        ${stat(`${o.faults.resolved} / ${o.faults.fired}`, 'FAULTS RESOLVED')}
        ${stat(fmtS(o.faults.avg_first_action_s), 'AVG TIME TO FIRST ACTION')}
        ${stat(fmtS(o.faults.avg_resolution_s), 'AVG RESPONSE')}
        ${stat(o.console.invalid_code, 'FAILED CONSOLE ENTRIES')}
        ${stat(o.transfers.requested, 'TRANSFERS')}
        ${stat(fmtS(o.transfers.avg_request_to_stamp_s), 'AVG TRANSFER TIME')}
        ${stat(o.sectors.critical_entries, 'CRITICAL ENTRIES')}
        ${stat(o.council.avg_time_used_s != null ? U.mmss(o.council.avg_time_used_s) : '—', 'COUNCIL DECISION')}
      </div>
      <div class="cmp"><div class="label">ROUND 3 vs AFTERSHOCK <em>— neutral: the delta is the product, not a score</em></div>
        <table><tr><th></th><th>ROUND 3</th><th>AFTERSHOCK</th></tr>
        ${cmp.rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${cell(cmp.R3, r)}</td><td>${cell(cmp.R4, r)}</td></tr>`).join('')}
        </table></div>
      <div class="rounds-list">${Object.values(d.rounds).map((R) => `<details><summary>${R.round} — ${R.faults.fired} faults · ${R.faults.resolved} resolved · ${R.faults.expired} expired · ${R.console.invalid_code} bad entries · ${R.transfers.requested} transfers · council ${R.council.called}</summary>
        ${R.faults.list.map((f) => `<div class="dtl"><span class="t">${f.code} ${f.sector}</span><span>${f.outcome}</span><span>first ${fmtS(f.time_to_first_action_s)}</span><span>solve ${fmtS(f.time_to_resolution_s)}</span><span>${f.attempts} att</span>${f.cross_sector ? '<span>x-sector</span>' : ''}${f.expired ? '<span style="color:var(--red)">expired</span>' : ''}</div>`).join('')}
        ${R.transfers.list.map((t) => `<div class="dtl"><span class="t">${t.from}→${t.to}</span><span>${t.amount} ${t.resource}</span><span>${t.status}</span><span>stamp ${fmtS(t.request_to_stamp_s)}</span></div>`).join('')}
        ${R.council.list.map((c) => `<div class="dtl"><span class="t">council</span><span>${c.order ? c.order.join(' › ') : (c.order_submitted ? 'order' : 'no order')}</span><span>${fmtS(c.time_used_s)} used</span></div>`).join('')}
        </details>`).join('')}</div>
      <div class="label">TIMELINE</div>
      <div>${d.timeline.slice(-80).map((e) => `<div class="dtl"><span class="t">${new Date(e.t).toLocaleTimeString([], { hour12: false })}</span><span>${esc(e.text)}</span></div>`).join('')}</div>`;
  }

  // -- observation pad --------------------------------------------------------------

  $('obs-tags').innerHTML = TAGS.map((t) => `<button data-tag="${t}">${t}</button>`).join('');
  for (const btn of $('obs-tags').querySelectorAll('button')) {
    btn.addEventListener('click', () => { obsTag = obsTag === btn.dataset.tag ? null : btn.dataset.tag; renderObsTags(); });
  }
  function renderObsTags() { for (const btn of $('obs-tags').querySelectorAll('button')) btn.classList.toggle('on', btn.dataset.tag === obsTag); }
  function renderObsSectors() {
    for (const btn of $('obs-sectors').querySelectorAll('button')) {
      const on = btn.dataset.sector === obsSector;
      btn.classList.toggle('on', on);
      if (on && state) btn.style.setProperty('--sector-on', state.sectors[btn.dataset.sector].colour);
    }
  }
  function logObservation() {
    const note = $('obs-note').value.trim();
    if (!note && !obsTag) return;
    send({ type: 'observe', sector: obsSector, tag: obsTag, note });
  }
  $('btn-observe').addEventListener('click', logObservation);
  $('obs-note').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); logObservation(); } });

  // -- render -----------------------------------------------------------------------

  function render(next) {
    state = next;
    $('run-id').textContent = state.run_id;
    $('scenario-name').textContent = state.scenario_name;
    $('phase-name').textContent = state.phase_name;
    $('mode-pill').textContent = state.mode;
    $('breather-pill').classList.toggle('hidden', !state.breather);
    $('paused-pill').classList.toggle('hidden', !state.paused);
    $('btn-pause').textContent = state.paused ? 'RESUME' : 'PAUSE';
    $('quick-pause').textContent = state.paused ? 'RESUME' : 'PAUSE';
    $('quick-pause').classList.toggle('on', state.paused);
    $('btn-start').textContent = state.round_clock.running ? 'RUNNING' : 'START';
    $('btn-start').disabled = state.round_clock.running;
    $('btn-breather').textContent = state.breather ? 'BREATHER ON' : 'BREATHER OFF';
    $('btn-breather').classList.toggle('on', state.breather);
    $('btn-sound').textContent = state.sound_enabled ? '🔊 ON' : '🔇 OFF';
    $('btn-wall-debrief').textContent = state.wall_debrief ? 'HIDE FROM WALL' : 'SHOW ON WALL';

    const core = $('core-value');
    core.textContent = `${state.core_output}%`;
    core.className = state.core_output < 50 ? 'low' : state.core_output < 70 ? 'warn' : '';
    const city = $('city-value');
    city.textContent = `${state.city_stability}%`;
    city.className = state.city_stability < 30 ? 'low' : state.city_stability < 60 ? 'warn' : '';

    if (state.phases && $('phase-select').options.length !== state.phases.length) {
      $('phase-select').innerHTML = state.phases.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    }
    if (document.activeElement !== $('phase-select')) $('phase-select').value = state.phase;

    renderClocks();
    renderSectors();
    renderPresets();
    renderTimeline();
    renderEvents();
    renderCouncil();
    renderCore();
    renderTransfers();
    renderSettings();
    renderObsSectors();
    renderFeed();
    if (content) renderInjects();
  }

  function renderClocks() {
    if (!state) return;
    const rc = U.countdown(state.round_clock, state.frozen);
    $('master-clock').textContent = U.mmss(rc);
    $('master-clock').classList.toggle('low', rc <= 60 && state.round_clock.running);
    const cy = U.countdown(state.cycle, state.frozen);
    $('cycle-clock').textContent = U.mmss(cy);
    $('cycle-clock').className = cy <= 30 && state.cycle.running ? 'low' : cy <= 120 && state.cycle.running ? 'warn' : '';
    $('cycle-clock-2').textContent = U.mmss(cy);
    const cc = U.countdown(state.council_clock, state.frozen);
    $('council-clock').textContent = U.mmss(cc);
    $('council-clock').className = state.council.active ? (cc <= 30 ? 'low' : '') : '';
    const big = $('council-big');
    if (big) { big.textContent = U.mmss(cc); big.classList.toggle('low', cc <= 30 && state.council.active); }
    $('tl-elapsed').textContent = `${U.mmss(state.round_length_s - rc)} elapsed`;
    for (const el of document.querySelectorAll('[data-cd-fault]')) {
      const [sec, code] = el.dataset.cdFault.split(':');
      const f = state.sectors[sec] && state.sectors[sec].faults.find((x) => x.code === code && !x.resolved);
      if (!f || f.expired || f.deadline_remaining_s == null) continue;
      const left = U.countdown({ running: !f.paused, remaining_s: f.deadline_remaining_s }, state.frozen);
      el.textContent = U.mmss(left);
      el.classList.toggle('low', left <= 30);
    }
    for (const el of document.querySelectorAll('[data-cd-effect]')) {
      const e = (state.effects || []).find((x) => x.id === el.dataset.cdEffect);
      if (e && e.remaining_s != null) el.textContent = U.mmss(U.countdown({ running: true, remaining_s: e.remaining_s }, state.frozen));
    }
  }
  setInterval(renderClocks, 500);

  /** Ticker doubles as the facilitator's live feed — same events, everything. */
  function renderFeed() {
    $('feed').innerHTML = state.ticker.slice(0, 80).map((e) => `
      <div class="feed-row ${esc(e.kind)}">
        <span class="ft">${new Date(e.t).toLocaleTimeString([], { hour12: false })}</span>
        <span class="fx">${esc(e.text)}</span>
      </div>`).join('') || '<div class="hint">No events yet.</div>';
  }
})();
