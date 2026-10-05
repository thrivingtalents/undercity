'use strict';
/**
 * FALSE TELEMETRY / PHANTOM FAULTS (FALSE_TELEMETRY_V1, 2026-10-06; one-round
 * lifetime since the same day's revision).
 *
 * A phantom alert looks like a fault to the room and is not one: it lives in
 * state.false_alerts, never in a sector's faults, so nothing decays, nothing
 * is consumed, nothing can be repaired and nothing is paid. Only COM is told,
 * privately; COM answers with PUBLISH CORRECTION on the existing City
 * Broadcast, which informs the city and withdraws nothing. The alert stays on
 * the target's console until the round it was fired in ends, when it expires
 * on the existing round transition and its broadcast leaves the wall.
 *
 * FT-001 … FT-012 are the first specification's acceptance tests; RE-001 …
 * RE-010 the revision's; the rest hold the edges.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { newGame, loadContent, logEvents } = require('./helpers');
const { forSector, forControl, forBigscreen } = require('../lib/visibility');
const { submitCode } = require('../lib/resolve');
const { analyse } = require('../lib/analytics');
const TEMPLATES = require('../lib/false-telemetry.json');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SECTOR_JS = read('public/sector/sector.js');
const CONTROL_JS = read('public/control/control.js');
const CONTROL_HTML = read('public/control/index.html');
const SERVER_JS = read('server.js');

const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const ALL = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'];
const content = loadContent();

/** A run in the given round, clock running, every table stocked. */
function live(round = 'R4') {
  const g = newGame();
  g.setPhase(`ROUND_${round.slice(1)}`);
  g.clock('start'); g.tick(1000);
  stock(g);
  return g;
}
const stock = (g) => { for (const s of SECTORS) g.setInventory(s, { power: 9, water: 9, parts: 9, med: 9 }); };
/** NEXT ROUND: the existing round transition, which ends the current round. */
function endRound(g) {
  stock(g);
  const next = ALL[ALL.indexOf(g.state.round) + 1];
  const res = g.activateRound(next);
  assert.equal(res.ok, true, JSON.stringify(res));
  return next;
}
const fire = (g, sector = 'AGR', template = 'F-705', extra = {}, opts = {}) => g.fireFalseAlert({ sector, template, ...extra }, { by: 'facilitator', ...opts });
const ownFaults = (g, s) => forSector(g, s).sectors[s].faults;
const phantom = (g, s, code) => ownFaults(g, s).find((f) => f.code === code);
const health = (g, s) => g.state.sectors[s].integrity;
const alertOf = (g) => g.state.false_alerts[0];
const comCards = (g) => forSector(g, 'COM').intel.anomalies;
const wallAnnouncement = (g) => forBigscreen(g).broadcast.announcement;
const notice = (g, s) => (forSector(g, s).announcements.find((a) => a.sector === s) || {}).text || '';
/** COM prepares and publishes the correction for the one live alert. */
function publishCorrection(g, words = {}) {
  const id = alertOf(g).id;
  const prep = g.falseAlertPrepare(id, { by: 'COM' });
  assert.equal(prep.ok, true, JSON.stringify(prep));
  const pub = g.setBroadcastAnnouncement({ headline: words.headline || prep.headline, message: words.message || prep.message, correction_for: id }, { by: 'COM' });
  assert.equal(pub.ok, true, JSON.stringify(pub));
  return { id, prep, pub };
}
/** Everything real about the city, for before/after comparisons. */
function realState(g) {
  return JSON.parse(JSON.stringify({
    sectors: Object.fromEntries(Object.entries(g.state.sectors).map(([c, s]) => [c, {
      integrity: s.integrity, status: s.status, inventory: s.inventory, workforce: s.workforce, upkeep: s.upkeep_per_round, production: s.production,
      generator: s.generator, faults: s.faults, opportunities: s.opportunities,
    }])),
    effects: g.state.effects, trn: g.trnCapacity(), med: g.medCapacity(), used: [g.stampsUsed(), g.medHealsUsed()],
    agr: g.state.agr, healing: g.state.healing, transfers: g.state.transfers, requests: g.state.requests, rewards_claimed: g.state.rewards_claimed,
  }));
}
const FORBIDDEN = /fake|false[ _-]?positive|phantom|telemetry ghost|simulation probe|admin[ _-]generated|actual[ _-]decay|verification|false[ _-]alert|false telemetry/i;

// -- the catalogue ---------------------------------------------------------------------------------

test('the six templates sit in an unused F-7xx range, one per sector, and collide with no real fault', () => {
  assert.equal(TEMPLATES.templates.length, 6);
  assert.deepEqual(TEMPLATES.templates.map((t) => t.code), ['F-701', 'F-702', 'F-703', 'F-704', 'F-705', 'F-706']);
  assert.deepEqual(TEMPLATES.templates.map((t) => t.sector), SECTORS);
  const real = new Set(content.faults.faults.map((f) => f.code));
  for (const t of TEMPLATES.templates) {
    assert.ok(!real.has(t.code), `${t.code} is a real fault`);
    assert.ok(t.name && t.description && [1, 2, 3].includes(t.default_severity) && t.default_display_decay_rate >= 0, t.code);
  }
  assert.ok(!content.faults.faults.some((f) => /^F-7\d\d$/.test(f.code)), 'a real fault already uses F-7xx');
  const g = live();
  assert.equal(fire(g, 'AGR', 'F-999').reason, 'unknown_template');
  assert.equal(fire(g, 'XXX', 'F-705').reason, 'unknown_sector');
});

// -- FT-001 … FT-004: the target's experience --------------------------------------------------------

test('FT-001: the admin fires F-705 at AGR — AGR sees it in ACTIVE FAULTS, in a real fault\'s shape, with no sign that it is false', () => {
  const g = live();
  const res = fire(g);
  assert.equal(res.ok, true, JSON.stringify(res));
  const f = phantom(g, 'AGR', 'F-705');
  assert.ok(f, 'AGR does not see F-705');
  assert.equal(f.name, 'Nutrient contamination alert');
  assert.equal(f.flavour, 'Bay 3 nutrient sensors report possible contamination.');
  assert.equal(f.severity, 2);
  assert.equal(f.decay_per_min, 2);
  assert.equal(f.status, 'ACTIVE');
  assert.equal(f.attempts, 0);
  assert.ok(f.reward && f.reward.text, 'the card has no REPAIR REWARD line like every other card');
  g.fireFault('F-209', 'AGR');
  const realOne = phantom(g, 'AGR', 'F-209');
  assert.deepEqual(Object.keys(f).sort(), Object.keys(realOne).sort(), 'the phantom\'s shape differs from a real fault\'s');
  const frame = forSector(g, 'AGR');
  const words = JSON.stringify(frame).replace(/"[a-z_]+":(true|false)/g, '');
  assert.ok(!FORBIDDEN.test(words), 'the target frame carries a tell');
  assert.equal(frame.false_telemetry, undefined);
  assert.equal(frame.false_alerts, undefined);
  assert.ok(!g.state.sectors.AGR.faults.some((x) => x.code === 'F-705'), 'the phantom was written into the sector\'s faults');
  assert.equal(g.state.false_alerts.length, 1);
  assert.equal(alertOf(g).status, 'ACTIVE_COM_VERIFIED');
  assert.ok(forBigscreen(g).feed.some((e) => e.kind === 'fault' && /AGR fault detected: F-705/.test(e.text)));
});

test('FT-002: F-705 stays active for three minutes and AGR loses no Health from it', () => {
  const g = live();
  fire(g);
  const before = health(g, 'AGR');
  g.tick(180000);
  assert.equal(health(g, 'AGR'), before, 'the phantom bled Health');
  assert.ok(phantom(g, 'AGR', 'F-705'), 'the phantom vanished on its own');
  assert.equal(alertOf(g).actual_decay_rate, 0);
});

test('FT-003: no repair procedure exists for F-705 — not in the content, not in any binder, no code to find', () => {
  assert.equal(content.faults.faults.find((f) => f.code === 'F-705'), undefined);
  const g = live();
  assert.ok(!g.faultDefinition('F-705'), 'the engine has a definition for F-705');
  assert.ok(!g.faultsByCode.has('F-705'));
});

test('FT-004: a guessed code gets NO MATCHING PROCEDURE — VERIFY THIS ALERT, and nothing is counted or consumed', () => {
  const g = live();
  fire(g);
  const before = realState(g);
  let res;
  for (let i = 0; i < 5; i += 1) {
    res = submitCode(g, { sector: 'AGR', fault_code: 'F-705', code: `P-0${i}-123`, workers_assigned: 2 });
    assert.equal(res.accepted, false);
    assert.equal(res.reason, 'no_procedure', JSON.stringify(res));
    assert.equal(res.attempts, 0);
    assert.equal(res.locked_until_s, undefined, 'a lockout engaged');
  }
  assert.deepEqual(realState(g), before, 'a submission against the phantom changed something real');
  const f = phantom(g, 'AGR', 'F-705');
  assert.equal(f.attempts, 0);
  assert.equal(f.locked_until_s, 0);
  assert.equal(alertOf(g).repair_attempts, 5);
  assert.ok(alertOf(g).first_repair_attempt_at);
  assert.equal(logEvents(g, 'false_alert_repair_attempt').length, 5);
  assert.ok(/NO MATCHING PROCEDURE — VERIFY THIS ALERT/.test(SECTOR_JS));
  assert.ok(/Stop entering codes\. Log it, tell COM, then work the faults you can repair\./.test(SECTOR_JS));
  assert.equal(submitCode(g, { sector: 'AGR', fault_code: 'F-799', code: 'P-01-000', workers_assigned: 1 }).reason, 'unknown_fault');
});

// -- FT-005 / FT-006: who is told ---------------------------------------------------------------------

test('FT-005: COM receives a private CITY INTELLIGENCE card — AGR F-705, FALSE POSITIVE CONFIRMED', () => {
  const g = live();
  fire(g);
  const com = forSector(g, 'COM');
  const cards = com.intel.anomalies;
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.title, 'TELEMETRY ANOMALY');
  assert.equal(c.affected_sector, 'AGR');
  assert.equal(c.fault_code, 'F-705');
  assert.equal(c.fault_name, 'Nutrient contamination alert');
  assert.equal(c.verification_result, 'FALSE POSITIVE CONFIRMED');
  assert.equal(c.publication_status, 'UNPUBLISHED');
  assert.equal(c.expires, 'ROUND_END');
  assert.ok(c.detected_at);
  assert.ok(com.sectors.AGR.faults.some((f) => f.code === 'F-705' && f.severity === 2));
  assert.equal(logEvents(g, 'false_alert_com_notified').length, 1);
  assert.ok(/intel\.anomalies/.test(SECTOR_JS) && /PREPARE CORRECTION/.test(SECTOR_JS) && /false_alert_prepare/.test(SECTOR_JS));
});

test('FT-006: POW, WTR, MED and TRN receive no private indication that AGR F-705 is false', () => {
  const g = live();
  fire(g);
  for (const s of ['POW', 'WTR', 'MED', 'TRN']) {
    const frame = forSector(g, s);
    assert.equal(frame.intel, undefined, `${s} has an intelligence feed`);
    const publicLines = frame.ticker.filter((e) => /F-705/.test(e.text));
    assert.ok(publicLines.every((e) => e.kind === 'fault' && e.text === 'AGR fault detected: F-705'), `${s}: ${JSON.stringify(publicLines)}`);
    const rest = JSON.stringify({ ...frame, ticker: [] }).replace(/"[a-z_]+":(true|false)/g, '');
    assert.ok(!/FALSE POSITIVE|TELEMETRY ANOMALY|F-705/.test(rest), `${s} was told about F-705`);
  }
  const wall = forBigscreen(g);
  assert.equal(wall.sectors.AGR.unresolved_faults, 1);
  assert.ok(!/FALSE POSITIVE|TELEMETRY ANOMALY/.test(JSON.stringify(wall)));
});

// -- FT-007 … FT-009: the correction informs, it does not withdraw --------------------------------------

test('FT-007: a normal City Broadcast changes nothing about AGR F-705', () => {
  const g = live();
  fire(g);
  const res = g.setBroadcastAnnouncement({ headline: 'HOLD WATER', message: 'MED needs water this round.' }, { by: 'COM' });
  assert.equal(res.ok, true);
  assert.equal(res.correction, null);
  assert.ok(phantom(g, 'AGR', 'F-705'));
  assert.equal(alertOf(g).status, 'ACTIVE_COM_VERIFIED');
  assert.equal(g.state.broadcast.announcement.correction_for, null, 'a normal broadcast was tied to the alert');
});

test('FT-008 / RE-002 / RE-003: COM prepares and publishes the correction — the wall shows it, every console is nudged, and the alert stays in ACTIVE FAULTS, never RESOLVED', () => {
  const g = live('R5');
  fire(g);
  const { id, prep, pub } = publishCorrection(g);
  assert.equal(prep.headline, 'TELEMETRY CORRECTION - F-705');
  assert.equal(prep.message, 'AGR alert F-705 has been verified as false telemetry. No repair action is required. Resume normal operations.');
  assert.ok(prep.headline.length <= 40 && prep.message.length <= 160);
  assert.equal(pub.correction.ok, true);
  assert.equal(pub.correction.alert_remains, true);
  // the wall and the nudge
  assert.equal(wallAnnouncement(g).headline, 'TELEMETRY CORRECTION - F-705');
  assert.equal(g.state.broadcast.announcement.correction_for, id, 'the wall does not remember which alert the broadcast answers');
  for (const s of SECTORS.filter((x) => x !== 'COM')) assert.equal(forSector(g, s).broadcast.announcement_active, true, `${s} was not nudged to the wall`);
  // the alert stays, unchanged, and is nowhere near RESOLVED
  const f = phantom(g, 'AGR', 'F-705');
  assert.ok(f, 'publishing withdrew the alert');
  assert.equal(f.status, 'ACTIVE');
  assert.equal(f.resolved, false);
  assert.equal(forSector(g, 'AGR').sectors.AGR.recently_resolved.length, 0, 'the phantom appeared under RECENTLY RESOLVED');
  assert.ok(!/RESOLVED|REPAIRED/.test(JSON.stringify(f)));
  assert.equal(alertOf(g).status, 'ACTIVE_CITY_NOTIFIED');
  assert.ok(alertOf(g).com_published_at);
  assert.equal(alertOf(g).resolved_at, null);
  // the target is told what happened, in the specification's words
  assert.equal(notice(g, 'AGR'), 'COM has issued a telemetry correction. No repair action is required. Alert remains logged until the end of the round.');
  // COM's card and the admin's monitor
  assert.equal(comCards(g)[0].publication_status, 'CITY NOTIFIED');
  const row = forControl(g).false_telemetry.alerts[0];
  assert.equal(row.status_word, 'ACTIVE - CITY NOTIFIED');
  assert.equal(row.live, true);
  assert.equal(row.expires, 'ROUND_END');
  assert.equal(logEvents(g, 'false_alert_correction_published').length, 1);
  assert.ok(/correction_for/.test(SECTOR_JS) && /PUBLISH CORRECTION/.test(SECTOR_JS) && /TELEMETRY CORRECTION PUBLISHED/.test(SECTOR_JS));
  assert.ok(!/publishing withdraws/.test(SECTOR_JS), 'the editor still promises a withdrawal');
});

test('FT-009: the correction changes nothing real — Health, inventory, workers, upkeep, faults, allowances, AGR\'s hand', () => {
  const g = live();
  g.fireFault('F-209', 'AGR');
  g.state.trn_approvals_used_this_round = 1;
  fire(g);
  const before = realState(g);
  publishCorrection(g);
  assert.deepEqual(realState(g), before, 'the correction moved real state');
  assert.ok(phantom(g, 'AGR', 'F-209'), 'the real fault went with it');
  assert.equal(Object.keys(g.state.rewards_claimed).length, 0, 'a reward was paid');
  // publishing again is still communication, and a bad id publishes the words but marks nothing
  const again = g.setBroadcastAnnouncement({ headline: 'AGAIN', message: 'x', correction_for: alertOf(g).id }, { by: 'COM' });
  assert.equal(again.correction.ok, true);
  assert.equal(alertOf(g).status, 'ACTIVE_CITY_NOTIFIED');
  const bad = g.setBroadcastAnnouncement({ headline: 'HELLO', message: 'x', correction_for: 'nope' }, { by: 'COM' });
  assert.equal(bad.ok, true);
  assert.equal(bad.correction.ok, false);
  assert.equal(g.state.broadcast.announcement.correction_for, null);
});

// -- FT-010 / RE-006 … RE-010: one round, then gone ----------------------------------------------------------

test('FT-010 / RE-007 / RE-008: the round ends after COM published — the alert expires, leaves AGR and COM, and its broadcast leaves the wall', () => {
  const g = live('R5');
  fire(g);
  publishCorrection(g);
  const before = realState(g);
  const next = endRound(g);
  assert.equal(next, 'R6');
  assert.equal(phantom(g, 'AGR', 'F-705'), undefined, 'the alert survived the round');
  assert.equal(alertOf(g).status, 'EXPIRED_AT_ROUND_END');
  assert.equal(alertOf(g).round_ended, 'R5');
  assert.equal(alertOf(g).com_published_before_expiry, 'YES');
  assert.equal(comCards(g).length, 0, 'COM still holds the card');
  assert.equal(wallAnnouncement(g), null, 'the correction is still on the wall');
  assert.equal(notice(g, 'AGR'), '', 'the target\'s notice about the alert lingered into the next round');
  assert.equal(g.state.broadcast.announcement.correction_for, null);
  assert.equal(forControl(g).false_telemetry.alerts[0].status_word, 'EXPIRED');
  assert.equal(logEvents(g, 'false_alert_expired').length, 1);
  assert.equal(logEvents(g, 'false_alert_broadcast_cleared').length, 1);
  // the upkeep charged is the standing bill, and nothing else about AGR moved beyond the pass
  assert.deepEqual(g.state.upkeep_results.R5.AGR.upkeep_required, { power: 2, water: 1 });
  assert.equal(g.state.sectors.AGR.workforce.active, before.sectors.AGR.workforce.active);
});

test('RE-006: COM never publishes — the alert still disappears when the round ends', () => {
  const g = live('R5');
  fire(g);
  g.tick(300000);
  assert.ok(phantom(g, 'AGR', 'F-705'), 'the alert went before the round ended');
  endRound(g);
  assert.equal(phantom(g, 'AGR', 'F-705'), undefined);
  assert.equal(alertOf(g).status, 'EXPIRED_AT_ROUND_END');
  assert.equal(alertOf(g).com_published_before_expiry, 'NO');
  assert.equal(comCards(g).length, 0);
  assert.equal(logEvents(g, 'false_alert_broadcast_cleared').length, 0, 'nothing was on the wall to clear');
});

test('RE-009: round-end cleanup never touches an unrelated normal City Broadcast', () => {
  // the correction was published, then COM replaced it with ordinary news
  const g = live('R5');
  fire(g);
  publishCorrection(g);
  g.setBroadcastAnnouncement({ headline: 'HOLD POWER', message: 'MED needs 2 power this round.' }, { by: 'COM' });
  assert.equal(g.state.broadcast.announcement.correction_for, null);
  endRound(g);
  assert.equal(alertOf(g).status, 'EXPIRED_AT_ROUND_END');
  assert.equal(wallAnnouncement(g).headline, 'HOLD POWER', 'the normal broadcast was cleared');
  assert.equal(logEvents(g, 'false_alert_broadcast_cleared').length, 0);
  // a normal broadcast with no alert at all survives a round change as it always did
  const g2 = live('R5');
  g2.setBroadcastAnnouncement({ headline: 'HOLD WATER', message: 'x' }, { by: 'COM' });
  endRound(g2);
  assert.equal(wallAnnouncement(g2).headline, 'HOLD WATER');
});

test('RE-010 / FT-012: a real fault beside the phantom keeps decaying Health, and crosses the round boundary as it always did', () => {
  const g = live('R5');
  g.fireFault('F-209', 'AGR');
  const rate = g.state.sectors.AGR.faults[0].decay_per_min;
  assert.ok(rate > 0, 'pick a fault that decays');
  fire(g);
  const before = health(g, 'AGR');
  g.tick(60000);
  const lost = before - health(g, 'AGR');
  assert.ok(Math.abs(lost - rate) < 0.05, `AGR lost ${lost}, the real fault's rate is ${rate}`);
  assert.equal(ownFaults(g, 'AGR').length, 2);
  assert.equal(forControl(g).sectors.AGR.faults.length, 1, 'the admin\'s real fault list grew a phantom');
  endRound(g);
  assert.ok(phantom(g, 'AGR', 'F-209'), 'the round end cleared a real fault');
  assert.equal(g.state.sectors.AGR.faults[0].resolved, false);
  assert.equal(phantom(g, 'AGR', 'F-705'), undefined, 'the phantom survived the round');
  assert.equal(ownFaults(g, 'AGR').length, 1);
});

test('RE-001 / RE-004 / RE-005: fired in Round 5, the alert stays through every participant action — repair attempts after the broadcast consume nothing, nothing a table does removes it', () => {
  const g = live('R5');
  fire(g);
  assert.equal(alertOf(g).created_round, 'R5');
  assert.ok(phantom(g, 'AGR', 'F-705'));
  publishCorrection(g);
  const before = realState(g);
  for (const code of ['P-05-123-456', 'P-01-705', 'F-705']) {
    const res = submitCode(g, { sector: 'AGR', fault_code: 'F-705', code, workers_assigned: 3 });
    assert.equal(res.accepted, false);
    assert.equal(res.reason, 'no_procedure');
    assert.equal(res.attempts, 0);
  }
  g.openFault('AGR', 'F-705');
  assert.deepEqual(realState(g), before, 'a participant action against the published phantom changed something real');
  assert.ok(phantom(g, 'AGR', 'F-705'), 'a participant action removed the alert');
  assert.equal(alertOf(g).status, 'ACTIVE_CITY_NOTIFIED');
  assert.equal(alertOf(g).repair_attempts, 3);
  assert.ok(logEvents(g, 'false_alert_repair_attempt').every((e) => e.after_com_published === true));
  // a restart of the same round is not an end
  g.activateRound('R5', { restart: true });
  assert.ok(phantom(g, 'AGR', 'F-705'), 'a restart of the same round expired the alert');
});

// -- the admin's recovery controls ---------------------------------------------------------------------

test('FT-011: CANCEL and FORCE CLEAR are recovery controls — quiet and noisy — and touch no real fault or resource', () => {
  const g = live();
  g.fireFault('F-209', 'AGR');
  fire(g);
  const before = realState(g);
  assert.equal(g.falseAlertCancel(alertOf(g).id, { by: 'facilitator' }).ok, true);
  assert.equal(phantom(g, 'AGR', 'F-705'), undefined);
  assert.equal(alertOf(g).status, 'ADMIN_CANCELLED');
  assert.deepEqual(realState(g), before);
  assert.ok(phantom(g, 'AGR', 'F-209'));
  assert.equal(notice(g, 'AGR'), '', 'a quiet cancel announced itself');
  // force clear: the alert and its broadcast go now, with a notice — a recovery, not play
  const g2 = live();
  fire(g2);
  publishCorrection(g2);
  const fc = g2.falseAlertForceClear(alertOf(g2).id, { by: 'facilitator' });
  assert.equal(fc.ok, true);
  assert.equal(alertOf(g2).status, 'ADMIN_FORCE_CLEARED');
  assert.equal(phantom(g2, 'AGR', 'F-705'), undefined);
  assert.ok(/ALERT WITHDRAWN/.test(notice(g2, 'AGR')));
  assert.equal(wallAnnouncement(g2), null, 'the force-cleared alert left its correction on the wall');
  assert.equal(logEvents(g2, 'false_alert_force_cleared').length, 1);
  const ft = forControl(g2).false_telemetry;
  assert.equal(ft.templates.length, 6);
  assert.equal(ft.alerts[0].status_word, 'FORCE CLEARED');
  assert.ok(/data-fv="telemetry"/.test(CONTROL_HTML) && /id="ft-fire"/.test(CONTROL_HTML) && /id="ft-list"/.test(CONTROL_HTML));
  assert.ok(/false_alert_fire/.test(CONTROL_JS) && /false_alert_cancel/.test(CONTROL_JS) && /false_alert_force_clear/.test(CONTROL_JS));
  assert.ok(/EXPIRES AT ROUND END/.test(CONTROL_JS), 'the monitor does not say when the alert goes');
  for (const intent of ['false_alert_fire', 'false_alert_cancel', 'false_alert_force_clear', 'false_alert_prepare']) assert.ok(SERVER_JS.includes(`case '${intent}'`), intent);
});

// -- the edges ------------------------------------------------------------------------------------------

test('COM blind: the card waits for telemetry, the admin is warned, and COM is told the moment its feed returns', () => {
  const g = live();
  g.setStatus('COM', 'DARK');
  assert.equal(g.comBlind(), true);
  const refused = fire(g);
  assert.deepEqual([refused.ok, refused.reason], [false, 'com_telemetry_unavailable']);
  assert.ok(/COM telemetry is currently unavailable/.test(refused.warn));
  const fired = fire(g, 'AGR', 'F-705', {}, { override: true });
  assert.equal(fired.ok, true);
  assert.equal(alertOf(g).com_notified_at, null);
  assert.equal(alertOf(g).status, 'ACTIVE_UNVERIFIED');
  assert.equal(forControl(g).false_telemetry.alerts[0].status_word, 'ACTIVE - WAITING FOR COM');
  assert.ok(phantom(g, 'AGR', 'F-705'), 'the target still sees the alert');
  assert.equal(g.falseAlertPrepare(alertOf(g).id, { by: 'COM' }).reason, 'com_telemetry_unavailable');
  g.setStatus('COM', 'ACTIVE');
  g.tick(1000);
  assert.ok(alertOf(g).com_notified_at, 'COM was not told when its feed came back');
  assert.equal(alertOf(g).status, 'ACTIVE_COM_VERIFIED');
  assert.equal(comCards(g).length, 1);
});

test('one live alert per code; a template may be aimed at any sector; the admin monitor reads what the target did', () => {
  const g = live();
  assert.equal(fire(g).ok, true);
  assert.equal(fire(g).reason, 'already_active');
  assert.equal(fire(g, 'POW', 'F-702').ok, true, 'a template cannot be aimed elsewhere');
  assert.ok(phantom(g, 'POW', 'F-702'));
  g.openFault('AGR', 'F-705');
  submitCode(g, { sector: 'AGR', fault_code: 'F-705', code: 'P-01-111', workers_assigned: 1 });
  const row = forControl(g).false_telemetry.alerts.find((a) => a.fault_code === 'F-705');
  assert.deepEqual([row.target_opened, row.target_attempted, row.com_notified, row.com_published, row.live], [true, true, true, false, true]);
  assert.ok(Number.isInteger(row.elapsed_s));
  assert.equal(logEvents(g, 'false_alert_opened').length, 1);
  g.fireFault('F-209', 'AGR');
  assert.equal(g.openFault('AGR', 'F-209'), true);
  assert.ok(g.state.sectors.AGR.faults[0].opened_at);
  // both expire together when the round ends; the one that was published says so
  publishCorrection(g);
  endRound(g);
  assert.deepEqual(g.state.false_alerts.map((a) => a.status), ['EXPIRED_AT_ROUND_END', 'EXPIRED_AT_ROUND_END']);
  assert.deepEqual(g.state.false_alerts.map((a) => a.com_published_before_expiry).sort(), ['NO', 'YES']);
});

test('persistence and reset: alerts survive a restore in their state and still expire with their round; RESET removes every one', () => {
  const g = live('R5');
  fire(g);
  publishCorrection(g);
  const snap = JSON.parse(JSON.stringify(g.serialise()));
  const back = newGame({ runId: 'ft-restore' });
  back.restore(snap);
  assert.equal(back.state.false_alerts.length, 1);
  assert.equal(alertOf(back).status, 'ACTIVE_CITY_NOTIFIED');
  assert.ok(phantom(back, 'AGR', 'F-705'));
  assert.equal(back.state.broadcast.announcement.correction_for, alertOf(back).id);
  endRound(back);
  assert.equal(phantom(back, 'AGR', 'F-705'), undefined);
  assert.equal(wallAnnouncement(back), null);
  // a snapshot from before the mechanic restores clean
  const old = JSON.parse(JSON.stringify(g.serialise()));
  delete old.state.false_alerts;
  delete old.state.broadcast.announcement.correction_for;
  const legacy = newGame({ runId: 'ft-legacy' });
  legacy.restore(old);
  assert.deepEqual(legacy.state.false_alerts, []);
  assert.equal(fire(legacy).ok, true);
  // reset
  g.reset('ft-fresh');
  assert.deepEqual(g.state.false_alerts, []);
  assert.equal(ownFaults(g, 'AGR').length, 0);
  assert.equal(forControl(g).false_telemetry.alerts.length, 0);
  assert.equal(g.state.broadcast.announcement.correction_for, null);
});

test('the debrief sees the whole arc — fired, opened, attempted, COM told, prepared, published, expired — with the metric COM communicated before expiry', () => {
  const g = live('R5');
  fire(g);
  g.openFault('AGR', 'F-705');
  submitCode(g, { sector: 'AGR', fault_code: 'F-705', code: 'P-02-222', workers_assigned: 1 });
  publishCorrection(g);
  endRound(g);
  const report = analyse(g.log.readAll());
  const rounds = Object.values(report.rounds || {});
  const rec = rounds.flatMap((R) => (R.false_alerts ? R.false_alerts.list : [])).find((x) => x.fault_code === 'F-705');
  assert.ok(rec, 'no false-alert record in the debrief');
  assert.equal(rec.target_sector, 'AGR');
  for (const k of ['time_fired', 'target_opened_at', 'first_repair_attempt_at', 'com_notified_at', 'com_prepared_at', 'com_published_at', 'round_end_time']) assert.ok(rec[k], k);
  assert.ok(Number.isInteger(rec.time_until_com_broadcast_s));
  assert.equal(rec.com_communicated_before_expiry, 'YES');
  assert.equal(rec.admin_force_clear, false);
  assert.ok(report.timeline.some((x) => x.kind === 'telemetry' && /F-705/.test(x.text)));
  assert.ok(!report.timeline.some((x) => x.kind === 'fault' && /F-705/.test(x.text)), 'the phantom was counted as a fault');
  assert.ok(!rounds.flatMap((R) => R.faults.list).some((f) => f.code === 'F-705'));
  // and the one COM never answered
  const g2 = live('R5');
  fire(g2);
  endRound(g2);
  const rec2 = Object.values(analyse(g2.log.readAll()).rounds).flatMap((R) => (R.false_alerts ? R.false_alerts.list : [])).find((x) => x.fault_code === 'F-705');
  assert.equal(rec2.com_communicated_before_expiry, 'NO');
  assert.equal(rec2.com_published_at, null);
  assert.ok(rec2.round_end_time);
});
