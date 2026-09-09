'use strict';
/**
 * runlog.jsonl — one JSON object per line, append-only.
 *
 * This file is the join key for the entire analytics pipeline: it is aligned to
 * the table audio by the R0 klaxon spike and read alongside transcripts in
 * debrief. Logging is a P0 feature, not instrumentation (contract §0.6).
 *
 * Writes are appended synchronously. At human-speed event rates the cost is
 * irrelevant, and a log that survives an abrupt process death is worth more
 * than one that batches.
 */

const fs = require('fs');
const path = require('path');

class RunLog {
  constructor(logPath, snapshotPath) {
    this.logPath = logPath;
    this.snapshotPath = snapshotPath;
    this.listeners = new Set();
    // Stamped onto every line so the analytics can segment by round and phase
    // without replaying the log: Round 3 and Aftershock must be comparable.
    this.context = {};
  }

  setContext(ctx = {}) {
    this.context = { ...this.context, ...ctx };
  }

  /** Append one event. `ev` names the event type; the rest is merged in. */
  write(ev, fields = {}) {
    const entry = { t: new Date().toISOString(), ev, ...this.context, ...fields };
    try {
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
    } catch (err) {
      // A failed log write must never take the run down mid-session.
      console.error('[runlog] write failed:', err.message);
    }
    for (const fn of this.listeners) fn(entry);
    return entry;
  }

  onWrite(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  writeSnapshot(state) {
    try {
      const tmp = this.snapshotPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, this.snapshotPath);
      return true;
    } catch (err) {
      console.error('[snapshot] write failed:', err.message);
      return false;
    }
  }

  readSnapshot() {
    try {
      if (!fs.existsSync(this.snapshotPath)) return null;
      return JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
    } catch (err) {
      console.error('[snapshot] read failed:', err.message);
      return null;
    }
  }

  /** Full log text, for the facilitator's export_log button. */
  readAll() {
    try {
      return fs.existsSync(this.logPath) ? fs.readFileSync(this.logPath, 'utf8') : '';
    } catch {
      return '';
    }
  }

  /** Start a fresh run: the previous log is preserved under a dated name. */
  rotate(runId) {
    try {
      if (fs.existsSync(this.logPath)) {
        const dir = path.dirname(this.logPath);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(this.logPath, path.join(dir, `runlog-${runId}-${stamp}.jsonl`));
      }
    } catch (err) {
      console.error('[runlog] rotate failed:', err.message);
    }
  }
}

module.exports = { RunLog };
