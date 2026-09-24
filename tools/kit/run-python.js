#!/usr/bin/env node
'use strict';
/**
 * Runs one of the generator scripts under whichever Python this machine has.
 *
 * `python3` is the name on the build machine and on CI. On Windows it is a
 * Microsoft Store shim that exists, answers `command -v`, and then refuses to
 * run — so the interpreter is chosen by executing each candidate, not by
 * finding it. UTF-8 is forced on the child because both generators print and
 * write the sector glyphs, and a cp1252 console or file encoding turns that
 * into a crash three hundred lines into an otherwise finished build.
 *
 *   node tools/kit/run-python.js <script.py> [args...]
 *
 * UNDERCITY_PYTHON overrides the search: UNDERCITY_PYTHON="py -3" npm run kit
 */

const { spawnSync } = require('child_process');

const CANDIDATES = [
  ...(process.env.UNDERCITY_PYTHON ? [process.env.UNDERCITY_PYTHON.split(/\s+/)] : []),
  ['python3'],
  ['python'],
  ['py', '-3'],
];

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node tools/kit/run-python.js <script.py> [args...]');
  process.exit(2);
}

const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

function works([cmd, ...pre]) {
  const probe = spawnSync(cmd, [...pre, '-c', 'import sys'], { stdio: 'ignore', env });
  return !probe.error && probe.status === 0;
}

const python = CANDIDATES.find(works);
if (!python) {
  console.error('ERROR: no working Python found. Tried: ' +
    CANDIDATES.map((c) => c.join(' ')).join(', ') +
    '\n       Install Python 3, or point UNDERCITY_PYTHON at the interpreter.');
  process.exit(1);
}

const [cmd, ...pre] = python;
const run = spawnSync(cmd, [...pre, ...args], { stdio: 'inherit', env });
if (run.error) {
  console.error(`ERROR: ${cmd} failed to start — ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status === null ? 1 : run.status);
