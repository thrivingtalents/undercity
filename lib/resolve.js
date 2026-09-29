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
 * discrepancy), and it may be EMPTY (a false alarm with no procedure,
 * detected from the empty array, never from the code — the deck has
 * carried none since 2026-09-27, but the shape stays).
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
function materialsShort(sector, fault, required = fault.resources_required) {
  const short = {};
  for (const [k, v] of Object.entries(required || {})) {
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

  // FAULT REWARDS v2: what the table armed for this attempt — RESERVE CREW
  // counts one temporary worker toward the minimum, the EMERGENCY REPAIR KIT
  // takes one part off the recipe (never below zero). Both are spent the
  // moment the attempt begins, whatever the code turns out to be.
  const armed = rewards.armedFor(fault);
  const required = rewards.effectiveRequirements(fault);

  // 4. Crew. The requirement stays in the binder: a refusal says only that
  //    there were too few, or that the assignment itself was impossible.
  const workers = Number(workers_assigned || 0);
  const available = game.availableWorkers(sector);
  if (!Number.isInteger(workers) || workers < 0 || workers > available) {
    return reject('invalid_workers', { attempts: fault.attempts }, { workers, workforce_active: available });
  }
  if (workers + armed.crew_bonus < fault.crew_required) {
    return reject('insufficient_crew', { attempts: fault.attempts }, { workers, crew_bonus: armed.crew_bonus, crew_required: fault.crew_required, workforce_active: available });
  }

  // 5. Materials, against the REAL tray. Which and how many is the binder's to tell.
  if (checkMaterials) {
    const short = materialsShort(sector, fault, required);
    if (Object.keys(short).length) {
      return reject('insufficient_resources', { attempts: fault.attempts }, { short, required: { ...required } });
    }
  }
  // Crew and tray are in: the attempt has begun, and whatever was armed is spent.
  const spent = rewards.spendArmed(game, sectorCode, fault, { outcome: 'attempt' });

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
    fault.wrong_code_attempts = (fault.wrong_code_attempts || 0) + 1;

    const result = { attempts: fault.attempts, max_consecutive: cfg.lockout_after_consecutive_invalid, armed_spent: spent };
    let locked = false;
    if (fault.consecutive_invalid >= cfg.lockout_after_consecutive_invalid) {
      fault.locked_until_s = cfg.lockout_s;
      fault.consecutive_invalid = 0;
      fault.lockouts += 1;
      locked = true;
      result.locked_until_s = cfg.lockout_s;
      game.ticker('lockout', `${sectorCode} console locked (${faultCode})`, { scope: 'admin' });
    }
    // Remembered so SECOND CHANCE can forgive exactly this one. The code is still wrong.
    rewards.noteRejection(fault, { locked });
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
      const short = materialsShort(sector, fault, required);
      if (checkMaterials && Object.keys(short).length) {
        return reject('insufficient_resources', { attempts: fault.attempts }, { short, note: 'changed during commit' });
      }
      // All or nothing (v17.3): every binder material leaves together. With the
      // check switched off and the tray short, none does — the repair is then
      // a declaration, and the debrief hears about it.
      consumed = {};
      if (Object.keys(short).length) {
        game.log.write('materials_unverified', { sector: sectorCode, fault: faultCode, short, required: { ...required } });
      } else {
        for (const [k, v] of Object.entries(required)) {
          const take = Number(v) || 0;
          sector.inventory[k] = (Number(sector.inventory[k]) || 0) - take;
          consumed[k] = take;
        }
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
    rewards.endEffectsFor(game, fault.id);   // a stabilisation on this fault ends with it

    sector.integrity = Math.min(100, sector.integrity + cfg.resolve_recovery);
    game.refreshStatus(sector);

    // The instance's fixed reward, dealt when it fired — paid now, after the
    // materials are gone, and never twice.
    const reward = game.applyFaultReward(sectorCode, fault, { via: 'resolve', by: sectorCode });

    game.ticker('resolve', `${sectorCode} resolved ${faultCode}`);
    game.log.write('repair_completed', {
      instance: fault.id, fault: faultCode, sector: sectorCode, round: game.state.round, resolved_round: game.state.round,
      crew_assigned: workers, crew_bonus: armed.crew_bonus, materials_consumed: consumed, material_units: rewards.units(consumed),
      resolution_success: true, armed_spent: spent,
      reward_type: fault.reward ? fault.reward.type : null,
      reward_text: fault.reward ? fault.reward.text : null,
      reward_result: reward.applied ? reward.result_text : reward.reason,
    });
    game.log.write('submit', {
      sector: sectorCode, fault: faultCode, code, accepted: true, workers, attempts: fault.attempts, consumed,
      recovery: cfg.resolve_recovery,
      reward: reward.applied ? { type: reward.type, text: reward.result_text, key: reward.key }
        : { applied: false, reason: reward.reason || null },
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
