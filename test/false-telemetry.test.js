'use strict';
/**
 * FALSE TELEMETRY / PHANTOM FAULTS (FALSE_TELEMETRY_V1, 2026-10-06).
 *
 * A phantom alert looks like a fault to the room and is not one: it lives in
 * state.false_alerts, never in a sector's faults, so nothing decays, nothing
 * is consumed, nothing can be repaired and nothing is paid. Only COM is told,
 * privately, that it is false; COM withdraws it with PUBLISH CORRECTION on
 * the existing City Broadcast. FT-001 … FT-012 are the specification's
 * acceptance tests, in its order; the rest hold the edges.
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
const SECTOR_HTML = read('public/sector/index.html');
const CONTROL_JS = read('public/control/control.js');
const CONTROL_HTML = read('public/control/index.html');
const SERVER_JS = read('server.js');

const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const content = loadContent();

/** A run in Round 4, clock running, every table stocked. */
function live() {
  const g = newGame();
  g.setPhase('ROUND_4');
  g.clock('start'); g.tick(1000);
  for (const s of SECTORS) g.setInventory(s, { power: 9, water: 9, parts: 9, med: 9 });
  return g;
}
const fire = (g, sector = 'AGR', template = 'F-705', extra = {}, opts = {}) => g.fireFalseAlert({ sector, template, ...extra }, { by: 'facilitator', ...opts });
const ownFaults = (g, s) => forSector(g, s).sectors[s].faults;
const phantom = (g, s, code) => ownFaults(g, s).find((f) => f.code === code);
const health = (g, s) => g.state.sectors[s].integrity;
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
  // the same keys as a real fault's projection, and nothing more
  g.fireFault('F-209', 'AGR');
  const realOne = phantom(g, 'AGR', 'F-209');
  assert.deepEqual(Object.keys(f).sort(), Object.keys(realOne).sort(), 'the phantom\'s shape differs from a real fault\'s');
  // no word on the frame gives it away, and the admin's collection never reaches a table
  const frame = forSector(g, 'AGR');
  const words = JSON.stringify(frame).replace(/"[a-z_]+":(true|false)/g, '');   // JSON booleans are not words
  assert.ok(!FORBIDDEN.test(words), 'the target frame carries a tell');
  assert.equal(frame.false_telemetry, undefined);
  assert.equal(frame.false_alerts, undefined);
  // it is not in the engine's fault collection
  assert.ok(!g.state.sectors.AGR.faults.some((x) => x.code === 'F-705'), 'the phantom was written into the sector\'s faults');
  assert.equal(g.state.false_alerts.length, 1);
  // the room heard what it hears for a real fault: a feed line and a sting
  assert.ok(forBigscreen(g).feed.some((e) => e.kind === 'fault' && /AGR fault detected: F-705/.test(e.text)));
});

test('FT-002: F-705 stays active for three minutes and AGR loses no Health from it', () => {
  const g = live();
  fire(g);
  const before = health(g, 'AGR');
  g.tick(180000);
  assert.equal(health(g, 'AGR'), before, 'the phantom bled Health');
  assert.ok(phantom(g, 'AGR', 'F-705'), 'the phantom vanished on its own');
  assert.equal(g.state.false_alerts[0].actual_decay_rate, 0);
});

test('FT-003: no repair procedure exists for F-705 — not in the content, not in any binder, no code to find', () => {
  assert.equal(content.faults.faults.find((f) => f.code === 'F-705'), undefined);
  const g = live();
  assert.ok(!g.faultDefinition('F-705'), 'the engine has a definition for F-705');
  assert.ok(!g.faultsByCode.has('F-705'));
  // the fault library the facilitator fires from does not list it either
  assert.ok(!forControl(g).scenario.fault_presets || !JSON.stringify(forControl(g).scenario.fault_presets).includes('F-705'));
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
  assert.equal(g.state.false_alerts[0].repair_attempts, 5);
  assert.ok(g.state.false_alerts[0].first_repair_attempt_at);
  assert.equal(logEvents(g, 'false_alert_repair_attempt').length, 5);
  // the console prints the no-procedure words and the binder's instruction, nothing about falseness
  assert.ok(/NO MATCHING PROCEDURE — VERIFY THIS ALERT/.test(SECTOR_JS));
  assert.ok(/Stop entering codes\. Log it, tell COM, then work the faults you can repair\./.test(SECTOR_JS));
  // a real unknown code is still unknown_fault
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
  assert.equal(c.instruction, 'Publish a city correction. No physical repair is required.');
  assert.ok(c.detected_at);
  // COM's own live feed shows AGR carrying F-705, exactly as a real fault would read there
  assert.ok(com.sectors.AGR.faults.some((f) => f.code === 'F-705' && f.severity === 2));
  assert.equal(g.state.false_alerts[0].status, 'COM_NOTIFIED');
  assert.equal(logEvents(g, 'false_alert_com_notified').length, 1);
  // the console renders the card in the CITY INTELLIGENCE block with PREPARE CORRECTION
  assert.ok(/intel\.anomalies/.test(SECTOR_JS) && /PREPARE CORRECTION/.test(SECTOR_JS) && /false_alert_prepare/.test(SECTOR_JS));
});

test('FT-006: POW, WTR, MED and TRN receive no private indication that AGR F-705 is false', () => {
  const g = live();
  fire(g);
  for (const s of ['POW', 'WTR', 'MED', 'TRN']) {
    const frame = forSector(g, s);
    assert.equal(frame.intel, undefined, `${s} has an intelligence feed`);
    // the one place F-705 may appear on another console is the public feed line every fault gets
    const publicLines = frame.ticker.filter((e) => /F-705/.test(e.text));
    assert.ok(publicLines.every((e) => e.kind === 'fault' && e.text === 'AGR fault detected: F-705'), `${s}: ${JSON.stringify(publicLines)}`);
    const rest = JSON.stringify({ ...frame, ticker: [] }).replace(/"[a-z_]+":(true|false)/g, '');
    assert.ok(!/FALSE POSITIVE|TELEMETRY ANOMALY|F-705/.test(rest), `${s} was told about F-705`);
  }
  // the wall counts it as one more alert on AGR, like any fault, and names nothing
  const wall = forBigscreen(g);
  assert.equal(wall.sectors.AGR.unresolved_faults, 1);
  assert.ok(!/FALSE POSITIVE|TELEMETRY ANOMALY/.test(JSON.stringify(wall)));
});

// -- FT-007 … FT-009: the correction ------------------------------------------------------------------

test('FT-007: a normal City Broadcast leaves AGR F-705 active', () => {
  const g = live();
  fire(g);
  const res = g.setBroadcastAnnouncement({ headline: 'HOLD WATER', message: 'MED needs water this round.' }, { by: 'COM' });
  assert.equal(res.ok, true);
  assert.equal(res.correction, null);
  assert.ok(phantom(g, 'AGR', 'F-705'), 'an unrelated broadcast withdrew the alert');
  assert.equal(g.state.false_alerts[0].status, 'COM_NOTIFIED');
});

test('FT-008: COM prepares a correction and presses PUBLISH CORRECTION — the wall shows it, every console is nudged, AGR\'s alert is withdrawn', () => {
  const g = live();
  fire(g);
  const id = g.state.false_alerts[0].id;
  const prep = g.falseAlertPrepare(id, { by: 'COM' });
  assert.equal(prep.ok, true, JSON.stringify(prep));
  assert.equal(prep.headline, 'TELEMETRY CORRECTION - F-705');
  assert.equal(prep.message, 'AGR alert F-705 has been verified as false telemetry. No repair action is required. Resume normal operations.');
  assert.ok(prep.headline.length <= 40 && prep.message.length <= 160);
  assert.equal(g.state.false_alerts[0].status, 'CORRECTION_PREPARED');
  assert.equal(forSector(g, 'COM').intel.anomalies[0].publication_status, 'CORRECTION PREPARED');
  // the existing broadcast, with the alert as hidden metadata
  const pub = g.setBroadcastAnnouncement({ headline: prep.headline, message: prep.message, correction_for: id }, { by: 'COM' });
  assert.equal(pub.ok, true);
  assert.equal(pub.correction.ok, true);
  assert.equal(forBigscreen(g).broadcast.announcement.headline, 'TELEMETRY CORRECTION - F-705');
  for (const s of SECTORS.filter((x) => x !== 'COM')) assert.equal(forSector(g, s).broadcast.announcement_active, true, `${s} was not nudged to the wall`);
  assert.equal(phantom(g, 'AGR', 'F-705'), undefined, 'the alert is still on AGR');
  const notice = forSector(g, 'AGR').announcements.find((a) => a.sector === 'AGR');
  assert.ok(notice && /ALERT WITHDRAWN — COM has verified F-705 as false telemetry\. No repair action is required\./.test(notice.text), JSON.stringify(notice));
  assert.equal(g.state.false_alerts[0].status, 'CORRECTED');
  assert.equal(g.state.false_alerts[0].resolution, 'COM_CORRECTION');
  assert.ok(g.state.false_alerts[0].com_published_at);
  assert.equal(forSector(g, 'COM').intel.anomalies[0].publication_status, 'CITY NOTIFIED');
  assert.equal(forControl(g).false_telemetry.alerts[0].status, 'CORRECTED');
  const logged = logEvents(g, 'false_alert_corrected');
  assert.equal(logged.length, 1);
  assert.ok(Number.isInteger(logged[0].total_seconds_until_correction));
  // the console's editor: PUBLISH CORRECTION carries the id, and only then
  assert.ok(/correction_for/.test(SECTOR_JS) && /PUBLISH CORRECTION/.test(SECTOR_JS) && /TELEMETRY CORRECTION PUBLISHED/.test(SECTOR_JS));
});

test('FT-009: the correction changes nothing real — Health, inventory, workers, upkeep, faults, allowances, AGR\'s hand', () => {
  const g = live();
  g.fireFault('F-209', 'AGR');
  g.state.trn_approvals_used_this_round = 1;
  fire(g);
  const before = realState(g);
  const id = g.state.false_alerts[0].id;
  g.falseAlertPrepare(id, { by: 'COM' });
  const pub = g.setBroadcastAnnouncement({ headline: 'TELEMETRY CORRECTION - F-705', message: 'AGR alert F-705 verified false.', correction_for: id }, { by: 'COM' });
  assert.equal(pub.correction.ok, true);
  assert.deepEqual(realState(g), before, 'the correction moved real state');
  assert.ok(phantom(g, 'AGR', 'F-209'), 'the real fault went with it');
  assert.equal(forSector(g, 'AGR').sectors.AGR.recently_resolved.length, 0, 'the phantom appeared as resolved');
  assert.equal(Object.keys(g.state.rewards_claimed).length, 0, 'a reward was paid');
  // a second correction for the same alert is refused, and a bad id publishes the words but withdraws nothing
  assert.equal(g.setBroadcastAnnouncement({ headline: 'AGAIN', message: 'x', correction_for: id }, { by: 'COM' }).correction.reason, 'false_alert_closed');
  const bad = g.setBroadcastAnnouncement({ headline: 'HELLO', message: 'x', correction_for: 'nope' }, { by: 'COM' });
  assert.equal(bad.ok, true);
  assert.equal(bad.correction.ok, false);
});

// -- FT-010 … FT-012: rounds, the admin, a real fault beside it ------------------------------------------

test('FT-010: a round change carries the unresolved alert forward — no clearing, no conversion, no upkeep, no hidden penalty', () => {
  const g = live();
  fire(g);
  const before = realState(g);
  for (const s of SECTORS) g.setInventory(s, { power: 9, water: 9, parts: 9, med: 9 });
  g.activateRound('R5');
  assert.ok(phantom(g, 'AGR', 'F-705'), 'the round change cleared the alert');
  assert.equal(g.state.false_alerts[0].status, 'COM_NOTIFIED');
  assert.ok(!g.state.sectors.AGR.faults.some((f) => f.code === 'F-705'));
  const after = realState(g);
  // the upkeep charged is the standing bill, nothing for the phantom; Health moved only by the pass (nothing here)
  assert.deepEqual(g.state.upkeep_results.R4.AGR.upkeep_required, { power: 2, water: 1 });
  assert.equal(after.sectors.AGR.integrity, before.sectors.AGR.integrity);
  assert.deepEqual(after.sectors.AGR.workforce, before.sectors.AGR.workforce);
});

test('FT-011: the admin cancels or force-clears a false alert without touching any real fault or resource', () => {
  const g = live();
  g.fireFault('F-209', 'AGR');
  fire(g);
  const before = realState(g);
  const id = g.state.false_alerts[0].id;
  assert.equal(g.falseAlertCancel(id, { by: 'facilitator' }).ok, true);
  assert.equal(phantom(g, 'AGR', 'F-705'), undefined);
  assert.equal(g.state.false_alerts[0].status, 'ADMIN_CANCELLED');
  assert.deepEqual(realState(g), before);
  assert.ok(phantom(g, 'AGR', 'F-209'));
  assert.ok(!forSector(g, 'AGR').announcements.some((a) => /WITHDRAWN/.test(a.text)), 'a quiet cancel announced itself');
  // force clear: the alert goes with the withdrawal notice, by the admin's hand
  const g2 = live();
  fire(g2);
  const id2 = g2.state.false_alerts[0].id;
  const fc = g2.falseAlertCorrected(id2, { by: 'facilitator', force: true });
  assert.equal(fc.ok, true);
  assert.equal(g2.state.false_alerts[0].resolution, 'ADMIN_FORCE_CLEAR');
  assert.equal(phantom(g2, 'AGR', 'F-705'), undefined);
  assert.ok(forSector(g2, 'AGR').announcements.some((a) => /ALERT WITHDRAWN/.test(a.text)));
  assert.equal(logEvents(g2, 'false_alert_force_cleared').length, 1);
  // the admin's monitor and controls
  const ft = forControl(g2).false_telemetry;
  assert.equal(ft.templates.length, 6);
  assert.equal(ft.alerts[0].status, 'CORRECTED');
  assert.ok(/data-fv="telemetry"/.test(CONTROL_HTML) && /id="ft-fire"/.test(CONTROL_HTML) && /id="ft-list"/.test(CONTROL_HTML));
  assert.ok(/false_alert_fire/.test(CONTROL_JS) && /false_alert_cancel/.test(CONTROL_JS) && /false_alert_force_clear/.test(CONTROL_JS));
  for (const intent of ['false_alert_fire', 'false_alert_cancel', 'false_alert_force_clear', 'false_alert_prepare']) assert.ok(SERVER_JS.includes(`case '${intent}'`), intent);
});

test('FT-012: a real fault beside the phantom keeps decaying Health; the phantom never does', () => {
  const g = live();
  g.fireFault('F-209', 'AGR');   // a real Round 2 fault with a decay rate
  const rate = g.state.sectors.AGR.faults[0].decay_per_min;
  assert.ok(rate > 0, 'pick a fault that decays');
  fire(g);
  const before = health(g, 'AGR');
  g.tick(60000);
  const lost = before - health(g, 'AGR');
  assert.ok(Math.abs(lost - rate) < 0.05, `AGR lost ${lost}, the real fault's rate is ${rate}`);
  assert.equal(ownFaults(g, 'AGR').length, 2);
  assert.equal(forControl(g).sectors.AGR.faults.length, 1, 'the admin\'s real fault list grew a phantom');
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
  assert.equal(g.state.false_alerts[0].com_notified_at, null);
  assert.equal(g.state.false_alerts[0].status, 'ACTIVE');
  assert.ok(phantom(g, 'AGR', 'F-705'), 'the target still sees the alert');
  assert.equal(g.falseAlertPrepare(g.state.false_alerts[0].id, { by: 'COM' }).reason, 'com_telemetry_unavailable');
  g.setStatus('COM', 'ACTIVE');
  g.tick(1000);
  assert.ok(g.state.false_alerts[0].com_notified_at, 'COM was not told when its feed came back');
  assert.equal(forSector(g, 'COM').intel.anomalies.length, 1);
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
  // a real fault opened by the same intent still opens
  g.fireFault('F-209', 'AGR');
  assert.equal(g.openFault('AGR', 'F-209'), true);
  assert.ok(g.state.sectors.AGR.faults[0].opened_at);
});

test('persistence and reset: alerts survive a restore in their state; RESET removes every one', () => {
  const g = live();
  fire(g);
  g.falseAlertPrepare(g.state.false_alerts[0].id, { by: 'COM' });
  const snap = JSON.parse(JSON.stringify(g.serialise()));
  const back = newGame({ runId: 'ft-restore' });
  back.restore(snap);
  assert.equal(back.state.false_alerts.length, 1);
  assert.equal(back.state.false_alerts[0].status, 'CORRECTION_PREPARED');
  assert.ok(phantom(back, 'AGR', 'F-705'));
  // a snapshot from before the mechanic restores clean
  const old = JSON.parse(JSON.stringify(g.serialise()));
  delete old.state.false_alerts;
  const legacy = newGame({ runId: 'ft-legacy' });
  legacy.restore(old);
  assert.deepEqual(legacy.state.false_alerts, []);
  assert.equal(fire(legacy).ok, true);
  // reset
  g.reset('ft-fresh');
  assert.deepEqual(g.state.false_alerts, []);
  assert.equal(ownFaults(g, 'AGR').length, 0);
  assert.equal(forControl(g).false_telemetry.alerts.length, 0);
});

test('the debrief sees the whole arc — fired, opened, attempted, COM told, prepared, published — and never as a fault', () => {
  const g = live();
  fire(g);
  g.openFault('AGR', 'F-705');
  submitCode(g, { sector: 'AGR', fault_code: 'F-705', code: 'P-02-222', workers_assigned: 1 });
  const id = g.state.false_alerts[0].id;
  g.falseAlertPrepare(id, { by: 'COM' });
  g.setBroadcastAnnouncement({ headline: 'TELEMETRY CORRECTION - F-705', message: 'AGR alert F-705 verified false.', correction_for: id }, { by: 'COM' });
  const report = analyse(g.log.readAll());
  const rounds = Object.values(report.rounds || {});
  const rec = rounds.flatMap((R) => (R.false_alerts ? R.false_alerts.list : [])).find((x) => x.fault_code === 'F-705');
  assert.ok(rec, 'no false-alert record in the debrief');
  assert.equal(rec.target_sector, 'AGR');
  for (const k of ['time_fired', 'target_opened_at', 'first_repair_attempt_at', 'com_notified_at', 'com_prepared_at', 'com_published_at']) assert.ok(rec[k], k);
  assert.ok(Number.isInteger(rec.total_seconds_until_correction));
  assert.equal(rec.admin_force_clear, false);
  assert.ok(report.timeline.some((x) => x.kind === 'telemetry' && /F-705/.test(x.text)));
  assert.ok(!report.timeline.some((x) => x.kind === 'fault' && /F-705/.test(x.text)), 'the phantom was counted as a fault');
  const faults = rounds.flatMap((R) => R.faults.list);
  assert.ok(!faults.some((f) => f.code === 'F-705'));
});
