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
function ownFault(f, showDependency = false) {
  return {
    id: f.id,
    code: f.code,
    name: f.name,
    flavour: cardFlavour(f.flavour, showDependency),
    severity: f.severity,
    crew_required: f.crew_required,
    resources_required: f.resources_required,
    decay_per_min: f.decay_per_min,
    deadline_s: f.deadline_s,
    deadline_remaining_s: ceilOrNull(f.deadline_remaining_s),
    integrity_penalty: f.integrity_penalty,
    attempts: f.attempts,
    locked_until_s: Math.ceil(f.locked_until_s),
    status: f.status,
    expired: !!f.expired,
    fired_at: f.fired_at,
    opened_at: f.opened_at,
    resolved: f.resolved,
    resolved_at: f.resolved_at,
    paused: f.paused,
    triggered_by: f.triggered_by,
  };
}

/** Fault as the facilitator sees it: everything, including valid_codes. */
function controlFault(f) {
  return {
    ...ownFault(f, true),   // the facilitator reads the whole line

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
  return { code: f.code, name: f.name, severity: f.severity, resolved: f.resolved, expired: !!f.expired };
}

/** The wall names the worst live fault and its clock — never the fix. */
function wallFault(f) {
  return {
    code: f.code, name: f.name, severity: f.severity,
    deadline_remaining_s: ceilOrNull(f.deadline_remaining_s), expired: !!f.expired,
  };
}

function worstFault(s) {
  const live = s.faults.filter((f) => !f.resolved);
  if (!live.length) return null;
  live.sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    const da = a.deadline_remaining_s ?? Infinity;
    const db = b.deadline_remaining_s ?? Infinity;
    return da - db;
  });
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
    faults: s.faults.filter((f) => !f.resolved).map((f) => ownFault(f, showDependency)),
    recently_resolved: s.faults.filter((f) => f.resolved).slice(-5)
      .map((f) => ownFault(f, showDependency)),
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

function forSector(game, sectorCode) {
  const def = game.content.sectors.sectors[sectorCode];
  const fullTelemetry = !!(def && def.full_telemetry);
  const delayed = game.delayedView();
  // Mirrors CARD_SHOWS_DEPENDENCY in the card renderer; both default to off.
  const showDependency = !!game.cfg.card_shows_dependency;
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
    transfers: game.state.transfers
      .filter((t) => t.from === sectorCode || t.to === sectorCode)
      .slice(0, 12).map(transferView),
    effects: effectsFor(game, sectorCode),
  };

  if (sectorCode === 'TRN') {
    const own = game.state.sectors.TRN;
    extra.transfer_queue = {
      capacity: game.trnCapacity(),
      used: game.transfersStampedThisCycle(),
      can_stamp: own.status !== 'DARK',
      items: game.state.transfers
        .filter((t) => !['DELIVERED', 'CANCELLED', 'STAMPED'].includes(t.status))
        .map(transferView),
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
      faults: s.faults.map(controlFault),
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
    transfers: st.transfers.map(transferView),
    transfer_capacity: { capacity: game.trnCapacity(), used: game.transfersStampedThisCycle() },
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
