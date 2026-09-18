'use strict';
/**
 * submit_code resolution — contract §3, in the v17 order (2026-09-18):
 *
 *   1 the fault is active and belongs to this sector
 *   2 the sector is not DARK
 *   3 the console is not locked
 *   4 the crew is a valid number and meets the binder's minimum
 *   5 every binder material is in the sector's REAL tray
 *   6 the code is right (a ghost has no code at all)
 *   7 one atomic commit: re-check crew and materials, deduct ALL materials,
 *     mark resolved exactly once, stop decay, pay the reward — in that order,
 *     so a reward can never fund the repair that earned it
 *
 * A refusal at any step consumes nothing and pays nothing. Only a wrong
 * code counts as an attempt (and towards the console lock); short crew or
 * short materials are not guesses. A refusal never names the numbers — the
 * binder does; the log gets them for the debrief.
 *
 * Two structural properties must never be special-cased away (contract
 * §0.4): valid_codes is an ARRAY (F-201 carries two: the seeded 340/290
 * discrepancy), and it may be EMPTY (F-210 is a false alarm with no
 * procedure, detected from the empty array, never from the code).
 *
 * With `auto_economy` off the trays are paper and the server cannot see
 * them: materials are then declared, not checked. `resolve_requires_resources`
 * (on in every built-in scenario) is the digital switch for the check;
 * `deduct_resources_on_resolve` for the deduction. Both default on.
 */

const rewards = require('./rewards');

/** Trim, uppercase, and normalise any dash-ish separator to a single hyphen. */
function normaliseCode(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .toUpperCase()
    .replace(/[‐-―−_]/g, '-')  // en/em dashes, minus, underscore
    .replace(/\s*-\s*/g, '-')                  // spaces hugging a hyphen
    .replace(/-{2,}/g, '-')                    // collapse runs
    .replace(/\s+/g, '');                      // any remaining whitespace
}

/** What the binder asks for that the tray does not hold. Empty when ready. */
function materialsShort(sector, fault) {
  const short = {};
  for (const [k, v] of Object.entries(fault.resources_required || {})) {
    const have = Number(sector.inventory[k]) || 0;
    if (have < v) short[k] = v - have;
  }
  return short;
}

function submitCode(game, { sector: sectorCode, fault_code: faultCode, code, workers_assigned }) {
  const cfg = game.cfg;
  const sector = game.state.sectors[sectorCode];
  const now = () => new Date().toISOString();
  const digital = !!cfg.auto_economy;
  const checkMaterials = digital && cfg.resolve_requires_resources !== false;
  const deduct = digital && cfg.deduct_resources_on_resolve !== false;

  // `extra` travels back to the table; `logOnly` goes to the debrief and
  // nowhere else — the numbers a refusal must never reveal.
  const reject = (reason, extra = {}, logOnly = {}) => {
    game.log.write('submit', {
      sector: sectorCode, fault: faultCode, code: code ?? null, accepted: false, reason, ...extra, ...logOnly,
    });
    game.touch();
    return { type: 'submit_result', fault_code: faultCode, accepted: false, reason, ...extra };
  };

  // 1. Fault exists, belongs to this sector, is unresolved — and nobody is mid-commit on it.
  if (!sector) return reject('unknown_fault');
  const fault = sector.faults.find((f) => f.code === faultCode && !f.resolved);
  if (!fault) return reject('unknown_fault');
  if (fault.resolving) return reject('unknown_fault', {}, { note: 'commit in progress' });

  // Any submission counts as the team's first action on the card.
  if (!fault.first_action_at) fault.first_action_at = now();

  // 2. A DARK sector's dashboard is locked (spec §3.1).
  if (sector.status === 'DARK') return reject('sector_dark', { attempts: fault.attempts });

  // 3. Lockout.
  if (fault.locked_until_s > 0) {
    return reject('locked', { attempts: fault.attempts, locked_until_s: Math.ceil(fault.locked_until_s) });
  }

  // 4. Crew. The requirement stays in the binder: a refusal says only that
  //    there were too few, or that the assignment itself was impossible.
  const workers = Number(workers_assigned || 0);
  const available = game.availableWorkers(sector);
  if (!Number.isInteger(workers) || workers < 0 || workers > available) {
    return reject('invalid_workers', { attempts: fault.attempts }, { workers, workforce_active: available });
  }
  if (workers < fault.crew_required) {
    return reject('insufficient_crew', { attempts: fault.attempts }, { workers, crew_required: fault.crew_required, workforce_active: available });
  }

  // 5. Materials, against the REAL tray. Which and how many is the binder's to tell.
  if (checkMaterials) {
    const short = materialsShort(sector, fault);
    if (Object.keys(short).length) {
      return reject('insufficient_resources', { attempts: fault.attempts }, { short, required: { ...fault.resources_required } });
    }
  }

  // 6. Code. An empty valid_codes array means no procedure exists at all —
  //    the fault is a ghost and only the facilitator can clear it.
  if (fault.valid_codes.length === 0) {
    fault.attempts += 1;
    return reject('no_procedure', { attempts: fault.attempts });
  }

  const submitted = normaliseCode(code);
  const accepted = fault.valid_codes.some((valid) => normaliseCode(valid) === submitted);

  if (!accepted) {
    fault.attempts += 1;
    fault.consecutive_invalid += 1;

    const result = { attempts: fault.attempts, max_consecutive: cfg.lockout_after_consecutive_invalid };
    if (fault.consecutive_invalid >= cfg.lockout_after_consecutive_invalid) {
      fault.locked_until_s = cfg.lockout_s;
      fault.consecutive_invalid = 0;
      fault.lockouts += 1;
      result.locked_until_s = cfg.lockout_s;
      game.ticker('lockout', `${sectorCode} console locked (${faultCode})`, { scope: 'admin' });
    }
    return reject('invalid_code', result);
  }

  // 7. The commit. Crew and materials are read again inside it — the tray
  //    may have moved since step 5 — then every material leaves at once, or
  //    none does.
  fault.resolving = true;
  try {
    if (workers > game.availableWorkers(sector)) {
      return reject('invalid_workers', { attempts: fault.attempts }, { workers, workforce_active: game.availableWorkers(sector), note: 'changed during commit' });
    }
    let consumed = null;
    if (deduct) {
      const short = materialsShort(sector, fault);
      if (checkMaterials && Object.keys(short).length) {
        return reject('insufficient_resources', { attempts: fault.attempts }, { short, note: 'changed during commit' });
      }
      consumed = {};
      const plan = Object.entries(fault.resources_required || {}).map(([k, v]) => [k, Math.min(Number(v) || 0, Number(sector.inventory[k]) || 0)]);
      for (const [k, take] of plan) {
        sector.inventory[k] = (Number(sector.inventory[k]) || 0) - take;
        consumed[k] = take;
      }
      fault.resources_consumed = consumed;
      game.state.repair_material_units_consumed = Number(game.state.repair_material_units_consumed || 0) + rewards.units(consumed);
    }

    fault.attempts += 1;
    fault.consecutive_invalid = 0;
    fault.resolved = true;               // exactly once: the guard above refuses a second commit
    fault.status = 'RESOLVED';
    fault.resolved_at = now();
    fault.resolved_by_code = submitted;
    fault.workers_used = workers;       // crew is a count here; nothing is held after the repair

    sector.integrity = Math.min(100, sector.integrity + cfg.resolve_recovery);
    game.refreshStatus(sector);

    // The instance's own reward, dealt when it fired — paid now, after the
    // materials are gone, and never twice. A choosing reward may wait for the
    // table's pick; that is still "after".
    const reward = game.applyFaultReward(sectorCode, fault, { via: 'resolve', by: sectorCode, consumed });

    game.ticker('resolve', `${sectorCode} resolved ${faultCode}`);
    game.log.write('repair_completed', {
      instance: fault.id, fault: faultCode, sector: sectorCode, round: game.state.round,
      crew_assigned: workers, materials_consumed: consumed, material_units: rewards.units(consumed),
      resolution_success: true,
      reward_archetype: fault.reward ? fault.reward.archetype : null,
      reward_result: reward.applied ? reward.result_text : (reward.pending ? 'PENDING CHOICE' : reward.reason),
      reward_targets: reward.targets || [], resource_reward_units_generated: reward.resource_units_generated || 0,
    });
    game.log.write('submit', {
      sector: sectorCode, fault: faultCode, code, accepted: true, workers, attempts: fault.attempts, consumed,
      recovery: cfg.resolve_recovery,
      reward: reward.applied ? { archetype: reward.archetype, resources: reward.resources, health: reward.health, key: reward.key }
        : { applied: false, pending: !!reward.pending, reason: reward.reason || null },
    });
    game.sting('resolved');
    game.touch();

    return {
      type: 'submit_result', fault_code: faultCode, accepted: true, reason: null,
      attempts: fault.attempts, recovery: cfg.resolve_recovery, consumed, reward,
    };
  } finally {
    delete fault.resolving;
  }
}

module.exports = { submitCode, normaliseCode, materialsShort };
