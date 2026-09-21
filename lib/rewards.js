'use strict';

/**
 * FAULT REWARDS (v17.3, 2026-09-18): exact, case-balanced, budgeted.
 *
 * Every fault instance is dealt ONE exact reward the moment it fires, and
 * that is the reward it pays — never rerolled, never redrawn, never swapped.
 * The strength comes from the fault's own case record (lib/reward-pools.json,
 * copied from the v17.3 balance table): a difficulty score built from the
 * binder's materials (parts and medical weigh more), crew, cross-sector
 * dependencies and severity; a target RVU; an allowed band; a case profile
 * that says how often the reward should be local health, help for another
 * sector, capacity or stock. A simple fault can never roll a critical
 * fault's reward, and no reward exceeds its fault's target.
 *
 * Stock is doubly capped. Per fault: at most half the material units the
 * repair costs (min 2), so a one-material fault never returns stock at all.
 * Across the run: reserved + generated reward units may never pass 35% of
 * the binder material units the facilitator has issued (bootstrap 1). Units
 * are RESERVED when the fault fires, so the exact resource the table sees is
 * already inside the budget; they become GENERATED when the repair pays, and
 * are RELEASED when the fault is cleared without a reward.
 *
 * Application is exactly once, by the authoritative completion — an accepted
 * code that has already deducted its materials, or the facilitator clearing a
 * ghost — after the repair is settled, so a cache can never fund the repair
 * that earned it. Health is capped at 100 and never revives DARK. Transport
 * and Medical bonuses widen the round's allowance and approve or heal nothing
 * by themselves. Stabilisation halves or pauses another fault's decay for a
 * fixed 90 or 60 seconds of game time (ending earlier at the round change or
 * when that fault resolves) — a reward effect, never a deadline.
 */

const POOLS = require('./reward-pools.json');

const RESOURCES = ['power', 'water', 'parts', 'med'];
const NAMES = { power: 'POWER', water: 'WATER', parts: 'PARTS', med: 'MEDICAL' };
const CATEGORIES = ['local', 'cross', 'capacity', 'resource'];

// -- the run's own RNG: FNV-1a seed, mulberry32 stream -----------------------------

function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted(entries, roll) {
  const total = entries.reduce((a, e) => a + Math.max(0, e.weight), 0);
  if (total <= 0) return entries[Math.min(entries.length - 1, Math.floor(roll * entries.length))];
  let x = roll * total;
  for (const e of entries) {
    x -= Math.max(0, e.weight);
    if (x < 0) return e;
  }
  return entries[entries.length - 1];
}

const units = (o) => Object.values(o || {}).reduce((a, v) => a + (Number(v) || 0), 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// -- who is in the game ---------------------------------------------------------------

/** The session's active sectors: a scenario list when it has one, else all six. */
function activeSectors(game) {
  const all = Object.keys(game.state.sectors);
  const cfg = game.cfg.active_sectors;
  if (Array.isArray(cfg) && cfg.length) {
    const want = new Set(cfg.map((c) => String(c).toUpperCase()));
    return all.filter((c) => want.has(c));
  }
  return all;
}

/** Active, not DARK, above the floor: a sector a reward may touch. */
function liveSectors(game) {
  return activeSectors(game).map((c) => game.state.sectors[c]).filter((s) => s && s.status !== 'DARK' && s.integrity > 0);
}

function otherFaults(game, fault) {
  const out = [];
  for (const code of activeSectors(game)) {
    for (const f of game.state.sectors[code].faults) if (!f.resolved && f.id !== fault.id) out.push({ sector: code, fault: f });
  }
  return out;
}

// -- the case record --------------------------------------------------------------------

/**
 * The v17.3 difficulty model, computed from a definition: weighted material
 * burden + crew burden + coordination burden + severity bonus. The table in
 * reward-pools.json is authoritative; this is how the table was built, used
 * to verify it and to place a fault the table does not know.
 */
function difficultyFor(def) {
  const mats = def.materials || def.resources_required || {};
  let burden = 0;
  for (const [k, v] of Object.entries(mats)) burden += (Number(v) || 0) * Number(POOLS.material_weights[k] ?? 1);
  const crew = Number(def.minimum_crew ?? def.crew_required ?? 0) || 0;
  const crewBurden = crew > 1 ? (crew - 1) * Number(POOLS.crew_weight_per_extra_worker) : 0;
  const deps = def.external_information_dependencies || [];
  const coordination = deps.length * Number(POOLS.dependency_weight);
  const severity = Number(POOLS.severity_bonus[String(def.severity_level ?? def.severity ?? 1)] ?? 0);
  const score = Math.round((burden + crewBurden + coordination + severity) * 100) / 100;
  const target = clamp(Math.ceil(score * Number(POOLS.target_factor) - 1e-9), 1, 5);
  const materialUnits = units(mats);
  return {
    material_units: materialUnits,
    weighted_material_burden: Math.round(burden * 100) / 100,
    difficulty_score: score,
    reward_target_rvu: target,
    allowed_reward_rvu: target >= 3 ? [target - 1, target] : [target, target],
    max_resource_units_in_single_reward: Math.min(Number(POOLS.per_fault_refund_max), Math.floor(materialUnits * Number(POOLS.per_fault_refund_ratio))),
  };
}

/** The fault's case record: the table's, or computed for a code the table lacks. */
function balanceOf(game, code, fault = null) {
  const table = POOLS.faults[code];
  const over = (game.cfg.fault_reward_overrides || {})[code] || {};
  let bal;
  if (table) bal = { ...table };
  else {
    const d = difficultyFor(fault || {});
    bal = {
      sector: fault ? fault.sector : null, title: fault ? fault.name : code, repair_type: 'STANDARD',
      severity_level: fault ? fault.severity : 1, minimum_crew: fault ? fault.crew_required : 1,
      external_information_dependencies: [], reward_tier: 1, case_profile: 'STANDARD_LOCAL', resource_reward_probability_cap: 0.2, ...d,
    };
  }
  if (over.tier) bal.reward_tier = clamp(Number(over.tier), 1, 4);
  return bal;
}

function tierOf(game, code) {
  return balanceOf(game, code).reward_tier;
}

/** The global scarcity guardrail, from the run's counters. */
function budget(game) {
  const st = game.state;
  const issued = Number(st.repair_material_units_issued || 0);
  const consumed = Number(st.repair_material_units_consumed || 0);
  const reserved = Number(st.fault_reward_resource_units_reserved || 0);
  const generated = Number(st.fault_reward_resource_units_generated || 0);
  const max = Math.max(Number(POOLS.resource_return_bootstrap ?? 1), Math.floor(issued * Number(POOLS.resource_return_ratio ?? 0.35)));
  return { issued, consumed, reserved, generated, max, remaining: Math.max(0, max - generated - reserved) };
}

function trnWanted(game) {
  const pending = game.state.transfers.some((t) => t.status === 'PENDING_TRN_APPROVAL');
  return pending || (game.trnCapacity() - game.stampsUsed()) <= 1;
}
function medWanted(game) {
  return game.state.healing.some((h) => h.status === 'WAITING_FOR_MED')
    || Object.values(game.state.sectors).some((s) => (Number(s.workforce.injured) || 0) > 0);
}

/**
 * Why an archetype cannot be dealt to this fault right now — null when it
 * can. The hard scarcity filters and the state filters, in one place, so the
 * log can say exactly what was excluded and why.
 */
function exclusion(game, sectorCode, fault, archetype, bal, { hardOnly = false } = {}) {
  const a = POOLS.archetypes[archetype];
  if (!a) return 'unknown_archetype';
  const ghost = !!fault.false_alarm || (Array.isArray(fault.valid_codes) && fault.valid_codes.length === 0) || bal.repair_type === 'SPECIAL_VERIFICATION';
  const ru = Number(a.resource_units) || 0;
  if (ru > 0 && (ghost || units(fault.resources_required) === 0)) return 'no_repair_materials';
  if (ru > Number(bal.max_resource_units_in_single_reward ?? 0)) return 'per_fault_resource_cap';
  if (ru > 0 && budget(game).remaining < ru) return 'global_resource_budget';
  if (a.salvage && units(fault.resources_required) < a.salvage) return 'salvage_exceeds_recipe';
  if (hardOnly) return null;
  const live = liveSectors(game);
  const active = activeSectors(game);
  const others = live.filter((s) => s.code !== sectorCode);
  if ((a.other || (a.others && !a.self_ok)) && !others.length) return 'no_other_active_sector';
  if ((a.lowest || a.lowest_n || (a.others && a.self_ok) || a.crew) && !live.length) return 'no_live_sector';
  if (a.capacity === 'trn_capacity' && (!active.includes('TRN') || !live.some((s) => s.code === 'TRN'))) return 'trn_inactive';
  if (a.capacity === 'med_capacity' && (!active.includes('MED') || !live.some((s) => s.code === 'MED'))) return 'med_inactive';
  if (a.stabilise && !otherFaults(game, fault).length) return 'no_other_active_fault';
  return null;
}

/**
 * The archetypes this fault may roll right now, each with its RVU, category
 * and weight, plus what was excluded and why. Inside the fault's band, never
 * above its target, inside both stock caps, usable in this session.
 */
function eligible(game, sectorCode, fault, bal = null) {
  bal = bal || balanceOf(game, fault.code, fault);
  const [lo, hi] = bal.allowed_reward_rvu || [1, 1];
  const top = Math.min(hi, bal.reward_target_rvu);
  const out = [];
  const excluded = {};
  for (const [name, a] of Object.entries(POOLS.archetypes)) {
    if (a.rvu < lo || a.rvu > top) { excluded[name] = 'outside_rvu_band'; continue; }
    const why = exclusion(game, sectorCode, fault, name, bal);
    if (why) { excluded[name] = why; continue; }
    let weight = 1;
    if (a.capacity === 'trn_capacity' && trnWanted(game)) weight = Number(POOLS.wanted_capacity_weight) || 1.5;
    if (a.capacity === 'med_capacity' && medWanted(game)) weight = Number(POOLS.wanted_capacity_weight) || 1.5;
    out.push({ reward: name, rvu: a.rvu, category: a.category, weight, resource_units: Number(a.resource_units) || 0 });
  }
  return Object.assign(out, { excluded });
}

/** The spec's fallback: the nearest lower-RVU health reward that has a target, never above the target. */
function fallbackHealth(game, sectorCode, fault, bal) {
  const target = bal.reward_target_rvu;
  const list = Object.entries(POOLS.archetypes)
    .filter(([, a]) => (a.category === 'local' || a.category === 'cross') && !a.crew && !a.capacity && !a.stabilise && !(Number(a.resource_units) || 0) && a.rvu <= target)
    .filter(([name]) => !exclusion(game, sectorCode, fault, name, bal))
    .sort(([na, a], [nb, b]) => (b.rvu - a.rvu) || ((a.category === 'local' ? 0 : 1) - (b.category === 'local' ? 0 : 1)) || na.localeCompare(nb));
  return list.length ? list[0][0] : 'LOCAL_RECOVERY_5';
}

// -- scarcity-weighted resources ---------------------------------------------------------

/**
 * Draw probabilities from REAL stock across live active sectors: the lower a
 * resource's average per sector, the likelier it is; no single type above
 * the cap, so the draw stays a draw. COM's board and pending transfers are
 * never read.
 */
function scarcityWeights(game, exclude = [], only = null) {
  const live = liveSectors(game);
  const n = Math.max(1, live.length);
  const types = RESOURCES.filter((r) => !exclude.includes(r) && (!only || only.includes(r)));
  if (!types.length) return {};
  const raw = {};
  for (const r of types) {
    const avg = live.reduce((a, s) => a + (Number(s.inventory[r]) || 0), 0) / n;
    raw[r] = 1 / (avg + 1);
  }
  const cap = Number(POOLS.draw_cap ?? 0.45);
  const w = { ...raw };
  for (let pass = 0; pass < 4; pass += 1) {
    const total = Object.values(w).reduce((a, v) => a + v, 0);
    for (const r of types) w[r] /= total;
    const over = types.filter((r) => w[r] > cap + 1e-9);
    if (!over.length || over.length === types.length) break;
    let excess = 0;
    for (const r of over) { excess += w[r] - cap; w[r] = cap; }
    const rest = types.filter((r) => !over.includes(r));
    const restTotal = rest.reduce((a, r) => a + w[r], 0) || 1;
    for (const r of rest) w[r] += excess * (w[r] / restTotal);
  }
  return w;
}

/** `count` supply units, distinct types first. */
function drawResources(game, count, roll) {
  const drawn = [];
  for (let i = 0; i < count; i += 1) {
    const w = scarcityWeights(game, drawn.length < RESOURCES.length ? drawn : []);
    const entries = Object.entries(w).map(([r, weight]) => ({ reward: r, weight }));
    if (!entries.length) break;
    drawn.push(weighted(entries, roll()).reward);
  }
  return drawn;
}

/**
 * `count` refund units from the binder recipe — every recipe material is
 * consumed by a successful repair, so the refund can be named at issue.
 * Scarcer recipe materials are likelier; distinct types first.
 */
function drawSalvage(game, fault, count, roll) {
  const left = {};
  for (const [k, v] of Object.entries(fault.resources_required || {})) if (Number(v) > 0) left[k] = Number(v);
  const drawn = [];
  for (let i = 0; i < count; i += 1) {
    const types = Object.keys(left).filter((k) => left[k] > 0);
    if (!types.length) break;
    const fresh = types.filter((k) => !drawn.includes(k));
    const pool = fresh.length ? fresh : types;
    const w = scarcityWeights(game, [], pool);
    const entries = pool.map((r) => ({ reward: r, weight: w[r] ?? 1 }));
    const pick = weighted(entries, roll()).reward;
    drawn.push(pick);
    left[pick] -= 1;
  }
  return drawn;
}

// -- the exact payload -------------------------------------------------------------------

function mergeAmounts(list, source) {
  const out = [];
  for (const r of list) {
    const hit = out.find((e) => e.resource === r);
    if (hit) hit.amount += 1;
    else out.push({ target: 'OWNER', resource: r, amount: 1, source });
  }
  return out;
}

/** The words on the card: exact resources, exact points, the target rule, the duration. */
function describeEffects(p) {
  const bits = [];
  for (const e of p.resource_effects || []) bits.push(`${e.source === 'SALVAGE' ? 'REFUND ' : ''}+${e.amount} ${NAMES[e.resource] || String(e.resource).toUpperCase()}`);
  for (const h of p.health_effects || []) {
    if (h.target === 'OWNER') bits.push(`+${h.amount} SECTOR HEALTH`);
    else if (h.target === 'CHOSEN_OTHER') bits.push(`CHOOSE ANOTHER ACTIVE SECTOR: +${h.amount} HEALTH`);
    else if (h.target === 'CHOSEN_MULTIPLE') bits.push(`CHOOSE UP TO ${h.count} OTHER ACTIVE SECTORS: +${h.amount} HEALTH EACH`);
    else if (h.target === 'LOWEST_HEALTH') bits.push(`LOWEST-HEALTH SECTOR: +${h.amount} HEALTH`);
    else if (h.target === 'MULTIPLE_LOWEST') bits.push(`${h.count} LOWEST-HEALTH SECTORS: +${h.amount} HEALTH EACH`);
  }
  for (const c of p.capacity_effects || []) bits.push(c.system === 'TRN_APPROVALS' ? `TRN +${c.amount} APPROVAL THIS CYCLE` : `MED +${c.amount} HEAL THIS CYCLE`);
  for (const w of p.worker_effects || []) bits.push(w.target === 'CHOSEN_MULTIPLE' ? `CHOOSE UP TO ${w.count} SECTORS: +${w.amount} WORKER EACH UNTIL ROUND END` : `CHOOSE A SECTOR: +${w.amount} WORKER UNTIL ROUND END`);
  for (const d of p.fault_decay_effects || []) bits.push(d.mode === 'PAUSE' ? `CHOOSE ANOTHER ACTIVE FAULT: PAUSE ITS DECAY FOR ${d.duration_s} S` : `CHOOSE ANOTHER ACTIVE FAULT: HALVE ITS DECAY FOR ${d.duration_s} S`);
  return bits.join(' · ');
}

/** Everything the reward will do, exact, drawn now and persisted. */
function buildPayload(game, sectorCode, fault, archetype, bal, tier, seed, roll, extra = {}) {
  const a = POOLS.archetypes[archetype];
  const health = [];
  if (a.owner) health.push({ target: 'OWNER', amount: Number(a.owner) });
  if (a.other) health.push({ target: 'CHOSEN_OTHER', amount: Number(a.other) });
  if (a.others && a.each) health.push({ target: 'CHOSEN_MULTIPLE', amount: Number(a.each), count: Number(a.others) });
  if (a.lowest) health.push({ target: 'LOWEST_HEALTH', amount: Number(a.lowest) });
  if (a.lowest_n) health.push({ target: 'MULTIPLE_LOWEST', amount: Number(a.each), count: Number(a.lowest_n) });
  let resources = [];
  if (a.supply) resources = resources.concat(mergeAmounts(drawResources(game, Number(a.supply), roll), 'SUPPLY'));
  if (a.salvage) resources = resources.concat(mergeAmounts(drawSalvage(game, fault, Number(a.salvage), roll), 'SALVAGE'));
  const capacity = a.capacity ? [{ system: a.capacity === 'trn_capacity' ? 'TRN_APPROVALS' : 'MED_HEALS', amount: 1, expires: 'END_OF_CURRENT_ROUND' }] : [];
  const workers = a.crew ? [{ type: 'TEMPORARY_WORKER', amount: Number(a.crew), expires: 'END_OF_CURRENT_ROUND', target: a.others ? 'CHOSEN_MULTIPLE' : 'CHOSEN', count: Number(a.others) || 1 }] : [];
  const decay = a.stabilise ? [{ mode: a.stabilise, duration_s: Number(POOLS.stabilisation_s[a.stabilise]) || 60, target_chosen_after_resolution: true }] : [];
  const p = {
    reward_instance_id: game.id('RW'),
    archetype, rvu: Number(a.rvu), tier, case_profile: bal.case_profile, label: a.label,
    choose: a.choose || null,
    health_effects: health, resource_effects: resources, capacity_effects: capacity, worker_effects: workers, fault_decay_effects: decay,
    resource_units_reserved: resources.reduce((n, e) => n + e.amount, 0),
    assigned_at_fault_creation: true, reroll_allowed: false,
    seed, assigned_at: new Date().toISOString(), assigned_round: game.state.round,
    difficulty_score: bal.difficulty_score, reward_target_rvu: bal.reward_target_rvu, allowed_reward_rvu: [...(bal.allowed_reward_rvu || [])],
    ...extra,
  };
  p.display_label = describeEffects(p);
  return p;
}

/**
 * Deal a fault instance its exact reward. Persisted on the instance with its
 * reservation; never dealt twice; logged with every input the balance needs.
 */
function assign(game, sectorCode, fault) {
  if (game.cfg.fault_rewards_enabled === false) return null;
  const bal = balanceOf(game, fault.code, fault);
  const tier = bal.reward_tier;
  const over = (game.cfg.fault_reward_overrides || {})[fault.code] || {};
  const seed = seedFrom(`${game.state.run_id}|${fault.id}|${tier}`);
  const roll = rng(seed);
  const candidates = eligible(game, sectorCode, fault, bal);
  const last = (game.state.reward_last || {})[sectorCode];
  let pick = null;
  let how = 'roll';
  let level = null;

  // A pinned archetype (a test, a facilitator experiment) skips the band and
  // the profile but never the scarcity caps or the session's state.
  if (over.archetype && POOLS.archetypes[over.archetype]) {
    const why = exclusion(game, sectorCode, fault, over.archetype, bal);
    if (!why) { pick = over.archetype; how = 'override'; }
    else game.log.write('fault_reward_override_rejected', { fault: fault.code, instance: fault.id, sector: sectorCode, archetype: over.archetype, reason: why });
  }

  if (!pick) {
    const target = bal.reward_target_rvu;
    const [lo, hiRaw] = bal.allowed_reward_rvu || [target, target];
    const hi = Math.min(hiRaw, target);
    level = hi;
    if (target >= 3 && lo < hi) level = roll() < Number(POOLS.target_weighting.full ?? 0.7) ? hi : lo;
    let pool = candidates.filter((c) => c.rvu === level);
    if (!pool.length) pool = candidates.filter((c) => c.rvu === (level === hi ? lo : hi));
    if (!pool.length) pool = [...candidates];
    if (last && new Set(pool.map((c) => c.reward)).size >= 3) pool = pool.filter((c) => c.reward !== last);
    if (pool.length) {
      const prof = POOLS.profiles[bal.case_profile] || POOLS.profiles.STANDARD_LOCAL;
      const cats = {};
      for (const c of pool) (cats[c.category] = cats[c.category] || []).push(c);
      const entries = Object.keys(cats).map((cat) => ({
        reward: cat,
        weight: cat === 'resource' ? Math.min(Number(prof.resource ?? 0), Number(bal.resource_reward_probability_cap ?? 0)) : Number(prof[cat] ?? 0),
      }));
      const cat = weighted(entries, roll()).reward;
      pick = weighted(cats[cat].map((c) => ({ reward: c.reward, weight: c.weight })), roll()).reward;
    } else {
      pick = fallbackHealth(game, sectorCode, fault, bal);
      how = 'fallback';
    }
  }

  const payload = buildPayload(game, sectorCode, fault, pick, bal, tier, seed, roll, { selected_by: how, rvu_level: level });
  game.state.reward_last = { ...(game.state.reward_last || {}), [sectorCode]: pick };
  if (payload.resource_units_reserved > 0) {
    game.state.fault_reward_resource_units_reserved = Number(game.state.fault_reward_resource_units_reserved || 0) + payload.resource_units_reserved;
    fault.reward_resource_units_reserved = payload.resource_units_reserved;
  }
  game.log.write('fault_reward_assigned', {
    run_id: game.state.run_id, instance: fault.id, fault: fault.code, sector: sectorCode,
    reward_instance_id: payload.reward_instance_id,
    difficulty_score: bal.difficulty_score, reward_target_rvu: bal.reward_target_rvu, allowed_reward_rvu: bal.allowed_reward_rvu,
    case_profile: bal.case_profile, max_resource_units: bal.max_resource_units_in_single_reward, tier,
    eligible_after_filtering: candidates.map((c) => c.reward), excluded: candidates.excluded,
    selected: pick, selected_by: how, rvu_level: level, rvu: payload.rvu,
    exact_reward_payload: { display_label: payload.display_label, health_effects: payload.health_effects, resource_effects: payload.resource_effects, capacity_effects: payload.capacity_effects, worker_effects: payload.worker_effects, fault_decay_effects: payload.fault_decay_effects },
    resource_units_reserved: payload.resource_units_reserved, assignment_round: game.state.round, budget: budget(game),
  });
  return payload;
}

// -- reservations ------------------------------------------------------------------------

/** A reservation that will never be paid goes back to the budget. */
function releaseReservation(game, fault, reason) {
  const n = Number(fault.reward_resource_units_reserved || 0);
  if (n <= 0) return 0;
  game.state.fault_reward_resource_units_reserved = Math.max(0, Number(game.state.fault_reward_resource_units_reserved || 0) - n);
  fault.reward_resource_units_reserved = 0;
  game.log.write('fault_reward_reservation_released', { fault: fault.code, instance: fault.id, units: n, reason, budget: budget(game) });
  return n;
}

/** A cancelled fault's binder units leave the budget basis. */
function cancelIssued(game, fault, reason) {
  if (!fault.material_units_issued) return 0;
  const n = Number(fault.material_units || units(fault.resources_required)) || 0;
  game.state.repair_material_units_issued = Math.max(0, Number(game.state.repair_material_units_issued || 0) - n);
  fault.material_units_issued = false;
  game.log.write('fault_material_issue_cancelled', { fault: fault.code, instance: fault.id, units: n, reason, budget: budget(game) });
  return n;
}

// -- application -----------------------------------------------------------------------

function healSector(game, sector, points) {
  if (!sector || points <= 0 || sector.status === 'DARK' || sector.integrity <= 0) return 0;
  const cap = Number(game.cfg.reward_health_cap ?? 100);
  const next = Math.min(cap, sector.integrity + points);
  const applied = Math.round((next - sector.integrity) * 10) / 10;
  sector.integrity = next;
  game.refreshStatus(sector);
  return applied;
}

/** What a choosing reward may pick from, right now. */
function choiceOptions(game, sectorCode, fault, reward) {
  const a = POOLS.archetypes[reward.archetype] || {};
  if (reward.choose === 'fault') {
    return otherFaults(game, fault).map(({ sector, fault: f }) => ({ id: f.id, code: f.code, name: f.name, sector, decay_per_min: f.decay_per_min }));
  }
  const live = liveSectors(game).filter((s) => a.self_ok || s.code !== sectorCode);
  return live.map((s) => ({ sector: s.code, name: s.name, integrity: Math.round(s.integrity) }));
}

function defaultTarget(game, sectorCode, fault, reward) {
  const a = POOLS.archetypes[reward.archetype] || {};
  const options = choiceOptions(game, sectorCode, fault, reward);
  if (!options.length) return null;
  if (reward.choose === 'fault') {
    const worst = [...options].sort((x, y) => y.decay_per_min - x.decay_per_min)[0];
    return { fault: worst.id };
  }
  const lowest = [...options].sort((x, y) => x.integrity - y.integrity);
  if (reward.choose === 'sectors') return { sectors: lowest.slice(0, Number(a.others) || 2).map((o) => o.sector) };
  return { sector: lowest[0].sector };
}

function validTarget(game, sectorCode, fault, reward, target) {
  const a = POOLS.archetypes[reward.archetype] || {};
  const options = choiceOptions(game, sectorCode, fault, reward);
  if (!target) return { ok: false, reason: 'reward_target_required', options };
  if (reward.choose === 'fault') {
    return options.some((o) => o.id === target.fault) ? { ok: true } : { ok: false, reason: 'reward_invalid_target', options };
  }
  if (reward.choose === 'sectors') {
    const list = [...new Set((target.sectors || (target.sector ? [target.sector] : [])).map((c) => String(c).toUpperCase()))];
    if (!list.length || list.length > (Number(a.others) || 2)) return { ok: false, reason: 'reward_invalid_target', options };
    return list.every((c) => options.some((o) => o.sector === c)) ? { ok: true, sectors: list } : { ok: false, reason: 'reward_invalid_target', options };
  }
  const code = String(target.sector || '').toUpperCase();
  return options.some((o) => o.sector === code) ? { ok: true, sector: code } : { ok: false, reason: 'reward_invalid_target', options };
}

/** Effects that stabilise a fault end with it. */
function endEffectsFor(game, faultId) {
  for (const e of [...game.state.effects]) if (e.kind === 'fault_stabilised' && e.target === faultId) game.removeEffect(e.id);
}

/**
 * Pay the instance's exact reward, once. `via` is 'resolve' (an accepted
 * code), 'false_alarm_clear' (the facilitator clearing a ghost), 'force' (the
 * facilitator clearing a real fault — unpaid unless the scenario or an
 * explicit override says so) or 'default_target' (a choice the table never
 * made, settled at the round change). What was shown is what is paid.
 */
function apply(game, sectorCode, fault, { via = 'resolve', by = 'sector', target = null, consumed = null, force = false } = {}) {
  const key = `faultReward:${game.state.run_id}:${fault.id}`;
  const common = { fault: fault.code, instance: fault.id, sector: sectorCode, key, via, by, run_id: game.state.run_id };
  if (game.cfg.fault_rewards_enabled === false) return { applied: false, reason: 'disabled', key };
  const reward = fault.reward;
  if (!reward) return { applied: false, reason: 'no_reward', key };
  const claimed = game.state.rewards_claimed[fault.id];
  if (claimed) {
    game.log.write('fault_reward_duplicate_blocked', { ...common, first_claim: claimed.at });
    return { applied: false, reason: 'duplicate', key, text: previewLine(reward) };
  }
  const override = via === 'force';
  if (override && !force && !game.cfg.reward_on_facilitator_force_resolve) {
    releaseReservation(game, fault, 'force_resolve_without_reward');
    game.log.write('fault_reward_force_resolve_skipped', { ...common, archetype: reward.archetype, rvu: reward.rvu });
    return { applied: false, reason: 'force_resolve', key, text: previewLine(reward) };
  }
  const sector = game.state.sectors[sectorCode];
  if (!sector) return { applied: false, reason: 'unknown_sector', key };

  // A choice the table has not made yet: hold the whole reward, prompt the screen.
  let chosen = null;
  if (reward.choose) {
    const options = choiceOptions(game, sectorCode, fault, reward);
    if (!target && options.length) {
      reward.pending = { choose: reward.choose, options, since: new Date().toISOString() };
      game.log.write('fault_reward_pending', { ...common, archetype: reward.archetype, choose: reward.choose, options });
      game.touch();
      return { applied: false, pending: true, key, choose: reward.choose, options, text: previewLine(reward) };
    }
    if (options.length) {
      const v = validTarget(game, sectorCode, fault, reward, target);
      if (!v.ok) return { applied: false, reason: v.reason, key, options: v.options, text: previewLine(reward) };
      chosen = v;
    }
  }

  const a = POOLS.archetypes[reward.archetype] || {};
  const health = {};
  const resources = {};
  const effects = [];
  const targets = [];
  const notes = [];
  const now = new Date().toISOString();
  const round = game.state.round;
  const heal = (s, pts) => { if (!s) return; const got = healSector(game, s, pts); health[s.code] = (health[s.code] || 0) + got; };

  for (const h of reward.health_effects || []) {
    if (h.target === 'OWNER') heal(sector, h.amount);
    else if (h.target === 'CHOSEN_OTHER' && chosen && chosen.sector) { targets.push(chosen.sector); heal(game.state.sectors[chosen.sector], h.amount); }
    else if (h.target === 'CHOSEN_MULTIPLE' && chosen && chosen.sectors) { for (const c of chosen.sectors) { targets.push(c); heal(game.state.sectors[c], h.amount); } }
    else if (h.target === 'LOWEST_HEALTH') { const live = liveSectors(game).sort((x, y) => x.integrity - y.integrity); if (live.length) { targets.push(live[0].code); heal(live[0], h.amount); } }
    else if (h.target === 'MULTIPLE_LOWEST') { for (const s of liveSectors(game).sort((x, y) => x.integrity - y.integrity).slice(0, h.count)) { targets.push(s.code); heal(s, h.amount); } }
    else if (h.target === 'CHOSEN_OTHER' || h.target === 'CHOSEN_MULTIPLE') notes.push('no_target_for_health');
  }
  for (const c of reward.capacity_effects || []) {
    const code = c.system === 'TRN_APPROVALS' ? 'TRN' : 'MED';
    const e = game.addEffect({ kind: c.system === 'TRN_APPROVALS' ? 'trn_capacity' : 'med_capacity', target: code, delta: c.amount, expires: 'round', round, label: 'FAULT REWARD', source: fault.id });
    effects.push(e.id); targets.push(code);
  }
  for (const w of reward.worker_effects || []) {
    const codes = chosen && chosen.sectors ? chosen.sectors : chosen && chosen.sector ? [chosen.sector] : [];
    for (const c of codes) {
      const e = game.addEffect({ kind: 'extra_workers', target: c, delta: w.amount, expires: 'round', round, label: 'FAULT REWARD', source: fault.id });
      effects.push(e.id); targets.push(c);
    }
    if (!codes.length) notes.push('no_target_for_workers');
  }
  for (const d of reward.fault_decay_effects || []) {
    const hit = target && target.fault ? otherFaults(game, fault).find((x) => x.fault.id === target.fault) : null;
    if (hit) {
      const e = game.addEffect({
        kind: 'fault_stabilised', target: hit.fault.id, sector: hit.sector, fault_code: hit.fault.code,
        mode: d.mode, multiplier: d.mode === 'PAUSE' ? 0 : 0.5, duration_s: d.duration_s, remaining_s: d.duration_s,
        expires: 'round', round, label: 'FAULT REWARD', source: fault.id,
      });
      effects.push(e.id); targets.push(`${hit.fault.code}@${hit.sector}`);
    } else notes.push('no_target_for_stabilisation');
  }

  // Stock: exactly what the card said. A refund needs something to have been
  // consumed — a force-resolve consumed nothing, so its refund pays nothing.
  const spent = consumed || fault.resources_consumed || {};
  let generated = 0;
  let unpaid = 0;
  for (const r of reward.resource_effects || []) {
    if (r.source === 'SALVAGE' && (Number(spent[r.resource]) || 0) < r.amount) { unpaid += r.amount; notes.push(`refund_unpaid:${r.resource}`); continue; }
    sector.inventory[r.resource] = (Number(sector.inventory[r.resource]) || 0) + r.amount;
    resources[r.resource] = (resources[r.resource] || 0) + r.amount;
    generated += r.amount;
  }
  // Reserved becomes generated, exactly once; anything unpaid is released.
  const reserved = Number(fault.reward_resource_units_reserved || 0);
  if (reserved > 0) {
    game.state.fault_reward_resource_units_reserved = Math.max(0, Number(game.state.fault_reward_resource_units_reserved || 0) - reserved);
    fault.reward_resource_units_reserved = 0;
  }
  if (generated) game.state.fault_reward_resource_units_generated = Number(game.state.fault_reward_resource_units_generated || 0) + generated;
  if (unpaid) game.log.write('fault_reward_reservation_released', { ...common, units: unpaid, reason: 'refund_without_consumption', budget: budget(game) });

  const claim = { key, at: now, sector: sectorCode, via, by, instance: fault.id, fault: fault.code, reward_instance_id: reward.reward_instance_id, archetype: reward.archetype, tier: reward.tier, rvu: reward.rvu, health, resources, effects, targets, resource_units_generated: generated };
  game.state.rewards_claimed[fault.id] = claim;
  delete reward.pending;
  reward.applied_at = now;
  reward.result = { health, resources, targets, effects, resource_units_generated: generated, notes };
  fault.reward_applied = true;
  const ownerHealth = health[sectorCode] || 0;
  game.log.write('fault_reward_applied', {
    ...common, reward_instance_id: reward.reward_instance_id, archetype: reward.archetype, tier: reward.tier, rvu: reward.rvu,
    exact_reward_applied: reward.display_label,
    resources_added: { ...resources }, health: { ...health }, health_points: Object.values(health).reduce((x, y) => x + y, 0),
    health_before: Math.round((sector.integrity - ownerHealth) * 10) / 10, health_after: Math.round(sector.integrity * 10) / 10,
    effects, targets, notes, resource_units_generated: generated, applied_round: round, budget: budget(game),
    reward_claimed: true, admin_override: override, facilitator_override: override,
  });
  if (override) game.log.write('fault_reward_admin_override', { ...common, reward_instance_id: reward.reward_instance_id, archetype: reward.archetype, rvu: reward.rvu, exact_reward_applied: reward.display_label });
  game.touch();
  return {
    applied: true, key, via, archetype: reward.archetype, text: previewLine(reward), result_text: resultLine(reward, reward.result),
    health, resources, targets, effects, notes, resource_units_generated: generated, facilitator_override: override,
  };
}

/** The exact words on the card. Older instances (pre-v17.3) still carry label + preview. */
function previewLine(reward) {
  if (!reward) return '';
  if (reward.display_label) return reward.display_label;
  return reward.preview ? `${reward.label} · ${reward.preview}` : String(reward.label || '');
}

/** "+1 PARTS · POW +5 HEALTH · WTR +5 HEALTH" — what actually happened. */
function resultLine(reward, { health = {}, resources = {}, targets = [], effects = [] } = {}) {
  const bits = [];
  for (const [k, v] of Object.entries(resources)) bits.push(`+${v} ${NAMES[k] || String(k).toUpperCase()}`);
  for (const [c, v] of Object.entries(health)) if (v > 0) bits.push(`${c} +${Math.round(v)} HEALTH`);
  for (const c of reward.capacity_effects || []) bits.push(c.system === 'TRN_APPROVALS' ? 'TRN +1 APPROVAL THIS CYCLE' : 'MED +1 HEAL THIS CYCLE');
  if ((reward.worker_effects || []).length) bits.push(`+1 WORKER UNTIL ROUND END${targets.length ? ` (${targets.filter((t) => !t.includes('@')).join(', ')})` : ''}`);
  for (const d of reward.fault_decay_effects || []) bits.push(`${d.mode === 'PAUSE' ? 'DECAY PAUSED' : 'DECAY HALVED'} ON ${targets.find((t) => t.includes('@')) || 'ANOTHER FAULT'} FOR ${d.duration_s} S`);
  void effects;
  return bits.join(' · ') || previewLine(reward);
}

/** The screen's view: the exact words, never the units or the RVU. Null when previews are off. */
function preview(game, fault) {
  if (game.cfg.fault_rewards_enabled === false || game.cfg.show_fault_reward_preview === false) return null;
  const r = fault.reward;
  if (!r) return null;
  const claimed = !!game.state.rewards_claimed[fault.id];
  return {
    archetype: r.archetype, label: r.label, text: previewLine(r), display_label: previewLine(r), choose: r.choose || null,
    resources: (r.resource_effects || []).map((e) => ({ resource: e.resource, amount: e.amount, refund: e.source === 'SALVAGE' })),
    pending: !!r.pending, options: r.pending ? r.pending.options : undefined, claimed,
    result_text: claimed && r.result ? resultLine(r, r.result) : null,
  };
}

/** At a round change, a choice the table never made goes to the sector or fault that needs it most. */
function settlePending(game) {
  let n = 0;
  for (const [code, sector] of Object.entries(game.state.sectors)) {
    for (const fault of sector.faults) {
      if (!fault.reward || !fault.reward.pending || game.state.rewards_claimed[fault.id]) continue;
      const target = defaultTarget(game, code, fault, fault.reward);
      game.log.write('fault_reward_default_target', { fault: fault.code, instance: fault.id, sector: code, archetype: fault.reward.archetype, target });
      apply(game, code, fault, { via: 'default_target', by: 'round_change', target, consumed: fault.resources_consumed });
      n += 1;
    }
  }
  return n;
}

/** The decay multiplier on a fault from stabilisation effects (1 = untouched). */
function decayMultiplier(game, fault) {
  let m = 1;
  for (const e of game.state.effects) if (e.kind === 'fault_stabilised' && e.target === fault.id) m *= Number(e.multiplier);
  return m;
}

/** Timed reward effects count down in game time and end on their own. */
function tickEffects(game, secs) {
  for (const e of [...game.state.effects]) {
    if (e.remaining_s === undefined) continue;
    e.remaining_s = Math.max(0, Number(e.remaining_s) - secs);
    if (e.remaining_s <= 0) game.removeEffect(e.id);
  }
}

module.exports = {
  POOLS, RESOURCES, NAMES, CATEGORIES, seedFrom, rng, weighted, activeSectors, liveSectors, balanceOf, difficultyFor, tierOf,
  budget, exclusion, eligible, fallbackHealth, assign, buildPayload, describeEffects, scarcityWeights, drawResources, drawSalvage,
  releaseReservation, cancelIssued, apply, preview, previewLine, resultLine, settlePending, decayMultiplier, tickEffects, endEffectsFor,
  choiceOptions, validTarget, defaultTarget, healSector, units,
};
