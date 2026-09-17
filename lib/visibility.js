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
 *   bigscreen / wall  integrity/status/workforce/feed/telemetry; resource
 *                     summary and the worst active fault are configurable
 *                     (wall_shows_inventory / wall_shows_faults) and hidden
 *                     while COM is dark; NEVER an answer key, procedure or
 *                     dependency clause
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
    locked_until_s: Math.ceil(f.locked_until_s),
    status: f.status,
    fired_at: f.fired_at,
    opened_at: f.opened_at,
    resolved: f.resolved,
    resolved_at: f.resolved_at,
    // What finishing this fault pays, in the player's words; whether it has been paid.
    reward: game ? game.rewardPreview(f.code) : null,
    reward_claimed: !!(game && game.state.rewards_claimed[f.code]),
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

function workforceView(game, s) {
  return {
    ...s.workforce,
    available: game.availableWorkers(s),
    total: s.workforce.active + s.workforce.injured + s.workforce.loaned,
  };
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
    inventory: { ...s.inventory },
    low: lowResources(game, s),
    production_next: economy.productionFor(game, s),
    upkeep_per_round: { ...s.upkeep_per_round },
    upkeep_delivery: upkeepDelivery(game, s),
    upkeep_due_in_s: Math.ceil(game.state.cycle.remaining_s),
    faults: s.faults.filter((f) => !f.resolved).map((f) => ownFault(f, showDependency, game)),
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

function envelope(game, extra) {
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
    phase: st.phase,
    phase_name: phase ? phase.name : st.phase,
    round: st.round,
    round_name: round.name,
    round_length_s: round.length_s,
    round_clock: clockView(game, st.round_clock),
    council_clock: clockView(game, st.council_clock),
    cycle: {
      number: st.cycle.number,
      length_s: st.cycle.length_s,
      remaining_s: Math.ceil(st.cycle.remaining_s),
      running: !!st.cycle.running && !game.frozen,
    },
    paused: !!st.paused,
    breather: !!st.breather,
    frozen: game.frozen,
    core_output: Math.round(st.core_integrity),
    core_integrity: Math.round(st.core_integrity),
    city_stability: Math.round(st.city_stability),
    stability_mode: (game.cfg.stability || {}).mode || 'auto',
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
      round: game.state.round,
      round_number: game.roundNumber(),
      editable: false,
      announcement_active: !!(a.headline || a.message),
    };
  }
  const rows = {};
  for (const [code, row] of Object.entries(b.rows || {})) {
    rows[code] = {
      ...row,
      round_number: row.round === null ? null : game.roundNumber(row.round),
      freshness: game.broadcastFreshness(row.round),
    };
  }
  const a = b.announcement || {};
  const live = !!(a.headline || a.message);
  return {
    round: game.state.round,
    round_number: game.roundNumber(),
    rows,
    announcement: live ? {
      ...a, round_number: a.round === null ? null : game.roundNumber(a.round), freshness: game.broadcastFreshness(a.round),
    } : null,
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
    const pending = game.state.transfers.filter((t) => t.status === 'PENDING_TRN_APPROVAL');
    extra.transfer_queue = {
      capacity,
      used,
      remaining: Math.max(0, capacity - used),
      basis: game.stampBasis(),
      requires_chit: game.cfg.require_physical_transfer_chit !== false,
      can_stamp: own.status !== 'DARK',
      // Requests the supplier has not answered are nobody's business but theirs.
      awaiting_acceptance: game.state.requests.filter((r) => r.status === 'REQUESTED').length,
      items: pending.map((t) => ({
        ...transferView(t),
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
  const showInventory = !!cfg.wall_shows_inventory && !detailHidden;
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
        total: s.workforce.active + s.workforce.injured + s.workforce.loaned,
      },
      // Count only, always — the wall names sectors, never their fix.
      unresolved_faults: s.faults.filter((f) => !f.resolved).length,
    };
    if (showInventory) view.inventory = { ...s.inventory };
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
    debrief: game.state.wall_debrief || null,
  });
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
      upkeep_due_in_s: Math.ceil(game.state.cycle.remaining_s),
      faults: s.faults.map((f) => controlFault(f, game)),
      top_fault: (() => { const w = worstFault(s); return w ? wallFault(w) : null; })(),
    };
  }
  const st = game.state;
  return envelope(game, {
    role: 'control',
    sectors,
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
    phases: (game.rounds.phases || []).map((p) => ({ id: p.id, name: p.name, round: p.round, mode: p.mode, hint: p.hint })),
    config: game.cfg,
    scenario: {
      id: game.scenario.id, name: game.scenario.name, notes: game.scenario.notes,
      sectors: game.scenario.sectors,
      events: game.scenario.events, fault_presets: game.scenario.fault_presets,
    },
    wall_debrief: !!st.wall_debrief,
  });
}

function filterState(game, client) {
  if (client.role === 'control') return forControl(game);
  if (client.role === 'bigscreen') return forBigscreen(game);
  return forSector(game, client.sector);
}

module.exports = {
  filterState, forSector, forBigscreen, forControl, cardFlavour, worstFault,
};
