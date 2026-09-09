'use strict';
/**
 * Persistence for the hosted platform.
 *
 * One SQLite file on the host's persistent disk holds facilitators, sessions
 * and teams. Game state itself does NOT live here — it stays in memory per
 * the contract (§0.1) and is snapshotted to disk, exactly as in LAN mode.
 * This database is the registry around the games, not the games themselves.
 *
 * runlog.jsonl also stays a flat append-only file, one per session, on the
 * same disk. It is the join key for the analytics pipeline and downstream
 * tooling reads it as JSONL — putting it in a table would break that for no
 * gain (spec §5.1, contract §5).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// Ambiguous glyphs (0/O, 1/I/L) are excluded: these codes get read aloud
// across a noisy room and typed by people under time pressure.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facilitators (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  run_id         TEXT NOT NULL,
  name           TEXT NOT NULL,
  client_name    TEXT,
  facilitator_id INTEGER NOT NULL REFERENCES facilitators(id),
  control_token  TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'DRAFT',
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  ended_at       TEXT
);

CREATE TABLE IF NOT EXISTS teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sector     TEXT NOT NULL,
  team_name  TEXT NOT NULL,
  join_code  TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, sector)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token          TEXT PRIMARY KEY,
  facilitator_id INTEGER NOT NULL REFERENCES facilitators(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scenarios (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  notes      TEXT,
  json       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_teams_session   ON teams(session_id);
CREATE INDEX IF NOT EXISTS idx_auth_expires    ON auth_sessions(expires_at);
`;

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // WAL keeps reads non-blocking while a live run writes; the game loop must
  // never stall behind an admin page load.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Additive migrations. SQLite has no ADD COLUMN IF NOT EXISTS, so each one
 * checks the table first. Never drop or rename here: a live disk holds run
 * history that downstream tooling reads by these column names.
 */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!cols.includes('scenario_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN scenario_id TEXT');
  }
}

class Store {
  constructor(dbPath) {
    this.db = open(dbPath);
  }

  close() {
    this.db.close();
  }

  // -- facilitators ---------------------------------------------------------

  createFacilitator({ email, name, passwordHash, isAdmin = false }) {
    const info = this.db.prepare(`
      INSERT INTO facilitators (email, name, password_hash, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(email.toLowerCase().trim(), name, passwordHash, isAdmin ? 1 : 0, new Date().toISOString());
    return this.facilitatorById(info.lastInsertRowid);
  }

  facilitatorByEmail(email) {
    return this.db.prepare('SELECT * FROM facilitators WHERE email = ?')
      .get(String(email || '').toLowerCase().trim());
  }

  facilitatorById(id) {
    return this.db.prepare('SELECT * FROM facilitators WHERE id = ?').get(id);
  }

  listFacilitators() {
    return this.db.prepare('SELECT id, email, name, is_admin, created_at, last_login_at FROM facilitators ORDER BY name').all();
  }

  countFacilitators() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM facilitators').get().n;
  }

  touchLogin(id) {
    this.db.prepare('UPDATE facilitators SET last_login_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  setPassword(id, passwordHash) {
    this.db.prepare('UPDATE facilitators SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }

  setAdmin(id, isAdmin) {
    this.db.prepare('UPDATE facilitators SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
  }

  countAdmins() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM facilitators WHERE is_admin = 1').get().n;
  }

  /** How many sessions this facilitator owns — deleting them would orphan these. */
  countSessionsOwned(id) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE facilitator_id = ?').get(id).n;
  }

  deleteFacilitator(id) {
    // auth_sessions cascade, so removing an account also signs them out.
    this.db.prepare('DELETE FROM facilitators WHERE id = ?').run(id);
  }

  // -- auth sessions --------------------------------------------------------

  createAuthSession(facilitatorId, ttlMs) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO auth_sessions (token, facilitator_id, created_at, expires_at) VALUES (?, ?, ?, ?)
    `).run(token, facilitatorId, new Date(now).toISOString(), new Date(now + ttlMs).toISOString());
    return token;
  }

  facilitatorByAuthToken(token) {
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT f.* FROM auth_sessions a
      JOIN facilitators f ON f.id = a.facilitator_id
      WHERE a.token = ? AND a.expires_at > ?
    `).get(token, new Date().toISOString());
    return row || null;
  }

  destroyAuthSession(token) {
    if (token) this.db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
  }

  purgeExpiredAuthSessions() {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date().toISOString());
  }

  // -- game sessions --------------------------------------------------------

  /** Codes are retried on collision rather than trusted to be unique by luck. */
  createSession({ name, clientName, facilitatorId, sectors }) {
    const createSession = this.db.transaction(() => {
      let code;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        code = makeCode(6);
        if (!this.sessionByCode(code)) break;
        code = null;
      }
      if (!code) throw new Error('could not allocate a unique session code');

      const now = new Date().toISOString();
      const runId = `${now.slice(0, 10)}-${code}`;
      const info = this.db.prepare(`
        INSERT INTO sessions (code, run_id, name, client_name, facilitator_id, control_token, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?)
      `).run(code, runId, name, clientName || null,
             facilitatorId, crypto.randomBytes(24).toString('base64url'), now);

      const sessionId = info.lastInsertRowid;
      for (const [sector, teamName] of Object.entries(sectors || {})) {
        this.addTeam(sessionId, sector, teamName);
      }
      return sessionId;
    });
    return this.sessionById(createSession());
  }

  sessionByCode(code) {
    return this.db.prepare('SELECT * FROM sessions WHERE code = ?')
      .get(String(code || '').toUpperCase().trim());
  }

  sessionById(id) {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  }

  listSessions({ facilitatorId = null, includeEnded = true } = {}) {
    const clauses = [];
    const args = [];
    if (facilitatorId) { clauses.push('s.facilitator_id = ?'); args.push(facilitatorId); }
    if (!includeEnded) clauses.push("s.status != 'ENDED'");
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT s.*, f.name AS facilitator_name,
             (SELECT COUNT(*) FROM teams t WHERE t.session_id = s.id) AS team_count
      FROM sessions s JOIN facilitators f ON f.id = s.facilitator_id
      ${where}
      ORDER BY s.created_at DESC
    `).all(...args);
  }

  setSessionStatus(id, status) {
    const stamp = new Date().toISOString();
    const column = status === 'LIVE' ? 'started_at' : status === 'ENDED' ? 'ended_at' : null;
    if (column) {
      this.db.prepare(`UPDATE sessions SET status = ?, ${column} = COALESCE(${column}, ?) WHERE id = ?`)
        .run(status, stamp, id);
    } else {
      this.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id);
    }
  }

  deleteSession(id) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  setSessionScenario(id, scenarioId) {
    this.db.prepare('UPDATE sessions SET scenario_id = ? WHERE id = ?').run(scenarioId || null, id);
  }

  // -- scenarios ------------------------------------------------------------

  listScenarios() {
    return this.db.prepare(
      'SELECT id, name, notes, created_at, updated_at FROM scenarios ORDER BY name'
    ).all();
  }

  scenarioById(id) {
    return this.db.prepare('SELECT * FROM scenarios WHERE id = ?').get(String(id || ''));
  }

  upsertScenario({ id, name, notes, json }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO scenarios (id, name, notes, json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, notes = excluded.notes,
        json = excluded.json, updated_at = excluded.updated_at
    `).run(id, name, notes || null, json, now, now);
    return this.scenarioById(id);
  }

  deleteScenario(id) {
    return this.db.prepare('DELETE FROM scenarios WHERE id = ?').run(String(id || '')).changes > 0;
  }

  // -- teams ----------------------------------------------------------------

  addTeam(sessionId, sector, teamName) {
    let joinCode;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      joinCode = makeCode(8);
      if (!this.teamByJoinCode(joinCode)) break;
      joinCode = null;
    }
    if (!joinCode) throw new Error('could not allocate a unique join code');

    this.db.prepare(`
      INSERT INTO teams (session_id, sector, team_name, join_code, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (session_id, sector) DO UPDATE SET team_name = excluded.team_name
    `).run(sessionId, sector, teamName, joinCode, new Date().toISOString());
    return this.teamBySector(sessionId, sector);
  }

  teamsForSession(sessionId) {
    return this.db.prepare('SELECT * FROM teams WHERE session_id = ? ORDER BY sector').all(sessionId);
  }

  teamBySector(sessionId, sector) {
    return this.db.prepare('SELECT * FROM teams WHERE session_id = ? AND sector = ?')
      .get(sessionId, sector);
  }

  teamByJoinCode(joinCode) {
    return this.db.prepare('SELECT * FROM teams WHERE join_code = ?')
      .get(String(joinCode || '').toUpperCase().trim());
  }

  removeTeam(sessionId, sector) {
    this.db.prepare('DELETE FROM teams WHERE session_id = ? AND sector = ?').run(sessionId, sector);
  }

  /** A fresh join code invalidates any link already handed out. */
  rotateJoinCode(sessionId, sector) {
    const team = this.teamBySector(sessionId, sector);
    if (!team) return null;
    let joinCode;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      joinCode = makeCode(8);
      if (!this.teamByJoinCode(joinCode)) break;
      joinCode = null;
    }
    if (!joinCode) throw new Error('could not allocate a unique join code');
    this.db.prepare('UPDATE teams SET join_code = ? WHERE id = ?').run(joinCode, team.id);
    return this.teamBySector(sessionId, sector);
  }
}

module.exports = { Store, makeCode, CODE_ALPHABET };
