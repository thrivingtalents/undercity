# UNDERCITY — HAVEN-9

The game control system for the UNDERCITY crisis-leadership simulation: one
server, three synchronised screens, one live game state.

Six sector tables (18–36 participants) keep an underground city alive through
a four-round shift while a facilitator turns the pressure dials from a game
master console. **The software is the world engine, not the product** — it
creates time pressure, scarcity and visible consequences, and records what
happened. The participants still talk, negotiate, walk, consult binders, sign
Transfer Chits and sit in Council. `runlog.jsonl` is what feeds the debrief.

Design authority: `docs/undercity-spec.md`.
Protocol authority: `docs/undercity-message-contract.md` (§8 is the game
control extension). Where the two differ, **the contract wins**.

---

## The three screens

```text
                 /admin  (facilitator's game master console)
                     │
                 GAME STATE   ← one authoritative process, server-side timers
              ╱       │        ╲
          /wall   /sector/POW   … /sector/COM
       projector   one laptop per sector (POW WTR MED TRN AGR COM)
```

| Screen | Who | LAN URL | What it does |
|---|---|---|---|
| **Wall** | projector, whole room | `/wall` | CITY STABILITY · CORE OUTPUT · NEXT CORE CYCLE · six sector cards (integrity, stock, workers, worst fault + countdown, status word) · event feed · emergency overlay · Council takeover · paused · Round 3 vs Aftershock |
| **Sector** | the Systems Lead | `/sector/POW` … `/sector/COM` | What's wrong · how long · what we have · what to enter. Fault list → open card → resolution console with 3-strike 20 s lockout. Transfers panel. TRN gets the transfer queue + STAMP; COM gets City Intelligence |
| **Admin** | the facilitator | `/admin?token=haven9` | Phase/master timer, seven always-visible quick actions, 2×3 sector control grid, pressure panel (faults · timeline · events · council · core · transfers · settings · debrief), live log, observation pad |

Every screen updates in real time over one websocket; no refresh, ever. A
laptop that drops and rejoins gets the current state and its timers continue
from where the server has them. `/bigscreen` is still there: the original
HAVEN-9 cross-section map, fed from the same frame.

---

## Run it

### LAN — the travel router (use this in a hotel)

No internet is needed during play. The facilitator's laptop runs the server;
the projector and six sector laptops join over the same Wi-Fi/LAN.

```bash
npm install
npm run start:lan            # or: MODE=lan node server.js
```

The boot log prints the addresses to read out to the room, e.g.

```text
  WALL (projector)      http://192.168.1.20:3000/wall
  SECTOR laptops        http://192.168.1.20:3000/sector/POW  …/WTR  …/MED  …/TRN  …/AGR  …/COM
  ADMIN (facilitator)   http://192.168.1.20:3000/admin?token=haven9
```

Admin → **URLS** shows the same list on screen. Change the facilitator token
with `FACILITATOR_TOKEN=…`. A second Admin connection is allowed (a dead
laptop must not end the run). The Admin page asks for the token if the URL
does not carry one.

```bash
PORT=3000 FACILITATOR_TOKEN=haven9 MODE=lan node server.js
RUNLOG_PATH=/media/usb/run.jsonl SNAPSHOT_PATH=/media/usb/snap.json MODE=lan node server.js   # log to a stick
npm test                                                                            # ~160 tests
```

### Demo scenario

With a LAN server running, open `/wall`, `/sector/POW`, `/sector/TRN` and
`/admin?token=haven9`, then:

```bash
npm run demo                 # DEMO_FAST=1 for a quicker run; DEMO_URL / DEMO_TOKEN to point elsewhere
```

It resets the run to the **HAVEN-9 DEMO** scenario
(`config/scenarios/haven9-demo.json`: two-minute cycles, a 90-second council,
short deadlines, six sectors that start at visibly different integrity and
stock, and an R2 script that fires itself) and walks the thirteen beats of
spec §50 — normal state, fault, countdown, wrong code, lockout, correct code
(stock deducted, +5 integrity), transfer stamped by TRN, integrity loss,
CRITICAL, Council, Continuity Order, brownout, sector DARK, and the Round 3 vs
Aftershock comparison on the wall. `DEMO_SCENARIO=haven9-standard` runs the
same beats on the standard clocks. Demo values are demo values, not balance;
pick HAVEN-9 STANDARD again (Admin → SETTINGS → RESET RUN WITH SCENARIO)
before a real cohort.

### Hosted — the platform

Many concurrent sessions, facilitator accounts, a sessions panel that creates
a session, picks its scenario, names the six tables and hands each one a join
link.

```bash
npm run create-user -- you@example.com "Your Name"   # prints a password once
npm start                                            # http://localhost:3000/admin
```

| Screen | URL |
|---|---|
| Sessions panel (accounts) | `/admin` |
| Wall | `/s/<CODE>/wall` |
| Admin console | `/s/<CODE>/control?token=…` |
| A team's dashboard | `/j/<JOIN CODE>` → their own sector |

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `MODE` | `lan` unless `DATA_DIR` is set | `hosted` or `lan` |
| `DATA_DIR` | `./data` | SQLite file, saved scenarios, one runlog per session |
| `PORT` | `3000` | |
| `FACILITATOR_TOKEN` | `haven9` | LAN mode admin token |
| `SECURE_COOKIES` | on when `NODE_ENV=production` | `Secure` flag on the sessions-panel cookie |
| `ADMIN_EMAIL` / `ADMIN_NAME` / `ADMIN_PASSWORD` | — | hosted mode: seed the master admin on first boot |
| `KIT_DIR` | `./kit` | where the printable documents live |
| `RUNLOG_PATH` / `SNAPSHOT_PATH` | under `DATA_DIR` | LAN mode only |

---

## How a round works

1. **Phases.** `SETUP → ORIENTATION → ROUND_1 → ROUND_2 → ROUND_3 → DEBRIEF_1 →
   AFTERSHOCK → DEBRIEF_2 → FINISHED` (`lib/rounds.json`). Each phase maps to a
   round and a mode; every change is timestamped. Admin: START / PAUSE /
   RESUME / END PHASE / NEXT PHASE. PAUSE freezes every timer (master clock,
   fault countdowns, council, core cycle, temporary effects) and the wall and
   sectors say SIMULATION PAUSED. RESUME continues from the exact remaining
   times. RESET requires confirmation.
2. **Faults.** Admin fires one from the picker (one click), a preset ("ROUND 2
   WAVE A", several faults with delays) or the round's **timeline**. The fault
   appears on that sector's screen with its countdown, and as the wall's
   headline fault for that sector. The team looks the code up in the physical
   binder, gathers resources and cross-sector spec values, and enters the
   resolution code. Wrong code → attempt recorded; three consecutive wrong
   codes → console locked 20 s (server-controlled). Right code → +5 integrity,
   the procedure's resources leave the digital stock, the wall credits the
   sector. Deadline reached → `EXPIRED`, an integrity penalty by severity, and
   the fault stays solvable (all configurable).
3. **Core cycle.** A city-wide countdown (default 7:00). At zero the server
   processes the cycle: production → upkeep → shortage penalties → worker
   recovery (MED spends med supplies) → brownout effects → city stability →
   next cycle. Admin sees a per-sector summary; Transport's per-cycle stamp
   capacity resets.
4. **Transfers.** The Transfer Chit stays physical. The digital record follows
   `REQUESTED → AGREED → WAITING_TRN → STAMPED → DELIVERED`; only TRN's STAMP
   (or Admin) moves stock, and only within Transport's capacity, which
   brownout, gridlock and tunnel collapse reduce.
5. **Council.** CALL COUNCIL puts the 5:00 summons on every screen. Admin
   records the **Continuity Order** by clicking sectors in rank order; it
   confirms ("This decision cannot be recalled."), ranks 5 and 6 enter
   BROWNOUT, the wall announces CONTINUITY ORDER ACCEPTED. No order at 00:00
   → NO CONTINUITY ORDER RECEIVED and a one-click **rolling blackout**, which
   rotates brownout through the city until Admin ends it.
6. **Pressure.** Quick actions (TRIGGER FAULT · CORE −10% · INJURE WORKER ·
   CALL COUNCIL · BROWNOUT · ANNOUNCEMENT · ALERT · PAUSE) are always on
   screen. The pressure dial and configurable **events** (supply delay,
   transport gridlock, false sensor reading, power surge, tunnel collapse,
   communication blackout, biological breach…) each have a visibility:
   `ADMIN_ONLY`, `CITY_WIDE`, `TARGET_SECTOR` or `COMMS_ONLY`.
7. **Debrief.** Admin → DEBRIEF folds the log into per-round numbers (faults
   resolved, time to first action, average response, failed console entries,
   lockouts, transfers and their timing, critical entries, council decision
   time) and a neutral Round 3 vs Aftershock table that can be put on the
   wall. No winner is declared.

The facilitator's eyes belong on the room: nothing on the Admin console is
more than two clicks away and only destructive actions confirm.

---

## Configuration, not code

Anything involving balance lives in a **scenario**
(`config/scenarios/haven9-standard.json`) and is editable live from Admin →
SETTINGS: the status thresholds (`critical_below`, `degraded_below`,
`dark_at`), lockout, council clock, core output at start, the length of every
round, cycle length, production and upkeep per sector, deadline defaults and
penalties by severity, per-fault overrides (a deadline, an expiry penalty and
extra accepted codes for one fault), brownout effects (with per-sector
specials: COM loses telemetry, TRN capacity drops, POW production collapses),
transport capacity, the city stability formula and its weights, resource
minimums, wall detail switches, event presets, fault presets, the round
timelines and COM's intelligence items. The status word every screen prints
(STABLE · DEGRADED · CRITICAL · BROWNOUT · DARK) is computed on the server
from those thresholds; no client carries a number.

**SAVE AS SCENARIO** stores the running configuration in SQLite under a name
(`HAVEN-9 HARD`, `HAVEN-9 CLIENT TEST`…); a saved copy with a built-in's id
shadows it, deleting the copy reveals the built-in again. A session chooses
its scenario when created (hosted) or on RESET RUN WITH SCENARIO (Admin).
A scenario file may `"extends"` another and state only what differs —
`defaults` and `sectors` merge over the parent, while `events`,
`fault_presets`, `intel` and each round's timeline are taken whole from
whichever document defines them. `haven9-demo.json` is the worked example.

Three switches decide how much the computer does, because the earlier design
deliberately kept it out of the economy (contract §3.5):

| Switch | Default | Off means |
|---|---|---|
| `auto_economy` | on | production, upkeep and transfers are recorded but move no stock |
| `deduct_resources_on_resolve` | on | a resolve is a declaration; chits are the only ledger |
| `resolve_requires_resources` | off | (on) a team short of stock is refused, not just logged |

Nothing in this file has been playtested. Treat every number as a starting
point.

---

## Layout

```text
server.js                Express + ws; routes, intents, the 1 s engine tick, change-based broadcast
config/scenarios/        game configuration — every balance number (HAVEN-9 STANDARD and the fast-clock DEMO ship)
content/*.json           faults · specs · sectors — generated from the matrix, never hand-edited
lib/
  config.js              ScenarioLibrary: built-ins + saved copies, deep merge, resolve for play
  state.js               authoritative state and every reducer; economy + crisis mixed in
  economy.js             pure functions: city stability formula, production/upkeep, PROCESS CYCLE
  crisis.js              council, Continuity Order, rolling blackout, events, scheduled queue, timeline
  resolve.js             submit_code, in the contract's exact order (deduction is a switch)
  visibility.js          per-role filtering — THE SECURITY BOUNDARY
  analytics.js           runlog.jsonl → per-round stats, Round 3 vs Aftershock comparison, timeline
  log.js                 runlog.jsonl appender (+ round/phase context) and snapshot writer
  rounds.json            rounds and phases from spec §8
  db.js                  SQLite: facilitators, sessions, teams, scenarios
  auth.js                scrypt passwords, server-side cookie sessions (sessions panel only)
  sessions.js            registry of concurrent games, one per session, reset with scenario
  kit.js · zip.js        the printable kit and its download
public/
  wall/                  projector   (spec §6–§11)
  sector/                sector laptop (spec §12–§23)
  control/               admin console (spec §24–§34, §44, §46)  — served at /admin and /control
  bigscreen/             the original HAVEN-9 cross-section map view
  admin/                 hosted sessions panel (accounts, join links, print kit)
  shared/ws.js           connect · countdown interpolation · audio with synthesised fallbacks
  audio/                 drop <sting>.mp3 here to replace a placeholder tone
scripts/demo.js          the demo scenario (spec §50)
scripts/create-user.js   facilitator accounts
tools/ · kit/            content pipeline and the printable documents (unchanged)
test/                    unit, engine, visibility, integration, resilience, hosted, accounts suites
```

### Architecture in five sentences

The server holds one `GameState` per session in memory, ticks it every
second, and after any change broadcasts a **full state frame** to every
client of that session — each client gets its own projection from
`lib/visibility.js`, so a sector laptop never receives another sector's stock,
any answer key, or the dependency half of a fault's flavour line. Clients
render what they are told and send intents; timers are server-authoritative
and clients only interpolate countdowns between frames. Every state change is
appended to `runlog.jsonl` with its round and phase, and the game is
snapshotted every 10 s so a crash or redeploy resumes mid-run. Balance lives
in a scenario document, the engine has no numbers of its own, and the content
(faults, specs, sectors) is generated from the spreadsheet that also prints
the binders. A cloud deployment is the same process with accounts and many
sessions in front of it; nothing about the game changes.

### Database schema (SQLite, `DATA_DIR/undercity.db`)

| Table | Holds |
|---|---|
| `facilitators` | accounts: email, name, scrypt hash, is_admin |
| `auth_sessions` | server-side login tokens |
| `sessions` | one row per run: code, run_id, name, client, owner, control_token, status, **scenario_id** |
| `teams` | six per session: sector, table name, join code |
| `scenarios` | saved scenario documents (id, name, notes, json) |

Game state itself is **not** in the database. It lives in memory and in
`DATA_DIR/runs/<CODE>/snapshot.json`; the log is `runlog.jsonl` beside it.
Migrations are additive and run at boot (`lib/db.js` → `migrate`).

---

## Adding faults, events, presets and timelines

- **A new fault** starts in `tools/undercity-crossref-matrix.xlsx` (see *Content
  pipeline* below), never in `content/faults.json`. Deadlines and injuries can
  be set per fault there; a fault with no deadline gets the scenario's default
  for its severity (`deadline_default_s`).
- **Tuning one fault for a run** (deadline, expiry penalty, extra accepted
  codes) is a scenario override — Admin → SETTINGS → *Fault overrides*, or
  `fault_overrides: { "F-201": { "deadline_s": 480, "integrity_penalty": 10,
  "extra_valid_codes": ["P-04-290"] } }` in the file. It applies to faults
  fired from then on. An extra code is added *beside* the content answer, never
  instead of it: that lets a facilitator honour a binder misprint mid-session
  without desynchronising paper from server, which is why the answer itself is
  not editable here.
- **A new event**: add an object to `events[]` in a scenario. Fields:
  `id name description targets` (`"ALL"`, `"PICK"`, `"RANDOM2"` or a list),
  `visibility`, and any of `integrity_changes {SECTOR|TARGET: delta}`,
  `resource_changes {…}` (per target), `resource_changes_all {…}`,
  `worker_changes { injure, sectors? }`, `core_delta`, `intel_changes {key: value}`,
  `effects [{ kind: trn_capacity|com_blind|no_production, value|delta, duration_s|cycles }]`,
  `alert { title subtitle big }`, `announce` (`{target}` is substituted),
  `followups [{ event_id, delay_s }]`. It appears on the PRESSURE tab at once.
- **A fault preset**: `fault_presets[]` → `{ id, name, items: [{ fault_code, sector, delay_s }] }`.
- **A round timeline**: `timelines.R2[]` → `{ offset_s, kind, mode }` where kind
  is `fault` (`fault_code`, `sector`), `event` (`event_id`), `council`,
  `core` (`value`), `announce` (`text`), `alert` (`text`) or `cycle`, and mode
  is `AUTO` (fires itself) or `MANUAL` (turns into READY TO FIRE — the
  facilitator hands the card and presses it). Skip or delay anything; the
  script never forces the room.
- **COM intelligence**: `intel[]` → `{ key, label, value, hidden_in_brownout }`;
  editable live from Admin → CORE.

Edit a built-in in `config/scenarios/`, or save a copy from Admin.

---

## Content pipeline

The spreadsheet is the game. The code is a display layer.

```
tools/build_crossref.py              generates the workbook (deterministic, seed 9)
  └─ recalculate in Excel/LibreOffice   formulas must be cached
       ├─ npm run export-content        → content/*.json   (server)
       └─ npm run kit                   → kit/*.docx       (paper)
```

Both branches read the **same cells**, so paper and server cannot disagree.
**Never hand-edit `content/*.json`.** A hand-fix desynchronises paper from
server and makes a fault unsolvable mid-session — the one failure a
facilitator cannot recover from live. `lib/validate.js` re-checks the
fixtures at every boot; errors abort startup. Findings to date are in
`CONTENT-ISSUES.md`.

## The paper kit

Sign in to the hosted `/admin` → **PRINT KIT**: fault cards, City Charter,
role cards, transfer chits, consent pack (participant-facing) and the answer
key, six sector binders and the Guidebook (facilitator only). A badge says
whether the kit matches the content the server is running (SHA-256 of every
content file, recorded at build time). `npm run kit` rebuilds locally
(needs `openpyxl` and the `docx` devDependency). Three content rules are
enforced by the generators: a card prints the symptom only; a binder never
prints another sector's spec values or a complete code; Appendix C gets no
index entry.

## Two structural edge cases

- **`F-201` has two valid codes.** The WTR binder prints reservoir pressure
  **340**; the wall shows **290**. The server accepts either. Never reconciled —
  the mismatch *is* the psychological-safety probe (spec §3.7).
- **`F-210` has zero.** A sensor ghost with no procedure. Every submission
  returns `no_procedure`; only the facilitator can clear it. Driven off
  `valid_codes.length === 0`, never off the code.

## Visibility

Filtering happens on the server. Participants will open devtools, so anything
a sector must not know is never put in its frame.

| Role | Own sector | Other sectors | Extra |
|---|---|---|---|
| `sector` | full | integrity + status only, **60 s stale** | own transfers, own announcements, own effects |
| `sector` = COM | full | as above **+ foreign fault codes and names, live** | CITY INTELLIGENCE (UNKNOWN under brownout/blackout) |
| `sector` = TRN | full | as above | TRANSFER QUEUE + capacity + STAMP |
| `wall` | — | integrity, status, workers, stock summary, worst fault + countdown, public feed | none of it while COM is DARK; **never** an answer key, procedure or flavour line |
| `control` | everything, live | everything, live | `valid_codes`, config, timeline, transfers, debrief |

The wall's stock summary and headline fault are switches
(`wall_shows_inventory`, `wall_shows_faults`) so the original "bars only"
projector is one setting away. A sector's screen says only *consult your
binder*; the dependency half of every flavour line is cut server-side, exactly
as the printed card cuts it.

## Deliberate non-features

Do not let a future change add these:

- **No chat.** All inter-sector communication is voice or feet.
- **No digital Transfer Chit.** The chit is signed by both Liaisons and
  stamped by TRN on paper; the screen only records the status.
- **No automatic triage.** The sector screen lists faults in the order they
  arrived and never says which to solve first.
- **No cascade AI.** Every fault is fired by the facilitator, a preset they
  chose, or a timeline they armed — and MANUAL beats wait for them.
- **No participant accounts.** Teams join by URL or code and stay anonymous.
- **No behavioural analysis in the app.** The debrief shows counts and
  durations; interpretation is the facilitator's.

## runlog.jsonl

One JSON object per line, appended on every state change, rotated on
`reset_run`, each line stamped with its `round` and `phase`. At R0 the
facilitator fires the klaxon; the audio spike aligns every recording to this
log. Logged: phases and clocks, faults fired/opened/resolved/expired/cleared,
every console submission accepted *and* rejected, lockouts, inventory
declarations, cycles and missed upkeep, injuries and recoveries, every
transfer step, council calls/orders/no-order, blackouts, events and effects,
alerts, announcements, configuration changes, observation tags, connects and
disconnects. `lib/analytics.js` reads nothing else.

---

## Deploying (Render)

`render.yaml` and the `Dockerfile` deploy the hosted mode as a single
always-on service with a persistent disk (`/var/data`). Open `/admin` to
claim the instance on first run. **Attach a persistent disk** or accounts,
sessions, saved scenarios and run logs are lost on restart — the boot log,
`/healthz` and the sessions panel all warn when `DATA_DIR` is ephemeral.
**Do not raise `numInstances` above 1**: game state is authoritative in one
process. A paid instance is required (free instances sleep mid-session).
Accounts and saved scenarios survive redeploys; a deploy replaces the image,
not the disk.
