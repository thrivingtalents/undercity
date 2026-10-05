'use strict';
/**
 * Crisis systems, mixed into GameState (spec §28–§37):
 *
 *   council            CALL COUNCIL → a one-minute discussion clock on every
 *                      screen, held, moved and closed by the facilitator;
 *                      00:00 says COUNCIL TIME EXPIRED and triggers nothing
 *   rolling blackout   the no-decision consequence: brownout rotates through
 *                      the city until the facilitator ends it
 *   events             reusable, configurable consequences with visibility
 *   scheduled queue    delayed faults/events (presets, follow-ups)
 *   timeline           the per-round script; AUTO fires itself, MANUAL waits —
 *                      except a broadcast at 00:00, which always waits (2026-10-06)
 *                      for READY TO FIRE. The system never forces the script.
 *
 * Everything here is `this`-bound onto GameState.prototype.
 */

const economy = require('./economy');

// A MAJOR transition broadcast (TRAINING PROTOCOLS CONCLUDED, FINAL OPERATING WINDOW)
// holds the takeover this long before it shrinks to the strip; a normal one
// uses the scenario's alert_full_screen_s.
const MAJOR_ALERT_S = 14;

// -- council ------------------------------------------------------------------
/*
 * THE COUNCIL (undercity_simple_call_council_timer_spec v1.0, 2026-09-29).
 *
 * A discussion timer, and nothing else. CALL COUNCIL opens one sitting and
 * starts a one-minute countdown; the facilitator can hold and run it, move
 * it thirty seconds either way, reset it to the full minute, and close the
 * sitting. At 00:00 the clock stops and says COUNCIL TIME EXPIRED — nothing
 * else moves: no brownout, no blackout, no fault. Brownout stays the
 * facilitator's own control on the Overview, used by hand afterwards.
 *
 * Like the round timer, the clock carries the server time it reaches 00:00,
 * so a refresh, a reconnect or a re-render restores the exact remaining time
 * and never starts a second one; a second CALL while it sits changes nothing.
 */

function councilLength() { return Math.max(1, Number(this.cfg.council_clock_s ?? 60)); }

/** Seconds left on the Council clock right now, measured from its end time while it runs. */
function councilRemaining() {
  const clk = this.state.council_clock || {};
  if (clk.status === 'running' && clk.target_end_at !== null && clk.target_end_at !== undefined && Number.isFinite(Number(clk.target_end_at))) {
    return Math.max(0, (Number(clk.target_end_at) - this.nowMs) / 1000);
  }
  return Math.max(0, Number(clk.remaining_s) || 0);
}

/** A fresh, unstarted Council clock at the configured length. */
function councilClockReady() {
  const len = this.councilLength();
  return { status: 'ready', running: false, duration_s: len, remaining_s: len, started_at: null, target_end_at: null, paused_at: null };
}

/** CALL COUNCIL: one sitting, one clock, started at once. A second call while it sits changes nothing. */
function callCouncil({ by = 'facilitator' } = {}) {
  const c = this.state.council;
  if (c.active) {
    return { ok: false, reason: 'council_already_active', count: c.count, status: c.status, remaining_s: Math.ceil(this.councilRemaining()) };
  }
  const len = this.councilLength();
  const now = new Date().toISOString();
  c.active = true;
  c.status = 'active';
  c.count += 1;
  c.round = this.state.round;
  c.started_at = now;
  c.ended_at = null;
  c.expired_at = null;
  c.warned_30 = false;
  c.called_by = by;
  this.state.mode = 'COUNCIL';
  this.state.council_clock = {
    status: 'running', running: true, duration_s: len, remaining_s: len,
    started_at: now, target_end_at: this.state.paused ? null : this.nowMs + len * 1000, paused_at: null,
  };
  this.ticker('council', 'COUNCIL SUMMONED — CHIEFS + LIAISONS REPORT');
  this.log.write('council_called', { count: c.count, round: c.round, by, duration_s: len });
  this.log.write('mode', { mode: 'COUNCIL' });
  this.sting('council');
  this.touch();
  return { ok: true, count: c.count, status: c.status, remaining_s: len };
}

/** 00:00 — the clock stops and says so. It triggers nothing. */
function councilExpire({ by = 'timer' } = {}) {
  const c = this.state.council;
  const clk = this.state.council_clock;
  clk.remaining_s = 0;
  clk.target_end_at = null;
  clk.status = 'expired';
  clk.running = false;
  c.status = 'expired';
  c.expired_at = c.expired_at || new Date().toISOString();
  this.ticker('council', 'COUNCIL TIME EXPIRED');
  this.log.write('council_expired', { count: c.count, round: c.round, duration_s: clk.duration_s, by });
  this.sting('alert');
  this.touch();
}

/** Runs inside tick() while the Council sits: the countdown from its end time, the 30-second word, the stop at 00:00. */
function tickCouncil() {
  const c = this.state.council;
  const clk = this.state.council_clock;
  if (!c.active || clk.status !== 'running') return;
  clk.remaining_s = this.councilRemaining();
  if (clk.remaining_s <= 30 && clk.remaining_s > 0 && !c.warned_30) {
    c.warned_30 = true;
    this.sting('warning_30');
  }
  if (clk.remaining_s <= 0) this.councilExpire({ by: 'timer' });
}

/** CLOSE COUNCIL: the clock stops, the sitting ends, and the next call starts fresh at the full minute. */
function endCouncil(reason = 'closed') {
  const c = this.state.council;
  if (!c.active) return false;
  const clk = this.state.council_clock;
  const used = Math.max(0, Math.round((Number(clk.duration_s) || this.councilLength()) - this.councilRemaining()));
  c.active = false;
  c.status = 'idle';
  c.ended_at = new Date().toISOString();
  this.state.council_clock = this.councilClockReady();
  if (this.state.mode === 'COUNCIL') this.state.mode = 'PLAY';
  this.ticker('council', 'COUNCIL CLOSED');
  this.log.write('council_ended', { reason, time_used_s: used, count: c.count, expired: !!c.expired_at });
  this.log.write('mode', { mode: this.state.mode });
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
    // MANUAL FAULTS (2026-10-04): a clock never fires a fault. A delayed fault
    // in the queue is dropped and logged; the facilitator fires it by hand.
    if (item.kind === 'fault') this.log.write('fault_auto_trigger_dropped', { id: item.id, fault: item.fault_code, sector: item.sector, source: item.source || null, reason: 'faults_are_manual' });
    else if (item.kind === 'event') this.fireEvent(item.event_id, { target: item.target, source: item.source || 'scheduled' });
    this.touch();
  }
}

/** ROUND 2 WAVE A: several faults with configured delays. */
function firePreset(id) {
  const def = (this.scenario.fault_presets || []).find((p) => p.id === id);
  if (!def) return { ok: false, reason: 'unknown_preset' };
  // A preset is the facilitator's press, so its immediate items fire now. Its
  // delayed items would fire on a clock, which nothing may do any more
  // (2026-10-04): they are logged and left for the facilitator's hand.
  const fired = [];
  for (const item of def.items) {
    if (!item.delay_s) fired.push(this.fireFault(item.fault_code, item.sector, { source: `preset:${id}` }));
    else this.log.write('fault_auto_trigger_dropped', { fault: item.fault_code, sector: item.sector, source: `preset:${id}`, delay_s: item.delay_s, reason: 'faults_are_manual' });
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
  this.state.timeline = items.map((it, i) => {
    const item = {
      id: `${roundId}-${String(i + 1).padStart(2, '0')}`,
      round: roundId,
      offset_s: Number(it.offset_s || 0),
      kind: it.kind,
      fault_code: it.fault_code || null,
      sector: it.sector || null,
      event_id: it.event_id || null,
      text: it.text || null,
      // an alert beat's body and weight (2026-10-05): the round broadcasts
      subtitle: it.subtitle || null,
      major: !!it.major,
      value: it.value ?? null,
      note: it.note || null,
      mode: it.mode === 'AUTO' ? 'AUTO' : 'MANUAL',
      status: 'PENDING',
      fired_at: null,
    };
    holdTransitionBeat.call(this, item, { by: 'arm' });
    return item;
  });
}

/**
 * QUIET TRANSITION (2026-10-06). An alert or an announcement at 00:00 is the
 * round transition's own broadcast, and NEXT ROUND and START play nothing:
 * no overlay, no banner, no ticker line, no sound in the room. Whatever the
 * scenario says, such a beat is held MANUAL and READY the moment the round
 * is armed — "now" is its offset — so the facilitator can FIRE it as a
 * separate press if the runbook wants it, and silently: the READY chime
 * that other manual beats earn would itself be a sound caused by nothing
 * but the transition. Beats later in the round are untouched: a scenario
 * that announces something at 03:00 still announces it at 03:00.
 */
function isTransitionBeat(item) {
  return (item.kind === 'alert' || item.kind === 'announce') && Number(item.offset_s) === 0;
}

function holdTransitionBeat(item, { by = 'arm' } = {}) {
  if (!isTransitionBeat(item) || item.status === 'FIRED' || item.status === 'SKIPPED') return false;
  if (item.mode === 'AUTO') {
    this.log.write('transition_broadcast_held', { id: item.id, round: item.round, kind: item.kind, text: item.text, scenario_mode: 'AUTO', by });
  }
  item.mode = 'MANUAL';
  item.transition = true;
  item.status = 'READY';
  return true;
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
    // MANUAL FAULTS (2026-10-04): a fault beat is never AUTO. It becomes READY
    // and waits for the facilitator's press, whatever the scenario says.
    // A snapshot from before the quiet transition (2026-10-06) may still
    // carry an AUTO broadcast at 00:00: it is held here, without the chime.
    if (holdTransitionBeat.call(this, item, { by: 'tick' })) { this.touch(); continue; }
    if (item.mode === 'AUTO' && item.kind !== 'fault') this.fireTimelineItem(item.id, { by: 'auto' });
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
    case 'alert':    this.setAlert({ title: item.text, subtitle: item.subtitle || '', full_s: item.major ? MAJOR_ALERT_S : null }); break;
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
  callCouncil, endCouncil, tickCouncil, councilLength, councilRemaining, councilClockReady, councilExpire,
  startRollingBlackout, rotateBlackout, tickBlackout, endRollingBlackout,
  eventDef, resolveTargets, fireEvent,
  schedule, cancelScheduled, tickScheduled, firePreset,
  armTimeline, roundElapsed, tickTimeline, fireTimelineItem, skipTimelineItem, delayTimelineItem,
};
