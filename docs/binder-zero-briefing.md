# UNDERCITY — Zero-Briefing Binders (2026-10-05)

The six sector binders are the participant's complete operating manual. A team
receives its binder, its console, its chits and its role cards, and plays the
whole shift without a presentation, a verbal briefing or a rules explanation.
The Game Master stays at `/control`.

Two editions were built on the same day. The **nine-page edition** (section 0)
is the one the kit prints; the 27-page operating manual it replaced is kept
below as the reconciliation record (sections 1–6), because the paper-versus-
software decisions and the Zero-Briefing Test results still stand.

## 0. The nine-page edition (approved architecture, 2026-10-05)

Every sector binder is exactly nine A4 pages, no cover, no contents page, no
role-card text, no worked examples, no generic steps repeated per fault. The
Station Operations Log is a separate loose sheet (`UNDERCITY_StationLog.docx`,
one page per sector).

| Page | Title | Scope | What is on it |
|---|---|---|---|
| 1 | START HERE — YOUR SECTOR | sector | Two-sentence context, objective, three-sentence mission, eight facts (operates, supplies, who depends, depends on, if DARK, authority, opening stock, workforce + upkeep), five-step start-up checklist. Roles: "take the Role Cards and assign them"; the cards carry the duties |
| 2 | RUNNING EACH ROUND | shared frame, own refresh line | Six-step round strip, rounds and clock, UPKEEP box, NEW ROUND — CHECK THESE NOW (upkeep result, production, workers, this sector's own refresh, open requests carry over), status table STABLE to DARK with the restart, pre-round line, banner line |
| 3 | YOUR SECTOR CONTROL | sector | POW/WTR: GENERATE, level table with a BROWNOUT column, upgrading, Level 5 support, allocation authority. MED: queue, HEAL, DECLINE, automatic recovery, Med Supplies, priority. TRN: approvals, CONFIRM CHIT, stamp, APPROVE, DECLINE, message table, brownout, own trades. AGR: three cards, GAIN and TRADE-OFF, targets, freight slot, the deck. COM: feed, intelligence, board, broadcast, focus, Charter, "publishing changes nothing real" |
| 4 | WHEN A FAULT APPEARS | shared | 1 GET VALUE → 2 BUILD CODE → 3 SUBMIT strip, seven steps, console message table, lockout, tactical tokens |
| 5 | TRADING, WORKERS & HEALING | shared | Seven-step transfer strip and steps, the "all three or nothing moved" box, workers and loans, injury and healing |
| 6 | QUICK ACTIONS & COUNCIL | shared, one own-panel line | Fourteen WHEN THIS HAPPENS → DO THIS rows, the Council box |
| 7 | FAULTS & REPAIRS — PART 1 | sector | Five fault cards (P-01 to P-05): large code, name, PROCEDURE · CREW · MATERIALS, VALUE 1 · VALUE 2 · ENTER |
| 8 | FAULTS & REPAIRS — PART 2 | sector | Five fault cards (P-06 to P-10) with TIME-CRITICAL and REFERENCE chains, then the ESCALATE TO line |
| 9 | SPECIFICATIONS, REFERENCES & AUTHORISATIONS | sector | VALUE / REFERENCE / AUTHORISATION legend, every specification table, the reference directory, the Appendix C value |

**How it is built.** `tools/kit/binder_compact.js` builds the nine pages;
`tools/kit/binder_rules.js` reads every number from the scenario config, the
tokens from `lib/rewards.js` and the AGR deck from `lib/agr-deck.js`;
`tools/kit/assemble_binders.py` supplies each sector's identity and its fault
rows, tables, references and Appendix C from the matrix and the generated
decks; `tools/kit/build_binders.js` renders. `python tools/kit/check_binder_pages.py`
exports every binder to PDF with Word and verifies that each of the nine pages
starts where it should.

**Verified, by test (`test/binder-compact.test.js`).** Every fault card
matches the content the server runs (code, name, procedure, crew, materials,
both value sources, format, TIME-CRITICAL); page 9 prints every value,
reference and authorisation of the sector and nobody else's; every printed
number is the scenario's; the BROWNOUT column equals what `economy.productionFor`
yields in brownout at each generator level, by execution; no resolution code,
spec value, probe or future fault list leaks; nothing waits for a trainer; the
console's own labels are used and the word is Health, never Integrity; the
shared pages are identical across the six binders; the kit sends every binder
and the log sheets to the stations and only the Answer Key and the Guidebook
to the desk.

**Change log, all six binders** (what was merged, shortened, moved or removed
against the 27-page edition):

- Merged: the Fault Code Index, the Repair Procedures and the escalation rows
  into the fault cards of pages 7–8; the Specification Tables, the Reference
  Directory and Appendix C into page 9; upkeep, the NEW ROUND box, the status
  table and the restart into page 2; the quick reference and Council into
  page 6.
- Shortened: START HERE from twelve steps to five; the upkeep Q&A to one box;
  every procedure from seven prose steps to one data card; the worked trade to
  a seven-step strip; the console guide to the labels used where they matter.
- Moved: the roles to the Role Cards only; the Station Operations Log to a
  loose sheet.
- Removed: cover, contents strip, back-cover duplicate, the sample Transfer
  Chit, the full console manual, the long upkeep FAQ.
- Preserved exactly: every fault code, name, ownership, escalation, procedure,
  crew, material, format, value source, reference chain, specification value,
  reference, Appendix C value, opening stock, workforce, upkeep, production,
  generator level and cost, approval and healing capacity, intervention
  effect, brownout and DARK effect, restart requirement, token effect, Council
  rule and trading requirement.

Sector notes: POW and WTR page 3 carry the generator table with the BROWNOUT
column; MED page 3 states both healing paths as implemented; TRN page 3 carries
the approval message table and the brownout approval count; AGR page 3 carries
the whole deck as a planning table; COM page 3 carries the three big-screen
controls and the Charter custody.

**Issues for the designer (nine-page edition).**

1. *Brownout output wording.* Config: `brownout_effects.production_multiplier`
   0.5, `per_sector.POW.production_multiplier` 0.25; the engine floors output
   × multiplier. Executed: POW yields 0, 0, 1, 1, 1 at Levels 1–5 in brownout
   (WTR 1, 1, 2, 2, 3). The binder prints these as the BROWNOUT column. The
   console's ROUND OUTPUT note still says "BROWNOUT — OUTPUT HALVED" for every
   sector, which is wrong for POW; the Guidebook said "to a quarter". Confirm
   the 0.25 and the rounding, then fix the console note.
2. *Council duration.* The brief asked the binder to say "Council lasts 5
   minutes". The scenario's `council_clock_s` is 60, the control panel resets to
   01:00, and five engine tests pin it. The binder says the sitting is timed by
   the Authority and ends when the Council clock reaches 00:00. To print five
   minutes, set `council_clock_s` to 300 (one config value) and update the
   control panel's RESET label and the tests; that is a mechanic decision.
3. *Appendix C is on page 9*, beside the tables, as the brief required; the old
   frustration-tolerance probe (an unindexed back page) is therefore weaker.
4. *MED's two healing prices* remain as implemented: HEAL from the queue costs
   no stock; the automatic round-change recovery spends one Med Supply.

---

## The 27-page edition (superseded the same day; reconciliation record)

## 1. Paper versus software: reconciliation

The spec required the implemented rules to win wherever the documents and the
engine disagreed. These were the disagreements and how each was resolved.

| Topic | Paper said | Software does | Resolution |
|---|---|---|---|
| Stock | Physical chits are the truth; the software does not police inventory (old binder p.11, Guidebook Part 1) | The console refuses a repair whose materials are missing, deducts them on success, takes upkeep at the round change, moves stock on TRN's approval, adds output on GENERATE | **Console is the official count; chits mirror it.** Binder §1, §5, §8; Guidebook Part 1 corrected |
| Council length | Five minutes, hard stop (old binder, build spec) | A one-minute clock the facilitator can extend in 30-second steps, shown on the console banner | **No fixed duration printed.** Binder §10: "the sitting ends when the Council clock reaches 00:00". The City Charter never stated a duration (Clause 3: timed by the Authority), so no Charter change was needed |
| Fault cards | The Game Master hands the matching card; procedures say "confirm the code on the alert card" | The fault appears on the console with code, severity, decay and reward the moment it is fired | **The console is the alert.** Procedures say "confirm the fault code on your console"; the printed deck is optional (manifest, Guidebook 2.5 and Part 7) |
| Injured workers | Tokens walk to MED's table and return after a round | The injured count stays on the sector's own console; healing is requested with REQUEST MED HEALING and granted by MED's HEAL; MED also returns one worker city-wide at each round change for one Med Supply | **Binder §8 describes the implemented flow.** Tokens stay at the station, face down |
| AGR output | "Produces Food — sustains Workforce efficiency" | No production and no Food resource exist; the intervention cards are AGR's lever | **Food claim removed.** AGR §2 and §6 describe the cards; the full deck is printed as a planning table derived from `lib/agr-cards.json` |
| Binder audience | Manifest, admin kit page and kit tests marked all six binders facilitator-only | A binder holds only its own sector's values and the team cannot play without it | **Binders are participant-facing.** Only the Answer Key and the Guidebook stay facilitator-only |
| The word for the sector's condition | Binder: Integrity; console header: Health; AGR card trade-offs: INTEGRITY; upkeep message: SECTOR HEALTH | One value | **HEALTH everywhere a participant reads.** `lib/agr-copy.js` trade-off lines now say HEALTH; the binder never says Integrity |

Facilitator dependencies removed from software: the console's cancel message
no longer says "ask the facilitator"; the DARK overlay no longer says "await
instructions"; the wall's pause screen no longer says "await facilitator".

## 2. What was built

**Binder architecture.** Cover with a NO BRIEFING IS COMING box and a contents
strip with page numbers; page 2 and the back page carry WHEN THIS HAPPENS → DO
THIS (19 rows, 20 for TRN). Then:

| § | Section | Pages | Shared / sector |
|---|---|---|---|
| 1 | START HERE — YOUR FIRST 5 MINUTES | 1 | shared (one production line differs) |
| 2 | YOUR SECTOR'S JOB | 1 | sector |
| 3 | WHO DOES WHAT | 1 | shared, from `roles.json` |
| 4 | HOW YOUR SHIFT WORKS | 1 | shared |
| 5 | UPKEEP, PRODUCTION & THE NEXT ROUND, with NEW ROUND — CHECK THESE NOW | 2 | shared Q&A; production block per sector |
| 6 | READING YOUR SECTOR CONSOLE, with THIS SECTOR ONLY | 2 (AGR 3) | shared table; own panel per sector; AGR's deck |
| 7 | WHEN A FAULT APPEARS | 2 | shared |
| 8 | RESOURCES & WORKFORCE | 2 | shared |
| 9 | HOW TO TRADE WITH ANOTHER SECTOR | 2 | shared, with a completed sample chit |
| 9A | YOU ARE THE STAMP | 1 | TRN only |
| 10 / 11 | WHEN COUNCIL IS CALLED · NO ACTIVE FAULT? DO THIS | 1 | shared (one own-panel line differs) |
| 12 | FAULT CODE INDEX | 1 | sector, content unchanged |
| 13 | REPAIR PROCEDURES | 4 | sector, content unchanged, "your console" |
| 14 / 14A | SPECIFICATION TABLES · CROSS-SYSTEM REFERENCE DIRECTORY | 2 | sector, unchanged |
| — | APPENDIX C | 1 | sector, unchanged and still unindexed |
| 15 | STATION OPERATIONS LOG | 1 | shared |

27 pages per binder; 28 for TRN (§9A) and AGR (the deck table).

**Single source of truth.** `tools/kit/binder_manual.js` builds every manual
section from the scenario the kit is built for
(`config/scenarios/haven9-standard.json`: upkeep, lockout, thresholds,
allowances, restart cost, generator levels, brownout effects), from the
engine's own modules (`lib/rewards.js` tokens, `lib/agr-deck.js` and
`lib/agr-copy.js` for the AGR deck) and from `tools/kit/roles.json`, which the
role cards also print. The Python assembler supplies only sector identity and
the reference half. A rule that changes in config changes in the binder at the
next `npm run kit`.

**Pages that add up.** Every section declares the pages it is laid out for;
the cover's page numbers are arithmetic from those declarations. Page breaks
are "page break before" paragraphs, which can never leave an empty leaf.
`python tools/kit/check_binder_pages.py` exports each binder to PDF with Word
and verifies with PyMuPDF that every section starts on the page the cover
promises. Result for this build: PAGE CHECK OK, all six binders.

**Tests.** `test/binder-manual.test.js` (ZB-001 to ZB-012): shared sections
identical across six binders; every printed number is the scenario's; no code,
value, probe or future fault list leaks; nothing waits for a trainer; the
manual uses the console's own labels and never a word the console does not
use; every participant-knowledge question has a home; section order; page
arithmetic; roles shared with the role cards; the reference half reworded to
the console; manifest audience; and the DARK console still offers its restart.
Full suite: 567 tests, 564 pass; the three failures are the known Windows
storage-class tests.

## 3. Files changed

Generators, templates and source data

- `tools/kit/binder_manual.js` — new: the operating manual, sections 1–11, quick reference, page plan
- `tools/kit/roles.json` — new: the four roles in full, shared by binder §3 and the role cards
- `tools/kit/build_binders.js` — rewritten renderer: cover, contents, boxes, cards, flow strip, sample chit, page-break-before layout, reference half renumbered 12–15
- `tools/kit/assemble_binders.py` — editorial fields removed; procedures confirm the code "on your console", point at "XXX Binder, Table" and "YOUR Table (§14)"
- `tools/kit/build_kit.js` — role cards print `roles.json` (DO / DON'T / WHEN NEEDED)
- `tools/kit/build_guidebook.js` — Part 1 "There is no briefing" and the corrected stock paragraph; staffing table; printing list (binders participant-facing, fault cards optional); 5.0 Orientation with no script; reset list
- `tools/kit/manifest.js` — only the Answer Key and the Guidebook are facilitator-only; titles updated
- `tools/kit/check_binder_pages.py` — new: Word export + PyMuPDF page check

Regenerated kit (`npm run kit`): `kit/UNDERCITY_Binder_{POW,WTR,MED,TRN,AGR,COM}.docx`, `UNDERCITY_RoleCards.docx`, `UNDERCITY_Facilitator_Guidebook.docx`, the other documents rebuilt unchanged in content, `kit/MANIFEST.json`. Three stray Word lock files (`kit/~$…docx`) are deleted from the repository.

Participant-facing software

- `public/sector/sector.css` — the DARK curtain takes no clicks and the EMERGENCY SHUTDOWN panel sits above it (found by the Zero-Briefing walkthrough)
- `public/sector/index.html` — DARK overlay text
- `public/sector/sector.js` — cancel message no longer sends a table to the facilitator
- `public/wall/index.html`, `public/wall/wall.js` — pause text; stale BRIEFING comment
- `lib/agr-copy.js` — trade-off lines say HEALTH
- `public/admin/admin.js` — kit page blurbs

Tests and docs

- `test/binder-manual.test.js` — new
- `test/kit.test.js`, `test/late-shift.test.js`, `test/reference-chain.test.js`, `test/agr-card-ui.test.js`, `test/agr-targets.test.js` — updated to the new audience, wording and HEALTH
- `README.md` — kit paragraph; `docs/binder-zero-briefing.md` — this report

## 4. Before and after

| | Before | After |
|---|---|---|
| Pages | 11 | 27 (TRN, AGR 28) |
| First page a team reads | Cover: "RESTRICTED — POW PERSONNEL" | Cover: "NO BRIEFING IS COMING … turn to page 3"; page 2: WHEN THIS HAPPENS → DO THIS |
| Rules a team needed from the facilitator | The premise, the objective, roles, rounds, the console, upkeep as implemented, production, trading as implemented, healing, rewards and tokens, CRITICAL/DARK/brownout behaviour, Council as implemented, every sector-only panel | None for normal operations; the only remaining reason to approach the desk is a technical failure |
| Where the rule numbers came from | Hand-typed in the assembler | Read from the scenario config and the engine at build time |
| Shared wording | Written once per binder page, drifting between sectors | One source, identical in all six (tested) |
| Audience | Facilitator-only | Participant-facing, one per station |
| Procedures | "Confirm the fault code on the alert card" | "Confirm the fault code on your console" |
| Word for the sector's condition | Integrity on paper, Health on screen, INTEGRITY on cards | Health everywhere |

## 5. Zero-Briefing Test

Condition: one sector binder (POW), the participant console at
`/sector/POW`, the Game Master only on the control socket. No guidebook was
opened. Each criterion was walked by reading the binder section and doing what
it says on the console; where other sectors were needed, their consoles were
driven the way their binders say.

| # | Criterion | Binder | Live result |
|---|---|---|---|
| 1 | Assign roles | §1 step 1, §3, name boxes | Paper only; nothing on the console is needed |
| 2 | Know the objective | §1 "Your objective" | — |
| 3 | Know what the sector does | §2 | — |
| 4 | Understand inventory and workforce | §1 steps 2–5, §8 | INVENTORY 3 ⚡ 3 💧 3 🔧 1 ⚕, WORKERS 8 / 8 AVAILABLE, exactly as §1 lists |
| 5 | Understand the round clock | §4, §6 | Current round "Round 0", Round time counting down |
| 6 | Understand upkeep | §5 | NEXT UPKEEP ⚡ 2 POWER + 💧 1 WATER, Status READY |
| 7 | Know what happens next round | §5 NEW ROUND box | Round 1 activated: "ROUND 0 · UPKEEP PAID — Sector stable.", 2 Power + 1 Water taken, Status SHORTFALL — 2 POWER SHORT until GENERATE, restart crew released (8 / 8) |
| 8 | Resolve a fault | §7 → §12 → §13 P-01 → §14 Table P-1 | F-001 fired; wrong code gave RESOLUTION REJECTED / ATTEMPTS 1; P-01-577 with 1 worker accepted; fault moved to RECENTLY RESOLVED, REWARD CLAIMED +1 PARTS, parts 3 → 3 |
| 9 | Obtain information from another sector | §7 step 8; procedures name "WTR Binder, Table W-4" and the row | Paper and voice; no console step |
| 10 | Perform a trade | §9 worked example | POW: RESOURCE EXCHANGE → + NEW REQUEST → WTR, 💧 WATER, 1 → SEND REQUEST (OUTGOING 1); WTR: banner VIEW / NEEDS ACTION → FULFILL (WAITING TRN 1) |
| 11 | TRN approves correctly | §9A | TRANSFER CONTROL → CONFIRM CHIT ("CHIT ✓ IN HAND") → APPROVE → CONFIRM APPROVAL; POW water 3 → 4, HISTORY 1 |
| 12 | Handle an injured worker | §8 | F-207 injured two TRN workers (6 / 8, INJURED 2); REQUEST MED HEALING → "TRN WORKER 1 → MEDICAL BAY WAITING FOR MEDICAL"; MED: HEALING THIS ROUND → HEAL → "1 / 3 USED · 2 LEFT", TRN 7 / 8 |
| 13 | Know what to do when Council is called | §10 | Banner "COUNCIL IN SESSION — CHIEF + LIAISON REPORT TO CENTRAL COUNCIL" with the Council clock (00:19 at reading) |
| 14 | Know what to do with no active fault | §11 | Console: "NO ACTIVE FAULTS — systems nominal" |
| 15 | Understand CRITICAL and DARK | §4 status table | Health 25: CRITICAL, red wash, every control live. Health 0: DARK, SECTOR OFFLINE. EMERGENCY RESTART: back at 20 %, CRITICAL, 2 workers held, 2 Parts + 1 Power + 1 Water taken |
| 16 | Continue to the next round unaided | §5 | GENERATE POWER pressed: 0 → 3 Power, OUTPUT ALREADY GENERATED THIS ROUND, Status READY |

One defect was found and fixed during the walk: at Health 0 the SECTOR
OFFLINE curtain covered the EMERGENCY RESTART button and swallowed the click,
so the binder's DARK instruction could not be followed. The curtain is now
click-through and the EMERGENCY SHUTDOWN panel sits above it (test ZB-012).

Rules questions a participant would still have to ask the desk: none within
normal play. The allowed exceptions remain: a console that stays RECONNECTING,
a venue or safety problem.

## 6. Items that need an owner's decision

None of these blocks play; each is a place where two implemented facts sit
oddly together, or where a design document still describes the old game.

1. **MED's two healing paths cost differently.** HEAL on the HEALING THIS ROUND
   queue costs no stock (three a round); the automatic recovery at the round
   change returns one worker city-wide and spends one of MED's Med Supplies.
   The binder states both as implemented. If one price is intended, that is a
   mechanic change.
2. **The big screen names fault codes.** The city map marks a sector's open
   fault (for example ⚠ F-207 on Transport) for the whole room, so COM's
   information advantage is its live feed and figures, not the code itself. The
   binder describes what the wall shows; no change was made.
3. **`docs/undercity-spec.md` is the original build specification** and still
   describes the five-minute Council, physical fault cards and workforce
   refugees at DARK. It is a design-history document, not participant-facing,
   and was left as it is.
4. **Round 0's bill.** Round 0 is charged when Round 1 is activated only if
   Round 0's clock was started; the binder says the first bill "can come as
   early as the start of Round 1", which is true in both cases. If Round 0
   should always be free, that is a config decision.
