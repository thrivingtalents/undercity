'use strict';
/**
 * UNDERCITY server — HAVEN-9.
 *
 * Runs in two modes from one codebase:
 *
 *   hosted  many concurrent sessions, facilitator accounts, a sessions panel.
 *           Sessions and teams live in SQLite; each run keeps its own
 *           in-memory game, runlog.jsonl and snapshot.
 *
 *   lan     the single-run behaviour for the offline travel router.
 *           One implicit session, no accounts, bare URLs. The spec calls
 *           venue WiFi the #1 failure mode for this class of product (§5.1),
 *           so this path stays first-class.
 *
 * The three screens (LAN mode):
 *   /wall           projector — the city
 *   /sector/POW …   one laptop per sector
 *   /admin          the facilitator's game master console (also /control)
 *
 * Set MODE=lan (or omit DATA_DIR) for the router. Everything else is shared.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');

const { validateContent } = require('./lib/validate');
const { RunLog } = require('./lib/log');
const { submitCode } = require('./lib/resolve');
const { filterState } = require('./lib/visibility');
const { Store } = require('./lib/db');
const { makeAuth, hashPassword, verifyPassword } = require('./lib/auth');
const { SessionRegistry } = require('./lib/sessions');
const { ScenarioLibrary } = require('./lib/config');
const { analyse } = require('./lib/analytics');
const { Kit } = require('./lib/kit');
const { inspectStorage, reportStorage } = require('./lib/storage');
const { zip } = require('./lib/zip');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MODE = (process.env.MODE || (process.env.DATA_DIR ? 'hosted' : 'lan')).toLowerCase();
const LAN_TOKEN = process.env.FACILITATOR_TOKEN || 'haven9';
const LAN_CODE = 'LOCAL';
// LAN mode keeps the original overridable log paths: a facilitator can point
// these at a USB stick and carry the debrief data out of the room on it.
const RUNLOG_PATH = process.env.RUNLOG_PATH || null;
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || null;
const HEARTBEAT_MS = 20000;
const SECURE_COOKIES = process.env.SECURE_COOKIES === '1' || process.env.NODE_ENV === 'production';

// -- content ------------------------------------------------------------------

const CONTENT_DIR = path.join(__dirname, 'content');
const loadJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const content = {
  faults: loadJson(path.join(CONTENT_DIR, 'faults.json')),
  specs: loadJson(path.join(CONTENT_DIR, 'specs.json')),
  sectors: loadJson(path.join(CONTENT_DIR, 'sectors.json')),
};
const rounds = loadJson(path.join(__dirname, 'lib', 'rounds.json'));
const SECTOR_CODES = Object.keys(content.sectors.sectors);

const { errors, warnings } = validateContent(content);
if (warnings.length) {
  console.warn('\n⚠  CONTENT WARNINGS — see CONTENT-ISSUES.md');
  for (const w of warnings) console.warn('   ⚠', w);
  console.warn('');
}
if (errors.length) {
  console.error('\n✗ CONTENT VALIDATION FAILED — refusing to boot:\n');
  for (const e of errors) console.error('   ✗', e);
  console.error('\nFix the crossref matrix and re-run tools/export_faults.py.\n');
  process.exit(1);
}
console.log(
  `✓ content OK — ${content.faults.faults.length} faults, ` +
  `${content.specs.specs.length} specs, ${SECTOR_CODES.length} sectors`
);

// -- storage ------------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });

// Before anything is written: will any of it still be here after a restart?
const storage = inspectStorage(DATA_DIR);

const store = new Store(path.join(DATA_DIR, 'undercity.db'));
const auth = makeAuth(store, { secure: SECURE_COOKIES });
const scenarios = new ScenarioLibrary({ store, rounds, content });
const registry = new SessionRegistry({ store, content, rounds, dataDir: DATA_DIR, scenarios });
console.log(`✓ scenarios — ${scenarios.list().map((s) => s.id).join(', ')}`);

// The printable kit is generated at image-build time from the same commit that
// produced content/*.json, so it is read-only here and always matches.
const kit = new Kit({
  kitDir: process.env.KIT_DIR || path.join(__dirname, 'kit'),
  contentDir: CONTENT_DIR,
});

/**
 * Seed the master admin from the environment.
 *
 * Accounts live in SQLite on the persistent disk and survive redeploys — a
 * deploy replaces the image, not the disk. This exists so the FIRST deploy
 * needs no shell access: if ADMIN_EMAIL names an account that does not exist
 * yet, it is created. An existing account is never touched.
 */
function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim();
  if (!email) {
    if (store.countFacilitators() === 0) {
      console.log('  ADMIN_EMAIL is not set — no account will be seeded.');
    }
    return;
  }

  const existing = store.facilitatorByEmail(email);
  if (existing) {
    if (!existing.is_admin) {
      store.setAdmin(existing.id, true);
      console.log(`✓ ${existing.email} promoted to admin`);
    }
    return;
  }

  const name = (process.env.ADMIN_NAME || '').trim() || email.split('@')[0];
  const supplied = process.env.ADMIN_PASSWORD;
  const password = supplied || require('crypto').randomBytes(12).toString('base64url');

  const user = store.createFacilitator({
    email, name, passwordHash: hashPassword(password), isAdmin: true,
  });
  console.log(`\n✓ created master admin ${user.email} (${user.name})`);
  if (!supplied) {
    console.log(`  temporary password: ${password}`);
    console.log('  Shown once. Sign in and change it, or set ADMIN_PASSWORD.\n');
  }
}

if (MODE === 'hosted') seedAdmin();

/**
 * LAN mode keeps working without an admin ever logging in: a system
 * facilitator and one standing session are created on first boot.
 */
let lanEntry = null;
if (MODE === 'lan') {
  let sys = store.facilitatorByEmail('local@undercity');
  if (!sys) {
    sys = store.createFacilitator({
      email: 'local@undercity', name: 'Local facilitator',
      passwordHash: hashPassword(require('crypto').randomBytes(32).toString('hex')),
      isAdmin: true,
    });
  }
  let row = store.sessionByCode(LAN_CODE);
  if (!row) {
    row = store.createSession({
      name: 'Local run', clientName: null, facilitatorId: sys.id,
      sectors: Object.fromEntries(SECTOR_CODES.map((s) => [s, content.sectors.sectors[s].name])),
    });
    store.db.prepare('UPDATE sessions SET code = ?, control_token = ? WHERE id = ?')
      .run(LAN_CODE, LAN_TOKEN, row.id);
    store.setSessionStatus(row.id, 'LIVE');
  } else if (row.control_token !== LAN_TOKEN) {
    store.db.prepare('UPDATE sessions SET control_token = ? WHERE id = ?').run(LAN_TOKEN, row.id);
  }
  if (RUNLOG_PATH && SNAPSHOT_PATH) {
    registry.overridePaths(LAN_CODE, { runlog: RUNLOG_PATH, snapshot: SNAPSHOT_PATH });
  }
  lanEntry = registry.get(LAN_CODE);
}

// -- http ---------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false }));

const staticOpts = { redirect: false };
app.use('/shared', express.static(path.join(__dirname, 'public', 'shared'), staticOpts));
// Optional replaceable audio: drop fault_alert.mp3 etc. into public/audio.
app.use('/audio', express.static(path.join(__dirname, 'public', 'audio'), staticOpts));
for (const view of ['sector', 'bigscreen', 'wall', 'control', 'admin']) {
  app.use(`/assets/${view}`, express.static(path.join(__dirname, 'public', view), staticOpts));
}

const view = (name) => path.join(__dirname, 'public', name, 'index.html');

// -- session-scoped views -----------------------------------------------------

function requireSession(req, res, next) {
  const row = store.sessionByCode(req.params.code);
  if (!row) return res.status(404).send('Unknown session code');
  if (row.status === 'ENDED') return res.status(410).send('This session has ended');
  req.sessionRow = row;
  next();
}

app.get('/s/:code/wall', requireSession, (_req, res) => res.sendFile(view('wall')));
app.get('/s/:code/bigscreen', requireSession, (_req, res) => res.sendFile(view('bigscreen')));
app.get('/s/:code/control', requireSession, (_req, res) => res.sendFile(view('control')));
app.get('/s/:code/sector/:sector', requireSession, (req, res) => {
  if (!content.sectors.sectors[String(req.params.sector).toUpperCase()]) {
    return res.status(404).send('Unknown sector');
  }
  res.sendFile(view('sector'));
});

/** A team's join link: short, printable, resolves to their own dashboard. */
app.get('/j/:joinCode', (req, res) => {
  const team = store.teamByJoinCode(req.params.joinCode);
  if (!team) return res.status(404).send('Unknown join code');
  const row = store.sessionById(team.session_id);
  if (!row || row.status === 'ENDED') return res.status(410).send('This session has ended');
  res.redirect(`/s/${row.code}/sector/${team.sector}`);
});

// -- LAN-mode routes (the travel router path) ---------------------------------

if (MODE === 'lan') {
  app.get('/sector/:code', (req, res) => {
    if (!content.sectors.sectors[String(req.params.code).toUpperCase()]) {
      return res.status(404).send('Unknown sector');
    }
    res.sendFile(view('sector'));
  });
  app.get('/wall', (_req, res) => res.sendFile(view('wall')));
  app.get('/bigscreen', (_req, res) => res.sendFile(view('bigscreen')));
  app.get('/control', (_req, res) => res.sendFile(view('control')));
  // In LAN mode /admin IS the game master console. The page asks for the
  // facilitator token if the URL does not carry one.
  app.get('/admin', (_req, res) => res.sendFile(view('control')));
}

// -- admin (hosted sessions panel) -------------------------------------------

app.get('/admin/login', (_req, res) => res.sendFile(view('admin')));
app.get('/admin', auth.requireAuth, (_req, res) => res.sendFile(view('admin')));
app.get('/admin/*', auth.requireAuth, (_req, res) => res.sendFile(view('admin')));

const setupOpen = () => store.countFacilitators() === 0;

app.get('/api/auth/needs-setup', (_req, res) => {
  res.json({
    needs_setup: setupOpen(),
    suggested_email: setupOpen() ? (process.env.ADMIN_EMAIL || '').trim() || null : null,
    suggested_name: setupOpen() ? (process.env.ADMIN_NAME || '').trim() || null : null,
  });
});

app.post('/api/auth/setup', (req, res) => {
  if (!setupOpen()) {
    return res.status(409).json({
      error: 'This instance already has an account. Sign in, or ask an admin to add you.',
    });
  }
  const { email, name, password } = req.body || {};
  const clean = String(email || '').trim().toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
    return res.status(400).json({ error: 'That does not look like an email address.' });
  }
  if (!String(name || '').trim()) return res.status(400).json({ error: 'A name is required.' });
  if (String(password || '').length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const user = store.createFacilitator({
    email: clean,
    name: String(name).trim(),
    passwordHash: hashPassword(password),
    isAdmin: true,
  });
  console.log(`✓ first admin created via setup: ${user.email} (${user.name})`);
  auth.login(res, user.id);
  res.status(201).json({
    ok: true,
    user: { name: user.name, email: user.email, is_admin: true },
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = store.facilitatorByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  auth.login(res, user.id);
  res.json({ ok: true, user: { name: user.name, email: user.email, is_admin: !!user.is_admin } });
});

app.post('/api/auth/logout', (req, res) => { auth.logout(req, res); res.json({ ok: true }); });

app.get('/api/auth/me', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorised' });
  res.json({ user: { name: user.name, email: user.email, is_admin: !!user.is_admin } });
});

const api = express.Router();
api.use(auth.requireAuth);

api.get('/meta', (_req, res) => {
  res.json({
    storage: {
      verdict: storage.verdict,
      detail: storage.detail,
      dir: storage.dir,
      boots: storage.boots,
      first_boot_at: storage.first_boot_at,
    },
    sectors: SECTOR_CODES.map((code) => ({
      code, name: content.sectors.sectors[code].name, colour: content.sectors.sectors[code].colour,
    })),
    rounds: rounds.rounds.map((r) => ({ id: r.id, name: r.name })),
    scenarios: scenarios.list(),
    mode: MODE,
  });
});

function decorate(row) {
  const entry = registry.live.get(row.code);
  const teams = store.teamsForSession(row.id);
  return {
    ...row,
    control_token: undefined,
    teams: teams.map((t) => ({
      sector: t.sector, team_name: t.team_name, join_code: t.join_code,
    })),
    loaded: !!entry,
    connected: entry ? entry.clients.size : 0,
    live_state: entry ? {
      mode: entry.game.state.mode,
      phase: entry.game.state.phase,
      round: entry.game.state.round,
      core_integrity: Math.round(entry.game.state.core_integrity),
      city_stability: Math.round(entry.game.state.city_stability),
    } : null,
  };
}

api.get('/sessions', (req, res) => {
  const rows = store.listSessions({ includeEnded: req.query.all === '1' });
  res.json({ sessions: rows.map(decorate) });
});

api.post('/sessions', (req, res) => {
  const { name, client_name: clientName, teams, scenario_id: scenarioId } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'A session name is required.' });

  const sectors = {};
  for (const code of SECTOR_CODES) {
    const teamName = teams && teams[code];
    sectors[code] = (teamName && String(teamName).trim()) || content.sectors.sectors[code].name;
  }
  const row = store.createSession({
    name: String(name).trim(),
    clientName: clientName ? String(clientName).trim() : null,
    facilitatorId: req.user.id,
    sectors,
  });
  if (scenarioId && scenarios.raw(scenarioId)) store.setSessionScenario(row.id, scenarioId);
  res.status(201).json({ session: decorate(store.sessionById(row.id)) });
});

api.get('/sessions/:code', (req, res) => {
  const row = store.sessionByCode(req.params.code);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({ session: decorate(row), control_token: row.control_token });
});

api.post('/sessions/:code/teams', (req, res) => {
  const row = store.sessionByCode(req.params.code);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const { sector, team_name: teamName } = req.body || {};
  const code = String(sector || '').toUpperCase();
  if (!content.sectors.sectors[code]) return res.status(400).json({ error: 'unknown_sector' });
  if (!teamName || !String(teamName).trim()) return res.status(400).json({ error: 'team_name required' });
  store.addTeam(row.id, code, String(teamName).trim());
  res.json({ session: decorate(store.sessionByCode(row.code)) });
});

api.post('/sessions/:code/teams/:sector/rotate', (req, res) => {
  const row = store.sessionByCode(req.params.code);
  if (!row) return res.status(404).json({ error: 'not_found' });
  store.rotateJoinCode(row.id, String(req.params.sector).toUpperCase());
  res.json({ session: decorate(store.sessionByCode(row.code)) });
});

api.post('/sessions/:code/status', (req, res) => {
  const row = store.sessionByCode(req.params.code);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const status = String((req.body || {}).status || '').toUpperCase();
  if (!['DRAFT', 'LIVE', 'ENDED'].includes(status)) return res.status(400).json({ error: 'bad_status' });

  if (status === 'ENDED') registry.end(row.code);
  else {
    store.setSessionStatus(row.id, status);
    if (status === 'LIVE') registry.get(row.code);   // warm it before the room fills
  }
  res.json({ session: decorate(store.sessionByCode(row.code)) });
});

api.delete('/sessions/:code', (req, res) => {
  const row = store.sessionByCode(req.params.code);
  if (!row) return res.status(404).json({ error: 'not_found' });
  registry.evict(row.code);
  store.deleteSession(row.id);
  res.json({ ok: true });
});

api.get('/sessions/:code/log', (req, res) => {
  const row = store.sessionByCode(req.params.code);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const { runlog } = registry.paths(row.code);
  const body = fs.existsSync(runlog) ? fs.readFileSync(runlog, 'utf8') : '';
  res.type('application/x-ndjson')
     .set('Content-Disposition', `attachment; filename="runlog-${row.run_id}.jsonl"`)
     .send(body);
});

// -- facilitators (admin only) ------------------------------------------------

function requireAdmin(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only.' });
  next();
}

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  is_admin: !!u.is_admin,
  created_at: u.created_at,
  last_login_at: u.last_login_at,
  sessions_owned: store.countSessionsOwned(u.id),
});

api.get('/facilitators', requireAdmin, (_req, res) => {
  res.json({ facilitators: store.listFacilitators().map(publicUser) });
});

api.post('/facilitators', requireAdmin, (req, res) => {
  const { email, name, password, is_admin: isAdmin } = req.body || {};
  const clean = String(email || '').trim().toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
    return res.status(400).json({ error: 'That does not look like an email address.' });
  }
  if (!String(name || '').trim()) return res.status(400).json({ error: 'A name is required.' });
  if (store.facilitatorByEmail(clean)) {
    return res.status(409).json({ error: 'That email already has an account.' });
  }
  if (password && String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const generated = password ? null : require('crypto').randomBytes(9).toString('base64url');
  const user = store.createFacilitator({
    email: clean,
    name: String(name).trim(),
    passwordHash: hashPassword(password || generated),
    isAdmin: !!isAdmin,
  });
  res.status(201).json({ facilitator: publicUser(user), generated_password: generated });
});

api.post('/facilitators/:id/password', requireAdmin, (req, res) => {
  const user = store.facilitatorById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'not_found' });

  const supplied = (req.body || {}).password;
  if (supplied && String(supplied).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const generated = supplied ? null : require('crypto').randomBytes(9).toString('base64url');
  store.setPassword(user.id, hashPassword(supplied || generated));
  res.json({ ok: true, generated_password: generated });
});

api.post('/facilitators/:id/admin', requireAdmin, (req, res) => {
  const user = store.facilitatorById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'not_found' });
  const makeAdmin = !!(req.body || {}).is_admin;

  if (!makeAdmin && user.is_admin && store.countAdmins() <= 1) {
    return res.status(409).json({ error: 'This is the last admin — promote someone else first.' });
  }
  store.setAdmin(user.id, makeAdmin);
  res.json({ facilitator: publicUser(store.facilitatorById(user.id)) });
});

api.delete('/facilitators/:id', requireAdmin, (req, res) => {
  const user = store.facilitatorById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'not_found' });

  if (user.id === req.user.id) {
    return res.status(409).json({ error: 'You cannot remove your own account.' });
  }
  if (user.is_admin && store.countAdmins() <= 1) {
    return res.status(409).json({ error: 'This is the last admin — promote someone else first.' });
  }
  const owned = store.countSessionsOwned(user.id);
  if (owned > 0) {
    return res.status(409).json({
      error: `${user.name} owns ${owned} session${owned > 1 ? 's' : ''}. ` +
             'Delete or reassign them first so the run history keeps its author.',
    });
  }
  store.deleteFacilitator(user.id);
  res.json({ ok: true });
});

// -- printable kit ------------------------------------------------------------

api.get('/kit', (_req, res) => res.json(kit.summary()));

api.get('/kit/download/:file', (req, res) => {
  const found = kit.resolve(req.params.file);
  if (!found) return res.status(404).json({ error: 'not_found' });
  res.set('Content-Disposition', `attachment; filename="${found.entry.file}"`);
  res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.send(fs.readFileSync(found.full));
});

api.get('/kit/download-all', (req, res) => {
  const audience = req.query.audience === 'participant' ? 'participant'
    : req.query.audience === 'facilitator' ? 'facilitator' : null;
  const entries = kit.entries({ audience });
  if (!entries.length) return res.status(404).json({ error: 'no_kit' });

  const stamp = new Date().toISOString().slice(0, 10);
  const label = audience ? `-${audience}` : '';
  res.set('Content-Disposition', `attachment; filename="undercity-kit${label}-${stamp}.zip"`);
  res.type('application/zip');
  res.send(zip(entries));
});

app.use('/api/admin', api);

// -- control-token gated API (the game master console) -----------------------

/** The session named by ?session (LAN: LOCAL), only with its control token. */
function controlSession(req, res) {
  const code = String(req.query.session || (MODE === 'lan' ? LAN_CODE : '')).toUpperCase();
  const row = store.sessionByCode(code);
  const token = req.query.token || (req.body || {}).token;
  if (!row || token !== row.control_token) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return row;
}

// The facilitator panel needs the answer key; it is gated on the session's own
// control token, exactly as the control socket is.
app.get('/api/content', (req, res) => {
  const row = controlSession(req, res);
  if (!row) return;
  res.json({
    faults: content.faults, specs: content.specs, sectors: content.sectors, rounds,
    scenarios: scenarios.list(),
    urls: publicUrls(row),
  });
});

app.get('/api/log', (req, res) => {
  const row = controlSession(req, res);
  if (!row) return;
  const { runlog } = registry.paths(row.code);
  res.type('application/x-ndjson')
     .set('Content-Disposition', `attachment; filename="runlog-${row.run_id}.jsonl"`)
     .send(fs.existsSync(runlog) ? fs.readFileSync(runlog, 'utf8') : '');
});

/** Debrief numbers, folded from the run log on request. */
app.get('/api/debrief', (req, res) => {
  const row = controlSession(req, res);
  if (!row) return;
  const { runlog } = registry.paths(row.code);
  const text = fs.existsSync(runlog) ? fs.readFileSync(runlog, 'utf8') : '';
  const entry = registry.live.get(row.code);
  res.json(analyse(text, { runId: entry ? entry.game.state.run_id : null }));
});

app.get('/api/scenarios', (req, res) => {
  if (!controlSession(req, res)) return;
  res.json({ scenarios: scenarios.list() });
});

app.get('/api/scenarios/:id', (req, res) => {
  if (!controlSession(req, res)) return;
  const doc = scenarios.raw(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  res.json({ scenario: doc });
});

/** SAVE AS SCENARIO: the running game's configuration, under a new name. */
app.post('/api/scenarios', (req, res) => {
  const row = controlSession(req, res);
  if (!row) return;
  const { id, name, doc, from_live: fromLive } = req.body || {};
  let document = doc;
  if (fromLive || !document) {
    const entry = registry.get(row.code);
    const sc = entry.game.scenario;
    document = {
      notes: (req.body || {}).notes ?? sc.notes,
      defaults: sc.defaults, sectors: sc.sectors, intel: sc.intel,
      events: sc.events, fault_presets: sc.fault_presets, timelines: sc.timelines,
    };
  }
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'A scenario name is required.' });
  try {
    const key = scenarios.save({ id, name, doc: document });
    res.status(201).json({ ok: true, id: key, scenarios: scenarios.list() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/scenarios/:id', (req, res) => {
  if (!controlSession(req, res)) return;
  res.json({ ok: scenarios.remove(req.params.id), scenarios: scenarios.list() });
});

/** The LAN addresses to put on the projector and read out to the room. */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

function publicUrls(row) {
  const base = MODE === 'lan' ? '' : `/s/${row.code}`;
  const hosts = MODE === 'lan' ? lanAddresses().map((ip) => `http://${ip}:${PORT}`) : [];
  return {
    hosts,
    wall: `${base}/wall`,
    sectors: Object.fromEntries(SECTOR_CODES.map((c) => [c, `${base}/sector/${c}`])),
    admin: MODE === 'lan' ? '/admin' : `${base}/control`,
  };
}

app.get('/healthz', (_req, res) => res.json({
  ok: true,
  mode: MODE,
  live_sessions: registry.liveCodes().length,
  storage: {
    verdict: storage.verdict,
    boots: storage.boots,
    first_boot_at: storage.first_boot_at,
  },
}));

app.get('/', (_req, res) => res.redirect(MODE === 'lan' ? '/wall' : '/admin'));

// -- websockets ---------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

/** Full state to every client of ONE session, each through its own filter. */
function broadcast(entry) {
  entry.lastBroadcast = Date.now();
  entry.lastChanged = entry.game.changed;
  for (const client of entry.clients) {
    if (!client.ready) continue;
    send(client.ws, filterState(entry.game, client));
  }
  flushStings(entry);
}

/** Sounds queued by the engine go to the room (wall + sectors), never control. */
function flushStings(entry) {
  const stings = entry.game.drainStings();
  if (!stings.length) return;
  for (const name of new Set(stings)) {
    entry.log.write('sting', { sound: name, auto: true });
    for (const c of entry.clients) {
      if (c.ready && (c.role === 'bigscreen' || c.role === 'sector')) {
        send(c.ws, { type: 'sting', sound: name });
      }
    }
  }
}

wss.on('connection', (ws) => {
  const client = { ws, role: null, sector: null, session: null, ready: false, alive: true };

  ws.on('pong', () => { client.alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', reason: 'bad_json' });
    }
    try {
      handleMessage(client, msg);
    } catch (err) {
      // A bad frame must never take the run down mid-session.
      console.error('[ws] handler failed:', err);
      send(ws, { type: 'error', reason: 'server_error', got: msg && msg.type });
    }
  });

  ws.on('close', () => {
    if (client.session) {
      const entry = registry.live.get(client.session);
      if (entry && client.ready) {
        entry.log.write('disconnect', { role: client.role, sector: client.sector });
      }
      registry.detach(client.session, client);
    }
  });

  ws.on('error', () => { /* close handler cleans up */ });
});

setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN) continue;
    try { client.ping(); } catch { /* dropped on the next sweep */ }
  }
}, HEARTBEAT_MS);

function handleMessage(client, msg) {
  if (msg.type === 'hello') return handleHello(client, msg);
  if (!client.ready) return send(client.ws, { type: 'error', reason: 'not_ready' });

  const entry = registry.live.get(client.session);
  if (!entry) return send(client.ws, { type: 'error', reason: 'session_gone' });
  entry.lastTouch = Date.now();

  if (client.role === 'sector') return handleSector(client, entry, msg);
  if (client.role !== 'control') return send(client.ws, { type: 'error', reason: 'forbidden' });
  return handleControl(client, entry, msg);
}

function handleHello(client, msg) {
  const code = String(msg.session || (MODE === 'lan' ? LAN_CODE : '')).toUpperCase();
  const row = store.sessionByCode(code);
  if (!row) {
    send(client.ws, { type: 'error', reason: 'unknown_session' });
    return client.ws.close();
  }
  if (row.status === 'ENDED') {
    send(client.ws, { type: 'error', reason: 'session_ended' });
    return client.ws.close();
  }

  if (msg.role === 'control') {
    if (msg.token !== row.control_token) {
      send(client.ws, { type: 'error', reason: 'bad_token' });
      const known = registry.live.get(code);
      if (known) known.log.write('auth_rejected', { role: 'control' });
      return client.ws.close();
    }
    client.role = 'control';
  } else if (msg.role === 'bigscreen' || msg.role === 'wall') {
    client.role = 'bigscreen';
  } else if (msg.role === 'sector') {
    const sector = String(msg.sector || '').toUpperCase();
    if (!content.sectors.sectors[sector]) {
      send(client.ws, { type: 'error', reason: 'unknown_sector' });
      return client.ws.close();
    }
    client.role = 'sector';
    client.sector = sector;
  } else {
    send(client.ws, { type: 'error', reason: 'unknown_role' });
    return client.ws.close();
  }

  client.session = code;
  const entry = registry.attach(code, client);
  client.ready = true;

  const team = client.sector ? store.teamBySector(row.id, client.sector) : null;
  send(client.ws, {
    type: 'welcome',
    role: client.role,
    sector: client.sector,
    session: code,
    session_name: row.name,
    team_name: team ? team.team_name : null,
    teams: Object.fromEntries(
      store.teamsForSession(row.id).map((t) => [t.sector, t.team_name])
    ),
    urls: publicUrls(row),
    server_time: new Date().toISOString(),
  });
  send(client.ws, filterState(entry.game, client));
  entry.log.write('connect', { role: client.role, sector: client.sector });
}

// -- participant intents ------------------------------------------------------

function handleSector(client, entry, msg) {
  const game = entry.game;
  const mine = client.sector;
  if (msg.sector && String(msg.sector).toUpperCase() !== mine) {
    return send(client.ws, { type: 'error', reason: 'wrong_sector' });
  }

  switch (msg.type) {
    case 'submit_code':
      send(client.ws, submitCode(game, { ...msg, sector: mine }));
      return broadcast(entry);

    case 'set_inventory':
      game.setInventory(mine, msg.inventory || {});
      return broadcast(entry);

    case 'fault_open':
      game.openFault(mine, msg.fault_code);
      return broadcast(entry);

    /** The digital record of a physical chit — either party may raise it. */
    case 'transfer_request': {
      const from = String(msg.from || mine).toUpperCase();
      const to = String(msg.to || '').toUpperCase();
      if (from !== mine && to !== mine) return send(client.ws, { type: 'error', reason: 'not_party' });
      const result = game.requestTransfer({
        from, to, resource: msg.resource, amount: msg.amount, note: msg.note, by: mine,
      });
      send(client.ws, { type: 'transfer_result', ...result });
      return broadcast(entry);
    }

    case 'transfer_update': {
      const t = game.findTransfer(msg.id);
      if (!t || (t.from !== mine && t.to !== mine)) return send(client.ws, { type: 'error', reason: 'not_party' });
      const status = String(msg.status || '').toUpperCase();
      if (!['AGREED', 'WAITING_TRN', 'CANCELLED'].includes(status)) {
        return send(client.ws, { type: 'error', reason: 'bad_status' });
      }
      send(client.ws, { type: 'transfer_result', ...game.updateTransfer(msg.id, status, { by: mine }) });
      return broadcast(entry);
    }

    /** TRN's stamp. The rubber stamp on the chit is still the real one. */
    case 'transfer_stamp': {
      if (mine !== 'TRN') return send(client.ws, { type: 'error', reason: 'forbidden' });
      if (game.state.sectors.TRN.status === 'DARK') {
        return send(client.ws, { type: 'transfer_result', ok: false, reason: 'sector_dark' });
      }
      send(client.ws, { type: 'transfer_result', ...game.stampTransfer(msg.id, { by: 'TRN' }) });
      return broadcast(entry);
    }

    default:
      return send(client.ws, { type: 'error', reason: 'forbidden' });
  }
}

// -- facilitator authority ----------------------------------------------------

function handleControl(client, entry, msg) {
  const game = entry.game;
  const ok = () => broadcast(entry);
  const reply = (payload) => send(client.ws, payload);

  switch (msg.type) {
    // -- faults
    case 'fire_fault':
      reply({ type: 'fire_result', ...game.fireFault(msg.fault_code, msg.sector) });
      return ok();
    case 'fire_preset':
      reply({ type: 'fire_result', ...game.firePreset(msg.preset_id) });
      return ok();
    case 'clear_fault':      game.clearFault(msg.sector, msg.fault_code, msg.reason); return ok();
    case 'accelerate_fault': game.accelerateFault(msg.sector, msg.fault_code, msg.decay_per_min); return ok();
    case 'pause_fault':      game.pauseFault(msg.sector, msg.fault_code, msg.paused); return ok();
    case 'fault_add_time':   game.addFaultTime(msg.sector, msg.fault_code, msg.seconds); return ok();
    case 'runbook_mark': {
      if (msg.done) game.runbookDone.add(msg.beat_id);
      else game.runbookDone.delete(msg.beat_id);
      entry.log.write('runbook_mark', { beat_id: msg.beat_id, done: !!msg.done });
      return ok();
    }

    // -- sectors
    case 'set_integrity':      game.setIntegrity(msg.sector, msg.value); return ok();
    case 'adjust_integrity':   game.adjustIntegrity(msg.sector, msg.delta); return ok();
    case 'set_status':         game.setStatus(msg.sector, msg.value); return ok();
    case 'adjust_workforce':   game.adjustWorkforce(msg.sector, msg.active, msg.injured); return ok();
    case 'injure_worker':      game.injure(msg.sector, msg.count || 1); return ok();
    case 'recover_worker':     game.recover(msg.sector, msg.count || 1); return ok();
    case 'adjust_inventory':   game.adjustInventory(msg.sector, msg.delta); return ok();
    case 'set_sector_config':  game.patchSectorConfig(msg.sector, msg.patch || {}); return ok();

    // -- city
    case 'set_core_integrity':
    case 'set_core_output':    game.setCoreOutput(msg.value); return ok();
    case 'adjust_core':        game.setCoreOutput(game.state.core_integrity + Number(msg.delta || 0)); return ok();
    case 'set_stability':      game.setStability({ mode: msg.mode, value: msg.value }); return ok();
    case 'set_telemetry':      game.setTelemetry(msg.telemetry || {}); return ok();
    case 'set_intel':          game.setIntel(msg.key, msg.value !== undefined ? msg.value : msg.patch); return ok();
    case 'set_config':         game.patchConfig(msg.patch || {}); return ok();
    case 'set_fault_override':
      reply({ type: 'override_result', ...game.setFaultOverride(msg.fault_code, msg.patch === undefined ? null : msg.patch) });
      return ok();
    case 'set_sound':          game.setSound(msg.on); return ok();

    // -- tempo
    case 'set_phase':   game.setPhase(msg.phase); return ok();
    case 'next_phase':  game.nextPhase(); return ok();
    case 'set_round':   game.setRound(msg.round); return ok();
    case 'set_mode':    game.setMode(msg.mode); return ok();
    case 'clock':       game.clock(msg.action, msg.seconds, msg.which); return ok();
    case 'cycle': {
      const summary = game.cycleControl(msg.action, msg.seconds);
      if (summary) reply({ type: 'cycle_summary', summary });
      return ok();
    }
    case 'pause':       game.pause(); return ok();
    case 'resume':      game.resume(); return ok();
    case 'breather':    game.setBreather(msg.on); return ok();

    // -- the room
    case 'announce':    game.announce(msg.text, { sector: msg.sector || null }); return ok();
    case 'alert':       game.setAlert({ title: msg.title, subtitle: msg.subtitle, big: msg.big }); return ok();
    case 'dismiss_alert': game.dismissAlert(); return ok();
    case 'sting': {
      entry.log.write('sting', { sound: msg.sound });
      for (const c of entry.clients) {
        if (c.ready && (c.role === 'bigscreen' || c.role === 'sector')) {
          send(c.ws, { type: 'sting', sound: msg.sound });
        }
      }
      return ok();
    }

    // -- crisis
    case 'call_council':   game.callCouncil(); return ok();
    case 'end_council':    game.endCouncil(msg.reason || 'facilitator'); return ok();
    case 'continuity_order': {
      if (!msg.confirm) return reply({ type: 'error', reason: 'confirm_required' });
      reply({ type: 'order_result', ...game.submitContinuityOrder(msg.order) });
      return ok();
    }
    case 'rolling_blackout': {
      if (!msg.confirm) return reply({ type: 'error', reason: 'confirm_required' });
      game.startRollingBlackout();
      return ok();
    }
    case 'end_blackout':   game.endRollingBlackout(); return ok();
    case 'fire_event':
      reply({ type: 'event_result', ...game.fireEvent(msg.event_id, { target: msg.target }) });
      return ok();
    case 'cancel_scheduled': game.cancelScheduled(msg.id); return ok();
    case 'timeline_fire':  reply({ type: 'timeline_result', ...game.fireTimelineItem(msg.id) }); return ok();
    case 'timeline_skip':  game.skipTimelineItem(msg.id); return ok();
    case 'timeline_delay': game.delayTimelineItem(msg.id, msg.seconds); return ok();

    // -- transfers
    case 'transfer_request': {
      reply({ type: 'transfer_result', ...game.requestTransfer({ ...msg, by: 'facilitator' }) });
      return ok();
    }
    case 'transfer_update':
      reply({ type: 'transfer_result', ...game.updateTransfer(msg.id, String(msg.status || '').toUpperCase(), { by: 'facilitator' }) });
      return ok();
    case 'transfer_stamp':
      reply({ type: 'transfer_result', ...game.stampTransfer(msg.id, { by: 'facilitator', force: !!msg.force }) });
      return ok();

    // -- debrief on the wall
    case 'wall_debrief': {
      if (msg.on) {
        const { runlog } = registry.paths(entry.code);
        const text = fs.existsSync(runlog) ? fs.readFileSync(runlog, 'utf8') : '';
        game.state.wall_debrief = analyse(text, { runId: game.state.run_id }).comparison;
      } else {
        game.state.wall_debrief = null;
      }
      entry.log.write('wall_debrief', { on: !!msg.on });
      game.touch();
      return ok();
    }

    case 'observe':
      entry.log.write('observe', {
        sector: msg.sector || null, tag: msg.tag || null, note: msg.note || '',
      });
      game.ticker('obs', `${msg.tag || 'NOTE'}${msg.sector ? ' ' + msg.sector : ''}: ${msg.note || ''}`, { scope: 'admin' });
      reply({ type: 'observe_ack', t: new Date().toISOString() });
      return ok();

    // -- run control
    case 'reset_run': {
      if (!msg.confirm) return reply({ type: 'error', reason: 'confirm_required' });
      registry.resetRun(entry.code, { runId: msg.run_id, scenarioId: msg.scenario_id || null });
      return ok();
    }
    case 'snapshot':
      entry.log.writeSnapshot(game.serialise());
      reply({ type: 'snapshot_ack', t: new Date().toISOString() });
      return;
    case 'export_log': {
      const row = store.sessionByCode(client.session);
      reply({
        type: 'export_ready',
        url: `/api/log?session=${row.code}&token=${encodeURIComponent(row.control_token)}`,
      });
      return;
    }

    default:
      return reply({ type: 'error', reason: 'unknown_message', got: msg.type });
  }
}

// -- loops --------------------------------------------------------------------

/**
 * The engine ticks every second (deadlines, lockouts and the cycle need
 * that precision) but only broadcasts when something changed, or every
 * broadcast_ms as a heartbeat. Clients interpolate countdowns in between.
 */
const tickMs = Number(rounds.defaults.tick_ms || 1000);
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastTick;
  lastTick = now;
  for (const entry of registry.entries()) {
    const game = entry.game;
    try { game.tick(elapsed); } catch (err) { console.error('[tick] failed:', err); }
    const heartbeat = Number(game.cfg.broadcast_ms || 10000);
    if (game.changed !== entry.lastChanged || now - (entry.lastBroadcast || 0) >= heartbeat) {
      broadcast(entry);
    } else {
      flushStings(entry);
    }
  }
}, tickMs);

setInterval(() => {
  for (const entry of registry.entries()) entry.log.writeSnapshot(entry.game.serialise());
}, rounds.defaults.snapshot_ms);

setInterval(() => {
  registry.sweepIdle();
  store.purgeExpiredAuthSessions();
}, 10 * 60 * 1000);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    // A redeploy must not cost a live run: snapshot everything on the way out.
    registry.closeAll();
    try { store.close(); } catch { /* already closed */ }
    process.exit(0);
  });
}

if (require.main === module) {
  server.listen(PORT, () => {
    reportStorage(storage);
    console.log(`\nUNDERCITY — HAVEN-9  [${MODE} mode]`);
    if (MODE === 'lan') {
      const ips = lanAddresses();
      const host = ips[0] ? `http://${ips[0]}:${PORT}` : `http://localhost:${PORT}`;
      console.log(`  WALL (projector)      ${host}/wall`);
      console.log(`  SECTOR laptops        ${host}/sector/POW  …/WTR  …/MED  …/TRN  …/AGR  …/COM`);
      console.log(`  ADMIN (facilitator)   ${host}/admin?token=${LAN_TOKEN}`);
      if (ips.length > 1) console.log(`  other addresses       ${ips.slice(1).join(', ')}`);
      console.log('');
    } else {
      console.log(`  admin       http://localhost:${PORT}/admin`);
      console.log(`  data dir    ${DATA_DIR}`);
      if (store.countFacilitators() === 0) {
        console.log('\n  ⚠ No facilitator accounts yet — this instance is unclaimed.');
        console.log('      Open /admin and create the first admin account now.');
        console.log('      That form is available ONLY while zero accounts exist.\n');
        console.log('    Alternatives: set ADMIN_EMAIL (+ ADMIN_PASSWORD) and redeploy,');
        console.log('    or run:  npm run create-user -- "you@example.com" "Your Name"\n');
      } else {
        console.log('');
      }
    }
  });
}

module.exports = { app, server, store, registry, scenarios, auth, MODE };
