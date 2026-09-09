'use strict';
/**
 * Debrief analytics (spec §41–§43), computed from runlog.jsonl alone.
 *
 * Nothing here is stored twice: the log is the single record, every line
 * carries the round and phase it happened in (lib/log.js context), and this
 * module folds it into per-round figures on request. Round 3 and Aftershock
 * come out as separate buckets so the two can be laid side by side.
 *
 * No behavioural interpretation. Clean timestamps, counts and durations only.
 */

const secs = (a, b) => (a && b ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000) : null);
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

function parseLog(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line at process death */ }
  }
  return out;
}

/** Only the current run: everything after the last run_reset, if any. */
function currentRun(entries, runId = null) {
  let start = 0;
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].ev === 'run_reset' && (!runId || entries[i].run_id === runId)) start = i;
  }
  return entries.slice(start);
}

function emptyRound(id) {
  return {
    round: id,
    faults: { fired: 0, resolved: 0, expired: 0, cleared: 0, failed: 0, cross_sector: 0, resolution_rate: null,
      avg_first_action_s: null, avg_resolution_s: null, avg_attempts: null, resources_consumed: {}, list: [] },
    console: { submissions: 0, accepted: 0, rejected: 0, invalid_code: 0, lockouts: 0 },
    transfers: { requested: 0, stamped: 0, delivered: 0, cancelled: 0, refused_capacity: 0,
      avg_request_to_stamp_s: null, avg_request_to_delivery_s: null, list: [] },
    council: { called: 0, orders: 0, no_order: 0, avg_time_used_s: null, list: [] },
    sectors: { critical_entries: 0, dark_entries: 0, brownouts: 0, injuries: 0, recoveries: 0, missed_upkeep: 0 },
    cycles: 0,
    events: 0,
    observations: 0,
    timeline: [],
  };
}

/**
 * Fold a run's entries into per-round stats plus a run-wide summary.
 * @returns {{ rounds: object, overall: object, comparison: object, timeline: array }}
 */
function analyse(text, { runId = null } = {}) {
  const entries = currentRun(parseLog(text), runId);
  const rounds = {};
  const byRound = (id) => (rounds[id] = rounds[id] || emptyRound(id));

  // Open faults keyed by sector+code, so a re-fired code starts a new record.
  const openFaults = new Map();
  const transfers = new Map();
  const fkey = (e) => `${e.sector}:${e.fault}`;

  for (const e of entries) {
    const r = e.round || 'R?';
    const R = byRound(r);

    switch (e.ev) {
      case 'fault_fired': {
        R.faults.fired += 1;
        if (e.cross_sector) R.faults.cross_sector += 1;
        const rec = {
          sector: e.sector, code: e.fault, severity: e.severity ?? null, round: r,
          fired_at: e.t, first_action_at: null, resolved_at: null, outcome: 'OPEN',
          attempts: 0, invalid: 0, lockouts: 0, cross_sector: !!e.cross_sector,
          deadline_s: e.deadline_s ?? null, expired: false, consumed: null,
          time_to_first_action_s: null, time_to_resolution_s: null,
        };
        openFaults.set(fkey(e), rec);
        R.faults.list.push(rec);
        R.timeline.push({ t: e.t, kind: 'fault', text: `${e.fault} fired — ${e.sector}` });
        break;
      }
      case 'fault_opened': {
        const rec = openFaults.get(fkey(e));
        if (rec && !rec.first_action_at) rec.first_action_at = e.t;
        break;
      }
      case 'submit': {
        R.console.submissions += 1;
        const rec = openFaults.get(fkey(e));
        if (rec) {
          if (!rec.first_action_at) rec.first_action_at = e.t;
          rec.attempts += 1;
        }
        if (e.accepted) {
          R.console.accepted += 1;
          if (rec) {
            rec.resolved_at = e.t;
            rec.outcome = 'RESOLVED';
            rec.consumed = e.consumed || null;
            openFaults.delete(fkey(e));
            R.faults.resolved += 1;
            for (const [k, v] of Object.entries(e.consumed || {})) {
              R.faults.resources_consumed[k] = (R.faults.resources_consumed[k] || 0) + v;
            }
          }
          R.timeline.push({ t: e.t, kind: 'resolve', text: `${e.fault} resolved — ${e.sector}` });
        } else {
          R.console.rejected += 1;
          if (e.reason === 'invalid_code') {
            R.console.invalid_code += 1;
            if (rec) rec.invalid += 1;
          }
          if (e.locked_until_s) { R.console.lockouts += 1; if (rec) rec.lockouts += 1; }
        }
        break;
      }
      case 'deadline_expired': {
        R.faults.expired += 1;
        const rec = openFaults.get(fkey(e));
        if (rec) rec.expired = true;
        R.timeline.push({ t: e.t, kind: 'expired', text: `${e.fault} deadline passed — ${e.sector}` });
        break;
      }
      case 'fault_failed': {
        R.faults.failed += 1;
        const rec = openFaults.get(fkey(e));
        if (rec) { rec.outcome = 'FAILED'; rec.resolved_at = e.t; openFaults.delete(fkey(e)); }
        break;
      }
      case 'fault_cleared': {
        R.faults.cleared += 1;
        const rec = openFaults.get(fkey(e));
        if (rec) { rec.outcome = 'CLEARED'; rec.resolved_at = e.t; openFaults.delete(fkey(e)); }
        R.timeline.push({ t: e.t, kind: 'clear', text: `${e.fault} cleared — ${e.sector}` });
        break;
      }
      case 'transfer_requested': {
        R.transfers.requested += 1;
        const rec = { id: e.id, from: e.from, to: e.to, resource: e.resource, amount: e.amount, round: r,
          requested_at: e.t, stamped_at: null, delivered_at: null, status: 'REQUESTED',
          request_to_stamp_s: null, request_to_delivery_s: null };
        transfers.set(e.id, rec);
        R.transfers.list.push(rec);
        R.timeline.push({ t: e.t, kind: 'transfer', text: `Transfer requested ${e.from} → ${e.to} (${e.amount} ${e.resource})` });
        break;
      }
      case 'transfer_stamped': {
        R.transfers.stamped += 1;
        const rec = transfers.get(e.id);
        if (rec) { rec.stamped_at = e.t; rec.status = e.delivered ? 'DELIVERED' : 'STAMPED'; if (e.delivered) { rec.delivered_at = e.t; R.transfers.delivered += 1; } }
        R.timeline.push({ t: e.t, kind: 'transfer', text: `TRN stamped ${e.from} → ${e.to}` });
        break;
      }
      case 'transfer_delivered': {
        R.transfers.delivered += 1;
        const rec = transfers.get(e.id);
        if (rec) { rec.delivered_at = e.t; rec.status = 'DELIVERED'; }
        break;
      }
      case 'transfer_cancelled': {
        R.transfers.cancelled += 1;
        const rec = transfers.get(e.id);
        if (rec) rec.status = 'CANCELLED';
        break;
      }
      case 'transfer_refused':
        if (e.reason === 'capacity') R.transfers.refused_capacity += 1;
        break;
      case 'council_called':
        R.council.called += 1;
        R.timeline.push({ t: e.t, kind: 'council', text: 'Council summoned' });
        break;
      case 'council_ended':
        R.council.list.push({ t: e.t, time_used_s: e.time_used_s ?? null, order_submitted: !!e.order_submitted });
        break;
      case 'continuity_order':
        R.council.orders += 1;
        R.council.list.push({ t: e.t, order: e.order, brownout: e.brownout, time_used_s: e.time_used_s ?? null, order_submitted: true });
        R.timeline.push({ t: e.t, kind: 'order', text: `Continuity Order: ${(e.order || []).join(' › ')}` });
        break;
      case 'council_no_order':
        R.council.no_order += 1;
        R.timeline.push({ t: e.t, kind: 'council', text: 'No Continuity Order received' });
        break;
      case 'status':
        if (e.status === 'CRITICAL') { R.sectors.critical_entries += 1; R.timeline.push({ t: e.t, kind: 'status', text: `${e.sector} CRITICAL` }); }
        if (e.status === 'DARK') { R.sectors.dark_entries += 1; R.timeline.push({ t: e.t, kind: 'status', text: `${e.sector} DARK` }); }
        break;
      case 'set_status':
        if (e.status === 'BROWNOUT') { R.sectors.brownouts += 1; R.timeline.push({ t: e.t, kind: 'status', text: `${e.sector} BROWNOUT (${e.by || 'facilitator'})` }); }
        break;
      case 'injury': R.sectors.injuries += e.count || 0; break;
      case 'worker_recovered': R.sectors.recoveries += e.count || 1; break;
      case 'upkeep_missed': R.sectors.missed_upkeep += 1; break;
      case 'cycle_processed': R.cycles += 1; R.timeline.push({ t: e.t, kind: 'cycle', text: `Core cycle ${e.cycle} processed` }); break;
      case 'event_fired': R.events += 1; R.timeline.push({ t: e.t, kind: 'event', text: e.name || e.event }); break;
      case 'observe': R.observations += 1; R.timeline.push({ t: e.t, kind: 'obs', text: `${e.tag || 'NOTE'}${e.sector ? ' · ' + e.sector : ''}: ${e.note || ''}` }); break;
      case 'phase': R.timeline.push({ t: e.t, kind: 'phase', text: `Phase ${e.phase}` }); break;
      default: break;
    }
  }

  // Derived figures per round.
  for (const R of Object.values(rounds)) {
    const f = R.faults;
    for (const rec of f.list) {
      rec.time_to_first_action_s = secs(rec.fired_at, rec.first_action_at);
      rec.time_to_resolution_s = rec.outcome === 'RESOLVED' ? secs(rec.fired_at, rec.resolved_at) : null;
    }
    const closed = f.fired - f.list.filter((x) => x.outcome === 'OPEN').length;
    f.resolution_rate = f.fired ? Math.round((f.resolved / f.fired) * 100) : null;
    f.closed = closed;
    f.avg_first_action_s = round1(avg(f.list.map((x) => x.time_to_first_action_s).filter((x) => x != null)));
    f.avg_resolution_s = round1(avg(f.list.map((x) => x.time_to_resolution_s).filter((x) => x != null)));
    f.avg_attempts = round1(avg(f.list.filter((x) => x.attempts > 0).map((x) => x.attempts)));

    const t = R.transfers;
    for (const rec of t.list) {
      rec.request_to_stamp_s = secs(rec.requested_at, rec.stamped_at);
      rec.request_to_delivery_s = secs(rec.requested_at, rec.delivered_at);
    }
    t.avg_request_to_stamp_s = round1(avg(t.list.map((x) => x.request_to_stamp_s).filter((x) => x != null)));
    t.avg_request_to_delivery_s = round1(avg(t.list.map((x) => x.request_to_delivery_s).filter((x) => x != null)));

    const c = R.council;
    c.avg_time_used_s = round1(avg(c.list.map((x) => x.time_used_s).filter((x) => x != null)));

    R.timeline.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  }

  const overall = sumRounds(Object.values(rounds));
  return {
    generated_at: new Date().toISOString(),
    entries: entries.length,
    rounds,
    overall,
    comparison: compare(rounds.R3, rounds.R4),
    timeline: Object.values(rounds).flatMap((R) => R.timeline).sort((a, b) => Date.parse(a.t) - Date.parse(b.t)),
  };
}

function sumRounds(list) {
  const o = emptyRound('ALL');
  const firstActions = [];
  const resolutions = [];
  const stamps = [];
  for (const R of list) {
    for (const k of Object.keys(o.faults)) if (typeof o.faults[k] === 'number') o.faults[k] += R.faults[k];
    for (const k of Object.keys(o.console)) o.console[k] += R.console[k];
    for (const k of Object.keys(o.transfers)) if (typeof o.transfers[k] === 'number') o.transfers[k] += R.transfers[k];
    for (const k of Object.keys(o.council)) if (typeof o.council[k] === 'number') o.council[k] += R.council[k];
    for (const k of Object.keys(o.sectors)) o.sectors[k] += R.sectors[k];
    o.cycles += R.cycles; o.events += R.events; o.observations += R.observations;
    firstActions.push(...R.faults.list.map((x) => x.time_to_first_action_s).filter((x) => x != null));
    resolutions.push(...R.faults.list.map((x) => x.time_to_resolution_s).filter((x) => x != null));
    stamps.push(...R.transfers.list.map((x) => x.request_to_stamp_s).filter((x) => x != null));
  }
  o.faults.resolution_rate = o.faults.fired ? Math.round((o.faults.resolved / o.faults.fired) * 100) : null;
  o.faults.avg_first_action_s = round1(avg(firstActions));
  o.faults.avg_resolution_s = round1(avg(resolutions));
  o.transfers.avg_request_to_stamp_s = round1(avg(stamps));
  delete o.faults.list; delete o.transfers.list; delete o.council.list; delete o.timeline;
  return o;
}

/**
 * ROUND 3 vs AFTERSHOCK, side by side. Neutral: numbers only, no verdict,
 * no winner (spec §43).
 */
function compare(r3, r4) {
  const pick = (R) => (R ? {
    faults_fired: R.faults.fired,
    resolution_rate: R.faults.resolution_rate,
    avg_first_action_s: R.faults.avg_first_action_s,
    avg_resolution_s: R.faults.avg_resolution_s,
    failed_console_entries: R.console.invalid_code,
    lockouts: R.console.lockouts,
    transfers: R.transfers.requested,
    avg_transfer_s: R.transfers.avg_request_to_stamp_s,
    critical_entries: R.sectors.critical_entries,
    council_time_used_s: R.council.avg_time_used_s,
    orders_submitted: R.council.orders,
  } : null);
  return {
    rows: [
      { key: 'resolution_rate', label: 'Fault resolution', unit: '%' },
      { key: 'avg_first_action_s', label: 'Avg time to first action', unit: 's' },
      { key: 'avg_resolution_s', label: 'Avg response', unit: 's' },
      { key: 'failed_console_entries', label: 'Failed console entries', unit: '' },
      { key: 'lockouts', label: 'Console lockouts', unit: '' },
      { key: 'transfers', label: 'Transfers', unit: '' },
      { key: 'avg_transfer_s', label: 'Avg transfer time', unit: 's' },
      { key: 'critical_entries', label: 'Critical entries', unit: '' },
      { key: 'council_time_used_s', label: 'Council decision', unit: 's' },
    ],
    R3: pick(r3),
    R4: pick(r4),
  };
}

module.exports = { analyse, parseLog, compare };
