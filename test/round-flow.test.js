'use strict';
/**
 * THE SIMPLIFIED ROUND FLOW (spec ROUND-001 … ROUND-006).
 *
 * The visible structure of the day is five numbers: Round 0 to Round 4. No
 * descriptive title, no subtitle, no objective, no phase word, on any screen
 * either side of the glass. A title like "Core Failure" is a spoiler — it
 * tells a table what is about to be done to it, and the measurement this
 * product sells depends on that being a surprise.
 *
 * Underneath, nothing changed: each round still carries its own inject
 * timeline and fault pool, Round 4 still runs the aftershock material, and a
 * round change still resets NOTHING.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { newGame, logEvents, rounds } = require('./helpers');
const { forSector, forBigscreen, forControl } = require('../lib/visibility');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const SECTOR_INDEX = read('public', 'sector', 'index.html');
const SECTOR_SCRIPT = read('public', 'sector', 'sector.js');
const WALL_INDEX = read('public', 'wall', 'index.html');
const WALL_SCRIPT = read('public', 'wall', 'wall.js');
const CONTROL_INDEX = read('public', 'control', 'index.html');
const CONTROL_SCRIPT = read('public', 'control', 'control.js');

/** Every word the spec forbids on a screen, on either side of the glass. */
const FORBIDDEN = [
  'Orientation', 'Stable Operations', 'Stable Ops', 'Interdependence',
  'Core Failure', 'Aftershock', 'Final Crisis', 'Temporary Stabilisation', 'Escalation',
];

/** What a page would actually print: not its comments, not its element ids. */
function visible(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/\s(?:id|class|data-[\w-]+)="[^"]*"/g, '');
}
/** What a script would print: string and template literals, minus its comments. */
function strings(js) {
  const body = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return (body.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) || []).join('\n');
}

function live(phase = 'ROUND_2') {
  const game = newGame();
  game.setPhase(phase);
  game.clock('start');
  return game;
}

// -- the sequence --------------------------------------------------------------

test('the visible sequence is Round 0 to Round 4, and then the end', () => {
  const game = newGame();
  const seen = [game.state.phase];
  while (game.nextPhase()) seen.push(game.state.phase);
  assert.deepEqual(seen, ['ROUND_0', 'ROUND_1', 'ROUND_2', 'ROUND_3', 'ROUND_4', 'ENDED']);
  // One phase per round: what the engine tracks and what a screen shows cannot
  // drift apart, because they are the same thing.
  const phases = rounds.phases.filter((p) => p.mode !== 'ENDED');
  assert.deepEqual(phases.map((p) => p.number), [0, 1, 2, 3, 4]);
  assert.deepEqual(phases.map((p) => p.round), ['R0', 'R1', 'R2', 'R3', 'R4']);
  for (const p of rounds.phases) {
    assert.ok(!FORBIDDEN.some((w) => String(p.name).includes(w)), `${p.id} is named "${p.name}"`);
  }
});

test('ROUND-001: a player in Round 2 sees "Round 2" and nothing else about it', () => {
  const game = live('ROUND_2');
  for (const code of ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM']) {
    const f = forSector(game, code);
    assert.equal(f.round_number, 2, `${code} was not told the round number`);
    assert.equal(f.round_name, undefined, `${code} was told a round name`);
    assert.equal(f.phase, undefined, `${code} was told the phase`);
    assert.equal(f.phase_name, undefined);
    assert.equal(f.phase_hint, undefined, `${code} was told what the round is for`);
  }
  // And the markup prints the number, with no title beside it.
  assert.ok(/Current round/.test(SECTOR_INDEX), 'the header has no round');
  assert.ok(/`Round \$\{state\.round_number\}`/.test(SECTOR_SCRIPT), 'the header does not print the number');
  const shown = visible(SECTOR_INDEX);
  for (const word of FORBIDDEN) assert.ok(!shown.includes(word), `the sector page prints "${word}"`);
  for (const word of FORBIDDEN) assert.ok(!strings(SECTOR_SCRIPT).includes(word), `sector.js prints "${word}"`);
});

test('ROUND-002: Admin in Round 3 sees "Round 3", and keeps its round and timer controls', () => {
  const game = live('ROUND_3');
  const f = forControl(game);
  assert.equal(f.round_number, 3);
  assert.equal(f.round_name, undefined, 'the console was sent a round name');
  assert.equal(f.phase_name, undefined, 'the console was sent a phase name');
  assert.equal(f.phase, 'ROUND_3', 'the console still needs the id to navigate and to log');
  assert.deepEqual(f.phases.map((p) => p.number), [0, 1, 2, 3, 4, null]);
  assert.ok(f.phases.every((p) => p.name === undefined), 'the navigator carries names it could print');

  // The controls the spec asks for are all present.
  for (const id of ['btn-prev-round', 'btn-next-phase', 'clock-minus', 'clock-plus', 'btn-timer']) {
    assert.ok(CONTROL_INDEX.includes(`id="${id}"`), `the console lacks ${id}`);
  }
  assert.ok(/CURRENT ROUND/.test(CONTROL_INDEX), 'the top bar does not name the round field');
  assert.ok(/`Round \$\{state\.round_number\}`/.test(CONTROL_SCRIPT), 'the console does not print the number');
  const shown = visible(CONTROL_INDEX);
  for (const word of FORBIDDEN) assert.ok(!shown.includes(word), `the console prints "${word}"`);
  for (const word of FORBIDDEN) assert.ok(!strings(CONTROL_SCRIPT).includes(word), `control.js prints "${word}"`);
});

test('ROUND-004: Round 4 is a number on every screen; its mechanics still run', () => {
  const game = live('ROUND_4');
  assert.equal(forSector(game, 'POW').round_number, 4);
  assert.equal(forBigscreen(game).round_number, 4);
  assert.equal(forControl(game).round_number, 4);
  for (const f of [forSector(game, 'POW'), forBigscreen(game), forControl(game)]) {
    assert.ok(!JSON.stringify(f).includes('Aftershock'), 'the word reached a frame');
  }
  // The engine still knows: R4 is armed, with R4's own inject script.
  assert.equal(game.state.round, 'R4');
  assert.ok(game.state.timeline.every((i) => i.round === 'R4'), "Round 4's injects are not armed");
  const wall = visible(WALL_INDEX);
  for (const word of FORBIDDEN) assert.ok(!wall.includes(word), `the wall prints "${word}"`);
  for (const word of FORBIDDEN) assert.ok(!strings(WALL_SCRIPT).includes(word), `wall.js prints "${word}"`);
});

// -- the transition -------------------------------------------------------------

test('ROUND-003: a round change starts no rest, no debrief, no reflection, and resets nothing', () => {
  const game = live('ROUND_2');
  game.fireFault('F-201', 'POW');
  game.injure('MED', 2);
  game.setInventory('POW', { power: 7, water: 1, parts: 0, med: 2 });
  game.setIntegrity('WTR', 38);
  game.state.sectors.POW.inventory.parts = 3;
  const upgrade = game.startGeneratorUpgrade('POW');
  assert.equal(upgrade.ok, true, upgrade.reason);
  const request = game.requestTransfer({ from: 'WTR', to: 'MED', resource: 'water', amount: 1, by: 'MED' });
  const transfer = game.createTransfer({ from: 'AGR', to: 'MED', resource: 'parts', amount: 1, by: 'AGR' });
  game.tick(2000);

  const before = {
    mode: game.state.mode,
    clock: game.state.round_clock.remaining_s,
    running: game.state.round_clock.running,
    cycle: game.state.cycle.number,
    sectors: JSON.stringify(game.state.sectors),
    requests: game.state.requests.map((r) => r.status).join(','),
    transfers: game.state.transfers.map((t) => t.status).join(','),
    agr: JSON.stringify(game.state.agr),
    council: JSON.stringify(game.state.council),
  };

  assert.equal(game.nextPhase(), true);
  assert.equal(game.state.phase, 'ROUND_3');

  // No stage of any kind was entered.
  assert.equal(game.state.mode, before.mode, 'the mode changed');
  assert.equal(game.state.mode, 'PLAY');
  assert.equal(game.frozen, false, 'the game froze');
  assert.equal(game.state.round_clock.running, before.running, 'MASTER TIME stopped');
  assert.equal(game.state.round_clock.remaining_s, before.clock, 'the clock was reset');
  assert.equal(game.state.cycle.number, before.cycle, 'an upkeep pass was charged');

  // And nothing in the city moved.
  assert.equal(JSON.stringify(game.state.sectors), before.sectors,
    'health, stock, workers, injuries, generators or upgrades changed');
  assert.equal(game.state.requests.map((r) => r.status).join(','), before.requests, 'a request was swept');
  assert.equal(game.state.transfers.map((t) => t.status).join(','), before.transfers, 'a transfer was swept');
  assert.equal(JSON.stringify(game.state.agr), before.agr, 'AGR was dealt again');
  assert.equal(JSON.stringify(game.state.council), before.council, 'Council state moved');
  assert.ok(game.findFault('POW', 'F-201'), 'the open fault was cleared');
  assert.equal(game.findRequest(request.request.id).status, 'REQUESTED');
  assert.equal(game.findTransfer(transfer.transfer.id).status, 'PENDING_TRN_APPROVAL');
  assert.ok(game.generatorFor('POW').pending, 'the upgrade in progress was cancelled');

  // No screen has a rest, debrief or reflection to show, because none exists.
  for (const src of [SECTOR_INDEX, WALL_INDEX, CONTROL_INDEX]) {
    for (const word of ['BREATHER', 'REFLECTION', 'REST PERIOD', 'ROUND COMPLETE']) {
      assert.ok(!visible(src).includes(word), `a screen offers ${word}`);
    }
  }
});

test('going back a round is just as harmless as going forward', () => {
  const game = live('ROUND_3');
  game.fireFault('F-201', 'POW');
  game.setIntegrity('POW', 44);
  const before = JSON.stringify(game.state.sectors);
  assert.equal(game.setPhase('ROUND_2'), true);
  assert.equal(game.state.round, 'R2');
  assert.equal(JSON.stringify(game.state.sectors), before, 'going back changed the city');
  assert.ok(game.findFault('POW', 'F-201'), 'going back cleared a fault');
  assert.ok(game.state.timeline.every((i) => i.round === 'R2'), "R2's injects were not re-armed");
});

// -- the timer ------------------------------------------------------------------

test('ROUND-005/006: ±60 s moves the clock and nothing else, and never below 00:00', () => {
  const game = live('ROUND_2');
  game.tick(1000);
  const snapshot = () => JSON.stringify({
    s: game.state.sectors, t: game.state.transfers, r: game.state.requests,
    c: game.state.cycle.number, p: game.state.phase, round: game.state.round, agr: game.state.agr,
  });

  const before = snapshot();
  const t0 = game.state.round_clock.remaining_s;
  assert.equal(game.clock('add', 60, 'round', { reason: 'running long' }).ok, true);
  assert.equal(Math.round(game.state.round_clock.remaining_s - t0), 60);
  assert.equal(game.state.round_clock.running, true, 'a running clock stopped');
  assert.equal(snapshot(), before, 'the adjustment moved other game state');

  game.clock('add', -60, 'round', { reason: 'ahead' });
  assert.equal(Math.round(game.state.round_clock.remaining_s), Math.round(t0));
  assert.equal(snapshot(), before, 'the adjustment moved other game state');

  // The floor holds, and a paused clock stays paused.
  game.clock('set', 30, 'round', { reason: 'nearly over' });
  game.clock('add', -60, 'round', { reason: 'past the end' });
  assert.equal(game.state.round_clock.remaining_s, 0, 'the clock went below 00:00');
  game.pause();
  game.clock('add', 60, 'round', { reason: 'more time' });
  assert.equal(game.state.paused, true, 'the adjustment resumed the session');
  assert.equal(game.state.round_clock.remaining_s, 60);
  // add, add, set, add, add — every hand on the clock writes its own line.
  assert.equal(logEvents(game, 'admin_timer_adjust').length, 5, 'every hand on the clock is logged');
});

// -- the transition marker --------------------------------------------------------

test('the wall marks a round change briefly, says only the number, and blocks nothing', () => {
  assert.ok(/id="round-flash"/.test(WALL_INDEX), 'the wall has no round marker');
  assert.ok(/const ROUND_FLASH_MS = (\d+);/.test(WALL_SCRIPT));
  const ms = Number(WALL_SCRIPT.match(/const ROUND_FLASH_MS = (\d+);/)[1]);
  assert.ok(ms > 0 && ms <= 3000, `the marker stays ${ms}ms, the ceiling is 3000`);
  assert.ok(/`ROUND \$\{n\}`/.test(WALL_SCRIPT), 'the marker prints something other than the number');
  const css = read('public', 'wall', 'wall.css');
  const block = css.slice(css.indexOf('.round-flash {'), css.indexOf('.round-flash b'));
  assert.ok(/pointer-events:\s*none/.test(block), 'the marker can take a click from the room');
});
