'use strict';

/**
 * ADMIN OVERRIDES (Admin Command Centre, v16).
 *
 * A routine scenario event — a fault, an injury, a brownout, an announcement —
 * is the facilitator running the game. An override is the facilitator's hand
 * on authoritative state: a health value, a tray, a worker count, a forced
 * approval or heal, a rerolled hand, a wiped run. The rules underneath do not
 * change; the wrapper only makes every such act deliberate and auditable:
 * it requires a reason, reads the target before and after, and writes one
 * `admin_override` event — actor, time, target, before, after, reason — on
 * top of whatever the reducer already logs.
 *
 * The server calls `validate`, takes a `snapshot`, dispatches the inner
 * intent through the ordinary control handler, takes a second `snapshot`,
 * and calls `record`. Nothing here mutates the game.
 */

const MAX_REASON = 140;

/** Every intent the wrapper will carry, and what its record is about. */
const ALLOWED = {
  set_integrity: 'sector', adjust_integrity: 'sector', adjust_inventory: 'sector',
  adjust_workforce: 'sector', recover_worker: 'sector', injure_worker: 'sector', set_status: 'sector',
  generate_output: 'sector',
  clear_fault: 'fault', accelerate_fault: 'fault', pause_fault: 'fault',
  set_core_output: 'core', set_core_integrity: 'core', adjust_core: 'core', set_stability: 'core',
  set_telemetry: 'core', set_intel: 'core', cycle: 'core',
  reset_stamps: 'capacity', reset_heals: 'capacity', expire_transfers: 'capacity',
  transfer_request: 'capacity', transfer_create: 'capacity',
  transfer_approve: 'transfer', transfer_stamp: 'transfer', transfer_decline: 'transfer',
  transfer_update: 'transfer', transfer_chit: 'transfer',
  request_fulfill: 'request', request_decline: 'request', request_cancel: 'request',
  heal_worker: 'healing', heal_decline: 'healing', heal_cancel: 'healing',
  agr_reroll: 'agr', agr_activate: 'agr', agr_card_enabled: 'agr',
  com_board_set: 'broadcast', com_announce: 'broadcast', com_announce_clear: 'broadcast',
  set_config: 'config', set_sector_config: 'config', set_fault_override: 'config',
  // v18: the tray by hand, the round timer by hand
  resource_override: 'sector',
  timer_adjust: 'clock', timer_set: 'clock', timer_reset: 'clock',
  // P0: the pressure regulator. Facilitator-only, reason required, one event.
  pressure_relief: 'pressure',
  reset_run: 'run',
};

const RESOURCE_KEYS = ['power', 'water', 'parts', 'med'];

function validate(msg = {}) {
  const action = String(msg.action || '');
  if (!ALLOWED[action]) return { ok: false, reason: 'unknown_action' };
  const reason = String(msg.reason || '').trim();
  if (!reason) return { ok: false, reason: 'reason_required' };
  if (reason.length > MAX_REASON) return { ok: false, reason: 'reason_too_long' };
  if (action === 'reset_run' && String(msg.confirm_text || '').trim().toUpperCase() !== 'RESET') {
    return { ok: false, reason: 'typed_confirmation_required' };
  }
  // v18: the payload is checked here, before anything is touched — whole
  // numbers of zero or more for stock, a whole number of seconds for time.
  const p = msg.payload || {};
  if (action === 'resource_override') {
    const vals = p.values;
    if (!vals || typeof vals !== 'object' || Array.isArray(vals) || !Object.keys(vals).length) return { ok: false, reason: 'values_required' };
    for (const [k, v] of Object.entries(vals)) {
      if (!RESOURCE_KEYS.includes(k)) return { ok: false, reason: 'unknown_resource', resource: k };
      if (typeof v !== 'number' || !Number.isInteger(v)) return { ok: false, reason: 'invalid_value', resource: k };
      if (v < 0) return { ok: false, reason: 'negative_value', resource: k };
    }
  }
  if (action === 'timer_set' && !(Number.isInteger(p.seconds) && p.seconds >= 0)) return { ok: false, reason: 'invalid_time' };
  if (action === 'timer_adjust' && !(Number.isInteger(p.delta_s) && p.delta_s !== 0)) return { ok: false, reason: 'invalid_delta' };
  return { ok: true, action, reason };
}

const code = (v) => String(v || '').toUpperCase();
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, JSON.parse(JSON.stringify(o[k]))]));

/** What the record names: POW, F-201 @ POW, CORE, T-0004, AGR, COM BOARD, CONFIG, RUN. */
function targetName(game, action, payload = {}) {
  switch (ALLOWED[action]) {
    case 'sector':    return code(payload.sector);
    case 'fault':     return `${code(payload.fault_code)} @ ${code(payload.sector)}`;
    case 'core':      return 'CORE';
    case 'capacity':  return 'CAPACITY';
    case 'transfer': case 'request': case 'healing': return String(payload.id || '');
    case 'agr':       return 'AGR';
    case 'broadcast': return 'COM BOARD';
    case 'config':    return action === 'set_sector_config' ? `CONFIG ${code(payload.sector)}` : action === 'set_fault_override' ? `CONFIG ${code(payload.fault_code)}` : 'CONFIG';
    case 'clock':     return 'MASTER TIME';
    case 'run':       return `RUN ${game.state.run_id}`;
    default:          return action.toUpperCase();
  }
}

/** The authoritative state the action is about, as it is right now. */
function snapshot(game, action, payload = {}) {
  const st = game.state;
  switch (ALLOWED[action]) {
    case 'sector': {
      const s = st.sectors[code(payload.sector)];
      if (!s) return null;
      return {
        sector: s.code, integrity: Math.round(s.integrity * 10) / 10, status: s.status, status_word: game.statusWord(s),
        inventory: { ...s.inventory }, workforce: { ...s.workforce },
      };
    }
    case 'fault': {
      const s = st.sectors[code(payload.sector)];
      const f = s && s.faults.find((x) => x.code === code(payload.fault_code) && !x.resolved);
      if (!f) return s ? { sector: s.code, fault: code(payload.fault_code), status: 'NOT ACTIVE' } : null;
      return { sector: s.code, fault: f.code, status: f.status, decay_per_min: f.decay_per_min, paused: !!f.paused, integrity: Math.round(s.integrity * 10) / 10 };
    }
    case 'core':
      return {
        core_output: Math.round(st.core_integrity), city_stability: Math.round(st.city_stability),
        stability_mode: (game.cfg.stability || {}).mode || 'auto', upkeep_passes: st.cycle.number,
        telemetry: { ...st.telemetry },
      };
    case 'capacity':
      return {
        trn_used: game.stampsUsed(), trn_capacity: game.trnCapacity(),
        med_used: game.medHealsUsed(), med_capacity: game.medCapacity(),
        pending_transfers: st.transfers.filter((t) => t.status === 'PENDING_TRN_APPROVAL').length,
        open_requests: st.requests.filter((r) => r.status === 'REQUESTED').length,
      };
    case 'transfer': {
      const t = game.findTransfer(payload.id);
      return t ? { ...pick(t, ['id', 'from', 'to', 'resource', 'amount', 'status', 'chit_confirmed', 'moved']) } : null;
    }
    case 'request': {
      const r = game.findRequest(payload.id);
      return r ? { ...pick(r, ['id', 'supplier', 'requester', 'resource', 'amount', 'status', 'transfer_id']) } : null;
    }
    case 'healing': {
      const h = game.findHealing(payload.id);
      return h ? { ...pick(h, ['id', 'sector', 'worker_id', 'status']) } : null;
    }
    case 'agr':
      return { ...pick(st.agr, ['round', 'offered', 'selected', 'used', 'reroll_count']), disabled: [...(game.cfg.agr_disabled_cards || [])] };
    case 'broadcast': {
      const b = st.broadcast || {};
      if (action === 'com_board_set') return { row: code(payload.row || payload.sector), values: { ...((b.rows || {})[code(payload.row || payload.sector)] || {}) } };
      return { announcement: b.announcement ? { ...b.announcement } : null };
    }
    case 'config': {
      if (action === 'set_sector_config') return JSON.parse(JSON.stringify(game.scenario.sectors[code(payload.sector)] || null));
      if (action === 'set_fault_override') return JSON.parse(JSON.stringify((game.cfg.fault_overrides || {})[code(payload.fault_code)] || null));
      return pick(game.cfg, Object.keys(payload.patch || {}));
    }
    case 'clock':
      return {
        remaining_s: Math.ceil(st.round_clock.remaining_s), remaining_ms: Math.round(st.round_clock.remaining_s * 1000),
        running: !!st.round_clock.running, started: !!st.round_clock.started, session_paused: !!st.paused,
        default_s: game.liveLength(), round: st.round, phase: st.phase,
      };
    case 'run':
      return { run_id: st.run_id, scenario_id: st.scenario_id, round: st.round, phase: st.phase };
    default:
      return null;
  }
}

/**
 * The audit record: one log event and one admin-only ticker line. The
 * reducer's own event has already been written by the time this runs.
 */
function record(log, game, { action, payload = {}, reason, actor = 'facilitator', before = null, after = null } = {}) {
  const target = targetName(game, action, payload);
  const entry = log.write('admin_override', {
    actor, action, target, reason: String(reason || '').trim().slice(0, MAX_REASON),
    payload: JSON.parse(JSON.stringify(payload)), before, after,
  });
  if (typeof game.ticker === 'function') {
    game.ticker('override', `OVERRIDE ${action.toUpperCase().replace(/_/g, ' ')} · ${target} — ${entry.reason}`, { scope: 'admin' });
  }
  return entry;
}

module.exports = { ALLOWED, MAX_REASON, validate, snapshot, targetName, record };
