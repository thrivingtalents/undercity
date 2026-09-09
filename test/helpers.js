'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const { GameState } = require('../lib/state');
const { RunLog } = require('../lib/log');

const ROOT = path.join(__dirname, '..');

function loadContent() {
  const rd = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'content', f), 'utf8'));
  return { faults: rd('faults.json'), specs: rd('specs.json'), sectors: rd('sectors.json') };
}

const rounds = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'rounds.json'), 'utf8'));

/** A GameState writing its log into a scratch dir, in PLAY mode and ready. */
function newGame() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-test-'));
  const log = new RunLog(path.join(dir, 'runlog.jsonl'), path.join(dir, 'snapshot.json'));
  const game = new GameState({ content: loadContent(), rounds, runId: 'test-run', log });
  log.setContext({ round: game.state.round, phase: game.state.phase });
  game.state.mode = 'PLAY';
  game.dir = dir;
  return game;
}

/** Read back every logged event of a given type. */
function logEvents(game, ev) {
  const raw = game.log.readAll().trim();
  if (!raw) return [];
  return raw.split('\n').map((l) => JSON.parse(l)).filter((e) => !ev || e.ev === ev);
}

module.exports = { newGame, loadContent, rounds, logEvents };
