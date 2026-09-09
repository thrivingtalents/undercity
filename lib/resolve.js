'use strict';
/**
 * submit_code resolution — contract §3, in exactly that order.
 *
 * Two structural properties drive this module and must never be special-cased
 * away (contract §0.4):
 *   · valid_codes is an ARRAY. F-201 carries two codes (the seeded 340/290
 *     discrepancy) and the game must not punish either answer.
 *   · valid_codes may be EMPTY. F-210 is a false alarm with no procedure at
 *     all. That is detected from the empty array, never from the fault code,
 *     so a future false alarm needs no code change.
 *
 * Resource deduction is configuration, not engine: with
 * `deduct_resources_on_resolve` (and `auto_economy`) on, the procedure's cost
 * leaves the digital stock on success; off, the paper chits stay the only
 * ledger (the original contract §3.5 stance). `resolve_requires_resources`
 * decides whether a team short of stock is refused or merely goes negative
 * to zero — off by default, so the argument stays in the room.
 */

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

function submitCode(game, { sector: sectorCode, fault_code: faultCode, code, workers_assigned }) {
  const cfg = game.cfg;
  const sector = game.state.sectors[sectorCode];
  const now = () => new Date().toISOString();

  const reject = (reason, extra = {}) => {
    game.log.write('submit', {
      sector: sectorCode,
      fault: faultCode,
      code: code ?? null,
      accepted: false,
      reason,
      ...extra,
    });
    game.touch();
    return { type: 'submit_result', fault_code: faultCode, accepted: false, reason, ...extra };
  };

  // 1. Fault exists, belongs to this sector, is unresolved.
  if (!sector) return reject('unknown_fault');
  const fault = sector.faults.find((f) => f.code === faultCode && !f.resolved);
  if (!fault) return reject('unknown_fault');

  // Any submission counts as the team's first action on the card.
  if (!fault.first_action_at) fault.first_action_at = now();

  // A DARK sector's dashboard is locked (spec §3.1).
  if (sector.status === 'DARK') return reject('sector_dark', { attempts: fault.attempts });

  // 2. Lockout.
  if (fault.locked_until_s > 0) {
    return reject('locked', {
      attempts: fault.attempts,
      locked_until_s: Math.ceil(fault.locked_until_s),
    });
  }

  // 3. Crew. Must meet the requirement and not exceed who is actually standing.
  const workers = Number(workers_assigned || 0);
  const available = game.availableWorkers(sector);
  if (workers < fault.crew_required || workers > available) {
    return reject('insufficient_crew', {
      attempts: fault.attempts,
      crew_required: fault.crew_required,
      workforce_active: available,
    });
  }

  // 3b. Resources — only when the scenario says a short team is refused.
  if (cfg.auto_economy && cfg.resolve_requires_resources) {
    const short = {};
    for (const [k, v] of Object.entries(fault.resources_required || {})) {
      if ((sector.inventory[k] || 0) < v) short[k] = v - (sector.inventory[k] || 0);
    }
    if (Object.keys(short).length) {
      return reject('insufficient_resources', { attempts: fault.attempts, short });
    }
  }

  // 4. Code. An empty valid_codes array means no procedure exists at all —
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

  // 5. Success: stop decay, apply recovery, settle resources, credit publicly.
  fault.attempts += 1;
  fault.consecutive_invalid = 0;
  fault.resolved = true;
  fault.status = 'RESOLVED';
  fault.resolved_at = now();
  fault.resolved_by_code = submitted;
  fault.workers_used = workers;

  let consumed = null;
  if (cfg.auto_economy && cfg.deduct_resources_on_resolve) {
    consumed = {};
    for (const [k, v] of Object.entries(fault.resources_required || {})) {
      const take = Math.min(v, sector.inventory[k] || 0);
      sector.inventory[k] = (sector.inventory[k] || 0) - take;
      consumed[k] = take;
    }
    fault.resources_consumed = consumed;
  }

  sector.integrity = Math.min(100, sector.integrity + cfg.resolve_recovery);
  game.refreshStatus(sector);

  game.ticker('resolve', `${sectorCode} resolved ${faultCode}`);
  game.log.write('submit', {
    sector: sectorCode,
    fault: faultCode,
    code,
    accepted: true,
    workers,
    attempts: fault.attempts,
    consumed,
    recovery: cfg.resolve_recovery,
  });
  game.sting('resolved');
  game.touch();

  return {
    type: 'submit_result',
    fault_code: faultCode,
    accepted: true,
    reason: null,
    attempts: fault.attempts,
    recovery: cfg.resolve_recovery,
    consumed,
  };
}

module.exports = { submitCode, normaliseCode };
