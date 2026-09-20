'use strict';
/**
 * The participant Big Screen — contract v15 (2026-09-18).
 *
 * Display-only: no aggregate city figure, no real inventory, nothing to
 * press. Sector health and its word are the server's; COM's board is what
 * COM reported and never moves on its own; freshness is a round count. The
 * formatting rules the projector runs live in public/shared/bigscreen.js and
 * are exercised here directly. The markup, the script and the stylesheet are
 * read as text for the things a node test can only check that way.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { newGame, loadContent, logEvents } = require('./helpers');
const { forBigscreen, forSector, forControl } = require('../lib/visibility');
const { submitCode } = require('../lib/resolve');
const economy = require('../lib/economy');
const B = require('../public/shared/bigscreen');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const WALL_INDEX = read('public/wall/index.html');
const WALL_SCRIPT = read('public/wall/wall.js');
const WALL_CSS = read('public/wall/wall.css');
const RULES = read('public/shared/bigscreen.js');
const SIX = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];

function running() {
  const game = newGame();
  game.setPhase('ROUND_2');
  game.clock('start');
  return game;
}
function readyTransfer(game, { from, to, resource, amount }) {
  const r = game.requestTransfer({ from, to, resource, amount, by: to });
  assert.equal(r.ok, true, `request refused: ${r.reason}`);
  const f = game.fulfillRequest(r.request.id, { by: from });
  assert.equal(f.ok, true, `fulfil refused: ${f.reason}`);
  assert.equal(game.confirmChit(f.transfer.id, true, { by: 'TRN' }).ok, true);
  return f.transfer;
}
function resolveFault(game, code) {
  const def = loadContent().faults.faults.find((f) => f.code === code);
  const fired = game.fireFault(code, def.sector);
  assert.equal(fired.ok, true, `${code} did not fire: ${fired.reason}`);
  const res = submitCode(game, { sector: def.sector, fault_code: code, code: def.valid_codes[0], workers_assigned: def.crew_required });
  assert.equal(res.accepted, true, `${code} was not accepted: ${res.reason}`);
  return res;
}
const board = (game) => JSON.parse(JSON.stringify(game.state.broadcast.rows));
const wallRows = (game) => forBigscreen(game).broadcast.rows;

/** wall.css as a list of { sel, body } — enough to ask what animates and what does not. */
function cssRules() {
  return WALL_CSS.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.trim()).filter(Boolean).map((r) => {
    const i = r.indexOf('{');
    return { sel: r.slice(0, i).trim(), body: r.slice(i + 1).trim() };
  });
}

// -- City Health is gone --------------------------------------------------------------

test('the wall frame carries no city figure and no real inventory; the facilitator keeps both', () => {
  const game = running();
  game.setInventory('POW', { power: 7 });
  const wall = forBigscreen(game);
  assert.equal(wall.city_stability, undefined, 'CITY reached the wall');
  assert.equal(wall.stability_mode, undefined);
  for (const c of SIX) {
    assert.equal(wall.sectors[c].inventory, undefined, `${c} stock reached the wall`);
    assert.equal(forSector(game, c).city_stability, undefined, `${c}'s laptop got a city figure`);
  }
  const json = JSON.stringify(wall);
  assert.ok(!json.includes('city_stability') && !json.includes('"inventory"'));
  const ctl = forControl(game);
  assert.equal(typeof ctl.city_stability, 'number', 'Admin lost the score');
  assert.equal(ctl.sectors.POW.inventory.power, 7, 'Admin lost the stock');
});

test('the wall prints no CITY HEALTH, no aggregate, no cycle labels, and has nothing to press', () => {
  assert.ok(!/CITY HEALTH|id="hud-city"|id="stability"|CITY 100/.test(WALL_INDEX));
  assert.ok(!/city_stability|computeStability/.test(WALL_SCRIPT + RULES), 'the wall reads or builds an aggregate');
  assert.ok(!/reduce\(|average|\bsum\b/.test(RULES), 'the rules fold sector health into one number');
  assert.ok(!/CURRENT CYCLE|NEXT CORE CYCLE/.test(WALL_INDEX + WALL_SCRIPT));
  assert.ok(!/<(button|input|select|textarea|form)\b/i.test(WALL_INDEX), 'a control in the markup');
  assert.ok(!/<(button|input|select|textarea|form)\b/i.test(WALL_SCRIPT), 'a control built by the script');
  assert.ok(!/createElement\(['"](button|input|select|textarea|form)['"]\)/i.test(WALL_SCRIPT));
  assert.equal((WALL_SCRIPT.match(/\.send\(/g) || []).length, 0, 'the wall sends something beyond its hello');
  for (const word of ['TRANSFER', 'REQUEST', 'APPROVE', 'DECLINE', 'HEAL', 'RESOLVE', 'ASSIGN']) {
    assert.ok(!new RegExp(`>${word}<`).test(WALL_SCRIPT + WALL_INDEX), `a ${word} pill or button`);
  }
  assert.ok(/role: 'bigscreen'/.test(WALL_SCRIPT), 'the wall no longer identifies as the read-only role');
});

// -- Sector health ------------------------------------------------------------------

test('all six sector health percentages reach the wall, each with the server\'s status word', () => {
  const wall = forBigscreen(running());
  for (const c of SIX) {
    assert.equal(typeof wall.sectors[c].integrity, 'number', `${c} has no health`);
    assert.ok(['STABLE', 'DEGRADED', 'CRITICAL', 'BROWNOUT', 'DARK'].includes(wall.sectors[c].status_word), `${c} has no word`);
  }
  assert.deepEqual(B.SECTOR_ORDER, SIX, 'six cards, fixed order');
  assert.ok(/B\.SECTOR_ORDER/.test(WALL_SCRIPT) && /HEALTH/.test(WALL_SCRIPT));
});

test('health thresholds: 70+ STABLE, 30-69 DEGRADED, 1-29 CRITICAL, 0 DARK — the server decides, the wall agrees', () => {
  const game = running();
  assert.equal(game.cfg.degraded_below, 70);
  assert.equal(game.cfg.critical_below, 30);
  const cases = [[100, 'STABLE'], [70, 'STABLE'], [69, 'DEGRADED'], [30, 'DEGRADED'], [29, 'CRITICAL'], [1, 'CRITICAL'], [0, 'DARK']];
  for (const [v, w] of cases) {
    game.setIntegrity('POW', v);
    const s = forBigscreen(game).sectors.POW;
    assert.equal(s.status_word, w, `${v}%`);
    assert.equal(B.healthWord(s), w, `${v}% on the wall`);
    assert.equal(B.healthState(s), w.toLowerCase(), `${v}% state`);
  }
});

test('the map node and the sector card derive one state from one rule', () => {
  assert.ok(!/function healthState/.test(WALL_SCRIPT), 'the wall grew its own health rule');
  assert.ok((WALL_SCRIPT.match(/B\.healthState\(s\)/g) || []).length >= 2, 'map and card do not share the rule');
  assert.ok(/g\.dataset\.state = state/.test(WALL_SCRIPT) && /card\.dataset\.state = state/.test(WALL_SCRIPT));
  assert.ok(/B\.STATE_WORD\[state\]/.test(WALL_SCRIPT), 'the word is not printed from the same state');
  // a BROWNOUT order and a DARK sector are words the room reads, not just colours
  for (const s of B.STATES) assert.ok(B.STATE_WORD[s], `${s} has no word`);
});

test('a stable or degraded sector never moves; critical breathes slowly; dark is dim and grey', () => {
  const rules = cssRules();
  const infinite = rules.filter((r) => /animation[^;]*infinite/.test(r.body));
  assert.ok(infinite.length > 0, 'the parse found nothing');
  for (const r of infinite) {
    assert.ok(!/data-state="(stable|degraded)"/.test(r.sel), `${r.sel} animates a calm state`);
    assert.ok(!/^\.(district|shc)$/.test(r.sel) && !/^\.(district|shc) /.test(r.sel), `${r.sel} animates every sector`);
    assert.ok(/critical|dark|core-low|final|blackout|breach|unstable|b-crisis|moving|down/.test(r.sel), `${r.sel} moves for no state`);
  }
  for (const r of infinite.filter((x) => /data-state="critical"/.test(x.sel))) {
    const m = r.body.match(/animation:[^;]*?(\d+(?:\.\d+)?)s/);
    assert.ok(m && Number(m[1]) >= 2, `${r.sel} pulses fast: ${r.body}`);
  }
  assert.ok(rules.some((r) => /data-state="critical"/.test(r.sel) && /animation/.test(r.body)), 'critical has no emphasis');
  assert.ok(rules.some((r) => /data-state="degraded"/.test(r.sel)), 'degraded has no emphasis');
  assert.ok(!rules.some((r) => /data-state="degraded"/.test(r.sel) && /animation/.test(r.body)), 'degraded moves');
  assert.ok(!rules.some((r) => /data-state="dark"/.test(r.sel) && /animation/.test(r.body)), 'dark flashes');
  assert.ok(rules.some((r) => r.sel === '.d-dark' && /grayscale/.test(r.body)), 'no greyscale copy');
  assert.ok(rules.some((r) => /data-state="dark"\] \.d-dark/.test(r.sel) && /display: inline/.test(r.body)), 'dark does not desaturate');
  assert.ok(rules.some((r) => /data-state="dark"\] \.d-dim/.test(r.sel) && /opacity: 0\.\d/.test(r.body)), 'dark does not dim');
  assert.ok(rules.some((r) => r.sel === '.core-glow' && !/animation/.test(r.body)), 'the healthy Core pulses for decoration');
});

// -- COM-reported resources ----------------------------------------------------------

test('card resources are COM\'s report in POWER · WATER · MEDICAL · PARTS order, never real inventory', () => {
  const game = running();
  game.setInventory('POW', { power: 2 });
  game.setBroadcastRow('POW', { power: 5, water: 1, med: 0, parts: 3 }, { by: 'COM' });
  const row = wallRows(game).POW;
  assert.equal(row.power, 5, 'the wall shows what COM reported');
  const rep = B.reportLine(row);
  assert.equal(rep.none, false);
  assert.deepEqual(rep.values.map((v) => v.key), ['power', 'water', 'med', 'parts']);
  assert.equal(rep.text, '⚡ 5   💧 1   ⚕ 0   🔧 3');
  assert.equal(game.state.sectors.POW.inventory.power, 2, 'real stock untouched');
  assert.ok(/frame\.broadcast\.rows/.test(WALL_SCRIPT) && /B\.reportLine/.test(WALL_SCRIPT));
  assert.ok(!/\.inventory/.test(WALL_SCRIPT + RULES), 'the wall reads a stock field');
});

test("nothing in the world moves COM's board: a stock edit, a transfer, a fault reward, an AGR card, a healing, production and upkeep, a round change", () => {
  const game = running();
  game.setBroadcastRow('POW', { power: 5, water: 5, med: 5, parts: 5 }, { by: 'COM' });
  game.setBroadcastRow('WTR', { power: 3, water: 3, med: 3, parts: 3 }, { by: 'COM' });
  game.setBroadcastRow('AGR', { power: 1, water: 1, med: 1, parts: 1 }, { by: 'COM' });
  const before = board(game);
  const same = (why) => {
    assert.deepEqual(board(game), before, `${why} moved the board`);
    assert.equal(wallRows(game).POW.power, 5, `${why} moved the wall`);
    assert.equal(wallRows(game).AGR.parts, 1, `${why} moved the wall`);
  };
  game.setInventory('POW', { power: 9, water: 9 });
  same('a stock edit');
  const t = readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 });
  assert.equal(game.approveTransfer(t.id, { by: 'TRN' }).ok, true);
  same('a TRN-approved transfer');
  game.patchConfig({ fault_reward_overrides: { 'F-002': { archetype: 'LOCAL_RECOVERY_5' } } });   // v17: a reward that pays at once, not one that waits for the table's pick
  resolveFault(game, 'F-002');
  assert.equal(logEvents(game, 'fault_reward_applied').length, 1, 'the reward did not pay');
  same('a fault resolution and its reward');
  game.state.agr.offered = ['AGR_EMERGENCY_PARTS', 'AGR_POWER_SURGE', 'AGR_WATER_RESERVE'];
  assert.equal(game.agrActivate('AGR_EMERGENCY_PARTS', { by: 'AGR' }).ok, true);
  same('an AGR intervention');
  game.injure('WTR', 1);
  const h = game.requestHealing('WTR', { by: 'WTR' });
  assert.equal(h.ok, true, h.reason);
  assert.equal(game.healWorker(h.healing.id, { by: 'MED' }).ok, true);
  same('a MED healing');
  game.cycleControl('process');
  same('production and upkeep');
  game.setRound('R3');
  assert.deepEqual(board(game), before, 'a round change moved the board');
  assert.equal(wallRows(game).POW.power, 5);
  assert.equal(wallRows(game).POW.freshness, 'STALE', 'only the freshness word moved');
});

// -- Freshness and NO REPORT ---------------------------------------------------------

test('freshness: CURRENT this round, STALE one round on, OUTDATED after two, NOT UPDATED when COM never reported', () => {
  const game = running();   // R2
  game.setBroadcastRow('POW', { power: 5 }, { by: 'COM' });
  assert.deepEqual(B.freshnessLine(wallRows(game).POW), { level: 'CURRENT', text: 'UPDATED ROUND 2 · CURRENT' });
  assert.deepEqual(B.freshnessLine(wallRows(game).WTR), { level: 'NOT UPDATED', text: 'NOT UPDATED' });
  game.setRound('R3');
  assert.deepEqual(B.freshnessLine(wallRows(game).POW), { level: 'STALE', text: 'UPDATED ROUND 2 · STALE' });
  game.setRound('R4');
  assert.deepEqual(B.freshnessLine(wallRows(game).POW), { level: 'OUTDATED', text: 'UPDATED ROUND 2 · OUTDATED' });
  assert.equal(B.freshnessLine(null).text, 'NOT UPDATED');
  // quiet when current, noticeable when stale, loud when outdated or never updated
  assert.ok(/\.shc-fresh\[data-fresh="CURRENT"\] \{[^}]*ink-faint/.test(WALL_CSS));
  assert.ok(/\.shc-fresh\[data-fresh="STALE"\] \{[^}]*amber/.test(WALL_CSS));
  assert.ok(/\.shc-fresh\[data-fresh="OUTDATED"\], \.shc-fresh\[data-fresh="NOT UPDATED"\] \{[^}]*red/.test(WALL_CSS));
  assert.ok(/B\.freshnessLine/.test(WALL_SCRIPT));
});

test('NO REPORT stands alone — no dashes, no glyph row — and a partial report shows what COM gave', () => {
  const game = running();
  const none = B.reportLine(wallRows(game).WTR);
  assert.deepEqual(none, { none: true, text: 'NO REPORT', values: [] });
  assert.ok(/NO REPORT/.test(WALL_SCRIPT), 'the card has no NO REPORT');
  assert.ok(!/NO REPORT'\s*:\s*`R\$/.test(WALL_SCRIPT), 'the old dash row is back');
  game.setBroadcastRow('WTR', { water: 4 }, { by: 'COM' });
  assert.equal(B.reportLine(wallRows(game).WTR).text, '⚡ —   💧 4   ⚕ —   🔧 —');
  const m = WALL_CSS.match(/\.rep-none \{[^}]*font-size: clamp\((\d+)px/);
  assert.ok(m && Number(m[1]) >= 15, 'NO REPORT is tiny');
});

// -- Alerts -------------------------------------------------------------------------

test('a single waiting transfer shows one clear FROM → TO route and its item; several collapse to a count', () => {
  const game = running();
  game.setInventory('TRN', { power: 3 });
  const t1 = readyTransfer(game, { from: 'TRN', to: 'AGR', resource: 'power', amount: 1 });
  let a = B.transferAlert(forBigscreen(game).transfers);
  assert.equal(a.count, 1);
  assert.equal(a.head, '⚠ 1 TRANSFER WAITING FOR TRN');
  assert.equal(a.detail, 'TRN → AGR   ⚡ 1 POWER');
  assert.equal(a.route, 'TRN → AGR');
  assert.ok(!/TRN → TRN/.test(a.detail), 'a multi-hop route');
  readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 });
  readyTransfer(game, { from: 'WTR', to: 'MED', resource: 'water', amount: 2 });
  a = B.transferAlert(forBigscreen(game).transfers);
  assert.equal(a.count, 3);
  assert.equal(a.head, '⚠ 3 TRANSFERS WAITING FOR TRN');
  assert.equal(a.detail, '');
  assert.equal(game.approveTransfer(t1.id, { by: 'TRN' }).ok, true);
  assert.equal(B.transferAlert(forBigscreen(game).transfers).count, 2, 'an approved transfer is still waiting');
  assert.equal(B.transferAlert([]), null);
  assert.ok(!/transfer history|renderHistory|\.history/i.test(WALL_SCRIPT), 'the wall lists transfer history');
});

test('critical and dark sectors outrank a waiting transfer; a calm city shows no strip at all', () => {
  const game = running();
  assert.deepEqual(B.buildAlerts(forBigscreen(game)), [], 'a calm city has an alert');
  assert.ok(/<section class="alerts" id="alerts" hidden>/.test(WALL_INDEX), 'the strip is drawn when empty');
  game.setInventory('TRN', { power: 3 });
  readyTransfer(game, { from: 'TRN', to: 'AGR', resource: 'power', amount: 1 });
  game.setIntegrity('MED', 27);
  game.setIntegrity('COM', 0);
  let alerts = B.buildAlerts(forBigscreen(game));
  assert.deepEqual(alerts.map((x) => x.kind), ['dark', 'critical', 'transfer']);
  assert.equal(alerts[0].head, '⚠ COM DARK');
  assert.equal(alerts[1].head, '⚠ MED CRITICAL · 27% HEALTH');
  assert.ok(alerts.every((x) => !/procedure|repair|binder|crew|code/i.test(`${x.head} ${x.detail}`)), 'an alert explains the fix');
  game.setCoreOutput(60);
  alerts = B.buildAlerts(forBigscreen(game));
  assert.deepEqual(alerts.map((x) => x.kind), ['dark', 'critical', 'core', 'transfer']);
  assert.equal(alerts[2].head, '⚠ CORE STABILITY 60%');
  // on the strip: red before grey, and a critical chip never yields its width to a transfer
  assert.ok(/\.chip\.emergency, \.chip\.dark, \.chip\.critical \{ flex-shrink: 0; \}/.test(WALL_CSS));
  assert.ok(/B\.buildAlerts\(frame\)/.test(WALL_SCRIPT));
});

// -- The city broadcast -------------------------------------------------------------

test("the city broadcast is COM's announcement in a readable area, or NO ACTIVE CITY BROADCAST", () => {
  const game = running();
  assert.equal(forBigscreen(game).broadcast.announcement, null);
  assert.ok(/NO ACTIVE CITY BROADCAST/.test(WALL_INDEX) && /NO ACTIVE CITY BROADCAST/.test(WALL_SCRIPT));
  assert.ok(/CITY BROADCAST/.test(WALL_INDEX) && /COMMS & SENSORS/.test(WALL_SCRIPT));
  game.setBroadcastAnnouncement({ headline: 'MEDICAL SUPPLIES REQUIRED', message: 'Review available stock' }, { by: 'COM' });
  const a = forBigscreen(game).broadcast.announcement;
  assert.equal(a.headline, 'MEDICAL SUPPLIES REQUIRED');
  assert.equal(a.round_number, 2);
  assert.equal(a.freshness, 'CURRENT');
  assert.ok(/frame\.broadcast\.announcement/.test(WALL_SCRIPT));
  assert.ok(!/class="ticker"|renderTicker|tickerLine/.test(WALL_INDEX + WALL_SCRIPT), 'the ticker is back');
  const m = WALL_CSS.match(/\.bc-head \{[^}]*font-size: clamp\((\d+)px/);
  assert.ok(m && Number(m[1]) >= 22, 'the headline is small');
  assert.ok(/\.broadcast\.enter \{ animation: bcIn [\d.]+s ease; \}/.test(WALL_CSS), 'no single entrance');
  assert.ok(!/\.broadcast[^{]*\{[^}]*infinite/.test(WALL_CSS), 'the broadcast loops');
});

// -- The command bar ----------------------------------------------------------------

test('CURRENT ROUND, NEXT ROUND IN and LIVE are on the command bar, from the round and its clock', () => {
  const f = forBigscreen(running());
  assert.equal(f.round_number, 2);
  assert.ok(f.round_clock && typeof f.round_clock.remaining_s === 'number');
  assert.ok(/CURRENT ROUND/.test(WALL_INDEX) && /id="round-number"/.test(WALL_INDEX));
  assert.ok(/NEXT ROUND IN/.test(WALL_INDEX) && /id="round-clock"/.test(WALL_INDEX));
  assert.ok(/id="live"/.test(WALL_INDEX) && /'LIVE'/.test(WALL_SCRIPT));
  assert.ok(/frame\.round_number/.test(WALL_SCRIPT) && /frame\.round_clock/.test(WALL_SCRIPT));
});

test('CORE STABILITY is meaningful — it scales POW production and drives the insufficiency alert — so the wall shows it', () => {
  const game = running();
  const base = economy.productionFor(game, game.state.sectors.POW).power;
  assert.ok(base > 0);
  game.setCoreOutput(50);
  assert.equal(economy.productionFor(game, game.state.sectors.POW).power, Math.floor(base * 0.5), 'core does not scale POW');
  assert.equal(forBigscreen(game).core_output, 50);
  assert.ok(B.buildAlerts(forBigscreen(game)).some((a) => a.kind === 'core'));
  game.setCoreOutput(61);
  assert.ok(!B.buildAlerts(forBigscreen(game)).some((a) => a.kind === 'core'));
  assert.ok(/CORE STABILITY/.test(WALL_INDEX) && /id="core-output"/.test(WALL_INDEX));
  assert.ok(/frame\.core_output/.test(WALL_SCRIPT));
});

// -- Guardrails ---------------------------------------------------------------------

test('no gameplay moved: TRN alone approves, MED alone heals, COM alone reports', () => {
  const game = running();
  const t = readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 });
  assert.equal(game.approveTransfer(t.id, { by: 'POW' }).ok, false);
  assert.equal(game.approveTransfer(t.id, { by: 'TRN' }).ok, true);
  game.injure('WTR', 1);
  const h = game.requestHealing('WTR', { by: 'WTR' });
  assert.equal(game.healWorker(h.healing.id, { by: 'WTR' }).ok, false);
  assert.equal(game.healWorker(h.healing.id, { by: 'MED' }).ok, true);
  assert.equal(game.setBroadcastRow('POW', { power: 1 }, { by: 'POW' }).ok, false);
  assert.equal(game.setBroadcastRow('POW', { power: 1 }, { by: 'COM' }).ok, true);
});

// -- the city animation (2026-09-20) ------------------------------------------------------
//
// The Big Screen's map is a looping video with the painting behind it as the
// fallback. Everything about the media lives in config/big-screen-map.json;
// the wall reads it at startup and nothing else in the screen changes.

const MAP_MEDIA = JSON.parse(read('config/big-screen-map.json'));
const SERVER_JS = read('server.js');
const PREPARE_ART = read('tools/prepare-wall-art.js');

test('the map media config names real files and is set to play the animation', () => {
  const m = MAP_MEDIA.mapDisplay;
  assert.ok(m, 'no mapDisplay block');
  assert.equal(m.type, 'video');
  assert.equal(m.source, '/assets/wall/art/haven9-map.mp4');
  assert.equal(m.fallbackImage, '/assets/wall/art/haven9-map.png');
  // the URLs and the files on disk are the same bytes, served by /assets/wall
  for (const [url, file] of [[m.source, m.sourceFile], [m.fallbackImage, m.fallbackImageFile]]) {
    assert.equal(url, `/assets/wall/${file.replace('public/wall/', '')}`, `${file} is not where its URL says`);
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is missing`);
    assert.ok(fs.statSync(path.join(ROOT, file)).size > 1000, `${file} is empty`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, m.sourceArtwork)), 'the master animation named by the config is gone');
  // the playback a command-centre display needs, and nothing a viewer can press
  assert.equal(m.autoplay, true); assert.equal(m.loop, true); assert.equal(m.muted, true);
  assert.equal(m.playsInline, true); assert.equal(m.preload, 'auto');
  assert.equal(m.controls, false, 'the Big Screen would show playback controls');
  assert.equal(m.fit, 'contain', 'the map would be cropped or stretched');
  assert.equal(m.position, 'center');
});

test('the config is served by name, and the rest of config/ stays private', () => {
  assert.ok(/app\.get\('\/config\/big-screen-map\.json'/.test(SERVER_JS), 'the wall cannot read its own config');
  assert.ok(!/express\.static\(path\.join\(__dirname, 'config'/.test(SERVER_JS), 'the whole config directory is exposed');
  assert.ok(!/\/config['"`]?, express\.static/.test(SERVER_JS));
});

test('the wall plays the animation under the same box, with no controls and no chrome', () => {
  const html = WALL_INDEX;
  assert.ok(/<video id="map-video"/.test(html), 'no video element');
  for (const attr of ['autoplay', 'loop', 'muted', 'playsinline', 'preload="auto"']) {
    assert.ok(new RegExp(`<video id="map-video"[^>]*\\b${attr.replace('"', '"')}`, 's').test(html), `the video is missing ${attr}`);
  }
  const tag = html.slice(html.indexOf('<video id="map-video"'), html.indexOf('>', html.indexOf('<video id="map-video"')) + 1);
  assert.ok(!/\bcontrols\b/.test(tag), 'the video shows controls');
  assert.ok(/disablepictureinpicture/.test(tag) && /disableremoteplayback/.test(tag), 'the browser can still offer playback UI');
  assert.ok(/aria-hidden="true"/.test(tag) && /tabindex="-1"/.test(tag), 'the decoration is in the reading order');
  assert.ok(!/src=/.test(tag), 'the media path is hardcoded in the markup as well as the config');
  // the video is inside the city panel, before the SVG that draws over it
  const city = html.indexOf('<section class="city"');
  assert.ok(city > -1 && html.indexOf('<video id="map-video"') > city && html.indexOf('<video id="map-video"') < html.indexOf('<svg id="map"'));
  // the painted map is still the SVG's own backdrop
  assert.ok(/haven9-map\.png/.test(WALL_SCRIPT) && fs.existsSync(path.join(ROOT, 'public/wall/art/haven9-map.png')));
});

test('the animation fills the map area without distortion, under every overlay', () => {
  const css = WALL_CSS;
  const rule = css.slice(css.indexOf('.map-video {'), css.indexOf('}', css.indexOf('.map-video {')));
  assert.ok(/object-fit: contain/.test(rule), 'the video is stretched or cropped');
  assert.ok(/object-position: center/.test(rule), 'the video is not centred');
  assert.ok(/position: absolute/.test(rule) && /inset: 0/.test(rule) && /width: 100%/.test(rule) && /height: 100%/.test(rule), 'the video does not fill the map area');
  assert.ok(/z-index: -1/.test(rule), 'the video is not behind the overlays');
  assert.ok(!/border/.test(rule), 'a border was added around the map');
  assert.ok(/\.city \{[^}]*isolation: isolate/s.test(css), 'the video can escape behind the city panel');
  assert.ok(/\.city\[data-map="video"\] \.backdrop \{[^}]*opacity: 0/s.test(css), 'the painting stays on top of the animation');
  assert.ok(/\.wall\.dimmed #map, \.wall\.dimmed \.map-video \{/.test(css), 'a takeover dims the overlays but not the animation');
});

test('the animation loops natively: no timer restarts it, nothing reloads it, and a failure falls back to the painting', () => {
  const js = WALL_SCRIPT;
  const fn = js.slice(js.indexOf('function startMapAnimation()'), js.indexOf('\n  buildMap();'));
  assert.ok(fn.length > 400, 'startMapAnimation is missing');
  assert.ok(/fetch\(MAP_MEDIA_URL/.test(fn), 'the wall does not read the media config');
  assert.ok(/video\.loop = m\.loop !== false/.test(fn) && /video\.muted = m\.muted !== false/.test(fn), 'loop and muted are not taken from the config');
  assert.ok(/video\.controls = m\.controls === true/.test(fn));
  // native loop only: no clock is allowed near this element
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame/.test(fn), 'a timer drives the video');
  assert.ok(!/currentTime\s*=/.test(fn), 'the video is restarted by hand');
  assert.ok((fn.match(/video\.src\s*=/g) || []).length === 1, 'the video source is assigned more than once');
  assert.ok(/video\.load\(\)/.test(fn) === false, 'the video is reloaded');
  // the fallback: the painting shows until it plays, and comes back if it fails
  assert.ok(/const painting = \(\) => \{ city\.dataset\.map = 'image'; \};/.test(fn));
  assert.ok(/addEventListener\('error', painting\)/.test(fn), 'a broken video leaves an empty box');
  assert.ok(/addEventListener\('playing'/.test(fn), 'the painting is hidden before the video really plays');
  assert.ok(/if \(m\.type !== 'video' \|\| !m\.source\) \{ video\.remove\(\); return; \}/.test(fn), 'the config cannot turn the animation off');
  assert.ok(/\.catch\(painting\)/.test(fn), 'a missing config leaves the screen blank');
  assert.ok(/m\.fallbackImage/.test(fn), 'the config does not control the fallback image');
});

test('the art pipeline copies the animation beside the painting, so the space in the folder name never reaches a URL', () => {
  assert.ok(/path\.join\(SRC, 'Map Animation'\)/.test(PREPARE_ART), 'the pipeline does not read the animation folder');
  assert.ok(/mp4\|webm\|mov/.test(PREPARE_ART), 'the pipeline only accepts one file name');
  assert.ok(/haven9-map\.mp4/.test(PREPARE_ART));
  assert.ok(!/Map%20Animation|Map Animation/.test(WALL_INDEX + WALL_SCRIPT + WALL_CSS + JSON.stringify(MAP_MEDIA.mapDisplay.source)), 'a served URL points into the Asset folder');
});
