# UNDERCITY — Crisis Leadership Simulation
## Master Build Specification v1.0 (MVP)

**Owner:** Eugene Phuah (Thriving Talents) · **Target:** Runnable MVP in 4 weeks · **Status:** Draft for build

---

## 1. Problem Statement & Purpose

Corporate teams cannot see their own behaviour under pressure — domination, passivity, withheld information, and psychological-safety-killing dialogue only surface in real crises, when the cost is already paid. UNDERCITY is a hybrid physical-digital simulation that manufactures a controlled stress gradient, records all team dialogue, and produces individual behavioural diagnostics (talk time, interruptions, agreements/disagreements, safety-building vs safety-eroding moves) that feed a debrief-and-recommitment cycle within the same day.

**The product is the measurement-and-debrief methodology. The simulation is the stimulus.** Every design decision below serves one test: *does this force diagnostically useful speech onto the transcript?*

### Companion files (build inputs)

| File | Role |
|---|---|
| `undercity-crossref-matrix.xlsx` | **Single source of truth.** All faults, spec values, cross-references, binder print manifest, validation checks. Every content change starts here. |
| `export_faults.py` | Reads the matrix, validates, emits `content/faults.json`, `specs.json`, `sectors.json`. Aborts on failed validation or unrecalculated formulas. |
| `undercity-message-contract.md` | Authoritative websocket schema and build order for the webapp. |

**Pipeline discipline:** edit matrix → recalc → re-run exporter → regenerate binder PDFs. Never hand-edit the JSON or a printed binder value. A hand-fix desynchronises paper from server and makes a fault unsolvable mid-session — the one failure the facilitator cannot recover from live.

### Locked design decisions (from design sessions)
1. Hybrid format: physical sector tables + paper artifacts + digital dashboards + big screen.
2. Facilitator-driven engine (Wizard-of-Oz): no automated cascade AI in MVP. A game master fires all events from a control panel.
3. Four rounds, not three: R1 baseline → R2 interdependence → R3 triage climax → **debrief → R4 re-entry** with second measurement pass (pre/post delta is the flagship output).
4. No participant exile mechanics. Sacrifice decisions target fictional populations; personnel pressure via workforce reallocation only.
5. Individual analytics go to the participant only; client organisation receives aggregate team patterns. PDPA consent form signed before play.
6. Audio: one mic per sector table, post-hoc transcription; only headline metrics computed same-day for R4.
7. Tech stack: Node server, vanilla JS, websockets, single-page views (reuse ATC architecture).

### Goals
- G1: A 6-sector cohort of 18–36 participants completes a full 4-round day with zero facilitator-blocking technical failures.
- G2: ≥ 90% of scripted injects produce audible cross-sector dialogue (verified against transcripts in pilot).
- G3: Same-day R4 delta report (talk time, interruptions, questions asked) delivered within 30 minutes of R4 ending.
- G4: A trained associate trainer (not the design team) can reset and rerun the full kit in ≤ 15 minutes between cohorts.
- G5: Total MVP build ≤ 4 weeks of part-time vibe-coding + one weekend of document writing.

### Non-Goals (v1)
- ❌ Automated failure-cascade engine (facilitator fires everything manually — pedagogically superior and 10× cheaper).
- ❌ Real-time transcription/diarization pipeline (highest technical risk; post-hoc for MVP).
- ❌ Automated behavioural coding (semi-manual with Claude against Rackham/Edmondson/Pentland framework for MVP).
- ❌ Participant accounts, login, persistence across events (each run is stateless; facilitator resets).
- ❌ Mobile-responsive layouts (dashboards run on provided laptops/tablets at fixed resolution).
- ❌ BM/Mandarin UI localisation (English UI for pilot; spoken language is free — the analytics layer handles code-switching, not the game).

---

## 2. World & Narrative Frame

**Premise (60-second briefing script):** *"The surface has been uninhabitable for 40 years. Your city — HAVEN-9 — survives 300 metres underground, kept alive by six interdependent sector systems and a geothermal Core. This morning, Core output began degrading. You are the sector leadership councils. The city does not know yet. You have one shift to keep HAVEN-9 alive."*

Tone: grounded techno-realism (think *The Martian*, not zombies). No combat, no horror imagery — the threat is systems failure and scarcity. This keeps it culturally neutral, age-appropriate, and focused on operations rather than fantasy.

### 2.1 The six sectors

| # | Sector | Code | Produces | Critical dependency | Diagnostic role in the design |
|---|--------|------|----------|--------------------|-------------------------------|
| 1 | Power Grid | POW | Power Cells | Water (turbine cooling) | Everyone needs them → natural power broker; watch for domination |
| 2 | Water & Filtration | WTR | Water Units | Power (pumps) | Mutual hostage relationship with POW → negotiation engine |
| 3 | Medical Bay | MED | Restores injured Workforce | Power, Water, Parts | Moral weight; strongest claim in triage round |
| 4 | Transport & Tunnels | TRN | Transfer capacity (moves everything) | Power, Workforce | Controls the *speed* of all trades → passive-aggressive choke point |
| 5 | Agriculture (Hydroponics) | AGR | Food (sustains Workforce efficiency) | Water, Power | Slow-burn consequences; tests long-vs-short-term prioritisation |
| 6 | Communications & Sensors | COM | Telemetry (sees others' hidden data) | Power | **Asymmetric information engine** — COM sees faults before the affected sector does |

Cohort sizing: 3–6 participants per sector. 18 = minimum viable cohort; 36 = maximum (6 per table). Below 18, run 4 sectors (cut TRN and AGR; fold transport delay into facilitator manual control).

### 2.2 Resources (keep to five — cognitive load budget)

| Resource | Physical form | Produced by | Notes |
|----------|--------------|-------------|-------|
| Power Cells ⚡ | Yellow chit | POW | Universal currency of the game |
| Water Units 💧 | Blue chit | WTR | Second universal currency |
| Spare Parts 🔧 | Grey chit | None — fixed scarce stock | Zero-sum: the scarcity driver. Total city stock is deliberately ~70% of total R2–R3 demand |
| Med Supplies ⚕ | Red chit | MED (limited) | Needed to restore injured Workforce |
| Workforce 👤 | Wooden meeple/token | — | 8 per sector at start. Faults injure workforce; injured tokens go to MED. Fewer workers = slower fault resolution (see 3.4) |

### 2.3 Interdependency rules (the whole game in four sentences)
1. Every sector pays a per-round **upkeep** in Power Cells and Water Units (printed on their dashboard and binder).
2. **Faults** (fired by facilitator) damage sector Integrity over time until resolved; resolution requires a binder procedure + resources + often a spec value from *another sector's* binder.
3. All resource transfers move physically as chits, logged on a Transfer Chit, and take effect only when TRN stamps the chit (transport capacity = TRN's power).
4. City survives if **Core Integrity** (a facilitator-controlled aggregate on the big screen) stays above 0 at the end of R3/R4.

---

## 3. Game Systems

### 3.1 Sector Integrity
- Each sector has Integrity 0–100, shown as a health bar on its dashboard and the big screen.
- Unresolved faults tick Integrity down at a rate set per-fault (facilitator can override live).
- At Integrity < 30 the sector enters **CRITICAL** (red strobe border on big screen + klaxon sting — public shame mechanic).
- At 0, the sector goes **DARK**: dashboard locks except comms; its people become refugees (workforce tokens physically walked to other tables — a designed emotional beat).

### 3.2 Fault lifecycle (core loop)
1. Facilitator fires inject from control panel → affected sector's dashboard shows alert + fault code (e.g., `F-201`) → facilitator hands the matching **Fault Card** to the table.
2. Team looks up F-201 in their **Binder fault index** → points to a Procedure page (`P-04`).
3. Procedure specifies: (a) resources to spend, (b) a **spec value that lives in another sector's binder** (~60% of R2+ faults), (c) the composite **resolution code** format.
4. Team acquires resources/specs (talking, trading, walking — this is the point), enters resolution code on dashboard.
5. Server validates → Integrity damage stops, small recovery applied → resolved fault appears on big screen ticker with sector credit.
- Wrong code: dashboard shows "REJECTED — verify procedure" and logs the attempt (failed-attempt count is itself debrief data: who bulldozed a guess vs who verified?).

### 3.3 Resolution code scheme (build-simple, cheat-resistant)
`[Procedure]-[SpecValue]`, `[Procedure]-[Spec1]-[Spec2]` for R3/R4 two-spec faults, or `[Procedure]-[Spec1]-[Spec2]-[Spec3]` for the twelve three-value faults (every sector's P-08 and P-09 since 2026-10-06: `spec/reference_chain_faults.json` and `spec/late_shift_faults.json` name the rows, the generators resolve the values, and VALUE 3 is the sector's own table, its own Appendix C or a third sector's row). Example: F-201 resolves as `P-03-340`, where 340 is the Lower Reservoir pressure rating in WTR Manual Table W-4.
- Server holds a lookup table (`content/faults.json`, generated from the crossref matrix) of fault → **array** of valid codes. No parsing logic needed.
- One structural edge case lives in the built content: F-201 has **two** valid codes (the discrepancy seed). The array may also be **empty** for a false alarm; the deck has carried none since 2026-09-27, and any code path assuming exactly one code is still wrong.
- Spec values are 3-digit numbers unique per table cell, so overheard numbers are useless without knowing which table they came from.

### 3.4 Workforce mechanic
- Entering a resolution code requires the dashboard's "workers assigned" field ≥ the fault's crew requirement. Teams with injured workforce must borrow workers (physical meeple handover + Transfer Chit) or queue faults.
- Selected faults injure 1–2 workforce (facilitator judgement): tokens go to MED's table and return after MED spends Med Supplies + 1 round.

### 3.5 The Council Meeting
- Facilitator-triggered: big screen switches to COUNCIL MODE — 5:00 hard countdown, all liaisons + sector chiefs to the centre table, one dedicated centre-table mic.
- Used once in R2 (information pooling under time pressure) and once in R3 (the triage vote).
- **This is the analytics centrepiece**: compressed, whole-group, high-stakes dialogue.

### 3.6 R3 Triage mechanic (replaces exile)
- Core output drops to 60%: city can fully sustain only 4 of 6 sectors. Council must submit a **Continuity Order** — a physical form ranking sectors 1–6 — before the countdown ends.
- Bottom two sectors go to **brownout** (halved upkeep delivery, Integrity decays slowly): populations at risk are printed on the form (e.g., "MED brownout: 3,000 patients on life support"). No right answer by design.
- If no form is submitted before zero: facilitator declares random rolling blackouts (worst outcome) — indecision is punished more than any decision.
- Brownout sectors' participants stay fully in play, redeployed as aid crews — no human is ever benched.

### 3.7 The seeded discrepancy (psychological safety probe)
- WTR Binder Table W-4 prints reservoir pressure as **340**; the big screen telemetry panel shows WTR reservoir pressure **290** from R2 onward. Both values resolve faults (server accepts either) — the *game* doesn't punish; the *transcript* reveals who noticed, who spoke, and how the group responded to the dissenter.
- Nobody is briefed. Facilitator watches for the catch; debrief protocol has a dedicated section for it whether or not anyone spoke up.

### 3.8 Stress instrumentation (facilitator's throttle)
Pressure dials the game master can turn independently, listed on the control panel:
- Inject frequency and stacking (parallel faults)
- Countdown timers on faults (optional per-inject)
- Public callouts on the big screen ticker ("POW has 2 unresolved faults")
- Klaxon/audio stings (sparingly — contrast is what registers as stress)
- Resource droughts (skip an upkeep delivery)
- The 5-minute breathers between rounds are part of the instrument: stress needs contrast.

---
## 4. Physical Artifact Specifications

**Production rules (non-negotiable):** every artifact reprintable from a master PDF on A4, no bespoke props; every artifact carries its sector code and round tag in the footer; total kit resettable in ≤ 15 minutes using the Reset Checklist (§4.7).

### 4.1 Sector Technical Operations Binder — one per sector (6 total)

Format: A4, 10–12 pages, in a coloured 2-ring binder matching sector colour. Master PDF per sector.

| Page(s) | Section | Content spec | Design intent |
|---------|---------|--------------|---------------|
| Cover | Identity | Sector name, code, crest, "RESTRICTED — [SECTOR] PERSONNEL" | Ownership feeling → hoarding becomes a *choice* |
| 1 | Sector Overview | 150-word mission, upkeep costs, starting inventory, org chart with role cards refs | Onboarding in R0 |
| 2 | System Schematic | One-page diagram of the sector's plant (drawn once in Claude/SVG, reused) | Shared reference for pointing/explaining |
| 3–4 | Fault Code Index | Table: fault code → fault name → procedure ref. **Includes 4–6 codes belonging to OTHER sectors' faults** marked "escalate to [SECTOR]" | Forces "whose fault is this?" dialogue |
| 5–8 | Repair Procedures (P-01…P-12) | Each: resources required, crew required, spec-value source ("obtain X from [OTHER SECTOR] Manual, Table Y"), resolution code format | The core loop. ~40% self-contained (R1), ~60% cross-sector (R2+) |
| 9 | Spec Tables | 2–3 tables of 3-digit values that OTHER sectors need from this binder | Makes every binder a demanded asset |
| 10 | Appendix C (deliberately buried) | One R3-relevant spec placed here with no index entry; index says "see appendix" only | Frustration-tolerance probe (the "slightly messy" calibration — one buried item, no more) |
| 11 | Ops Log Sheet | Blank table: time / event / decision / who agreed | Teams self-document; debrief gold; also occupies the compulsive note-taker |
| 12 | Transfer rules quick-ref | How chits work, TRN stamping, council protocol | Reduces rules questions to facilitator |

Cross-reference topology: design as a ring — POW needs WTR specs, WTR needs MED, MED needs TRN, TRN needs AGR, AGR needs COM, COM needs POW — plus two diagonal pairs in R3 so the triage round forces non-adjacent sectors to talk. Map every cross-reference in a single spreadsheet (`crossref-matrix.xlsx`) before writing any procedure page; this matrix is also the facilitator's answer key.

Discrepancy seed: WTR binder Table W-4 row 3 = **340** (vs big screen 290). Flag in the answer key only.

### 4.2 Fault Cards — deck of 30 (+6 tutorial)

A6 cards, sector-coloured border, printed 4-per-A4 and cut. Each card:
- Front: fault code (large), fault name, flavour line (1 sentence), severity icon (▲ minor / ▲▲ major / ▲▲▲ critical), "LOOK UP IN YOUR FAULT INDEX."
- Back: blank (no answers on cards — answers live in binders).
- Deck composition (as built, see matrix; evened out 2026-09-27): 6 R0 tutorial cards (one per sector), 6 R1 (self-contained, minor, one per sector), 12 R2 (cross-sector ring, two per sector), 6 R3 (critical, two-spec, one per sector), 6 R4 (novel combinations raiding other binders' buried appendices — tests transfer, not memory; one per sector). Total 36, six per sector, no false alarm.
- Facilitator's copy of each card lists the valid resolution code + spec source (printed as a separate answer-key sheet, never enters the room).

### 4.3 Transfer Chits — pad of 100

A6 carbonless duplicate pad (or two-part printed slips). Fields: FROM sector / TO sector / resource + qty / workforce count / negotiated consideration ("in exchange for…") / signatures (both liaisons) / TRN stamp box / time.
- Rule: a transfer is valid only when the chit is signed by both parties AND stamped by TRN. TRN gets a physical rubber stamp (₽15 from a stationery shop — the single best prop-per-ringgit in the kit).
- Duplicate copy stays with the sending sector → complete paper trail reconstructable against transcript timestamps in debrief.

### 4.4 City Charter — one per cohort

A4, 2 pages, "official" typography, handed to COM at R0 (COM holding the governance document is itself an information-asymmetry seed).
- Page 1: HAVEN-9 governance — council composition, how decisions bind, quorum.
- Page 2, Clause 7 (the deliberate ambiguity): *"In the event of Core insufficiency, continuity of essential services shall take precedence, as determined by the Council."* — "essential" is never defined. This single sentence generates the R3 values debate.
- Continuity Order form (the R3 ranking ballot) printed on the back page with population-at-risk figures per sector.

### 4.5 Role cards — 1 per participant

Business-card size. Roles per sector: **Sector Chief** (accountable voice), **Liaison** (only member permitted to leave the table), **Systems Lead** (owns the binder), remaining participants **Engineers**. Roles are self-assigned in R0 in 2 minutes — *how* they self-assign is the first data point of the day; facilitator notes it.

### 4.6 Consent & privacy pack
- PDPA consent form (signed before R0): recording purpose, individual-report-to-participant-only policy, aggregate-to-organisation policy, retention period, withdrawal mechanism.
- Table tent per sector: "🎙 This table is being recorded for your personal development report."

### 4.7 Kit logistics (associate-trainer-proofing)
- **Packing list** (laminated, in kit lid): 6 binders, fault deck, chit pads ×2, stamp, charter, role cards, consent forms, chit trays ×6, meeples ×48+spares, 6 table mics + recorder, spare batteries.
- **Reset Checklist**: re-sort fault deck by round tab; refill chit trays to starting inventory (printed per-sector start table); return meeples 8/8/8/8/8/8; fresh log sheets into binders (page 11 is the only consumable binder page — keep it loose-leaf); wipe dashboard state via facilitator panel "RESET RUN" button.
- **Facilitator Artifact Map**: one A3 sheet showing which artifact goes to which table at which inject — mirrors the control panel runbook column 1:1 (§6.4), so paper and screen never desynchronise.

---
## 5. Digital System — Architecture & Data Model

### 5.1 Architecture (reuse ATC stack)
- **Server:** single Node.js process, Express + `ws` websockets. Authoritative game state in memory; snapshot to a JSON file every 10s (crash recovery = reload snapshot).
- **Clients:** three static single-page views served from the same process, no framework, no build step:
  - `/sector/:code` → Sector Dashboard (6 instances on laptops/tablets)
  - `/bigscreen` → projection view
  - `/control` → Facilitator Control Panel (facilitator laptop; URL includes a token query param — good enough for a closed-room LAN)
- **Network:** dedicated travel router (offline LAN — no venue-WiFi dependency, no internet requirement during play). This is a hard operational requirement: hotel WiFi is the #1 failure mode for this class of product.
- **Sync model:** server broadcasts full game state (~2–5 KB JSON) on every change; clients re-render from state. No diffing, no optimistic UI. At this scale (8 clients, human-speed events) simplicity beats elegance.
- **Event log:** every state change appended to `runlog.jsonl` with timestamp — this file is later joined with audio timestamps for debrief reconstruction ("the interruption spike at 10:42 was 90 seconds after F-201 fired").

### 5.2 Game state (single JSON object)

> **Authority note:** the shape below is illustrative. `undercity-message-contract.md` §2 is the authoritative state schema for the build — it adds fields this sketch omits (`upkeep_due_in_s`, `locked_until_s`, `telemetry`, per-role visibility filtering). Where the two differ, the contract wins.
```json
{
  "run_id": "2026-09-14-clientX-c1",
  "round": 2,
  "round_clock": { "running": true, "remaining_s": 1140 },
  "core_integrity": 74,
  "mode": "PLAY",                 // PLAY | COUNCIL | BRIEFING | PAUSED | DEBRIEF
  "council_clock": { "running": false, "remaining_s": 180 },
  "sectors": {
    "POW": {
      "integrity": 61,
      "status": "ACTIVE",          // ACTIVE | CRITICAL | BROWNOUT | DARK
      "workforce": { "active": 6, "injured": 2 },
      "inventory": { "power": 4, "water": 1, "parts": 2, "med": 0 },
      "faults": [
        { "code": "F-201", "name": "Coolant loop failure", "severity": 2,
          "decay_per_min": 1.5, "crew_req": 2, "fired_at": "...",
          "deadline_s": null, "attempts": 3, "resolved": false }
      ]
    }
    // … WTR, MED, TRN, AGR, COM
  },
  "ticker": [ { "t": "...", "text": "WTR resolved F-105", "kind": "resolve" } ],
  "announcements": [ { "t": "...", "text": "Core output dropping. Council convenes in 10 min." } ]
}
```
- Fault definitions (codes, valid resolution codes, decay rates, crew req, artifact refs) live in a static `faults.json` — the digital twin of the answer key. One file to edit when playtesting rebalances.
- Integrity decay is computed server-side on a 10s tick from active faults; facilitator overrides write directly to state.

### 5.3 Build estimate sanity check
Server + state + tick loop: ~2 days. Three views: ~2 days each. Styling/polish: 2 days. Playtest fixes: 3 days. **≈ 3 weeks part-time** — fits the month with the document-writing weekend, provided §9's P0 line is held.

---

## 6. Screen Specifications

### 6.1 Sector Dashboard (`/sector/:code`) — laptop/tablet per table

Fixed 1366×768 min. Sector colour theming from URL param. Layout, 3 columns:

**Left — MY SECTOR (always full fidelity)**
- Integrity bar (large, colour-shifts green→amber→red; pulses in CRITICAL)
- Workforce: active / injured counts with icons
- Inventory: 4 resource counters (display only — physical chits are the source of truth; a designated Engineer keeps this synced, and *that reconciliation chatter is deliberate*: it forces the team to verbalise their stock)
- Upkeep due panel: "Next upkeep: 2⚡ 1💧 in 04:12"

**Centre — ACTIVE FAULTS**
- Fault cards as list: code, name, severity pips, decay indicator, optional deadline countdown, attempts counter
- Resolution entry: `[ code input ] [ workers assigned ▾ ] [ SUBMIT ]`
  - Accepted → green flash, fault greys out, ticker credit
  - Rejected → red shake, "REJECTED — verify procedure", attempts++
- Guardrail: 20-second lockout after 3 consecutive rejects (anti-brute-force; also surfaces "slow down" dialogue)

**Right — CITY FEED (deliberately degraded)**
- Other sectors: name + integrity bar only, **updated on a 60-second delay**, no fault detail (COM's dashboard is the exception: COM sees all sectors' fault codes in real time — their asymmetric-information role)
- Announcements feed (facilitator broadcasts)
- Council indicator: when mode=COUNCIL, right column becomes a full-height 5:00 countdown with "SEND LIAISON + CHIEF TO COUNCIL TABLE"

Explicitly excluded from this screen: any chat/messaging feature. **All inter-sector communication is voice or feet.** A chat box would route your diagnostic data into silent text.

### 6.2 Big Screen (`/bigscreen`) — projector

Dark theme, readable at 10 m. Design language: brutalist industrial (amber/green on near-black — reuse The Huddle deck aesthetic).

- **Centre:** HAVEN-9 cross-section map (one static SVG of the underground city; sectors as zones). Zone fill = integrity colour; CRITICAL zones strobe; DARK zones go black with a "SECTOR DARK" stencil. This map is the emotional centrepiece — spend real design effort on this single SVG.
- **Top bar:** CORE INTEGRITY dial (large) + round label + round countdown.
- **Right rail:** six sector integrity bars with workforce icons.
- **Bottom ticker:** scrolling event feed (faults fired, faults resolved with sector credit, transfers stamped, facilitator announcements). The ticker is the public-shame/public-credit instrument — it should name sectors, never individuals.
- **COUNCIL MODE takeover:** map dims, giant 5:00 countdown + agenda line ("CONTINUITY ORDER DUE") centred.
- **R4 close:** big screen shows the cohort's aggregate deltas (interruptions ↓, questions ↑, talk-time balance) as the final image of the day — the product shot.
- Telemetry panel (small, lower-left): rotating "sensor readings" including WTR reservoir pressure **290** (the seeded discrepancy's public half).

### 6.3 Facilitator Control Panel (`/control`) — the real product

One dense screen, four columns. Everything reachable in ≤ 2 clicks; no confirmations except DARK and RESET.

**Col 1 — RUNBOOK (the script):** ordered list of scripted beats per round, each row = time offset + inject button + artifact instruction ("hand F-201 card to POW") + expected behaviour note. Firing a row marks it done and stamps the log. This column ports the Facilitator Artifact Map 1:1 → paper and screen cannot desynchronise. Off-script section below: full inject library, filterable by sector/severity, fire-at-will.

**Col 2 — CITY STATE (god view):** per-sector: integrity slider (drag to override), status dropdown (ACTIVE/CRITICAL/BROWNOUT/DARK), workforce +/-, inventory +/- (for grants/droughts), active fault list with per-fault kill/pause/accelerate. Core Integrity master slider.

**Col 3 — TEMPO:** round selector + clocks (start/pause/add 2:00), council mode toggle, announcement composer with 6 preset buttons ("Core output dropping…", "Upkeep suspended this cycle", etc.), audio stings (klaxon / chime / silence-all), breather toggle (pauses all decay + clocks).

**Col 4 — OBSERVATION PAD:** timestamped free-text notes (one keystroke shortcut per sector to tag), quick-tag buttons for the behaviours the debrief needs: `DOMINANCE` `WITHDRAWAL` `SAFETY+` `SAFETY-` `DISCREPANCY-SPOTTED`. Notes land in `runlog.jsonl` alongside game events → the debrief timeline builds itself.

Header: run ID, mode, RESET RUN (double-confirm), snapshot-now, export log.

**Design principle for this screen:** the facilitator's eyes should be on the room ≥ 80% of the time. Anything that demands sustained screen attention is a defect.

---

## 7. Audio & Analytics Pipeline (MVP scope)

- **Capture:** 1 USB boundary/conference mic per sector table + centre council-table mic → cheap multichannel recorder or one laptop per 2 mics recording WAV. Phone backup recorder per table (belt and braces — a lost table of audio is a lost participant report). File naming: `runid_SECTOR_round.wav`.
- **Clock sync:** at R0, facilitator triggers a klaxon; the spike aligns all recordings to the game log. (Free, robust, zero code.)
- **Same-day (between R3 debrief and R4, and after R4):** transcribe council-table audio + one designated sector; compute headline metrics only — talk time %, interruption count, questions asked. These three power the R4 recommitment and the closing delta screen.
- **Next-morning:** full transcription of all tables; behavioural coding with Claude against the Rackham (verbal behaviours) / Edmondson (psych safety markers) / Pentland (interaction dynamics) framework → individual PDF reports (participant-only) + team aggregate (client-facing).
- Known risk, owned openly: diarization of 6-person Malaysian code-switching tables is the hardest technical problem in this product — harder than the entire game. MVP mitigation: per-table (not per-person) attribution where diarization fails + facilitator observation tags as ground truth. Do not promise per-person interruption counts to clients until the pilot proves them.

---

## 8. Round Configuration (server-side `rounds.json`)

| Round | Length | Injects | Mechanics active | Measurement purpose |
|-------|--------|---------|------------------|---------------------|
| R0 Onboarding | 20 min | 1 tutorial fault/sector (self-contained) | Everything, zero stakes | Interface fluency; role self-assignment observation |
| R1 Stable Ops | 15 min | 1 minor/sector, staggered | Intra-sector only | **Baseline capture** — must feel comfortably manageable |
| — breather 5 min | | | decay paused | contrast |
| R2 Interdependence | 15 min | Cross-sector cascades, 2/sector; discrepancy live | Transfers, liaisons, Council #1 at ~18:00 | First stress delta; information-sharing latency |
| — breather 5 min | | | | |
| R3 Core Failure | 12 min | Critical stack ×3; Core drops to 60% at 05:00; Continuity Order due 25:00 | Triage, irreversibility, brownouts | Peak stress; values conflict; decision under deadline |
| Debrief 1 | 60 min | — | — | Individual headline metrics; trigger identification; 1 written behavioural commitment each |
| R4 Aftershock | 8 min | 6 novel-combination faults (1/sector) + 1 mini-triage | Same systems, fresh crisis | **Post-measurement** — the delta is the product |
| Debrief 2 | 45 min | — | — | Deltas on big screen; back-at-work transfer plan |

Total: 70 min play (20 min orientation, then four timed rounds, 50 min) + 105 min debrief. Every length is a scenario value the admin can change in SETTINGS. Each round runs on its own ROUND TIMER (2026-09-28, `undercity_round_timer_spec` v1.0): a round change loads the full length in READY, the admin presses START, and the clock stops at 00:00.

---

## 9. Requirements Priority

**P0 — cannot run without:** server + state + tick; the three views per §6 (control panel may ship visually rough); `faults.json` + answer key + crossref matrix; 6 binder PDFs, fault deck, chit pads, charter, consent pack; offline router kit; audio capture per §7; runbook for all rounds; reset checklist.

**P1 — first fast-follows:** ticker sound design + strobe polish; council-mode auto-layouts; observation-pad hotkeys; per-sector start-inventory config UI (MVP: edit JSON); printable end-of-day delta slide auto-generated from log.

**P2 — architectural insurance (design for, don't build):** automated cascade rules engine (state model already supports `triggered_by` field on faults — include the field now, leave it null); real-time transcription feed into control panel; multi-facilitator support; BM/中文 UI.

---

## 10. Open Questions

1. **[Michael / legal — BLOCKING]** IP ownership of UNDERCITY and the analytics methodology — resolve before build starts, per ATC precedent.
2. **[Eugene — blocking for §4.1]** Binder difficulty calibration confirmed as "one buried appendix, one loosely indexed section, otherwise clean"? (Spec assumes yes.)
3. **[Ops/Mei — non-blocking]** Venue requirements sheet: 6 tables + centre table + projector + power; minimum room size; does this fit standard client training rooms or does it constrain venue choice (pricing implication)?
4. **[Winnie — non-blocking]** Pricing architecture: is R4 + delta report a premium tier or the only tier? (Recommendation: only tier — it *is* the product.)
5. **[Katrina — non-blocking]** Which two sectors merge for sub-18 cohorts, and does the crossref ring survive the cut? (Proposed: cut TRN+AGR; needs a 4-sector crossref variant in the matrix.)
6. **[Pilot — resolves itself]** Fault pacing numbers in §8 are estimates; first internal playtest (TT staff as guinea pigs, week 3) rebalances `faults.json`.

---

## 11. Build Sequence (4 weeks)

- **W1:** Crossref matrix + `faults.json` + answer key (the game *is* this spreadsheet) · server + state + sector dashboard skeleton · PDPA consent draft to legal review.
- **W2:** Big screen + control panel · binder PDFs ×6 written with Claude · fault cards + chits + charter laid out.
- **W3:** Internal playtest with TT staff (2 sectors, R1–R2 only) → rebalance · audio pipeline dry run · runbook written from playtest learnings.
- **W4:** Full-kit dress rehearsal (all 6 sectors, all rounds, real timing) · reset-checklist validation by someone who didn't build it · pilot-client scheduling.

**The one-sentence build philosophy:** the spreadsheet of faults and cross-references is the game; the code is a display layer; the paper is the interaction layer; the debrief is the product.
