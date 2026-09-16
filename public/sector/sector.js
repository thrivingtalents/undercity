'use strict';
/**
 * Sector console — UNDERCITY / HAVEN-9 (spec §6.1, contract §3 and §8).
 *
 * One laptop per sector, read under time pressure. The screen answers, in
 * this order: what is wrong, how long we have, what we hold, what to type.
 *
 * Rules that shape this file:
 *   · It renders what the server sends and sends intents back. No game state
 *     is computed here, so a rejected code never briefly looks accepted.
 *   · Frames arrive every second while anything is counting. The console
 *     (code input, workers select) is a PERSISTENT DOM element: renders only
 *     touch text nodes and attributes, never rebuild it, so typing is never
 *     interrupted. Fault rows are keyed by code and updated in place.
 *   · Countdowns run locally on a 250 ms tick from the last frame
 *     (Undercity.countdown) and never past zero, never while frozen.
 *   · The fault list keeps server order. Triage is the team's job.
 *   · Status is always printed as a word; colour only reinforces it.
 *   · No chat surface of any kind (contract §0.5).
 */
(function sectorConsole() {
  const U = window.Undercity;
  const CTX = U.context();
  const SECTOR = CTX.sector;
  const $ = (id) => document.getElementById(id);
  const esc = U.escapeHtml;

  const RESOURCES = [
    { key: 'power', glyph: '⚡', name: 'POWER' },
    { key: 'water', glyph: '💧', name: 'WATER' },
    { key: 'parts', glyph: '🔧', name: 'PARTS' },
    { key: 'med',   glyph: '⚕',  name: 'MEDICAL' },
  ];
  const RES = Object.fromEntries(RESOURCES.map((r) => [r.key, r]));
  RES.workers = { key: 'workers', glyph: '👤', name: 'WORKERS' };

  const TRANSFER_WORD = {
    REQUESTED: 'REQUESTED', TRANSFER_CREATED: 'TRANSFER RAISED',
    DECLINED_BY_SUPPLIER: 'DECLINED', PENDING_TRN_APPROVAL: 'AWAITING TRANSPORT',
    APPROVED: 'APPROVED', DELIVERED: 'DELIVERED', DECLINED_BY_TRN: 'DECLINED BY TRANSPORT',
    CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED',
    WAITING_FOR_MED: 'WAITING FOR MEDICAL', HEALED: 'HEALED', DECLINED_BY_MED: 'DECLINED BY MEDICAL',
  };
  const OPEN_TRANSFER = new Set(['REQUESTED', 'PENDING_TRN_APPROVAL', 'APPROVED']);
  const ALERT_FULL_S = 8;
  const WARN_S = 120;
  const DANGER_S = 30;
  const RESULT_BANNER_MS = 9000;
  const REQUEST_BANNER_MS = 12000;

  // -- state ------------------------------------------------------------------

  let state = null;
  let mine = null;
  let teamName = null;
  let selected = null;        // fault code whose card is open
  let consoleFor = null;      // fault code the console inputs currently hold a draft for
  const draft = new Map();    // fault code -> { code, workers }
  const verdict = new Map();  // fault code -> last submit_result
  const consecutive = new Map(); // fault code -> consecutive invalid codes (local mirror)
  const opened = new Set();   // fault codes we have sent fault_open for
  const localLock = new Map(); // fault code -> performance.now() when a client-side lock ends
  const faultRows = new Map(); // fault code -> list row element
  const cityRows = new Map();  // sector code -> feed row element
  const transferRows = new Map(); // transfer id -> row element
  const queueRows = new Map();    // transfer id -> queue row element
  const inboxSeen = new Set();    // inbound request ids we have already rung for
  const queueSeen = new Set();    // approval-queue ids (TRN) already rung for
  const healSeen = new Set();     // healing-queue ids (MED) already rung for
  let requestBannerUntil = 0;     // when the arrival banner retires
  let formMode = 'request';       // 'request' (ask) or 'transfer' (offer)
  let alertSeen = null;       // { id, age, at } — age from the frame + local elapsed
  let resultBanner = null;    // { until }
  let pendingTransferAction = null; // 'transfer' | 'stamp' — routes transfer_result to a panel
  let lastDisabled = null;

  // -- connection -------------------------------------------------------------

  const socket = U.connect({
    hello: { type: 'hello', role: 'sector', session: CTX.session, sector: SECTOR, token: null },
    onState: render,
    onStatus: setConnStatus,
    onMessage: (msg) => {
      if (msg.type === 'welcome' && msg.team_name) {
        // The table's own name, so a room of six tables knows which is theirs.
        teamName = msg.team_name;
        const el = $('hdr-team');
        el.textContent = teamName;
        el.hidden = false;
      }
      if (msg.type === 'submit_result') handleResult(msg);
      if (msg.type === 'transfer_result' || msg.type === 'heal_result') handleTransferResult(msg);
      if (msg.type === 'sting') U.playSting(msg.sound);
    },
  });

  function setConnStatus(status) {
    const el = $('conn');
    el.dataset.status = status;
    $('conn-text').textContent =
      status === 'live' ? 'LIVE' : status === 'stale' ? 'DELAYED' : 'RECONNECTING';
  }

  // -- small DOM helpers ------------------------------------------------------

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }
  function show(el, on) {
    if (el && el.hidden === !!on) el.hidden = !on;
  }
  /** Urgency colouring for a countdown: amber under 2:00, pulsing red under 0:30. */
  function setUrgency(el, secs, active) {
    const cls = !active ? '' : secs < DANGER_S ? 'u-danger' : secs < WARN_S ? 'u-warn' : '';
    if (el.dataset.u === cls) return;
    el.classList.remove('u-warn', 'u-danger');
    if (cls) el.classList.add(cls);
    el.dataset.u = cls;
  }
  function flash(el, cls, ms) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth; // restart the animation
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  }
  function fmtRes(obj, sep = '  ') {
    const parts = Object.entries(obj || {}).filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => `${v}${(RES[k] || {}).glyph || k}`);
    return parts.join(sep);
  }
  const timers = {};
  function transientMsg(id, text, cls, ms = 6000) {
    const el = $(id);
    el.textContent = text;
    el.className = `msg ${cls || ''}`;
    el.hidden = !text;
    clearTimeout(timers[id]);
    if (text) timers[id] = setTimeout(() => { el.hidden = true; }, ms);
  }

  // -- status words -----------------------------------------------------------

  /** The word we print. Never colour alone. The server computes it from the
   *  scenario thresholds (degraded_below / critical_below); the fallback only
   *  covers a frame from an older server. */
  function statusWord(s) {
    if (s.status_word) return s.status_word;
    if (s.status === 'DARK' || s.status === 'BROWNOUT' || s.status === 'CRITICAL') return s.status;
    return Number(s.integrity) >= 60 ? 'STABLE' : 'DEGRADED';
  }

  function hasDeadline(f) {
    return f.deadline_remaining_s !== null && f.deadline_remaining_s !== undefined;
  }
  function faultRemaining(f) {
    return U.countdown({ running: !f.paused && !state.frozen, remaining_s: f.deadline_remaining_s }, state.frozen);
  }
  function deadlineText(f) {
    if (f.expired) return 'DEADLINE PASSED';
    if (!hasDeadline(f)) return 'NO DEADLINE';
    return U.mmss(faultRemaining(f));
  }
  function lockRemaining(f) {
    const server = U.countdown({ running: !state.frozen, remaining_s: f.locked_until_s || 0 }, state.frozen);
    const local = localLock.has(f.code) ? (localLock.get(f.code) - performance.now()) / 1000 : 0;
    return Math.max(0, server, local);
  }
  function selectedFault() {
    return selected && mine ? (mine.faults || []).find((f) => f.code === selected) || null : null;
  }

  // -- init: persistent controls ----------------------------------------------

  function init() {
    document.title = `UNDERCITY — ${SECTOR || 'SECTOR'}`;

    // Resource rows: four persistent rows, values updated in place.
    const host = $('resources');
    for (const r of RESOURCES) {
      const row = document.createElement('div');
      row.className = 'res-row';
      row.dataset.key = r.key;
      // Read-only. Stock changes through the sanctioned paths only: production,
      // upkeep, a solved fault, and a transfer Transport has approved. A table
      // that could edit this number could walk straight through all of them.
      row.innerHTML =
        `<span class="res-glyph">${r.glyph}</span>` +
        `<span class="res-name">${r.name}</span>` +
        `<b class="res-val">—</b>` +
        `<span class="res-low" hidden>LOW</span>`;
      host.appendChild(row);
    }

    // Transfer form.
    const amt = $('tf-amt');
    for (let n = 1; n <= 9; n += 1) amt.insertAdjacentHTML('beforeend', `<option value="${n}">${n}</option>`);
    $('transfer-form').addEventListener('submit', (e) => { e.preventDefault(); submitForm(); });
    for (const b of $('tf-tabs').querySelectorAll('button')) {
      b.addEventListener('click', () => setFormMode(b.dataset.mode));
    }
    $('btn-heal-request').addEventListener('click', requestHealing);

    // Console.
    const input = $('code-input');
    const select = $('workers-select');
    input.addEventListener('input', () => {
      if (!consoleFor) return;
      const d = draft.get(consoleFor) || {};
      d.code = input.value;
      draft.set(consoleFor, d);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    select.addEventListener('change', () => {
      if (!consoleFor) return;
      const d = draft.get(consoleFor) || {};
      d.workers = select.value;
      draft.set(consoleFor, d);
    });
    $('submit-btn').addEventListener('click', submit);

    // Sound hint: goes away on the first gesture (which also unlocks audio).
    const hint = $('sound-hint');
    const dismiss = () => { hint.hidden = true; };
    window.addEventListener('pointerdown', dismiss, { once: true });
    window.addEventListener('keydown', dismiss, { once: true });

    setFormMode('request');
    setInterval(tick, 250);
  }

  // -- intents ----------------------------------------------------------------

  function submit() {
    const f = selectedFault();
    if (!f) return;
    if ($('submit-btn').disabled) return;
    socket.send({
      type: 'submit_code',
      sector: SECTOR,
      fault_code: f.code,
      code: $('code-input').value.trim(),
      workers_assigned: Number($('workers-select').value || 0),
    });
  }

  function selectFault(code) {
    if (selected === code) return;
    selected = code;
    if (code && !opened.has(code)) {
      opened.add(code);
      socket.send({ type: 'fault_open', fault_code: code });
    }
    for (const [c, row] of faultRows) row.classList.toggle('selected', c === code);
    renderCard();
    tick();
    if (code) {
      const input = $('code-input');
      if (!input.disabled) input.focus();
    }
  }

  /**
   * REQUEST asks another sector for stock; TRANSFER offers our own. Neither
   * moves anything: a request waits on the supplier, a transfer waits on
   * Transport. Every sector has both.
   */
  function submitForm() {
    if (!mine) return;
    const other = $('tf-sector').value;
    if (!other) return;
    const resource = $('tf-res').value;
    const amount = Number($('tf-amt').value || 1);
    pendingTransferAction = 'transfer';
    socket.send(formMode === 'transfer'
      ? { type: 'transfer_create', to: other, resource, amount }
      : { type: 'transfer_request', from: other, to: SECTOR, resource, amount });
  }

  function updateTransfer(id, status) {
    pendingTransferAction = 'transfer';
    socket.send({ type: 'transfer_update', id, status });
  }

  /** Supplier consent: raises a transfer. Not approval — that is Transport's. */
  function fulfillRequest(id) {
    pendingTransferAction = 'inbox';
    socket.send({ type: 'request_fulfill', id });
  }

  function declineRequest(id) {
    pendingTransferAction = 'inbox';
    socket.send({ type: 'request_decline', id });
  }

  /** TRN only: the signed paper chit is in our hand. */
  function confirmChit(id, confirmed) {
    pendingTransferAction = 'stamp';
    socket.send({ type: 'transfer_chit', id, confirmed });
  }

  /** TRN only: approve the movement. This is the step that moves stock. */
  function approveTransfer(id) {
    pendingTransferAction = 'stamp';
    socket.send({ type: 'transfer_approve', id });
  }

  function declineTransfer(id) {
    pendingTransferAction = 'stamp';
    socket.send({ type: 'transfer_decline', id });
  }

  /** Any sector with an injured worker. The target is always Medical. */
  function requestHealing() {
    pendingTransferAction = 'heal';
    socket.send({ type: 'heal_request' });
  }

  /** MED only. */
  function healWorker(id) {
    pendingTransferAction = 'healing';
    socket.send({ type: 'heal_worker', id });
  }

  function declineHealing(id) {
    pendingTransferAction = 'healing';
    socket.send({ type: 'heal_decline', id });
  }

  // -- replies ----------------------------------------------------------------

  function handleResult(msg) {
    verdict.set(msg.fault_code, msg);
    const card = $('card');
    const row = faultRows.get(msg.fault_code);

    if (msg.accepted) {
      draft.delete(msg.fault_code);
      consecutive.delete(msg.fault_code);
      localLock.delete(msg.fault_code);
      if (consoleFor === msg.fault_code) $('code-input').value = '';
      const spent = fmtRes(msg.consumed, ' ');
      const text = `${msg.fault_code}  FAULT RESOLVED  +${Number(msg.recovery) || 0} INTEGRITY` +
        (spent ? `  ·  SPENT ${spent}` : '');
      const banner = $('banner-result');
      banner.textContent = text;
      banner.hidden = false;
      resultBanner = { until: performance.now() + RESULT_BANNER_MS };
      flash(card, 'flash-ok', 900);
      flash(row, 'flash-ok', 900);
    } else {
      if (msg.reason === 'invalid_code') {
        if (msg.locked_until_s) {
          // Third strike: the server resets its consecutive count; mirror it.
          localLock.set(msg.fault_code, performance.now() + Number(msg.locked_until_s) * 1000);
          consecutive.set(msg.fault_code, 0);
        } else {
          consecutive.set(msg.fault_code, (consecutive.get(msg.fault_code) || 0) + 1);
        }
      }
      if (msg.reason === 'locked' && msg.locked_until_s) {
        localLock.set(msg.fault_code, performance.now() + Number(msg.locked_until_s) * 1000);
      }
      flash(card, 'flash-bad', 500);
      if (consoleFor === msg.fault_code) {
        const input = $('code-input');
        if (!input.disabled) { input.focus(); input.select(); }
      }
    }
    renderCard();
    tick();
  }

  function transferReason(msg) {
    const res = (RES[msg.resource] || { name: String(msg.resource || '').toUpperCase() }).name;
    switch (msg.reason) {
      case 'capacity':
        return `TRANSPORT HAS USED ALL ${msg.capacity} STAMPS FOR THIS ${String(msg.basis || 'round').toUpperCase()}`;
      case 'not_supplier':     return `ONLY ${msg.supplier || 'THE SUPPLYING SECTOR'} CAN FULFIL OR DECLINE THIS REQUEST`;
      case 'approval_trn_only': return 'ONLY TRANSPORT & TUNNELS CAN APPROVE RESOURCE TRANSFERS';
      case 'insufficient_stock_accept':
        return `CANNOT FULFIL — WE HOLD ${msg.have} ${res}, THE REQUEST IS FOR ${msg.need}`;
      case 'insufficient_stock_stamp':
        return `CANNOT APPROVE — SUPPLIER NO LONGER HAS ${msg.need} ${res}`;
      case 'not_accepted':     return 'CANNOT APPROVE — THE SUPPLIER HAS NOT FULFILLED THIS REQUEST';
      case 'chit_required':    return 'CANNOT APPROVE — PHYSICAL TRANSFER CHIT NOT CONFIRMED';
      case 'cancel_locked':    return 'ALREADY WITH TRANSPORT — ASK THE FACILITATOR TO CANCEL';
      case 'expired':          return 'THIS EXPIRED WHEN THE ROUND CHANGED';
      case 'already_stamped':  return 'ALREADY APPROVED';
      case 'transfer_closed':  return 'TRANSFER ALREADY CLOSED';
      case 'request_closed':   return 'REQUEST ALREADY ANSWERED';
      case 'unknown_transfer': return 'UNKNOWN TRANSFER';
      case 'unknown_request':  return 'UNKNOWN REQUEST';
      case 'unknown_healing':  return 'UNKNOWN HEALING REQUEST';
      case 'not_stamped':      return 'NOT APPROVED YET';
      case 'sector_dark':      return 'SECTOR IS DARK';
      case 'bad_request':      return 'INVALID REQUEST';
      case 'same_sector':      return 'SUPPLIER AND RECEIVER CANNOT BE THE SAME SECTOR';
      case 'invalid_amount':   return 'AMOUNT MUST BE GREATER THAN ZERO';
      // healing
      case 'heal_med_only':    return 'ONLY MEDICAL BAY CAN HEAL INJURED WORKERS';
      case 'med_capacity':     return `MEDICAL HAS USED ALL ${msg.capacity} HEALS FOR THIS ROUND`;
      case 'worker_not_injured': return 'THAT WORKER IS NOT CURRENTLY INJURED';
      case 'not_own_sector':   return 'A SECTOR MAY ONLY ASK FOR ITS OWN WORKERS';
      case 'healing_closed':   return 'THAT HEALING REQUEST IS ALREADY ANSWERED';
      default:                 return String(msg.reason || 'REFUSED').toUpperCase().replace(/_/g, ' ');
    }
  }

  function handleTransferResult(msg) {
    const target = {
      stamp: 'queue-msg', inbox: 'inbox-msg', heal: 'heal-msg', healing: 'healing-msg',
    }[pendingTransferAction] || 'transfer-msg';
    pendingTransferAction = null;
    if (msg.ok) {
      const t = msg.transfer || msg.request || msg.healing || {};
      transientMsg(target, `${t.id ? `${t.id} ` : ''}${TRANSFER_WORD[t.status] || 'RECORDED'}`, 'ok', 4000);
    } else {
      transientMsg(target, `REFUSED — ${transferReason(msg)}`, 'bad');
    }
  }

  // -- render (per frame; keyed, never rebuilds the console) -----------------

  function render(next) {
    state = next;
    mine = state.sectors && state.sectors[SECTOR];
    if (!mine) return;

    document.documentElement.style.setProperty('--sector', mine.colour || '#E8B33A');
    renderHeader();
    renderModes();
    renderResources();
    renderUpkeep();
    renderInbox();
    renderInjured();
    renderTransfers();
    renderFaultList();
    renderCard();
    renderCity();
    renderAnnouncements();
    renderEffects();
    renderQueue();
    renderHealing();
    renderIntel();
    renderResolved();
    tick();
  }

  function renderHeader() {
    setText($('hdr-glyph'), U.SECTOR_GLYPH[SECTOR] || '');
    setText($('hdr-name'), String(mine.name || SECTOR).toUpperCase());
    setText($('hdr-code'), mine.code);

    const word = statusWord(mine);
    setText($('hdr-status'), word);
    $('hdr-status-block').dataset.status = word;

    const value = Math.round(mine.integrity);
    setText($('hdr-integrity'), `${value}%`);
    const bar = $('hdr-integrity-bar');
    const cls = `bar ${U.integrityClass(value)}`;
    if (bar.className !== cls) bar.className = cls;
    bar.firstElementChild.style.width = `${Math.max(0, Math.min(100, value))}%`;

    setText($('hdr-core'), `${Math.round(state.core_output)}%`);
    setText($('hdr-phase'), String(state.phase_name || state.phase || '—').toUpperCase());
  }

  function renderModes() {
    const body = document.body;
    const word = statusWord(mine);
    body.classList.toggle('is-critical', word === 'CRITICAL');
    body.classList.toggle('is-brownout', word === 'BROWNOUT');
    body.classList.toggle('is-dark', word === 'DARK');
    body.classList.toggle('is-paused', !!state.paused);

    show($('banner-brownout'), word === 'BROWNOUT');
    show($('banner-breather'), !!state.breather);
    show($('dark-overlay'), word === 'DARK');
    show($('pause-overlay'), !!state.paused);

    // Council: a full-width summons banner plus the takeover panel in the
    // right column; the rest of the screen keeps working.
    const council = !!(state.council && state.council.active) || state.mode === 'COUNCIL';
    show($('council'), council);
    show($('banner-council'), council);
    show($('city-block'), !council);
    show($('announce-block'), !council);

    // Alert: remember the frame's age so the tick can promote full → reduced locally.
    const a = state.alert;
    if (a) {
      alertSeen = { id: a.id, age: Number(a.age_s) || 0, at: performance.now(), full: !!a.full_screen, fullS: Number(a.full_s) || ALERT_FULL_S };
      setText($('alert-title'), a.title || '');
      setText($('alert-sub'), a.subtitle || '');
      setText($('alert-big'), a.big || '');
      show($('alert-big'), !!a.big);
      setText($('banner-alert-title'), a.title || '');
      setText($('banner-alert-sub'), a.subtitle ? ` — ${a.subtitle}` : '');
    } else {
      alertSeen = null;
      show($('alert-full'), false);
      show($('banner-alert'), false);
    }
  }

  function renderResources() {
    const host = $('resources');
    for (const row of host.children) {
      const key = row.dataset.key;
      const v = Number(mine.inventory[key]) || 0;
      const low = !!(mine.low && mine.low[key]);
      setText(row.querySelector('.res-val'), String(v));
      row.classList.toggle('low', low);
      show(row.querySelector('.res-low'), low);
    }
    const wf = mine.workforce || {};
    setText($('wf-avail'), String(wf.available ?? wf.active ?? 0));
    setText($('wf-total'), String(wf.total ?? 0));
    const extra = [];
    if (wf.injured > 0) extra.push(`INJURED ${wf.injured}`);
    if (wf.loaned > 0) extra.push(`LOANED OUT ${wf.loaned}`);
    if (wf.borrowed > 0) extra.push(`BORROWED ${wf.borrowed}`);
    // Brownout holds crew back without injuring anyone; say so.
    const held = (Number(wf.active) || 0) + (Number(wf.borrowed) || 0) - (Number(wf.available) || 0);
    if (held > 0 && mine.brownout) extra.push(`HELD BACK ${held} (BROWNOUT)`);
    setText($('wf-extra'), extra.join(' · '));
    show($('wf-extra'), extra.length > 0);
    $('wf-avail').classList.toggle('low', Number(wf.available) <= 0);
  }

  function renderUpkeep() {
    const delivery = mine.upkeep_delivery || mine.upkeep_per_round || {};
    const items = Object.entries(delivery).filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => `<span class="uk"><i>${(RES[k] || {}).glyph || ''}</i> ${v} ${(RES[k] || { name: k }).name}</span>`);
    const html = items.length ? items.join('') : '<span class="uk dim">NONE</span>';
    const host = $('upkeep-delivery');
    if (host.innerHTML !== html) host.innerHTML = html;

    // Brownout: half rations — show the full entitlement struck through beside it.
    const full = $('upkeep-full');
    if (mine.brownout) {
      const fullText = fmtRes(mine.upkeep_per_round, ' ');
      const fh = `<s>${esc(fullText)}</s> <em>HALF RATIONS</em>`;
      if (full.innerHTML !== fh) full.innerHTML = fh;
    }
    show(full, !!mine.brownout);

    const prod = mine.production_next || {};
    const prodText = Object.entries(prod).filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => `+${v} ${(RES[k] || {}).glyph || k}`).join('  ');
    setText($('production-next'), prodText || '—');
    $('production-next').classList.toggle('dim', !prodText);
  }

  function sectorLabel(code) {
    const s = state.sectors && state.sectors[code];
    return String((s && s.name) || code).toUpperCase();
  }
  function resName(key) {
    return (RES[key] || { name: String(key).toUpperCase() }).name;
  }
  function ourStock(key) {
    if (!mine) return 0;
    return key === 'workers'
      ? Number((mine.workforce || {}).active) || 0
      : Number((mine.inventory || {})[key]) || 0;
  }

  /** A banner and a sound, once, when something new lands on this screen. */
  function notifyArrival(text) {
    const rules = state.transfer_rules || {};
    setText($('banner-request'), text);
    show($('banner-request'), true);
    requestBannerUntil = performance.now() + REQUEST_BANNER_MS;
    if (rules.notify_supplier_with_sound !== false) U.playSting('chime');
  }

  /** REQUEST asks for stock; TRANSFER offers ours. Both exist on every screen. */
  function setFormMode(mode) {
    formMode = mode === 'transfer' ? 'transfer' : 'request';
    for (const b of $('tf-tabs').querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.mode === formMode);
    }
    const offering = formMode === 'transfer';
    setText($('tf-label'), offering ? 'TRANSFER TO' : 'REQUEST FROM');
    setText($('tf-submit'), offering ? 'SEND FOR TRN APPROVAL' : 'SEND REQUEST');
    setText($('tf-hint'), offering
      ? 'Offers our own stock. Nothing moves until Transport approves it.'
      : 'Asks another sector for stock. Nothing moves until they fulfil it and Transport approves.');
  }

  /** What this piece of paper is waiting on, in the words the room uses. */
  function statusLine(t) {
    switch (t.status) {
      case 'REQUESTED':            return `REQUESTED — WAITING FOR ${sectorLabel(t.supplier || t.from)}`;
      case 'TRANSFER_CREATED':     return 'FULFILLED — AWAITING TRANSPORT';
      case 'DECLINED_BY_SUPPLIER': return `DECLINED BY ${sectorLabel(t.supplier || t.from)}`;
      case 'PENDING_TRN_APPROVAL': return 'AWAITING TRANSPORT APPROVAL';
      case 'APPROVED':             return 'APPROVED BY TRANSPORT';
      case 'DELIVERED':            return 'DELIVERED';
      case 'DECLINED_BY_TRN':      return 'DECLINED BY TRANSPORT';
      case 'CANCELLED':            return 'CANCELLED';
      case 'EXPIRED':              return `EXPIRED AT END OF ${t.round_created || 'THE ROUND'}`;
      default:                     return TRANSFER_WORD[t.status] || t.status;
    }
  }

  function paperLine(t) {
    const a = t.supplier || t.from;
    const b = t.requester || t.to;
    return `${a} → ${b} · ${t.amount} ${resName(t.resource)} · ${statusLine(t)}`;
  }

  /**
   * INBOUND REQUESTS — the supplier's decision. Another table has asked us for
   * stock; only we can answer. FULFIL raises a transfer for Transport to
   * approve; it is not approval itself.
   */
  function renderInbox() {
    const rules = state.transfer_rules || {};
    const list = (state.requests || []).filter((r) => r.supplier === SECTOR && r.status === 'REQUESTED');
    show($('inbox-panel'), list.length > 0);
    setText($('inbox-count'), String(list.length));

    const host = $('inbox');
    const html = list.map((t) => {
      const have = ourStock(t.resource);
      const short = rules.enforce_supplier_stock !== false && have < t.amount;
      return `<div class="inbound${short ? ' short' : ''}" data-id="${esc(t.id)}">
          <div class="ib-title">NEW RESOURCE REQUEST</div>
          <div class="ib-msg">${esc(sectorLabel(t.requester))} IS REQUESTING <b>${esc(t.amount)} ${esc(resName(t.resource))}</b></div>
          <div class="ib-stock">CURRENT STOCK: <b>${have} ${esc(resName(t.resource))}</b>${short ? ' — NOT ENOUGH TO FULFIL' : ''}</div>
          <div class="ib-btns">
            <button type="button" class="primary" data-fulfill="${esc(t.id)}"${short ? ' disabled' : ''}>FULFIL</button>
            <button type="button" class="ghost" data-decline="${esc(t.id)}">DECLINE</button>
          </div>
        </div>`;
    }).join('');
    if (host.dataset.sig !== html) {
      host.dataset.sig = html;
      host.innerHTML = html;
      for (const b of host.querySelectorAll('[data-fulfill]')) b.addEventListener('click', () => fulfillRequest(b.dataset.fulfill));
      for (const b of host.querySelectorAll('[data-decline]')) b.addEventListener('click', () => declineRequest(b.dataset.decline));
    }

    const fresh = list.filter((t) => !inboxSeen.has(t.id));
    for (const t of list) inboxSeen.add(t.id);
    for (const id of [...inboxSeen]) if (!list.some((t) => t.id === id)) inboxSeen.delete(id);
    if (fresh.length) {
      const t = fresh[0];
      notifyArrival(`NEW RESOURCE REQUEST — ${sectorLabel(t.requester)} REQUESTS ${t.amount} ${resName(t.resource)}`);
    }
  }

  /** Our own paperwork: what we asked for, and what is moving in or out. */
  function renderTransfers() {
    const host = $('transfers');
    // Requests waiting on US are the inbox's business, not this ledger's.
    const requests = (state.requests || []).filter((r) => !(r.supplier === SECTOR && r.status === 'REQUESTED'));
    const list = [...requests, ...(state.transfers || [])]
      .sort((a, b) => Date.parse(b.requested_at || 0) - Date.parse(a.requested_at || 0));
    const seen = new Set();
    list.forEach((t, i) => {
      seen.add(t.id);
      let row = transferRows.get(t.id);
      if (!row) {
        row = document.createElement('div');
        row.className = 'transfer';
        row.dataset.id = t.id;
        transferRows.set(t.id, row);
      }
      // Rebuild the row's controls only when the status changes.
      if (row.dataset.status !== t.status) {
        row.dataset.status = t.status;
        row.className = `transfer st-${t.status}`;
        // Withdraw our own ask while it is still unanswered.
        const mineToWithdraw = t.status === 'REQUESTED' && t.requester === SECTOR;
        const btns = mineToWithdraw
          ? [`<button type="button" class="ghost" data-s="CANCELLED">WITHDRAW</button>`] : [];
        row.innerHTML =
          `<div class="t-line"><span class="t-id">${esc(t.id)}</span> <span class="t-text">${esc(paperLine(t))}</span></div>` +
          (btns.length ? `<div class="t-btns">${btns.join('')}</div>` : '');
        for (const b of row.querySelectorAll('button')) {
          b.addEventListener('click', () => updateTransfer(t.id, b.dataset.s));
        }
      } else {
        setText(row.querySelector('.t-text'), paperLine(t));
      }
      if (host.children[i] !== row) host.insertBefore(row, host.children[i] || null);
    });
    for (const [id, row] of transferRows) {
      if (!seen.has(id)) { row.remove(); transferRows.delete(id); }
    }
    const empty = $('transfers-empty');
    show(empty, list.length === 0);
    if (list.length === 0 && empty.parentNode !== host) host.appendChild(empty);

    // The other five sectors, for both forms.
    const sel = $('tf-sector');
    const others = Object.keys(state.sectors).filter((c) => c !== SECTOR);
    if (sel.dataset.keys !== others.join(',')) {
      sel.dataset.keys = others.join(',');
      sel.innerHTML = others.map((c) => `<option value="${c}">${U.SECTOR_GLYPH[c] || ''} ${c}</option>`).join('');
    }
  }

  /**
   * INJURED WORKERS — every sector, when it has one. The target is Medical
   * Bay and there is nothing to choose; only Medical can do the healing.
   */
  function renderInjured() {
    const wf = (mine && mine.workforce) || {};
    const injured = Number(wf.injured) || 0;
    const mineHealing = (state.healing || []).filter((h) => h.status === 'WAITING_FOR_MED');
    show($('injured-panel'), injured > 0 || mineHealing.length > 0);
    if (injured <= 0 && !mineHealing.length) return;

    const unclaimed = Number(state.unclaimed_injured) || 0;
    setText($('injured-count'), String(injured));
    setText($('injured-num'), String(injured));
    setText($('injured-unclaimed'), String(unclaimed));

    const recent = (state.healing || []).slice(0, 6);
    const html = recent.map((h) => `<div class="heal-row st-${esc(h.status)}">
        <span class="h-worker">${esc(h.worker_label)}</span>
        <span class="h-target">→ MEDICAL BAY</span>
        <span class="h-status">${esc(TRANSFER_WORD[h.status] || h.status)}</span>
      </div>`).join('');
    const host = $('heal-list');
    if (host.dataset.sig !== html) { host.dataset.sig = html; host.innerHTML = html; }

    const btn = $('btn-heal-request');
    btn.disabled = unclaimed <= 0;
    btn.title = unclaimed <= 0 ? 'Every injured worker is already with Medical' : 'Ask Medical Bay to heal one worker';
  }

  /**
   * MED HEALING QUEUE — Medical only. The server sends this to nobody else, so
   * no other screen can render a HEAL control.
   */
  function renderHealing() {
    const q = state.healing_queue;
    show($('healing-panel'), !!q);
    if (!q) return;
    const full = q.used >= q.capacity;
    const left = Math.max(0, q.remaining !== undefined ? q.remaining : q.capacity - q.used);
    setText($('healing-cap'), `${q.used}/${q.capacity} USED · ${left} LEFT THIS ROUND`);
    $('healing-cap').classList.toggle('warn', full);

    const items = q.items || [];
    const html = items.map((h, i) => {
      const gone = h.still_injured === false;
      const blocked = full || !q.can_heal || gone;
      return `<div class="q-row${gone ? ' blocked' : ''}">
          <span class="q-n">${i + 1}.</span>
          <span class="q-text">${esc(sectorLabel(h.sector))} · ${esc(h.worker_label)}${gone ? ' · NO LONGER INJURED' : ''}</span>
          <button type="button" class="q-stamp" data-heal="${esc(h.id)}"${blocked ? ' disabled' : ''}
            title="${gone ? 'This worker is no longer injured' : full ? 'No heals left this round' : !q.can_heal ? 'Medical is dark' : 'Heal this worker'}">HEAL</button>
          <button type="button" class="q-chit" data-hdecline="${esc(h.id)}">DECLINE</button>
        </div>`;
    }).join('') || `<div class="empty">Queue empty.</div>`;
    const host = $('healing');
    if (host.dataset.sig !== html) {
      host.dataset.sig = html;
      host.innerHTML = html;
      for (const b of host.querySelectorAll('[data-heal]')) b.addEventListener('click', () => healWorker(b.dataset.heal));
      for (const b of host.querySelectorAll('[data-hdecline]')) b.addEventListener('click', () => declineHealing(b.dataset.hdecline));
    }

    const fresh = items.filter((h) => !healSeen.has(h.id));
    for (const h of items) healSeen.add(h.id);
    for (const id of [...healSeen]) if (!items.some((h) => h.id === id)) healSeen.delete(id);
    if (fresh.length) notifyArrival(`HEALING REQUEST — ${sectorLabel(fresh[0].sector)} ${fresh[0].worker_label}`);
  }

  // -- faults -----------------------------------------------------------------

  function makeFaultRow(f) {
    const row = document.createElement('div');
    row.className = `fault-row sev-${f.severity}`;
    row.dataset.code = f.code;
    row.innerHTML =
      `<span class="fr-code">${esc(f.code)}</span>` +
      `<span class="fr-dl clock">—</span>` +
      `<span class="fr-sev"><i>${U.severityPips(f.severity)}</i> ${U.severityName(f.severity)}</span>` +
      `<span class="fr-name">${esc(f.name)}</span>`;
    row.addEventListener('click', () => selectFault(f.code));
    return row;
  }

  function renderFaultList() {
    const host = $('fault-list');
    const faults = mine.faults || [];
    const previouslySelected = selected;
    // Where the open fault sat BEFORE this frame reorders the rows, so that
    // when it vanishes (resolved/cleared) the card moves to its neighbour.
    const removedIndex = selected
      ? Array.prototype.findIndex.call(host.children, (r) => r.dataset.code === selected) : -1;
    const seen = new Set();

    faults.forEach((f, i) => {
      seen.add(f.code);
      localLock.delete(f.code); // server truth for the lockout arrived with this frame
      let row = faultRows.get(f.code);
      if (!row) { row = makeFaultRow(f); faultRows.set(f.code, row); }
      if (host.children[i] !== row) host.insertBefore(row, host.children[i] || null);
      const cls = `fault-row sev-${f.severity}${f.code === selected ? ' selected' : ''}${f.expired ? ' expired' : ''}${f.paused ? ' paused' : ''}`;
      if (row.className !== cls) row.className = cls;
      setText(row.querySelector('.fr-name'), f.name);
    });
    for (const [code, row] of faultRows) {
      if (!seen.has(code)) {
        row.remove();
        faultRows.delete(code);
        draft.delete(code);
        consecutive.delete(code);
        localLock.delete(code);
        opened.delete(code);
      }
    }

    setText($('fault-count'), String(faults.length));
    show($('fault-empty'), faults.length === 0);

    // Selection: keep it; if it vanished (resolved/cleared) move to the next one;
    // a lone fault opens itself. Several faults with nothing open: the team picks.
    if (selected && !seen.has(selected)) {
      selected = null;
      if (faults.length) {
        const idx = Math.min(Math.max(removedIndex, 0), faults.length - 1);
        selectFault(faults[idx].code);
      }
    } else if (!selected && faults.length === 1) {
      selectFault(faults[0].code);
    }
    if (previouslySelected !== selected) {
      for (const [c, row] of faultRows) row.classList.toggle('selected', c === selected);
    }
    show($('fault-pick'), !selected && faults.length > 1);
  }

  function renderCard() {
    const card = $('card');
    const f = selectedFault();
    if (!f) {
      show(card, false);
      consoleFor = null;
      return;
    }
    show(card, true);
    const sev = `sev-${f.severity}`;
    if (card.dataset.sev !== sev) {
      card.classList.remove('sev-1', 'sev-2', 'sev-3');
      card.classList.add(sev);
      card.dataset.sev = sev;
    }
    setText($('card-sev'), `${U.severityPips(f.severity)} ${U.severityName(f.severity)}`);
    setText($('card-code'), f.code);
    setText($('card-name'), String(f.name || '').toUpperCase());
    setText($('card-flavour'), f.flavour || '');

    const spend = fmtRes(f.resources_required, ' ');
    const meta = [
      `CREW REQUIRED <b>${esc(f.crew_required)}</b>`,
      `DECAY <b>${esc(f.decay_per_min)}</b>/min`,
      spend ? `SPEND <b>${esc(spend)}</b>` : null,
      `ATTEMPTS <b>${esc(f.attempts)}</b>`,
      f.paused ? `<b class="warn">TIMER PAUSED</b>` : null,
    ].filter(Boolean).map((m) => `<span>${m}</span>`).join('');
    const metaHost = $('card-meta');
    if (metaHost.innerHTML !== meta) metaHost.innerHTML = meta;

    // Console: switch drafts only when the selected fault changes.
    const input = $('code-input');
    const select = $('workers-select');
    const avail = Math.max(0, Number((mine.workforce || {}).available) || 0);
    if (consoleFor !== f.code) {
      consoleFor = f.code;
      const d = draft.get(f.code) || {};
      input.value = d.code || '';
      draft.set(f.code, d);
      select.dataset.avail = '';
    }
    const d = draft.get(f.code) || {};
    if (select.dataset.avail !== String(avail)) {
      select.dataset.avail = String(avail);
      const opts = [];
      for (let n = 0; n <= avail; n += 1) opts.push(`<option value="${n}">${n}</option>`);
      select.innerHTML = opts.join('');
      const want = d.workers !== undefined ? Number(d.workers) : Number(f.crew_required) || 0;
      select.value = String(Math.min(avail, Math.max(0, want)));
      d.workers = select.value;
      draft.set(f.code, d);
    }
    updateConsole(f);
  }

  /** Lockout / verdict text and enabled state. Called per frame and per tick. */
  function updateConsole(f) {
    const lock = lockRemaining(f);
    const dark = statusWord(mine) === 'DARK';
    const disabled = lock > 0 || dark || !!state.paused;
    const input = $('code-input');
    const select = $('workers-select');
    const btn = $('submit-btn');
    if (lastDisabled !== disabled) {
      input.disabled = disabled;
      select.disabled = disabled;
      btn.disabled = disabled;
      const wasLocked = lastDisabled === true;
      lastDisabled = disabled;
      if (!disabled && wasLocked) input.focus();
    }
    $('console').classList.toggle('locked', lock > 0);

    const msgEl = $('console-msg');
    let cls = '';
    let text = '';
    if (dark) {
      cls = 'bad'; text = 'SECTOR IS DARK — CONSOLE DISABLED';
    } else if (lock > 0) {
      cls = 'locked'; text = `CONSOLE LOCKED ${U.mmss(lock)} — verify the procedure before retrying`;
    } else {
      let v = verdict.get(f.code);
      // The verdict that caused a lockout is spent once the lock clears.
      if (v && v.locked_until_s) { verdict.delete(f.code); v = null; }
      if (v && !v.accepted) {
        cls = 'bad';
        switch (v.reason) {
          case 'invalid_code': {
            const n = consecutive.get(f.code) || 0;
            const max = Number(v.max_consecutive) || 3;
            text = `INVALID RESOLUTION CODE — ATTEMPTS: ${n} / ${max}  (TOTAL ${v.attempts})`;
            break;
          }
          case 'insufficient_crew':
            text = `Not enough crew assigned (needs ${v.crew_required}, ${v.workforce_active} available).`;
            break;
          case 'insufficient_resources':
            text = `Insufficient resources: ${Object.entries(v.short || {}).map(([k, n]) => `${n} ${(RES[k] || { name: k }).name}`).join(', ') || 'see binder'}`;
            break;
          // Driven by an empty valid_codes array, never by the fault code (§3).
          case 'no_procedure':  text = 'No matching procedure. Verify this alert.'; break;
          case 'sector_dark':   text = 'Sector is dark.'; break;
          case 'locked':        text = 'Console locked — wait for the timer.'; break;
          case 'unknown_fault': text = 'That fault is not active here.'; break;
          default:              text = 'REJECTED.';
        }
      }
    }
    if (msgEl.textContent !== text) msgEl.textContent = text;
    const mcls = `console-msg ${cls}`;
    if (msgEl.className !== mcls) msgEl.className = mcls;
  }

  // -- right column -----------------------------------------------------------

  function renderCity() {
    setText($('delay-note'), state.full_telemetry ? 'FULL TELEMETRY' : '60s DELAY');
    const host = $('city');
    for (const [code, s] of Object.entries(state.sectors)) {
      if (code === SECTOR) continue;
      let row = cityRows.get(code);
      if (!row) {
        row = document.createElement('div');
        row.className = 'city-row';
        row.innerHTML =
          `<div class="c-top"><span class="c-name">${U.SECTOR_GLYPH[code] || ''} ${esc(s.name)}</span>` +
          `<span class="c-val"><b class="c-int"></b> <span class="c-status"></span></span></div>` +
          `<div class="bar"><i></i></div><div class="c-faults" hidden></div>`;
        cityRows.set(code, row);
        host.appendChild(row);
      }
      const value = Math.round(s.integrity);
      setText(row.querySelector('.c-int'), `${value}%`);
      const word = statusWord(s);
      const st = row.querySelector('.c-status');
      setText(st, word);
      st.dataset.status = word;
      const bar = row.querySelector('.bar');
      const cls = `bar ${U.integrityClass(value)}`;
      if (bar.className !== cls) bar.className = cls;
      bar.firstElementChild.style.width = `${Math.max(0, Math.min(100, value))}%`;
      // COM alone sees which faults are live elsewhere — the asymmetry engine.
      const fh = row.querySelector('.c-faults');
      const faults = (s.faults || []).map((f) =>
        `<span class="c-fault sev-${f.severity}" title="${esc(f.name)}">${esc(f.code)} ${U.severityPips(f.severity)}</span>`).join('');
      if (fh.innerHTML !== faults) fh.innerHTML = faults;
      show(fh, !!faults);
    }
  }

  function renderAnnouncements() {
    const host = $('announcements');
    const list = state.announcements || [];
    const html = list.length
      ? list.map((a) => {
        const t = a.t ? new Date(a.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        return `<div class="announcement"><span class="t">${esc(t)}${a.sector ? ' · ' + esc(a.sector) : ''}</span>${esc(a.text)}</div>`;
      }).join('')
      : '<div class="empty">Nothing yet.</div>';
    if (host.innerHTML !== html) host.innerHTML = html;
  }

  function effectLabel(e) {
    switch (e.kind) {
      case 'no_production': return 'NO PRODUCTION NEXT CYCLE';
      case 'trn_capacity':  return 'TRANSPORT CAPACITY REDUCED';
      case 'com_blind':     return 'TELEMETRY OFFLINE';
      default:              return String(e.kind || 'EFFECT').toUpperCase().replace(/_/g, ' ');
    }
  }

  function renderEffects() {
    const list = (state.effects || []).filter((e) => e.target === SECTOR || e.target === 'ALL');
    const host = $('effects');
    const html = list.map((e) =>
      `<div class="effect" data-id="${esc(e.id)}"><span>${effectLabel(e)}</span>` +
      `<b class="clock ef-clock">${e.cycles_remaining !== undefined && e.remaining_s == null ? esc(`${e.cycles_remaining} CYCLE${e.cycles_remaining === 1 ? '' : 'S'}`) : ''}</b></div>`).join('');
    if (host.dataset.sig !== html) { host.dataset.sig = html; host.innerHTML = html; }
    show($('effects-panel'), list.length > 0);
  }

  /**
   * RESOURCE APPROVAL QUEUE — Transport only. The server sends this to nobody
   * else, so no other screen can render an APPROVE control. Transfers waiting
   * on us, the approvals left this round, and the two gates before approval:
   * the paper chit in our hand, and the supplier still holding the goods.
   */
  function renderQueue() {
    const q = state.transfer_queue;
    show($('queue-panel'), !!q);
    if (!q) return;
    const full = q.used >= q.capacity;
    const left = Math.max(0, (q.remaining !== undefined ? q.remaining : q.capacity - q.used));
    const period = String(q.basis || 'round').toUpperCase();
    setText($('queue-cap'), `${q.used}/${q.capacity} USED · ${left} LEFT THIS ${period}`);
    $('queue-cap').classList.toggle('warn', full);

    const host = $('queue');
    const seen = new Set();
    (q.items || []).forEach((t, i) => {
      seen.add(t.id);
      let row = queueRows.get(t.id);
      if (!row) {
        row = document.createElement('div');
        row.className = 'q-row';
        row.innerHTML =
          `<span class="q-n"></span><span class="q-text"></span>` +
          `<b class="q-wait clock"></b>` +
          `<div class="q-btns">` +
          `<button type="button" class="q-chit">CHIT</button>` +
          `<button type="button" class="q-stamp">APPROVE</button>` +
          `<button type="button" class="q-no">DECLINE</button></div>`;
        row.querySelector('.q-chit').addEventListener('click', () => confirmChit(t.id, !row.dataset.chit || row.dataset.chit === 'no'));
        row.querySelector('.q-stamp').addEventListener('click', () => approveTransfer(t.id));
        row.querySelector('.q-no').addEventListener('click', () => declineTransfer(t.id));
        queueRows.set(t.id, row);
      }
      if (host.children[i] !== row) host.insertBefore(row, host.children[i] || null);
      row.dataset.since = t.requested_at || '';
      row.dataset.chit = t.chit_confirmed ? 'yes' : 'no';
      setText(row.querySelector('.q-n'), `${i + 1}.`);
      setText(row.querySelector('.q-text'),
        `${t.from} → ${t.to} · ${t.amount} ${resName(t.resource)}${t.request_id ? ' · ON REQUEST' : ''}`);

      const chitBtn = row.querySelector('.q-chit');
      const needsChit = q.requires_chit !== false;
      show(chitBtn, needsChit);
      chitBtn.classList.toggle('on', !!t.chit_confirmed);
      setText(chitBtn, t.chit_confirmed ? 'CHIT ✓' : 'CHIT');
      chitBtn.title = t.chit_confirmed
        ? 'Signed chit received — click to withdraw'
        : 'Confirm the signed paper chit is in your hand';

      const btn = row.querySelector('.q-stamp');
      const chitMissing = needsChit && !t.chit_confirmed;
      const shortStock = t.supplier_ok === false;
      btn.disabled = !q.can_stamp || full || chitMissing || shortStock;
      btn.title = !q.can_stamp ? 'Transport is dark'
        : full ? `No approvals left this ${period.toLowerCase()}`
          : chitMissing ? 'Physical Transfer Chit not confirmed'
            : shortStock ? 'Supplier no longer has the stock'
              : 'Approve this transfer — stock moves now';
      row.classList.toggle('blocked', shortStock);
    });
    for (const [id, row] of queueRows) {
      if (!seen.has(id)) { row.remove(); queueRows.delete(id); }
    }
    const waiting = Number(q.awaiting_acceptance) || 0;
    const noteHtml = !q.items || !q.items.length
      ? `<div class="empty" data-empty>Queue empty.${waiting ? ` ${waiting} request${waiting === 1 ? '' : 's'} not yet answered by a supplier.` : ''}</div>`
      : full ? `<div class="empty warn" data-empty>NO APPROVALS LEFT THIS ${period}</div>`
        : !q.can_stamp ? '<div class="empty warn" data-empty>TRANSPORT DARK — CANNOT APPROVE</div>' : '';
    let note = host.querySelector('[data-empty]');
    if (noteHtml) {
      if (!note) { host.insertAdjacentHTML('beforeend', noteHtml); }
      else if (note.outerHTML !== noteHtml) { note.outerHTML = noteHtml; }
    } else if (note) note.remove();

    // Transport is told when something new needs it, the same as a supplier is.
    const items = q.items || [];
    const fresh = items.filter((t) => !queueSeen.has(t.id));
    for (const t of items) queueSeen.add(t.id);
    for (const id of [...queueSeen]) if (!items.some((t) => t.id === id)) queueSeen.delete(id);
    if (fresh.length) {
      const t = fresh[0];
      notifyArrival(`TRANSFER WAITING — ${t.from} → ${t.to}, ${t.amount} ${resName(t.resource)}`);
    }
  }

  function renderIntel() {
    const intel = state.intel;
    show($('intel-panel'), !!intel);
    if (!intel) return;
    show($('intel-degraded'), !!intel.degraded);
    const html = (intel.items || []).map((i) => {
      const unknown = String(i.value).toUpperCase() === 'UNKNOWN';
      return `<div class="intel-row${unknown ? ' unknown' : ''}"><span class="i-label">${esc(i.label || i.key)}</span><b class="i-val">${esc(i.value)}</b></div>`;
    }).join('') || '<div class="empty">No intelligence on file.</div>';
    const host = $('intel');
    if (host.innerHTML !== html) host.innerHTML = html;
  }

  function renderResolved() {
    const list = (mine.recently_resolved || []).slice().reverse();
    show($('resolved-block'), list.length > 0);
    // RESOLVED by the team; CLEARED by the facilitator; FAILED at a deadline.
    const html = list.map((f) => `<div class="resolved-row"><span>${esc(f.code)}</span><span class="r-name">${esc(f.name)}</span><span class="r-st">${esc(f.status === 'RESOLVED' || !f.status ? 'RESOLVED' : f.status)}</span></div>`).join('');
    const host = $('resolved');
    if (host.innerHTML !== html) host.innerHTML = html;
  }

  // -- local tick: countdown text nodes only ---------------------------------

  function tick() {
    if (!state || !mine) return;
    const frozen = !!state.frozen;

    // Header + upkeep share the cycle clock.
    const cyc = U.countdown(state.cycle, frozen);
    const cycText = state.cycle && state.cycle.running === false && !frozen && cyc <= 0 ? 'HOLD' : U.mmss(cyc);
    setText($('hdr-cycle'), cycText);
    setUrgency($('hdr-cycle'), cyc, true);
    setText($('upkeep-due'), cycText);
    setUrgency($('upkeep-due'), cyc, true);

    setText($('hdr-round-clock'), U.mmss(U.countdown(state.round_clock, frozen)));
    const council = U.countdown(state.council_clock, frozen);
    setText($('council-clock'), U.mmss(council));
    setUrgency($('council-clock'), council, true);
    setText($('banner-council-clock'), U.mmss(council));

    // Fault list deadlines.
    for (const f of mine.faults || []) {
      const row = faultRows.get(f.code);
      if (!row) continue;
      const dl = row.querySelector('.fr-dl');
      setText(dl, deadlineText(f));
      const rem = faultRemaining(f);
      setUrgency(dl, rem, hasDeadline(f) && !f.expired);
      dl.classList.toggle('passed', !!f.expired);
    }

    // Open card.
    const f = selectedFault();
    if (f) {
      const el = $('card-deadline');
      const pen = $('card-penalty');
      if (f.expired) {
        setText($('card-time-label'), 'Deadline');
        setText(el, 'DEADLINE PASSED');
        setText(pen, `−${Number(f.integrity_penalty) || 0} INTEGRITY`);
        show(pen, true);
        setUrgency(el, 0, true);
        el.classList.add('passed');
      } else {
        setText($('card-time-label'), hasDeadline(f) ? 'Time remaining' : 'Deadline');
        setText(el, hasDeadline(f) ? U.mmss(faultRemaining(f)) : 'NONE');
        show(pen, false);
        setUrgency(el, faultRemaining(f), hasDeadline(f));
        el.classList.remove('passed');
      }
      updateConsole(f);
    }

    // Alert: full-screen for its first seconds, then a persistent banner.
    if (alertSeen) {
      const age = alertSeen.age + (performance.now() - alertSeen.at) / 1000;
      const full = alertSeen.full && age < (alertSeen.fullS || ALERT_FULL_S);
      show($('alert-full'), full);
      show($('banner-alert'), !full);
    }

    // Result banner expiry.
    if (resultBanner && performance.now() > resultBanner.until) {
      resultBanner = null;
      show($('banner-result'), false);
    }

    // The inbound-request banner retires; the card itself stays until answered.
    if (requestBannerUntil && performance.now() > requestBannerUntil) {
      requestBannerUntil = 0;
      show($('banner-request'), false);
    }

    // TRN queue waiting times.
    const now = Date.now();
    for (const row of queueRows.values()) {
      const since = Date.parse(row.dataset.since);
      const wait = Number.isFinite(since) ? Math.max(0, (now - since) / 1000) : 0;
      setText(row.querySelector('.q-wait'), `WAITING ${U.mmss(wait)}`);
    }

    // Effects with a running clock.
    const effects = (state.effects || []);
    for (const el of $('effects').children) {
      const e = effects.find((x) => x.id === el.dataset.id);
      if (!e || e.remaining_s == null) continue;
      setText(el.querySelector('.ef-clock'), U.mmss(U.countdown({ running: true, remaining_s: e.remaining_s }, frozen)));
    }
  }

  init();
})();
