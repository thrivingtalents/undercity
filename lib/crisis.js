'use strict';
/**
 * Crisis systems, mixed into GameState (spec §28–§37):
 *
 *   council            CALL COUNCIL → 5:00 on every screen → order or no order
 *   continuity order   ranking 1–6; ranks 5 and 6 go BROWNOUT; irreversible
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

function callCouncil() {
  const c = this.state.council;
  c.active = true;
  c.started_at = new Date().toISOString();
  c.ended_at = null;
  c.order = null;
  c.order_at = null;
  c.no_order = false;
  c.warned_30 = false;   // every sitting gets its own 30-second warning
  c.count += 1;
  this.state.mode = 'COUNCIL';
  this.state.council_clock = { running: true, remaining_s: Number(this.cfg.council_clock_s) };
  this.ticker('council', 'COUNCIL SUMMONED — CHIEFS + LIAISONS REPORT');
  this.log.write('council_called', { count: c.count, round: this.state.round });
  this.log.write('mode', { mode: 'COUNCIL' });
  this.sting('council');
  this.touch();
  return true;
}

function endCouncil(reason = 'ended') {
  const c = this.state.council;
  if (!c.active) return false;
  c.active = false;
  c.ended_at = new Date().toISOString();
  this.state.council_clock.running = false;
  if (this.state.mode === 'COUNCIL') this.state.mode = 'PLAY';
  const used = Number(this.cfg.council_clock_s) - this.state.council_clock.remaining_s;
  this.ticker('council', 'COUNCIL ENDED');
  this.log.write('council_ended', {
    reason, order_submitted: !!c.order, time_used_s: Math.round(used), count: c.count,
  });
  this.log.write('mode', { mode: this.state.mode });
  this.touch();
  return true;
}

/** Runs inside tick() while the council is active. */
function tickCouncil() {
  const c = this.state.council;
  const clk = this.state.council_clock;
  if (clk.remaining_s <= 30 && clk.remaining_s > 0 && !c.warned_30) {
    c.warned_30 = true;
    this.sting('warning_30');
  }
  if (clk.remaining_s > 0) return;
  if (c.order || c.no_order) return;

  c.no_order = true;
  c.warned_30 = false;
  clk.running = false;
  this.ticker('council', 'NO CONTINUITY ORDER RECEIVED');
  this.log.write('council_no_order', { count: c.count });
  this.sting('critical');
  if (this.cfg.auto_blackout_on_no_order) this.startRollingBlackout({ by: 'auto' });
  this.touch();
}

/**
 * The Council's ranking. Requires all six sectors exactly once. Ranks 5 and 6
 * enter BROWNOUT. Confirmation is the client's job (spec §32) — the server
 * only refuses a malformed order.
 */
function submitContinuityOrder(order, { by = 'facilitator' } = {}) {
  const codes = Object.keys(this.state.sectors);
  const list = Array.isArray(order) ? order.map((c) => String(c).toUpperCase()) : [];
  const unique = new Set(list);
  if (list.length !== codes.length || unique.size !== codes.length || !codes.every((c) => unique.has(c))) {
    return { ok: false, reason: 'order_incomplete' };
  }

  const now = new Date().toISOString();
  const c = this.state.council;
  const record = {
    id: this.id('CO'), order: list, t: now, by,
    round: this.state.round, council_count: c.count,
    time_used_s: c.active
      ? Math.round(Number(this.cfg.council_clock_s) - this.state.council_clock.remaining_s)
      : null,
    brownout: list.slice(-2),
  };
  this.state.continuity_order = record;
  c.order = list;
  c.order_at = now;
  c.no_order = false;

  for (const code of record.brownout) this.setStatus(code, 'BROWNOUT', { by: 'order' });

  this.ticker('order', `CONTINUITY ORDER ACCEPTED — ${list.join(' › ')}`);
  this.announce(`Continuity Order accepted. ${record.brownout.join(' and ')} enter brownout.`);
  this.setAlert({ title: 'CONTINUITY ORDER ACCEPTED', subtitle: `${record.brownout.join(' · ')} — BROWNOUT` });
  this.log.write('continuity_order', record);
  if (c.active) this.endCouncil('order submitted');
  this.touch();
  return { ok: true, order: record };
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
    if (eff.cycles !== undefined) e.cycles_remaining = Number(eff.cycles);
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
  return this.roundConfig().length_s - this.state.round_clock.remaining_s;
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
  startRollingBlackout, rotateBlackout, tickBlackout, endRollingBlackout,
  eventDef, resolveTargets, fireEvent,
  schedule, cancelScheduled, tickScheduled, firePreset,
  armTimeline, roundElapsed, tickTimeline, fireTimelineItem, skipTimelineItem, delayTimelineItem,
};
