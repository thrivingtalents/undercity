'use strict';
/**
 * FALSE TELEMETRY / PHANTOM FAULTS (FALSE_TELEMETRY_V1, 2026-10-06; one-round
 * lifetime since the same day's revision), mixed into GameState.
 *
 * The facilitator fires an alert at a sector that LOOKS like a fault — a code,
 * a name, a symptom, a severity, a displayed decay rate — and is not one. It
 * lives here, in state.false_alerts, and never in a sector's `faults`, which
 * is the collection the tick decays, the console repairs and the rewards pay.
 * So nothing bleeds, nothing is consumed, nothing can be repaired, nothing is
 * paid, and nothing about it is ever "resolved". The target's console shows it
 * in ACTIVE FAULTS in exactly a real fault's shape (lib/visibility.js appends
 * the projection to the same list), a guessed code gets the existing NO
 * MATCHING PROCEDURE answer with nothing counted (lib/resolve.js), and the
 * room hears what it hears for any fault: a feed line and a sting.
 *
 * Only COM is told. While its telemetry is up, COM's CITY INTELLIGENCE file
 * carries a private TELEMETRY ANOMALY card — FALSE POSITIVE CONFIRMED — and
 * COM answers it with PUBLISH CORRECTION on the existing City Broadcast: the
 * same editor, the same wall, the same CITY ANNOUNCEMENT UPDATED nudge, plus
 * the alert's id as hidden metadata on the broadcast. Publishing is
 * communication only: it tells the city, it does not withdraw the alert.
 *
 * A PHANTOM LIVES FOR ONE ROUND. It stays on the target's console, published
 * or not, until the round it was fired in ends — the existing round
 * transition (cycleRefresh, the beat where every "this round" effect ends),
 * never a clock of its own. At that beat it is marked EXPIRED_AT_ROUND_END,
 * leaves the target's list and COM's file, and the broadcast that answered it
 * (found by metadata, never by its words) is cleared from the wall; an
 * unrelated broadcast stays. The admin's CANCEL (quiet) and FORCE CLEAR (with
 * a notice) are recovery controls, not part of normal play.
 *
 * Statuses: ACTIVE_UNVERIFIED → ACTIVE_COM_VERIFIED → ACTIVE_CITY_NOTIFIED →
 * EXPIRED_AT_ROUND_END (from any of the three), or ADMIN_CANCELLED /
 * ADMIN_FORCE_CLEARED. Everything here is `this`-bound onto GameState.prototype.
 */
const TEMPLATES = require('./false-telemetry.json');

const LIVE = new Set(['ACTIVE_UNVERIFIED', 'ACTIVE_COM_VERIFIED', 'ACTIVE_CITY_NOTIFIED']);
const SEVERITIES = new Set([1, 2, 3]);
const HISTORY_MAX = 40;
const REWARD_WORD = { power: 'POWER', water: 'WATER', parts: 'PARTS', med: 'MEDICAL' };
const WARN_COM_BLIND = 'COM telemetry is currently unavailable. The false alert may not be verifiable until COM telemetry is restored.';
/** The admin's words for each status. */
const STATUS_WORD = {
  ACTIVE_UNVERIFIED: 'ACTIVE - WAITING FOR COM',
  ACTIVE_COM_VERIFIED: 'ACTIVE - COM VERIFIED',
  ACTIVE_CITY_NOTIFIED: 'ACTIVE - CITY NOTIFIED',
  EXPIRED_AT_ROUND_END: 'EXPIRED',
  ADMIN_CANCELLED: 'CANCELLED',
  ADMIN_FORCE_CLEARED: 'FORCE CLEARED',
};

const defaultHeadline = (code) => `TELEMETRY CORRECTION - ${code}`;
const defaultMessage = (sector, code) => `${sector} alert ${code} has been verified as false telemetry. No repair action is required. Resume normal operations.`;
/** The target's notice once COM has published: the alert stays, the repair does not. */
const CORRECTION_NOTICE = 'COM has issued a telemetry correction. No repair action is required. Alert remains logged until the end of the round.';
const forceClearNotice = (code) => `ALERT WITHDRAWN — ${code} has been cleared from your console by the Continuity Authority. No repair action is required.`;
const secondsBetween = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));

// -- the templates, checked once at load -------------------------------------------
function check(cond, msg) { if (!cond) throw new Error(`lib/false-telemetry.json: ${msg}`); }
check(Array.isArray(TEMPLATES.templates) && TEMPLATES.templates.length > 0, 'templates must be a non-empty list');
const byCode = new Map();
for (const t of TEMPLATES.templates) {
  check(/^F-7\d\d$/.test(String(t.code)), `${t.code}: a template code is F-7xx`);
  check(!byCode.has(t.code), `${t.code} is listed twice`);
  check(/^[A-Z]{3}$/.test(String(t.sector)), `${t.code}: sector`);
  check(typeof t.name === 'string' && t.name.trim() && typeof t.description === 'string' && t.description.trim(), `${t.code}: name and description`);
  check(SEVERITIES.has(Number(t.default_severity)), `${t.code}: default_severity`);
  check(Number(t.default_display_decay_rate) >= 0, `${t.code}: default_display_decay_rate`);
  if (t.display_reward) check(t.display_reward.type === 'RESOURCE' && REWARD_WORD[t.display_reward.resource], `${t.code}: display_reward`);
  byCode.set(t.code, t);
}

/** The REPAIR REWARD line the card prints — the engine's own words for a resource reward, never paid. */
function displayRewardView(r) {
  if (!r) return null;
  const text = `+${Number(r.amount) || 1} ${REWARD_WORD[r.resource]}`;
  return { type: r.type, resource: r.resource, amount: Number(r.amount) || 1, token: null, text, label: 'REPAIR REWARD', display: `REPAIR REWARD: ${text}`, banner: text, claimed: false, result_text: null };
}

// -- the mixin ----------------------------------------------------------------------

function falseTelemetryTemplates() { return TEMPLATES.templates.map((t) => ({ ...t })); }

/** The run's alerts, given their shape — a snapshot from before 2026-10-06 has none. */
function falseTelemetryState() {
  if (!Array.isArray(this.state.false_alerts)) this.state.false_alerts = [];
  return this.state.false_alerts;
}

function falseAlertsLive() { return this.falseTelemetryState().filter((a) => LIVE.has(a.status)); }

function falseAlertById(id) { return this.falseTelemetryState().find((a) => a.id === id) || null; }

/** The live alert a sector's console is showing under this code, if any. */
function findFalseAlert(sectorCode, faultCode) {
  return this.falseAlertsLive().find((a) => a.target_sector === sectorCode && a.fault_code === faultCode) || null;
}

/** The live alerts on one sector, oldest first — in the order a console lists faults. */
function phantomFaultsFor(sectorCode) {
  return this.falseAlertsLive().filter((a) => a.target_sector === sectorCode)
    .sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at));
}

/**
 * FIRE. The admin's press: a template aimed at a sector, with the severity and
 * the displayed decay rate the card will show. Refused for an unknown sector
 * or template, a code a real fault carries, a code already live, and — unless
 * the admin overrides the warning — while COM's telemetry is down, since COM
 * could not then be told.
 */
function fireFalseAlert({ sector, template, severity, decay, notes } = {}, { by = 'facilitator', override = false } = {}) {
  const target = String(sector || '').toUpperCase();
  if (!this.state.sectors[target]) return { ok: false, reason: 'unknown_sector', sector };
  const tpl = byCode.get(String(template || '').toUpperCase());
  if (!tpl) return { ok: false, reason: 'unknown_template', template };
  if (this.faultsByCode.has(tpl.code)) return { ok: false, reason: 'code_collides_with_real_fault', code: tpl.code };
  if (this.falseAlertsLive().some((a) => a.fault_code === tpl.code)) return { ok: false, reason: 'already_active', code: tpl.code };
  const blind = this.comBlind();
  if (blind && !override) return { ok: false, reason: 'com_telemetry_unavailable', warn: WARN_COM_BLIND, code: tpl.code, sector: target };

  const sev = SEVERITIES.has(Number(severity)) ? Number(severity) : Number(tpl.default_severity);
  const rate = Number.isFinite(Number(decay)) && Number(decay) >= 0 ? Number(decay) : Number(tpl.default_display_decay_rate);
  const now = new Date().toISOString();
  const alert = {
    // The instance id wears a real fault's prefix: it reaches the target's frame, and a prefix is a tell.
    id: this.id('F'),
    fault_code: tpl.code, template: tpl.code, target_sector: target,
    name: tpl.name, description: tpl.description,
    display_severity: sev, display_decay_rate: rate, actual_decay_rate: 0,
    display_reward: tpl.display_reward ? { ...tpl.display_reward } : null,
    created_at: now, created_round: this.state.round, created_by: by,
    admin_notes: notes ? String(notes).slice(0, 200) : null,
    status: 'ACTIVE_UNVERIFIED', com_verification_status: 'PENDING', com_notified_at: null,
    target_opened_at: null, first_repair_attempt_at: null, repair_attempts: 0,
    prepared_at: null, com_published_at: null, correction: null,
    resolved_at: null, resolution: null, round_ended: null, com_published_before_expiry: null,
    com_telemetry_blind_at_fire: blind,
  };
  const list = this.falseTelemetryState();
  list.unshift(alert);
  // keep the file bounded: the oldest ENDED entries go first, live ones never
  while (list.length > HISTORY_MAX) {
    const i = list.map((a) => LIVE.has(a.status)).lastIndexOf(false);
    if (i < 0) break;
    list.splice(i, 1);
  }
  // THE ROOM: exactly what a real fault does on arrival — the feed line and the sting.
  this.ticker('fault', `${target} fault detected: ${tpl.code}`);
  this.sting(sev >= 3 ? 'critical' : 'fault_alert');
  this.log.write('false_alert_fired', {
    false_alert_id: alert.id, fault_code: tpl.code, target_sector: target, round: this.state.round,
    display_severity: sev, display_decay_rate: rate, actual_decay_rate: 0, by, override: !!override,
    com_telemetry_blind: blind, notes: alert.admin_notes, expires: 'ROUND_END',
  });
  this.falseTelemetryTick();   // COM is told at once when its telemetry is up
  this.touch();
  return { ok: true, alert: { ...alert } };
}

/** Every tick: an alert COM has not yet been told about is disclosed the moment COM's telemetry is up. */
function falseTelemetryTick() {
  const waiting = this.falseAlertsLive().filter((a) => !a.com_notified_at);
  if (!waiting.length || this.comBlind()) return;
  const now = new Date().toISOString();
  for (const a of waiting) {
    a.com_notified_at = now;
    a.com_verification_status = 'FALSE_POSITIVE_CONFIRMED';
    if (a.status === 'ACTIVE_UNVERIFIED') a.status = 'ACTIVE_COM_VERIFIED';
    this.log.write('false_alert_com_notified', {
      false_alert_id: a.id, fault_code: a.fault_code, target_sector: a.target_sector, seconds_since_fired: secondsBetween(a.created_at, now),
    });
  }
  this.touch();
}

/** The target opened the card (the same intent a real fault's open uses). */
function falseAlertOpened(sectorCode, faultCode) {
  const a = this.findFalseAlert(sectorCode, faultCode);
  if (!a) return false;
  if (!a.target_opened_at) {
    a.target_opened_at = new Date().toISOString();
    this.ticker('open', `${sectorCode} opened ${faultCode}`, { scope: 'admin' });
    this.log.write('false_alert_opened', { false_alert_id: a.id, fault_code: faultCode, target_sector: sectorCode, seconds_since_fired: secondsBetween(a.created_at, a.target_opened_at) });
    this.touch();
  }
  return true;
}

/** The target typed a code at it. Counted here, for the debrief — never on the card, never towards a lockout. */
function falseAlertRepairAttempt(sectorCode, faultCode, submitted) {
  const a = this.findFalseAlert(sectorCode, faultCode);
  if (!a) return null;
  const now = new Date().toISOString();
  a.repair_attempts += 1;
  if (!a.first_repair_attempt_at) a.first_repair_attempt_at = now;
  this.log.write('false_alert_repair_attempt', {
    false_alert_id: a.id, fault_code: faultCode, target_sector: sectorCode, attempt: a.repair_attempts,
    code_entered: String(submitted || '').slice(0, 40), seconds_since_fired: secondsBetween(a.created_at, now),
    after_com_published: !!a.com_published_at,
  });
  this.touch();
  return a;
}

/**
 * PREPARE CORRECTION. COM's press on the private card: the moment is noted
 * and the existing broadcast editor is handed a headline and a message to
 * edit. Refused while COM's telemetry is down or before COM has been told.
 */
function falseAlertPrepare(id, { by = 'COM' } = {}) {
  if (by !== 'COM' && by !== 'facilitator') return { ok: false, reason: 'com_only', actor: by };
  const a = this.falseAlertById(id);
  if (!a || !LIVE.has(a.status)) return { ok: false, reason: 'unknown_false_alert', id };
  if (by === 'COM' && (this.comBlind() || !a.com_notified_at)) return { ok: false, reason: 'com_telemetry_unavailable', id };
  const now = new Date().toISOString();
  if (!a.prepared_at) {
    a.prepared_at = now;
    this.log.write('false_alert_correction_prepared', { false_alert_id: a.id, fault_code: a.fault_code, target_sector: a.target_sector, by, seconds_since_fired: secondsBetween(a.created_at, now) });
    this.touch();
  }
  return {
    ok: true, id: a.id, fault_code: a.fault_code, target_sector: a.target_sector,
    headline: defaultHeadline(a.fault_code), message: defaultMessage(a.target_sector, a.fault_code),
  };
}

/**
 * CITY NOTIFIED. COM's PUBLISH CORRECTION (setBroadcastAnnouncement hands the
 * alert id through). Communication only: the wall carries the words, the
 * target's console gets a notice, and the alert stays exactly where it is
 * until the round ends. Nothing real moves — there was never anything real.
 */
function falseAlertCityNotified(id, { by = 'COM', announcement = null } = {}) {
  const a = this.falseAlertById(id);
  if (!a) return { ok: false, reason: 'unknown_false_alert', id };
  if (!LIVE.has(a.status)) return { ok: false, reason: 'false_alert_closed', id, status: a.status };
  const now = new Date().toISOString();
  const first = !a.com_published_at;
  a.status = 'ACTIVE_CITY_NOTIFIED';
  if (first) a.com_published_at = now;
  a.correction = announcement ? { headline: announcement.headline, message: announcement.message } : a.correction;
  a.corrected_by = by;
  if (first) {
    this.announce(CORRECTION_NOTICE, { sector: a.target_sector });
    // the notice is tagged with the alert it is about (an opaque id, no word), so the round's end can take it down with the alert
    const n = this.state.announcements[0];
    if (n && n.sector === a.target_sector && n.text === CORRECTION_NOTICE) n.about = a.id;
  }
  this.ticker('event', `${a.target_sector} ${a.fault_code}: COM published the telemetry correction — the alert stays until the round ends`, { scope: 'admin' });
  this.log.write('false_alert_correction_published', {
    false_alert_id: a.id, fault_code: a.fault_code, target_sector: a.target_sector, by, first,
    seconds_since_fired: secondsBetween(a.created_at, now),
    seconds_from_com_notified: a.com_notified_at ? secondsBetween(a.com_notified_at, now) : null,
    seconds_from_prepared: a.prepared_at ? secondsBetween(a.prepared_at, now) : null,
    target_opened: !!a.target_opened_at, repair_attempts: a.repair_attempts, announcement: a.correction,
  });
  this.touch();
  return { ok: true, id: a.id, fault_code: a.fault_code, target_sector: a.target_sector, status: a.status, alert_remains: true };
}

/** The broadcast that answered this alert, if it is the one on the wall right now — by metadata, never by its words. */
function clearLinkedBroadcast(game, a, reason) {
  const b = game.state.broadcast && game.state.broadcast.announcement;
  if (!b || b.correction_for !== a.id) return false;
  const previous = { ...b };
  b.headline = '';
  b.message = '';
  b.round = null;
  b.correction_for = null;
  game.log.write('false_alert_broadcast_cleared', { false_alert_id: a.id, fault_code: a.fault_code, target_sector: a.target_sector, reason, previous });
  return true;
}

/**
 * ROUND END. Called from cycleRefresh, the beat where every "this round"
 * effect ends: every live alert fired in a round that has just ended is
 * marked EXPIRED_AT_ROUND_END, leaves the target's console and COM's file,
 * and takes the broadcast that answered it off the wall. A restart of the
 * same round is not an end, and a real fault is not touched.
 */
function falseTelemetryRoundEnd() {
  const ended = this.falseAlertsLive().filter((a) => a.created_round !== this.state.round);
  if (!ended.length) return 0;
  const now = new Date().toISOString();
  for (const a of ended) {
    a.status = 'EXPIRED_AT_ROUND_END';
    a.resolved_at = now;
    a.resolution = 'EXPIRED_AT_ROUND_END';
    a.round_ended = a.created_round;
    a.com_published_before_expiry = a.com_published_at ? 'YES' : 'NO';
    const cleared = clearLinkedBroadcast(this, a, 'round_end');
    // the target's notice about the alert goes with it: nothing about last round's phantom lingers on any screen
    this.state.announcements = this.state.announcements.filter((n) => n.about !== a.id);
    this.ticker('event', `${a.target_sector} ${a.fault_code} expired with the round${cleared ? ' — its correction left the wall' : ''}`, { scope: 'admin' });
    this.log.write('false_alert_expired', {
      false_alert_id: a.id, fault_code: a.fault_code, target_sector: a.target_sector, round_ended: a.created_round, next_round: this.state.round,
      seconds_live: secondsBetween(a.created_at, now), com_published_before_expiry: a.com_published_before_expiry,
      time_until_com_broadcast_s: a.com_published_at ? secondsBetween(a.created_at, a.com_published_at) : null,
      target_opened: !!a.target_opened_at, repair_attempts: a.repair_attempts, broadcast_cleared: cleared,
    });
  }
  this.touch();
  return ended.length;
}

/** FORCE CLEAR. A recovery control, not play: the alert goes now, with a notice, and its broadcast with it. */
function falseAlertForceClear(id, { by = 'facilitator' } = {}) {
  const a = this.falseAlertById(id);
  if (!a) return { ok: false, reason: 'unknown_false_alert', id };
  if (!LIVE.has(a.status)) return { ok: false, reason: 'false_alert_closed', id, status: a.status };
  const now = new Date().toISOString();
  a.status = 'ADMIN_FORCE_CLEARED';
  a.resolved_at = now;
  a.resolution = 'ADMIN_FORCE_CLEARED';
  a.cleared_by = by;
  a.com_published_before_expiry = a.com_published_at ? 'YES' : 'NO';
  const cleared = clearLinkedBroadcast(this, a, 'force_clear');
  this.announce(forceClearNotice(a.fault_code), { sector: a.target_sector });
  this.ticker('event', `${a.target_sector} ${a.fault_code} force-cleared by the facilitator`, { scope: 'admin' });
  this.log.write('false_alert_force_cleared', {
    false_alert_id: a.id, fault_code: a.fault_code, target_sector: a.target_sector, by,
    seconds_live: secondsBetween(a.created_at, now), com_published_before_expiry: a.com_published_before_expiry,
    target_opened: !!a.target_opened_at, repair_attempts: a.repair_attempts, broadcast_cleared: cleared,
  });
  this.touch();
  return { ok: true, id: a.id, fault_code: a.fault_code, target_sector: a.target_sector, status: a.status, resolution: a.resolution };
}

/** CANCEL. The admin takes it back quietly: it leaves the target's list, its broadcast goes if it was up, and nobody is told anything. */
function falseAlertCancel(id, { by = 'facilitator' } = {}) {
  const a = this.falseAlertById(id);
  if (!a) return { ok: false, reason: 'unknown_false_alert', id };
  if (!LIVE.has(a.status)) return { ok: false, reason: 'false_alert_closed', id, status: a.status };
  const now = new Date().toISOString();
  a.status = 'ADMIN_CANCELLED';
  a.resolved_at = now;
  a.resolution = 'ADMIN_CANCELLED';
  a.cancelled_by = by;
  a.com_published_before_expiry = a.com_published_at ? 'YES' : 'NO';
  const cleared = clearLinkedBroadcast(this, a, 'cancel');
  this.ticker('event', `FALSE TELEMETRY ${a.fault_code} ON ${a.target_sector} CANCELLED`, { scope: 'admin' });
  this.log.write('false_alert_cancelled', {
    false_alert_id: a.id, fault_code: a.fault_code, target_sector: a.target_sector, by,
    seconds_since_fired: secondsBetween(a.created_at, now), target_opened: !!a.target_opened_at, repair_attempts: a.repair_attempts, broadcast_cleared: cleared,
  });
  this.touch();
  return { ok: true, id: a.id, fault_code: a.fault_code, target_sector: a.target_sector, status: a.status };
}

// -- projections --------------------------------------------------------------------

/**
 * What the target's console gets: a real fault's projection, key for key
 * (ownFault plus materials_ready), and not one field more. Nothing in it says
 * what it is, and it never reads RESOLVED or REPAIRED.
 */
function phantomFaultView(a) {
  return {
    id: a.id,
    code: a.fault_code,
    name: a.name,
    flavour: a.description,
    severity: a.display_severity,
    decay_per_min: a.display_decay_rate,
    attempts: 0,
    wrong_code_attempts: 0,
    locked_until_s: 0,
    status: 'ACTIVE',
    fired_at: a.created_at,
    opened_at: a.target_opened_at,
    resolved: false,
    resolved_at: null,
    reward: displayRewardView(a.display_reward),
    reward_claimed: false,
    armed: [],
    second_chance_available: false,
    stabilised: false,
    paused: false,
    triggered_by: null,
    time_critical: false,
    materials_ready: true,
  };
}

/** What COM's live city feed shows for the target: the same line as any fault there. */
function phantomComFault(a) {
  return { code: a.fault_code, name: a.name, severity: a.display_severity, resolved: false };
}

/** A candidate for the wall's worst-fault line: code, name, severity, when it arrived. */
function phantomWorstCandidate(a) {
  return { code: a.fault_code, name: a.name, severity: a.display_severity, fired_at: a.created_at, resolved: false };
}

/**
 * COM's private cards: every live alert COM has been told about, while COM's
 * telemetry is up. A card reads CITY NOTIFIED once COM has published and
 * leaves the file with the round, when the alert expires.
 */
function falseAlertAnomaliesForCom() {
  if (this.comBlind()) return [];
  return this.falseAlertsLive()
    .filter((a) => a.com_notified_at)
    .sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at))
    .map((a) => ({
      id: a.id,
      title: 'TELEMETRY ANOMALY',
      affected_sector: a.target_sector,
      fault_code: a.fault_code,
      fault_name: a.name,
      verification_result: 'FALSE POSITIVE CONFIRMED',
      detected_at: a.com_notified_at,
      instruction: 'Publish a city correction. No physical repair is required.',
      publication_status: a.status === 'ACTIVE_CITY_NOTIFIED' ? 'CITY NOTIFIED' : a.prepared_at ? 'CORRECTION PREPARED' : 'UNPUBLISHED',
      prepared: !!a.prepared_at,
      published_at: a.com_published_at,
      expires: 'ROUND_END',
    }));
}

/** The facilitator's monitor: the templates, COM's telemetry state, every alert with what the room did about it. */
function falseTelemetryView() {
  const now = Date.now();
  const stamp = (r) => Date.parse(r.created_at || r.requested_at || 0);
  const requestsDuring = (a) => (this.state.requests || []).filter((r) => r.requester === a.target_sector
    && stamp(r) >= Date.parse(a.created_at) && (!a.resolved_at || stamp(r) <= Date.parse(a.resolved_at))).length;
  const com = this.state.sectors.COM;
  return {
    version: TEMPLATES.version,
    templates: this.falseTelemetryTemplates(),
    com_blind: this.comBlind(),
    com_status: com ? com.status : null,
    warn_com_blind: WARN_COM_BLIND,
    alerts: this.falseTelemetryState().map((a) => ({
      ...a,
      live: LIVE.has(a.status),
      status_word: STATUS_WORD[a.status] || a.status,
      expires: LIVE.has(a.status) ? 'ROUND_END' : null,
      elapsed_s: Math.max(0, Math.round(((a.resolved_at ? Date.parse(a.resolved_at) : now) - Date.parse(a.created_at)) / 1000)),
      com_notified: !!a.com_notified_at,
      com_published: !!a.com_published_at,
      target_opened: !!a.target_opened_at,
      target_attempted: a.repair_attempts > 0,
      related_requests: requestsDuring(a),
    })),
  };
}

module.exports = {
  falseTelemetryTemplates, falseTelemetryState, falseAlertsLive, falseAlertById, findFalseAlert, phantomFaultsFor,
  fireFalseAlert, falseTelemetryTick, falseAlertOpened, falseAlertRepairAttempt, falseAlertPrepare,
  falseAlertCityNotified, falseTelemetryRoundEnd, falseAlertForceClear, falseAlertCancel,
  phantomFaultView, phantomComFault, phantomWorstCandidate, falseAlertAnomaliesForCom, falseTelemetryView,
};
