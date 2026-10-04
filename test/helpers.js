'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const { GameState } = require('../lib/state');
const { RunLog } = require('../lib/log');

const ROOT = path.join(__dirname, '..');

// The same loader the server uses, so a test never sees a different world:
// the workbook's faults plus the generated reference-chain twelve.
const { loadContent: loadFromDir } = require('../lib/content');
const loadContent = () => loadFromDir(path.join(ROOT, 'content'));

const rounds = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'rounds.json'), 'utf8'));

/** A GameState writing its log into a scratch dir, in PLAY mode and ready. */
function newGame({ runId = 'test-run' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-test-'));
  const log = new RunLog(path.join(dir, 'runlog.jsonl'), path.join(dir, 'snapshot.json'));
  const game = new GameState({ content: loadContent(), rounds, runId, log });
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
