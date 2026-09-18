# UNDERCITY — Websocket Message Contract & Build Handoff

**Companion to:** `undercity-spec.md` (design) · `undercity-crossref-matrix.xlsx` (content source of truth) · `export_faults.py` (fixture generator)
**Purpose:** the contract every client and the server agree on, written down *before* any code exists. Paste this into Claude Code as the first context of the build.

---

## 0. Read this first (build principles)

1. **The server is authoritative.** Clients never compute game state. They render what they are told and send intents. No optimistic UI.
2. **Broadcast full state, always.** ~3–5 KB JSON, 8 clients, human-speed events. Diffing is premature optimisation and a bug factory. One `state` message shape, every client re-renders from it.
3. **Content is loaded, never coded.** Server reads `content/faults.json`, `content/specs.json`, `content/sectors.json` at boot. Changing the game = re-running `export_faults.py`, not editing source.
4. **Two edge cases are structural, not exceptions.** `valid_codes` is an *array* (F-201 accepts two codes), and it may be *empty* (F-210 is a false alarm with no code). Any code path that assumes exactly one code is wrong.
5. **No chat feature, ever.** All inter-sector communication is voice or feet. A chat box would route the diagnostic data into silent text and destroy the product.
6. **Every state change is logged** to `runlog.jsonl` — this file is joined to audio timestamps in debrief. Logging is a P0 feature, not instrumentation.

---

## 1. Connection & identity

Three client roles, distinguished by URL at connect time:

| Role | URL | Count | Trust |
|------|-----|-------|-------|
| `sector` | `/sector/POW` … `/sector/COM` | 6 | Untrusted-ish (participants) |
| `bigscreen` | `/bigscreen` | 1 | Read-only |
| `control` | `/control?token=<FACILITATOR_TOKEN>` | 1 | Full authority |

On websocket open, client sends `hello`; server replies `state` (full snapshot) and thereafter broadcasts `state` on every change.

```json
// client -> server, first message
{ "type": "hello", "role": "sector", "sector": "POW", "token": null }
{ "type": "hello", "role": "control", "token": "haven9" }
```

```json
// server -> client, on accept
{ "type": "welcome", "role": "sector", "sector": "POW", "server_time": "2026-09-14T09:02:11.482Z" }
```

Rules: reject `control` without a matching token (closes socket). A second `control` connection is allowed (facilitator laptop dies mid-run — this must not be fatal). Sector clients reconnect freely; identity is the URL, there are no accounts or sessions.

**Heartbeat:** server pings every 20 s; client replies pong. Sector dashboard shows a small connection dot — amber on missed pong, red on disconnect, with "RECONNECTING". A frozen dashboard mid-crisis with no indicator is the worst possible failure mode in the room.

---

## 2. Server → all clients: `state`

The only message that carries game state. Full snapshot every time.

```json
{
  "type": "state",
  "server_time": "2026-09-14T10:42:03.117Z",
  "run_id": "2026-09-14-clientX-c1",
  "mode": "PLAY",
  "round": "R2",
  "round_clock": { "running": true, "remaining_s": 1140 },
  "council_clock": { "running": false, "remaining_s": 300 },
  "core_integrity": 74,
  "sectors": {
    "POW": {
      "code": "POW",
      "name": "Power Grid",
      "integrity": 61,
      "status": "ACTIVE",
      "workforce": { "active": 6, "injured": 2 },
      "inventory": { "power": 4, "water": 1, "parts": 2, "med": 0 },
      "upkeep_due_in_s": 252,
      "faults": [
        {
          "code": "F-201",
          "name": "Coolant loop failure",
          "flavour": "Turbine coolant pressure collapsing...",
          "severity": 2,
          "crew_required": 2,
          "resources_required": { "parts": 2, "water": 1 },
          "decay_per_min": 1.5,
          "attempts": 3,
          "locked_until_s": 0,
          "fired_at": "2026-09-14T10:38:00.000Z"
        }
      ]
    }
  },
  "ticker": [
    { "t": "...", "kind": "resolve", "text": "WTR resolved F-105" },
    { "t": "...", "kind": "fault",   "text": "POW fault detected: F-201" },
    { "t": "...", "kind": "transfer","text": "WTR → POW transfer stamped" }
  ],
  "announcements": [
    { "t": "...", "text": "Core output dropping. Council convenes in 10 minutes." }
  ],
  "telemetry": { "wtr_reservoir_pressure": 290, "core_output_pct": 100 }
}
```

**`mode`:** `BRIEFING` | `PLAY` | `COUNCIL` | `PAUSED` | `DEBRIEF`
**`status`:** `ACTIVE` | `CRITICAL` (<30) | `BROWNOUT` | `DARK` (0)

### Visibility filtering — do this server-side, not client-side

The server sends each sector client a **filtered** state. Never send the full picture and hide it in CSS; participants will open devtools.

- Own sector: full fidelity.
- Other sectors: `integrity` and `status` only, **snapshotted 60 s ago** (server keeps a rolling delayed copy). No fault arrays, no inventory, no workforce.
- **COM exception:** `full_telemetry: true` in `sectors.json` — COM receives other sectors' *fault codes and names* in real time (not inventory). This is the asymmetric-information engine; it is a feature, not a leak.
- `bigscreen` receives integrity/status/ticker/telemetry for all, no fault detail, no inventory.
- `control` receives everything, undelayed, plus `valid_codes` for every active fault (the facilitator's live answer key).

`telemetry.wtr_reservoir_pressure` is **290** — the public half of the seeded discrepancy (the WTR binder prints 340). Both resolve F-201. Never reconcile these two numbers.

---

## 3. Sector client → server (participant intents)

```json
{ "type": "submit_code", "sector": "POW", "fault_code": "F-201",
  "code": "P-04-340", "workers_assigned": 2 }

{ "type": "set_inventory", "sector": "POW",
  "inventory": { "power": 4, "water": 1, "parts": 2, "med": 0 } }
```

`set_inventory` is **no longer accepted from a sector** (2026-09-17). It is
refused with `inventory_read_only`. A sector's stock moves on production,
upkeep, a solved fault, and a transfer Transport has approved — and nowhere
else, because a table that can write its own stock walks straight through the
supplier's consent and Transport's three approvals a round. The facilitator
still corrects a count from Admin with `adjust_inventory`, which is logged.

### `submit_code` resolution logic (server-side, exact order)

1. Fault exists, belongs to this sector, is unresolved → else `reject: "unknown_fault"`.
2. `locked_until_s > 0` → `reject: "locked"`.
3. `workers_assigned` must be a whole number no greater than the sector's available workers → else `reject: "invalid_workers"`; and at least `crew_required` → else `reject: "insufficient_crew"`. Neither reply carries the required number or the shortfall; those go to the log only. A materials refusal (`insufficient_resources`) likewise names no material. The screen prints WORKER ASSIGNMENT INVALID, INSUFFICIENT CREW, MATERIALS NOT READY and RESOLUTION REJECTED.
4. `code` (trimmed, uppercased, hyphens normalised) is in `valid_codes` → else increment `attempts`, `reject: "invalid_code"`; on 3 consecutive invalids set `locked_until_s = 20`.
5. **Resources are deducted by the server** when `deduct_resources_on_resolve` is on (the default), and the shortfall refuses the resolve when `resolve_requires_resources` is on. Both are scenario switches; with both off the original behaviour returns, except that a sector can no longer write its own stock — only the facilitator can.
6. On success: mark resolved, stop decay, apply `+5` integrity recovery, ticker entry crediting the sector, log it.

**There is no deadline** (2026-09-17). A fault carries no countdown, expiry or penalty at a moment in time; decay is the only pressure. A sector's fault view carries `code, name, flavour` (the symptom only), `severity, decay_per_min, attempts, locked_until_s, status, reward, reward_claimed` and never `crew_required`, `resources_required`, `procedure` or a deadline field. Old `deadline_*` fields in a snapshot or the content are read and ignored.
7. **Then the fault's reward** (`lib/fault-rewards.json`, one per fault): resources into the owner's real inventory and/or health capped at 100 (a DARK sector stays at 0), claimed once per run under `faultReward:{run_id}:{code}` and kept in `state.rewards_claimed` so a re-fired fault, a refresh, a reconnect or a duplicate frame can never pay twice. `submit_result` carries `reward { applied, resources, health, health_before, health_after, text }` or `{ applied: false, reason }`. Every sector frame's fault carries `reward { resources, health, text }` (null when the preview is off) and `reward_claimed`. Facilitator `clear_fault` pays nothing unless `reward_on_facilitator_force_resolve` is on (then logged as an override), except for a fault with no procedure, whose clear is its completion. Events: `fault_reward_applied`, `fault_reward_duplicate_blocked`, `fault_reward_force_resolve_skipped`, `fault_reward_admin_override`.

**Empty `valid_codes` (F-210, false alarm):** every submission returns `reject: "no_procedure"` with UI text *"No matching procedure. Verify this alert."* The facilitator clears it manually via `clear_fault` once COM confirms the ghost. Do not special-case F-210 by code — drive it off the empty array, so future false alarms need no code change.

```json
// server -> requesting client only
{ "type": "submit_result", "fault_code": "F-201", "accepted": true,
  "reason": null, "attempts": 3 }
{ "type": "submit_result", "fault_code": "F-201", "accepted": false,
  "reason": "invalid_code", "attempts": 4, "locked_until_s": 20 }
```

---

## 4. Control panel → server (facilitator authority)

Every message requires the token. Grouped by control-panel column (§6.3 of the spec).

**Col 1 — Runbook / injects**
```json
{ "type": "fire_fault",  "fault_code": "F-201", "sector": "POW" }
{ "type": "clear_fault", "fault_code": "F-210", "sector": "AGR", "reason": "false alarm confirmed" }
{ "type": "runbook_mark", "beat_id": "R2-04", "done": true }
```
`fire_fault` looks the fault up in `faults.json` and instantiates it on the sector, applying `injures_workforce` (tokens move to MED's injured count) — server-side, so the facilitator never has to remember.

**Col 2 — City state (god view)**
```json
{ "type": "set_integrity", "sector": "POW", "value": 45 }
{ "type": "set_status",    "sector": "AGR", "value": "BROWNOUT" }
{ "type": "adjust_workforce", "sector": "MED", "active": 1, "injured": -1 }
{ "type": "adjust_inventory", "sector": "WTR", "delta": { "parts": -2 } }
{ "type": "set_core_integrity", "value": 60 }
{ "type": "accelerate_fault", "fault_code": "F-301", "decay_per_min": 4.0 }
```

**Col 3 — Tempo**
```json
{ "type": "set_round", "round": "R3" }
{ "type": "clock", "action": "start" }        // start | pause | add, with "seconds"
{ "type": "set_mode", "mode": "COUNCIL" }     // triggers big-screen takeover + 5:00
{ "type": "announce", "text": "Core output dropping to 60 percent." }
{ "type": "sting", "sound": "klaxon" }        // klaxon | chime | silence
{ "type": "breather", "on": true }            // pauses ALL decay and clocks
```

**Col 4 — Observation pad**
```json
{ "type": "observe", "sector": "POW", "tag": "DOMINANCE",
  "note": "Chief cut off liaison twice during transfer negotiation" }
```
Tags: `DOMINANCE` `WITHDRAWAL` `SAFETY+` `SAFETY-` `DISCREPANCY-SPOTTED`. Writes straight to `runlog.jsonl` — this is how the debrief timeline builds itself. **This is the highest-value feature in the control panel; build it early, not last.**

**Run control**
```json
{ "type": "reset_run", "run_id": "2026-09-14-clientX-c2", "confirm": true }
{ "type": "snapshot" }
{ "type": "export_log" }
```

---

## 5. `runlog.jsonl` — one JSON object per line

```json
{"t":"2026-09-14T10:38:00.112Z","ev":"fault_fired","sector":"POW","fault":"F-201","round":"R2"}
{"t":"2026-09-14T10:41:22.900Z","ev":"submit","sector":"POW","fault":"F-201","code":"P-04-291","accepted":false,"reason":"invalid_code","attempts":2}
{"t":"2026-09-14T10:42:03.117Z","ev":"submit","sector":"POW","fault":"F-201","code":"P-04-340","accepted":true,"workers":2}
{"t":"2026-09-14T10:44:10.004Z","ev":"observe","sector":"POW","tag":"SAFETY-","note":"Engineer flagged 290/340 mismatch, chief dismissed it"}
{"t":"2026-09-14T10:45:00.000Z","ev":"mode","mode":"COUNCIL"}
```

Log every: fault fired/resolved/cleared, every submit (accepted *and* rejected — failed attempts are diagnostic), inventory declarations, mode/round/clock changes, announcements, facilitator overrides, observation tags, connect/disconnect.

**Clock sync:** at R0 the facilitator fires `sting: klaxon`; the audio spike aligns every recording to this log. Log the sting with its timestamp — it is the join key for the entire analytics pipeline.

---

## 6. Build order for Claude Code

1. **Server skeleton** — Express + `ws`, load the three JSON fixtures, in-memory state, 10 s decay tick, snapshot to disk every 10 s, `runlog.jsonl` appender.
2. **`hello`/`state` loop + visibility filter** — get the filtering right here; retrofitting it later means auditing every view.
3. **Sector dashboard** — three columns per spec §6.1. Test against F-201 (two valid codes) and F-210 (empty array) before building anything else.
4. **Control panel** — ugly is fine, complete is not. Runbook column + observation pad first.
5. **Big screen** — the HAVEN-9 cross-section SVG deserves real design time; everything else on it is bars and a ticker.
6. **Council mode + brownout/dark states** — the R3 climax path, end to end.

**Definition of done for MVP:** a full R1→R4 dry run with 6 laptops on the offline router, no restarts, `runlog.jsonl` complete and timestamp-aligned to a klaxon spike.

---

## 7. Deliberate non-features (do not let the build add these)

- ❌ Chat / messaging between sectors — destroys the diagnostic.
- ❌ Auto-deducted resources — pushes arguments onto the screen, off the transcript.
- ❌ Automated cascade rules engine — facilitator fires everything in MVP (`triggered_by` field exists, stays `null`).
- ❌ Accounts, logins, persistence between runs — every run is stateless; `reset_run` is the whole lifecycle.
- ❌ Mobile-responsive layouts — fixed 1366×768 on provided hardware.
- ❌ Reconciling telemetry 290 with binder 340 — that mismatch *is* the psychological safety probe.

---

## 8. Game Control System extension (v2)

Everything above still holds. This section adds the phases, economy, crisis
and measurement layers. **Balance lives in `config/scenarios/*.json`, never in
code** — every number below is a scenario default.

### 8.1 URLs

| Screen | LAN mode | Hosted mode |
|---|---|---|
| Wall (projector) | `/wall` | `/s/<CODE>/wall` |
| Sector laptop | `/sector/POW` … `/sector/COM` | `/j/<JOIN>` → `/s/<CODE>/sector/POW` |
| Admin (game master) | `/admin?token=<FACILITATOR_TOKEN>` (also `/control`) | `/s/<CODE>/control?token=…` |
| Sessions panel | — | `/admin` (accounts) |

`/bigscreen` remains as the original cross-section map view of the same frame.
The Admin page prompts for the token if the URL does not carry one.

### 8.2 Envelope fields (every role)

```json
{
  "phase": "ROUND_2", "phase_name": "Round 2 — Interdependence",
  "round": "R2", "round_name": "Interdependence", "round_length_s": 1800,
  "round_clock":   { "running": true,  "remaining_s": 1140 },
  "council_clock": { "running": false, "remaining_s": 300 },
  "cycle": { "number": 3, "length_s": 420, "remaining_s": 267, "running": false },   // legacy timer; see §8.7
  "paused": false, "breather": false, "frozen": false,
  "core_output": 83, "core_integrity": 83,
  "city_stability": 71, "stability_mode": "auto",   // control frame ONLY — no participant frame carries an aggregate city figure (v15)
  "council": { "active": false, "count": 1, "order_submitted": false, "no_order": false, "started_at": null },
  "continuity_order": { "order": ["POW","MED","WTR","TRN","COM","AGR"], "brownout": ["COM","AGR"], "t": "…" },
  "blackout": { "active": false, "current": [] },
  "alert": { "id": "A-0003", "title": "⚠ CORE INSTABILITY DETECTED", "subtitle": "CORE OUTPUT FALLING", "big": "", "t": "…", "age_s": 3, "full_screen": true },
  "sound_enabled": true,
  "thresholds": { "power": 1, "water": 1, "parts": 1, "med": 0 }
}
```

Phases: `SETUP ORIENTATION ROUND_1 ROUND_2 ROUND_3 DEBRIEF_1 AFTERSHOCK DEBRIEF_2 FINISHED`
(`lib/rounds.json` → `phases[]`, each mapping to a round and a mode).

**Clocks.** A clock's `running` is already false whenever the simulation is
frozen (pause, breather, briefing). Clients count down locally between frames
with `Undercity.countdown(clock, frame.frozen)` and never past zero. The
server ticks every second and broadcasts on change or every `broadcast_ms`.

**Alert.** Full-screen while `full_screen` is true (`alert_full_screen_s`,
default 8 s), then a reduced persistent banner until `dismiss_alert`.

### 8.3 Sector frame additions

Own sector: `brownout`, `dark`, `workforce { active injured loaned borrowed
available total }`, `low { power water parts med }` (below threshold or zero),
`production_next`, `upkeep_delivery` (next round's cost after brownout),
`upkeep_due_in_s` (= round clock remaining, since 2026-09-18), `round_output`,
`upkeep_status`, `upkeep_short` (§8.7). Own faults add `id status deadline_s
deadline_remaining_s integrity_penalty expired opened_at`. Fault `status`:
`ACTIVE RESOLVED EXPIRED FAILED CLEARED`. The dependency half of the flavour
line is still cut; the screen says *consult your binder*, nothing more.

Plus: `transfers[]` (those involving this sector), `announcements[]` (public
plus this sector's), `effects[]` (temporary effects targeting this sector or
ALL), and:

- **TRN only** — `transfer_queue { capacity, used, remaining, basis, requires_chit,
  can_stamp, awaiting_acceptance, items[] }`. `items[]` holds only transfers in
  `PENDING_TRN_APPROVAL`, **oldest first** by `created_at` (2026-09-18); each
  carries `chit_confirmed` and `supplier_ok` — a
  **boolean**, never the supplier's stock count, so Transport learns whether the
  chit can be honoured without learning what another table is holding.
  `awaiting_acceptance` is a count of requests no supplier has answered, and a
  count only. **No other role is sent this key**, which is what stops any other
  screen rendering an APPROVE control.
- **MED only** — `healing_queue { capacity, used, remaining, can_heal, items[] }`,
  each item carrying `sector`, `worker_id`, `worker_label` and `still_injured`.
  **No other role is sent this key.**
- **AGR only** — `agr_cards { round, round_number, used, selected, target,
  offered[], message }`. `offered[]` is the three dealt cards with
  `{ id, title, summary, category, target }` plus `sectors[]`, `choices{}` or
  `ties[]` where a choice is needed. Never the deck. **No other role is sent
  this key.**
- **The wall and COM** — `broadcast { round, round_number,
  rows{ CODE: { power, water, med, parts, round, round_number, freshness } },
  announcement | null, editable }`. Reported by COM, never read from
  inventory; `freshness` is CURRENT / STALE / OUTDATED / NOT UPDATED from
  round distance alone, and no field carries a clock time. `editable` is true
  only in COM's frame.
- **Every other sector** — `broadcast { round, round_number, editable: false,
  announcement_active }` and nothing more (2026-09-17). A table's console is
  local truth; the city's reported board lives on the wall; the screen shows
  only CITY ANNOUNCEMENT UPDATED when one exists, never the words.
- **The wall** — `requests[]` (open) and `transfers[]` (open, plus any closed in
  the last 20 s so an animation can finish), each `{ id, from/to or
  supplier/requester, resource, amount, status, updated_at }`. What is moving
  and between whom, never what anyone holds. Empty when
  `show_completed_transfer_on_wall` is off.
- **Every sector** — `requests[]` and `transfers[]` it is party to, and since
  2026-09-18 `movement { active[], history[], history_total }`: the same
  paperwork as one card per movement, labelled and sorted for that table.
  Each card: `{ kind: request|transfer, id, from, to, resource, amount,
  status, label, direction: INCOMING|OUTGOING, active, action_required,
  can_fulfill, can_withdraw, linked_id, at, updated_at }`. Labels: request
  `REQUESTED` → WAITING FOR SUPPLIER (ACTION REQUIRED when this table is the
  supplier), `TRANSFER_CREATED` → SUPPLIER ACCEPTED (never active — its
  linked transfer is the card), `DECLINED_BY_SUPPLIER` → DECLINED; transfer
  `PENDING_TRN_APPROVAL` → WAITING FOR TRN, `DELIVERED` → DELIVERED,
  `DECLINED_BY_TRN` → TRN DECLINED, `APPROVED` → APPROVED BY TRN;
  `CANCELLED` / `EXPIRED` as themselves. `active[]` is oldest first;
  `history[]` newest first, at most 20 (`history_total` counts them all).
  `can_fulfill` is computed from the table's own stock and nothing else.
  The engine's status names are unchanged. Its own
  `healing[]`, `unclaimed_injured`, and `transfer_rules { require_supplier_acceptance,
  require_physical_transfer_chit, notify_supplier_with_sound,
  enforce_supplier_stock, approver: "TRN", healer: "MED" }`, so a screen can
  gate its own controls without guessing at the scenario.
- **COM only** — `intel { degraded, items[{key,label,value}] }`; values read
  `UNKNOWN` under a brownout (per item `hidden_in_brownout`) or comms blackout.
  `full_telemetry` also drops to false while COM is blind.

Transfer object:
```json
{ "id": "T-0007", "from": "WTR", "to": "POW", "resource": "water", "amount": 2,
  "status": "WAITING_TRN", "requested_at": "…", "agreed_at": null, "waiting_at": "…",
  "stamped_at": null, "delivered_at": null, "cancelled_at": null, "requested_by": "WTR" }
```
Status flow: `REQUESTED → AGREED → WAITING_TRN → STAMPED → DELIVERED`, or
`CANCELLED`. **Only STAMPED moves stock** (when `auto_economy` is on). The
signed chit and TRN's rubber stamp remain the physical truth.

### 8.4 Wall frame

Per sector: `integrity status status_word brownout dark workforce{active
injured available total} unresolved_faults`, plus `top_fault { code name
severity deadline_remaining_s expired }` when `wall_shows_faults`, which
vanishes while COM is DARK and `com_dark_hides_wall_detail` is on
(`telemetry_degraded: true`). `broadcast` is COM's board (`rows{}` with a
`round_number` and a `freshness` word per sector, and the `announcement`);
`requests[]` and `transfers[]` are the open movement (§8.7). `feed[]` is the
ticker filtered to public kinds, newest first, capped at `wall_feed_max`.
`debrief` carries the Round 3 vs Aftershock comparison once the facilitator
turns `wall_debrief` on. Never: real `inventory`, `city_stability` or any
aggregate city figure, an answer key, a procedure, a flavour line.

**Big Screen contract v15 (2026-09-18).** The wall is display-only and prints:
CURRENT ROUND (`round_number`), CORE STABILITY (`core_output`), NEXT ROUND IN
(`round_clock`, the council clock while the Council sits), LIVE; an alert
strip only while something needs the room — the facilitator's `alert`, DARK
sectors, CRITICAL sectors with their health, core ≤ 60, the Council, transfers
`PENDING_TRN_APPROVAL` (one `FROM → TO` route and item, or a count), a
facilitator announcement under 120 s old; six sector cards (HEALTH %, the
server's status word, COM's reported row in POWER · WATER · MEDICAL · PARTS
order or NO REPORT, `UPDATED ROUND n · CURRENT|STALE|OUTDATED` or NOT UPDATED);
and the CITY BROADCAST area (`broadcast.announcement`, else NO ACTIVE CITY
BROADCAST). The rules are in `public/shared/bigscreen.js` and are tested.

### 8.5 Control frame

Everything, plus `transfers[]`, `transfer_capacity`, `timeline[]`
(`{id offset_s kind fault_code sector event_id text value mode:AUTO|MANUAL
status:PENDING|READY|FIRED|SKIPPED}`), `round_elapsed_s`, `scheduled[]`,
`effects[]`, `intel[]`, `cycle_summary`, `council_detail`,
`continuity_order_detail`, `blackout_detail`, `phases[]`, `config` (the live
scenario defaults) and `scenario { id name sectors events fault_presets }`.

### 8.6 Sector → server (new)

```json
{ "type": "fault_open", "fault_code": "F-201" }
{ "type": "transfer_request", "from": "POW", "to": "MED", "resource": "power", "amount": 2 }  // ASK — any sector
{ "type": "transfer_create",  "to": "MED", "resource": "power", "amount": 2 }   // OFFER our own stock — any sector
{ "type": "request_fulfill",  "id": "R-0007" }   // SUPPLIER only — raises a transfer; NOT approval
{ "type": "request_decline",  "id": "R-0007" }   // SUPPLIER only
{ "type": "request_cancel",   "id": "R-0007" }   // either party, while still REQUESTED
{ "type": "transfer_chit",    "id": "T-0008", "confirmed": true }   // TRN only — the signed paper is in hand
{ "type": "transfer_approve", "id": "T-0008" }   // TRN ONLY — the only step that moves stock
{ "type": "transfer_decline", "id": "T-0008" }   // TRN only
{ "type": "heal_request" }                       // any sector, for ITS OWN injured worker; target is always MED
{ "type": "heal_worker",  "id": "H-0009" }       // MED ONLY
{ "type": "heal_decline", "id": "H-0009" }       // MED only
{ "type": "heal_cancel",  "id": "H-0009" }       // the asking sector
{ "type": "com_board_set", "row": "POW", "values": { "power": 5, "water": 1, "med": 0, "parts": 2 } }  // COM ONLY — row, not sector
{ "type": "com_announce", "headline": "MED NEEDS POWER", "message": "…" }   // COM only; 40 / 160 chars
{ "type": "com_announce_clear" }                                             // COM only
{ "type": "agr_select",   "card": "AGR_STABILISE_SECTOR" }                   // AGR only — inspect, spends nothing
{ "type": "agr_activate", "card": "AGR_STABILISE_SECTOR", "target": { "sector": "POW" } }   // AGR ONLY
```

**COM writes the big screen; nobody else does.** `com_board_set` from any
other sector is refused with `com_edit_forbidden`. It changes displayed
values only — never a sector's inventory — and stamps the row with the
current round. **AGR plays one card a round.** `agr_activate` from another
sector is refused with `agr_only`; a card outside the dealt hand with
`agr_card_not_in_offer`; a second card with `agr_card_already_used`; a
missing or bad target with `agr_target_required` / `agr_invalid_target`.
A refusal never spends the round's choice. `target` is
`{ sector }` for sector cards and tied CRISIS RESPONSE, `{ resource }` for
RESERVE CACHE.

Nothing here carries a **free-text field**: the terms are agreed out loud, by
Liaisons, on paper. A **request** moves nothing and approves nothing; only the
supplier may answer it, and `request_fulfill` from anyone else is refused with
`not_supplier`. Fulfilling raises a transfer in `PENDING_TRN_APPROVAL`.

**Only TRN approves and only MED heals**, enforced in the router *and* the
reducer. `transfer_approve` from another sector is refused with
`approval_trn_only`, `heal_worker` with `heal_med_only`. An approval is
refused, in order, with `approval_trn_only`, `capacity { capacity, used,
basis }`, `chit_required` or `insufficient_stock_stamp { have, need }`; a heal
with `heal_med_only`, `med_capacity { capacity, used }` or
`worker_not_injured`. **A refusal spends no allowance and moves nothing.**
`heal_request` takes no target: the reducer uses the asking sector and always
writes MED.
Replies: `transfer_result { ok, reason?, transfer? }`. `submit_result` now
also carries `recovery` and `consumed` on success, `max_consecutive` on an
invalid code, and `insufficient_resources { short }` when the scenario
requires stock.

### 8.7 Control → server (new)

```json
{ "type": "set_phase", "phase": "ROUND_2" }   { "type": "next_phase" }
{ "type": "clock", "which": "round", "action": "start|pause|resume|end|add|set", "seconds": 120 }
{ "type": "cycle", "action": "start|pause|process|set|add", "seconds": 60 }
{ "type": "pause" }  { "type": "resume" }
{ "type": "fire_preset", "preset_id": "r2_wave_a" }
{ "type": "fault_add_time", "sector": "POW", "fault_code": "F-201", "seconds": 60 }
{ "type": "adjust_integrity", "sector": "POW", "delta": -10 }
{ "type": "injure_worker", "sector": "POW", "count": 1 }   { "type": "recover_worker", "sector": "POW", "count": 1 }
{ "type": "set_core_output", "value": 60 }   { "type": "adjust_core", "delta": -10 }
{ "type": "set_stability", "mode": "manual", "value": 55 }
{ "type": "set_intel", "key": "water_pressure", "value": "DEGRADING" }
{ "type": "set_config", "patch": { "cycle_length_s": 300, "brownout_effects": { "production_multiplier": 0.4 } } }
{ "type": "set_sector_config", "sector": "AGR", "patch": { "production": { "water": 1 } } }
{ "type": "set_sound", "on": false }
{ "type": "alert", "title": "COUNCIL SUMMONED", "subtitle": "CHIEFS + LIAISONS REPORT IMMEDIATELY" }
{ "type": "dismiss_alert" }
{ "type": "call_council" }   { "type": "end_council" }
{ "type": "continuity_order", "order": ["POW","MED","WTR","TRN","COM","AGR"], "confirm": true }
{ "type": "rolling_blackout", "confirm": true }   { "type": "end_blackout" }
{ "type": "fire_event", "event_id": "tunnel_collapse", "target": "TRN" }
{ "type": "cancel_scheduled", "id": "S-0004" }
{ "type": "timeline_fire", "id": "R2-01" }  { "type": "timeline_skip", "id": "R2-01" }  { "type": "timeline_delay", "id": "R2-01", "seconds": 120 }
{ "type": "transfer_request", "from": "WTR", "to": "POW", "resource": "water", "amount": 2 }
{ "type": "transfer_create", "from": "WTR", "to": "POW", "resource": "water", "amount": 2 }
{ "type": "request_fulfill", "id": "R-0007" }   { "type": "request_decline", "id": "R-0007" }
{ "type": "transfer_chit", "id": "T-0008", "confirmed": true }
{ "type": "transfer_approve", "id": "T-0008", "force": true }   // lifts allowance and chit — never stock
{ "type": "transfer_decline", "id": "T-0008" }
{ "type": "heal_request", "sector": "AGR" }
{ "type": "heal_worker", "id": "H-0009", "force": true }   // logged as facilitator_force_heal
{ "type": "heal_decline", "id": "H-0009" }
{ "type": "reset_stamps", "which": "all" }   { "type": "reset_heals" }   { "type": "expire_transfers" }
{ "type": "com_board_set", "sector": "POW", "values": { "power": 5 } }   // logged as facilitator_com_override
{ "type": "com_announce", "headline": "…", "message": "…" }   { "type": "com_announce_clear" }
{ "type": "agr_reroll" }                                        // logged as agr_admin_reroll
{ "type": "agr_activate", "card": "AGR_POWER_SURGE", "target": null, "force": true }   // agr_admin_force_activate
{ "type": "agr_card_enabled", "card": "AGR_RELIEF_CREW", "enabled": false }
{ "type": "wall_debrief", "on": true }
{ "type": "reset_run", "run_id": "…", "scenario_id": "haven9-hard", "confirm": true }
```

`set_mode: "COUNCIL"` still works and is equivalent to `call_council`.
Replies: `fire_result`, `event_result`, `order_result`, `timeline_result`,
`transfer_result`, `cycle_summary`.

### 8.8 HTTP (control token)

| Route | Purpose |
|---|---|
| `GET /api/content?session&token` | faults, specs, sectors, rounds, scenarios, public URLs |
| `GET /api/debrief?session&token` | `lib/analytics` output: per-round stats, `comparison` (R3 vs R4), timeline |
| `GET /api/scenarios?…` · `GET /api/scenarios/:id` | list / raw document |
| `POST /api/scenarios` `{ name, id?, from_live: true }` | SAVE AS SCENARIO from the running configuration |
| `DELETE /api/scenarios/:id` | remove a saved copy (built-ins cannot be deleted) |

### 8.9 Sounds

The server queues stings on game events (`fault_alert critical resolved
council warning_30 brownout dark core_warning alert cycle chime`) and sends
`{ "type": "sting", "sound": "…" }` to the wall and sector screens when
`sound_enabled` is on. The client plays `/audio/<sound>.mp3` if that file
exists, else a synthesised placeholder.

### 8.10 Log additions

`phase`, `pause`, `fault_opened`, `deadline_expired {penalty}`, `fault_failed`,
`cycle_processed {summary}`, `upkeep_missed`, `worker_recovered`,
`request_created/fulfilled/declined/cancelled/expired`, `request_fulfil_refused`,
`transfer_created/chit/approved/declined/cancelled/expired/refused`,
`heal_requested/declined/refused/cancelled/expired`, `worker_healed`,
`trn_approval_counter_reset`, `med_healing_counter_reset`,
`facilitator_force_transfer`, `facilitator_force_heal`,
`com_row_updated`, `com_announcement_published/cleared`, `facilitator_com_override`,
`agr_random_offer_generated`, `agr_card_selected/activated/activation_refused`,
`agr_round_offer_archived`, `agr_admin_reroll`, `agr_admin_force_activate`, `agr_card_enabled`,
`council_called/ended/no_order`, `continuity_order`, `blackout_started/rotated/ended`,
`event_fired`, `effect_started/ended`, `scheduled`, `preset_fired`,
`timeline_fired/skipped/delayed`, `alert`, `config_patched`, `set_stability`,
`intel`, `sound`. Every line also carries `round` and `phase`.

### 8.7 One clock: the round's (2026-09-18)

The free-running core cycle is retired. `round_clock` is the only clock a
table sees, and **upkeep falls due when a played round ends**: the
facilitator advancing the phase runs one economy pass for the outgoing round
(`cycle_processed {cycle, round, summary}`; a round whose clock never
started is not charged). The `cycle` object stays in every frame for
compatibility — `number` now counts upkeep passes, and `running` is false
unless a scenario turns the legacy timer back on with `cycle_autostart`.
Admin's PROCESS UPKEEP NOW (`cycle {action:"process"}`) still forces a pass.

Own sector adds `round_output` — `null` for a sector with no production
line, else `{ manual, used, base, amount, added, reduced, core_output,
available }` — and `upkeep_status` (`READY` | `SHORTFALL`) with
`upkeep_short {resource: n}`, both from the sector's real stock and never
from COM's board. The common frame adds `round_number`.

```json
{ "type": "generate_output" }    // POW / WTR only — their own output, once a round, into the real tray
```

Reply `output_result { ok, sector, round, added, moved }`; refusals
`already_generated`, `no_output` (no production line), `no_output_now` (a
supply delay, or core at 0), `sector_dark`, `frozen`, `not_your_sector`,
`output_automatic` (scenario switch `round_output_manual: false`). A second
press in the same round adds nothing; a refresh, a reconnect or a restart
keeps the stamp. Brownout halves it and core output scales POW's, exactly as
they shaped the old automatic production. COM's board never moves. The
facilitator may run it for a table with `generate_output {sector}`.

Sector screens no longer render the City Feed (COM alone keeps it — its
sensors are its product) or an Announcements panel; a facilitator notice
addressed to one table shows as a banner there, and city-wide announcements
are read on the wall.
