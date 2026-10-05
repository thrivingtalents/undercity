'use strict';
/**
 * Debrief analytics (spec §41–§43), computed from runlog.jsonl alone.
 *
 * Nothing here is stored twice: the log is the single record, every line
 * carries the round and phase it happened in (lib/log.js context), and this
 * module folds it into per-round figures on request. Round 3 and Round 7
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
    // Asking is one thing, moving is another, healing is a third.
    requests: { created: 0, fulfilled: 0, declined: 0, cancelled: 0, expired: 0,
      fulfil_refused_stock: 0, avg_request_to_fulfil_s: null, list: [] },
    transfers: { requested: 0, created: 0, accepted: 0, approved: 0, declined: 0, stamped: 0,
      delivered: 0, cancelled: 0, expired: 0,
      refused_capacity: 0, refused_not_accepted: 0, refused_chit: 0, refused_stock: 0,
      refused_not_trn: 0, accept_refused_stock: 0, facilitator_overrides: 0,
      avg_request_to_accept_s: null, avg_request_to_stamp_s: null, avg_request_to_delivery_s: null, list: [] },
    healing: { requested: 0, healed: 0, declined: 0, cancelled: 0, expired: 0, refused: 0,
      refused_capacity: 0, facilitator_overrides: 0, avg_request_to_heal_s: null, list: [] },
    council: { called: 0, orders: 0, no_order: 0, nominations: 0, avg_time_used_s: null, list: [] },
    // COM's public board and AGR's interventions.
    broadcast: { row_updates: 0, announcements: 0, cleared: 0, overrides: 0, list: [] },
    agr: { offers: 0, activations: 0, refused: 0, rerolls: 0, overrides: 0, cards: {}, list: [] },
    // What finishing faults paid out, and what was refused.
    rewards: { assigned: 0, awarded: 0, duplicates_blocked: 0, force_skipped: 0, overrides: 0, integrity_points: 0, tokens_used: 0, tokens_granted_by_facilitator: 0, tokens_revoked: 0, resources: {}, by_type: {}, tokens_granted: {}, list: [] },
    repairs: { count: 0, material_units: 0, materials: {} },
    sectors: { critical_entries: 0, dark_entries: 0, brownouts: 0, injuries: 0, recoveries: 0, missed_upkeep: 0 },
    cycles: 0,
    events: 0,
    city_events: 0,
    // FALSE TELEMETRY (2026-10-06): every phantom alert, with the whole arc the debrief wants.
    false_alerts: { fired: 0, corrected: 0, cancelled: 0, force_cleared: 0, list: [] },
    observations: 0,
    overrides: 0,
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
  const falseAlerts = new Map();   // id -> the false-alert record being built
  const requests = new Map();
  const transfers = new Map();
  const healing = new Map();
  const fkey = (e) => `${e.sector}:${e.fault}`;

  for (const e of entries) {
    // Continuous gameflow: a few events carry a PERIOD stamp of their own (the
    // operating cycle, C1, C2 …) in `round` — COM's board, AGR's hand. The fold
    // is by the backend round the event happened in, which the log context
    // carries as `context_round`, so a cycle stamp never opens a phantom round.
    const r = (/^C\d+$/.test(String(e.round || '')) ? e.context_round : e.round) || e.round || 'R?';
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
          requested_at: e.t, accepted_at: null, declined_at: null, expired_at: null,
          stamped_at: null, delivered_at: null, status: 'REQUESTED', override: false,
          request_to_accept_s: null, request_to_stamp_s: null, request_to_delivery_s: null };
        transfers.set(e.id, rec);
        R.transfers.list.push(rec);
        R.timeline.push({ t: e.t, kind: 'transfer', text: `Transfer requested ${e.from} → ${e.to} (${e.amount} ${e.resource})` });
        break;
      }
      // -- the v3 chain: ask, fulfil, approve, heal ----------------------------
      case 'request_created': {
        R.requests.created += 1;
        const rec = { id: e.id, supplier: e.supplier, requester: e.requester, resource: e.resource,
          amount: e.amount, round: r, requested_at: e.t, fulfilled_at: null, declined_at: null,
          status: 'REQUESTED', transfer_id: null, request_to_fulfil_s: null };
        requests.set(e.id, rec);
        R.requests.list.push(rec);
        R.timeline.push({ t: e.t, kind: 'transfer', text: `${e.requester} asked ${e.supplier} for ${e.amount} ${e.resource}` });
        // a request raised while a phantom alert sat on the requester: the unnecessary mobilisation the debrief looks for
        for (const fa of falseAlerts.values()) if (fa.target_sector === e.requester && !fa.ended_at) fa.related_requests += 1;
        break;
      }
      case 'request_fulfilled': {
        R.requests.fulfilled += 1;
        const rec = requests.get(e.id);
        if (rec) { rec.fulfilled_at = e.t; rec.status = 'TRANSFER_CREATED'; rec.transfer_id = e.transfer_id; }
        R.timeline.push({ t: e.t, kind: 'transfer', text: `${e.supplier} fulfilled ${e.requester} — awaiting TRN` });
        break;
      }
      case 'request_declined': {
        R.requests.declined += 1;
        const rec = requests.get(e.id);
        if (rec) { rec.declined_at = e.t; rec.status = 'DECLINED_BY_SUPPLIER'; }
        R.timeline.push({ t: e.t, kind: 'transfer', text: `${e.supplier} declined ${e.requester}` });
        break;
      }
      case 'request_cancelled': {
        R.requests.cancelled += 1;
        const rec = requests.get(e.id);
        if (rec) rec.status = 'CANCELLED';
        break;
      }
      case 'request_expired': {
        R.requests.expired += 1;
        const rec = requests.get(e.id);
        if (rec) rec.status = 'EXPIRED';
        break;
      }
      case 'request_fulfil_refused':
        if (e.reason === 'insufficient_stock') R.requests.fulfil_refused_stock += 1;
        break;
      case 'transfer_created': {
        R.transfers.created += 1;
        const rec = { id: e.id, from: e.from, to: e.to, resource: e.resource, amount: e.amount, round: r,
          requested_at: e.t, accepted_at: null, declined_at: null, expired_at: null,
          stamped_at: null, delivered_at: null, status: 'PENDING_TRN_APPROVAL', override: false,
          request_id: e.request_id || null,
          request_to_accept_s: null, request_to_stamp_s: null, request_to_delivery_s: null };
        transfers.set(e.id, rec);
        R.transfers.list.push(rec);
        break;
      }
      case 'transfer_approved': {
        R.transfers.approved += 1;
        R.transfers.stamped += 1;
        if (e.facilitator_override) R.transfers.facilitator_overrides += 1;
        const rec = transfers.get(e.id);
        if (rec) {
          rec.stamped_at = e.t;
          rec.status = e.delivered ? 'DELIVERED' : 'APPROVED';
          if (e.facilitator_override) rec.override = true;
          if (e.delivered) { rec.delivered_at = e.t; R.transfers.delivered += 1; }
        }
        R.timeline.push({
          t: e.t, kind: 'transfer',
          text: `TRN approved ${e.from} → ${e.to}${e.facilitator_override ? ' (facilitator override)' : ''}`,
        });
        break;
      }
      case 'transfer_declined': {
        R.transfers.declined += 1;
        const rec = transfers.get(e.id);
        if (rec) { rec.declined_at = e.t; rec.status = 'DECLINED_BY_TRN'; }
        R.timeline.push({ t: e.t, kind: 'transfer', text: `TRN declined ${e.from} → ${e.to}` });
        break;
      }
      case 'transfer_expired': {
        R.transfers.expired += 1;
        const rec = transfers.get(e.id);
        if (rec) { rec.expired_at = e.t; rec.status = 'EXPIRED'; }
        break;
      }
      case 'heal_requested': {
        R.healing.requested += 1;
        const rec = { id: e.id, sector: e.sector, worker_id: e.worker_id, worker_label: e.worker_label,
          round: r, requested_at: e.t, healed_at: null, declined_at: null, status: 'WAITING_FOR_MED',
          override: false, request_to_heal_s: null };
        healing.set(e.id, rec);
        R.healing.list.push(rec);
        R.timeline.push({ t: e.t, kind: 'injury', text: `${e.sector} asked MED to heal ${e.worker_label}` });
        break;
      }
      case 'worker_healed': {
        R.healing.healed += 1;
        if (e.facilitator_override) R.healing.facilitator_overrides += 1;
        const rec = healing.get(e.id);
        if (rec) { rec.healed_at = e.t; rec.status = 'HEALED'; if (e.facilitator_override) rec.override = true; }
        R.timeline.push({
          t: e.t, kind: 'injury',
          text: `MED healed ${e.worker_label || e.worker_id}${e.facilitator_override ? ' (facilitator override)' : ''}`,
        });
        break;
      }
      case 'heal_declined': {
        R.healing.declined += 1;
        const rec = healing.get(e.id);
        if (rec) { rec.declined_at = e.t; rec.status = 'DECLINED_BY_MED'; }
        break;
      }
      case 'heal_cancelled': {
        R.healing.cancelled += 1;
        const rec = healing.get(e.id);
        if (rec) rec.status = 'CANCELLED';
        break;
      }
      case 'heal_expired': {
        R.healing.expired += 1;
        const rec = healing.get(e.id);
        if (rec) rec.status = 'EXPIRED';
        break;
      }
      case 'heal_refused':
        R.healing.refused += 1;
        if (e.reason === 'med_capacity') R.healing.refused_capacity += 1;
        break;

      // -- fault rewards v2: one fixed reward per fault, and the tokens spent ----------
      case 'fault_reward_assigned': R.rewards.assigned += 1; break;
      case 'reward_awarded': {
        R.rewards.awarded += 1;
        R.rewards.by_type[e.reward_type] = (R.rewards.by_type[e.reward_type] || 0) + 1;
        if (e.reward_type === 'RESOURCE' && e.reward_value) R.rewards.resources[e.reward_value.resource] = (R.rewards.resources[e.reward_value.resource] || 0) + Number(e.reward_value.amount || 0);
        if (e.reward_type === 'INTEGRITY') R.rewards.integrity_points += Number((e.result || {}).integrity) || 0;
        if (e.reward_type === 'OPPORTUNITY' && e.reward_value) R.rewards.tokens_granted[e.reward_value.token] = (R.rewards.tokens_granted[e.reward_value.token] || 0) + 1;
        if (e.facilitator_override) R.rewards.overrides += 1;
        R.rewards.list.push({ t: e.t, fault: e.fault, sector: e.sector, via: e.via, type: e.reward_type, value: e.reward_value, override: !!e.facilitator_override });
        R.timeline.push({ t: e.t, kind: 'reward', text: `${e.sector} ${e.fault} reward: ${e.result_text || e.reward_type}${e.facilitator_override ? ' (facilitator override)' : ''}` });
        break;
      }
      case 'opportunity_used':
        R.rewards.tokens_used += 1;
        R.timeline.push({ t: e.t, kind: 'reward', text: `${e.sector} used ${String(e.token || '').replace(/_/g, ' ')}${e.fault ? ` on ${e.fault}` : ''}` });
        break;
      case 'opportunity_granted_by_facilitator':
        R.rewards.tokens_granted_by_facilitator += 1;
        R.timeline.push({ t: e.t, kind: 'reward', text: `${e.sector} granted ${String(e.token || '').replace(/_/g, ' ')} by the facilitator` });
        break;
      case 'opportunity_revoked':
        R.rewards.tokens_revoked += 1;
        R.timeline.push({ t: e.t, kind: 'reward', text: `${e.sector} ${String(e.token || '').replace(/_/g, ' ')} revoked by the facilitator` });
        break;
      case 'repair_completed': {
        R.repairs.count += 1;
        R.repairs.material_units += Number(e.material_units) || 0;
        for (const [k, v] of Object.entries(e.materials_consumed || {})) R.repairs.materials[k] = (R.repairs.materials[k] || 0) + Number(v);
        break;
      }
      case 'fault_reward_duplicate_blocked':
        R.rewards.duplicates_blocked += 1;
        R.rewards.list.push({ t: e.t, fault: e.fault, sector: e.sector, via: e.via, blocked: 'duplicate' });
        break;
      case 'fault_reward_force_resolve_skipped':
        R.rewards.force_skipped += 1;
        R.rewards.list.push({ t: e.t, fault: e.fault, sector: e.sector, via: e.via, blocked: 'force_resolve' });
        break;

      // -- the pre-v3 names, so an older run log still folds -------------------
      // -- COM's board -----------------------------------------------------------
      case 'com_row_updated':
        R.broadcast.row_updates += 1;
        if (e.facilitator_override) R.broadcast.overrides += 1;
        R.broadcast.list.push({ t: e.t, kind: 'row', sector: e.sector, previous: e.previous, values: e.values, by: e.by });
        R.timeline.push({ t: e.t, kind: 'announce', text: 'COM reported ' + e.sector + (e.facilitator_override ? ' (facilitator override)' : '') });
        break;
      case 'com_announcement_published':
        R.broadcast.announcements += 1;
        if (e.facilitator_override) R.broadcast.overrides += 1;
        R.broadcast.list.push({ t: e.t, kind: 'announcement', headline: e.headline, message: e.message, by: e.by });
        R.timeline.push({ t: e.t, kind: 'announce', text: 'COM broadcast: ' + (e.headline || e.message) });
        break;
      case 'com_announcement_cleared':
        R.broadcast.cleared += 1;
        break;
      // -- AGR's interventions ---------------------------------------------------
      case 'agr_random_offer_generated':
        R.agr.offers += 1;
        R.agr.list.push({ t: e.t, kind: 'offer', offered: e.offered, seed: e.seed });
        break;
      case 'agr_card_activated': {
        R.agr.activations += 1;
        R.agr.cards[e.card] = (R.agr.cards[e.card] || 0) + 1;
        if (e.facilitator_override) R.agr.overrides += 1;
        R.agr.list.push({ t: e.t, kind: 'activated', card: e.card, target: e.target, before: e.before, after: e.after, by: e.by });
        R.timeline.push({ t: e.t, kind: 'announce', text: 'AGR played ' + e.card + (e.facilitator_override ? ' (facilitator override)' : '') });
        break;
      }
      case 'agr_card_activation_refused':
        R.agr.refused += 1;
        R.agr.list.push({ t: e.t, kind: 'refused', card: e.card, reason: e.reason, by: e.by });
        break;
      case 'agr_admin_reroll':
        R.agr.rerolls += 1;
        R.agr.overrides += 1;
        R.agr.list.push({ t: e.t, kind: 'reroll', previous: e.previous_offer, offered: e.offered });
        break;

      // -- the pre-v3 names, so an older run log still folds -------------------
      case 'transfer_accepted': {
        R.transfers.accepted += 1;
        if (e.facilitator_override) R.transfers.facilitator_overrides += 1;
        const rec = transfers.get(e.id);
        if (rec) { rec.accepted_at = e.t; rec.status = 'ACCEPTED'; if (e.facilitator_override) rec.override = true; }
        R.timeline.push({ t: e.t, kind: 'transfer', text: `${e.from} accepted ${e.to} request (${e.amount} ${e.resource})` });
        break;
      }
      case 'transfer_declined': {
        R.transfers.declined += 1;
        const rec = transfers.get(e.id);
        if (rec) { rec.declined_at = e.t; rec.status = 'DECLINED'; }
        R.timeline.push({ t: e.t, kind: 'transfer', text: `${e.from} declined ${e.to} request` });
        break;
      }
      case 'transfer_expired': {
        R.transfers.expired += 1;
        const rec = transfers.get(e.id);
        if (rec) { rec.expired_at = e.t; rec.status = 'EXPIRED'; }
        R.timeline.push({ t: e.t, kind: 'transfer', text: `Transfer ${e.from} → ${e.to} expired (${e.reason || 'round change'})` });
        break;
      }
      case 'transfer_accept_refused':
        if (e.reason === 'insufficient_stock') R.transfers.accept_refused_stock += 1;
        break;
      case 'transfer_stamped': {
        R.transfers.stamped += 1;
        if (e.facilitator_override) R.transfers.facilitator_overrides += 1;
        const rec = transfers.get(e.id);
        if (rec) {
          rec.stamped_at = e.t;
          rec.status = e.delivered ? 'DELIVERED' : 'STAMPED';
          if (e.facilitator_override) rec.override = true;
          if (e.delivered) { rec.delivered_at = e.t; R.transfers.delivered += 1; }
        }
        R.timeline.push({
          t: e.t, kind: 'transfer',
          text: `TRN stamped ${e.from} → ${e.to}${e.facilitator_override ? ' (facilitator override)' : ''}`,
        });
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
        if (e.reason === 'not_accepted') R.transfers.refused_not_accepted += 1;
        if (e.reason === 'approval_trn_only') R.transfers.refused_not_trn += 1;
        if (e.reason === 'chit_required') R.transfers.refused_chit += 1;
        if (e.reason === 'insufficient_stock_stamp') R.transfers.refused_stock += 1;
        break;
      case 'council_called':
        R.council.called += 1;
        R.timeline.push({ t: e.t, kind: 'council', text: 'Council summoned' });
        break;
      case 'council_ended':
        R.council.list.push({ t: e.t, time_used_s: e.time_used_s ?? null, order_submitted: !!e.order_submitted });
        break;
      case 'council_nomination':
        R.council.nominations += 1;
        R.timeline.push({ t: e.t, kind: 'council', text: `${e.sector} nominated ${(e.choices || []).join(' + ')}` });
        break;
      case 'council_aggregate':
        R.timeline.push({ t: e.t, kind: 'council', text: `Nominations closed — provisional ${(e.provisional || []).join(' + ') || 'unresolved'}${(e.ties || []).length ? ` (tie: ${e.ties.join(' / ')})` : ''}` });
        break;
      case 'continuity_order':
        R.council.orders += 1;
        R.council.list.push({
          t: e.t, order: e.order, brownout: e.brownout, provisional: e.provisional || null,
          changed_from_provisional: !!e.changed_from_provisional, submitted_by: e.submitted_by || e.by || null,
          time_used_s: e.time_used_s ?? null, order_submitted: true,
        });
        R.timeline.push({ t: e.t, kind: 'order', text: `Continuity Order: ${(e.brownout || e.order || []).join(' + ')} brownout${e.changed_from_provisional ? ' (changed from the provisional two)' : ''}` });
        break;
      case 'brownout_applied':
        R.timeline.push({ t: e.t, kind: 'status', text: `Brownout in force: ${(e.sectors || []).join(' + ')}` });
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
      case 'upkeep_result': {
        // The session timeline keeps every charge (2026-10-05): paid, or short and what it cost.
        const cap = (k) => k.charAt(0).toUpperCase() + k.slice(1);
        const paid = Object.entries(e.resources_deducted || {}).map(([k, v]) => `-${v} ${cap(k)}`).join(', ');
        R.timeline.push({ t: e.t, kind: 'upkeep', text: e.upkeep_status === 'PAID'
          ? `${e.round} — ${e.sector} upkeep paid: ${paid || 'nothing due'}.`
          : `${e.round} — ${e.sector} upkeep shortfall: -${e.health_penalty || 0} Sector Health.` });
        break;
      }
      case 'cycle_processed': R.cycles += 1; R.timeline.push({ t: e.t, kind: 'cycle', text: `Core cycle ${e.cycle} processed` }); break;
      case 'event_fired': R.events += 1; R.timeline.push({ t: e.t, kind: 'event', text: e.name || e.event }); break;
      // CITY EVENTS (2026-10-06): on the timeline beside the behaviour they provoked; never a fault resolved or failed.
      // FALSE TELEMETRY (2026-10-06): never a fault fired, resolved or failed — its own record and its own timeline kind.
      case 'false_alert_fired': {
        const fa = {
          id: e.false_alert_id, fault_code: e.fault_code, target_sector: e.target_sector, round_fired: e.round || r, time_fired: e.t,
          target_opened_at: null, first_repair_attempt_at: null, repair_attempts: 0, com_notified_at: null, com_prepared_at: null,
          com_published_at: null, time_until_com_broadcast_s: null, round_end_time: null, com_communicated_before_expiry: 'NO',
          admin_force_clear: false, cancelled: false, related_requests: 0, ended_at: null,
        };
        falseAlerts.set(fa.id, fa);
        R.false_alerts.fired += 1;
        R.false_alerts.list.push(fa);
        R.timeline.push({ t: e.t, kind: 'telemetry', text: `False telemetry ${e.fault_code} fired at ${e.target_sector}` });
        break;
      }
      case 'false_alert_opened': { const fa = falseAlerts.get(e.false_alert_id); if (fa && !fa.target_opened_at) fa.target_opened_at = e.t; break; }
      case 'false_alert_repair_attempt': { const fa = falseAlerts.get(e.false_alert_id); if (fa) { fa.repair_attempts += 1; if (!fa.first_repair_attempt_at) fa.first_repair_attempt_at = e.t; } break; }
      case 'false_alert_com_notified': { const fa = falseAlerts.get(e.false_alert_id); if (fa) fa.com_notified_at = e.t; break; }
      case 'false_alert_correction_prepared': { const fa = falseAlerts.get(e.false_alert_id); if (fa && !fa.com_prepared_at) fa.com_prepared_at = e.t; break; }
      // COM published: communication only — the alert stays until the round ends, so nothing ends here.
      case 'false_alert_correction_published': {
        const fa = falseAlerts.get(e.false_alert_id);
        if (fa && !fa.com_published_at) {
          fa.com_published_at = e.t;
          fa.time_until_com_broadcast_s = e.seconds_since_fired ?? null;
          fa.com_communicated_before_expiry = 'YES';
        }
        R.false_alerts.corrected += 1;
        R.timeline.push({ t: e.t, kind: 'telemetry', text: `COM published the correction for ${e.fault_code} on ${e.target_sector}${Number.isFinite(e.seconds_since_fired) ? ` after ${e.seconds_since_fired}s` : ''} — the alert stays until the round ends` });
        break;
      }
      case 'false_alert_expired': {
        const fa = falseAlerts.get(e.false_alert_id);
        if (fa) { fa.ended_at = e.t; fa.round_end_time = e.t; fa.com_communicated_before_expiry = e.com_published_before_expiry || fa.com_communicated_before_expiry; }
        R.false_alerts.expired = (R.false_alerts.expired || 0) + 1;
        R.timeline.push({ t: e.t, kind: 'telemetry', text: `${e.fault_code} on ${e.target_sector} expired with the round — COM ${e.com_published_before_expiry === 'YES' ? 'had' : 'had not'} published` });
        break;
      }
      case 'false_alert_broadcast_cleared': {
        R.timeline.push({ t: e.t, kind: 'telemetry', text: `The correction for ${e.fault_code} left the wall (${e.reason})` });
        break;
      }
      case 'false_alert_force_cleared': {
        const fa = falseAlerts.get(e.false_alert_id);
        if (fa) { fa.admin_force_clear = true; fa.ended_at = e.t; }
        R.false_alerts.force_cleared += 1;
        R.timeline.push({ t: e.t, kind: 'telemetry', text: `Facilitator cleared false telemetry ${e.fault_code} on ${e.target_sector}` });
        break;
      }
      case 'false_alert_cancelled': {
        const fa = falseAlerts.get(e.false_alert_id);
        if (fa) { fa.cancelled = true; fa.ended_at = e.t; }
        R.false_alerts.cancelled += 1;
        R.timeline.push({ t: e.t, kind: 'telemetry', text: `Facilitator cancelled false telemetry ${e.fault_code} on ${e.target_sector}` });
        break;
      }
      case 'city_event_activated':
        R.city_events = (R.city_events || 0) + 1;
        R.timeline.push({ t: e.t, kind: 'city_event', text: `CITY EVENT ${e.event_name || e.event_id} (${e.event_type || '?'})${(e.affected_sectors || []).length ? ' — ' + e.affected_sectors.join(' ') : ''}` });
        break;
      case 'city_event_effect_expired':
        R.timeline.push({ t: e.t, kind: 'city_event', text: `${e.event_name || e.event_id}: ${String(e.kind || '').replace(/_/g, ' ')} on ${e.target} expired` });
        break;
      case 'city_event_upkeep_effect_consumed':
        R.timeline.push({ t: e.t, kind: 'city_event', text: `${e.event_name || e.event_id}: upkeep modifier on ${e.target} consumed` });
        break;
      case 'admin_override': R.overrides = (R.overrides || 0) + 1; R.timeline.push({ t: e.t, kind: 'override', text: `OVERRIDE ${String(e.action || '').toUpperCase().replace(/_/g, ' ')} · ${e.target || ''} — ${e.reason || ''}` }); break;
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

    const q = R.requests;
    for (const rec of q.list) rec.request_to_fulfil_s = secs(rec.requested_at, rec.fulfilled_at);
    q.avg_request_to_fulfil_s = round1(avg(q.list.map((x) => x.request_to_fulfil_s).filter((x) => x != null)));

    const hl = R.healing;
    for (const rec of hl.list) rec.request_to_heal_s = secs(rec.requested_at, rec.healed_at);
    hl.avg_request_to_heal_s = round1(avg(hl.list.map((x) => x.request_to_heal_s).filter((x) => x != null)));

    const t = R.transfers;
    for (const rec of t.list) {
      rec.request_to_accept_s = secs(rec.requested_at, rec.accepted_at);
      rec.request_to_stamp_s = secs(rec.requested_at, rec.stamped_at);
      rec.request_to_delivery_s = secs(rec.requested_at, rec.delivered_at);
    }
    t.avg_request_to_accept_s = round1(avg(t.list.map((x) => x.request_to_accept_s).filter((x) => x != null)));
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
    comparison: compare(rounds.R3, rounds.R7, 'R3', 'R7'),
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
    for (const k of Object.keys(o.requests)) if (typeof o.requests[k] === 'number') o.requests[k] += R.requests[k];
    for (const k of Object.keys(o.healing)) if (typeof o.healing[k] === 'number') o.healing[k] += R.healing[k];
    for (const k of Object.keys(o.broadcast)) if (typeof o.broadcast[k] === 'number') o.broadcast[k] += R.broadcast[k];
    for (const k of Object.keys(o.agr)) if (typeof o.agr[k] === 'number') o.agr[k] += R.agr[k];
    for (const k of Object.keys(o.rewards)) if (typeof o.rewards[k] === 'number') o.rewards[k] += R.rewards[k];
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
  delete o.requests.list; delete o.healing.list; delete o.broadcast.list; delete o.agr.list; delete o.rewards.list;
  return o;
}

/**
 * ROUND 3 vs ROUND 7, side by side: the last round of the learning phase
 * against the final round (2026-10-05 — it was Round 4 while that was the
 * last). Neutral: numbers only, no verdict, no winner (spec §43). The two
 * rounds are carried by id so the panel prints numbers and never a title.
 */
function compare(a, b, fromId = 'R3', toId = 'R7') {
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
    from: fromId,
    to: toId,
    [fromId]: pick(a),
    [toId]: pick(b),
  };
}

module.exports = { analyse, parseLog, compare };
