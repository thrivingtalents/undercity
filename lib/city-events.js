'use strict';
/**
 * CITY EVENTS (CITY_EVENTS_V1, 2026-10-06), mixed into GameState.
 *
 * Ten facilitator-triggered, city-wide events — five GOOD, five BAD — fired
 * by one press of ACTIVATE on the Admin Control Panel. They are not faults:
 * no procedure, no code, nothing on ACTIVE FAULTS, nothing to acknowledge.
 * The press is authoritative: once the server accepts it, every effect of the
 * event is applied at once, the run log records it, and the room is told.
 *
 * ACTIVE AND INACTIVE (later on 2026-10-06). An activation stays ACTIVE until
 * the facilitator presses DEACTIVATE or it expires by itself — a THIS_ROUND
 * event with the round, a NEXT_UPKEEP event with the upkeep that consumes it,
 * a MIXED event when its last lasting component ends, an IMMEDIATE event with
 * the round (the round is the period: its once-a-round mark clears then, and
 * so does its presentation). DEACTIVATE ends only what is still in force —
 * the round modifiers still live, the upkeep modifiers not yet consumed — and
 * never what already happened: Health taken or given, Workers injured,
 * transfers approved, heals performed. `state.city_events.active` holds the
 * live activations in activation order; the newest one owns the overlay.
 *
 * NOTHING NEW UNDERNEATH. Each effect in lib/city-events.json is applied
 * through a mechanism the engine already has:
 *
 *   health                → setIntegrity (clamped 0–100; DARK at 0 as ever;
 *                            a gain skips DARK sectors — Emergency Restart is
 *                            the only way back)
 *   injure_workers        → injure() (moves at most what is there; MED heals
 *                            through its normal queue)
 *   extra_workers         → the extra_workers effect availableWorkers reads,
 *                            one per sector, expiring with the round
 *   trn_capacity          → the trn_capacity effect trnCapacity reads
 *   med_healing_capacity  → the med_capacity effect medCapacity reads
 *   upkeep_modifier       → the upkeep_extra obligation upkeepFor adds and
 *                            the economy pass retires (cycles_remaining 1)
 *
 * The definitions live in lib/city-events.json and nowhere else; the control
 * panel reads them off the control frame (cityEventsView) and prints the
 * effect line this module derives from `effects`, so no number is typed in
 * two places. Everything here is `this`-bound onto GameState.prototype.
 */
const DEFS = require('./city-events.json');

const KINDS = new Set(['health', 'injure_workers', 'extra_workers', 'trn_capacity', 'med_healing_capacity', 'upkeep_modifier']);
const TARGET_TOKENS = new Set(['ALL_SECTORS', 'ALL_NON_DARK_SECTORS']);
const DURATIONS = new Set(['IMMEDIATE', 'THIS_ROUND', 'NEXT_UPKEEP', 'MIXED']);
const POLICIES = new Set(['ONCE_PER_ROUND', 'BLOCK_WHILE_PENDING']);
const RES_WORD = { power: 'POWER', water: 'WATER', parts: 'PARTS', med: 'MED' };
const HISTORY_MAX = 50;
/** The activation wash: how long every screen holds the full overlay before it collapses to the subtle state. */
const TAKEOVER_S = 4;
/** What the screens say beside the colour — never colour alone. */
const LABEL = { GOOD: 'POSITIVE CITY EVENT', BAD: 'CITY EMERGENCY' };
const COLOUR = { GOOD: 'green', BAD: 'red' };

// -- the catalogue, checked once at load -------------------------------------------
function check(cond, msg) { if (!cond) throw new Error(`lib/city-events.json: ${msg}`); }
check(Array.isArray(DEFS.events) && DEFS.events.length > 0, 'events must be a non-empty list');
const byId = new Map();
for (const def of DEFS.events) {
  check(typeof def.id === 'string' && /^[A-Z][A-Z0-9_]+$/.test(def.id), `event id "${def.id}" must be UPPER_SNAKE`);
  check(!byId.has(def.id), `${def.id} is listed twice`);
  check(typeof def.name === 'string' && def.name.trim(), `${def.id}: name`);
  check(def.type === 'GOOD' || def.type === 'BAD', `${def.id}: type must be GOOD or BAD`);
  check(typeof def.description === 'string' && typeof def.player_message === 'string', `${def.id}: description and player_message`);
  check(DURATIONS.has(def.duration), `${def.id}: duration ${def.duration}`);
  check(POLICIES.has(def.repeat_policy), `${def.id}: repeat_policy ${def.repeat_policy}`);
  check(Array.isArray(def.effects) && def.effects.length > 0, `${def.id}: effects`);
  for (const fx of def.effects) {
    check(KINDS.has(fx.kind), `${def.id}: effect kind ${fx.kind}`);
    check(typeof fx.target === 'string' && (TARGET_TOKENS.has(fx.target) || /^[A-Z]{3}$/.test(fx.target)), `${def.id}: target ${fx.target}`);
    if (fx.kind === 'injure_workers') check(Number.isInteger(fx.quantity) && fx.quantity > 0, `${def.id}: injure_workers quantity`);
    else check(Number.isInteger(fx.delta) && fx.delta !== 0, `${def.id}: ${fx.kind} delta`);
    if (fx.kind === 'upkeep_modifier') check(RES_WORD[String(fx.resource || '').toLowerCase()], `${def.id}: upkeep_modifier resource ${fx.resource}`);
  }
  byId.set(def.id, def);
}

// -- words --------------------------------------------------------------------------
const sign = (n) => `${Number(n) > 0 ? '+' : ''}${Number(n)}`;
const plural = (n, one, many) => (Math.abs(Number(n)) === 1 ? one : many);
const who = (token) => (token === 'ALL_SECTORS' ? 'ALL SECTORS' : token === 'ALL_NON_DARK_SECTORS' ? 'OPERATING SECTORS' : String(token));

/** The card's effect line, derived from the effects so it can never disagree with them. */
function effectSummary(def) {
  const parts = [];
  for (const fx of def.effects) {
    switch (fx.kind) {
      case 'health': parts.push(`${who(fx.target)} ${sign(fx.delta)} HEALTH`); break;
      case 'injure_workers': parts.push(`${fx.quantity} ${plural(fx.quantity, 'WORKER', 'WORKERS')} INJURED IN ${fx.target === 'ALL_SECTORS' ? 'EVERY SECTOR' : who(fx.target)}`); break;
      case 'trn_capacity': parts.push(`TRN ${sign(fx.delta)} TRANSFER ${plural(fx.delta, 'APPROVAL', 'APPROVALS')} · THIS ROUND`); break;
      case 'med_healing_capacity': parts.push(`MED ${sign(fx.delta)} ${plural(fx.delta, 'HEAL', 'HEALS')} · THIS ROUND`); break;
      case 'extra_workers': parts.push(`${who(fx.target)} ${sign(fx.delta)} WORKER · THIS ROUND`); break;
      case 'upkeep_modifier': parts.push(`${who(fx.target)} ${sign(fx.delta)} ${RES_WORD[String(fx.resource).toLowerCase()]} · NEXT UPKEEP`); break;
      default: break;
    }
  }
  return parts.join(' · ');
}

/** What the screens say under the event's name: the player message without the name it starts with. */
function playerLine(def) {
  const esc = def.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(def.player_message || '').replace(new RegExp(`^\\s*${esc}\\s*[—–-]\\s*`), '').trim();
}

/** When the event's lasting effects end, for the log. */
function expiryWord(def) {
  const round = def.effects.some((fx) => ['trn_capacity', 'med_healing_capacity', 'extra_workers'].includes(fx.kind));
  const upkeep = def.effects.some((fx) => fx.kind === 'upkeep_modifier');
  return round && upkeep ? 'ROUND_CHANGE+NEXT_UPKEEP' : round ? 'ROUND_CHANGE' : upkeep ? 'NEXT_UPKEEP' : 'NONE';
}

/** One ACTIVE CITY EFFECTS line for a group of live effects from one activation. */
function activeText(group, sectorCount) {
  const all = group.targets.length >= sectorCount;
  const many = all ? 'ALL SECTORS' : group.targets.join(' + ');
  switch (group.kind) {
    case 'trn_capacity': return `TRN ${sign(group.delta)} TRANSFER CAPACITY · UNTIL ROUND END`;
    case 'med_capacity': return `MED ${sign(group.delta)} ${plural(group.delta, 'HEAL', 'HEALS')} · UNTIL ROUND END`;
    case 'extra_workers': return `${many} ${sign(group.delta)} WORKER · UNTIL ROUND END`;
    case 'upkeep_extra': return `${many} ${Object.entries(group.add || {}).map(([k, v]) => `${sign(v)} ${RES_WORD[k] || k.toUpperCase()}`).join(' ')} · NEXT UPKEEP`;
    default: return `${many} ${String(group.kind).toUpperCase().replace(/_/g, ' ')}`;
  }
}

/** The live effects of one activation, grouped the way the panel prints them. */
function groupEffects(live) {
  const groups = new Map();
  for (const e of live) {
    const size = e.kind === 'upkeep_extra' ? JSON.stringify(e.add || {}) : String(e.delta);
    const key = `${e.activation}|${e.kind}|${size}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key, activation: e.activation || null, event_id: e.event_id, name: e.event_name || e.label || e.event_id, kind: e.kind,
        delta: e.delta ?? null, add: e.add || null, targets: [], effect_ids: [],
        until: e.kind === 'upkeep_extra' ? 'NEXT_UPKEEP' : 'ROUND_END', cycles_remaining: e.cycles_remaining ?? null,
      });
    }
    const g = groups.get(key);
    g.targets.push(e.target);
    g.effect_ids.push(e.id);
  }
  return [...groups.values()];
}

// -- the mixin ----------------------------------------------------------------------

function cityEventDefs() { return DEFS.events; }

function cityEventDef(id) { return byId.get(String(id || '').trim().toUpperCase()) || null; }

/**
 * The run's event bookkeeping, given its shape. A snapshot from before
 * 2026-10-06 has none; one from before ACTIVATE / DEACTIVATE (the same day)
 * has no `active` list, so it is rebuilt from the effects still live: an
 * event whose modifiers are still in force is still active, in the order
 * the history says they were activated. Nothing immediate is replayed.
 */
function cityEventsState() {
  const st = this.state;
  if (!st.city_events || typeof st.city_events !== 'object') st.city_events = { used: {}, history: [], active: [] };
  const ce = st.city_events;
  if (!ce.used || typeof ce.used !== 'object') ce.used = {};
  if (!Array.isArray(ce.history)) ce.history = [];
  if (!Array.isArray(ce.active)) {
    const records = new Map();
    for (const e of (st.effects || [])) {
      if (e.source !== 'city_event' || !e.activation) continue;
      if (!records.has(e.activation)) {
        const def = byId.get(e.event_id) || null;
        const h = ce.history.find((x) => x.id === e.activation) || {};
        records.set(e.activation, {
          activation: e.activation, event_id: e.event_id,
          event_name: e.event_name || (def && def.name) || e.event_id, event_type: e.event_type || (def && def.type) || 'BAD',
          duration: def ? def.duration : 'THIS_ROUND',
          activated_at: h.t || null, activated_round: h.round || null, activated_by: h.by || 'facilitator',
          effects: {}, immediate: [], rebuilt: true,
        });
      }
      records.get(e.activation).effects[e.id] = { kind: e.kind, target: e.target, status: 'ACTIVE' };
    }
    ce.active = [...records.values()].sort((a, b) => String(a.activated_at || '').localeCompare(String(b.activated_at || '')));
  }
  return ce;
}

/** The live effects a City Event created (all of them, or one event's). */
function cityEventEffects(eventId = null) {
  return (this.state.effects || []).filter((e) => e.source === 'city_event' && (!eventId || e.event_id === eventId));
}

/** The active record of an event, or null: one event is active at most once at a time. */
function cityEventActive(eventId) {
  const id = String(eventId || '').trim().toUpperCase();
  return this.cityEventsState().active.find((r) => r.event_id === id) || null;
}

/** The live effects of one activation. */
function activationEffects(game, record) {
  return game.cityEventEffects(record.event_id).filter((e) => e.activation === record.activation);
}

/** Whether the card can be pressed now, and the word it shows. */
function cityEventStatus(def) {
  const ce = this.cityEventsState();
  if (this.cityEventActive(def.id)) {
    return { state: 'active', reason: 'event_already_active', button: 'DEACTIVATE' };
  }
  if (def.repeat_policy === 'ONCE_PER_ROUND' && ce.used[def.id] === this.state.round) {
    return { state: 'used', reason: 'city_event_used_this_round', button: 'USED THIS ROUND' };
  }
  if (def.repeat_policy === 'BLOCK_WHILE_PENDING' && this.cityEventEffects(def.id).length) {
    return { state: 'pending', reason: 'city_event_pending', button: 'PENDING' };
  }
  return { state: 'available', reason: null, button: 'ACTIVATE' };
}

/** The sectors a target token names right now; null for a token the engine does not know. */
function cityEventTargets(token) {
  const all = Object.values(this.state.sectors);
  const t = String(token || '').toUpperCase();
  if (t === 'ALL_SECTORS') return all.map((s) => s.code);
  if (t === 'ALL_NON_DARK_SECTORS') return all.filter((s) => s.status !== 'DARK').map((s) => s.code);
  if (this.state.sectors[t]) return [t];
  return null;
}

/** The history entry of an activation, closed with how it ended. */
function closeHistory(ce, record, how, reason, t) {
  const h = ce.history.find((x) => x.id === record.activation);
  if (h) { h.ended_at = t; h.ended_by = how; h.ended_reason = reason; }
}

/**
 * ACTIVATE. Validates first — the event, the run, the active state, the
 * repeat policy, every effect's kind and target — and applies nothing until
 * all of it has passed; then applies every effect through the helper that
 * already owns it, marks the repeat policy, records the activation as ACTIVE,
 * and tells the room. A second press of the same card while it is active (or
 * in the same round, or while its upkeep modifier is pending) is refused
 * here, so a double-click applies once.
 */
function activateCityEvent(eventId, { by = 'facilitator' } = {}) {
  const def = this.cityEventDef(eventId);
  if (!def) return { ok: false, reason: 'unknown_city_event', event_id: eventId };
  if (this.state.mode === 'ENDED') return { ok: false, reason: 'run_ended', event_id: def.id };
  const status = this.cityEventStatus(def);
  if (status.state !== 'available') return { ok: false, reason: status.reason, event_id: def.id, status: status.state };

  const hmin = Number((DEFS.health || {}).min ?? 0);
  const hmax = Number((DEFS.health || {}).max ?? 100);
  const plan = [];
  for (const fx of def.effects) {
    const targets = this.cityEventTargets(fx.target);
    if (!targets) return { ok: false, reason: 'unknown_target', event_id: def.id, target: fx.target };
    switch (fx.kind) {
      case 'health':
        plan.push({ kind: 'health', targets, delta: Number(fx.delta), cap: Math.min(hmax, Number(fx.cap ?? hmax)), floor: Math.max(hmin, Number(fx.floor ?? hmin)) });
        break;
      case 'injure_workers':
        plan.push({ kind: 'injure_workers', targets, quantity: Math.max(0, Math.round(Number(fx.quantity) || 0)) });
        break;
      case 'extra_workers':
        plan.push({ kind: 'extra_workers', targets, delta: Number(fx.delta) });
        break;
      case 'trn_capacity':
        plan.push({ kind: 'trn_capacity', targets: ['TRN'], delta: Number(fx.delta) });
        break;
      case 'med_healing_capacity':
        plan.push({ kind: 'med_capacity', targets: ['MED'], delta: Number(fx.delta) });
        break;
      case 'upkeep_modifier': {
        const resource = String(fx.resource || '').toLowerCase();
        if (!RES_WORD[resource]) return { ok: false, reason: 'unknown_resource', event_id: def.id, resource: fx.resource };
        plan.push({ kind: 'upkeep_extra', targets, resource, delta: Number(fx.delta), cycles: Math.max(1, Math.round(Number(fx.cycles_remaining) || 1)) });
        break;
      }
      default:
        return { ok: false, reason: 'unknown_effect_kind', event_id: def.id, kind: fx.kind };
    }
  }
  for (const op of plan) {
    if (op.kind !== 'injure_workers' && !Number.isFinite(op.delta)) return { ok: false, reason: 'invalid_delta', event_id: def.id, kind: op.kind };
  }

  // Everything checked: apply, all of it.
  const ce = this.cityEventsState();
  const activation = this.id('CE');
  const t = new Date().toISOString();
  const round = this.state.round;
  const stamp = { source: 'city_event', event_id: def.id, event_name: def.name, event_type: def.type, activation, label: def.name };
  const applied = [];
  const health = {};
  const affected = new Set();
  // The record: what still runs (effects, by id and status) and what already happened (immediate).
  const record = {
    activation, event_id: def.id, event_name: def.name, event_type: def.type, duration: def.duration,
    activated_at: t, activated_round: round, activated_by: by, effects: {}, immediate: [],
  };

  for (const op of plan) {
    switch (op.kind) {
      case 'health': {
        // The DARK sectors a gain leaves alone are written down, whether the
        // token excluded them or the loop skipped them: the log says who was
        // not revived, not just who was helped.
        const rec = {
          kind: 'health', delta: op.delta, sectors: {},
          skipped_dark: op.delta > 0 ? Object.values(this.state.sectors).filter((s) => s.status === 'DARK' && !op.targets.includes(s.code)).map((s) => s.code) : [],
        };
        for (const code of op.targets) {
          const s = this.state.sectors[code];
          const before = Math.round(s.integrity);
          // A gain never revives a DARK sector: Emergency Restart is the only way back.
          if (op.delta > 0 && s.status === 'DARK') { rec.skipped_dark.push(code); continue; }
          this.setIntegrity(code, Math.max(op.floor, Math.min(op.cap, s.integrity + op.delta)));
          const after = Math.round(s.integrity);
          rec.sectors[code] = { before, after, status: s.status };
          health[code] = { before, after };
          affected.add(code);
        }
        applied.push(rec);
        record.immediate.push({ kind: 'health', delta: op.delta, sectors: Object.keys(rec.sectors), text: `${sign(op.delta)} HEALTH` });
        break;
      }
      case 'injure_workers': {
        const rec = { kind: 'injure_workers', quantity: op.quantity, sectors: {} };
        for (const code of op.targets) {
          // injure() moves at most what is active, so a sector with nobody to injure injures nobody.
          const moved = op.quantity > 0 ? this.injure(code, op.quantity) : 0;
          rec.sectors[code] = moved;
          if (moved > 0) affected.add(code);
        }
        applied.push(rec);
        record.immediate.push({ kind: 'injure_workers', quantity: op.quantity, sectors: Object.keys(rec.sectors).filter((c) => rec.sectors[c] > 0), text: `${op.quantity} ${plural(op.quantity, 'WORKER', 'WORKERS')} INJURED` });
        break;
      }
      case 'extra_workers': {
        const rec = { kind: 'extra_workers', delta: op.delta, effects: {} };
        for (const code of op.targets) {
          const e = this.addEffect({
            kind: 'extra_workers', target: code, delta: op.delta, expires: 'round', round: this.periodKey(), ...stamp,
            player_label: `${sign(op.delta)} WORKER · THIS ROUND`,
            description: `${code} ${sign(op.delta)} available worker this round (${def.name})`,
          });
          rec.effects[code] = e.id;
          record.effects[e.id] = { kind: 'extra_workers', target: code, status: 'ACTIVE' };
          affected.add(code);
        }
        applied.push(rec);
        break;
      }
      case 'trn_capacity':
      case 'med_capacity': {
        const code = op.targets[0];
        const read = () => (op.kind === 'trn_capacity' ? this.trnCapacity() : this.medCapacity());
        const before = read();
        const e = this.addEffect({
          kind: op.kind, target: code, delta: op.delta, expires: 'round', round: this.periodKey(), ...stamp,
          player_label: op.kind === 'trn_capacity'
            ? `${sign(op.delta)} TRANSFER ${plural(op.delta, 'APPROVAL', 'APPROVALS')} · THIS ROUND`
            : `${sign(op.delta)} ${plural(op.delta, 'HEAL', 'HEALS')} · THIS ROUND`,
          description: `${code} ${sign(op.delta)} ${op.kind === 'trn_capacity' ? 'transfer approvals' : 'heals'} this round (${def.name})`,
        });
        applied.push({ kind: op.kind, target: code, delta: op.delta, effect: e.id, capacity_before: before, capacity_after: read() });
        record.effects[e.id] = { kind: op.kind, target: code, status: 'ACTIVE' };
        affected.add(code);
        break;
      }
      case 'upkeep_extra': {
        const rec = { kind: 'upkeep_extra', resource: op.resource, delta: op.delta, cycles: op.cycles, effects: {} };
        for (const code of op.targets) {
          const e = this.addEffect({
            kind: 'upkeep_extra', target: code, add: { [op.resource]: op.delta }, cycles_remaining: op.cycles, ...stamp,
            player_label: `${sign(op.delta)} ${RES_WORD[op.resource]} · NEXT UPKEEP`,
            description: `${code} ${sign(op.delta)} ${op.resource} at its next upkeep (${def.name})`,
          });
          rec.effects[code] = e.id;
          record.effects[e.id] = { kind: 'upkeep_extra', target: code, status: 'ACTIVE' };
          affected.add(code);
        }
        applied.push(rec);
        break;
      }
      default: break;
    }
  }

  if (def.repeat_policy === 'ONCE_PER_ROUND') ce.used[def.id] = round;
  ce.history.unshift({ id: activation, t, round, event_id: def.id, name: def.name, type: def.type, by, affected: [...affected] });
  if (ce.history.length > HISTORY_MAX) ce.history.length = HISTORY_MAX;
  ce.active.push(record);

  // THE ROOM: every console and the wall paint the event's own overlay from
  // the frame (cityEventOverlayView) — green for GOOD, red for BAD, with its
  // name and effect, then a subtle active state while it lasts. The feed line
  // and a sound go with it; the facilitator's red City Alert is not raised.
  this.ticker('event', def.name);
  this.sting(def.type === 'GOOD' ? 'chime' : 'alert');

  this.log.write('city_event_activated', {
    activation, round, event_id: def.id, event_name: def.name, event_type: def.type, by,
    effects_requested: def.effects.map((fx) => ({ ...fx })),
    effects_applied: applied,
    affected_sectors: [...affected],
    health,
    duration: def.duration, expiry: expiryWord(def), repeat_policy: def.repeat_policy,
  });
  this.touch();
  // `event_type`, not `type`: the server spreads this into a message whose `type` is city_event_result.
  return {
    ok: true, action: 'activate', activation, event_id: def.id, name: def.name, event_type: def.type, round, applied, health, affected: [...affected],
    active: true, overlay: COLOUR[def.type], label: LABEL[def.type],
  };
}

/**
 * DEACTIVATE. Ends what is still in force — the round modifiers still live
 * and the upkeep modifiers not yet consumed — and nothing that already
 * happened: Health taken or given, Workers injured, transfers approved and
 * heals performed stay exactly as they are. The record leaves the active
 * list, the overlay goes with it, and the log says what was removed, what
 * was cancelled and what was deliberately left alone.
 */
function deactivateCityEvent(eventId, { by = 'facilitator' } = {}) {
  const def = this.cityEventDef(eventId);
  if (!def) return { ok: false, reason: 'unknown_city_event', event_id: eventId };
  const ce = this.cityEventsState();
  const record = this.cityEventActive(def.id);
  if (!record) return { ok: false, reason: 'event_not_active', event_id: def.id };

  record.ending = true;
  const t = new Date().toISOString();
  const removed = [];
  const cancelled = [];
  const reconcile = new Set();
  for (const e of activationEffects(this, record)) {
    const entry = { effect: e.id, kind: e.kind, target: e.target, delta: e.delta ?? null, add: e.add || null };
    e.cancelled_by = 'deactivate';
    this.removeEffect(e.id);
    if (e.kind === 'upkeep_extra') cancelled.push(entry); else removed.push(entry);
    if (e.kind === 'extra_workers') reconcile.add(e.target);
  }
  // A sector that had committed the temporary Worker it just lost keeps its
  // commitments honest; availableWorkers never reads below zero anyway.
  for (const code of reconcile) if (typeof this.reconcileCommitments === 'function') this.reconcileCommitments(code);
  const notReversed = record.immediate.map((i) => ({ ...i }));

  ce.active = ce.active.filter((r) => r !== record);
  closeHistory(ce, record, 'deactivate', by, t);
  this.log.write('city_event_deactivated', {
    activation: record.activation, round: this.state.round, event_id: def.id, event_name: def.name, event_type: def.type, by, t,
    effects_removed: removed, pending_effects_cancelled: cancelled, effects_not_reversed: notReversed,
  });
  // The room hears about it when something it could feel has ended; otherwise only the facilitator's feed.
  this.ticker('event', `${def.name} — DEACTIVATED`, removed.length || cancelled.length ? {} : { scope: 'admin' });
  this.touch();
  return {
    ok: true, action: 'deactivate', activation: record.activation, event_id: def.id, name: def.name, event_type: def.type, round: this.state.round,
    effects_removed: removed, pending_effects_cancelled: cancelled, effects_not_reversed: notReversed, active: false,
  };
}

/**
 * Called by removeEffect for every effect a City Event created: an effect
 * that lasted the round has expired, an upkeep modifier has been consumed,
 * or DEACTIVATE cancelled it. When the last lasting effect of an activation
 * goes by itself, the activation has expired.
 */
function cityEventEffectEnded(e) {
  const cancelled = e.cancelled_by === 'deactivate';
  const ev = cancelled ? 'city_event_effect_cancelled' : e.kind === 'upkeep_extra' ? 'city_event_upkeep_effect_consumed' : 'city_event_effect_expired';
  this.log.write(ev, {
    effect: e.id, activation: e.activation || null, event_id: e.event_id, event_name: e.event_name || null,
    kind: e.kind, target: e.target, delta: e.delta ?? null, add: e.add || null, round: this.state.round,
    ...(cancelled ? { cancelled_by: e.cancelled_by } : {}),
  });
  const ce = this.cityEventsState();
  const record = ce.active.find((r) => r.activation === e.activation);
  if (!record) return;
  if (record.effects[e.id]) record.effects[e.id].status = cancelled ? 'CANCELLED' : e.kind === 'upkeep_extra' ? 'CONSUMED' : 'EXPIRED';
  if (!record.ending && !activationEffects(this, record).length) {
    this.cityEventExpire(record, e.kind === 'upkeep_extra' ? 'upkeep_consumed' : 'effects_expired');
  }
}

/** An activation ends by itself: its last lasting effect went, or the round turned over an immediate one. */
function cityEventExpire(record, reason) {
  const ce = this.cityEventsState();
  if (!ce.active.includes(record)) return false;
  const t = new Date().toISOString();
  ce.active = ce.active.filter((r) => r !== record);
  closeHistory(ce, record, 'expiry', reason, t);
  this.log.write('city_event_expired', {
    activation: record.activation, event_id: record.event_id, event_name: record.event_name, event_type: record.event_type,
    round: this.state.round, reason, t,
  });
  this.ticker('event', `${record.event_name} — ENDED`, { scope: 'admin' });
  this.touch();
  return true;
}

/**
 * The round turned over (cycleRefresh). The round modifiers have already
 * expired through removeEffect; what is left active with nothing lasting —
 * an IMMEDIATE event, a MIXED one whose components all went — ends now. An
 * activation still holding an unconsumed upkeep modifier stays active.
 */
function cityEventsRoundChanged() {
  const ce = this.cityEventsState();
  for (const record of [...ce.active]) {
    if (!activationEffects(this, record).length) this.cityEventExpire(record, 'round_change');
  }
}

/** What an active event still does, in the panel's words; immediate-only events have nothing left. */
function remainingText(game, record) {
  const groups = groupEffects(activationEffects(game, record));
  if (!groups.length) return record.duration === 'IMMEDIATE' ? 'IMMEDIATE · NO REMAINING EFFECT' : 'NO REMAINING EFFECT';
  const n = Object.keys(game.state.sectors).length;
  return groups.map((g) => activeText(g, n)).join(' · ');
}

/**
 * The overlay every screen paints (sector consoles and the wall): the active
 * events in activation order, and the newest as `current` with its colour,
 * its label beside the colour, and how far into its four-second wash it is.
 * Nothing internal: no event ids, no catalogue.
 */
function cityEventOverlayView() {
  const ce = this.cityEventsState();
  const active = ce.active.map((r) => {
    const def = byId.get(r.event_id) || null;
    return {
      activation: r.activation, name: r.event_name, type: r.event_type,
      label: LABEL[r.event_type] || LABEL.BAD, colour: COLOUR[r.event_type] || COLOUR.BAD,
      effect_summary: def ? effectSummary(def) : '', line: def ? playerLine(def) : '',
      activated_at: r.activated_at, round_number: r.activated_round ? this.roundOrdinal(r.activated_round) : null,
    };
  });
  const last = active.length ? active[active.length - 1] : null;
  const age = last && last.activated_at ? Math.max(0, (Date.now() - Date.parse(last.activated_at)) / 1000) : 0;
  return {
    active, count: active.length,
    current: last ? { ...last, age_s: Math.round(age), full_s: TAKEOVER_S, full_screen: age < TAKEOVER_S } : null,
  };
}

/** The control frame's CITY EVENTS: every card with its state, the active events, the live effects grouped, the run's history. */
function cityEventsView() {
  const ce = this.cityEventsState();
  const live = this.cityEventEffects();
  const sectorCount = Object.keys(this.state.sectors).length;
  return {
    version: DEFS.version,
    events: DEFS.events.map((def) => {
      const st = this.cityEventStatus(def);
      const record = this.cityEventActive(def.id);
      return {
        id: def.id, name: def.name, type: def.type, description: def.description, player_message: def.player_message,
        duration: def.duration, repeat_policy: def.repeat_policy, effect_summary: effectSummary(def),
        status: st.state, button: st.button, used_round: ce.used[def.id] || null,
        live_effects: live.filter((e) => e.event_id === def.id).length,
        active: !!record, activation: record ? record.activation : null,
        activated_round: record ? record.activated_round : null, activated_at: record ? record.activated_at : null,
        activated_by: record ? record.activated_by : null, remaining: record ? remainingText(this, record) : null,
      };
    }),
    active_events: ce.active.map((r) => ({
      activation: r.activation, event_id: r.event_id, name: r.event_name, type: r.event_type, label: LABEL[r.event_type] || LABEL.BAD,
      duration: r.duration, activated_round: r.activated_round, round_number: r.activated_round ? this.roundOrdinal(r.activated_round) : null,
      activated_at: r.activated_at, activated_by: r.activated_by, remaining: remainingText(this, r),
      effects: Object.entries(r.effects).map(([id, x]) => ({ id, ...x })), immediate: r.immediate.map((i) => ({ ...i })),
    })),
    active_effects: groupEffects(live).map((g) => ({ ...g, text: activeText(g, sectorCount) })),
    history: ce.history.slice(0, 20).map((h) => ({ ...h })),
  };
}

// Only methods: lib/state.js assigns this whole object onto GameState.prototype.
module.exports = {
  cityEventDefs, cityEventDef, cityEventsState, cityEventEffects, cityEventActive, cityEventStatus, cityEventTargets,
  activateCityEvent, deactivateCityEvent, cityEventEffectEnded, cityEventExpire, cityEventsRoundChanged,
  cityEventOverlayView, cityEventsView,
};
