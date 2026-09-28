'use strict';
/**
 * Crisis systems, mixed into GameState (spec §28–§37):
 *
 *   council            CALL COUNCIL → a 60-second private nomination on every
 *                      table → the aggregate and a provisional two → a five-
 *                      minute sitting → the final order, or no order
 *   continuity order   exactly two sectors, locked on submission; they brown
 *                      out when Round 3 starts and stay in play
 *   rolling blackout   the no-decision consequence: brownout rotates through
 *                      the city until the facilitator ends it
 *   events             reusable, configurable consequences with visibility
 *   scheduled queue    delayed faults/events (presets, follow-ups)
 *   timeline           the per-round script; AUTO fires itself, MANUAL waits
 *                      for READY TO FIRE. The system never forces the script.
 *
 * Everything here is `this`-bound onto GameState.prototype.
 */

const economy = require('./economy');

// -- council ------------------------------------------------------------------
/*
 * THE R2 COUNCIL (undercity_r2_council_brownout_spec v1.0, 2026-09-28).
 *
 * One sitting, three beats, all kept on `state.council`:
 *
 *   nomination     every sector privately names exactly TWO sectors for a
 *                  temporary brownout — itself allowed, no abstention, void
 *                  when incomplete. Editable until the 60-second clock runs
 *                  out, the sixth table is in, or the facilitator closes it.
 *                  Other tables never see a vote; the facilitator sees them
 *                  all, live. One record per sector per sitting, so a refresh,
 *                  a reconnect or a repeated click never duplicates anything.
 *   aggregate      the valid nominations are counted. The top two are
 *                  PROVISIONAL only. A tie affecting either position is shown
 *                  as unresolved and never broken by chance.
 *   deliberation   five minutes for the Council to confirm or replace the
 *                  provisional two and submit the final Continuity Order —
 *                  exactly two unique sectors, locked on submission, never
 *                  recalled. 00:00 with no order: the rolling blackout, by
 *                  itself, as the Charter says.
 *
 * The brownout itself waits for Round 3 (`brownout_apply_round`): the two
 * sectors stay in play and keep their seat at the table; only their
 * capability drops, through the brownout effects the engine already applies.
 */

function councilSectorCodes() { return Object.keys(this.state.sectors); }
function nominationLength() { return Math.max(1, Number(this.cfg.nomination_clock_s ?? 60)); }
function deliberationLength() { return Math.max(1, Number(this.cfg.council_clock_s ?? 300)); }

function brownoutApplyRound() {
  const want = String(this.cfg.brownout_apply_round || 'R3').toUpperCase();
  return this.rounds.rounds.some((r) => r.id === want) ? want : 'R3';
}

/** Who has nominated so far — a count the room may see, names the facilitator may. */
function nominationStatus() {
  const c = this.state.council;
  const codes = this.councilSectorCodes();
  const submitted = codes.filter((k) => c.nominations && c.nominations[k]);
  return { submitted, pending: codes.filter((k) => !submitted.includes(k)), count: submitted.length, of: codes.length };
}

/** The facilitator calls the Council: the private nomination opens on every table, on its own clock. */
function callCouncil({ by = 'facilitator' } = {}) {
  const c = this.state.council;
  if (c.active) return { ok: false, reason: 'council_already_active', count: c.count, stage: c.stage };
  c.active = true;
  c.count += 1;
  c.round = this.state.round;
  c.started_at = new Date().toISOString();
  c.ended_at = null;
  c.stage = 'nomination';
  c.nominations = {};
  c.aggregate = null;
  c.final = null;
  c.order = null;
  c.order_at = null;
  c.no_order = false;
  c.warned_30 = false;
  c.called_by = by;
  this.state.mode = 'COUNCIL';
  const len = this.nominationLength();
  this.state.council_clock = { running: true, remaining_s: len, stage: 'nomination', length_s: len };
  this.ticker('council', 'COUNCIL SUMMONED — PRIVATE NOMINATION OPEN');
  this.log.write('council_called', {
    count: c.count, round: c.round, stage: 'nomination', by,
    nomination_s: len, deliberation_s: this.deliberationLength(),
  });
  this.log.write('mode', { mode: 'COUNCIL' });
  this.sting('council');
  this.touch();
  return { ok: true, count: c.count, stage: c.stage, round: c.round };
}

/**
 * A table's private nomination: exactly two unique sectors, itself allowed.
 * One record per sector per sitting — a re-submission before the close
 * replaces it, the same pair again changes nothing, and after the close the
 * door is shut. An incomplete submission is void and is not stored.
 */
function submitNomination(sector, choices, { by = null } = {}) {
  const c = this.state.council;
  const code = String(sector || '').toUpperCase();
  if (!this.state.sectors[code]) return { ok: false, reason: 'unknown_sector' };
  if (!c.active || c.stage !== 'nomination') return { ok: false, reason: 'nomination_closed', stage: c.stage || null, sector: code };
  const codes = this.councilSectorCodes();
  const list = Array.isArray(choices) ? choices.map((x) => String(x || '').toUpperCase()) : [];
  const unique = new Set(list);
  if (list.length !== 2 || unique.size !== 2 || !list.every((x) => codes.includes(x))) {
    this.log.write('council_nomination_refused', { count: c.count, sector: code, choices: list, reason: 'nomination_invalid' });
    return { ok: false, reason: 'nomination_invalid', sector: code };
  }
  const existing = c.nominations[code];
  const now = new Date().toISOString();
  if (existing && existing.choices.every((x) => unique.has(x))) {
    return {
      ok: true, unchanged: true, sector: code, choices: [...existing.choices], submitted_at: existing.submitted_at,
      submitted: this.nominationStatus().count, of: codes.length,
    };
  }
  c.nominations[code] = {
    sector: code, round: c.round, choices: list, submitted_at: now, valid: true,
    by: by || code, revisions: existing ? (existing.revisions || 0) + 1 : 0,
  };
  const status = this.nominationStatus();
  this.log.write('council_nomination', {
    count: c.count, round: c.round, sector: code, choices: list, revision: c.nominations[code].revisions, by: by || code,
  });
  this.ticker('council', `${code} NOMINATED · ${status.count}/${status.of} IN`, { scope: 'admin' });
  this.touch();
  if (status.count >= status.of) this.closeNominations({ by: 'all_in' });
  return { ok: true, sector: code, choices: list, submitted_at: now, submitted: status.count, of: status.of };
}

/**
 * Count the valid nominations. The top two are provisional; a tie affecting
 * either position is listed and left for the Council — never broken here.
 */
function aggregateNominations() {
  const c = this.state.council;
  const codes = this.councilSectorCodes();
  const totals = Object.fromEntries(codes.map((k) => [k, 0]));
  const valid = [];
  const voided = [];
  for (const k of codes) {
    const n = c.nominations && c.nominations[k];
    if (n && n.valid && Array.isArray(n.choices) && n.choices.length === 2) {
      valid.push(k);
      for (const ch of n.choices) if (ch in totals) totals[ch] += 1;
    } else {
      voided.push(k);
    }
  }
  const ranked = codes.map((k) => ({ code: k, total: totals[k] }))
    .sort((a, b) => b.total - a.total || a.code.localeCompare(b.code));
  let provisional = [];
  let ties = [];
  let unresolved = [];
  if (valid.length === 0) {
    unresolved = [1, 2];
  } else {
    const top = ranked.filter((r) => r.total === ranked[0].total).map((r) => r.code);
    if (top.length >= 3) {
      ties = top; unresolved = [1, 2];
    } else if (top.length === 2) {
      provisional = top;
    } else {
      provisional = [top[0]];
      const second = ranked.filter((r) => r.total === ranked[1].total).map((r) => r.code);
      if (second.length === 1) provisional.push(second[0]);
      else { ties = second; unresolved = [2]; }
    }
  }
  return { totals, ranked, provisional, ties, unresolved, valid_count: valid.length, void: voided, computed_at: new Date().toISOString() };
}

/** Nominations close — by the clock, by the sixth table, or by the facilitator — and the Council sits. */
function closeNominations({ by = 'facilitator' } = {}) {
  const c = this.state.council;
  if (!c.active || c.stage !== 'nomination') return { ok: false, reason: 'nominations_not_open', stage: c.stage || null };
  c.aggregate = { ...this.aggregateNominations(), closed_by: by };
  c.stage = 'deliberation';
  c.warned_30 = false;
  const len = this.deliberationLength();
  this.state.council_clock = { running: true, remaining_s: len, stage: 'deliberation', length_s: len };
  const a = c.aggregate;
  const word = a.unresolved.length
    ? `PROVISIONAL ${a.provisional.join(' + ') || '—'} · ${a.unresolved.length === 2 ? 'BOTH POSITIONS' : 'SECOND POSITION'} UNRESOLVED`
    : `PROVISIONAL BROWNOUT ${a.provisional.join(' + ')}`;
  this.ticker('council', `NOMINATIONS CLOSED — COUNCIL SITS · ${word}`);
  this.log.write('council_nominations_closed', { count: c.count, round: c.round, by, valid_count: a.valid_count, void: a.void });
  this.log.write('council_aggregate', {
    count: c.count, round: c.round, totals: a.totals, provisional: a.provisional, ties: a.ties, unresolved: a.unresolved, valid_count: a.valid_count,
  });
  this.sting('council');
  this.touch();
  return { ok: true, stage: c.stage, aggregate: c.aggregate };
}

function endCouncil(reason = 'ended') {
  const c = this.state.council;
  if (!c.active) return false;
  c.active = false;
  c.ended_at = new Date().toISOString();
  this.state.council_clock.running = false;
  if (this.state.mode === 'COUNCIL') this.state.mode = 'PLAY';
  const used = c.stage === 'nomination' ? null : Math.round(this.deliberationLength() - this.state.council_clock.remaining_s);
  if (c.stage === 'nomination' || c.stage === 'deliberation') c.stage = 'abandoned';
  if (!Array.isArray(c.history)) c.history = [];
  // The whole sitting, kept for the debrief: every private vote, the aggregate, the provisional two and the final two.
  c.history.push(JSON.parse(JSON.stringify({
    count: c.count, round: c.round, started_at: c.started_at, ended_at: c.ended_at, reason, stage: c.stage,
    nominations: c.nominations, aggregate: c.aggregate, final: c.final, no_order: c.no_order, time_used_s: used,
  })));
  this.ticker('council', 'COUNCIL ENDED');
  this.log.write('council_ended', { reason, order_submitted: !!c.final, time_used_s: used, count: c.count, stage: c.stage });
  this.log.write('mode', { mode: this.state.mode });
  this.touch();
  return true;
}

/** Runs inside tick() while the Council is active. */
function tickCouncil() {
  const c = this.state.council;
  const clk = this.state.council_clock;
  if (c.stage === 'nomination') {
    if (clk.remaining_s <= 0) this.closeNominations({ by: 'timer' });
    return;
  }
  if (c.stage !== 'deliberation') return;
  if (clk.remaining_s <= 30 && clk.remaining_s > 0 && !c.warned_30) {
    c.warned_30 = true;
    this.sting('warning_30');
  }
  if (clk.remaining_s > 0 || c.final) return;

  // 00:00 with no valid order: the Charter's consequence, by itself.
  c.no_order = true;
  c.stage = 'no_order';
  clk.running = false;
  this.ticker('council', 'NO CONTINUITY ORDER RECEIVED — ROLLING BLACKOUT');
  this.log.write('council_no_order', { count: c.count, round: c.round });
  this.sting('critical');
  this.endCouncil('no order');
  this.startRollingBlackout({ by: 'council' });
  this.touch();
}

/**
 * THE FINAL CONTINUITY ORDER: exactly two unique sectors, from the Council's
 * recorder at a station or from the facilitator, during the deliberation.
 * It locks the moment it lands and is never recalled; the two sectors are
 * marked pending and brown out when Round 3 starts (at once, if it already
 * has). A legacy six-rank order names its bottom two.
 */
function submitContinuityOrder(order, { by = 'facilitator' } = {}) {
  const c = this.state.council;
  const codes = this.councilSectorCodes();
  let list = Array.isArray(order) ? order.map((x) => String(x || '').toUpperCase()) : [];
  if (list.length === codes.length && new Set(list).size === codes.length && codes.every((k) => list.includes(k))) list = list.slice(-2);
  if (c.final) return { ok: false, reason: 'order_locked', order: c.final };
  if (!c.active) return { ok: false, reason: 'council_not_sitting' };
  if (c.stage !== 'deliberation') return { ok: false, reason: 'nominations_open', stage: c.stage };
  const unique = new Set(list);
  if (list.length !== 2 || unique.size !== 2 || !list.every((k) => codes.includes(k))) return { ok: false, reason: 'order_incomplete' };

  const now = new Date().toISOString();
  const a = c.aggregate || { provisional: [], totals: {} };
  const sameAsProvisional = a.provisional.length === 2 && a.provisional.every((k) => unique.has(k));
  const applyRound = this.brownoutApplyRound();
  const record = {
    id: this.id('CO'), round: c.round, council_count: c.count,
    brownout: list, order: list,
    provisional: [...a.provisional], totals: { ...a.totals }, changed_from_provisional: !sameAsProvisional,
    submitted_at: now, t: now, submitted_by: by, by, locked: true,
    time_used_s: Math.round(this.deliberationLength() - this.state.council_clock.remaining_s),
    apply_round: applyRound, applied_at: null,
  };
  c.final = record;
  c.order = list;
  c.order_at = now;
  c.no_order = false;
  c.stage = 'decided';
  this.state.continuity_order = record;
  this.state.brownout_pending = { sectors: [...list], council_count: c.count, decided_at: now, apply_round: applyRound };

  const n = this.roundOrdinal(applyRound);
  this.ticker('order', `CONTINUITY ORDER LOCKED — ${list.join(' + ')} BROWNOUT FROM ROUND ${n}`);
  this.announce(`Continuity Order accepted. ${list.join(' and ')} enter brownout when Round ${n} begins.`);
  this.setAlert({ title: 'CONTINUITY ORDER ACCEPTED', subtitle: `${list.join(' · ')} — BROWNOUT FROM ROUND ${n}` });
  this.log.write('continuity_order', record);
  this.endCouncil('order submitted');
  // Decided once the apply round has already begun: the brownout does not wait.
  if (this.roundOrdinal(this.state.round) >= n) this.applyPendingBrownout({ by: 'continuity_order' });
  this.touch();
  return { ok: true, order: record };
}

/** Round 3 begins: the Council's two sectors brown out — still playable, still seated, reduced. */
function applyPendingBrownout({ by = 'round' } = {}) {
  const p = this.state.brownout_pending;
  if (!p || !Array.isArray(p.sectors) || !p.sectors.length) return false;
  const at = new Date().toISOString();
  for (const code of p.sectors) if (this.state.sectors[code]) this.setStatus(code, 'BROWNOUT', { by: 'order' });
  if (this.state.continuity_order && this.state.continuity_order.council_count === p.council_count) this.state.continuity_order.applied_at = at;
  if (this.state.council.final && this.state.council.final.council_count === p.council_count) this.state.council.final.applied_at = at;
  this.log.write('brownout_applied', { sectors: [...p.sectors], council_count: p.council_count, round: this.state.round, by, at });
  this.ticker('order', `BROWNOUT IN FORCE — ${p.sectors.join(' + ')}`);
  this.state.brownout_pending = null;
  this.touch();
  return true;
}

// -- rolling blackout ---------------------------------------------------------

function startRollingBlackout({ by = 'facilitator' } = {}) {
  const b = this.state.blackout;
  if (b.active) return false;
  const rb = this.cfg.rolling_blackout || {};
  b.active = true;
  b.started_at = new Date().toISOString();
  b.index = 0;
  b.current = [];
  b.restore = {};
  b.next_rotate_s = 0;
  b.interval_s = Number(rb.interval_s ?? 60);
  b.at_a_time = Number(rb.sectors_at_a_time ?? 2);
  this.setAlert({ title: 'ROLLING BLACKOUT INITIATED', subtitle: 'NO CONTINUITY ORDER — ALL SECTORS AT RISK' });
  this.ticker('blackout', 'ROLLING BLACKOUT INITIATED');
  this.log.write('blackout_started', { by, interval_s: b.interval_s, at_a_time: b.at_a_time });
  this.sting('brownout');
  this.rotateBlackout();
  this.touch();
  return true;
}

function rotateBlackout() {
  const b = this.state.blackout;
  const codes = Object.keys(this.state.sectors);
  // Restore the sectors that were only browned out by the rotation.
  for (const code of b.current) {
    const s = this.state.sectors[code];
    if (s && s.brownout_by === 'blackout') {
      s.status_override = b.restore[code] || null;
      s.brownout_by = s.status_override === 'BROWNOUT' ? 'order' : null;
      this.refreshStatus(s);
    }
  }
  const next = [];
  for (let i = 0; i < b.at_a_time; i += 1) {
    next.push(codes[(b.index + i) % codes.length]);
  }
  b.index = (b.index + b.at_a_time) % codes.length;
  b.current = next;
  for (const code of next) {
    const s = this.state.sectors[code];
    if (s.status === 'DARK') continue;
    if (s.status_override !== 'BROWNOUT') {
      b.restore[code] = s.status_override;
      this.setStatus(code, 'BROWNOUT', { by: 'blackout' });
    }
  }
  b.next_rotate_s = b.interval_s;
  this.log.write('blackout_rotated', { sectors: next });
  this.touch();
}

function tickBlackout(secs) {
  const b = this.state.blackout;
  if (!b.active) return;
  b.next_rotate_s -= secs;
  if (b.next_rotate_s <= 0) this.rotateBlackout();
}

function endRollingBlackout() {
  const b = this.state.blackout;
  if (!b.active) return false;
  for (const code of b.current) {
    const s = this.state.sectors[code];
    if (s && s.brownout_by === 'blackout') {
      s.status_override = b.restore[code] || null;
      s.brownout_by = null;
      this.refreshStatus(s);
    }
  }
  b.active = false;
  b.current = [];
  this.ticker('blackout', 'ROLLING BLACKOUT ENDED');
  this.log.write('blackout_ended', {});
  this.touch();
  return true;
}

// -- events -------------------------------------------------------------------

function eventDef(id) {
  return (this.scenario.events || []).find((e) => e.id === id) || null;
}

function resolveTargets(def, target) {
  const codes = Object.keys(this.state.sectors);
  const t = def.targets;
  if (Array.isArray(t)) return t.filter((c) => codes.includes(c));
  if (t === 'ALL') return codes;
  if (t === 'PICK') return target && codes.includes(target) ? [target] : [];
  if (typeof t === 'string' && t.startsWith('RANDOM')) {
    const n = Number(t.slice(6)) || 1;
    const pool = codes.filter((c) => this.state.sectors[c].status !== 'DARK');
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, n);
  }
  return target && codes.includes(target) ? [target] : [];
}

/**
 * Fire a configured event. Visibility decides who learns about it:
 *   ADMIN_ONLY     log + facilitator feed only
 *   CITY_WIDE      wall ticker + announcement to every sector
 *   TARGET_SECTOR  announcement to the target(s) only
 *   COMMS_ONLY     COM's intelligence feed only
 */
function fireEvent(id, { target = null, source = 'facilitator' } = {}) {
  const def = this.eventDef(id);
  if (!def) return { ok: false, reason: 'unknown_event' };
  const targets = this.resolveTargets(def, target);
  if (def.targets === 'PICK' && !targets.length) return { ok: false, reason: 'target_required' };

  const vis = def.visibility || 'ADMIN_ONLY';
  const sub = (text) => String(text || '').replace('{target}', targets.join(' & '));
  const applied = { targets, integrity: {}, resources: {}, injured: {} };

  for (const [code, delta] of Object.entries(def.integrity_changes || {})) {
    const list = code === 'TARGET' ? targets : [code];
    for (const c of list) if (this.state.sectors[c]) { this.adjustIntegrity(c, delta); applied.integrity[c] = delta; }
  }
  if (def.resource_changes) {
    for (const c of targets) { this.adjustInventory(c, def.resource_changes, { reason: `event:${id}` }); applied.resources[c] = def.resource_changes; }
  }
  if (def.resource_changes_all) {
    for (const c of Object.keys(this.state.sectors)) this.adjustInventory(c, def.resource_changes_all, { reason: `event:${id}` });
    applied.resources.ALL = def.resource_changes_all;
  }
  if (def.worker_changes && def.worker_changes.injure) {
    const list = def.worker_changes.sectors || targets;
    for (const c of list) applied.injured[c] = this.injure(c, def.worker_changes.injure);
  }
  if (def.core_delta) this.setCoreOutput(this.state.core_integrity + Number(def.core_delta));
  for (const [key, value] of Object.entries(def.intel_changes || {})) this.setIntel(key, value);
  for (const eff of def.effects || []) {
    const effTarget = eff.target || (eff.kind === 'trn_capacity' ? 'TRN' : eff.kind === 'com_blind' ? 'COM' : (targets[0] || 'ALL'));
    const e = { kind: eff.kind, target: effTarget, source: id };
    if (eff.duration_s !== undefined) e.remaining_s = Number(eff.duration_s);
    // `rounds` since 2026-09-28 (the round is the period); `cycles` is the same count in older scenarios.
    if (eff.rounds !== undefined || eff.cycles !== undefined) e.cycles_remaining = Number(eff.rounds ?? eff.cycles);
    if (eff.value !== undefined) e.value = Number(eff.value);
    if (eff.delta !== undefined) e.delta = Number(eff.delta);
    this.addEffect(e);
  }

  if (vis === 'CITY_WIDE') {
    this.ticker('event', sub(def.ticker || def.name));
    if (def.announce) this.announce(sub(def.announce));
    if (def.alert) this.setAlert({ title: sub(def.alert.title), subtitle: sub(def.alert.subtitle), big: def.alert.big });
  } else if (vis === 'TARGET_SECTOR') {
    for (const c of targets) this.announce(sub(def.announce || def.name), { sector: c });
    this.ticker('event', `${def.name} → ${targets.join(', ')}`, { scope: 'admin' });
  } else if (vis === 'COMMS_ONLY') {
    if (def.announce) this.announce(sub(def.announce), { sector: 'COM' });
    this.ticker('event', `${def.name} (COM only)`, { scope: 'admin' });
  } else {
    this.ticker('event', `${def.name} → ${targets.join(', ') || 'city'}`, { scope: 'admin' });
  }

  for (const f of def.followups || []) {
    this.schedule({ kind: 'event', event_id: f.event_id, target: f.target || targets[0] || null, delay_s: f.delay_s, source: `followup:${id}` });
  }

  this.log.write('event_fired', { event: id, name: def.name, visibility: vis, ...applied, source });
  this.touch();
  return { ok: true, event: id, targets };
}

// -- scheduled queue ----------------------------------------------------------

function schedule(item) {
  const at = this.state.game_clock_s + Number(item.delay_s || 0);
  const entry = { id: this.id('S'), at_s: at, ...item };
  this.state.scheduled.push(entry);
  this.state.scheduled.sort((a, b) => a.at_s - b.at_s);
  this.log.write('scheduled', { id: entry.id, kind: entry.kind, at_s: Math.round(at), fault: entry.fault_code || null, event: entry.event_id || null, source: entry.source || null });
  this.touch();
  return entry;
}

function cancelScheduled(id) {
  const i = this.state.scheduled.findIndex((s) => s.id === id);
  if (i < 0) return false;
  this.state.scheduled.splice(i, 1);
  this.log.write('scheduled_cancelled', { id });
  this.touch();
  return true;
}

function tickScheduled() {
  const now = this.state.game_clock_s;
  while (this.state.scheduled.length && this.state.scheduled[0].at_s <= now) {
    const item = this.state.scheduled.shift();
    if (item.kind === 'fault') this.fireFault(item.fault_code, item.sector, { source: item.source || 'preset' });
    else if (item.kind === 'event') this.fireEvent(item.event_id, { target: item.target, source: item.source || 'scheduled' });
    this.touch();
  }
}

/** ROUND 2 WAVE A: several faults with configured delays. */
function firePreset(id) {
  const def = (this.scenario.fault_presets || []).find((p) => p.id === id);
  if (!def) return { ok: false, reason: 'unknown_preset' };
  const fired = [];
  for (const item of def.items) {
    if (!item.delay_s) fired.push(this.fireFault(item.fault_code, item.sector, { source: `preset:${id}` }));
    else this.schedule({ kind: 'fault', fault_code: item.fault_code, sector: item.sector, delay_s: item.delay_s, source: `preset:${id}` });
  }
  this.ticker('event', `PRESET ${def.name}`, { scope: 'admin' });
  this.log.write('preset_fired', { preset: id, items: def.items.length });
  this.touch();
  return { ok: true, fired };
}

// -- timeline -----------------------------------------------------------------

/** Load the round's script. Called whenever the round changes. */
function armTimeline(roundId) {
  const items = (this.scenario.timelines || {})[roundId] || [];
  // Continuous gameflow (2026-09-21): a beat's offset is measured from the
  // moment its phase was armed. Since the ROUND TIMER (2026-09-28) roundElapsed()
  // reads that timer instead; this stamp is kept for the log and old snapshots.
  // MASTER TIME used to run the whole shift
  // now, so it can no longer be what says how far into a round the city is.
  this.state.timeline_armed_game_s = this.state.game_clock_s;
  this.state.timeline = items.map((it, i) => ({
    id: `${roundId}-${String(i + 1).padStart(2, '0')}`,
    round: roundId,
    offset_s: Number(it.offset_s || 0),
    kind: it.kind,
    fault_code: it.fault_code || null,
    sector: it.sector || null,
    event_id: it.event_id || null,
    text: it.text || null,
    value: it.value ?? null,
    note: it.note || null,
    mode: it.mode === 'AUTO' ? 'AUTO' : 'MANUAL',
    status: 'PENDING',
    fired_at: null,
  }));
}

function roundElapsed() {
  // Minutes into the round as the ROUND TIMER tells it: its length less what
  // is left. READY is 00:00, PAUSED holds, and the beats follow the clock the
  // facilitator is looking at — not game time, which runs between rounds.
  const clk = this.state.round_clock;
  return Math.max(0, (Number(clk.duration_s) || 0) - this.roundTimerRemaining());
}

function tickTimeline() {
  if (!this.state.round_clock.running) return;
  const elapsed = this.roundElapsed();
  for (const item of this.state.timeline) {
    if (item.status !== 'PENDING' || item.offset_s > elapsed) continue;
    if (item.mode === 'AUTO') this.fireTimelineItem(item.id, { by: 'auto' });
    else { item.status = 'READY'; this.sting('chime'); this.touch(); }
  }
}

function fireTimelineItem(id, { by = 'facilitator' } = {}) {
  const item = this.state.timeline.find((t) => t.id === id);
  if (!item || item.status === 'FIRED' || item.status === 'SKIPPED') return { ok: false, reason: 'not_fireable' };
  let result = { ok: true };
  switch (item.kind) {
    case 'fault':    result = this.fireFault(item.fault_code, item.sector, { source: `timeline:${id}` }); break;
    case 'event':    result = this.fireEvent(item.event_id, { target: item.sector, source: `timeline:${id}` }); break;
    case 'council':  this.callCouncil(); break;
    case 'core':     this.setCoreOutput(item.value); break;
    case 'announce': this.announce(item.text); break;
    case 'alert':    this.setAlert({ title: item.text }); break;
    case 'cycle':    economy.processCycle(this); break;
    default:         result = { ok: false, reason: 'unknown_kind' };
  }
  item.status = 'FIRED';
  item.fired_at = new Date().toISOString();
  item.result = result.ok ? null : result.reason;
  this.log.write('timeline_fired', { id, kind: item.kind, by, ok: result.ok, reason: result.reason || null });
  this.touch();
  return result;
}

function skipTimelineItem(id) {
  const item = this.state.timeline.find((t) => t.id === id);
  if (!item || item.status === 'FIRED') return false;
  item.status = 'SKIPPED';
  this.log.write('timeline_skipped', { id, kind: item.kind });
  this.touch();
  return true;
}

function delayTimelineItem(id, seconds) {
  const item = this.state.timeline.find((t) => t.id === id);
  if (!item || item.status === 'FIRED' || item.status === 'SKIPPED') return false;
  item.offset_s = Math.max(0, item.offset_s + Number(seconds || 0));
  if (item.status === 'READY' && item.offset_s > this.roundElapsed()) item.status = 'PENDING';
  this.log.write('timeline_delayed', { id, seconds: Number(seconds), offset_s: item.offset_s });
  this.touch();
  return true;
}

module.exports = {
  callCouncil, endCouncil, tickCouncil, submitContinuityOrder,
  councilSectorCodes, nominationLength, deliberationLength, brownoutApplyRound, nominationStatus,
  submitNomination, aggregateNominations, closeNominations, applyPendingBrownout,
  startRollingBlackout, rotateBlackout, tickBlackout, endRollingBlackout,
  eventDef, resolveTargets, fireEvent,
  schedule, cancelScheduled, tickScheduled, firePreset,
  armTimeline, roundElapsed, tickTimeline, fireTimelineItem, skipTimelineItem, delayTimelineItem,
};
