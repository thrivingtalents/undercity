'use strict';

/**
 * FAULT REWARDS (v17, 2026-09-18): smart-random, tiered, budgeted.
 *
 * A fault instance is dealt ONE reward the moment it fires, from its tier's
 * pool, seeded by run + instance + tier so a refresh, a reconnect, a restart
 * or a failed attempt can never deal it again. The pool is filtered first by
 * what the city can actually use — which sectors are active and alive, who
 * needs Transport or Medical, whether another fault exists to stabilise —
 * and by the scarcity guardrail: across the run, the stock a reward creates
 * (supply caches, salvage) may not pass roughly 35% of the material the
 * repairs consumed, with a bootstrap of one unit. Most of what a reward pays
 * is health, capacity and support, not stock.
 *
 * The reward is paid exactly once, only by the authoritative completion —
 * an accepted code that has already deducted its materials, or the
 * facilitator clearing a ghost — and only after the repair is settled, so a
 * cache can never fund the repair that earned it. Health is capped at 100
 * and never revives a DARK sector. A Transport or Medical bonus widens the
 * allowance for the rest of the round; the sector still does its own work.
 * Stabilisation is a beneficial round-scoped modifier on another fault's
 * decay, never a deadline.
 */

const POOLS = require('./reward-pools.json');

const RESOURCES = ['power', 'water', 'parts', 'med'];
const NAMES = { power: 'POWER', water: 'WATER', parts: 'PARTS', med: 'MEDICAL' };

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
  if (total <= 0) return entries[0];
  let x = roll * total;
  for (const e of entries) {
    x -= Math.max(0, e.weight);
    if (x < 0) return e;
  }
  return entries[entries.length - 1];
}

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

function tierOf(game, code) {
  const over = (game.cfg.fault_reward_overrides || {})[code] || {};
  const t = Number(over.tier || POOLS.tiers[code] || 1);
  return Math.min(4, Math.max(1, t));
}

/** The scarcity guardrail, from the run's counters. */
function budget(game) {
  const consumed = Number(game.state.repair_material_units_consumed || 0);
  const generated = Number(game.state.fault_reward_resource_units_generated || 0);
  const max = Math.max(Number(POOLS.resource_return_bootstrap ?? 1), Math.floor(consumed * Number(POOLS.resource_return_ratio ?? 0.35)));
  return { consumed, generated, max, remaining: Math.max(0, max - generated) };
}

function otherFaults(game, fault) {
  const out = [];
  for (const code of activeSectors(game)) {
    for (const f of game.state.sectors[code].faults) if (!f.resolved && f.id !== fault.id) out.push({ sector: code, fault: f });
  }
  return out;
}

const units = (o) => Object.values(o || {}).reduce((a, v) => a + (Number(v) || 0), 0);

function trnWanted(game) {
  const pending = game.state.transfers.some((t) => t.status === 'PENDING_TRN_APPROVAL');
  return pending || (game.trnCapacity() - game.stampsUsed()) <= 1;
}
function medWanted(game) {
  return game.state.healing.some((h) => h.status === 'WAITING_FOR_MED')
    || Object.values(game.state.sectors).some((s) => (Number(s.workforce.injured) || 0) > 0);
}

/**
 * The tier's pool, minus everything the city cannot use right now. Weights
 * are the pool's; a Transport or Medical bonus counts half again when that
 * sector has work waiting.
 */
function eligible(game, sectorCode, fault, tier, { atApplication = false, consumed = null } = {}) {
  const pool = POOLS.pools[String(tier)] || [];
  const live = liveSectors(game);
  const active = activeSectors(game);
  const others = live.filter((s) => s.code !== sectorCode);
  const b = budget(game);
  const noMaterials = !!fault.false_alarm || units(fault.resources_required) === 0;
  const out = [];
  for (const entry of pool) {
    const a = POOLS.archetypes[entry.reward];
    if (!a) continue;
    let weight = Number(entry.weight) || 0;
    if (a.resource_units > 0 && noMaterials) continue;                         // a ghost pays no stock
    if (a.resource_units > 0 && b.generated + a.resource_units > b.max) continue;  // the guardrail
    if (a.salvage && atApplication && units(consumed) < 1) continue;           // nothing was consumed to refund
    if ((a.other || a.others) && !a.self_ok && !others.length) continue;      // needs someone else
    if (a.others && a.self_ok && !live.length) continue;
    if ((a.lowest || a.lowest_n) && !live.length) continue;
    if (a.capacity === 'trn_capacity') {
      if (!active.includes('TRN') || !live.some((s) => s.code === 'TRN')) continue;
      if (trnWanted(game)) weight *= 1.5;
    }
    if (a.capacity === 'med_capacity') {
      if (!active.includes('MED') || !live.some((s) => s.code === 'MED')) continue;
      if (medWanted(game)) weight *= 1.5;
    }
    if (a.crew && !live.length) continue;
    if (a.stabilise !== undefined && !otherFaults(game, fault).length) continue;
    out.push({ reward: entry.reward, weight, owner_health_bonus: Number(entry.owner_health_bonus) || 0 });
  }
  return out;
}

function previewOf(a, bonus) {
  return String(a.preview).replace('{bonus}', String(bonus || 0));
}

function describe(archetype, bonus) {
  const a = POOLS.archetypes[archetype];
  return { archetype, label: a.label, preview: previewOf(a, bonus), choose: a.choose || null, resource_units: a.resource_units, rvu: a.rvu + (bonus ? bonus / 5 : 0) };
}

/** Deal a fault instance its reward. Persisted on the instance; never dealt twice. */
function assign(game, sectorCode, fault) {
  if (game.cfg.fault_rewards_enabled === false) return null;
  const tier = tierOf(game, fault.code);
  const over = (game.cfg.fault_reward_overrides || {})[fault.code] || {};
  let candidates = eligible(game, sectorCode, fault, tier);
  if (over.archetype && POOLS.archetypes[over.archetype]) {
    candidates = [{ reward: over.archetype, weight: 1, owner_health_bonus: Number(over.owner_health_bonus) || 0 }];
  }
  const last = (game.state.reward_last || {})[sectorCode];
  if (new Set(candidates.map((c) => c.reward)).size >= 3 && last) candidates = candidates.filter((c) => c.reward !== last);
  if (!candidates.length) candidates = [{ reward: 'LOCAL_RECOVERY_5', weight: 1, owner_health_bonus: 0 }];   // never nothing
  const seed = seedFrom(`${game.state.run_id}|${fault.id}|${tier}`);
  const pick = weighted(candidates, rng(seed)());
  const d = describe(pick.reward, pick.owner_health_bonus);
  game.state.reward_last = { ...(game.state.reward_last || {}), [sectorCode]: pick.reward };
  return { ...d, tier, owner_health_bonus: pick.owner_health_bonus, seed, assigned_at: new Date().toISOString() };
}

// -- scarcity-weighted resources ---------------------------------------------------------

/**
 * Draw probabilities from REAL stock across live active sectors: the lower a
 * resource's average per sector, the likelier it is; no single type above
 * the cap, so the draw stays a draw.
 */
function scarcityWeights(game, exclude = []) {
  const live = liveSectors(game);
  const n = Math.max(1, live.length);
  const types = RESOURCES.filter((r) => !exclude.includes(r));
  if (!types.length) return {};
  const raw = {};
  for (const r of types) {
    const avg = live.reduce((a, s) => a + (Number(s.inventory[r]) || 0), 0) / n;
    raw[r] = 1 / (avg + 1);
  }
  const cap = Number(POOLS.draw_cap ?? 0.45);
  let w = { ...raw };
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

/**
 * Pay the instance's reward, once. `via` is 'resolve' (an accepted code),
 * 'false_alarm_clear' (the facilitator clearing a ghost), 'force' (the
 * facilitator clearing a real fault — unpaid unless the scenario or an
 * explicit override says so) or 'default_target' (a choice the table never
 * made, settled at the round change).
 */
function apply(game, sectorCode, fault, { via = 'resolve', by = 'sector', target = null, consumed = null, force = false } = {}) {
  const key = `faultReward:${game.state.run_id}:${fault.id}`;
  const common = { fault: fault.code, instance: fault.id, sector: sectorCode, key, via, by, run_id: game.state.run_id };
  if (game.cfg.fault_rewards_enabled === false) return { applied: false, reason: 'disabled', key };
  if (!fault.reward) return { applied: false, reason: 'no_reward', key };
  const claimed = game.state.rewards_claimed[fault.id];
  if (claimed) {
    game.log.write('fault_reward_duplicate_blocked', { ...common, first_claim: claimed.at });
    return { applied: false, reason: 'duplicate', key, text: previewLine(fault.reward) };
  }
  const override = via === 'force';
  if (override && !force && !game.cfg.reward_on_facilitator_force_resolve) {
    game.log.write('fault_reward_force_resolve_skipped', { ...common, archetype: fault.reward.archetype, rvu: fault.reward.rvu });
    return { applied: false, reason: 'force_resolve', key, text: previewLine(fault.reward) };
  }
  const sector = game.state.sectors[sectorCode];
  if (!sector) return { applied: false, reason: 'unknown_sector', key };

  // The guardrail and salvage are re-checked at payment: what was affordable
  // when the fault fired may not be now. Fall back to a non-stock reward from
  // the same tier — the reward is never cancelled.
  const spent = consumed || fault.resources_consumed || {};
  let reward = fault.reward;
  let a = POOLS.archetypes[reward.archetype];
  const b = budget(game);
  if ((a.resource_units > 0 && b.generated + a.resource_units > b.max) || (a.salvage && units(spent) < 1)) {
    const alt = eligible(game, sectorCode, fault, reward.tier, { atApplication: true, consumed: spent })
      .filter((c) => POOLS.archetypes[c.reward].resource_units === 0);
    const pick = weighted(alt.length ? alt : [{ reward: 'LOCAL_RECOVERY_5', weight: 1, owner_health_bonus: 0 }], rng(seedFrom(`${reward.seed}|fallback`))());
    const d = describe(pick.reward, pick.owner_health_bonus);
    game.log.write('fault_reward_budget_fallback', { ...common, from: reward.archetype, to: pick.reward, budget: b, consumed_this_repair: units(spent) });
    reward = { ...reward, ...d, owner_health_bonus: pick.owner_health_bonus, fallback_from: reward.archetype };
    fault.reward = reward;
    a = POOLS.archetypes[reward.archetype];
  }

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

  const health = {};
  const resources = {};
  const effects = [];
  const targets = [];
  const now = new Date().toISOString();
  const round = game.state.round;
  const bonus = a.owner_from_pool ? Number(reward.owner_health_bonus) || 0 : Number(a.owner) || 0;
  if (bonus > 0) health[sectorCode] = (health[sectorCode] || 0) + healSector(game, sector, bonus);
  if (a.other && chosen && chosen.sector) { targets.push(chosen.sector); health[chosen.sector] = (health[chosen.sector] || 0) + healSector(game, game.state.sectors[chosen.sector], a.other); }
  if (a.each && a.others && chosen && chosen.sectors) { for (const c of chosen.sectors) { targets.push(c); health[c] = (health[c] || 0) + healSector(game, game.state.sectors[c], a.each); } }
  if (a.lowest) {
    const live = liveSectors(game).sort((x, y) => x.integrity - y.integrity);
    if (live.length) { targets.push(live[0].code); health[live[0].code] = (health[live[0].code] || 0) + healSector(game, live[0], a.lowest); }
  }
  if (a.lowest_n) {
    const live = liveSectors(game).sort((x, y) => x.integrity - y.integrity).slice(0, a.lowest_n);
    for (const s of live) { targets.push(s.code); health[s.code] = (health[s.code] || 0) + healSector(game, s, a.each); }
  }
  if (a.capacity) {
    const code = a.capacity === 'trn_capacity' ? 'TRN' : 'MED';
    const e = game.addEffect({ kind: a.capacity, target: code, delta: 1, expires: 'round', round, label: 'FAULT REWARD', source: fault.id });
    effects.push(e.id); targets.push(code);
  }
  if (a.crew) {
    const codes = chosen && chosen.sectors ? chosen.sectors : chosen && chosen.sector ? [chosen.sector] : [];
    for (const c of codes) {
      const e = game.addEffect({ kind: 'extra_workers', target: c, delta: a.crew, expires: 'round', round, label: 'FAULT REWARD', source: fault.id });
      effects.push(e.id); targets.push(c);
    }
  }
  if (a.stabilise !== undefined && target && target.fault) {
    const hit = otherFaults(game, fault).find((x) => x.fault.id === target.fault);
    if (hit) {
      const e = game.addEffect({ kind: 'fault_stabilised', target: hit.fault.id, sector: hit.sector, fault_code: hit.fault.code, multiplier: a.stabilise, expires: 'round', round, label: 'FAULT REWARD', source: fault.id });
      effects.push(e.id); targets.push(`${hit.fault.code}@${hit.sector}`);
    }
  }
  let generated = 0;
  if (a.supply) {
    const drawn = drawResources(game, a.supply, rng(seedFrom(`${reward.seed}|draw`)));
    for (const r of drawn) { sector.inventory[r] = (Number(sector.inventory[r]) || 0) + 1; resources[r] = (resources[r] || 0) + 1; generated += 1; }
  }
  if (a.salvage) {
    const order = Object.entries(spent).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([k]) => k);
    let left = Math.min(a.salvage, units(spent));
    for (let i = 0; left > 0 && order.length; i += 1) {
      const r = order[i % order.length];
      sector.inventory[r] = (Number(sector.inventory[r]) || 0) + 1; resources[r] = (resources[r] || 0) + 1; generated += 1; left -= 1;
    }
  }
  if (generated) game.state.fault_reward_resource_units_generated = Number(game.state.fault_reward_resource_units_generated || 0) + generated;

  const claim = { key, at: now, sector: sectorCode, via, by, instance: fault.id, fault: fault.code, archetype: reward.archetype, tier: reward.tier, rvu: reward.rvu, health, resources, effects, targets, resource_units_generated: generated };
  game.state.rewards_claimed[fault.id] = claim;
  delete reward.pending;
  reward.applied_at = now;
  reward.result = { health, resources, targets, effects, resource_units_generated: generated };
  const ownerHealth = health[sectorCode] || 0;
  game.log.write('fault_reward_applied', {
    ...common, archetype: reward.archetype, tier: reward.tier, rvu: reward.rvu, fallback_from: reward.fallback_from || null,
    resources_added: { ...resources }, health: { ...health }, health_points: Object.values(health).reduce((x, y) => x + y, 0),
    health_before: Math.round((sector.integrity - ownerHealth) * 10) / 10, health_after: Math.round(sector.integrity * 10) / 10,
    effects, targets, resource_units_generated: generated, budget: budget(game),
    reward_claimed: true, facilitator_override: override,
  });
  if (override) game.log.write('fault_reward_admin_override', { ...common, archetype: reward.archetype, rvu: reward.rvu });
  game.touch();
  return {
    applied: true, key, via, archetype: reward.archetype, text: previewLine(reward), result_text: resultLine(reward, { health, resources, targets }),
    health, resources, targets, effects, resource_units_generated: generated, facilitator_override: override,
  };
}

/** "MUTUAL AID · CHOOSE ANOTHER SECTOR: +5 HEALTH" — the words on the card. */
function previewLine(reward) {
  return reward ? `${reward.label} · ${reward.preview}` : '';
}

/** "+1 PARTS · POW +5 HEALTH · WTR +5 HEALTH" — what actually happened. */
function resultLine(reward, { health = {}, resources = {}, targets = [] } = {}) {
  const bits = [];
  for (const [k, v] of Object.entries(resources)) bits.push(`+${v} ${NAMES[k] || String(k).toUpperCase()}`);
  for (const [c, v] of Object.entries(health)) if (v > 0) bits.push(`${c} +${Math.round(v)} HEALTH`);
  const a = POOLS.archetypes[reward.archetype] || {};
  if (a.capacity) bits.push(a.capacity === 'trn_capacity' ? 'TRN +1 APPROVAL THIS ROUND' : 'MED +1 HEAL THIS ROUND');
  if (a.crew) bits.push(`+1 WORKER UNTIL ROUND END${targets.length ? ` (${targets.filter((t) => !t.includes('@')).join(', ')})` : ''}`);
  if (a.stabilise !== undefined) bits.push(`${a.stabilise === 0 ? 'DECAY PAUSED' : 'DECAY HALVED'} ON ${targets.find((t) => t.includes('@')) || 'ANOTHER FAULT'} UNTIL ROUND END`);
  return bits.join(' · ') || reward.label;
}

/** The screen's view: the words, never the units. Null when previews are off. */
function preview(game, fault) {
  if (game.cfg.fault_rewards_enabled === false || game.cfg.show_fault_reward_preview === false) return null;
  const r = fault.reward;
  if (!r) return null;
  const claimed = !!game.state.rewards_claimed[fault.id];
  return {
    archetype: r.archetype, label: r.label, preview: r.preview, text: previewLine(r), choose: r.choose || null,
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

module.exports = {
  POOLS, RESOURCES, seedFrom, rng, weighted, activeSectors, liveSectors, tierOf, budget, eligible, assign,
  scarcityWeights, drawResources, apply, preview, previewLine, resultLine, settlePending, decayMultiplier,
  choiceOptions, validTarget, defaultTarget, healSector, units,
};
