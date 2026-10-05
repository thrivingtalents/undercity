'use strict';
/**
 * QUIET TRANSITION (2026-10-06). NEXT ROUND and START announce nothing. The
 * room sees the round number change and the new round's clock, and that is
 * all: no event title, no narrative, no city announcement, no overlay, no
 * sound caused by nothing but the transition. A round's broadcast, where the
 * runbook wants one, waits on the EVENTS timeline for the facilitator's own
 * press. Everything else the transition does — the timer, upkeep, the
 * allowances, the faults and transfers that carry — it still does.
 *
 *   RT-001  the scenario's round broadcasts are MANUAL beats at 00:00
 *   RT-002  Round 1 to Round 7: NEXT ROUND and START raise no alert, no announcement and no room sound — the number and the clock change
 *   RT-003  the mechanics still turn over: the timer, upkeep, the allowances, an open fault
 *   RT-004  the broadcast waits READY for the facilitator, silently, and plays with its weight when pressed
 *   RT-005  a scenario that says AUTO at 00:00 is held anyway, and an old snapshot's AUTO beat is held on its first tick
 *   RT-006  automatic beats off the transition still fire themselves
 *   RT-007  what is manual stays manual: COM's CITY BROADCAST, the facilitator's announcement, overlay and event
 *   RT-008  the screens and the paper say so
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { newGame, logEvents, rounds } = require('./helpers');
const { forControl, forSector, forBigscreen } = require('../lib/visibility');

const ROOT = path.join(__dirname, '..');
const STANDARD = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'scenarios', 'haven9-standard.json'), 'utf8'));
const ALL = rounds.rounds.map((r) => r.id);
const PLAYED = ALL.slice(1);                   // R1..R7: the rounds a NEXT ROUND press opens

/** What the room would notice: the overlay, the announcement feed, the sounds queued for the wall and consoles. */
function roomNotices(game) {
  return { alert: game.state.alert, announcements: game.state.announcements.length, stings: game.drainStings() };
}

test('RT-001: the scenario\'s round broadcasts are MANUAL beats at 00:00', () => {
  const broadcasts = [];
  for (const [round, beats] of Object.entries(STANDARD.timelines)) {
    for (const b of beats) {
      if ((b.kind === 'alert' || b.kind === 'announce') && Number(b.offset_s || 0) === 0) {
        assert.equal(b.mode, 'MANUAL', `${round}: ${b.text} is ${b.mode}`);
        assert.ok(!/it plays when START is pressed|plays itself/i.test(b.note || ''), `${round}: the note still promises a START broadcast`);
        broadcasts.push(round);
      }
    }
  }
  assert.deepEqual(broadcasts, ['R4', 'R5', 'R6', 'R7']);
});

test('RT-002: Round 1 to Round 7 — NEXT ROUND and START raise no alert, no announcement and no room sound; the number and the clock change', () => {
  const game = newGame();
  const before = game.state.announcements.length;
  game.drainStings();
  for (const r of PLAYED) {
    const n = Number(r.slice(1));
    const act = game.activateRound(r);
    assert.equal(act.ok, true, `${r}: ${act.reason}`);
    let seen = roomNotices(game);
    assert.equal(seen.alert, null, `${r}: NEXT ROUND raised an overlay`);
    assert.equal(seen.announcements, before, `${r}: NEXT ROUND announced something`);
    assert.ok(!seen.stings.includes('alert'), `${r}: NEXT ROUND sounded the alert`);
    assert.equal(game.state.round, r);
    assert.equal(game.roundOrdinal(), n, `${r}: the visible number`);
    assert.equal(forBigscreen(game).round_number, n, `${r}: the wall's number`);
    assert.equal(forSector(game, 'POW').round_number, n, `${r}: the console's number`);
    const length = rounds.rounds.find((x) => x.id === r).length_s || STANDARD.defaults.round_length_s[r];
    assert.equal(game.state.round_clock.duration_s, STANDARD.defaults.round_length_s[r], `${r}: the timer length (${length})`);
    assert.equal(game.state.round_clock.status, 'ready', `${r}: the timer waits for START`);

    assert.equal(game.clock('start').ok, true);
    game.tick(1000); game.tick(1000); game.tick(1000);
    seen = roomNotices(game);
    assert.equal(seen.alert, null, `${r}: START raised an overlay`);
    assert.equal(seen.announcements, before, `${r}: START announced something`);
    assert.deepEqual(seen.stings, [], `${r}: START sent a sound to the room: ${seen.stings.join(', ')}`);
    assert.equal(game.state.round_clock.running, true, `${r}: the clock is not running`);
    assert.ok(game.roundTimerRemaining() < STANDARD.defaults.round_length_s[r], `${r}: the clock did not move`);
    assert.equal(forBigscreen(game).alert, null, `${r}: the wall carries an overlay`);
    assert.equal(forSector(game, 'COM').alert, null, `${r}: a console carries an overlay`);
  }
  assert.equal(logEvents(game, 'alert').length, 0, 'an alert was logged across the shift');
  assert.equal(logEvents(game, 'announce').length, 0, 'an announcement was logged across the shift');
  assert.equal(logEvents(game, 'timeline_fired').filter((e) => e.by === 'auto' && (e.kind === 'alert' || e.kind === 'announce')).length, 0, 'a broadcast fired itself');
});

test('RT-003: the mechanics still turn over — the timer, upkeep, the allowances, an open fault', () => {
  const game = newGame();
  game.activateRound('R1'); game.clock('start'); game.tick(1000);
  // an open fault in Round 1
  assert.equal(game.fireFault('F-101', 'POW').ok, true);
  const open = game.findFault('POW', 'F-101');
  assert.ok(open && !open.resolved);
  const resets = { trn: logEvents(game, 'trn_approval_counter_reset').length, med: logEvents(game, 'med_healing_counter_reset').length };
  const upkeep = logEvents(game, 'upkeep_result').length;

  const act = game.activateRound('R2');
  assert.equal(act.ok, true);
  assert.equal(act.charged, 'R1', 'moving on did not charge the round just played');
  assert.ok(logEvents(game, 'upkeep_result').length > upkeep, 'no upkeep result was recorded');
  assert.ok(logEvents(game, 'trn_approval_counter_reset').length > resets.trn, 'TRN approvals did not refresh');
  assert.ok(logEvents(game, 'med_healing_counter_reset').length > resets.med, 'MED heals did not refresh');
  const still = game.findFault('POW', 'F-101');
  assert.ok(still && !still.resolved, 'the open fault did not carry over');
  assert.equal(game.state.round_clock.duration_s, STANDARD.defaults.round_length_s.R2);
  assert.equal(game.state.round_clock.status, 'ready');
  assert.equal(game.state.alert, null);
});

test('RT-004: the broadcast waits READY for the facilitator, silently, and plays with its weight when pressed', () => {
  const game = newGame();
  for (const r of ['R1', 'R2', 'R3']) { game.activateRound(r); game.clock('start'); game.tick(1000); }
  game.drainStings();
  game.activateRound('R4');
  const beat = game.state.timeline.find((t) => t.kind === 'alert' && t.offset_s === 0);
  assert.ok(beat, 'Round 4 has no broadcast beat');
  assert.equal(beat.mode, 'MANUAL');
  assert.equal(beat.status, 'READY', 'the broadcast is not ready the moment the round is armed');
  assert.equal(beat.transition, true);
  assert.ok(!game.drainStings().includes('chime'), 'the READY chime reached the room');
  // the control panel sees it waiting, the room sees nothing
  const ctl = forControl(game).timeline.find((t) => t.id === beat.id);
  assert.ok(ctl && ctl.transition === true && ctl.status === 'READY' && ctl.mode === 'MANUAL');
  assert.equal(forSector(game, 'POW').alert, null);
  game.clock('start'); game.tick(1000); game.tick(1000);
  assert.equal(game.state.alert, null, 'START played the broadcast');
  assert.deepEqual(game.drainStings(), [], 'START sent a sound to the room');
  // the press plays it: a major broadcast holds the full screen for 14 s
  const fired = game.fireTimelineItem(beat.id);
  assert.equal(fired.ok, true);
  assert.equal(game.state.alert.title, 'TRAINING PROTOCOLS CONCLUDED');
  assert.equal(forSector(game, 'POW').alert.full_s, 14);
  assert.equal(forSector(game, 'POW').alert.full_screen, true);
  assert.ok(game.drainStings().includes('alert'), 'the pressed broadcast made no sound');
  assert.equal(logEvents(game, 'timeline_fired').filter((e) => e.id === beat.id && e.by === 'facilitator').length, 1);
  assert.equal(game.fireTimelineItem(beat.id).ok, false, 'a broadcast plays twice');
});

test('RT-005: a scenario that says AUTO at 00:00 is held anyway, and an old snapshot\'s AUTO beat is held on its first tick', () => {
  const game = newGame();
  game.scenario.timelines.R5 = [
    { offset_s: 0, kind: 'alert', text: 'AUTO OVERLAY', subtitle: 'the scenario asked for it', mode: 'AUTO' },
    { offset_s: 0, kind: 'announce', text: 'AUTO LINE', mode: 'AUTO' },
    { offset_s: 30, kind: 'announce', text: 'LATER LINE', mode: 'AUTO' },
  ];
  game.setRound('R5');
  const held = logEvents(game, 'transition_broadcast_held');
  assert.equal(held.length, 2, `held: ${JSON.stringify(held)}`);
  assert.ok(held.every((h) => h.scenario_mode === 'AUTO' && h.round === 'R5'));
  for (const t of game.state.timeline.filter((x) => x.offset_s === 0)) {
    assert.equal(t.mode, 'MANUAL', `${t.text} stayed AUTO`);
    assert.equal(t.status, 'READY');
    assert.equal(t.transition, true);
  }
  const later = game.state.timeline.find((x) => x.offset_s === 30);
  assert.equal(later.mode, 'AUTO', 'a beat later in the round was held too');
  assert.equal(later.transition, undefined);
  const before = game.state.announcements.length;
  game.clock('start'); game.tick(1000); game.tick(1000);
  assert.equal(game.state.alert, null);
  assert.equal(game.state.announcements.length, before);

  // a snapshot written before the quiet transition still carries an AUTO beat at 00:00, PENDING
  const g2 = newGame({ runId: 'old-snapshot' });
  g2.setRound('R6');
  g2.state.timeline.push({ id: 'R6-OLD', round: 'R6', offset_s: 0, kind: 'announce', text: 'OLD AUTO', mode: 'AUTO', status: 'PENDING', fired_at: null });
  g2.drainStings();
  const n = g2.state.announcements.length;
  g2.clock('start'); g2.tick(1000);
  const old = g2.state.timeline.find((t) => t.id === 'R6-OLD');
  assert.equal(old.status, 'READY');
  assert.equal(old.mode, 'MANUAL');
  assert.equal(old.transition, true);
  assert.equal(g2.state.announcements.length, n, 'the old beat announced itself');
  assert.deepEqual(g2.drainStings(), [], 'holding the old beat made a sound');
  assert.equal(logEvents(g2, 'transition_broadcast_held').filter((h) => h.id === 'R6-OLD' && h.by === 'tick').length, 1);
});

test('RT-006: automatic beats off the transition still fire themselves', () => {
  const game = newGame();
  game.activateRound('R1'); game.clock('start'); game.tick(1000);
  game.activateRound('R2');
  const beat = game.state.timeline.find((t) => t.kind === 'announce');
  assert.ok(beat && beat.mode === 'AUTO' && beat.offset_s === 180, `the Round 2 announcement: ${JSON.stringify(beat)}`);
  game.clock('start'); game.tick(1000);
  assert.equal(beat.status, 'PENDING', 'the 03:00 announcement went off at START');
  game.clock('set', game.state.round_clock.duration_s - beat.offset_s - 1, 'round', { reason: 'jump' });
  game.tick(1000);
  assert.equal(beat.status, 'FIRED');
  assert.equal(game.state.announcements[0].text, beat.text);
  assert.equal(logEvents(game, 'transition_broadcast_held').length, 0);
});

test("RT-007: what is manual stays manual — COM's CITY BROADCAST, the facilitator's announcement, overlay and event", () => {
  const game = newGame();
  game.activateRound('R1'); game.clock('start'); game.tick(1000);
  const pub = game.setBroadcastAnnouncement({ headline: 'WATER PRESSURE LOW', message: 'Conserve where you can.' }, { by: 'COM' });
  assert.equal(pub.ok, true, pub.reason);
  assert.equal(game.state.broadcast.announcement.headline, 'WATER PRESSURE LOW');
  assert.equal(forBigscreen(game).broadcast.announcement.headline, 'WATER PRESSURE LOW', 'the wall does not carry COM\'s broadcast');
  assert.equal(game.state.alert, null, 'a COM broadcast raised a system overlay');
  game.announce('Core output dropping.');
  assert.equal(game.state.announcements[0].text, 'Core output dropping.');
  game.setAlert({ title: 'MANUAL OVERLAY', subtitle: 'pressed by the facilitator' });
  assert.equal(forSector(game, 'MED').alert.title, 'MANUAL OVERLAY');
  assert.equal(game.dismissAlert(), true);
  const ev = game.fireEvent('supply_delay', { target: 'POW' });
  assert.equal(ev.ok, true, ev.reason);
  // and a broadcast fired from the timeline is the same press as any other beat
  game.activateRound('R2'); game.activateRound('R3'); game.activateRound('R4');
  const beat = game.state.timeline.find((t) => t.transition);
  assert.equal(game.fireTimelineItem(beat.id).ok, true);
  assert.equal(game.state.alert.title, 'TRAINING PROTOCOLS CONCLUDED');
});

test('RT-008: the screens and the paper say so', () => {
  const control = fs.readFileSync(path.join(ROOT, 'public', 'control', 'control.js'), 'utf8');
  assert.ok(/NOTHING PLAYS ON START/.test(control), 'the control panel does not say why the broadcast waits');
  const guide = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'build_guidebook.js'), 'utf8');
  assert.ok(!/plays on START|plays that round|plays when START/.test(guide), 'the guidebook still promises a broadcast on START');
  assert.ok(/START runs the clock and plays nothing/.test(guide));
  const wall = fs.readFileSync(path.join(ROOT, 'public', 'wall', 'wall.js'), 'utf8');
  assert.ok(/ROUND_FLASH_MS/.test(wall) && /round-flash-text/.test(wall), 'the wall no longer flashes the number');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(/NEXT ROUND and START play nothing/.test(readme));
});
