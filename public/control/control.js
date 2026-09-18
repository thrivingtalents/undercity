/* UNDERCITY — the facilitator's command centre (Admin v16).
 *
 * UNDERSTAND → DECIDE → INTERVENE. The frame from the server is the whole
 * truth; this file only decides what to show first. OVERVIEW is the default:
 * session state, NEEDS ATTENTION, six observational sector cards, five
 * system summaries, a short activity feed and the observation pad. EVENTS
 * runs the scenario, CITY SYSTEMS inspects authoritative state, DEBRIEF
 * looks back. A change to authoritative state — a health value, a tray, a
 * worker, a forced approval — goes through askOverride(): current → proposed,
 * a reason, and one ADMIN_OVERRIDE audit event on the server.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const U = window.Undercity;
  const CTX = U.context();
  const params = new URLSearchParams(location.search);
  const TOKEN = params.get('token') || '';

  const TAGS = ['DOMINANCE', 'WITHDRAWAL', 'SAFETY+', 'SAFETY-', 'DISCREPANCY-SPOTTED'];
  const RESOURCES = ['power', 'water', 'parts', 'med'];
  const RES_NAME = { power: 'POWER', water: 'WATER', parts: 'PARTS', med: 'MEDICAL', workers: 'WORKERS' };
  const ANNOUNCE_PRESETS = [
    'Core output dropping. Council convenes in 10 minutes.',
    'Upkeep suspended this round.',
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
  const LOG_KINDS = {
    FAULTS: ['fault', 'resolve', 'lockout', 'clear', 'open'],
    TRANSFERS: ['transfer'],
    RESOURCES: ['cycle', 'output', 'core'],
    WORKERS: ['injury'],
    ADMIN: ['override', 'obs', 'announce', 'pause', 'breather', 'status', 'event', 'council', 'order', 'blackout', 'round', 'phase'],
  };
  const REQ_WORD = { REQUESTED: 'WAITING FOR SUPPLIER', TRANSFER_CREATED: 'SUPPLIER ACCEPTED', DECLINED_BY_SUPPLIER: 'DECLINED', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED' };
  const TR_WORD = { PENDING_TRN_APPROVAL: 'WAITING FOR TRN', APPROVED: 'APPROVED BY TRN', DELIVERED: 'DELIVERED', DECLINED_BY_TRN: 'TRN DECLINED', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED' };
  const HEAL_WORD = { WAITING_FOR_MED: 'WAITING FOR MEDICAL', HEALED: 'HEALED', DECLINED_BY_MED: 'DECLINED BY MEDICAL', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED' };

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
  let view = 'overview';
  const sub = { events: 'faults', systems: 'transfers', debrief: 'observations' };
  let faultView = 'active';
  let faultDebug = false;
  let drawerSector = null;
  let drawerAdmin = false;
  let logFilter = 'ALL';
  let attnAll = false;
  let obsSector = null;
  let obsTag = null;
  let orderDraft = [];
  let lastConfigJson = null;
  let debriefData = null;
  let pendingOverride = null;

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
      if (msg.type === 'observe_ack') { $('obs-note').value = ''; $('obs2-note').value = ''; obsTag = null; renderObs(); toast('OBSERVATION LOGGED', 'ok'); }
      if (msg.type === 'export_ready') window.open(msg.url, '_blank');
      if (msg.type === 'welcome' && msg.urls) urls = msg.urls;
      if (msg.type === 'order_result' && !msg.ok) toast(`Order refused: ${msg.reason}`);
      if (msg.type === 'transfer_result' && msg.ok === false) toast(`Transfer: ${msg.reason}`);
      if (msg.type === 'fire_result' && msg.ok === false) toast(`Not fired: ${msg.reason}`);
      if (msg.type === 'event_result' && msg.ok === false) toast(`Event: ${msg.reason}`);
      if (msg.type === 'output_result' && msg.ok === false) toast(`Output: ${msg.reason}`);
      if (msg.type === 'override_result') {
        if (msg.ok) toast(`OVERRIDE LOGGED — ${String(msg.action || '').toUpperCase().replace(/_/g, ' ')}${msg.target ? ' · ' + msg.target : ''}`, 'ok');
        else toast(`Override refused: ${msg.reason}`);
      }
    },
  });
  const send = (payload) => socket.send(payload);

  function toast(text, cls = 'bad') {
    const el = document.createElement('div');
    el.className = `toast ${cls}`;
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
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

    for (const host of ['obs-sectors', 'obs2-sectors']) {
      $(host).innerHTML = codes.map((s) => `<button data-sector="${s}">${s}</button>`).join('');
      for (const btn of $(host).querySelectorAll('button')) {
        btn.addEventListener('click', () => { obsSector = obsSector === btn.dataset.sector ? null : btn.dataset.sector; renderObs(); });
      }
    }
    $('ovr-sectors').innerHTML = codes.map((s) => `<button data-ovr-sector="${s}">${U.SECTOR_GLYPH[s] || ''} ${s}</button>`).join('');
    for (const b of $('ovr-sectors').querySelectorAll('button')) b.addEventListener('click', () => openSector(b.dataset.ovrSector, { admin: true }));

    $('presets').innerHTML = ANNOUNCE_PRESETS.map((p, i) => `<button data-preset="${i}">${esc(p)}</button>`).join('');
    for (const btn of $('presets').querySelectorAll('button')) {
      btn.addEventListener('click', () => send({ type: 'announce', text: ANNOUNCE_PRESETS[Number(btn.dataset.preset)], sector: $('announce-target').value || null }));
    }
    $('alert-presets').innerHTML = ALERT_PRESETS.map((p, i) => `<button data-alert="${i}">${esc(p.title)}${p.big ? ' ' + esc(p.big) : ''}</button>`).join('');
    for (const btn of $('alert-presets').querySelectorAll('button')) {
      btn.addEventListener('click', () => send({ type: 'alert', ...ALERT_PRESETS[Number(btn.dataset.alert)] }));
    }
    for (const f of content.faults.faults) {
      $('fo-fault').insertAdjacentHTML('beforeend', `<option value="${f.code}">${f.code} · ${f.sector} · ${esc(f.name)}</option>`);
    }
  }

  // -- navigation: four destinations, one click back to OVERVIEW ----------------

  function go(next, subName = null) {
    view = next;
    for (const b of $('nav').querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === view);
    for (const v of document.querySelectorAll('.view')) v.classList.toggle('on', v.id === `view-${view}`);
    $('crumb').classList.toggle('hidden', view !== 'settings');
    $('crumb').textContent = view === 'settings' ? 'OVERVIEW › ••• › SETTINGS' : '';
    if (subName && sub[view] !== undefined) sub[view] = subName;
    showSub(view);
    if (view === 'debrief' && sub.debrief === 'analysis' && !debriefData) loadDebrief();
    if (view === 'settings' && state) renderSettings(true);
  }
  function showSub(v) {
    const nav = document.querySelector(`.subnav[data-for="${v}"]`);
    if (!nav) return;
    const active = sub[v];
    for (const b of nav.querySelectorAll('[data-sub]')) b.classList.toggle('on', b.dataset.sub === active);
    const root = $(`view-${v}`);
    for (const panel of root.querySelectorAll('.sub')) panel.classList.toggle('on', panel.id === `sub-${active}` || (v === 'debrief' && active === 'overrides' && panel.id === 'sub-overrides-log'));
  }
  for (const b of $('nav').querySelectorAll('[data-view]')) b.addEventListener('click', () => go(b.dataset.view));
  for (const nav of document.querySelectorAll('.subnav')) {
    for (const b of nav.querySelectorAll('[data-sub]')) b.addEventListener('click', () => go(nav.dataset.for, b.dataset.sub));
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go]');
    if (!t) return;
    const [v, s] = String(t.dataset.go).split(':');
    go(v, s || null);
  });
  for (const b of $('fault-views').querySelectorAll('[data-fv]')) b.addEventListener('click', () => { faultView = b.dataset.fv; renderFaults(); });
  for (const b of $('log-filters').querySelectorAll('[data-lf]')) b.addEventListener('click', () => { logFilter = b.dataset.lf; renderLog(); });
  $('btn-expand-log').addEventListener('click', () => go('debrief', 'log'));
  $('attn-more').addEventListener('click', () => { attnAll = !attnAll; renderAttention(); });

  // -- top bar ------------------------------------------------------------------

  $('btn-start').addEventListener('click', () => send({ type: 'clock', which: 'round', action: state && state.round_clock.remaining_s > 0 && !state.round_clock.running && state.phase !== 'SETUP' ? 'resume' : 'start' }));
  $('btn-pause').addEventListener('click', togglePause);
  function togglePause() { send({ type: state && state.paused ? 'resume' : 'pause' }); }
  $('btn-end-phase').addEventListener('click', () => {
    if (!confirm('STOP THE ROUND CLOCK at 00:00? The phase stays where it is — NEXT PHASE moves it on.')) return;
    send({ type: 'clock', which: 'round', action: 'end' });
  });
  $('btn-next-phase').addEventListener('click', () => {
    const next = nextPhase();
    if (!next) return;
    const roundChange = state && next.round !== state.round;
    if (!confirm(`NEXT PHASE → ${next.name}${roundChange ? `\n\nThis enters ${next.round}: the outgoing round's upkeep is charged, TRN and MED allowances reset, unfinished paperwork expires and AGR is dealt again.` : ''}`)) return;
    send({ type: 'next_phase' });
  });
  function nextPhase() {
    if (!state || !state.phases) return null;
    const i = state.phases.findIndex((p) => p.id === state.phase);
    return i >= 0 ? state.phases[i + 1] || null : null;
  }

  // the ••• menu
  $('btn-more').addEventListener('click', (e) => { e.stopPropagation(); $('more').classList.toggle('hidden'); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#more') && !e.target.closest('#btn-more')) $('more').classList.add('hidden'); });
  $('btn-sound').addEventListener('click', () => send({ type: 'set_sound', on: !(state && state.sound_enabled) }));
  $('btn-snapshot').addEventListener('click', () => { send({ type: 'snapshot' }); toast('SNAPSHOT WRITTEN', 'ok'); });
  $('btn-export').addEventListener('click', () => send({ type: 'export_log' }));
  $('btn-export-2').addEventListener('click', () => send({ type: 'export_log' }));
  $('btn-settings').addEventListener('click', () => go('settings'));
  $('btn-reset').addEventListener('click', askReset);
  $('ovr-reset-session').addEventListener('click', askReset);
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

  // -- quick actions + picker -----------------------------------------------------

  for (const btn of document.querySelectorAll('.quick-groups button[data-quick]')) btn.addEventListener('click', () => quick(btn.dataset.quick));
  $('picker-close').addEventListener('click', closePicker);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePicker(); $('urls').classList.add('hidden'); closeModal(); $('more').classList.add('hidden'); }
  });

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
      case 'injure': return pickSector('INJURE WORKER — which sector?', (s) => send({ type: 'injure_worker', sector: s, count: 1 }),
        (s) => `👤 ${state.sectors[s].workforce.active} active`);
      case 'council': return send({ type: 'call_council' });
      case 'breather': return send({ type: 'breather', on: !(state && state.breather) });
      case 'brownout': return pickSector('BROWNOUT — toggle a sector', (s) => {
        const st = state.sectors[s];
        send({ type: 'set_status', sector: s, value: st.status === 'BROWNOUT' ? 'ACTIVE' : 'BROWNOUT' });
      }, (s) => (state.sectors[s].status === 'BROWNOUT' ? 'RESTORE' : state.sectors[s].status));
      case 'announce': {
        const body = openPicker('ANNOUNCEMENT', `
          <div class="pick-presets">${ANNOUNCE_PRESETS.map((p, i) => `<button data-i="${i}">${esc(p)}</button>`).join('')}</div>
          <div class="row"><input type="text" id="pk-announce" placeholder="custom announcement…" autocomplete="off"><button id="pk-send" class="primary">SEND CITY-WIDE</button></div>`);
        for (const b of body.querySelectorAll('[data-i]')) b.addEventListener('click', () => { send({ type: 'announce', text: ANNOUNCE_PRESETS[Number(b.dataset.i)] }); closePicker(); });
        const goSend = () => { const t = body.querySelector('#pk-announce').value.trim(); if (t) { send({ type: 'announce', text: t }); closePicker(); } };
        body.querySelector('#pk-send').addEventListener('click', goSend);
        body.querySelector('#pk-announce').addEventListener('keydown', (e) => { if (e.key === 'Enter') goSend(); });
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
      default: return null;
    }
  }

  function pickSector(title, onPick, subtitle) {
    const codes = sectorCodes();
    const body = openPicker(title, `<div class="pick-big">${codes.map((s) =>
      `<button data-s="${s}" style="border-color:${state.sectors[s].colour}">${U.SECTOR_GLYPH[s] || ''} ${s}<span class="sub">${esc(subtitle ? subtitle(s) : '')}</span></button>`).join('')}</div>`);
    for (const b of body.querySelectorAll('[data-s]')) b.addEventListener('click', () => { onPick(b.dataset.s); closePicker(); });
  }

  /** Triggering a fault is routine, but never a slip: one preview, one press. */
  function confirmTrigger(code, sector) {
    const f = content && content.faults.faults.find((x) => x.code === code);
    const body = openPicker(`TRIGGER FAULT — ${code}`, `
      <div class="confirm-card">
        <div class="cc-title">${esc(code)} · ${esc(f ? f.name : '')}</div>
        <div class="cc-line">→ <b>${esc(sector)}</b> · ${f ? U.severityPips(f.severity) : ''} · ${f ? esc(f.round) : ''}${f && f.injures_workforce ? ` · injures ${f.injures_workforce}` : ''}</div>
        <div class="row"><button id="cc-cancel">CANCEL</button><button id="cc-go" class="primary">TRIGGER</button></div>
      </div>`);
    body.querySelector('#cc-cancel').addEventListener('click', closePicker);
    body.querySelector('#cc-go').addEventListener('click', () => { send({ type: 'fire_fault', fault_code: code, sector }); closePicker(); });
  }

  /** A wave shows what it is before it fires. */
  function previewPreset(id) {
    const presets = (state && state.scenario ? state.scenario.fault_presets : []) || [];
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    const sectors = [...new Set(p.items.map((i) => i.sector))];
    const body = openPicker(`PRESET WAVE — ${p.name}`, `
      <div class="confirm-card">
        <div class="cc-title">${esc(p.name)}</div>
        <div class="cc-line">${p.items.length} fault${p.items.length === 1 ? '' : 's'} · sectors ${esc(sectors.join(', '))}</div>
        <div class="cc-list">${p.items.map((i) => `<div>${esc(i.fault_code)} → ${esc(i.sector)} <span class="hint">${i.delay_s ? `+${U.mmss(i.delay_s)}` : 'now'}</span></div>`).join('')}</div>
        <div class="row"><button id="cc-cancel">CANCEL</button><button id="cc-go" class="primary">FIRE WAVE</button></div>
      </div>`);
    body.querySelector('#cc-cancel').addEventListener('click', closePicker);
    body.querySelector('#cc-go').addEventListener('click', () => { send({ type: 'fire_preset', preset_id: id }); closePicker(); });
  }

  function pickFault(only = null) {
    if (!content) return;
    const codes = only ? [only] : sectorCodes();
    const active = activeFaultCodes();
    const presets = (state && state.scenario ? state.scenario.fault_presets : []) || [];
    const body = openPicker(only ? `TRIGGER FAULT — ${only}` : 'TRIGGER FAULT — pick one, then confirm', `
      ${presets.length && !only ? `<div class="pick-presets">${presets.map((p) => `<button data-preset="${esc(p.id)}">▶ ${esc(p.name)} <span class="hint">${p.items.length} faults</span></button>`).join('')}</div>` : ''}
      <div class="pick-sectors">${codes.map((s) => `
        <div class="pick-sector"><h3 style="color:${state.sectors[s].colour}">${U.SECTOR_GLYPH[s] || ''} ${s}</h3>
          ${content.faults.faults.filter((f) => f.sector === s).map((f) => `
            <button class="pf${active.has(f.code) ? ' live' : ''}" data-fire="${f.code}" data-sector="${s}" title="${esc(f.name)}">
              <b>${f.code}</b><span class="nm">${esc(f.name)}</span><span class="rd">${f.round}</span><span class="sv">${U.severityPips(f.severity)}</span>
            </button>`).join('')}
        </div>`).join('')}
      </div>`);
    for (const b of body.querySelectorAll('[data-fire]')) b.addEventListener('click', () => confirmTrigger(b.dataset.fire, b.dataset.sector));
    for (const b of body.querySelectorAll('[data-preset]')) b.addEventListener('click', () => previewPreset(b.dataset.preset));
  }

  function activeFaultCodes() {
    const out = new Set();
    if (!state) return out;
    for (const s of Object.values(state.sectors)) for (const f of s.faults) if (!f.resolved) out.add(f.code);
    return out;
  }

  // -- ADMIN OVERRIDE: current → proposed, a reason, one audit event ----------------

  function askOverride({ title, target, diff = [], extra = '', action, payload = {}, confirmLabel = 'CONFIRM OVERRIDE' }) {
    pendingOverride = { action, payload };
    $('modal-title').textContent = title;
    $('modal-target').textContent = target;
    $('modal-diff').innerHTML = diff.length
      ? `<tr><th></th><th>CURRENT</th><th>PROPOSED</th></tr>${diff.map(([l, b, a]) => `<tr><td>${esc(l)}</td><td>${esc(b)}</td><td class="to">${esc(a)}</td></tr>`).join('')}`
      : '';
    $('modal-extra').innerHTML = extra;
    $('modal-reason').value = '';
    $('modal-confirm').textContent = confirmLabel;
    $('modal').classList.remove('hidden');
    $('modal-reason').focus();
  }
  function closeModal() { $('modal').classList.add('hidden'); pendingOverride = null; }
  $('modal-cancel').addEventListener('click', closeModal);
  $('modal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!pendingOverride) return;
    const reason = $('modal-reason').value.trim();
    if (reason.length < 3) { $('modal-reason').focus(); toast('A short reason is required'); return; }
    const msg = { type: 'admin_override', action: pendingOverride.action, payload: pendingOverride.payload, reason };
    if (pendingOverride.action === 'clear_fault' && $('ovr-pay')) msg.payload = { ...msg.payload, with_reward: $('ovr-pay').checked };
    if (pendingOverride.action === 'reset_run') {
      const typed = ($('rs-typed') ? $('rs-typed').value : '').trim().toUpperCase();
      if (typed !== 'RESET') { toast('Type RESET to confirm'); $('rs-typed').focus(); return; }
      msg.confirm_text = typed;
      msg.payload = { run_id: $('rs-run').value.trim() || undefined, scenario_id: $('rs-scenario').value || undefined };
      lastConfigJson = null;
    }
    send(msg);
    closeModal();
  });

  function askReset() {
    $('more').classList.add('hidden');
    const scenarios = (content && content.scenarios) || [];
    askOverride({
      title: 'RESET SESSION',
      target: state ? `RUN ${state.run_id} · ${state.scenario_name}` : 'RUN',
      extra: `<div class="hint">Wipes every sector, clock, fault, request, transfer, board and hand and starts a new run. The current log is kept under a dated name. This cannot be undone.</div>
        <label class="modal-field">NEW RUN ID<input type="text" id="rs-run" value="${esc(`${new Date().toISOString().slice(0, 10)}-c2`)}" autocomplete="off"></label>
        <label class="modal-field">SCENARIO<select id="rs-scenario"><option value="">keep ${esc(state ? state.scenario_id : 'current')}</option>${scenarios.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.builtin ? '' : ' (saved)'}</option>`).join('')}</select></label>
        <label class="modal-field">TYPE <b>RESET</b> TO CONFIRM<input type="text" id="rs-typed" placeholder="RESET" autocomplete="off"></label>`,
      action: 'reset_run',
      confirmLabel: 'RESET SESSION',
    });
  }

  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
  const invLine = (inv) => RESOURCES.map((r) => `${U.GLYPH[r]}${inv[r] ?? 0}`).join(' ');

  // -- the top bar + session progress ----------------------------------------------

  function renderTopbar() {
    $('run-id').textContent = state.run_id;
    $('scenario-name').textContent = state.scenario_name;
    $('phase-name').textContent = state.phase_name;
    $('mode-pill').textContent = state.mode;
    $('breather-pill').classList.toggle('hidden', !state.breather);
    $('paused-pill').classList.toggle('hidden', !state.paused);
    $('round-value').textContent = `${state.round_number ?? state.round}`;
    $('round-value').title = state.round_name || '';
    $('btn-pause').textContent = state.paused ? 'RESUME' : 'PAUSE';
    $('btn-pause').classList.toggle('on', !!state.paused);
    const rc = state.round_clock;
    $('btn-start').textContent = rc.running ? 'RUNNING' : rc.started && rc.remaining_s > 0 ? 'RESUME' : 'START';
    $('btn-start').disabled = !!rc.running;
    $('btn-end-phase').disabled = !rc.running;
    const next = nextPhase();
    $('btn-next-phase').textContent = next ? `NEXT PHASE › ${next.name.toUpperCase()}${next.round !== state.round ? ` (${next.round})` : ''}` : 'LAST PHASE';
    $('btn-next-phase').disabled = !next;
    $('btn-breather').textContent = state.breather ? 'BREATHER ON' : 'BREATHER';
    $('btn-breather').classList.toggle('on', !!state.breather);
    $('btn-sound').textContent = state.sound_enabled ? '🔊 AUDIO ON' : '🔇 AUDIO OFF';
    $('btn-wall-debrief').textContent = state.wall_debrief ? 'HIDE FROM WALL' : 'SHOW ON WALL';
    const core = $('core-value');
    core.textContent = `${state.core_output}%`;
    core.className = state.core_output < 50 ? 'low' : state.core_output < 70 ? 'warn' : '';
  }

  function renderProgress() {
    const phases = state.phases || [];
    const i = phases.findIndex((p) => p.id === state.phase);
    const html = phases.map((p, k) => `<button class="ph${k < i ? ' done' : k === i ? ' on' : ''}" data-phase="${esc(p.id)}" title="Jump to ${esc(p.name)}"><span class="ph-name">${esc(p.name.replace(/^Round \d+ — /, '').toUpperCase())}</span><span class="ph-round">${esc(p.round)}</span></button>`).join('<span class="ph-arrow">›</span>');
    if ($('progress').dataset.sig !== html) {
      $('progress').dataset.sig = html;
      $('progress').innerHTML = html;
      for (const b of $('progress').querySelectorAll('[data-phase]')) {
        b.addEventListener('click', () => {
          const p = phases.find((x) => x.id === b.dataset.phase);
          if (!p || p.id === state.phase) return;
          if (confirm(`JUMP TO ${p.name.toUpperCase()}${p.round !== state.round ? ` (${p.round})` : ''}? Skipped phases are not played.`)) send({ type: 'set_phase', phase: p.id });
        });
      }
    }
  }

  // -- NEEDS ATTENTION ------------------------------------------------------------

  function renderAttention() {
    const items = state.needs_attention || [];
    $('attn-count').textContent = String(items.length);
    $('attention-panel').classList.toggle('quiet', items.length === 0);
    $('attention-panel').classList.toggle('hot', items.some((a) => a.priority <= 1));
    const shown = attnAll ? items : items.slice(0, 6);
    const html = items.length
      ? shown.map((a, i) => `<button class="attn p${a.priority}" data-attn="${i}">⚠ ${esc(a.text)}</button>`).join('')
      : '<div class="attn-none">✓ NO CRITICAL ISSUES</div>';
    if ($('attention').dataset.sig !== html) {
      $('attention').dataset.sig = html;
      $('attention').innerHTML = html;
      for (const b of $('attention').querySelectorAll('[data-attn]')) {
        b.addEventListener('click', () => {
          const a = shown[Number(b.dataset.attn)];
          if (!a) return;
          if (a.target && a.target.sector) { go('overview'); openSector(a.target.sector); return; }
          if (a.target) go(a.target.view, a.target.tab || null);
        });
      }
    }
    const more = $('attn-more');
    more.classList.toggle('hidden', items.length <= 6);
    more.textContent = attnAll ? 'SHOW FEWER' : `SHOW ALL ${items.length}`;
  }

  // -- the six sector cards: observational --------------------------------------------

  function comFreshness() {
    const rows = Object.values((state.broadcast || {}).rows || {});
    const f = { CURRENT: 0, STALE: 0, OUTDATED: 0, 'NOT UPDATED': 0 };
    for (const r of rows) f[r.freshness] = (f[r.freshness] || 0) + 1;
    return f;
  }

  function capability(code, s) {
    switch (code) {
      case 'MED': { const h = state.healing_capacity || {}; return ['HEALING', `${h.used}/${h.capacity} USED · ${h.remaining} LEFT`, h.remaining ? '' : 'warn']; }
      case 'TRN': { const c = state.transfer_capacity || {}; return ['APPROVALS', `${c.used}/${c.capacity} USED · ${c.remaining} LEFT`, c.remaining ? '' : 'warn']; }
      case 'AGR': { const a = state.agr || {}; return ['INTERVENTION', a.used ? `USED · ${a.selected}` : 'READY', a.used ? 'ok' : '']; }
      case 'COM': { const f = comFreshness(); const bad = f.OUTDATED + f['NOT UPDATED']; return ['REPORTS', `${f.CURRENT} CURRENT · ${f.STALE} STALE · ${bad} OUTDATED/NOT UPDATED`, bad ? 'warn' : '']; }
      default: {
        const ro = s.round_output;
        if (!ro) return ['ROUND OUTPUT', 'NO OUTPUT LINE', ''];
        return ['ROUND OUTPUT', ro.used ? `USED · ${invLine(ro.added || {})}` : ro.available ? 'READY' : 'NOT AVAILABLE', ro.used ? 'ok' : ro.available ? '' : 'warn'];
      }
    }
  }

  function renderSectors() {
    const html = Object.entries(state.sectors).map(([code, s]) => {
      const live = s.faults.filter((f) => !f.resolved);
      const word = s.status_word || s.status;
      const [capLabel, capText, capCls] = capability(code, s);
      const short = s.upkeep_status === 'SHORTFALL';
      return `<article class="sec ${word}" data-sector="${code}">
        <div class="sec-head">
          <span class="sec-code" style="color:${s.colour}">${U.SECTOR_GLYPH[code] || ''} ${code}</span>
          <span class="sec-name">${esc(s.name.toUpperCase())}</span>
          <span class="sec-status ${word}">${word}</span>
        </div>
        <div class="sec-int"><b>${Math.round(s.integrity)}%</b><span class="sec-int-label">HEALTH</span>
          <div class="bar ${U.integrityClass(s.integrity)}"><i style="width:${Math.max(0, s.integrity)}%"></i></div></div>
        <div class="sec-row"><span class="k">REAL INVENTORY</span><span class="v sec-res">${RESOURCES.map((r) => `<span class="${s.low[r] ? 'low' : ''}">${U.GLYPH[r]}${s.inventory[r]}</span>`).join('')}</span></div>
        <div class="sec-row"><span class="k">WORKERS</span><span class="v">${s.workforce.available}/${s.workforce.total} AVAILABLE${s.workforce.injured ? ` · <b class="warn">${s.workforce.injured} INJURED</b>` : ''}${s.workforce.loaned ? ` · ${s.workforce.loaned} LOANED` : ''}</span></div>
        <div class="sec-row"><span class="k">FAULTS</span><span class="v ${live.length ? 'warn' : ''}">${live.length} ACTIVE${live.length ? ` · ${live.map((f) => f.code).join(' ')}` : ''}</span></div>
        <div class="sec-row"><span class="k">NEXT UPKEEP</span><span class="v ${short ? 'bad' : 'ok'}">${short ? `⚠ SHORTFALL · MISSING ${esc(Object.entries(s.upkeep_short || {}).map(([k, v]) => `${v} ${RES_NAME[k] || k}`).join(', '))}` : 'READY'}</span></div>
        <div class="sec-row"><span class="k">${capLabel}</span><span class="v ${capCls}">${esc(capText)}</span></div>
        <button class="sec-open" data-open="${code}">OPEN SECTOR</button>
      </article>`;
    }).join('');
    if ($('sectors').dataset.sig !== html) {
      $('sectors').dataset.sig = html;
      $('sectors').innerHTML = html;
      for (const b of $('sectors').querySelectorAll('[data-open]')) b.addEventListener('click', () => openSector(b.dataset.open));
    }
  }

  // -- the sector drawer: one level deeper ----------------------------------------------

  function openSector(code, { admin = false } = {}) {
    drawerSector = code;
    drawerAdmin = admin;
    $('drawer').classList.remove('hidden');
    renderDrawer();
    $('drawer-body').scrollTop = 0;
  }
  $('drawer-close').addEventListener('click', () => { drawerSector = null; $('drawer').classList.add('hidden'); });

  function renderDrawer() {
    if (!drawerSector || !state.sectors[drawerSector]) return;
    const code = drawerSector;
    const s = state.sectors[code];
    const word = s.status_word || s.status;
    const live = s.faults.filter((f) => !f.resolved);
    const b = state.broadcast || { rows: {} };
    const rep = b.rows[code] || {};
    const [capLabel, capText] = capability(code, s);
    const waiting = (state.healing || []).filter((h) => h.sector === code && h.status === 'WAITING_FOR_MED');
    $('drawer-title').textContent = `${U.SECTOR_GLYPH[code] || ''} ${code} · ${s.name.toUpperCase()}`;
    $('drawer-sub').textContent = `${Math.round(s.integrity)}% HEALTH · ${word}`;

    const faultRow = (f) => `<div class="dr-fault${f.locked_until_s > 0 ? ' locked' : ''}">
        <div class="dr-fault-top"><b>${esc(f.code)}</b> ${esc(f.name)} <span class="hint">${U.severityPips(f.severity)} · −${f.decay_per_min}/min · ${f.locked_until_s > 0 ? `LOCKED ${f.locked_until_s}s` : esc(f.status)}${f.paused ? ' · DECAY PAUSED' : ''} · ${f.attempts} attempt${f.attempts === 1 ? '' : 's'}</span></div>
        <div class="hint">${f.reward ? `Reward: ${esc(typeof f.reward === 'string' ? f.reward : f.reward.text || JSON.stringify(f.reward))}${f.reward_claimed ? ' (claimed)' : ''}` : 'No reward'}</div>
        ${faultDebug ? `<div class="dr-debug">answer ${esc(f.valid_codes.length ? f.valid_codes.join(' / ') : 'NONE — ghost, clear by hand')} · crew ${f.crew_required ?? '—'} · materials ${esc(Object.entries(f.resources_required || {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'none')}${f.flavour ? `<br>${esc(f.flavour)}` : ''}</div>` : ''}
        <div class="row">
          <button data-ovr-clear="${esc(f.code)}" class="danger">FORCE RESOLVE</button>
          <button data-ovr-fast="${esc(f.code)}">DOUBLE DECAY</button>
          <button data-ovr-pause="${esc(f.code)}">${f.paused ? 'RESUME DECAY' : 'PAUSE DECAY'}</button>
        </div>
      </div>`;

    const html = `
      <section class="dr-sec"><h4>CURRENT STATE</h4>
        <div class="dr-state"><b class="${U.integrityClass(s.integrity)}">${Math.round(s.integrity)}%</b><span>${word}${s.brownout_by ? ` · brownout by ${esc(s.brownout_by)}` : ''}</span></div>
        <div class="bar ${U.integrityClass(s.integrity)}"><i style="width:${Math.max(0, s.integrity)}%"></i></div>
      </section>
      <section class="dr-sec"><h4>INVENTORY <span class="hint">real vs COM-reported — never substituted</span></h4>
        <table class="dr-table"><tr><th></th><th>REAL</th><th>COM REPORTED</th></tr>
        ${RESOURCES.map((r) => `<tr><td>${U.GLYPH[r]} ${RES_NAME[r]}</td><td class="${s.low[r] ? 'bad' : ''}">${s.inventory[r]}</td><td class="dim">${rep[r] ?? '—'}</td></tr>`).join('')}
        </table>
        <div class="hint">LAST COM UPDATE: ${rep.round_number != null ? `ROUND ${rep.round_number}` : 'NEVER'} · ${esc(rep.freshness || 'NOT UPDATED')}</div>
      </section>
      <section class="dr-sec"><h4>WORKERS</h4>
        <div class="dr-kv">${[['AVAILABLE', s.workforce.available], ['TOTAL', s.workforce.total], ['ACTIVE', s.workforce.active], ['INJURED', s.workforce.injured], ['LOANED OUT', s.workforce.loaned], ['BORROWED', s.workforce.borrowed]].map(([k, v]) => `<span><em>${k}</em>${v}</span>`).join('')}</div>
        ${waiting.length ? `<div class="hint">${waiting.length} injured waiting for Medical: ${esc(waiting.map((h) => h.worker_label).join(', '))}</div>` : ''}
      </section>
      <section class="dr-sec"><h4>ACTIVE FAULTS <span class="count">${live.length}</span> <button class="ghost tiny" id="dr-debug">${faultDebug ? 'HIDE DEBUG DETAILS' : 'VIEW DEBUG DETAILS'}</button></h4>
        ${live.map(faultRow).join('') || '<div class="hint">None active.</div>'}
        <div class="row"><button id="dr-trigger">TRIGGER FAULT HERE…</button></div>
      </section>
      <section class="dr-sec"><h4>ROUND CAPABILITY</h4>
        <div class="dr-kv"><span><em>${capLabel}</em>${esc(capText)}</span><span><em>NEXT UPKEEP</em>${s.upkeep_status === 'SHORTFALL' ? `⚠ SHORTFALL · missing ${esc(Object.entries(s.upkeep_short || {}).map(([k, v]) => `${v} ${k}`).join(', '))}` : 'READY'} (${esc(Object.entries(s.upkeep_delivery || {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'none')})</span></div>
      </section>
      <details class="override-box dr-admin"${drawerAdmin ? ' open' : ''}><summary>ADMIN ACTIONS <span class="hint">direct state changes — each asks why and is logged</span></summary>
        <div class="dr-ovr">
          <div class="dr-ovr-row"><em>HEALTH</em>
            <button data-ovr-int="-10">−10 HEALTH</button><button data-ovr-int="-5">−5</button><button data-ovr-int="5">+5</button><button data-ovr-int="10">+10 HEALTH</button>
            <input type="number" id="dr-int-set" min="0" max="100" value="${Math.round(s.integrity)}" class="short"><button id="dr-int-go">SET</button>
          </div>
          <div class="dr-ovr-row"><em>INVENTORY</em>${RESOURCES.map((r) => `<span class="stepper"><span class="n">${U.GLYPH[r]} ${r}</span><button data-ovr-inv="${r}" data-d="-1">−</button><b>${s.inventory[r]}</b><button data-ovr-inv="${r}" data-d="1">+</button></span>`).join('')}</div>
          <div class="dr-ovr-row"><em>WORKERS</em>
            <span class="stepper"><span class="n">active</span><button data-ovr-wf="-1">−</button><b>${s.workforce.active}</b><button data-ovr-wf="1">+</button></span>
            <span class="stepper"><span class="n">injured</span><button data-ovr-inj="-1">−</button><b>${s.workforce.injured}</b><button data-ovr-inj="1">+</button></span>
            <button id="dr-recover" ${s.workforce.injured ? '' : 'disabled'}>RECOVER 1</button>
          </div>
          <div class="dr-ovr-row"><em>STATUS</em>
            <button id="dr-brown">${s.status === 'BROWNOUT' ? 'RESTORE FROM BROWNOUT' : 'BROWNOUT'}</button>
            <button id="dr-dark" class="${s.status === 'DARK' ? '' : 'danger'}">${s.status === 'DARK' ? 'RESTORE FROM DARK' : 'FORCE DARK'}</button>
            ${s.round_output && !s.round_output.used ? '<button id="dr-output">GENERATE OUTPUT FOR TABLE</button>' : ''}
          </div>
        </div>
      </details>`;
    const body = $('drawer-body');
    if (body.dataset.sig === html) return;
    body.dataset.sig = html;
    body.innerHTML = html;

    const on = (sel, fn) => { for (const b of body.querySelectorAll(sel)) b.addEventListener('click', () => fn(b)); };
    const target = `${code} · ${s.name.toUpperCase()}`;
    body.querySelector('#dr-debug').addEventListener('click', () => { faultDebug = !faultDebug; renderDrawer(); renderFaults(); });
    body.querySelector('#dr-trigger').addEventListener('click', () => pickFault(code));
    const admin = body.querySelector('.dr-admin');
    admin.addEventListener('toggle', () => { drawerAdmin = admin.open; });
    on('[data-ovr-int]', (b) => {
      const d = Number(b.dataset.ovrInt);
      askOverride({ title: 'ADJUST HEALTH', target, diff: [['HEALTH', `${Math.round(s.integrity)}%`, `${clamp(s.integrity + d)}%`]], action: 'adjust_integrity', payload: { sector: code, delta: d } });
    });
    body.querySelector('#dr-int-go').addEventListener('click', () => {
      const v = clamp(Number(body.querySelector('#dr-int-set').value));
      askOverride({ title: 'SET HEALTH', target, diff: [['HEALTH', `${Math.round(s.integrity)}%`, `${v}%`]], action: 'set_integrity', payload: { sector: code, value: v } });
    });
    on('[data-ovr-inv]', (b) => {
      const r = b.dataset.ovrInv; const d = Number(b.dataset.d);
      askOverride({ title: 'ADJUST INVENTORY', target, diff: [[RES_NAME[r], s.inventory[r], Math.max(0, s.inventory[r] + d)]], action: 'adjust_inventory', payload: { sector: code, delta: { [r]: d } } });
    });
    on('[data-ovr-wf]', (b) => {
      const d = Number(b.dataset.ovrWf);
      askOverride({ title: 'CHANGE WORKER STATE', target, diff: [['ACTIVE WORKERS', s.workforce.active, Math.max(0, s.workforce.active + d)]], action: 'adjust_workforce', payload: { sector: code, active: d, injured: 0 } });
    });
    on('[data-ovr-inj]', (b) => {
      const d = Number(b.dataset.ovrInj);
      askOverride({ title: 'CHANGE WORKER STATE', target, diff: [['INJURED WORKERS', s.workforce.injured, Math.max(0, s.workforce.injured + d)]], action: 'adjust_workforce', payload: { sector: code, active: 0, injured: d } });
    });
    body.querySelector('#dr-recover').addEventListener('click', () => {
      askOverride({ title: 'RECOVER A WORKER BY HAND', target, diff: [['INJURED', s.workforce.injured, s.workforce.injured - 1], ['ACTIVE', s.workforce.active, s.workforce.active + 1]], extra: '<div class="hint">Medical Bay normally does this. Recovering by hand bypasses MED and its allowance.</div>', action: 'recover_worker', payload: { sector: code, count: 1 } });
    });
    body.querySelector('#dr-brown').addEventListener('click', () => {
      const to = s.status === 'BROWNOUT' ? 'ACTIVE' : 'BROWNOUT';
      if (confirm(`${to === 'BROWNOUT' ? 'BROWNOUT' : 'RESTORE'} ${code}? A brownout halves output and upkeep and holds workers back.`)) send({ type: 'set_status', sector: code, value: to });
    });
    body.querySelector('#dr-dark').addEventListener('click', () => {
      const to = s.status === 'DARK' ? 'ACTIVE' : 'DARK';
      askOverride({ title: to === 'DARK' ? 'FORCE DARK' : 'RESTORE FROM DARK', target, diff: [['STATUS', s.status, to]], extra: to === 'DARK' ? '<div class="hint">Its console locks and its people become refugees.</div>' : '', action: 'set_status', payload: { sector: code, value: to } });
    });
    const out = body.querySelector('#dr-output');
    if (out) out.addEventListener('click', () => askOverride({ title: 'GENERATE OUTPUT FOR TABLE', target, diff: [['ROUND OUTPUT', 'NOT GENERATED', `+${esc(invLine(s.round_output.amount))}`]], action: 'generate_output', payload: { sector: code } }));
    on('[data-ovr-clear]', (b) => {
      const f = live.find((x) => x.code === b.dataset.ovrClear);
      askOverride({ title: 'FORCE RESOLVE FAULT', target: `${f.code} · ${f.name} @ ${code}`, diff: [['FAULT', 'ACTIVE', 'CLEARED'], ['MATERIALS', 'in the tray', 'not consumed'], ['REWARD', f.reward ? f.reward.text : '—', 'NONE unless ticked']], extra: '<label class="modal-field"><input type="checkbox" id="ovr-pay"> ALSO PAY THE FAULT\'S REWARD (logged as an override)</label>', action: 'clear_fault', payload: { sector: code, fault_code: f.code, reason: 'facilitator cleared' } });
    });
    on('[data-ovr-fast]', (b) => {
      const f = live.find((x) => x.code === b.dataset.ovrFast);
      askOverride({ title: 'DOUBLE FAULT DECAY', target: `${f.code} @ ${code}`, diff: [['DECAY / MIN', f.decay_per_min, Math.round(f.decay_per_min * 2 * 10) / 10]], action: 'accelerate_fault', payload: { sector: code, fault_code: f.code, decay_per_min: Math.round(f.decay_per_min * 2 * 10) / 10 } });
    });
    on('[data-ovr-pause]', (b) => {
      const f = live.find((x) => x.code === b.dataset.ovrPause);
      askOverride({ title: f.paused ? 'RESUME FAULT DECAY' : 'PAUSE FAULT DECAY', target: `${f.code} @ ${code}`, diff: [['DECAY', f.paused ? 'PAUSED' : 'RUNNING', f.paused ? 'RUNNING' : 'PAUSED']], action: 'pause_fault', payload: { sector: code, fault_code: f.code, paused: !f.paused } });
    });
  }

  // -- system summaries on the overview --------------------------------------------------

  function renderSummaries() {
    const live = [];
    for (const s of Object.values(state.sectors)) for (const f of s.faults) if (!f.resolved) live.push({ ...f, sector: s.code });
    $('sum-faults').innerHTML = live.length
      ? `<b>${live.length} ACTIVE</b>${live.slice(0, 4).map((f) => `<div>${esc(f.sector)} ${esc(f.code)} <span class="hint">−${f.decay_per_min}/min</span></div>`).join('')}${live.length > 4 ? `<div class="hint">+${live.length - 4} more</div>` : ''}`
      : '<b class="ok">NONE ACTIVE</b>';
    const tc = state.transfer_capacity || {};
    const pend = (state.transfers || []).filter((t) => t.status === 'PENDING_TRN_APPROVAL').length;
    const open = (state.requests || []).filter((r) => r.status === 'REQUESTED').length;
    $('sum-transfers').innerHTML = `<b class="${tc.remaining ? '' : 'warn'}">${tc.used}/${tc.capacity} APPROVALS USED</b><div>${pend} waiting for TRN</div><div>${open} waiting for a supplier</div>`;
    const wf = Object.values(state.sectors).reduce((a, s) => ({ avail: a.avail + s.workforce.available, total: a.total + s.workforce.total, injured: a.injured + s.workforce.injured }), { avail: 0, total: 0, injured: 0 });
    const hc = state.healing_capacity || {};
    $('sum-workforce').innerHTML = `<b>${wf.avail}/${wf.total} AVAILABLE</b><div class="${wf.injured ? 'warn' : ''}">${wf.injured} injured</div><div>MED ${hc.used}/${hc.capacity} heals used</div>`;
    const f = comFreshness();
    const a = (state.broadcast || {}).announcement;
    $('sum-com').innerHTML = `<b class="${f.OUTDATED + f['NOT UPDATED'] ? 'warn' : ''}">${f.CURRENT} CURRENT · ${f.STALE} STALE · ${f.OUTDATED + f['NOT UPDATED']} OUTDATED/NOT UPDATED</b><div>${a ? `Broadcast: ${esc(a.headline)}` : 'No broadcast on the wall'}</div>`;
    const agr = state.agr || {};
    $('sum-agr').innerHTML = `<b class="${agr.used ? 'ok' : ''}">${agr.used ? 'INTERVENTION USED' : 'INTERVENTION READY'}</b><div>${agr.round || '—'} · ${(agr.offered || []).length} cards dealt${agr.used ? ` · ${esc(agr.selected)}` : ''}</div>`;
  }

  // -- EVENTS: faults (ACTIVE · SCHEDULED · LIBRARY) ---------------------------------------

  function renderFaults() {
    for (const b of $('fault-views').querySelectorAll('[data-fv]')) b.classList.toggle('on', b.dataset.fv === faultView);
    for (const p of document.querySelectorAll('#sub-faults .fv')) p.classList.toggle('on', p.id === `fv-${faultView}`);
    const live = [];
    for (const s of Object.values(state.sectors)) for (const f of s.faults) if (!f.resolved) live.push({ ...f, sector: s.code });
    $('fv-active-n').textContent = String(live.length);
    $('fv-sched-n').textContent = String((state.scheduled || []).length);
    const rb = state.reward_budget || {};
    $('fault-budget').textContent = `MATERIALS ISSUED ${rb.issued ?? 0} · CONSUMED ${rb.consumed ?? 0} · REWARD STOCK RESERVED ${rb.reserved ?? 0} + GENERATED ${rb.generated ?? 0} / ${rb.max ?? 1} ALLOWED · ACTIVE SECTORS ${(state.active_sectors || []).join(' ')}`;
    const html = live.length ? `<div class="fa-head"><span></span><span>SECTOR</span><span>FAULT</span><span>DECAY</span><span>STATUS</span><span>REWARD</span><span><button class="ghost tiny" id="fa-debug">${faultDebug ? 'HIDE DEBUG DETAILS' : 'VIEW DEBUG DETAILS'}</button></span></div>`
      + live.map((f) => `<div class="fa-row${f.locked_until_s > 0 ? ' locked' : ''}" data-id="${esc(f.id)}">
          <span class="hint">${esc(f.id)}</span><span><b>${esc(f.sector)}</b></span><span><b>${esc(f.code)}</b> ${esc(f.name)}</span>
          <span>−${f.decay_per_min}/min${f.paused ? ' · PAUSED' : ''}</span>
          <span>${f.locked_until_s > 0 ? `LOCKED ${f.locked_until_s}s` : esc(f.status)} · ${f.attempts} att</span>
          <span class="hint">${f.reward ? esc(typeof f.reward === 'string' ? f.reward : f.reward.text || '') : '—'}${f.reward_claimed ? ' ✓' : ''}</span>
          <span class="fa-acts"><button data-fa-open="${esc(f.sector)}">OPEN SECTOR</button></span>
          ${faultDebug ? `<div class="dr-debug fa-debug">answer ${esc(f.valid_codes.length ? f.valid_codes.join(' / ') : 'NONE — ghost')} · crew ${f.crew_required ?? '—'} · materials ${esc(Object.entries(f.resources_required || {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'none')}${f.procedure ? ` · ${esc(String(f.procedure).slice(0, 120))}` : ''}${f.flavour ? `<br>${esc(f.flavour)}` : ''}</div>` : ''}
        </div>`).join('')
      : '<div class="hint">No active faults. Trigger one from the LIBRARY, a preset wave, or the pressure dial.</div>';
    if ($('faults-active').dataset.sig !== html) {
      $('faults-active').dataset.sig = html;
      $('faults-active').innerHTML = html;
      const dbg = $('faults-active').querySelector('#fa-debug');
      if (dbg) dbg.addEventListener('click', () => { faultDebug = !faultDebug; renderFaults(); renderDrawer(); });
      for (const b of $('faults-active').querySelectorAll('[data-fa-open]')) b.addEventListener('click', () => openSector(b.dataset.faOpen));
    }
  }

  function renderPresets() {
    const presets = (state.scenario && state.scenario.fault_presets) || [];
    const html = presets.map((p) => `<button data-preset="${esc(p.id)}">▶ ${esc(p.name)} <span class="hint">${p.items.length} faults · ${esc([...new Set(p.items.map((i) => i.sector))].join(' '))}</span></button>`).join('') || '<div class="hint">None in this scenario.</div>';
    if ($('fault-presets').dataset.sig !== html) {
      $('fault-presets').dataset.sig = html;
      $('fault-presets').innerHTML = html;
      for (const b of $('fault-presets').querySelectorAll('button')) b.addEventListener('click', () => previewPreset(b.dataset.preset));
    }
    const sc = state.scheduled || [];
    const sh = sc.map((s) => `<div class="sc"><b>${U.mmss(s.in_s)}</b> ${s.kind === 'fault' ? `${esc(s.fault_code)} → ${esc(s.sector)}` : `event ${esc(s.event_id)}${s.target ? ' → ' + esc(s.target) : ''}`} <span class="hint">${esc(s.source || '')}</span><button data-cancel="${esc(s.id)}">CANCEL</button></div>`).join('') || '<div class="hint">Nothing queued.</div>';
    if ($('scheduled').dataset.sig !== sh) {
      $('scheduled').dataset.sig = sh;
      $('scheduled').innerHTML = sh;
      for (const b of $('scheduled').querySelectorAll('[data-cancel]')) b.addEventListener('click', () => send({ type: 'cancel_scheduled', id: b.dataset.cancel }));
    }
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
          <span class="tags">${tags.join('')}<button data-fire="${f.code}" data-sector="${f.sector}"${active.has(f.code) ? ' disabled' : ''}>${active.has(f.code) ? 'LIVE' : 'TRIGGER'}</button></span>
        </div>`;
    }).join('') || '<div class="hint">No faults match.</div>';
    for (const btn of $('injects').querySelectorAll('button[data-fire]')) {
      btn.addEventListener('click', () => confirmTrigger(btn.dataset.fire, btn.dataset.sector));
    }
  }

  // -- EVENTS: timeline ----------------------------------------------------------------

  function describe(item) {
    switch (item.kind) {
      case 'fault': return `${item.fault_code} → ${item.sector}`;
      case 'event': return `EVENT ${item.event_id}${item.sector ? ' → ' + item.sector : ''}`;
      case 'council': return 'CALL COUNCIL';
      case 'core': return `CORE OUTPUT → ${item.value}%`;
      case 'announce': return `ANNOUNCE: ${item.text}`;
      case 'alert': return `ALERT: ${item.text}`;
      case 'cycle': return 'PROCESS UPKEEP';
      default: return item.kind;
    }
  }

  function renderTimeline() {
    $('tl-round').textContent = `${state.round} — ${state.round_name}`;
    const items = state.timeline || [];
    let ready = 0;
    const html = items.map((it) => {
      if (it.status === 'READY') ready += 1;
      return `<div class="tl ${it.status}">
        <span class="off">${U.mmss(it.offset_s)}</span>
        <span class="what"><b>${esc(describe(it))}</b>${it.note ? `<span class="nt">${esc(it.note)}</span>` : ''}<span class="md">${it.mode} · ${it.status === 'READY' ? 'READY TO FIRE' : it.status}${it.result ? ' · ' + esc(it.result) : ''}</span></span>
        <span class="acts">${it.status === 'PENDING' || it.status === 'READY'
          ? `<button class="fire" data-fire="${it.id}">${it.status === 'READY' ? 'FIRE NOW' : 'FIRE'}</button><button data-delay="${it.id}">+2:00</button><button data-skip="${it.id}">SKIP</button>` : ''}</span>
      </div>`;
    }).join('') || '<div class="hint">No script for this round. Author one in the scenario file under timelines.</div>';
    if ($('timeline').dataset.sig !== html) {
      $('timeline').dataset.sig = html;
      $('timeline').innerHTML = html;
      for (const b of $('timeline').querySelectorAll('[data-fire]')) b.addEventListener('click', () => send({ type: 'timeline_fire', id: b.dataset.fire }));
      for (const b of $('timeline').querySelectorAll('[data-skip]')) b.addEventListener('click', () => send({ type: 'timeline_skip', id: b.dataset.skip }));
      for (const b of $('timeline').querySelectorAll('[data-delay]')) b.addEventListener('click', () => send({ type: 'timeline_delay', id: b.dataset.delay, seconds: 120 }));
    }
    const tab = document.querySelector('.subnav[data-for="events"] [data-sub="timeline"]');
    tab.classList.toggle('attn', ready > 0);
    tab.textContent = ready ? `TIMELINE (${ready})` : 'TIMELINE';
  }

  // -- EVENTS: pressure ------------------------------------------------------------------

  for (const btn of $('dial').querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      const k = btn.dataset.dial;
      if (k === 'fault' || k === 'second') return pickFault();
      if (k === 'injure') return quick('injure');
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
    const html = events.map((e) => `<div class="ev">
        <span class="nm">${esc(e.name)}</span>
        ${e.targets === 'PICK' ? `<select data-target="${esc(e.id)}">${codes.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>` : `<span class="hint">${Array.isArray(e.targets) ? e.targets.join('+') : e.targets}</span>`}
        <button data-event="${esc(e.id)}">FIRE</button>
        <span class="ds">${esc(e.description || '')} · ${esc(e.visibility || 'ADMIN_ONLY')}</span>
      </div>`).join('');
    if ($('events').dataset.sig !== html) {
      $('events').dataset.sig = html;
      $('events').innerHTML = html;
      for (const b of $('events').querySelectorAll('[data-event]')) {
        b.addEventListener('click', () => {
          const sel = $('events').querySelector(`[data-target="${b.dataset.event}"]`);
          send({ type: 'fire_event', event_id: b.dataset.event, target: sel ? sel.value : null });
        });
      }
    }
    const eff = state.effects || [];
    $('effects').innerHTML = eff.map((e) => `<div class="ef"><b>${esc(e.kind)}</b> ${esc(e.target)} ${e.remaining_s != null ? `<span data-cd-effect="${e.id}">${U.mmss(e.remaining_s)}</span>` : ''}${e.cycles_remaining != null ? `${e.cycles_remaining} round(s)` : ''} <span class="hint">${esc(e.source || '')}</span></div>`).join('') || '<div class="hint">None.</div>';
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

  // -- EVENTS: council ----------------------------------------------------------------------

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
    document.querySelector('.subnav[data-for="events"] [data-sub="council"]').classList.toggle('attn', c.active || c.no_order);
    if (!$('order-pick').children.length) renderOrder();
  }

  // -- CITY SYSTEMS: transfers -------------------------------------------------------------

  const paper = (t) => `${U.GLYPH[t.resource] || ''} ${t.amount} ${t.resource === 'workers' ? (t.amount === 1 ? 'WORKER' : 'WORKERS') : (RES_NAME[t.resource] || t.resource)}`;
  const stamp = (t) => new Date(t.requested_at || t.created_at).toLocaleTimeString([], { hour12: false });

  function renderTransfersView() {
    const tc = state.transfer_capacity || {};
    const transfers = state.transfers || [];
    const requests = state.requests || [];
    const pending = transfers.filter((t) => t.status === 'PENDING_TRN_APPROVAL');
    const open = requests.filter((r) => r.status === 'REQUESTED');
    const declined = transfers.filter((t) => ['DECLINED_BY_TRN', 'EXPIRED'].includes(t.status)).length + requests.filter((r) => ['DECLINED_BY_SUPPLIER', 'EXPIRED'].includes(r.status)).length;
    $('tr-summary').innerHTML = [
      [pending.length, 'PENDING TRN APPROVALS', pending.length && !tc.remaining ? 'warn' : ''],
      [`${tc.used}/${tc.capacity}`, `APPROVED THIS ${String(tc.basis || 'round').toUpperCase()}`, ''],
      [open.length, 'WAITING FOR SUPPLIER', ''],
      [declined, 'DECLINED / EXPIRED', ''],
    ].map(([v, l, c]) => `<div class="stat ${c}"><b>${v}</b><span>${l}</span></div>`).join('');

    const row = (t, title, meta, acts = []) => `<div class="tr"><div class="who"><b>${title}</b><br><span class="st">${meta}</span></div><div class="acts">${acts.join('')}</div></div>`;
    $('transfers').innerHTML = pending.map((t) => row(t, `${esc(t.id)} · ${esc(t.from)} → ${esc(t.to)} · ${paper(t)}`,
      `${TR_WORD[t.status] || t.status}${t.chit_confirmed ? ' · CHIT ✓' : ' · CHIT NOT CONFIRMED'} · ${stamp(t)}${t.request_id ? ` · from ${esc(t.request_id)}` : ''}`)).join('') || '<div class="hint">Nothing waiting for Transport.</div>';
    $('requests').innerHTML = open.map((r) => row(r, `${esc(r.id)} · ${esc(r.requester)} asked ${esc(r.supplier)} · ${paper(r)}`, `${REQ_WORD[r.status] || r.status} · ${stamp(r)}`)).join('') || '<div class="hint">No open requests.</div>';

    // The override lists: every open item, with the facilitator's hand on it.
    const ovrT = transfers.filter((t) => ['PENDING_TRN_APPROVAL', 'APPROVED'].includes(t.status)).map((t) => row(t, `${esc(t.id)} · ${esc(t.from)} → ${esc(t.to)} · ${paper(t)}`, `${TR_WORD[t.status] || t.status}${t.chit_confirmed ? ' · CHIT ✓' : ''}`, [
      `<button data-ovr-chit="${esc(t.id)}" data-on="${t.chit_confirmed ? '0' : '1'}">CHIT ${t.chit_confirmed ? '✗ WITHDRAW' : '✓ CONFIRM'}</button>`,
      t.status === 'PENDING_TRN_APPROVAL' ? `<button data-ovr-approve="${esc(t.id)}" class="danger">FORCE APPROVE</button>` : `<button data-ovr-deliver="${esc(t.id)}">MARK DELIVERED</button>`,
      `<button data-ovr-decline="${esc(t.id)}">DECLINE</button>`,
      `<button data-ovr-cancel="${esc(t.id)}">CANCEL</button>`,
    ])).join('') || '<div class="hint">No open transfers.</div>';
    const ovrR = open.map((r) => row(r, `${esc(r.id)} · ${esc(r.requester)} asked ${esc(r.supplier)} · ${paper(r)}`, REQ_WORD[r.status], [
      `<button data-ovr-fulfil="${esc(r.id)}" class="danger">FULFIL FOR ${esc(r.supplier)}</button>`,
      `<button data-ovr-decreq="${esc(r.id)}">DECLINE</button>`,
      `<button data-ovr-cancelreq="${esc(r.id)}">CANCEL</button>`,
    ])).join('') || '<div class="hint">No open requests.</div>';
    if ($('transfers-ovr').dataset.sig !== ovrT + ovrR) {
      $('transfers-ovr').dataset.sig = ovrT + ovrR;
      $('transfers-ovr').innerHTML = ovrT;
      $('requests-ovr').innerHTML = ovrR;
      const on = (sel, fn) => { for (const b of $('tr-override').querySelectorAll(sel)) b.addEventListener('click', () => fn(b)); };
      const T = (id) => transfers.find((x) => x.id === id);
      const R = (id) => requests.find((x) => x.id === id);
      on('[data-ovr-chit]', (b) => { const t = T(b.dataset.ovrChit); askOverride({ title: 'CONFIRM CHIT FOR TRANSPORT', target: t.id, diff: [['CHIT', t.chit_confirmed ? 'CONFIRMED' : 'NOT CONFIRMED', b.dataset.on === '1' ? 'CONFIRMED' : 'NOT CONFIRMED']], action: 'transfer_chit', payload: { id: t.id, confirmed: b.dataset.on === '1' } }); });
      on('[data-ovr-approve]', (b) => { const t = T(b.dataset.ovrApprove); askOverride({ title: 'FORCE APPROVE TRANSFER', target: `${t.id} · ${t.from} → ${t.to} · ${paper(t)}`, diff: [['STATUS', 'WAITING FOR TRN', 'APPROVED — STOCK MOVES']], extra: '<div class="hint">Lifts Transport\'s allowance and the chit. Never invents stock: a short supplier still refuses.</div>', action: 'transfer_approve', payload: { id: t.id, force: true } }); });
      on('[data-ovr-deliver]', (b) => { const t = T(b.dataset.ovrDeliver); askOverride({ title: 'MARK DELIVERED', target: t.id, diff: [['STATUS', 'APPROVED', 'DELIVERED']], action: 'transfer_update', payload: { id: t.id, status: 'DELIVERED' } }); });
      on('[data-ovr-decline]', (b) => { const t = T(b.dataset.ovrDecline); askOverride({ title: 'DECLINE TRANSFER FOR TRANSPORT', target: t.id, diff: [['STATUS', TR_WORD[t.status], 'TRN DECLINED']], action: 'transfer_decline', payload: { id: t.id } }); });
      on('[data-ovr-cancel]', (b) => { const t = T(b.dataset.ovrCancel); askOverride({ title: 'CANCEL TRANSFER', target: t.id, diff: [['STATUS', TR_WORD[t.status], 'CANCELLED']], action: 'transfer_update', payload: { id: t.id, status: 'CANCELLED' } }); });
      on('[data-ovr-fulfil]', (b) => { const r = R(b.dataset.ovrFulfil); askOverride({ title: 'FULFIL REQUEST FOR THE SUPPLIER', target: `${r.id} · ${r.supplier} → ${r.requester} · ${paper(r)}`, diff: [['REQUEST', 'WAITING FOR SUPPLIER', 'SUPPLIER ACCEPTED — TRANSFER RAISED']], extra: '<div class="hint">Raises the transfer for Transport. Moves nothing; TRN still approves.</div>', action: 'request_fulfill', payload: { id: r.id } }); });
      on('[data-ovr-decreq]', (b) => { const r = R(b.dataset.ovrDecreq); askOverride({ title: 'DECLINE REQUEST FOR THE SUPPLIER', target: r.id, diff: [['REQUEST', 'WAITING FOR SUPPLIER', 'DECLINED']], action: 'request_decline', payload: { id: r.id } }); });
      on('[data-ovr-cancelreq]', (b) => { const r = R(b.dataset.ovrCancelreq); askOverride({ title: 'CANCEL REQUEST', target: r.id, diff: [['REQUEST', 'WAITING FOR SUPPLIER', 'CANCELLED']], action: 'request_cancel', payload: { id: r.id } }); });
    }
  }
  $('btn-tr-add').addEventListener('click', () => {
    const p = { from: $('tr-from').value, to: $('tr-to').value, resource: $('tr-res').value, amount: Number($('tr-amt').value) };
    askOverride({ title: 'RAISE A REQUEST FOR A TABLE', target: `${p.to} asks ${p.from}`, diff: [['REQUEST', 'none', `${p.amount} ${p.resource}`]], action: 'transfer_request', payload: p });
  });
  $('btn-tr-direct').addEventListener('click', () => {
    const p = { from: $('tr-from').value, to: $('tr-to').value, resource: $('tr-res').value, amount: Number($('tr-amt').value) };
    askOverride({ title: 'RAISE A TRANSFER FOR A TABLE', target: `${p.from} → ${p.to}`, diff: [['TRANSFER', 'none', `${p.amount} ${p.resource} · WAITING FOR TRN`]], action: 'transfer_create', payload: p });
  });
  const askResetStamps = () => { const c = state.transfer_capacity || {}; askOverride({ title: 'RESET TRN APPROVALS', target: 'CAPACITY', diff: [['APPROVALS USED', `${c.used}/${c.capacity}`, `0/${c.capacity}`]], action: 'reset_stamps', payload: { which: 'all' } }); };
  const askResetHeals = () => { const h = state.healing_capacity || {}; askOverride({ title: 'RESET MED HEALS', target: 'CAPACITY', diff: [['HEALS USED', `${h.used}/${h.capacity}`, `0/${h.capacity}`]], action: 'reset_heals', payload: {} }); };
  $('btn-reset-stamps').addEventListener('click', askResetStamps);
  $('ovr-reset-stamps').addEventListener('click', askResetStamps);
  $('btn-reset-heals').addEventListener('click', askResetHeals);
  $('ovr-reset-heals').addEventListener('click', askResetHeals);
  $('btn-expire-transfers').addEventListener('click', () => {
    const n = (state.transfers || []).filter((t) => t.status === 'PENDING_TRN_APPROVAL').length;
    askOverride({ title: 'EXPIRE ALL PENDING', target: 'CAPACITY', diff: [['PENDING TRANSFERS', n, 0]], extra: '<div class="hint">Voids every transfer that has not been approved. Delivered ones are untouched.</div>', action: 'expire_transfers', payload: {} });
  });

  // -- CITY SYSTEMS: workforce · MED ---------------------------------------------------------

  function renderWorkforce() {
    const sectors = Object.values(state.sectors);
    const sum = sectors.reduce((a, s) => ({ avail: a.avail + s.workforce.available, total: a.total + s.workforce.total, injured: a.injured + s.workforce.injured, loaned: a.loaned + s.workforce.loaned }), { avail: 0, total: 0, injured: 0, loaned: 0 });
    const hc = state.healing_capacity || {};
    $('wf-summary').innerHTML = [
      [`${sum.avail}/${sum.total}`, 'AVAILABLE', ''], [sum.injured, 'INJURED', sum.injured ? 'warn' : ''], [sum.loaned, 'ON LOAN', ''],
      [`${hc.used}/${hc.capacity}`, `MED HEALS USED · ${hc.remaining} LEFT`, hc.remaining ? '' : 'warn'],
    ].map(([v, l, c]) => `<div class="stat ${c}"><b>${v}</b><span>${l}</span></div>`).join('');
    $('wf-table').innerHTML = `<table class="dr-table"><tr><th>SECTOR</th><th>AVAILABLE</th><th>ACTIVE</th><th>INJURED</th><th>LOANED</th><th>BORROWED</th><th>STATUS</th></tr>
      ${sectors.map((s) => `<tr><td><b>${s.code}</b></td><td>${s.workforce.available}/${s.workforce.total}</td><td>${s.workforce.active}</td><td class="${s.workforce.injured ? 'bad' : ''}">${s.workforce.injured}</td><td>${s.workforce.loaned}</td><td>${s.workforce.borrowed}</td><td>${s.status_word || s.status}</td></tr>`).join('')}</table>`;
    const healing = state.healing || [];
    const waiting = healing.filter((h) => h.status === 'WAITING_FOR_MED');
    const notYet = sectors.filter((s) => s.workforce.injured > waiting.filter((h) => h.sector === s.code).length).map((s) => `${s.code} ${s.workforce.injured - waiting.filter((h) => h.sector === s.code).length}`);
    const row = (h, acts = []) => `<div class="tr${h.status !== 'WAITING_FOR_MED' ? ' closed' : ''}"><div class="who"><b>${esc(h.worker_label)}</b> · home ${esc(h.sector)}<br><span class="st">${HEAL_WORD[h.status] || h.status}${h.still_injured === false ? ' · NO LONGER INJURED' : ''} · ${stamp(h)}</span></div><div class="acts">${acts.join('')}</div></div>`;
    $('healing').innerHTML = healing.slice(0, 12).map((h) => row(h)).join('') + (notYet.length ? `<div class="hint">Injured, not yet put forward to Medical: ${esc(notYet.join(' · '))}</div>` : '') || '<div class="hint">No injured workers.</div>';
    const ovr = waiting.map((h) => row(h, [`<button data-ovr-heal="${esc(h.id)}" class="danger">FORCE HEAL</button>`, `<button data-ovr-decheal="${esc(h.id)}">DECLINE</button>`, `<button data-ovr-cancelheal="${esc(h.id)}">CANCEL</button>`])).join('') || '<div class="hint">Nobody waiting for Medical.</div>';
    if ($('healing-ovr').dataset.sig !== ovr) {
      $('healing-ovr').dataset.sig = ovr;
      $('healing-ovr').innerHTML = ovr;
      const on = (sel, fn) => { for (const b of $('healing-ovr').querySelectorAll(sel)) b.addEventListener('click', () => fn(b)); };
      const H = (id) => healing.find((x) => x.id === id);
      on('[data-ovr-heal]', (b) => { const h = H(b.dataset.ovrHeal); askOverride({ title: 'FORCE HEAL', target: `${h.id} · ${h.worker_label} (${h.sector})`, diff: [['WORKER', 'INJURED · WAITING FOR MEDICAL', 'HEALED']], extra: '<div class="hint">Bypasses Medical\'s allowance. Medical alone heals in normal play.</div>', action: 'heal_worker', payload: { id: h.id, force: true } }); });
      on('[data-ovr-decheal]', (b) => { const h = H(b.dataset.ovrDecheal); askOverride({ title: 'DECLINE HEALING FOR MEDICAL', target: h.id, diff: [['REQUEST', 'WAITING FOR MEDICAL', 'DECLINED']], action: 'heal_decline', payload: { id: h.id } }); });
      on('[data-ovr-cancelheal]', (b) => { const h = H(b.dataset.ovrCancelheal); askOverride({ title: 'CANCEL HEALING REQUEST', target: h.id, diff: [['REQUEST', 'WAITING FOR MEDICAL', 'CANCELLED']], action: 'heal_cancel', payload: { id: h.id } }); });
    }
  }
  $('btn-recover-pick').addEventListener('click', () => pickSector('RECOVER 1 WORKER BY HAND — which sector?', (code) => {
    const s = state.sectors[code];
    askOverride({ title: 'RECOVER A WORKER BY HAND', target: code, diff: [['INJURED', s.workforce.injured, Math.max(0, s.workforce.injured - 1)]], extra: '<div class="hint">Medical Bay normally does this.</div>', action: 'recover_worker', payload: { sector: code, count: 1 } });
  }, (code) => `👤 ${state.sectors[code].workforce.injured} injured`));

  // -- CITY SYSTEMS: COM ----------------------------------------------------------------------

  const BOARD_KEYS = ['power', 'water', 'med', 'parts'];
  let boardBuilt = false;

  function renderCom() {
    const b = state.broadcast;
    if (!b) return;
    const f = comFreshness();
    $('com-summary').innerHTML = [[f.CURRENT, 'CURRENT', 'ok'], [f.STALE, 'STALE', ''], [f.OUTDATED, 'OUTDATED', f.OUTDATED ? 'warn' : ''], [f['NOT UPDATED'], 'NOT UPDATED', f['NOT UPDATED'] ? 'warn' : '']]
      .map(([v, l, c]) => `<div class="stat ${c}"><b>${v}</b><span>${l}</span></div>`).join('');
    $('com-table').innerHTML = `<table class="dr-table com"><tr><th>SECTOR</th><th>REAL INVENTORY</th><th>COM REPORTED</th><th>LAST UPDATE</th><th>FRESHNESS</th></tr>
      ${Object.entries(state.sectors).map(([code, s]) => { const r = b.rows[code] || {}; const rep = r.round_number == null ? '—' : BOARD_KEYS.map((k) => `${U.GLYPH[k]}${r[k] ?? '—'}`).join(' '); return `<tr><td><b>${code}</b></td><td>${invLine(s.inventory)}</td><td class="dim">${rep}</td><td>${r.round_number == null ? '—' : `ROUND ${r.round_number}`}</td><td class="fr-${esc((r.freshness || '').replace(' ', '-'))}">${esc(r.freshness || 'NOT UPDATED')}</td></tr>`; }).join('')}</table>`;
    const a = b.announcement;
    $('ca-ann-now').textContent = a ? `ON THE WALL: ${a.headline} — ${a.message} (ROUND ${a.round_number} · ${a.freshness})` : 'No announcement on the wall.';
    $('ca-round').textContent = `CURRENT ROUND: ${b.round_number}`;
    const host = $('ca-rows');
    const codes = Object.keys(b.rows);
    if (!boardBuilt || host.children.length !== codes.length) {
      boardBuilt = true;
      host.innerHTML = codes.map((code) => `<div class="ca-row" data-code="${code}">
          <b>${code}</b>
          ${BOARD_KEYS.map((k) => `<input type="number" min="0" id="ca-${code}-${k}" value="${b.rows[code][k] ?? ''}" placeholder="${k}" title="${k}">`).join('')}
          <button data-casave="${code}">SAVE AS COM</button>
          <span class="ca-meta"></span>
        </div>`).join('');
      for (const btn of host.querySelectorAll('[data-casave]')) {
        btn.addEventListener('click', () => {
          const code = btn.dataset.casave;
          const values = {};
          for (const k of BOARD_KEYS) { const el = $(`ca-${code}-${k}`); if (el.value !== '') values[k] = Number(el.value); }
          askOverride({ title: "WRITE COM'S BOARD", target: `COM BOARD · ${code}`, diff: BOARD_KEYS.map((k) => [k.toUpperCase(), b.rows[code][k] ?? '—', values[k] ?? '—']), action: 'com_board_set', payload: { row: code, values } });
        });
      }
    }
    for (const code of codes) {
      const row = b.rows[code];
      const meta = host.querySelector(`[data-code="${code}"] .ca-meta`);
      if (meta) meta.textContent = row.round_number === null ? 'NOT UPDATED' : `R${row.round_number} · ${row.freshness}`;
    }
  }
  $('btn-ca-publish').addEventListener('click', () => {
    const headline = $('ca-head').value.trim(); const message = $('ca-msg').value.trim();
    if (!headline && !message) return;
    const a = (state.broadcast || {}).announcement;
    askOverride({ title: 'PUBLISH AN ANNOUNCEMENT AS COM', target: 'COM BOARD', diff: [['HEADLINE', a ? a.headline : '—', headline], ['MESSAGE', a ? a.message : '—', message]], action: 'com_announce', payload: { headline, message } });
  });
  $('btn-ca-clear').addEventListener('click', () => {
    const a = (state.broadcast || {}).announcement;
    askOverride({ title: "CLEAR COM'S ANNOUNCEMENT", target: 'COM BOARD', diff: [['ANNOUNCEMENT', a ? a.headline : '—', 'none']], action: 'com_announce_clear', payload: {} });
  });

  // -- CITY SYSTEMS: AGR ------------------------------------------------------------------------

  function renderAgr() {
    const agr = state.agr;
    if (!agr) return;
    const titles = Object.fromEntries((agr.pool || []).map((c) => [c.id, c]));
    $('agr-summary').innerHTML = [[agr.round || '—', 'ROUND', ''], [agr.used ? 'USED' : 'READY', 'INTERVENTION', agr.used ? 'ok' : ''], [(agr.offered || []).length, 'CARDS DEALT', ''], [agr.reroll_count || 0, 'REROLLS', agr.reroll_count ? 'warn' : '']]
      .map(([v, l, c]) => `<div class="stat ${c}"><b>${v}</b><span>${l}</span></div>`).join('');
    const card = (id, acts = []) => { const c = titles[id] || { title: id, summary: '', target: null }; const isUsed = agr.used && agr.selected === id; return `<div class="tr${agr.used && !isUsed ? ' closed' : ''}"><div class="who"><b>${esc(c.title)}</b> ${isUsed ? '<span class="tag multi">USED</span>' : agr.selected === id ? '<span class="tag">SELECTED</span>' : ''}<br><span class="st">${esc(c.summary)}${c.target ? ` · needs ${c.target.replace('_', ' ')}` : ''}</span></div><div class="acts">${acts.join('')}</div></div>`; };
    $('ca-offer').innerHTML = (agr.offered || []).map((id) => card(id)).join('') || '<div class="hint">No hand dealt.</div>';
    const ovr = (agr.offered || []).map((id) => card(id, agr.used ? [] : [`<button data-force="${esc(id)}" class="danger">FORCE ACTIVATE</button>`])).join('') || '<div class="hint">No hand dealt.</div>';
    if ($('ca-offer-ovr').dataset.sig !== ovr) {
      $('ca-offer-ovr').dataset.sig = ovr;
      $('ca-offer-ovr').innerHTML = ovr;
      for (const btn of $('ca-offer-ovr').querySelectorAll('[data-force]')) {
        btn.addEventListener('click', () => {
          const c = titles[btn.dataset.force] || {};
          const target = {};
          if (c.target === 'sector' || (c.effect && c.effect.type === 'health_lowest')) target.sector = $('ca-target-sector').value;
          if (c.target === 'resource_type') target.resource = $('ca-target-res').value;
          askOverride({ title: 'FORCE ACTIVATE AGR CARD', target: `AGR · ${c.title || btn.dataset.force}`, diff: [['INTERVENTION', 'READY', `USED · ${c.title || btn.dataset.force}${target.sector ? ' → ' + target.sector : ''}${target.resource ? ' · ' + target.resource : ''}`]], extra: '<div class="hint">Plays the card for Agriculture, with the same live checks. AGR alone plays in normal play.</div>', action: 'agr_activate', payload: { card: btn.dataset.force, target: Object.keys(target).length ? target : null, force: true } });
        });
      }
    }
    const sel = $('ca-target-sector');
    const codes = agr.active_sectors || [];
    if (sel.dataset.keys !== codes.join(',')) {
      sel.dataset.keys = codes.join(',');
      sel.innerHTML = codes.map((c) => `<option value="${c}">${c}</option>`).join('');
    }
    const poolHtml = (agr.pool || []).map((c) => `<label class="ca-pool${c.enabled ? '' : ' off'}"><input type="checkbox" data-card="${c.id}" ${c.enabled ? 'checked' : ''}> ${esc(c.title)}</label>`).join('');
    if ($('ca-pool').dataset.sig !== poolHtml) {
      $('ca-pool').dataset.sig = poolHtml;
      $('ca-pool').innerHTML = poolHtml;
      for (const cb of $('ca-pool').querySelectorAll('[data-card]')) {
        cb.addEventListener('change', () => send({ type: 'agr_card_enabled', card: cb.dataset.card, enabled: cb.checked }));
      }
    }
  }
  $('btn-agr-reroll').addEventListener('click', () => {
    const agr = state.agr || {};
    askOverride({ title: 'REROLL AGR HAND', target: 'AGR', diff: [['HAND', (agr.offered || []).join(', ') || '—', 'three new cards']], extra: '<div class="hint">Refused once the round\'s card is used.</div>', action: 'agr_reroll', payload: {} });
  });

  // -- CITY SYSTEMS: core ---------------------------------------------------------------------

  function renderCore() {
    const sum = state.cycle_summary;
    $('core-summary').innerHTML = [[`${state.core_output}%`, 'CORE OUTPUT', state.core_output < 50 ? 'warn' : ''], [state.cycle.number - 1, 'UPKEEP PASSES', ''], [sum ? new Date(sum.t).toLocaleTimeString([], { hour12: false }) : '—', 'LAST PASS', ''], [state.cycle.running ? 'LEGACY TIMER' : 'AT ROUND END', 'UPKEEP DUE', '']]
      .map(([v, l, c]) => `<div class="stat ${c}"><b>${v}</b><span>${l}</span></div>`).join('');
    const presets = (state.config && state.config.core_output_presets) || [100, 90, 80, 70, 60, 50, 40];
    const ph = presets.map((p) => `<button data-p="${p}" class="${state.core_output === p ? 'on' : ''}">${p}%</button>`).join('');
    if ($('core-presets').dataset.sig !== ph) {
      $('core-presets').dataset.sig = ph;
      $('core-presets').innerHTML = ph;
      for (const b of $('core-presets').querySelectorAll('button')) b.addEventListener('click', () => askCore(Number(b.dataset.p)));
    }
    if (document.activeElement !== $('core-input')) $('core-input').value = state.core_output;
    if (document.activeElement !== $('stab-value')) $('stab-value').value = state.city_stability;
    if (document.activeElement !== $('stab-mode')) $('stab-mode').value = state.stability_mode;
    $('stab-hint').textContent = state.stability_mode === 'auto' ? 'auto: integrity + core, minus critical faults, dark, brownout, missed upkeep' : 'manual';
    if (document.activeElement !== $('tel-wtr')) $('tel-wtr').value = state.telemetry.wtr_reservoir_pressure;
    if (sum) {
      const fmt = (o) => Object.entries(o || {}).map(([k, v]) => `${v}${U.GLYPH[k] || k}`).join(' ') || '—';
      $('cycle-summary').innerHTML = `<div class="label">UPKEEP PASS ${sum.cycle}${sum.round ? ' · ' + sum.round : ''} COMPLETE · ${new Date(sum.t).toLocaleTimeString()}${sum.missed_upkeep_count ? ` · <span class="bad">${sum.missed_upkeep_count} missed upkeep</span>` : ''}</div>
        <table><tr><th>SECTOR</th><th>GENERATED</th><th>UPKEEP</th><th>SHORT</th><th>HEALTH</th><th>NOTES</th></tr>
        ${Object.entries(sum.sectors).map(([c, l]) => `<tr><td><b>${c}</b></td><td class="good">${fmt(l.produced)}</td><td>${fmt(l.upkeep)}</td><td class="bad">${fmt(l.shortfall)}</td><td class="${l.integrity_delta < 0 ? 'bad' : ''}">${l.integrity_delta || ''}</td><td>${esc((l.notes || []).join(', '))}${l.recovered ? ` +${l.recovered} recovered` : ''}</td></tr>`).join('')}
        </table>`;
    }
    $('intel').innerHTML = (state.intel || []).map((i) => `<div class="it"><span>${esc(i.label)}</span><input type="text" value="${esc(i.value)}" data-intel="${esc(i.key)}"><button data-intel-set="${esc(i.key)}">SET</button></div>`).join('') +
      `<div class="hint">COM sees these; ${state.com_blind ? 'COM IS BLIND right now' : 'brownout hides the flagged ones'}.</div>`;
    for (const b of $('intel').querySelectorAll('[data-intel-set]')) {
      b.addEventListener('click', () => send({ type: 'set_intel', key: b.dataset.intelSet, value: $('intel').querySelector(`[data-intel="${b.dataset.intelSet}"]`).value }));
    }
  }
  function askCore(value) {
    askOverride({ title: 'SET CORE OUTPUT', target: 'CORE', diff: [['CORE OUTPUT', `${state.core_output}%`, `${clamp(value)}%`]], extra: '<div class="hint">Scales POW\'s output; under 60% the core warning sounds.</div>', action: 'set_core_output', payload: { value: clamp(value) } });
  }
  for (const btn of document.querySelectorAll('[data-core-delta]')) btn.addEventListener('click', () => askCore(state.core_output + Number(btn.dataset.coreDelta)));
  $('btn-core-set').addEventListener('click', () => askCore(Number($('core-input').value)));
  $('btn-stab-set').addEventListener('click', () => askOverride({ title: 'SET CITY STABILITY SCORE', target: 'CORE', diff: [['MODE', state.stability_mode, $('stab-mode').value], ['SCORE', `${state.city_stability}`, $('stab-mode').value === 'manual' ? $('stab-value').value : 'computed']], action: 'set_stability', payload: { mode: $('stab-mode').value, value: Number($('stab-value').value) } }));
  for (const btn of document.querySelectorAll('[data-cycle]')) btn.addEventListener('click', () => askOverride({ title: 'PROCESS UPKEEP NOW', target: 'CORE', diff: [['UPKEEP PASSES', state.cycle.number - 1, state.cycle.number]], extra: '<div class="hint">Charges every sector\'s upkeep now, off schedule, with penalties for a shortfall. The round end will charge it again.</div>', action: 'cycle', payload: { action: 'process' } }));
  $('btn-tel-set').addEventListener('click', () => send({ type: 'set_telemetry', telemetry: { wtr_reservoir_pressure: Number($('tel-wtr').value) } }));

  // -- activity, logs, observations -----------------------------------------------------------

  const feedRow = (e) => `<div class="feed-row ${esc(e.kind)}"><span class="ft">${new Date(e.t).toLocaleTimeString([], { hour12: false })}</span><span class="fx">${esc(e.text)}</span></div>`;

  function renderRecent() {
    $('recent').innerHTML = state.ticker.slice(0, 5).map(feedRow).join('') || '<div class="hint">No events yet.</div>';
  }
  function renderLog() {
    for (const b of $('log-filters').querySelectorAll('[data-lf]')) b.classList.toggle('on', b.dataset.lf === logFilter);
    const kinds = LOG_KINDS[logFilter];
    const rows = state.ticker.filter((e) => !kinds || kinds.includes(e.kind));
    $('log').innerHTML = rows.slice(0, 200).map(feedRow).join('') || '<div class="hint">Nothing of that kind yet.</div>';
  }
  function renderOverrideLog() {
    const rows = state.ticker.filter((e) => e.kind === 'override');
    const html = rows.map(feedRow).join('') || '<div class="hint">No overrides this run.</div>';
    $('override-log').innerHTML = html;
    $('override-log-2').innerHTML = html;
  }

  for (const host of ['obs-tags', 'obs2-tags']) {
    $(host).innerHTML = TAGS.map((t) => `<button data-tag="${t}">${t}</button>`).join('');
    for (const btn of $(host).querySelectorAll('button')) {
      btn.addEventListener('click', () => { obsTag = obsTag === btn.dataset.tag ? null : btn.dataset.tag; renderObs(); });
    }
  }
  function renderObs() {
    for (const host of ['obs-tags', 'obs2-tags']) for (const btn of $(host).querySelectorAll('button')) btn.classList.toggle('on', btn.dataset.tag === obsTag);
    for (const host of ['obs-sectors', 'obs2-sectors']) {
      for (const btn of $(host).querySelectorAll('button')) {
        const on = btn.dataset.sector === obsSector;
        btn.classList.toggle('on', on);
        if (on && state) btn.style.setProperty('--sector-on', state.sectors[btn.dataset.sector].colour);
      }
    }
    if (state) $('obs-list').innerHTML = state.ticker.filter((e) => e.kind === 'obs').map(feedRow).join('') || '<div class="hint">Nothing logged yet.</div>';
  }
  function logObservation(noteId) {
    const note = $(noteId).value.trim();
    if (!note && !obsTag) return;
    send({ type: 'observe', sector: obsSector, tag: obsTag, note });
  }
  $('btn-observe').addEventListener('click', () => logObservation('obs-note'));
  $('btn-observe2').addEventListener('click', () => logObservation('obs2-note'));
  $('obs-note').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); logObservation('obs-note'); } });
  $('obs2-note').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); logObservation('obs2-note'); } });

  // -- settings (••• › SETTINGS) ---------------------------------------------------------------

  const SETTINGS = [
    ['THRESHOLDS'],
    ['critical_below', 'Critical below health', 'n'], ['degraded_below', 'Degraded below health', 'n'],
    ['dark_at', 'Dark at health', 'n'],
    ['resolve_recovery', 'Health on resolve', 'n'], ['lockout_s', 'Console lockout (s)', 'n'],
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
    ['upkeep_on_round_change', 'Upkeep charged when a played round ends', 'b'], ['round_output_manual', 'POW / WTR generate output by button, once a round', 'b'],
    ['cycle_length_s', 'Legacy cycle timer length (s)', 'n'], ['cycle_autostart', 'Legacy cycle timer runs with the round clock', 'b'],
    ['upkeep_shortfall_penalty', 'Penalty per missing upkeep unit', 'n'], ['upkeep_shortfall_penalty_cap', 'Penalty cap per upkeep pass', 'n'],
    ['core_scales_power_production', 'Core output scales POW output', 'b'],
    ['injured_recovery_per_cycle', 'Injured recovered per upkeep pass (MED)', 'n'], ['injured_recovery_costs_med', 'Med supplies per recovery', 'n'],
    ['deliver_on_stamp', 'Stamp delivers immediately', 'b'],
    ['FAULT REWARDS'],
    ['fault_rewards_enabled', 'Faults pay their reward on resolution', 'b'],
    ['show_fault_reward_preview', 'Sector screens show the reward before completion', 'b'],
    ['reward_on_facilitator_force_resolve', 'A facilitator clear of a real fault also pays (logged as an override)', 'b'],
    ['reward_on_false_alarm_clear', 'Clearing a ghost fault (no procedure) pays its reward', 'b'],
    ['reward_health_cap', 'Health cap for reward points', 'n'],
    ['TRANSFERS & HEALING'],
    ['trn_approval_limit', 'Transport approvals per round', 'n'],
    ['med_healing_limit', 'Medical heals per round', 'n'],
    ['transfer_limit_basis', 'Approval allowance counted per', 'e', ['round', 'cycle']],
    ['trn_capacity_per_cycle', 'Transport capacity per cycle (legacy basis)', 'n'],
    ['require_supplier_acceptance', 'Supplier must fulfil before Transport sees it', 'b'],
    ['enforce_supplier_stock', 'Check supplier stock on fulfil and on approval', 'b'],
    ['insufficient_stock_behavior', 'When the supplier is short', 'e', ['refuse', 'legacy_partial_if_supported']],
    ['expire_pending_requests_on_round_change', 'Unanswered requests expire at round change', 'b'],
    ['expire_pending_transfers_on_round_change', 'Unapproved transfers expire at round change', 'b'],
    ['expire_pending_healing_on_round_change', 'Unhealed requests expire at round change', 'b'],
    ['require_physical_transfer_chit', 'Transport must confirm the paper chit', 'b'],
    ['allow_facilitator_force_transfer', 'Facilitator may force an approval', 'b'],
    ['allow_facilitator_force_heal', 'Facilitator may force a heal', 'b'],
    ['notify_supplier_with_sound', 'Arrivals ring on the supplier, Transport and Medical screens', 'b'],
    ['show_completed_transfer_on_wall', 'Completed transfers and heals show on the wall', 'b'],
    ['BROWNOUT'],
    ['brownout_effects.production_multiplier', 'Production ×', 'f'], ['brownout_effects.upkeep_delivery_multiplier', 'Upkeep ×', 'f'],
    ['brownout_effects.worker_penalty', 'Workers unavailable', 'n'],
    ['brownout_effects.decay_per_min', 'Health decay / min', 'f'],
    ['brownout_effects.per_sector.POW.production_multiplier', 'POW production ×', 'f'],
    ['brownout_effects.per_sector.TRN.transfer_capacity', 'TRN capacity under brownout', 'n'],
    ['brownout_effects.per_sector.COM.lose_telemetry', 'COM loses telemetry', 'b'],
    ['rolling_blackout.interval_s', 'Blackout rotation (s)', 'n'], ['rolling_blackout.sectors_at_a_time', 'Sectors browned out at a time', 'n'],
    ['auto_blackout_on_no_order', 'Auto blackout when no order', 'b'],
    ['STABILITY FORMULA'],
    ['stability.weights.integrity', 'Weight: avg health', 'f'], ['stability.weights.core_output', 'Weight: core output', 'f'],
    ['stability.weights.critical_fault', '− per critical fault', 'n'], ['stability.weights.dark_sector', '− per dark sector', 'n'],
    ['stability.weights.brownout_sector', '− per brownout sector', 'n'], ['stability.weights.missed_upkeep', '− per missed upkeep', 'n'],
    ['RESOURCE MINIMUMS'],
    ['resource_min_thresholds.power', 'Power', 'n'], ['resource_min_thresholds.water', 'Water', 'n'],
    ['resource_min_thresholds.parts', 'Parts', 'n'], ['resource_min_thresholds.med', 'Medical', 'n'],
    ['WALL & ROOM'],
    ['wall_shows_faults', 'Wall shows worst fault', 'b'],
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
    $('settings').innerHTML = SETTINGS.map(([key, label, type, options]) => {
      if (!label) return `<div class="sg">${key}</div>`;
      const v = getPath(cfg, key);
      if (type === 'b') return `<label>${esc(label)}<input type="checkbox" data-key="${key}" data-type="b" ${v ? 'checked' : ''}></label>`;
      if (type === 'e') {
        return `<label>${esc(label)}<select data-key="${key}" data-type="e">${(options || [])
          .map((o) => `<option value="${esc(o)}"${String(v) === o ? ' selected' : ''}>${esc(o.replace(/_/g, ' '))}</option>`).join('')}</select></label>`;
      }
      return `<label>${esc(label)}<input type="number" step="${type === 'f' ? '0.05' : '1'}" data-key="${key}" data-type="${type}" value="${v == null ? '' : v}"></label>`;
    }).join('');
    for (const input of $('settings').querySelectorAll('input, select')) {
      input.addEventListener('change', () => {
        let v;
        if (input.dataset.type === 'b') v = input.checked;
        else if (input.dataset.type === 'e') v = input.value;
        else v = Number(input.value);
        send({ type: 'set_config', patch: setPath({}, input.dataset.key, v) });
      });
    }

    const sc = state.scenario.sectors;
    $('sector-config').innerHTML = `<table><tr><th>SECTOR</th>${RESOURCES.map((r) => `<th>OUTPUT ${U.GLYPH[r]}</th>`).join('')}${RESOURCES.map((r) => `<th>UPKEEP ${U.GLYPH[r]}</th>`).join('')}<th>START HEALTH</th><th>WORKERS</th><th></th></tr>
      ${Object.entries(sc).map(([c, d]) => `<tr data-sc="${c}"><td><b>${c}</b></td>
        ${RESOURCES.map((r) => `<td><input type="number" data-prod="${r}" value="${d.production[r] || 0}"></td>`).join('')}
        ${RESOURCES.map((r) => `<td><input type="number" data-up="${r}" value="${d.upkeep[r] || 0}"></td>`).join('')}
        <td><input type="number" data-si value="${d.start_integrity}"></td><td><input type="number" data-sw value="${d.start_workforce}"></td>
        <td><button data-apply="${c}">APPLY</button></td></tr>`).join('')}</table>
      <div class="hint">Output and upkeep apply from the next round. Start values apply on the next reset. AGR/TRN/COM economies are unspecified by design — set them here once playtested.</div>`;
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

    const overrides = Object.entries(cfg.fault_overrides || {});
    $('fault-overrides').innerHTML = overrides.map(([code, o]) => `<div class="fo">
        <b>${esc(code)}</b>
        <span>${(o.extra_valid_codes || []).length ? `also accepts ${esc(o.extra_valid_codes.join(', '))}` : ''}</span>
        <button data-fo-remove="${esc(code)}">REMOVE</button>
      </div>`).join('') || '<div class="hint">None. Faults use the content answer.</div>';
    for (const b of $('fault-overrides').querySelectorAll('[data-fo-remove]')) {
      b.addEventListener('click', () => send({ type: 'set_fault_override', fault_code: b.dataset.foRemove, patch: null }));
    }
  }

  $('btn-fo-apply').addEventListener('click', () => {
    const code = $('fo-fault').value;
    if (!code) return;
    const patch = { extra_valid_codes: $('fo-extra').value.split(',').map((c) => c.trim()).filter(Boolean) };
    send({ type: 'set_fault_override', fault_code: code, patch });
    $('fo-extra').value = '';
  });

  $('btn-save-scenario').addEventListener('click', async () => {
    const name = $('save-name').value.trim();
    if (!name) return;
    const res = await fetch(`/api/scenarios?${qs()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, from_live: true }) });
    const data = await res.json().catch(() => ({}));
    $('save-hint').textContent = res.ok ? `saved as ${data.id}` : (data.error || 'failed');
    if (res.ok) { content.scenarios = data.scenarios; $('save-name').value = ''; }
  });

  // -- debrief analysis -------------------------------------------------------------------

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
      <div class="rounds-list">${Object.values(d.rounds).map((R) => `<details><summary>${R.round} — ${R.faults.fired} faults · ${R.faults.resolved} resolved · ${R.console.invalid_code} bad entries · ${R.transfers.requested} transfers · council ${R.council.called}${R.overrides ? ` · ${R.overrides} overrides` : ''}</summary>
        ${R.faults.list.map((f) => `<div class="dtl"><span class="t">${f.code} ${f.sector}</span><span>${f.outcome}</span><span>first ${fmtS(f.time_to_first_action_s)}</span><span>solve ${fmtS(f.time_to_resolution_s)}</span><span>${f.attempts} att</span>${f.cross_sector ? '<span>x-sector</span>' : ''}</div>`).join('')}
        ${R.transfers.list.map((t) => `<div class="dtl"><span class="t">${t.from}→${t.to}</span><span>${t.amount} ${t.resource}</span><span>${t.status}</span><span>stamp ${fmtS(t.request_to_stamp_s)}</span></div>`).join('')}
        ${R.council.list.map((c) => `<div class="dtl"><span class="t">council</span><span>${c.order ? c.order.join(' › ') : (c.order_submitted ? 'order' : 'no order')}</span><span>${fmtS(c.time_used_s)} used</span></div>`).join('')}
        </details>`).join('')}</div>
      <div class="label">TIMELINE</div>
      <div>${d.timeline.slice(-80).map((e) => `<div class="dtl ${esc(e.kind || '')}"><span class="t">${new Date(e.t).toLocaleTimeString([], { hour12: false })}</span><span>${esc(e.text)}</span></div>`).join('')}</div>`;
  }

  // -- render -----------------------------------------------------------------------

  function render(next) {
    state = next;
    renderTopbar();
    renderProgress();
    renderAttention();
    renderSectors();
    renderSummaries();
    renderRecent();
    renderObs();
    if (drawerSector) renderDrawer();
    renderFaults();
    renderPresets();
    renderTimeline();
    renderEvents();
    renderCouncil();
    renderTransfersView();
    renderWorkforce();
    renderCom();
    renderAgr();
    renderCore();
    renderLog();
    renderOverrideLog();
    renderSettings();
    renderClocks();
    if (content) renderInjects();
  }

  function renderClocks() {
    if (!state) return;
    const rc = U.countdown(state.round_clock, state.frozen);
    $('master-clock').textContent = U.mmss(rc);
    $('master-clock').classList.toggle('low', rc <= 60 && state.round_clock.running);
    $('clock-note').textContent = state.paused ? '— PAUSED' : state.round_clock.running ? '— upkeep at 00:00' : state.round_clock.started ? '— STOPPED' : '— not started';
    const cc = U.countdown(state.council_clock, state.frozen);
    const big = $('council-big');
    if (big) { big.textContent = U.mmss(cc); big.classList.toggle('low', cc <= 30 && state.council.active); }
    $('tl-elapsed').textContent = `${U.mmss(state.round_length_s - rc)} elapsed`;
    for (const el of document.querySelectorAll('[data-cd-effect]')) {
      const e = (state.effects || []).find((x) => x.id === el.dataset.cdEffect);
      if (e && e.remaining_s != null) el.textContent = U.mmss(U.countdown({ running: true, remaining_s: e.remaining_s }, state.frozen));
    }
  }
  setInterval(renderClocks, 500);
})();
