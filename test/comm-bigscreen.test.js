'use strict';
/**
 * COMM CITY BIG SCREEN CONTROL (spec COMM-BS-001 … COMM-BS-009).
 *
 * The whole design rests on one sentence: COMM controls what the city is
 * TOLD, never what is happening. So most of what follows checks that a COMM
 * action moved the display and moved nothing else — that a sector reported
 * STABLE is still bleeding out underneath, that eight seconds of emphasis
 * cannot dim a brownout, and that what COMM knows privately stays private
 * until COMM decides otherwise.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { newGame, logEvents } = require('./helpers');
const { forSector, forBigscreen, forControl } = require('../lib/visibility');
const { GameState } = require('../lib/state');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const SECTOR_INDEX = read('public', 'sector', 'index.html');
const SECTOR_SCRIPT = read('public', 'sector', 'sector.js');
const WALL_SCRIPT = read('public', 'wall', 'wall.js');
const WALL_CSS = read('public', 'wall', 'wall.css');
const BASE_CSS = read('public', 'shared', 'base.css');

const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];

/** Everything the simulation owns, in one string. If this moves, COMM cheated. */
function world(game) {
  const st = game.state;
  return JSON.stringify({
    sectors: st.sectors,
    core: st.core_integrity,
    faults: Object.values(st.sectors).map((s) => s.faults.map((f) => [f.code, f.resolved, f.status])),
    requests: st.requests, transfers: st.transfers, healing: st.healing,
    council: st.council, continuity: st.continuity_order,
    round: st.round, phase: st.phase, cycle: st.cycle.number,
    // MASTER TIME is deliberately absent: it moves with every tick whatever
    // COMM does, so the clock is asserted on its own terms below.
    effects: st.effects, agr: st.agr,
    alert: st.alert, blackout: st.blackout,
  });
}

function live() {
  const game = newGame();
  game.setPhase('ROUND_2');
  game.clock('start');
  return game;
}

// -- the page, and the absence of an alert -------------------------------------

test('COMM-BS-001: COMM has a CITY BIG SCREEN CONTROL page, and no alert control at all', () => {
  const game = live();
  // The page is offered to COMM and to nobody else.
  assert.equal(forSector(game, 'COM').broadcast.editable, true);
  for (const code of SECTORS.filter((c) => c !== 'COM')) {
    const b = forSector(game, code).broadcast;
    assert.equal(b.editable, false, `${code} can edit the board`);
    assert.equal(b.rows, undefined, `${code} was sent the board`);
    assert.equal(b.statuses, undefined);
  }
  assert.ok(/id="bigscreen-page"/.test(SECTOR_INDEX), 'there is no Big Screen page');
  assert.ok(/data-page="bigscreen"[^>]*>CITY BIG SCREEN CONTROL/.test(SECTOR_INDEX), 'the deck does not offer it');
  for (const section of ['CITY BOARD', 'CITY BROADCAST', 'SECTOR FOCUS']) {
    assert.ok(SECTOR_INDEX.includes(`>${section}<`), `the page has no ${section} section`);
  }

  // No alert-raising control exists for a sector. The only alert markup on a
  // console is the RECEIVER of the facilitator's alert, which the spec keeps.
  assert.ok(!/id="[^"]*alert[^"]*"[^>]*>\s*(RAISE|NEW|PUBLISH|SEND|CLEAR)/i.test(SECTOR_INDEX), 'a console can raise an alert');
  for (const bad of ["type: 'alert'", "type:'alert'", 'com_alert', 'sector_alert']) {
    assert.ok(!SECTOR_SCRIPT.includes(bad), `sector.js can send ${bad}`);
  }
  // …and the facilitator's own alert is untouched.
  assert.equal(typeof game.setAlert, 'function', "the facilitator's alert was removed");
});

test('the page is COMM\'s alone: another table cannot reach it or write through it', () => {
  const game = live();
  assert.ok(/if \(page === 'bigscreen' && SECTOR !== 'COM'\)/.test(SECTOR_SCRIPT),
    'another table can open the page by hand');
  // The focus intent names its target in `focus`, never `sector`: a sector
  // message naming another table is refused before it reaches the reducer,
  // and COMM points at every table but its own.
  assert.ok(/type: 'com_sector_focus', focus:/.test(SECTOR_SCRIPT), 'the focus intent would be refused as wrong_sector');
  assert.equal(game.setBroadcastRow('MED', { status: 'STABLE' }, { by: 'POW' }).reason, 'com_edit_forbidden');
  assert.equal(game.setBroadcastAnnouncement({ headline: 'x' }, { by: 'AGR' }).reason, 'com_edit_forbidden');
  assert.equal(game.setSectorFocus('POW', { by: 'WTR' }).reason, 'com_edit_forbidden');
});

// -- the board ------------------------------------------------------------------

test('COMM-BS-002: a reported status moves the board and nothing else', () => {
  const game = live();
  game.setIntegrity('MED', 24);
  const before = world(game);

  const r = game.setBroadcastRow('MED', { status: 'STABLE' }, { by: 'COM' });
  assert.equal(r.ok, true);
  assert.equal(r.row.status, 'STABLE');

  // The city is told STABLE. The city is not stable.
  assert.equal(forBigscreen(game).broadcast.rows.MED.status, 'STABLE');
  assert.equal(game.state.sectors.MED.integrity, 24, 'reporting changed the sector');
  assert.equal(world(game), before, 'reporting changed the simulation');
  assert.ok(logEvents(game, 'com_row_updated').length, 'the claim was not recorded');

  // Only the four words, and clearing is a choice of its own.
  assert.deepEqual(GameState.REPORTED_STATUSES, ['STABLE', 'DEGRADED', 'CRITICAL', 'DARK']);
  assert.equal(game.setBroadcastRow('MED', { status: 'FINE' }, { by: 'COM' }).reason, 'invalid_status');
  assert.equal(game.setBroadcastRow('MED', { status: null }, { by: 'COM' }).row.status, null);
  // Every sector is independent.
  game.setBroadcastRow('POW', { status: 'CRITICAL' }, { by: 'COM' });
  const rows = forBigscreen(game).broadcast.rows;
  assert.equal(rows.POW.status, 'CRITICAL');
  assert.equal(rows.MED.status, null);
  assert.equal(rows.WTR.status, null);
});

test('the wall shows the reported word beside the real one, never instead of it', () => {
  assert.ok(/class="rep-said"/.test(WALL_SCRIPT), 'the card has nowhere to print the report');
  assert.ok(/\.rep-said:empty \{ display: none; \}/.test(WALL_CSS), 'an unreported condition holds a line open');
  assert.ok(/rows\[code\] \|\| \{\}\)\.status/.test(WALL_SCRIPT), 'the card does not read the reported status');
  // The card's own health and status line are still rendered from the sector.
  assert.ok(/setText\(card\.querySelector\('\.shc-word'\), B\.CARD_WORD\[state\]\)/.test(WALL_SCRIPT),
    "the card stopped printing the system's own word");
  // Since 2026-09-24 real health is the figure and the bar under it, not a
  // labelled ring — the reported word still sits beneath both.
  assert.ok(/setText\(card\.querySelector\('\.shc-pct'\), value\)/.test(WALL_SCRIPT), 'the card stopped printing real health');
  assert.ok(/shc-bar-fill/.test(WALL_SCRIPT), 'the card stopped drawing real health');
  // And the reported word is visually subordinate: it never gets the status colour.
  assert.ok(/\.rep-said \{[^}]*--ink-faint/.test(WALL_CSS), 'the reported word is as loud as the real one');
});

// -- the broadcast ----------------------------------------------------------------

test('COMM-BS-003/004: one active broadcast, replaced by the next, removed by CLEAR', () => {
  const game = live();
  const before = world(game);

  assert.equal(game.setBroadcastAnnouncement({ headline: '', message: '  ' }, { by: 'COM' }).reason, 'empty_announcement');
  const first = game.setBroadcastAnnouncement({ headline: 'HOLD POWER', message: 'MED needs 2 power' }, { by: 'COM' });
  assert.equal(first.ok, true);
  assert.equal(forBigscreen(game).broadcast.announcement.headline, 'HOLD POWER');
  assert.equal(world(game), before, 'publishing changed the simulation');
  assert.equal(game.state.alert, null, 'publishing raised a system alert');

  // A second publish replaces the first: there is only ever one.
  game.setBroadcastAnnouncement({ headline: 'SECOND', message: 'replaces it' }, { by: 'COM' });
  const live2 = forBigscreen(game).broadcast.announcement;
  assert.equal(live2.headline, 'SECOND');
  assert.equal(live2.message, 'replaces it');

  // CLEAR removes the broadcast and leaves the rest of the screen alone.
  game.setBroadcastRow('POW', { status: 'DEGRADED', power: 4 }, { by: 'COM' });
  const boardBefore = JSON.stringify(forBigscreen(game).broadcast.rows);
  assert.equal(game.clearBroadcastAnnouncement({ by: 'COM' }).ok, true);
  assert.equal(forBigscreen(game).broadcast.announcement, null);
  assert.equal(JSON.stringify(forBigscreen(game).broadcast.rows), boardBefore, 'CLEAR reset the board too');
  assert.equal(game.state.alert, null);
  assert.ok(logEvents(game, 'com_announcement_published').length === 2);
  assert.ok(logEvents(game, 'com_announcement_cleared').length === 1);
});

// -- sector focus -------------------------------------------------------------------

test('COMM-BS-005: focus emphasises one sector for eight seconds and changes nothing', () => {
  const game = live();
  const before = world(game);

  const r = game.setSectorFocus('POW', { by: 'COM' });
  assert.equal(r.ok, true);
  assert.equal(r.focus.sector, 'POW');
  assert.equal(r.focus.duration_s, 8);
  assert.equal(world(game), before, 'focus changed the simulation');
  assert.equal(forBigscreen(game).broadcast.focus.sector, 'POW');

  // One at a time: a second focus replaces the first.
  game.setSectorFocus('AGR', { by: 'COM' });
  assert.equal(game.focusView().sector, 'AGR');

  // And it expires on its own, without anybody pressing anything.
  const clockBefore = game.state.round_clock.remaining_s;
  game.tick(7000);
  assert.ok(game.focusView(), 'focus ended early');
  game.tick(2000);
  assert.equal(game.focusView(), null, 'focus outlived its eight seconds');
  assert.equal(world(game), before, 'expiry changed the simulation');
  // The clock ran, as it always does, and focus neither stopped nor moved it.
  assert.equal(Math.round(clockBefore - game.state.round_clock.remaining_s), 9, 'focus touched MASTER TIME');
  assert.equal(game.state.round_clock.running, true);
  assert.equal(logEvents(game, 'com_sector_focus_started').length, 2);
  assert.ok(logEvents(game, 'com_sector_focus_ended').length >= 1);
  assert.equal(game.setSectorFocus('NOPE', { by: 'COM' }).reason, 'unknown_sector');
});

test('COMM-BS-006/008: focus cannot dim a brownout, a DARK sector or a Core warning', () => {
  const game = live();
  game.setStatus('POW', 'BROWNOUT');
  game.setIntegrity('WTR', 0);
  const before = world(game);

  game.setSectorFocus('POW', { by: 'COM' });
  assert.equal(game.state.sectors.POW.status, 'BROWNOUT', 'focus moved the brownout');
  assert.equal(forBigscreen(game).sectors.POW.status, 'BROWNOUT', 'the wall stopped drawing the brownout');
  assert.equal(forBigscreen(game).sectors.WTR.status, 'DARK', 'the wall stopped drawing DARK');
  assert.equal(world(game), before);

  // COMM has no way to touch the system's own marks: the only thing it writes
  // is the focus ring, which is additive and sets no opacity anywhere.
  const ring = BASE_CSS.slice(BASE_CSS.indexOf('.mo-region .mo-focus-ring'), BASE_CSS.indexOf('.mo-region .mo-focus-ring') + 260);
  assert.ok(/fill: none/.test(ring), 'the focus ring fills the region');
  assert.ok(/opacity: 0;/.test(ring), 'the focus ring is on by default');
  assert.ok(!/\.mo-region\.focused \.mo-dim/.test(WALL_CSS), 'focus touches the state dim');
  assert.ok(!/\.mo-region\.focused \.mo-edge/.test(WALL_CSS), 'focus touches the state edge');
  // The reported status is a claim on the card, not a status the map draws.
  game.setBroadcastRow('POW', { status: 'STABLE' }, { by: 'COM' });
  assert.equal(forBigscreen(game).sectors.POW.status, 'BROWNOUT', 'a report overrode the real status');
});

// -- intelligence ---------------------------------------------------------------------

test('COMM-BS-007: intelligence is COMM\'s, private, and never published by itself', () => {
  const game = live();
  assert.ok(forSector(game, 'COM').intel, 'COM has no intelligence');
  for (const code of SECTORS.filter((c) => c !== 'COM')) {
    assert.equal(forSector(game, code).intel, undefined, `${code} was sent COM's intelligence`);
  }
  assert.equal(forBigscreen(game).intel, undefined, 'the wall was sent intelligence');
  // Nothing about intelligence reaches the board or the broadcast on its own.
  const board = forBigscreen(game).broadcast;
  assert.equal(board.announcement, null);
  assert.ok(Object.values(board.rows).every((r) => r.status === null));
  // It reads on COMM's overview, beside the city feed — not on the Big
  // Screen page, where every control publishes.
  assert.ok(/id="intel-block"/.test(SECTOR_INDEX), 'intelligence has no panel on the overview');
  assert.ok(!/data-page="intel"/.test(SECTOR_INDEX), 'the deck still has an intelligence door');
  assert.ok(!/id="intel-page"/.test(SECTOR_INDEX), 'the intelligence page was left behind');
  const overview = SECTOR_INDEX.slice(SECTOR_INDEX.indexOf('id="columns"'), SECTOR_INDEX.indexOf('id="bigscreen-page"'));
  assert.ok(overview.includes('id="intel-block"') && overview.includes('id="intel"'),
    'intelligence is not on the overview');
  assert.ok(overview.indexOf('id="city-block"') < overview.indexOf('id="intel-block"'),
    'intelligence does not sit with the city feed');
  const bigScreenPage = SECTOR_INDEX.slice(SECTOR_INDEX.indexOf('id="bigscreen-page"'));
  assert.ok(!bigScreenPage.includes('id="intel"'), 'intelligence was merged into the Big Screen page');
  // COMM alone sees the panel, and never while the Council has the column.
  assert.ok(/show\(\$\('intel-block'\), SECTOR === 'COM' && !council/.test(SECTOR_SCRIPT),
    'the intelligence panel is not gated to COMM');
});

// -- reconnect -------------------------------------------------------------------------

test('COMM-BS-009: a reconnect restores the board and the broadcast, but not an expired focus', () => {
  const game = live();
  game.setBroadcastRow('MED', { status: 'CRITICAL', med: 2 }, { by: 'COM' });
  game.setBroadcastAnnouncement({ headline: 'MED NEEDS POWER', message: 'Two units' }, { by: 'COM' });
  game.setSectorFocus('TRN', { by: 'COM' });

  // A reconnect is a fresh projection of the same state — no page reload of
  // any kind is involved, which is exactly why this holds.
  const fresh = forBigscreen(game);
  assert.equal(fresh.broadcast.rows.MED.status, 'CRITICAL');
  assert.equal(fresh.broadcast.rows.MED.med, 2);
  assert.equal(fresh.broadcast.announcement.headline, 'MED NEEDS POWER');
  assert.equal(fresh.broadcast.focus.sector, 'TRN');

  // A restart from snapshot keeps the board and the broadcast.
  const back = newGame({ runId: 'comm-restore' });
  back.restore(JSON.parse(JSON.stringify(game.serialise())));
  assert.equal(forBigscreen(back).broadcast.rows.MED.status, 'CRITICAL');
  assert.equal(forBigscreen(back).broadcast.announcement.headline, 'MED NEEDS POWER');

  // Once the eight seconds are gone, nothing brings the focus back.
  game.tick(9000);
  assert.equal(forBigscreen(game).broadcast.focus, null);
  const later = newGame({ runId: 'comm-restore-2' });
  later.restore(JSON.parse(JSON.stringify(game.serialise())));
  assert.equal(forBigscreen(later).broadcast.focus, null, 'an expired focus came back');
});

// -- the facilitator keeps everything it had -------------------------------------------

test('Admin authority is not reduced: it can still override every COMM surface', () => {
  const game = live();
  assert.equal(game.setBroadcastRow('MED', { status: 'DARK' }, { by: 'facilitator' }).ok, true);
  assert.equal(game.setBroadcastAnnouncement({ headline: 'ADMIN' }, { by: 'facilitator' }).ok, true);
  assert.equal(game.setSectorFocus('COM', { by: 'facilitator' }).ok, true);
  assert.ok(logEvents(game, 'facilitator_com_override').length >= 1);
  // And the console still sees the whole board.
  assert.ok(forControl(game).broadcast.rows.MED.status === 'DARK');
});
