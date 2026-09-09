'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { newGame, logEvents } = require('./helpers');
const { submitCode, normaliseCode } = require('../lib/resolve');

const submit = (game, over = {}) =>
  submitCode(game, {
    sector: 'POW', fault_code: 'F-201', code: 'P-04-340', workers_assigned: 2, ...over,
  });

test('F-201 accepts BOTH seeded codes — the discrepancy must never be punished', () => {
  for (const code of ['P-04-340', 'P-04-290']) {
    const game = newGame();
    game.fireFault('F-201', 'POW');
    const res = submit(game, { code });
    assert.equal(res.accepted, true, `${code} should resolve F-201`);
    assert.equal(res.reason, null);
  }
});

test('F-201 resolution stops decay and applies recovery', () => {
  const game = newGame();
  game.fireFault('F-201', 'POW');
  game.setIntegrity('POW', 60);
  submit(game);

  const fault = game.state.sectors.POW.faults.find((f) => f.code === 'F-201');
  assert.equal(fault.resolved, true);
  assert.equal(game.state.sectors.POW.integrity, 65, '+5 recovery applied');

  const before = game.state.sectors.POW.integrity;
  game.tick(60000);
  assert.equal(game.state.sectors.POW.integrity, before, 'a resolved fault stops decaying');
});

test('F-210 has no procedure: every submission is rejected, whatever the code', () => {
  const game = newGame();
  game.fireFault('F-210', 'AGR');

  for (const code of ['P-04-401', 'ANYTHING', '', 'P-05-915']) {
    const res = submitCode(game, {
      sector: 'AGR', fault_code: 'F-210', code, workers_assigned: 0,
    });
    assert.equal(res.accepted, false);
    assert.equal(res.reason, 'no_procedure', `"${code}" must yield no_procedure`);
  }
});

test('no_procedure is driven by the EMPTY ARRAY, not by the fault code F-210', () => {
  const game = newGame();
  game.fireFault('F-201', 'POW');
  // A hypothetical future false alarm: same empty-array shape, different code.
  game.state.sectors.POW.faults.find((f) => f.code === 'F-201').valid_codes = [];

  const res = submit(game);
  assert.equal(res.reason, 'no_procedure',
    'any fault with an empty valid_codes array behaves as a false alarm');
});

test('F-210 can only be cleared by the facilitator', () => {
  const game = newGame();
  game.fireFault('F-210', 'AGR');
  assert.equal(game.clearFault('AGR', 'F-210', 'false alarm confirmed'), true);
  assert.equal(game.findFault('AGR', 'F-210'), null);
});

test('three consecutive invalid codes trigger a 20s lockout', () => {
  const game = newGame();
  game.fireFault('F-201', 'POW');

  let res;
  for (let i = 0; i < 3; i += 1) res = submit(game, { code: 'P-04-000' });

  assert.equal(res.reason, 'invalid_code');
  assert.equal(res.locked_until_s, 20);
  assert.equal(res.attempts, 3);

  // A correct code while locked is still refused — the lock is the point.
  assert.equal(submit(game).reason, 'locked');
});

test('lockout expires on the tick and the fault becomes solvable again', () => {
  const game = newGame();
  game.fireFault('F-201', 'POW');
  for (let i = 0; i < 3; i += 1) submit(game, { code: 'P-04-000' });

  game.tick(21000);
  assert.equal(submit(game).accepted, true);
});

test('attempts is a LIFETIME counter; the lockout counter resets on accept', () => {
  const game = newGame();
  game.fireFault('F-201', 'POW');

  submit(game, { code: 'P-04-000' });
  submit(game, { code: 'P-04-000' });
  const fault = game.state.sectors.POW.faults.find((f) => f.code === 'F-201');
  assert.equal(fault.consecutive_invalid, 2);

  const res = submit(game);
  assert.equal(res.accepted, true);
  assert.equal(res.attempts, 3, 'lifetime attempts keeps climbing through the accept');
  assert.equal(fault.consecutive_invalid, 0, 'consecutive counter is cleared');
});

test('crew requirement is enforced at both ends', () => {
  const game = newGame();
  game.fireFault('F-201', 'POW');       // crew_required: 2

  assert.equal(submit(game, { workers_assigned: 1 }).reason, 'insufficient_crew');
  assert.equal(submit(game, { workers_assigned: 99 }).reason, 'insufficient_crew',
    'cannot assign more workers than are actually standing');
  assert.equal(submit(game, { workers_assigned: 2 }).accepted, true);
});

test('a failed crew check does not count as an attempt', () => {
  const game = newGame();
  game.fireFault('F-201', 'POW');
  submit(game, { workers_assigned: 0 });
  const fault = game.state.sectors.POW.faults.find((f) => f.code === 'F-201');
  assert.equal(fault.attempts, 0, 'only real code guesses are diagnostic');
});

test('code normalisation: case, whitespace and dash variants all accept', () => {
  for (const code of [' p-04-340 ', 'P–04–340', 'P - 04 - 340', 'p_04_340', 'P--04--340']) {
    const game = newGame();
    game.fireFault('F-201', 'POW');
    assert.equal(submit(game, { code }).accepted, true, `"${code}" should normalise and accept`);
  }
});

test('normaliseCode leaves a canonical code untouched', () => {
  assert.equal(normaliseCode('P-06-142-261'), 'P-06-142-261');
});

test('two-spec R3 codes resolve as a single composite string', () => {
  const game = newGame();
  game.fireFault('F-301', 'POW');
  const res = submitCode(game, {
    sector: 'POW', fault_code: 'F-301', code: 'P-06-142-261', workers_assigned: 3,
  });
  assert.equal(res.accepted, true);
});

test('unknown fault, wrong sector and dark sector are all refused', () => {
  const game = newGame();
  game.fireFault('F-201', 'POW');

  assert.equal(submit(game, { fault_code: 'F-999' }).reason, 'unknown_fault');
  assert.equal(submit(game, { sector: 'WTR' }).reason, 'unknown_fault',
    'F-201 belongs to POW; WTR cannot resolve it');

  game.setStatus('POW', 'DARK');
  assert.equal(submit(game).reason, 'sector_dark');
});

test('resource deduction on resolve is configuration: on by default', () => {
  const game = newGame();
  game.fireFault('F-201', 'POW');                    // requires 2 parts, 1 water
  const before = { ...game.state.sectors.POW.inventory };
  const res = submit(game);
  assert.deepEqual(res.consumed, { parts: 2, water: 1 });
  assert.equal(game.state.sectors.POW.inventory.parts, before.parts - 2);
  assert.equal(game.state.sectors.POW.inventory.water, before.water - 1);
});

test('with deduct_resources_on_resolve off, resolve is a declaration only (contract §3.5)', () => {
  const game = newGame();
  game.patchConfig({ deduct_resources_on_resolve: false });
  game.fireFault('F-201', 'POW');
  const before = { ...game.state.sectors.POW.inventory };
  const res = submit(game);
  assert.equal(res.accepted, true);
  assert.equal(res.consumed, null);
  assert.deepEqual(game.state.sectors.POW.inventory, before,
    'the server must not touch inventory on resolve when the switch is off');
});

test('a short team is only refused when resolve_requires_resources is on', () => {
  const game = newGame();
  game.fireFault('F-201', 'POW');
  game.setInventory('POW', { power: 0, water: 0, parts: 0, med: 0 });
  assert.equal(submit(game).accepted, true, 'default: the argument stays in the room');

  const strict = newGame();
  strict.patchConfig({ resolve_requires_resources: true });
  strict.fireFault('F-201', 'POW');
  strict.setInventory('POW', { power: 0, water: 0, parts: 0, med: 0 });
  const res = submit(strict);
  assert.equal(res.reason, 'insufficient_resources');
  assert.deepEqual(res.short, { parts: 2, water: 1 });
  const fault = strict.state.sectors.POW.faults[0];
  assert.equal(fault.attempts, 0, 'a resource refusal is not a code guess');
});

test('a fault can be resolved even with inventory the team does not have', () => {
  const game = newGame();
  game.fireFault('F-201', 'POW');
  game.setInventory('POW', { power: 0, water: 0, parts: 0, med: 0 });
  assert.equal(submit(game).accepted, true,
    'enforcement would push the argument onto the screen, off the transcript');
});

test('every submission is logged, accepted and rejected alike', () => {
  const game = newGame();
  game.fireFault('F-201', 'POW');
  submit(game, { code: 'P-04-000' });
  submit(game);

  const submits = logEvents(game, 'submit');
  assert.equal(submits.length, 2);
  assert.equal(submits[0].accepted, false);
  assert.equal(submits[0].reason, 'invalid_code');
  assert.equal(submits[1].accepted, true);
  assert.equal(submits[1].workers, 2);
});
