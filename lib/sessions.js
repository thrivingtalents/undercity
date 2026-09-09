'use strict';
/**
 * Session registry — many concurrent runs inside one process.
 *
 * Each live session owns its own GameState and its own RunLog, so two cohorts
 * running at the same time share nothing but the process. State stays in
 * memory (contract §0.1); the registry only decides which game a socket or a
 * request is talking to.
 *
 * Runs are loaded lazily on first access and evicted when idle, so a server
 * holding fifty finished sessions is not holding fifty games in memory.
 */

const fs = require('fs');
const path = require('path');

const { GameState } = require('./state');
const { RunLog } = require('./log');

// A session with no sockets and no facilitator activity for this long is
// snapshotted and dropped from memory. It reloads intact on next access.
const IDLE_EVICT_MS = 60 * 60 * 1000;

class SessionRegistry {
  constructor({ store, content, rounds, dataDir }) {
    this.store = store;
    this.content = content;
    this.rounds = rounds;
    this.dataDir = dataDir;
    this.live = new Map();       // code -> { game, log, row, clients:Set, lastTouch }
    this.overrides = new Map();  // code -> { runlog, snapshot }
    fs.mkdirSync(path.join(dataDir, 'runs'), { recursive: true });
  }

  /**
   * Pin one session's log and snapshot to explicit paths. LAN mode uses this
   * so a facilitator can point RUNLOG_PATH straight at a USB stick and carry
   * the debrief data out of the room on it.
   */
  overridePaths(code, { runlog, snapshot }) {
    const key = String(code || '').toUpperCase().trim();
    if (runlog && snapshot) this.overrides.set(key, { runlog, snapshot });
  }

  paths(code) {
    const key = String(code || '').toUpperCase().trim();
    const override = this.overrides.get(key);
    if (override) {
      return { dir: path.dirname(override.runlog), ...override };
    }
    const dir = path.join(this.dataDir, 'runs', key);
    return {
      dir,
      runlog: path.join(dir, 'runlog.jsonl'),
      snapshot: path.join(dir, 'snapshot.json'),
    };
  }

  /** Load a session into memory, or return the one already there. */
  get(code) {
    const key = String(code || '').toUpperCase().trim();
    if (this.live.has(key)) {
      const entry = this.live.get(key);
      entry.lastTouch = Date.now();
      return entry;
    }

    const row = this.store.sessionByCode(key);
    if (!row) return null;

    const { dir, runlog, snapshot } = this.paths(key);
    fs.mkdirSync(dir, { recursive: true });

    const log = new RunLog(runlog, snapshot);
    const scenario = this.scenarios ? this.scenarios.resolve(row.scenario_id) : null;
    const game = new GameState({
      content: this.content, rounds: this.rounds, scenario, runId: row.run_id, log,
    });

    // A restart mid-session must not cost the run.
    const snap = log.readSnapshot();
    if (snap) game.restore(snap);
    log.setContext({ round: game.state.round, phase: game.state.phase });

    const entry = { game, log, row, clients: new Set(), lastTouch: Date.now(), code: key };
    this.live.set(key, entry);
    return entry;
  }

  /**
   * Start a fresh run in a session: rotate the log, optionally switch
   * scenario, rebuild the state, snapshot at once.
   */
  resetRun(code, { runId = null, scenarioId = null } = {}) {
    const entry = this.get(code);
    if (!entry) return null;
    const { game, log, row } = entry;
    const nextId = runId || row.run_id;
    log.write('run_end', { run_id: game.state.run_id });
    log.rotate(game.state.run_id);
    log.setContext({});
    let scenario = null;
    if (scenarioId && this.scenarios) {
      scenario = this.scenarios.resolve(scenarioId);
      this.store.setSessionScenario(row.id, scenario.id);
      entry.row = this.store.sessionById(row.id);
    }
    game.reset(nextId, { scenario });
    log.setContext({ round: game.state.round, phase: game.state.phase });
    log.writeSnapshot(game.serialise());
    return entry;
  }

  /** Teams as the game needs them: sector -> team name. */
  teamNames(sessionId) {
    const out = {};
    for (const team of this.store.teamsForSession(sessionId)) out[team.sector] = team.team_name;
    return out;
  }

  has(code) {
    return !!this.store.sessionByCode(String(code || '').toUpperCase().trim());
  }

  attach(code, client) {
    const entry = this.get(code);
    if (!entry) return null;
    entry.clients.add(client);
    entry.lastTouch = Date.now();
    return entry;
  }

  detach(code, client) {
    const entry = this.live.get(String(code || '').toUpperCase().trim());
    if (!entry) return;
    entry.clients.delete(client);
    entry.lastTouch = Date.now();
  }

  /** Snapshot and drop a session from memory; it reloads on next access. */
  evict(code) {
    const key = String(code || '').toUpperCase().trim();
    const entry = this.live.get(key);
    if (!entry) return false;
    entry.log.writeSnapshot(entry.game.serialise());
    this.live.delete(key);
    return true;
  }

  /** End a run for good: final snapshot, status flipped, memory released. */
  end(code) {
    const key = String(code || '').toUpperCase().trim();
    const row = this.store.sessionByCode(key);
    if (!row) return false;
    const entry = this.live.get(key);
    if (entry) {
      entry.log.write('run_end', { run_id: row.run_id });
      entry.log.writeSnapshot(entry.game.serialise());
      for (const client of entry.clients) {
        try { client.ws.close(); } catch { /* already gone */ }
      }
      this.live.delete(key);
    }
    this.store.setSessionStatus(row.id, 'ENDED');
    return true;
  }

  /** Every loaded session, for the tick and snapshot loops. */
  entries() {
    return [...this.live.values()];
  }

  liveCodes() {
    return [...this.live.keys()];
  }

  sweepIdle(now = Date.now()) {
    let evicted = 0;
    for (const [code, entry] of this.live) {
      if (entry.clients.size > 0) continue;
      if (now - entry.lastTouch < IDLE_EVICT_MS) continue;
      entry.log.writeSnapshot(entry.game.serialise());
      this.live.delete(code);
      evicted += 1;
    }
    return evicted;
  }

  closeAll() {
    for (const entry of this.live.values()) {
      entry.log.writeSnapshot(entry.game.serialise());
    }
    this.live.clear();
  }
}

module.exports = { SessionRegistry, IDLE_EVICT_MS };
