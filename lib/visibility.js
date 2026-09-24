'use strict';
/**
 * Per-role state projection — THE SECURITY BOUNDARY.
 *
 * Filtering happens here, on the server, and never in CSS. Participants will
 * open devtools (contract §2), so anything a sector client must not know must
 * not be in the frame sent to that client.
 *
 * Four projections:
 *   sector            own sector full; others integrity+status only, 60s stale
 *   sector (COM)      as above, plus other sectors' fault codes/names LIVE,
 *                     plus the CITY INTELLIGENCE feed (hidden under brownout)
 *   sector (TRN)      as above, plus the TRANSFER QUEUE and its capacity
 *   bigscreen / wall  integrity/status word/workforce/feed/telemetry, COM's
 *                     reported board and open movement; the worst active
 *                     fault is configurable (wall_shows_faults) and hidden
 *                     while COM is dark; NEVER real inventory, an aggregate
 *                     city figure, an answer key, procedure or dependency clause
 *   control           everything, undelayed, plus valid_codes (the answer key)
 *
 * COM's exception is scoped to *what is broken*, not *how to fix it* and not
 * *how much they hold* — and COM's view of the bars stays on the same 60 s
 * delay as everyone else's.
 */

const economy = require('./economy');
const { WALL_KINDS } = require('./state');

/**
 * The half of a flavour line a participant is allowed to read.
 *
 * Flavour lines are written "SYMPTOM; needs X from Y". The printed fault card
 * prints the symptom ONLY (tools/kit/build_cards.js), because the dependency
 * half is the lookup the team is supposed to earn by talking to another
 * sector — and on the six Appendix C faults it names the buried spec outright,
 * which would kill the frustration-tolerance probe the binder is built around
 * (spec §4.1 p.10).
 *
 * The screen must not hand over what the paper withholds, so the same cut is
 * applied here, server-side, before the text is ever sent. The facilitator's
 * own view keeps the full line.
 */
function cardFlavour(flavour, showDependency) {
  if (showDependency || !flavour) return flavour;
  const symptom = String(flavour).split(';')[0].trim();
  if (!symptom) return flavour;
  return symptom.endsWith('.') ? symptom : `${symptom}.`;
}

const ceilOrNull = (v) => (v === null || v === undefined ? null : Math.ceil(v));

/** Fault as its own sector sees it: no answer key, no dependency half. */
function ownFault(f, showDependency = false, game = null) {
  return {
    id: f.id,
    code: f.code,
    name: f.name,
    // The symptom only. The dependency half of the line names the sector that
    // holds the answer, which is the facilitator's to know, never the table's.
    flavour: showDependency ? f.flavour : cardFlavour(f.flavour, false),
    severity: f.severity,
    decay_per_min: f.decay_per_min,
    attempts: f.attempts,
    wrong_code_attempts: Number(f.wrong_code_attempts ?? 0),
    locked_until_s: Math.ceil(f.locked_until_s),
    status: f.status,
    fired_at: f.fired_at,
    opened_at: f.opened_at,
    resolved: f.resolved,
    resolved_at: f.resolved_at,
    // What finishing this fault pays, in the player's words; whether it has been paid.
    reward: game ? game.rewardPreview(f) : null,
    reward_claimed: !!(game && game.state.rewards_claimed[f.id]),
    paused: f.paused,
    triggered_by: f.triggered_by,
  };
}

/** Fault as the facilitator sees it: everything, including valid_codes. */
function controlFault(f, game) {
  return {
    ...ownFault(f, true, game),   // the facilitator reads the whole line
    flavour: f.flavour,
    crew_required: f.crew_required,
    resources_required: f.resources_required,

    valid_codes: f.valid_codes,
    false_alarm: f.false_alarm,
    procedure: f.procedure,
    reward_tier: f.reward ? f.reward.tier : null,
    reward_rvu: f.reward ? f.reward.rvu : null,
    reward_pending: !!(f.reward && f.reward.pending),
    reward_applied: !!f.reward_applied,
    reward_reserved: Number(f.reward_resource_units_reserved || 0),
    reward_target_rvu: f.reward ? f.reward.reward_target_rvu : null,
    reward_profile: f.reward ? f.reward.case_profile : null,
    difficulty_score: f.reward ? f.reward.difficulty_score : null,
    issued_round: f.issued_round || null,
    material_units: Number(f.material_units || 0),
    resources_consumed_units: f.resources_consumed ? Object.values(f.resources_consumed).reduce((a, v) => a + v, 0) : 0,
    cross_sector: !!f.cross_sector,
    consecutive_invalid: f.consecutive_invalid,
    lockouts: f.lockouts,
    first_action_at: f.first_action_at,
    resources_consumed: f.resources_consumed,
    cleared_by_facilitator: !!f.cleared_by_facilitator,
  };
}

/** What COM learns about somebody else's fault: that it exists, and its name. */
function comFault(f) {
  return { code: f.code, name: f.name, severity: f.severity, resolved: f.resolved };
}

/** The wall names the worst live fault and its clock — never the fix. */
function wallFault(f) {
  return {
    code: f.code, name: f.name, severity: f.severity,
  };
}

function worstFault(s) {
  const live = s.faults.filter((f) => !f.resolved);
  if (!live.length) return null;
  live.sort((a, b) => (b.severity !== a.severity ? b.severity - a.severity : Date.parse(a.fired_at || 0) - Date.parse(b.fired_at || 0)));
  return live[0];
}

/**
 * What the city actually delivers this cycle. A brownout sector is on half
 * rations (spec §3.6) — the server computes the figure so the team and the
 * facilitator read the same number.
 */
function upkeepDelivery(game, s) {
  return economy.upkeepFor(game, s);
}

function lowResources(game, s) {
  const thresholds = game.cfg.resource_min_thresholds || {};
  const out = {};
  for (const [k, v] of Object.entries(s.inventory)) {
    out[k] = v <= 0 || v < Number(thresholds[k] ?? 0);
  }
  return out;
}

/** COM's named risk, as the wall and COM's own console each need it. */
function priorityView(game, forCom) {
  const p = game.state.broadcast ? game.state.broadcast.priority : null;
  const out = { current: p ? { category: p.category, label: p.label, period: p.period } : null };
  if (forCom && game.comPriorityView) {
    const v = game.comPriorityView();
    if (v) { out.categories = v.categories; out.ready = v.ready; out.ready_in_s = v.ready_in_s; out.cooldown_s = v.cooldown_s; }
  }
  return out;
}

function workforceView(game, s) {
  return {
    ...s.workforce,
    committed: { ...(s.workforce.committed || {}) },
    committed_total: game.committedWorkers(s),
    available: game.availableWorkers(s),
    total: s.workforce.active + s.workforce.injured + s.workforce.loaned,
  };
}

/**
 * ROUND OUTPUT for a producing sector: the entitlement, what pressing
 * GENERATE would add right now (brownout, core, a supply delay), and whether
 * this round's output is already in the tray. Null for a sector with no
 * production line, so its screen never grows a production panel.
 */
function roundOutputView(game, s) {
  const base = s.production || {};
  if (!Object.keys(base).length) return null;
  const manual = game.cfg.round_output_manual !== false;
  const used = !!(s.round_output && s.round_output.round === game.periodKey());
  const amount = economy.productionFor(game, s);
  const reduced = Object.entries(base).some(([k, v]) => (amount[k] || 0) < Number(v));
  return {
    manual,
    used,
    base: { ...base },
    amount,
    added: used ? { ...s.round_output.added } : null,
    reduced,
    core_output: Math.round(game.state.core_integrity),
    available: manual && !used && s.status !== 'DARK' && !game.frozen && Object.values(amount).some((v) => v > 0),
  };
}

/** NEXT CYCLE UPKEEP readiness, from the sector's real stock and nothing else. */
function upkeepReadiness(game, s) {
  const need = upkeepDelivery(game, s);
  const short = {};
  for (const [k, v] of Object.entries(need)) {
    const gap = Math.max(0, Number(v) - (Number(s.inventory[k]) || 0));
    if (gap > 0) short[k] = gap;
  }
  return { upkeep_status: Object.keys(short).length ? 'SHORTFALL' : 'READY', upkeep_short: short };
}

/**
 * RESOURCE REQUESTS & TRANSFERS, as one table sees them (2026-09-18). Every
 * request and transfer the sector is party to becomes one card with a
 * player-facing label and a direction relative to THIS sector. A request
 * that has been fulfilled lives on as its linked transfer: it leaves ACTIVE
 * and waits in HISTORY as SUPPLIER ACCEPTED, so one movement is never two
 * cards. ACTIVE is oldest first; HISTORY newest first, bounded. The engine's
 * status names are untouched; only the words and the grouping are new.
 */
const REQUEST_LABEL = {
  REQUESTED: 'WAITING FOR SUPPLIER', TRANSFER_CREATED: 'SUPPLIER ACCEPTED',
  DECLINED_BY_SUPPLIER: 'DECLINED', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED',
};
const TRANSFER_LABEL = {
  PENDING_TRN_APPROVAL: 'WAITING FOR TRN', APPROVED: 'APPROVED BY TRN', DELIVERED: 'DELIVERED',
  DECLINED_BY_TRN: 'TRN DECLINED', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED',
};
const HISTORY_MAX = 20;

/**
 * RESOURCE REQUESTS (v20, 2026-09-20) — one journey, not two records.
 *
 * A table asks; the supplier answers; the answer raises a transfer; Transport
 * approves it. Underneath those are still a request record and a linked
 * transfer record, each with its own id, its own rules and its own audit
 * trail. Above, a table sees ONE card that keeps the request's reference for
 * the whole journey and only changes its words:
 *
 *   WAITING FOR SUPPLIER → WAITING FOR TRN → DELIVERED
 *                        ↘ DECLINED       ↘ TRN DECLINED
 *
 * Direction is the STOCK's, for the whole journey: OUTGOING while the goods
 * would leave us, INCOMING while they would arrive. A supplier's card is
 * therefore OUTGOING from the moment the ask lands, and `action_required`
 * (not the filter) is what says the table must answer it.
 *
 * A transfer with no request behind it — raised by the facilitator, or left
 * over from before v20 — keeps its own card so it can still be finished.
 */
function journeyStage(r, t) {
  if (r.status === 'REQUESTED') return { stage: 'REQUEST', state: 'WAITING_FOR_SUPPLIER', active: true };
  if (r.status === 'DECLINED_BY_SUPPLIER') return { stage: 'CLOSED', state: 'DECLINED', active: false };
  if (r.status === 'CANCELLED') return { stage: 'CLOSED', state: 'CANCELLED', active: false };
  if (r.status === 'EXPIRED') return { stage: 'CLOSED', state: 'EXPIRED', active: false };
  if (!t) return { stage: 'CLOSED', state: 'CANCELLED', active: false };
  switch (t.status) {
    case 'PENDING_TRN_APPROVAL': return { stage: 'TRANSFER', state: t.delayed ? 'DELAYED' : 'WAITING_FOR_TRN', active: true };
    case 'APPROVED':             return { stage: 'TRANSFER', state: t.delayed ? 'DELAYED' : 'APPROVED', active: false };
    case 'DELIVERED':            return { stage: 'CLOSED', state: 'DELIVERED', active: false };
    case 'DECLINED_BY_TRN':      return { stage: 'CLOSED', state: 'TRN_DECLINED', active: false };
    case 'EXPIRED':              return { stage: 'CLOSED', state: 'EXPIRED', active: false };
    default:                     return { stage: 'CLOSED', state: 'CANCELLED', active: false };
  }
}

const JOURNEY_LABEL = {
  WAITING_FOR_SUPPLIER: 'WAITING FOR SUPPLIER', WAITING_FOR_TRN: 'WAITING FOR TRN',
  APPROVED: 'APPROVED BY TRN', DELIVERED: 'DELIVERED', DECLINED: 'DECLINED',
  TRN_DECLINED: 'TRN DECLINED', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED',
};

const laterOf = (...xs) => xs.filter(Boolean).sort((p, q) => (Date.parse(q) || 0) - (Date.parse(p) || 0))[0] || null;

function movementFor(game, code) {
  const cards = [];
  for (const r of game.state.requests) {
    if (r.supplier !== code && r.requester !== code) continue;
    const t = r.transfer_id ? game.findTransfer(r.transfer_id) : null;
    const { stage, state, active } = journeyStage(r, t);
    const supplying = r.supplier === code;
    const actionRequired = active && stage === 'REQUEST' && supplying;
    const canAccept = actionRequired && (game.cfg.enforce_supplier_stock === false
      || game.supplierAvailable({ from: r.supplier, resource: r.resource }) >= r.amount);
    cards.push({
      kind: 'journey', id: r.id, request_id: r.id, transfer_id: t ? t.id : null,
      // the old field name, kept so nothing that reads a card's link breaks
      linked_id: t ? t.id : null,
      stage, from: r.supplier, to: r.requester, resource: r.resource, amount: r.amount,
      status: state, request_status: r.status, transfer_status: t ? t.status : null,
      label: JOURNEY_LABEL[state] || state,
      // the stock's direction, the whole way: out of the supplier, into the requester
      direction: supplying ? 'OUTGOING' : 'INCOMING',
      active, action_required: actionRequired,
      can_accept: canAccept, can_fulfill: canAccept,
      can_withdraw: active && stage === 'REQUEST' && r.requester === code,
      at: r.requested_at, updated_at: laterOf(t && t.updated_at, r.updated_at) || r.requested_at,
    });
  }
  // A transfer nobody asked for: the facilitator raised it, or it predates v20.
  for (const t of game.state.transfers) {
    if (t.request_id) continue;
    if (t.from !== code && t.to !== code) continue;
    const active = t.status === 'PENDING_TRN_APPROVAL';
    cards.push({
      kind: 'transfer', id: t.id, request_id: null, transfer_id: t.id, linked_id: null,
      stage: active ? 'TRANSFER' : 'CLOSED',
      from: t.from, to: t.to, resource: t.resource, amount: t.amount,
      status: t.status, request_status: null, transfer_status: t.status,
      label: TRANSFER_LABEL[t.status] || t.status,
      direction: t.from === code ? 'OUTGOING' : 'INCOMING',
      active, action_required: false, can_accept: false, can_fulfill: false, can_withdraw: false,
      legacy: true,
      at: t.created_at || t.requested_at, updated_at: t.updated_at || t.created_at || t.requested_at,
    });
  }
  const ts = (x) => Date.parse(x) || 0;
  // Ids share one counter across requests and transfers, so their number is
  // the true order when two things happen in the same millisecond.
  const num = (id) => Number(String(id).replace(/\D/g, '')) || 0;
  const active = cards.filter((c) => c.active).sort((a, b) => (ts(a.at) - ts(b.at)) || (num(a.id) - num(b.id)));
  const closed = cards.filter((c) => !c.active).sort((a, b) => (ts(b.updated_at) - ts(a.updated_at)) || (num(b.id) - num(a.id)));
  return { active, history: closed.slice(0, HISTORY_MAX), history_total: closed.length };
}

function ownSector(game, s, showDependency) {
  return {
    code: s.code,
    name: s.name,
    colour: s.colour,
    integrity: Math.round(s.integrity),
    status: s.status,
    status_word: game.statusWord(s),
    brownout: s.status === 'BROWNOUT',
    dark: s.status === 'DARK',
    workforce: workforceView(game, s),
    generator: game.generatorView ? game.generatorView(s.code) : null,
    emergency_restart: game.emergencyRestartView ? game.emergencyRestartView(s.code) : null,
    brownout_choice: game.brownoutView ? game.brownoutView(s.code) : null,
    inventory: { ...s.inventory },
    low: lowResources(game, s),
    production_next: economy.productionFor(game, s),
    round_output: roundOutputView(game, s),
    upkeep_per_round: { ...s.upkeep_per_round },
    upkeep_delivery: upkeepDelivery(game, s),
    ...upkeepReadiness(game, s),
    // Upkeep falls due at the end of the operating cycle: the cycle clock is
    // the upkeep clock, and it runs straight through every phase change.
    upkeep_due_in_s: Math.ceil(game.state.cycle.remaining_s),
    faults: s.faults.filter((f) => !f.resolved).map((f) => ({
      ...ownFault(f, showDependency, game),
      // v17: whether the tray is ready — never which materials, unless the scenario is in training mode.
      materials_ready: game.materialsReady(s.code, f),
      ...(game.cfg.training_mode ? { requirements: { crew: f.crew_required, materials: { ...f.resources_required } } } : {}),
    })),
    // A resolved fault whose reward still waits for the table's choice.
    reward_choices: s.faults.filter((f) => f.reward && f.reward.pending && !game.state.rewards_claimed[f.id])
      .map((f) => ({ id: f.id, code: f.code, name: f.name, reward: game.rewardPreview(f) })),
    recently_resolved: s.faults.filter((f) => f.resolved).slice(-5)
      .map((f) => ownFault(f, showDependency, game)),
  };
}

function clockView(game, clk) {
  return { running: !!clk.running && !game.frozen, remaining_s: Math.ceil(clk.remaining_s) };
}

function alertView(game) {
  const a = game.state.alert;
  if (!a || a.dismissed) return null;
  const age = Math.max(0, (Date.now() - Date.parse(a.t)) / 1000);
  const fullS = Number(game.cfg.alert_full_screen_s ?? 8);
  return {
    id: a.id, title: a.title, subtitle: a.subtitle, big: a.big, t: a.t,
    age_s: Math.round(age),
    full_s: fullS,
    full_screen: age < fullS,
  };
}

function transferView(t) {
  return { ...t };
}

function envelope(game, extra, { facilitator = false } = {}) {
  const st = game.state;
  const phase = game.phaseConfig();
  const round = game.roundConfig();
  const c = st.council;
  return {
    type: 'state',
    server_time: new Date().toISOString(),
    run_id: st.run_id,
    scenario_id: st.scenario_id,
    scenario_name: st.scenario_name,
    mode: st.mode,
    /*
      WHAT A SCREEN IS TOLD ABOUT THE ROUND (2026-09-21).

      One number, 0 to 4, to everybody. No name, no subtitle, no objective and
      no phase: the room reads "Round 2" and learns nothing about what Round 2
      is going to do to it. The ids below go to the facilitator alone, and they
      are for navigation and the log — no screen prints them either.
    */
    round_number: game.roundOrdinal(),
    round_clock: clockView(game, st.round_clock),      // MASTER TIME, under its old key
    master_clock: clockView(game, st.round_clock),
    council_clock: clockView(game, st.council_clock),
    period_number: st.cycle.number,
    cycle: {
      number: st.cycle.number,
      length_s: st.cycle.length_s,
      remaining_s: Math.ceil(st.cycle.remaining_s),
      running: !!st.cycle.running && !game.frozen,
    },
    paused: !!st.paused,
    frozen: game.frozen,
    ...(facilitator ? {
      phase: st.phase,
      round: st.round,
      round_length_s: round.length_s,
      live_length_s: game.liveLength(),
    } : {}),
    core_output: Math.round(st.core_integrity),
    core_integrity: Math.round(st.core_integrity),
    // The city-wide stability score is the facilitator's instrument. No
    // participant screen — wall or laptop — is sent an aggregate city figure.
    ...(facilitator ? { city_stability: Math.round(st.city_stability), stability_mode: (game.cfg.stability || {}).mode || 'auto' } : {}),
    council: {
      active: c.active, count: c.count, started_at: c.started_at,
      order_submitted: !!c.order, no_order: !!c.no_order,
    },
    continuity_order: st.continuity_order
      ? { order: st.continuity_order.order, brownout: st.continuity_order.brownout, t: st.continuity_order.t }
      : null,
    blackout: { active: st.blackout.active, current: [...st.blackout.current] },
    alert: alertView(game),
    sound_enabled: !!st.sound_enabled,
    thresholds: { ...(game.cfg.resource_min_thresholds || {}) },
    ...extra,
  };
}

/** Ticker entries a given audience may see. */
function tickerFor(game, { sector = null, wall = false, all = false }) {
  return game.state.ticker.filter((e) => {
    if (all) return true;
    if (wall) return !e.scope && WALL_KINDS.has(e.kind);
    return !e.scope || e.scope === sector;
  });
}

function announcementsFor(game, sector) {
  return game.state.announcements.filter((a) => !a.sector || (sector && a.sector === sector));
}

function effectsFor(game, sector) {
  return game.state.effects
    .filter((e) => e.target === 'ALL' || e.target === sector)
    .map((e) => ({ id: e.id, kind: e.kind, target: e.target, remaining_s: ceilOrNull(e.remaining_s), cycles_remaining: e.cycles_remaining }));
}

/**
 * COM's public board, as every screen sees it. Reported values with a ROUND
 * stamp and a freshness word — never a clock time, never live inventory.
 */
function broadcastFor(game, { editable = false, full = true } = {}) {
  const b = game.state.broadcast || game.emptyBroadcast();
  // A table that is not COM gets the round and one fact — that an
  // announcement exists — and nothing of the board. The board is on the wall.
  if (!full) {
    const a = b.announcement || {};
    return {
      round: game.periodKey(),
      round_number: game.roundNumber(),
      editable: false,
      announcement_active: !!(a.headline || a.message),
      priority: priorityView(game, false),
      // Emphasis is public by nature: every screen that draws the map needs to
      // know which sector COMM is pointing at.
      focus: game.focusView ? game.focusView() : null,
    };
  }
  const rows = {};
  for (const [code, row] of Object.entries(b.rows || {})) {
    rows[code] = {
      ...row,
      round_number: row.round === null ? null : game.roundNumber(row.round),
      // The round the report was filed in, 0-4, for the card's R# tag. Derived
      // from the row's own stamp and never from the round the game is in now.
      report_round_number: row.report_round === null || row.report_round === undefined
        ? null : game.roundOrdinal(row.report_round),
      freshness: game.broadcastFreshness(row.round),
    };
  }
  const a = b.announcement || {};
  const live = !!(a.headline || a.message);
  return {
    round: game.periodKey(),
    round_number: game.roundNumber(),
    rows,
    announcement: live ? {
      ...a, round_number: a.round === null ? null : game.roundNumber(a.round), freshness: game.broadcastFreshness(a.round),
    } : null,
    priority: priorityView(game, editable),
    focus: game.focusView ? game.focusView() : null,
    editable,
  };
}

/**
 * AGR's hand for the round — the three dealt cards and nothing of the deck
 * behind them. Only AGR is sent this.
 */
function agrCardsFor(game) {
  const agr = game.state.agr;
  const active = game.agrActiveSectors().map((s) => s.code);
  const offered = (agr.offered || []).map((id) => {
    const c = game.agrCard(id) || { id, title: id, summary: '', target: null, effect: {} };
    const card = { id: c.id, title: c.title, summary: c.summary, category: c.category, target: c.target || null };
    if (c.target === 'sector') card.sectors = active;
    if (c.target === 'resource_type') card.choices = { ...((c.effect || {}).choices || {}) };
    if (c.target === 'worker') card.workers = [];          // none eligible in this worker model
    if (c.effect && c.effect.type === 'health_lowest') card.ties = game.agrLowestSectors();
    return card;
  });
  return {
    round: agr.round,
    round_number: game.roundNumber(agr.round),
    used: !!agr.used,
    selected: agr.selected,
    target: agr.target,
    offered,
    message: agr.used
      ? 'INTERVENTION USED — New random cards will appear next round.'
      : 'Three interventions have been drawn for this round. Choose ONE.',
  };
}

function forSector(game, sectorCode) {
  const def = game.content.sectors.sectors[sectorCode];
  const fullTelemetry = !!(def && def.full_telemetry);
  const delayed = game.delayedView();
  // Mirrors CARD_SHOWS_DEPENDENCY in the card renderer; both default to off.
  // A table's card shows the symptom only: the other half of the line names
  // the sector that holds the answer, which is the binder's to reveal.
  const showDependency = false;
  const comBlind = game.comBlind();

  const sectors = {};
  for (const [code, s] of Object.entries(game.state.sectors)) {
    if (code === sectorCode) {
      sectors[code] = ownSector(game, s, showDependency);
      continue;
    }
    // Everyone else: the 60-second-old bar, and nothing more.
    const stale = delayed[code] || { integrity: 100, status: 'ACTIVE' };
    const view = {
      code,
      name: s.name,
      colour: s.colour,
      integrity: stale.integrity,
      status: stale.status,
      status_word: stale.word || game.statusWord(stale),
      delayed: true,
    };
    // A Level 5 step needs the other sector's sign-off. The sector that must
    // give it is told what is being asked for; nobody else is.
    if (game.generatorFor && game.generatorFor(code)) {
      const g = game.generatorFor(code);
      const want = g.level + 1;
      if (game.generatorSupportFrom(code, want) === sectorCode
          && !(g.confirmation && g.confirmation.round === game.state.round)) {
        const cfg = game.generatorConfig() || {};
        view.support_request = { to_level: want, label: (cfg.support_labels || {})[code] || 'SUPPORT' };
      }
    }
    if (fullTelemetry && !comBlind) {
      // COM's asymmetric-information role: what is broken, right now.
      view.faults = s.faults.filter((f) => !f.resolved).map(comFault);
    }
    sectors[code] = view;
  }

  const extra = {
    role: 'sector',
    sector: sectorCode,
    full_telemetry: fullTelemetry && !comBlind,
    sectors,
    ticker: tickerFor(game, { sector: sectorCode }),
    announcements: announcementsFor(game, sectorCode),
    telemetry: { ...game.state.telemetry },
    // Requests we raised or were asked for; transfers we send or receive;
    // healing we asked for. Never another table's paperwork.
    requests: game.state.requests
      .filter((r) => r.supplier === sectorCode || r.requester === sectorCode)
      .slice(0, 12).map(transferView),
    transfers: game.state.transfers
      .filter((t) => t.from === sectorCode || t.to === sectorCode)
      .slice(0, 12).map(transferView),
    healing: game.state.healing
      .filter((h) => h.sector === sectorCode)
      .slice(0, 12).map(transferView),
    // The same paperwork as one card per movement, labelled and sorted for this table.
    movement: movementFor(game, sectorCode),
    // How many of our injured workers have not been put forward yet.
    unclaimed_injured: game.unclaimedInjured(sectorCode),
    // The rules this screen must honour: whether Transport needs the paper
    // chit, whether an inbound request rings, who may approve and heal.
    transfer_rules: {
      require_supplier_acceptance: game.cfg.require_supplier_acceptance !== false,
      require_physical_transfer_chit: game.cfg.require_physical_transfer_chit !== false,
      notify_supplier_with_sound: game.cfg.notify_supplier_with_sound !== false,
      enforce_supplier_stock: game.cfg.enforce_supplier_stock !== false,
      approver: 'TRN',
      healer: 'MED',
    },
    effects: effectsFor(game, sectorCode),
    broadcast: broadcastFor(game, { editable: sectorCode === 'COM', full: sectorCode === 'COM' }),
  };

  // TRANSPORT: the resource approval queue. Only Transport is sent it, so no
  // other screen can render an APPROVE control even if its code tried to.
  if (sectorCode === 'TRN') {
    const own = game.state.sectors.TRN;
    const capacity = game.trnCapacity();
    const used = game.stampsUsed();
    // Oldest first (2026-09-18): the transfer that has waited longest is at
    // the top. `transfers[]` is newest-first, so this is a stable sort on
    // creation time, id as the tie-break — never a rule, only an order.
    const pending = game.state.transfers.filter((t) => t.status === 'PENDING_TRN_APPROVAL')
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (Date.parse(a.t.created_at || a.t.requested_at || 0) - Date.parse(b.t.created_at || b.t.requested_at || 0))
        || (b.i - a.i))
      .map((x) => x.t);
    extra.transfer_queue = {
      capacity,
      used,
      remaining: Math.max(0, capacity - used),
      basis: game.stampBasis(),
      requires_chit: game.cfg.require_physical_transfer_chit !== false,
      emergency: game.trnEmergencyView ? game.trnEmergencyView() : null,
      can_stamp: own.status !== 'DARK',
      // Requests the supplier has not answered are nobody's business but theirs.
      awaiting_acceptance: game.state.requests.filter((r) => r.status === 'REQUESTED').length,
      items: pending.map((t) => ({
        ...transferView(t),
        // The reference the two tables are holding: the request that raised it.
        journey_id: t.request_id || t.id,
        // Carried over from an earlier round: a promise already made.
        delayed: !!t.delayed,
        delayed_from_round: t.delayed_from_round || null,
        // A boolean, never the number: Transport learns whether the chit can be
        // honoured, not how much the supplier is holding (contract §2).
        supplier_ok: game.supplierAvailable(t) >= t.amount,
      })),
    };
  }

  // AGRICULTURE: the round's three intervention cards. Only AGR is sent them.
  if (sectorCode === 'AGR') extra.agr_cards = agrCardsFor(game);

  // MEDICAL: the healing queue. Only Medical is sent it, and only Medical can
  // act on it. Transport has no part in healing.
  if (sectorCode === 'MED') {
    const own = game.state.sectors.MED;
    const capacity = game.medCapacity();
    const used = game.medHealsUsed();
    extra.healing_queue = {
      capacity,
      used,
      remaining: Math.max(0, capacity - used),
      can_heal: own.status !== 'DARK',
      items: game.state.healing
        .filter((h) => h.status === 'WAITING_FOR_MED')
        .map((h) => ({
          ...transferView(h),
          // Still injured? A facilitator or the cycle may have got there first.
          still_injured: (Number((game.state.sectors[h.sector] || { workforce: {} }).workforce.injured) || 0) > 0,
        })),
    };
  }

  if (fullTelemetry) {
    const com = game.state.sectors.COM;
    const brown = com && com.status === 'BROWNOUT';
    const hard = game.comHardBlind();
    extra.intel = {
      degraded: hard || brown,
      items: game.state.intel.map((i) => ({
        key: i.key, label: i.label,
        value: hard || (brown && i.hidden_in_brownout) ? 'UNKNOWN' : i.value,
      })),
    };
  }

  return envelope(game, extra);
}

/**
 * The movement the room may watch: open requests and transfers, plus any that
 * closed in the last few seconds so the wall can finish an animation. What is
 * moving and between whom — never what anyone is holding. Nothing at all when
 * the scenario keeps transfers off the wall.
 */
function wallMovement(game) {
  if (game.cfg.show_completed_transfer_on_wall === false) return { requests: [], transfers: [] };
  const now = Date.now();
  const recent = (x) => now - Date.parse(x.updated_at || x.requested_at || 0) < 20000;
  const OPEN_R = ['REQUESTED'];
  const OPEN_T = ['PENDING_TRN_APPROVAL', 'APPROVED'];
  return {
    requests: game.state.requests
      .filter((r) => OPEN_R.includes(r.status) || recent(r)).slice(0, 12)
      .map((r) => ({ id: r.id, supplier: r.supplier, requester: r.requester, resource: r.resource,
        amount: r.amount, status: r.status, updated_at: r.updated_at })),
    transfers: game.state.transfers
      .filter((t) => OPEN_T.includes(t.status) || recent(t)).slice(0, 12)
      .map((t) => ({ id: t.id, from: t.from, to: t.to, resource: t.resource, amount: t.amount,
        status: t.status, updated_at: t.updated_at, approved_at: t.approved_at, request_id: t.request_id })),
  };
}

function forBigscreen(game) {
  const cfg = game.cfg;
  const comDark = game.state.sectors.COM && game.state.sectors.COM.status === 'DARK';
  const detailHidden = comDark && !!cfg.com_dark_hides_wall_detail;
  const showFaults = !!cfg.wall_shows_faults && !detailHidden;

  const sectors = {};
  for (const [code, s] of Object.entries(game.state.sectors)) {
    const worst = worstFault(s);
    const view = {
      code,
      name: s.name,
      colour: s.colour,
      integrity: Math.round(s.integrity),
      status: s.status,
      status_word: game.statusWord(s),
      brownout: s.status === 'BROWNOUT',
      dark: s.status === 'DARK',
      workforce: {
        active: s.workforce.active, injured: s.workforce.injured,
        available: game.availableWorkers(s),
        committed: { ...(s.workforce.committed || {}) },
        committed_total: game.committedWorkers(s),
        total: s.workforce.active + s.workforce.injured + s.workforce.loaned,
      },
      generator: game.generatorFor && game.generatorFor(code)
        ? { level: game.generatorFor(code).level, max: Number((game.generatorConfig() || {}).max_level) || 5 }
        : null,
      // Count only, always — the wall names sectors, never their fix.
      unresolved_faults: s.faults.filter((f) => !f.resolved).length,
    };
    if (showFaults) view.top_fault = worst ? wallFault(worst) : null;
    sectors[code] = view;
  }

  const feed = tickerFor(game, { wall: true });
  return envelope(game, {
    role: 'bigscreen',
    sectors,
    feed: feed.slice(0, Number(cfg.wall_feed_max ?? 7)),
    ticker: feed.slice(0, 20),
    announcements: announcementsFor(game, null),
    telemetry: { ...game.state.telemetry },
    telemetry_degraded: detailHidden,
    broadcast: broadcastFor(game),
    ...wallMovement(game),
  });
}

/**
 * NEEDS ATTENTION (Admin v16): where the facilitator's eyes should go, in
 * priority order, derived only from state the engine already keeps. Each
 * item names the problem and where to open it. Nothing here is a new rule.
 */
function attentionFor(game) {
  const st = game.state;
  const out = [];
  const push = (priority, kind, text, target, sector = null) => out.push({ priority, kind, text, target, sector });
  const fmtShort = (o) => Object.entries(o).map(([k, v]) => `${v} ${k.toUpperCase()}`).join(', ');
  for (const s of Object.values(st.sectors)) {
    if (s.status === 'DARK') push(0, 'dark', `${s.code} · DARK`, { view: 'overview', sector: s.code }, s.code);
  }
  for (const s of Object.values(st.sectors)) {
    if (s.status !== 'DARK' && game.statusWord(s) === 'CRITICAL') {
      push(1, 'critical', `${s.code} · ${Math.round(s.integrity)}% HEALTH · CRITICAL`, { view: 'overview', sector: s.code }, s.code);
    }
  }
  for (const s of Object.values(st.sectors)) {
    if (s.status === 'DARK') continue;
    const r = upkeepReadiness(game, s);
    if (r.upkeep_status === 'SHORTFALL') {
      push(2, 'upkeep', `${s.code} · NEXT CYCLE UPKEEP SHORTFALL · MISSING ${fmtShort(r.upkeep_short)}`, { view: 'overview', sector: s.code }, s.code);
    }
  }
  const pending = st.transfers.filter((t) => t.status === 'PENDING_TRN_APPROVAL').length;
  if (game.trnCapacity() - game.stampsUsed() <= 0 && pending > 0) {
    push(3, 'trn', `TRN · ${game.stampsUsed()}/${game.trnCapacity()} APPROVALS USED · ${pending} TRANSFER${pending === 1 ? '' : 'S'} WAITING`, { view: 'systems', tab: 'transfers' }, 'TRN');
  }
  const waiting = st.healing.filter((h) => h.status === 'WAITING_FOR_MED').length;
  if (game.medCapacity() - game.medHealsUsed() <= 0 && waiting > 0) {
    push(4, 'med', `MED · ${game.medHealsUsed()}/${game.medCapacity()} HEALS USED · ${waiting} INJURED WAITING`, { view: 'systems', tab: 'workforce' }, 'MED');
  }
  if (game.roundNumber() >= 1) {
    const rows = Object.values((st.broadcast || {}).rows || {});
    const bad = rows.filter((r) => ['OUTDATED', 'NOT UPDATED'].includes(game.broadcastFreshness(r.round))).length;
    if (bad > 0) push(5, 'com', `COM · ${bad} OUTDATED / NOT UPDATED REPORT${bad === 1 ? '' : 'S'}`, { view: 'systems', tab: 'com' }, 'COM');
  }
  if (st.council.no_order) push(6, 'council', 'COUNCIL · NO CONTINUITY ORDER RECEIVED', { view: 'events', tab: 'council' });
  if (st.blackout && st.blackout.active) push(6, 'blackout', `ROLLING BLACKOUT ACTIVE · ${(st.blackout.current || []).join(' + ') || '—'}`, { view: 'events', tab: 'council' });
  const ready = st.timeline.filter((t) => t.status === 'READY').length;
  if (ready) push(6, 'timeline', `TIMELINE · ${ready} CUE${ready === 1 ? '' : 'S'} READY TO FIRE`, { view: 'events', tab: 'timeline' });
  if (st.core_integrity <= 60) push(6, 'core', `CORE · ${Math.round(st.core_integrity)}% OUTPUT`, { view: 'systems', tab: 'core' });
  return out.sort((a, b) => a.priority - b.priority);
}

function forControl(game) {
  const sectors = {};
  for (const [code, s] of Object.entries(game.state.sectors)) {
    sectors[code] = {
      code,
      name: s.name,
      colour: s.colour,
      integrity: Math.round(s.integrity * 10) / 10,
      status: s.status,
      status_word: game.statusWord(s),
      status_override: s.status_override,
      brownout_by: s.brownout_by,
      workforce: workforceView(game, s),
      inventory: { ...s.inventory },
      low: lowResources(game, s),
      production: { ...s.production },
      production_next: economy.productionFor(game, s),
      upkeep_per_round: { ...s.upkeep_per_round },
      upkeep_delivery: upkeepDelivery(game, s),
      ...upkeepReadiness(game, s),
      round_output: roundOutputView(game, s),
      upkeep_due_in_s: Math.ceil(game.state.cycle.remaining_s),
      faults: s.faults.map((f) => controlFault(f, game)),
      top_fault: (() => { const w = worstFault(s); return w ? wallFault(w) : null; })(),
    };
  }
  const st = game.state;
  return envelope(game, {
    role: 'control',
    sectors,
    needs_attention: attentionFor(game),
    ticker: tickerFor(game, { all: true }),
    announcements: st.announcements,
    telemetry: { ...st.telemetry },
    runbook_done: [...game.runbookDone],
    requests: st.requests.map(transferView),
    transfers: st.transfers.map(transferView),
    healing: st.healing.map((h) => ({
      ...transferView(h),
      still_injured: (Number((st.sectors[h.sector] || { workforce: {} }).workforce.injured) || 0) > 0,
    })),
    transfer_capacity: {
      capacity: game.trnCapacity(),
      used: game.stampsUsed(),
      remaining: Math.max(0, game.trnCapacity() - game.stampsUsed()),
      basis: game.stampBasis(),
      round: st.round,
    },
    broadcast: broadcastFor(game, { editable: true }),
    agr: { ...st.agr, pool: game.agrPool(), lowest: game.agrLowestSectors(), active_sectors: game.agrActiveSectors().map((s) => s.code) },
    rewards_claimed: { ...st.rewards_claimed },
    reward_budget: game.rewardBudget(),
    active_sectors: game.activeSectorCodes(),
    healing_capacity: {
      capacity: game.medCapacity(),
      used: game.medHealsUsed(),
      remaining: Math.max(0, game.medCapacity() - game.medHealsUsed()),
      round: st.round,
    },
    timeline: st.timeline.map((t) => ({ ...t })),
    round_elapsed_s: Math.floor(game.roundElapsed()),
    scheduled: st.scheduled.map((s) => ({ ...s, in_s: Math.max(0, Math.ceil(s.at_s - st.game_clock_s)) })),
    effects: st.effects.map((e) => ({ ...e, remaining_s: ceilOrNull(e.remaining_s) })),
    intel: st.intel.map((i) => ({ ...i })),
    com_blind: game.comBlind(),
    cycle_summary: st.cycle.last_summary,
    council_detail: { ...st.council },
    continuity_order_detail: st.continuity_order,
    blackout_detail: { ...st.blackout },
    // The console's round navigator. A number and an id — what it needs to
    // move and to log, and nothing it could accidentally print as a title.
    phases: (game.rounds.phases || []).map((p) => ({
      id: p.id, number: p.number ?? null, round: p.round, mode: p.mode,
    })),
    config: game.cfg,
    scenario: {
      id: game.scenario.id, name: game.scenario.name, notes: game.scenario.notes,
      sectors: game.scenario.sectors,
      events: game.scenario.events, fault_presets: game.scenario.fault_presets,
    },
  }, { facilitator: true });
}

function filterState(game, client) {
  if (client.role === 'control') return forControl(game);
  if (client.role === 'bigscreen') return forBigscreen(game);
  return forSector(game, client.sector);
}

module.exports = {
  filterState, forSector, forBigscreen, forControl, cardFlavour, worstFault,
};
