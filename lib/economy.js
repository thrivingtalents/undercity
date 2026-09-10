'use strict';
/**
 * The city economy — pure functions over game state (spec §10, §35).
 *
 * Nothing in here has a number of its own: every rate, multiplier and
 * penalty comes from `game.cfg` (the scenario). Keeping the formulas in one
 * file, apart from the reducers, is what lets a facilitator retune the game
 * from Admin without touching the engine.
 */

const RESOURCES = ['power', 'water', 'parts', 'med'];

/** Brownout effect for a sector, with per-sector overrides merged in. */
function brownoutEffects(cfg, code) {
  const base = cfg.brownout_effects || {};
  const over = (base.per_sector || {})[code] || {};
  return { ...base, ...over, per_sector: undefined };
}

/**
 * CITY STABILITY 0–100.
 *
 * Automatic mode blends average sector integrity with core output, then
 * subtracts a configurable amount per unresolved critical fault, per DARK
 * sector, per BROWNOUT sector and per upkeep missed in the last cycle.
 * Manual mode returns the facilitator's number unchanged.
 */
function computeStability(game) {
  const st = game.cfg.stability || {};
  if (st.mode === 'manual') return clamp(Number(st.manual_value ?? 100));

  const w = st.weights || {};
  const sectors = Object.values(game.state.sectors);
  if (!sectors.length) return 100;

  const avg = sectors.reduce((a, s) => a + s.integrity, 0) / sectors.length;
  let value = avg * (w.integrity ?? 0.6) + game.state.core_integrity * (w.core_output ?? 0.4);

  let critical = 0;
  let dark = 0;
  let brownout = 0;
  for (const s of sectors) {
    if (s.status === 'DARK') dark += 1;
    else if (s.status === 'BROWNOUT') brownout += 1;
    for (const f of s.faults) {
      if (f.resolved) continue;
      if (f.severity >= 3 || f.expired) critical += 1;
    }
  }
  const missed = ((game.state.cycle.last_summary || {}).missed_upkeep_count) || 0;

  value -= critical * (w.critical_fault ?? 4);
  value -= dark * (w.dark_sector ?? 12);
  value -= brownout * (w.brownout_sector ?? 6);
  value -= missed * (w.missed_upkeep ?? 3);
  return clamp(value);
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
}

/**
 * The status WORD every screen prints (spec §5): STABLE · DEGRADED · CRITICAL
 * · BROWNOUT · DARK. The engine's own status is ACTIVE/CRITICAL/BROWNOUT/DARK;
 * STABLE vs DEGRADED is a threshold (`degraded_below`), and thresholds live in
 * the scenario — so the word is computed here, once, and never hardcoded in a
 * client.
 */
function statusWord(cfg, { integrity, status }) {
  if (status === 'DARK' || status === 'BROWNOUT' || status === 'CRITICAL') return status;
  const degradedBelow = Number((cfg || {}).degraded_below ?? 60);
  return Number(integrity) < degradedBelow ? 'DEGRADED' : 'STABLE';
}

/** What a sector will actually produce next cycle, after every modifier. */
function productionFor(game, sector) {
  const cfg = game.cfg;
  const out = {};
  if (sector.status === 'DARK') return out;
  if (game.hasEffect('no_production', sector.code)) return out;

  let mult = 1;
  if (sector.status === 'BROWNOUT') {
    mult *= Number(brownoutEffects(cfg, sector.code).production_multiplier ?? 0.5);
  }
  if (cfg.core_scales_power_production && sector.code === 'POW') {
    mult *= game.state.core_integrity / 100;
  }
  for (const [k, v] of Object.entries(sector.production || {})) {
    const n = Math.floor(Number(v) * mult);
    if (n > 0) out[k] = n;
  }
  return out;
}

/** What a sector owes next cycle. A brownout sector is on half rations. */
function upkeepFor(game, sector) {
  const out = {};
  if (sector.status === 'DARK') return out;
  const mult = sector.status === 'BROWNOUT'
    ? Number(brownoutEffects(game.cfg, sector.code).upkeep_delivery_multiplier ?? 0.5)
    : 1;
  for (const [k, v] of Object.entries(sector.upkeep_per_round || {})) {
    out[k] = Math.floor(Number(v) * mult);
  }
  return out;
}

/**
 * PROCESS CYCLE (spec §35), in this order:
 *   1 production · 2 upkeep · 3 shortage penalties · 4 fault decay (continuous,
 *   nothing to do here) · 5 worker recovery · 6 brownout effects (applied
 *   continuously; counted here) · 7 stability · 8 next cycle.
 *
 * Returns the summary shown to the facilitator. With `auto_economy` off,
 * nothing moves: the cycle still ticks and is logged, but chits stay the
 * source of truth (the original contract §3.5 behaviour).
 */
function processCycle(game) {
  const cfg = game.cfg;
  const number = game.state.cycle.number;
  const summary = { cycle: number, t: new Date().toISOString(), sectors: {}, missed_upkeep_count: 0 };
  const auto = !!cfg.auto_economy;

  for (const sector of Object.values(game.state.sectors)) {
    const line = { produced: {}, upkeep: {}, shortfall: {}, integrity_delta: 0, recovered: 0, notes: [] };
    summary.sectors[sector.code] = line;

    if (sector.status === 'DARK') { line.notes.push('DARK — no economy'); continue; }

    // 1. production
    const produced = productionFor(game, sector);
    line.produced = produced;
    if (auto) for (const [k, v] of Object.entries(produced)) sector.inventory[k] = (sector.inventory[k] || 0) + v;
    if (game.hasEffect('no_production', sector.code)) line.notes.push('SUPPLY DELAYED');

    // 2 + 3. upkeep and shortage
    const upkeep = upkeepFor(game, sector);
    line.upkeep = upkeep;
    let missing = 0;
    for (const [k, v] of Object.entries(upkeep)) {
      const have = sector.inventory[k] || 0;
      const short = Math.max(0, v - have);
      if (short > 0) line.shortfall[k] = short;
      missing += short;
      if (auto) sector.inventory[k] = Math.max(0, have - v);
    }
    if (missing > 0) {
      const penalty = Math.min(
        Number(cfg.upkeep_shortfall_penalty_cap ?? 12),
        missing * Number(cfg.upkeep_shortfall_penalty ?? 4)
      );
      if (auto) {
        sector.integrity = Math.max(0, sector.integrity - penalty);
        line.integrity_delta -= penalty;
      }
      line.notes.push(`UPKEEP FAILED (${missing} short)`);
      summary.missed_upkeep_count += 1;
      game.ticker('cycle', `${sector.code} missed upkeep`, { scope: null });
      game.log.write('upkeep_missed', { sector: sector.code, short: missing, penalty: auto ? penalty : 0 });
    }
  }

  // 5. worker recovery — MED spends med supplies to return injured workers.
  const med = game.state.sectors.MED;
  const perCycle = Number(cfg.injured_recovery_per_cycle ?? 0);
  const cost = Number(cfg.injured_recovery_costs_med ?? 1);
  if (auto && med && med.status !== 'DARK' && perCycle > 0) {
    let budget = perCycle;
    for (const sector of Object.values(game.state.sectors)) {
      while (budget > 0 && sector.workforce.injured > 0 && (med.inventory.med || 0) >= cost) {
        sector.workforce.injured -= 1;
        sector.workforce.active += 1;
        med.inventory.med -= cost;
        summary.sectors[sector.code].recovered += 1;
        budget -= 1;
        game.log.write('worker_recovered', { sector: sector.code, by: 'MED', med_spent: cost });
      }
    }
  }

  // 6. brownout / temporary effects that count in cycles
  game.expireCycleEffects();
  for (const sector of Object.values(game.state.sectors)) {
    if (sector.status === 'BROWNOUT') summary.sectors[sector.code].notes.push('BROWNOUT');
    sector.transfers_this_cycle = 0;
    game.refreshStatus(sector);
  }
  game.state.cycle.stamped = 0;

  // 7 + 8. stability and the next cycle
  game.state.cycle.number += 1;
  game.state.cycle.remaining_s = Number(cfg.cycle_length_s);
  game.state.cycle.last_summary = summary;
  game.state.cycle.processed_at = summary.t;
  game.state.city_stability = computeStability(game);

  game.ticker('cycle', `CORE CYCLE ${number} PROCESSED`);
  game.log.write('cycle_processed', { cycle: number, summary });
  game.sting('cycle');
  return summary;
}

module.exports = {
  RESOURCES, computeStability, processCycle, productionFor, upkeepFor, brownoutEffects, clamp, statusWord,
};
