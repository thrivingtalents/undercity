'use strict';

/**
 * FAULT REWARDS v2 (undercity_varied_fault_rewards_spec 2.0, 2026-09-29).
 *
 * One fixed reward per fault, from a table (lib/fault-rewards.json), in one of
 * three families:
 *
 *   RESOURCE     one unit of one resource into the resolving sector's REAL
 *                tray — stock like any other, so it still needs Transport to
 *                move, and it never refunds the repair
 *   INTEGRITY    +5 health, capped at the existing maximum, never reviving DARK
 *   OPPORTUNITY  one stored, single-use tactical token: RESERVE CREW (+1
 *                temporary worker for one repair), SECOND CHANCE (one rejected
 *                code does not count toward the lockout), EMERGENCY REPAIR KIT
 *                (one repair needs one part fewer, never below zero),
 *                STABILISER (one unresolved fault's next minute of decay is
 *                blocked). Each is consumed by its one use; none is permanent,
 *                tradeable or convertible.
 *
 * Nothing is rolled, nothing is chosen, nothing is budgeted. The reward is
 * dealt to the instance when the fault fires (so the card can say REPAIR
 * REWARD), paid exactly once by the authoritative completion — an accepted
 * code after its materials are gone, or the facilitator's explicit override —
 * under the key `faultReward:{run_id}:{instance}`, and written to the log.
 * Opening a card, assigning crew, a wrong code, a short tray, a refresh, a
 * reconnect or a replayed resolution: nothing.
 */

const TABLE = require('./fault-rewards.json');

const RESOURCES = ['power', 'water', 'parts', 'med'];
const NAMES = { power: 'POWER', water: 'WATER', parts: 'PARTS', med: 'MEDICAL' };
const SINGULAR = { power: 'Power Cell', water: 'Water Unit', parts: 'Spare Part', med: 'Med Supply' };
const STABILISER_S = 60;
const TOKENS = {
  RESERVE_CREW: {
    label: 'RESERVE CREW', title: 'Reserve Crew', effect: '+1 temporary worker for one repair',
    use: 'ARM FOR THIS REPAIR', timing: 'before the repair is submitted',
  },
  SECOND_CHANCE: {
    label: 'SECOND CHANCE', title: 'Second Chance', effect: 'one rejected code does not count toward the lockout',
    use: 'FORGIVE LAST REJECTION', timing: 'right after a rejected code',
  },
  EMERGENCY_REPAIR_KIT: {
    label: 'EMERGENCY REPAIR KIT', title: 'Emergency Repair Kit', effect: 'one repair needs 1 part fewer',
    use: 'ARM FOR THIS REPAIR', timing: 'before the repair is submitted',
  },
  STABILISER: {
    label: 'STABILISER', title: 'Stabiliser', effect: "blocks the next minute of one fault's decay",
    use: 'ACTIVATE ON THIS FAULT', timing: 'before the next decay',
  },
};

const units = (o) => Object.values(o || {}).reduce((a, v) => a + (Number(v) || 0), 0);
const round1 = (v) => Math.round(Number(v) * 10) / 10;

// -- the sectors a run plays with (a 3-sector session lists them) -----------------------

function activeSectors(game) {
  const all = Object.keys(game.state.sectors);
  const cfg = game.cfg.active_sectors;
  if (Array.isArray(cfg) && cfg.length) {
    const want = new Set(cfg.map((c) => String(c).toUpperCase()));
    return all.filter((c) => want.has(c));
  }
  return all;
}

/** Active, not DARK, above the floor. */
function liveSectors(game) {
  return activeSectors(game).map((c) => game.state.sectors[c]).filter((s) => s && s.status !== 'DARK' && s.integrity > 0);
}

// -- the table ---------------------------------------------------------------------------

/** The fixed reward for a fault code, a scenario override folded in; null when the code has none. */
function tableReward(game, code) {
  const over = ((game.cfg || {}).fault_reward_overrides || {})[code];
  const raw = over && over.type ? over : (TABLE.rewards || {})[code] || null;
  if (!raw) return null;
  const type = String(raw.type || '').toUpperCase();
  if (type === 'RESOURCE') {
    const resource = String(raw.resource || '').toLowerCase();
    if (!RESOURCES.includes(resource)) return null;
    const amount = Math.max(1, Math.floor(Number(raw.amount) || 1));
    return { type, resource, amount, text: `+${amount} ${NAMES[resource]}`, banner: `+${amount} ${SINGULAR[resource]}${amount === 1 ? '' : 's'}` };
  }
  if (type === 'INTEGRITY') {
    const amount = Math.max(1, Math.floor(Number(raw.amount ?? TABLE.integrity_default ?? 5)));
    return { type, amount, text: `+${amount} INTEGRITY`, banner: `+${amount} Integrity` };
  }
  if (type === 'OPPORTUNITY') {
    const token = String(raw.token || '').toUpperCase();
    if (!TOKENS[token]) return null;
    return { type, token, amount: 1, text: TOKENS[token].label, banner: `${TOKENS[token].title} token` };
  }
  return null;
}

const valueOf = (r) => (r.type === 'RESOURCE' ? { resource: r.resource, amount: r.amount }
  : r.type === 'INTEGRITY' ? { integrity: r.amount } : { token: r.token });

/** Deal the instance its reward when it fires: the table's, verbatim, never rolled. */
function assign(game, sectorCode, fault) {
  if (game.cfg.fault_rewards_enabled === false) return null;
  const r = tableReward(game, fault.code);
  if (!r) {
    game.log.write('fault_reward_unmapped', { fault: fault.code, instance: fault.id, sector: sectorCode });
    return null;
  }
  const reward = { ...r, fixed: true, label: r.text, display_label: r.text, assigned_at: new Date().toISOString() };
  game.log.write('fault_reward_assigned', {
    run_id: game.state.run_id, instance: fault.id, fault: fault.code, sector: sectorCode,
    reward_type: r.type, reward_value: valueOf(r), label: r.text, assignment_round: game.state.round,
  });
  return reward;
}

// -- what the screens say ----------------------------------------------------------------

/** The exact words on the card. */
function previewLine(reward) {
  return reward ? String(reward.text || reward.label || '') : '';
}

/** What actually happened, in the table's words. */
function resultLine(reward, result = {}) {
  if (!reward) return '';
  if (reward.type === 'RESOURCE') return `+${result.amount != null ? result.amount : reward.amount} ${NAMES[reward.resource]}`;
  if (reward.type === 'INTEGRITY') {
    const got = result.integrity != null ? result.integrity : reward.amount;
    return `+${Math.round(got)} INTEGRITY${result.capped ? ' (AT MAXIMUM)' : ''}`;
  }
  if (reward.type === 'OPPORTUNITY') return `${TOKENS[reward.token].label} TOKEN`;
  return previewLine(reward);
}

/** The screen's view: the reward's words, whether it has been paid. Null when previews are off. */
function preview(game, fault) {
  if (game.cfg.fault_rewards_enabled === false || game.cfg.show_fault_reward_preview === false) return null;
  const r = fault.reward;
  if (!r) return null;
  const claimed = !!game.state.rewards_claimed[fault.id];
  return {
    type: r.type, resource: r.resource || null, amount: r.amount || null, token: r.token || null,
    text: previewLine(r), label: 'REPAIR REWARD', display: `REPAIR REWARD: ${previewLine(r)}`, banner: r.banner || previewLine(r),
    claimed, result_text: claimed && r.result_text ? r.result_text : null,
  };
}

// -- paying it ---------------------------------------------------------------------------

/** Health is points, capped, and never revives DARK. Returns what was applied. */
function healSector(game, sector, points, cap = Math.min(100, Number(game.cfg.reward_health_cap ?? 100))) {
  if (!sector || points <= 0 || sector.status === 'DARK' || sector.integrity <= 0) return 0;
  const next = Math.min(cap, Math.max(sector.integrity, Math.min(cap, sector.integrity + points)));
  const applied = round1(next - sector.integrity);
  sector.integrity = next;
  game.refreshStatus(sector);
  return applied;
}

/**
 * Exactly once, by the authoritative completion. A force-resolve pays only
 * with the facilitator's explicit override (and the switch), logged as one.
 */
function apply(game, sectorCode, fault, { via = 'resolve', by = 'sector', force = false } = {}) {
  const key = `faultReward:${game.state.run_id}:${fault.id}`;
  const common = { fault: fault.code, instance: fault.id, sector: sectorCode, key, via, by, run_id: game.state.run_id, round: game.state.round };
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
    game.log.write('fault_reward_force_resolve_skipped', { ...common, reward_type: reward.type });
    return { applied: false, reason: 'force_resolve', key, text: previewLine(reward) };
  }
  const sector = game.state.sectors[sectorCode];
  if (!sector) return { applied: false, reason: 'unknown_sector', key };

  const now = new Date().toISOString();
  const result = {};
  if (reward.type === 'RESOURCE') {
    sector.inventory[reward.resource] = (Number(sector.inventory[reward.resource]) || 0) + reward.amount;
    result.resource = reward.resource;
    result.amount = reward.amount;
  } else if (reward.type === 'INTEGRITY') {
    const before = sector.integrity;
    const got = healSector(game, sector, reward.amount);
    result.integrity = got;
    result.before = round1(before);
    result.after = round1(sector.integrity);
    result.capped = got < reward.amount;
  } else if (reward.type === 'OPPORTUNITY') {
    const entry = grant(game, sectorCode, reward.token, { source_fault: fault.id, fault_code: fault.code, by: 'reward', at: now });
    result.token = reward.token;
    result.token_id = entry ? entry.id : null;
  }
  const value = reward.type === 'INTEGRITY' ? { integrity: reward.amount, applied: result.integrity } : valueOf(reward);

  game.state.rewards_claimed[fault.id] = { key, at: now, sector: sectorCode, via, by, instance: fault.id, fault: fault.code, type: reward.type, value };
  reward.applied_at = now;
  reward.result = result;
  reward.result_text = resultLine(reward, result);
  fault.reward_applied = true;
  fault.reward_awarded_at = now;
  game.log.write('reward_awarded', {
    ...common, reward_type: reward.type, reward_value: value, reward_awarded_at: now,
    result: { ...result }, result_text: reward.result_text, facilitator_override: override,
  });
  if (override) game.log.write('fault_reward_admin_override', { ...common, reward_type: reward.type, reward_value: value });
  game.ticker('reward', `${sectorCode} ${fault.code} REWARD ${reward.result_text}`, { scope: 'admin' });
  game.touch();
  return {
    applied: true, key, via, type: reward.type, text: previewLine(reward), result_text: reward.result_text, banner: reward.banner,
    resources: reward.type === 'RESOURCE' ? { [reward.resource]: reward.amount } : {},
    integrity: result.integrity || 0, token: reward.token || null, facilitator_override: override,
  };
}

// -- the tokens --------------------------------------------------------------------------

function tokensOf(sector) {
  if (!Array.isArray(sector.opportunities)) sector.opportunities = [];
  return sector.opportunities;
}
function usedOf(sector) {
  if (!Array.isArray(sector.opportunities_used)) sector.opportunities_used = [];
  return sector.opportunities_used;
}

/** One token into the sector's store — from a reward, or from the facilitator's hand. */
function grant(game, sectorCode, token, { source_fault = null, fault_code = null, by = 'reward', at = new Date().toISOString() } = {}) {
  const sector = game.state.sectors[sectorCode];
  const def = TOKENS[token];
  if (!sector || !def) return null;
  const entry = { id: game.id('T'), token, label: def.label, awarded_at: at, source_fault, fault_code, by };
  tokensOf(sector).push(entry);
  game.log.write('opportunity_granted', { sector: sectorCode, token, id: entry.id, fault: fault_code, instance: source_fault, by, round: game.state.round });
  return entry;
}

/** The facilitator's emergency correction: one token out of the store, with a reason. */
function revoke(game, sectorCode, token, { by = 'facilitator', reason = null } = {}) {
  const sector = game.state.sectors[sectorCode];
  if (!sector) return { ok: false, reason: 'unknown_sector' };
  token = String(token || '').toUpperCase();
  const list = tokensOf(sector);
  const i = list.findIndex((e) => e.token === token);
  if (i < 0) return { ok: false, reason: 'no_token', token };
  const [entry] = list.splice(i, 1);
  game.log.write('opportunity_revoked', { sector: sectorCode, token, id: entry.id, by, reason, round: game.state.round });
  game.touch();
  return { ok: true, token, id: entry.id, remaining: list.filter((e) => e.token === token).length };
}

function consume(game, sectorCode, entry, detail = {}) {
  const sector = game.state.sectors[sectorCode];
  const list = tokensOf(sector);
  const i = list.indexOf(entry);
  if (i >= 0) list.splice(i, 1);
  const used = { ...entry, used_at: new Date().toISOString(), ...detail };
  usedOf(sector).push(used);
  game.log.write('opportunity_used', {
    sector: sectorCode, token: entry.token, id: entry.id, fault: detail.fault || null, instance: detail.instance || null,
    effect: detail.effect || null, opportunity_token_used_at: used.used_at, by: detail.by || sectorCode, round: game.state.round,
  });
  game.ticker('reward', `${sectorCode} USED ${entry.label}${detail.fault ? ` ON ${detail.fault}` : ''}`, { scope: 'admin' });
  return used;
}

function latestRejected(sector) {
  let best = null;
  for (const f of sector.faults) {
    if (f.resolved || !f.last_rejection || f.last_rejection.forgiven) continue;
    if (!best || f.last_rejection.at > best.last_rejection.at) best = f;
  }
  return best;
}

/**
 * A table spends one stored token. RESERVE CREW and the REPAIR KIT are armed
 * on one unresolved fault for its next attempt; SECOND CHANCE forgives the
 * latest rejected code; the STABILISER blocks one fault's decay for a minute.
 */
function useOpportunity(game, sectorCode, token, { fault = null, by = sectorCode } = {}) {
  const sector = game.state.sectors[sectorCode];
  if (!sector) return { ok: false, reason: 'unknown_sector' };
  token = String(token || '').toUpperCase();
  if (!TOKENS[token]) return { ok: false, reason: 'unknown_token' };
  const entry = tokensOf(sector).find((e) => e.token === token);
  if (!entry) return { ok: false, reason: 'no_token', token };
  const code = fault ? String(fault).toUpperCase() : null;
  const live = code ? sector.faults.find((f) => f.code === code && !f.resolved) : null;

  if (token === 'RESERVE_CREW' || token === 'EMERGENCY_REPAIR_KIT') {
    if (!live) return { ok: false, reason: 'fault_required', token };
    const slot = token === 'RESERVE_CREW' ? 'reserve_crew' : 'repair_kit';
    live.armed = live.armed || {};
    if (live.armed[slot]) return { ok: false, reason: 'already_armed', token, fault: live.code };
    if (token === 'EMERGENCY_REPAIR_KIT' && !(Number((live.resources_required || {}).parts) > 0)) {
      return { ok: false, reason: 'no_parts_to_reduce', token, fault: live.code };
    }
    live.armed[slot] = entry.id;
    const used = consume(game, sectorCode, entry, { fault: live.code, instance: live.id, effect: 'armed', by });
    game.touch();
    return { ok: true, token, fault: live.code, effect: 'armed', id: used.id };
  }

  if (token === 'SECOND_CHANCE') {
    const target = live || latestRejected(sector);
    if (!target || !target.last_rejection || target.last_rejection.forgiven) return { ok: false, reason: 'nothing_to_forgive', token };
    const threshold = Number(game.cfg.lockout_after_consecutive_invalid ?? 3);
    let unlocked = false;
    if (target.last_rejection.locked) {
      // That rejection was the one that locked the console: the lock lifts and
      // the rejections before it still count.
      if (target.locked_until_s > 0) { target.locked_until_s = 0; unlocked = true; }
      target.lockouts = Math.max(0, (target.lockouts || 0) - 1);
      target.consecutive_invalid = Math.max(0, threshold - 1);
    } else {
      target.consecutive_invalid = Math.max(0, (target.consecutive_invalid || 0) - 1);
    }
    target.last_rejection.forgiven = true;
    target.forgiven_rejections = (target.forgiven_rejections || 0) + 1;
    const used = consume(game, sectorCode, entry, { fault: target.code, instance: target.id, effect: unlocked ? 'rejection_forgiven_unlocked' : 'rejection_forgiven', by });
    game.touch();
    return { ok: true, token, fault: target.code, effect: 'rejection_forgiven', unlocked, consecutive_invalid: target.consecutive_invalid, id: used.id };
  }

  if (token === 'STABILISER') {
    if (!live) return { ok: false, reason: 'fault_required', token };
    if (!(Number(live.decay_per_min) > 0)) return { ok: false, reason: 'no_decay', token, fault: live.code };
    if (game.state.effects.some((e) => e.kind === 'fault_stabilised' && e.target === live.id)) return { ok: false, reason: 'already_stabilised', token, fault: live.code };
    const e = game.addEffect({
      kind: 'fault_stabilised', target: live.id, sector: sectorCode, fault_code: live.code,
      mode: 'PAUSE', multiplier: 0, duration_s: STABILISER_S, remaining_s: STABILISER_S,
      expires: 'round', round: game.state.round, label: 'STABILISER', source: entry.id,
    });
    const used = consume(game, sectorCode, entry, { fault: live.code, instance: live.id, effect: `decay_blocked_${STABILISER_S}s`, by, effect_id: e.id });
    game.touch();
    return { ok: true, token, fault: live.code, effect: 'decay_blocked', duration_s: STABILISER_S, id: used.id };
  }
  return { ok: false, reason: 'unknown_token' };
}

/** What a fault has armed for its next attempt. */
function armedFor(fault) {
  const a = (fault && fault.armed) || {};
  return { crew_bonus: a.reserve_crew ? 1 : 0, parts_off: a.repair_kit ? 1 : 0, reserve_crew: !!a.reserve_crew, repair_kit: !!a.repair_kit };
}

/** The binder's recipe, one part fewer when the kit is armed — never below zero, never any other material. */
function effectiveRequirements(fault) {
  const req = { ...((fault && fault.resources_required) || {}) };
  const { parts_off } = armedFor(fault);
  if (parts_off && Number(req.parts) > 0) req.parts = Math.max(0, Number(req.parts) - parts_off);
  return req;
}

/** The attempt has begun: whatever was armed is spent, whatever the outcome. */
function spendArmed(game, sectorCode, fault, { outcome = 'attempt' } = {}) {
  const a = fault.armed;
  if (!a || (!a.reserve_crew && !a.repair_kit)) return [];
  const sector = game.state.sectors[sectorCode];
  const spent = [];
  for (const [slot, id] of Object.entries(a)) {
    if (!id) continue;
    const used = usedOf(sector).find((u) => u.id === id);
    if (used) { used.applied_at = new Date().toISOString(); used.applied_outcome = outcome; }
    const token = slot === 'reserve_crew' ? 'RESERVE_CREW' : 'EMERGENCY_REPAIR_KIT';
    spent.push(token);
    game.log.write('opportunity_applied', { sector: sectorCode, fault: fault.code, instance: fault.id, token, id, outcome, round: game.state.round });
  }
  fault.armed = null;
  return spent;
}

/** A rejected code, remembered so SECOND CHANCE can forgive exactly that one. */
function noteRejection(fault, { locked = false } = {}) {
  fault.last_rejection = { at: new Date().toISOString(), attempt: fault.attempts, locked, forgiven: false };
}

/** The screen's view of a sector's tokens. */
function tokensView(sector) {
  const tokens = tokensOf(sector).map((e) => ({ id: e.id, token: e.token, ...TOKENS[e.token], awarded_at: e.awarded_at, fault_code: e.fault_code, by: e.by }));
  const counts = {};
  for (const t of tokens) counts[t.token] = (counts[t.token] || 0) + 1;
  return {
    tokens, counts,
    used: usedOf(sector).slice(-5).map((u) => ({ token: u.token, label: u.label, used_at: u.used_at, fault: u.fault || null, effect: u.effect || null })),
  };
}

// -- timed effects (the STABILISER's minute) -----------------------------------------------

/** A stabilisation on a fault ends with it. */
function endEffectsFor(game, faultId) {
  for (const e of [...game.state.effects]) if (e.kind === 'fault_stabilised' && e.target === faultId) game.removeEffect(e.id);
}

/** The decay multiplier on a fault from stabilisation effects (1 = untouched). */
function decayMultiplier(game, fault) {
  let m = 1;
  for (const e of game.state.effects) if (e.kind === 'fault_stabilised' && e.target === fault.id) m *= Number(e.multiplier);
  return m;
}

/** Timed effects count down in game time and end on their own. */
function tickEffects(game, secs) {
  for (const e of [...game.state.effects]) {
    if (e.remaining_s === undefined) continue;
    e.remaining_s = Math.max(0, Number(e.remaining_s) - secs);
    if (e.remaining_s <= 0) game.removeEffect(e.id);
  }
}

module.exports = {
  TABLE, TOKENS, RESOURCES, NAMES, STABILISER_S, units, activeSectors, liveSectors,
  tableReward, assign, preview, previewLine, resultLine, healSector, apply,
  grant, revoke, useOpportunity, armedFor, effectiveRequirements, spendArmed, noteRejection, tokensView,
  endEffectsFor, decayMultiplier, tickEffects,
};
