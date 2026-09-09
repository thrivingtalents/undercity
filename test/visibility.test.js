'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { newGame } = require('./helpers');
const { forSector, forBigscreen, forControl } = require('../lib/visibility');

/** Every string in a payload, so we can assert an answer key never leaks. */
function flatten(value, out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value === 'object') {
    for (const v of Object.values(value)) flatten(v, out);
  } else {
    out.push(String(value));
  }
  return out;
}

function loaded() {
  const game = newGame();
  game.fireFault('F-201', 'POW');   // valid codes P-04-340 / P-04-290
  game.fireFault('F-103', 'WTR');
  game.fireFault('F-210', 'AGR');
  game.setIntegrity('WTR', 44);
  return game;
}

test('a sector sees its own faults in full', () => {
  const payload = forSector(loaded(), 'POW');
  const own = payload.sectors.POW;
  assert.equal(own.faults.length, 1);
  assert.equal(own.faults[0].code, 'F-201');
  assert.ok(own.inventory, 'own inventory is visible');
  assert.ok(own.workforce, 'own workforce is visible');
});

test('a sector learns nothing about another sector beyond a stale bar', () => {
  const payload = forSector(loaded(), 'POW');
  const other = payload.sectors.WTR;

  assert.equal(other.faults, undefined, 'no fault array for other sectors');
  assert.equal(other.inventory, undefined, 'no inventory for other sectors');
  assert.equal(other.workforce, undefined, 'no workforce for other sectors');
  assert.equal(other.delayed, true);
  assert.ok('integrity' in other && 'status' in other);
});

test('another sector\'s integrity is the 60s-old value, not the live one', () => {
  const game = loaded();                       // WTR set to 44 just now
  const payload = forSector(game, 'POW');
  assert.equal(payload.sectors.WTR.integrity, 100,
    'nothing is 60s old yet, so the starting value shows — never the present');
  assert.notEqual(payload.sectors.WTR.integrity, game.state.sectors.WTR.integrity);
});

test('the delayed view catches up once frames age past the window', () => {
  const game = loaded();
  // Backdate the buffer so the sampled frames are older than the delay window.
  game.sampleDelayed();
  for (const frame of game.delayed) frame.t -= 61000;

  const payload = forSector(game, 'POW');
  assert.equal(payload.sectors.WTR.integrity, 44, 'the aged frame is now visible');
});

test('COM sees other sectors\' fault codes and names live — the asymmetry engine', () => {
  const payload = forSector(loaded(), 'COM');
  assert.equal(payload.full_telemetry, true);

  const pow = payload.sectors.POW;
  assert.ok(Array.isArray(pow.faults), 'COM gets a fault array for other sectors');
  assert.equal(pow.faults[0].code, 'F-201');
  assert.equal(pow.faults[0].name, 'Coolant loop failure');
});

test('COM\'s exception is scoped: still no inventory, still a delayed bar', () => {
  const payload = forSector(loaded(), 'COM');
  const pow = payload.sectors.POW;

  assert.equal(pow.inventory, undefined, 'COM does not see others\' inventory');
  assert.equal(pow.workforce, undefined, 'COM does not see others\' workforce');
  assert.equal(pow.delayed, true, 'COM\'s view of the bars is delayed like everyone\'s');
  assert.equal(pow.faults[0].crew_required, undefined,
    'COM learns what is broken, not how to fix it');
});

test('non-COM sectors get full_telemetry false and no foreign fault arrays', () => {
  for (const code of ['POW', 'WTR', 'MED', 'TRN', 'AGR']) {
    const payload = forSector(loaded(), code);
    assert.equal(payload.full_telemetry, false, `${code} must not have full telemetry`);
    for (const [other, view] of Object.entries(payload.sectors)) {
      if (other === code) continue;
      assert.equal(view.faults, undefined, `${code} must not see ${other}'s faults`);
    }
  }
});

test('valid_codes NEVER appear in a sector payload', () => {
  for (const code of ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM']) {
    const strings = flatten(forSector(loaded(), code));
    assert.ok(!strings.includes('P-04-340'), `${code} payload leaked the answer key`);
    assert.ok(!strings.includes('P-04-290'), `${code} payload leaked the alternate code`);
    assert.ok(!JSON.stringify(forSector(loaded(), code)).includes('valid_codes'),
      `${code} payload contains a valid_codes field`);
  }
});

test('the wall names the worst fault and the stock, never the fix', () => {
  const payload = forBigscreen(loaded());
  const pow = payload.sectors.POW;
  assert.equal(pow.faults, undefined, 'no fault array — one headline fault only');
  assert.equal(pow.top_fault.code, 'F-201');
  assert.equal(pow.top_fault.name, 'Coolant loop failure');
  assert.equal(pow.top_fault.flavour, undefined, 'no flavour, no dependency clause');
  assert.equal(pow.top_fault.crew_required, undefined);
  assert.ok(pow.inventory, 'resource summary is on by default (spec §7)');
  assert.equal(typeof pow.unresolved_faults, 'number');
  const json = JSON.stringify(payload);
  assert.ok(!json.includes('valid_codes'));
  assert.ok(!json.includes('P-04-340'));
  assert.ok(!/Appendix C/i.test(json));
  assert.ok(payload.feed && payload.telemetry, 'feed and telemetry are public');
});

test('wall fault detail and inventory are switches, and COM going dark hides both', () => {
  const game = loaded();
  game.patchConfig({ wall_shows_inventory: false, wall_shows_faults: false });
  let payload = forBigscreen(game);
  assert.equal(payload.sectors.POW.top_fault, undefined);
  assert.equal(payload.sectors.POW.inventory, undefined);
  assert.equal(typeof payload.sectors.POW.unresolved_faults, 'number', 'counts always');

  game.patchConfig({ wall_shows_inventory: true, wall_shows_faults: true });
  game.setStatus('COM', 'DARK');
  payload = forBigscreen(game);
  assert.equal(payload.telemetry_degraded, true);
  assert.equal(payload.sectors.POW.top_fault, undefined, 'no sensors, no detail');
  assert.equal(payload.sectors.POW.inventory, undefined);
});

test('control receives the live answer key, undelayed', () => {
  const game = loaded();
  const payload = forControl(game);

  const pow = payload.sectors.POW;
  assert.deepEqual(pow.faults[0].valid_codes, ['P-04-340', 'P-04-290']);
  assert.equal(payload.sectors.WTR.integrity, 44, 'facilitator sees the present, not a delay');
  assert.ok(pow.inventory && pow.workforce);
});

test('control sees the empty valid_codes array that marks the false alarm', () => {
  const payload = forControl(loaded());
  const ghost = payload.sectors.AGR.faults.find((f) => f.code === 'F-210');
  assert.deepEqual(ghost.valid_codes, []);
  assert.equal(ghost.false_alarm, true);
});

test('the 290 telemetry reaches sectors and big screen and is never reconciled', () => {
  const game = loaded();
  assert.equal(forSector(game, 'WTR').telemetry.wtr_reservoir_pressure, 290);
  assert.equal(forBigscreen(game).telemetry.wtr_reservoir_pressure, 290);
  // 340 is a binder value; it must not appear anywhere in a broadcast frame.
  assert.ok(!flatten(forBigscreen(game)).includes('340'));
});

test('the dashboard withholds the dependency half, exactly as the card does', () => {
  const game = loaded();
  game.fireFault('F-302', 'WTR');   // "...buried in your own Appendix C."
  const payload = forSector(game, 'WTR');
  const fault = payload.sectors.WTR.faults.find((f) => f.code === 'F-302');

  assert.equal(fault.flavour, 'Lower reservoir wall cracking.');
  assert.ok(!fault.flavour.includes(';'), 'the dependency clause is cut');
});

test('no sector payload ever names a buried Appendix C spec', () => {
  // The six R3/R4 faults that need a buried spec must not advertise it. The
  // binder gives Appendix C no index entry on purpose (spec §4.1 p.10); a
  // dashboard that names it hands over the frustration-tolerance probe.
  const buried = ['F-302', 'F-305', 'F-401', 'F-402', 'F-403', 'F-404'];
  for (const code of buried) {
    const game = newGame();
    const def = game.faultsByCode.get(code);
    game.fireFault(code, def.sector);

    const json = JSON.stringify(forSector(game, def.sector));
    assert.ok(!/Appendix C/i.test(json), `${code}: sector payload names Appendix C`);
    assert.ok(!/\bburied\b/i.test(json), `${code}: sector payload says "buried"`);
  }
});

test('a flavour with no dependency clause is left alone', () => {
  const game = newGame();
  game.fireFault('F-210', 'AGR');   // two plain sentences, no semicolon
  const fault = forSector(game, 'AGR').sectors.AGR.faults[0];
  assert.equal(fault.flavour, 'Dashboards show a Bay 3 flood. Fields report dry floors.');
});

test('the facilitator still reads the whole flavour line', () => {
  const game = newGame();
  game.fireFault('F-302', 'WTR');
  const fault = forControl(game).sectors.WTR.faults.find((f) => f.code === 'F-302');

  assert.match(fault.flavour, /Appendix C/,
    'control holds the answer key already — it needs the full line');
});

test('no payload of any role contains a chat or message field', () => {
  const game = loaded();
  for (const payload of [forSector(game, 'POW'), forBigscreen(game), forControl(game)]) {
    const json = JSON.stringify(payload);
    assert.ok(!/"(chat|messages|dm|inbox)"/.test(json), 'no chat surface may exist');
  }
});
