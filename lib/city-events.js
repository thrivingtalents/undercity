'use strict';
/**
 * CITY EVENTS (CITY_EVENTS_V1, 2026-10-06), mixed into GameState.
 *
 * Ten facilitator-triggered, city-wide events — five GOOD, five BAD — fired
 * by one press of ACTIVATE on the Admin Control Panel. They are not faults:
 * no procedure, no code, nothing on ACTIVE FAULTS, nothing to acknowledge.
 * The press is authoritative: once the server accepts it, every effect of the
 * event is applied at once, the run log records it, and the room is told
 * through the City Alert every console and the wall already show.
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

/** What the alert says under the event's name: the player message without the name it starts with. */
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

// -- the mixin ----------------------------------------------------------------------

function cityEventDefs() { return DEFS.events; }

function cityEventDef(id) { return byId.get(String(id || '').trim().toUpperCase()) || null; }

/** The run's event bookkeeping, given its shape — a snapshot from before 2026-10-06 has none. */
function cityEventsState() {
  const st = this.state;
  if (!st.city_events || typeof st.city_events !== 'object') st.city_events = { used: {}, history: [] };
  if (!st.city_events.used || typeof st.city_events.used !== 'object') st.city_events.used = {};
  if (!Array.isArray(st.city_events.history)) st.city_events.history = [];
  return st.city_events;
}

/** The live effects a City Event created (all of them, or one event's). */
function cityEventEffects(eventId = null) {
  return (this.state.effects || []).filter((e) => e.source === 'city_event' && (!eventId || e.event_id === eventId));
}

/** Whether the card can be pressed now, and the word it shows if not. */
function cityEventStatus(def) {
  const ce = this.cityEventsState();
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

/**
 * ACTIVATE. Validates first — the event, the run, the repeat policy, every
 * effect's kind and target — and applies nothing until all of it has passed;
 * then applies every effect through the helper that already owns it, marks
 * the repeat policy, records the activation, and raises the City Alert.
 * A second press of the same card in the same round (or while its upkeep
 * modifier is pending) is refused here, so a double-click applies once.
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

  // THE ROOM: the City Alert every console overlays and then keeps as a banner,
  // the wall's strip and feed, the sting — the existing pathway, nothing new.
  this.setAlert({ title: def.name, subtitle: playerLine(def) });

  this.log.write('city_event_activated', {
    activation, round, event_id: def.id, event_name: def.name, event_type: def.type, by,
    effects_requested: def.effects.map((fx) => ({ ...fx })),
    effects_applied: applied,
    affected_sectors: [...affected],
    health,
    duration: def.duration, expiry: expiryWord(def), repeat_policy: def.repeat_policy,
  });
  this.touch();
  return { ok: true, activation, event_id: def.id, name: def.name, type: def.type, round, applied, health, affected: [...affected], alert: this.state.alert ? this.state.alert.id : null };
}

/**
 * Called by removeEffect for every effect a City Event created: an effect
 * that lasted the round has expired, an upkeep modifier has been consumed.
 */
function cityEventEffectEnded(e) {
  const ev = e.kind === 'upkeep_extra' ? 'city_event_upkeep_effect_consumed' : 'city_event_effect_expired';
  this.log.write(ev, {
    effect: e.id, activation: e.activation || null, event_id: e.event_id, event_name: e.event_name || null,
    kind: e.kind, target: e.target, delta: e.delta ?? null, add: e.add || null, round: this.state.round,
  });
}

/** The control frame's CITY EVENTS: every card with its state, the live effects grouped, the run's history. */
function cityEventsView() {
  const ce = this.cityEventsState();
  const live = this.cityEventEffects();
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
  const sectorCount = Object.keys(this.state.sectors).length;
  return {
    version: DEFS.version,
    events: DEFS.events.map((def) => {
      const st = this.cityEventStatus(def);
      return {
        id: def.id, name: def.name, type: def.type, description: def.description, player_message: def.player_message,
        duration: def.duration, repeat_policy: def.repeat_policy, effect_summary: effectSummary(def),
        status: st.state, button: st.button, used_round: ce.used[def.id] || null,
        live_effects: live.filter((e) => e.event_id === def.id).length,
      };
    }),
    active_effects: [...groups.values()].map((g) => ({ ...g, text: activeText(g, sectorCount) })),
    history: ce.history.slice(0, 20).map((h) => ({ ...h })),
  };
}

module.exports = {
  cityEventDefs, cityEventDef, cityEventsState, cityEventEffects, cityEventStatus, cityEventTargets,
  activateCityEvent, cityEventEffectEnded, cityEventsView,
};
