# Facilitator & Administrator Guidebook — audit, conflict log and proposed structure

**Date:** 2026-10-05 · **Scope:** deliverables 1–5 and 7 of the revision brief.
**Deliberately not done yet:** the full rewrite (deliverable 6) and the final QA pass
(deliverable 8). The brief says to audit, log the conflicts and agree the structure
first, and four of the findings below need a decision before any rewrite is safe.

**What was audited against what.** Every claim below was checked against the running
system, not against another document: the engine (`lib/state.js`, `lib/economy.js`,
`lib/rewards.js`, `lib/content.js`), the scenario (`config/scenarios/haven9-standard.json`),
the merged fault deck (60 faults), the control panel and sector console markup, and the
text of all fourteen printed kit documents extracted from the `.docx` files themselves.

---

## 1. Audit summary

The guidebook is well written and unusually honest about its own design. It is not a
bad document; it is a document that has been overtaken by its own system. Six changes
landed between 2026-09-27 and 2026-10-05 — the even deck, eight rounds, the round
timer, manual-only faults, Round 0 upkeep, AGR trade-offs — and the guide absorbed
most of them in the places that were rewritten while older paragraphs kept the previous
rules.

**The five issues that matter most**

1. **The guide contradicts itself about the single most-pressed button.** §3.3 says
   NEXT ROUND changes nothing but what may be fired next. §5.1 says it loads the clock
   and charges upkeep. The engine agrees with §5.1. A facilitator who reads Part 3
   before the day — which the guide tells them to do — will be surprised by a bill on
   every table at the first transition.

2. **Round 0 upkeep is documented backwards.** The guide says Round 0 is never charged.
   It has been charged since 2026-09-29. Six sectors pay 2 Power and 1 Water the moment
   Round 1 is activated, and a sector that cannot pay loses 10 Health before the
   baseline round has started.

3. **The one sentence the facilitator says out loud at orientation sends the room to
   the wrong page.** "Start at page 3" — START HERE is page 1. The next beat in the
   same table cites p.1 correctly.

4. **The console no longer mirrors the runbook.** Every fault is now fired by hand from
   the library; the scripted timeline holds between zero and two non-fault beats per
   round. The guide still tells a new facilitator the panel mirrors the beats in order.

5. **Navigation is the real usability problem.** The operational content exists, but
   finding it means reading prose. There is no single run sheet, no "what do I press
   now" page, no index of controls, and the live beats for one round are spread across
   two tables in different parts. Under live conditions this is the failure mode: not
   missing information, but information that cannot be reached in ten seconds.

**Smaller but real:** two injury faults have no physical-token instruction; the chit
print quantity is arithmetically impossible as written; "RESET RUN" is not a button;
the kit page reports 36 faults for a 60-fault deck; Health and Integrity are used for
the same number in the same breath.

**What is already correct, and should not be "fixed":** Round 1 is exactly F-101 to
F-106, one per sector; the fault card count of 60 is right; TIME LIMIT has been removed
from every printed document, so TIME-CRITICAL is now a single unambiguous mechanic; the
340/290 discrepancy is live and correctly described; round lengths, opening stock,
upkeep, workforce and reset values all match the scenario exactly.

---

## 2. Conflict log

| # | Issue | Source A | Source B | Why it matters | Recommended resolution | Designer decision? |
|---|---|---|---|---|---|---|
| C-01 | What NEXT ROUND does | Guide §3.3: "changes what you may fire next… changes nothing else: no clock resets, no stock, health, worker, transfer or upgrade moves" | Guide §5.1 + `setRound()` and `activateRound()`: clock reloads to full length, allowances refresh (TRN approvals, MED heals, AGR hand), generator upgrades complete, restart crews release, outgoing round's upkeep is charged | The most-pressed control in the day, described two opposite ways in one book | Delete the §3.3 claim. State the rule once, in the run sheet, as five numbered consequences | No — the engine settles it |
| C-02 | Round 0 upkeep | Guide §5.1: "Round 0 is orientation and is never charged" | `activateRound()`: "Round 0 is charged like any other (2026-09-29)… the first deduction lands when Round 1 is activated" | Six bills land at the first transition; a shortfall costs 10 Health before the baseline round | Correct the guide; add the two real exemptions (a round whose clock never started, and going backwards) | No |
| C-03 | Transfer chit quantity | Guide printing table: "~120 · 40 sheets, 2-up" (40 × 2 = 80) | `UNDERCITY_TransferChits.docx` holds 40 chits on 20 sheets; `build_kit.js` comment: "Print ~120 (60 sheets) per run" | Facilitators under-print and run out mid-shift | State it as: print the file three times — 60 sheets, 120 chits | Confirm 120 is the target |
| C-04 | Orientation checklist length | Guide §5.0: "the twelve things to do before operating" | Binder p.1 START-UP CHECKLIST: **5 steps** | A facilitator looking for twelve steps assumes the binder is misprinted | Say five | No |
| C-05 | The orientation line | Guide §5.0 00:01: 'Say only: "…Start at page 3."' | Binder p.1 is START HERE; p.3 is the sector's own control panel. Guide's own next beat cites "binder p.1, step 1" | This is the only sentence the facilitator says to the whole room | "Start at page 1." | No |
| C-06 | Council duration and "the close of the sitting" | Charter Clause 3: "A sitting is timed by the Continuity Authority. It does not run over." Clause 7: a Continuity Order submitted after the close has no effect | Console: 60-second clock, `+0:30` extendable without limit; guide: "+0:30 as often as the room needs it" | If the sitting can always be extended, "the close" has no fixed meaning — and the Continuity Order deadline is defined by it | **DECIDED 2026-10-05: the sitting is one minute and may be extended only before 00:00.** Implemented: the engine refuses `+0:30`, `−0:30` and RESET on a closed sitting, and the console greys them out. A second sitting is CLOSE COUNCIL then CALL COUNCIL, counted as sitting 2 in the log | Closed |
| C-07 | WAVE on screen | Guide §3.3: "Every screen in the building — yours included — shows one thing: Round 0 to Round 7" | Control panel: "Preset waves — preview, then fire", "PRESET WAVE — …", "FIRE WAVE", "RESET WAVE" | The guide's own rule says the facilitator's screen shows no wave language | Either define WAVE as facilitator-only vocabulary permitted on the control panel, or rename that control | **Yes** (small) |
| C-08 | "The control panel mirrors these beats" | Guide §5 opening | Timelines carry no fault beats at all (R0 0, R1 0, R2 1, R3 2, R4 2, R5–R7 1 — announce/core/alert only); `fault_presets` is empty | A new facilitator looks for the script on screen and finds an empty list | Rewrite: the console carries the broadcasts and the Core drop; the beats live on paper. See system change S-3 | No |
| C-09 | Injuries and physical tokens | Guide §5 Round 2: "Move two TRN workforce tokens physically to the MED table (F-207's injury)" | Deck: F-207 injures 2 (TRN), **F-303 injures 1 (MED)**, **F-304 injures 1 (TRN)** — neither mentioned | Table and console diverge in Round 3, in the round where health matters most | State the general rule once: whenever a console shows an injury, that many tokens move to MED. Keep F-207 as the worked example | No |
| C-10 | RESET RUN | Guide Part 7 step 8: "Control panel: RESET RUN with a new run ID" | The control panel's label is **RESET SESSION** (••• menu, typed RESET plus a reason). `reset_run` is an internal message name | A reset performed by someone who did not build the game, looking for a button that is not there | Use the interface's words throughout; add the typed-confirmation detail | No |
| C-11 | `deadline_s` vs TIME-CRITICAL | Content still carries `deadline_s`: F-302 = 480, F-304 = 360, F-404 = 600 | The engine ignores it ("decay is the only clock on a fault"); no printed document contains "TIME LIMIT" any more | Dead data that reads like a live rule to anyone opening the JSON or writing a new tool | One mechanic, already standardised on paper. Drop the field at the next matrix regeneration | Confirm removal |
| C-12 | Kit page reports 36 faults | `kit/MANIFEST.json` counts `content/faults.json` only | The deck the game fires is 60: 36 round + 12 reference chain + 12 late shift. Cards, answer key and binders all cover 60 | The facilitator's own kit page understates the deck by 24 | Count the merged deck in the manifest (system change S-4) | No |
| C-13 | "Briefing" in the block table | Part 4: "Arrival, consent, briefing — 20 min" | Part 1: "There is no briefing" | The word the whole design is built against appears as a block name | Rename to "Arrival, consent, roles" | No |
| C-14 | Health vs Integrity | Console header and upkeep message say **HEALTH**; `−10 SECTOR HEALTH` | Reward text says **+5 INTEGRITY**; AGR cards say Integrity; control panel says "Drop Core Integrity"; the data field is `sector.integrity` | One number with two names, while a *different* number (Core) also uses one of them | Pick one participant-facing word for the sector number and use it everywhere on screen and on paper; reserve "Core" for the city number. See the dictionary | **Yes** |

**Four decisions are needed before the rewrite:** C-06 (Council close), C-07 (wave
language), C-11 (dead deadline field), C-14 (Health vs Integrity). Everything else has
a provable answer and will be corrected to match the system.

---

## 3. Terminology dictionary

One meaning per term. Where the interface and the paper disagree today, the proposed
single term is marked **→**.

| Term | Means exactly | Notes and current collisions |
|---|---|---|
| **Sector Health** | The 0–100 number each sector carries. Falls with fault decay and upkeep shortfall; `critical` below 30, `degraded` below 70, DARK at 0 | **→ Decision C-14.** Console says HEALTH; rewards and AGR cards say INTEGRITY; the data field is `integrity` |
| **Core output** | The city-wide number the facilitator sets (starts at 100). Scales POW's production | Never a sector's number. "Core Integrity" and "Core output" are used interchangeably in the guide — pick one |
| **Round** | One of eight numbered periods, Round 0 to Round 7. The period for upkeep, allowances and effects | The only time word any participant screen shows |
| **Wave** | Facilitator-only word for a stretch *inside* a round with its own beats | **→ Decision C-07.** Appears on the control panel today |
| **Shift** | The whole continuous run, Round 0 through Round 7 | Never a round |
| **Fault** | One issued problem on one sector's console | 60 exist: 36 round deck, 12 reference chain, 12 late shift |
| **Fire** | The facilitator issuing a fault from the library | Replaces "inject" — the interface says fire |
| **Inject** | — | Retire the word; it survives only in older prose |
| **TIME-CRITICAL** | A P-10 fault: 3 crew, heavier materials, Integrity falling 3.0 a minute while open. **No countdown exists** | The printed TIME LIMIT lines were removed; the engine ignores `deadline_s` |
| **Decay** | Health lost per minute while a fault is open | P-09 = 2.0, P-10 = 3.0, round deck 0–3.0 |
| **Upkeep** | 2 Power + 1 Water per sector, charged for the outgoing round when the next is activated | All of it or none: a short sector keeps its stock and loses 10 Health |
| **Brownout** | A facilitator state placed on a sector by the quick action, per Continuity Order | Sector keeps its Council seat (Charter Clause 8) |
| **DARK** | Health 0. Produces nothing; a reward cannot revive it | Not the same as brownout |
| **Rolling blackout** | The Charter Clause 7 consequence when no Continuity Order is submitted | EVENTS › PRESSURE |
| **Request** | A sector asking another for stock. The only door participants have | Not a transfer |
| **Transfer** | A request the supplier accepted, awaiting Transport | Not yet moved |
| **Delivered** | Transport approved; the console has moved the stock | Only now do the physical chits move |
| **Council** | A timed discussion at the centre table, called by CALL COUNCIL | Triggers nothing by itself; expiry only prints COUNCIL TIME EXPIRED |
| **Continuity Order** | The Clause 7 ranking form, submitted before the sitting closes | Round 3 |
| **START / STOP CLOCK / PAUSE** | START runs this round's clock; STOP CLOCK ends it; PAUSE freezes everything for an emergency only | Not pacing tools |
| **NEXT ROUND** | Moves to the next round: charges the outgoing round's upkeep, loads the new clock at full length READY, refreshes allowances. Deals no faults | See C-01 |
| **RESET SESSION** | The between-cohort reset, typed confirmation plus a reason | Not "RESET RUN" |

---

## 4. Proposed structure

The brief's 00–14 model, with the source of each section. "Keep" means the existing
text is good and moves; "rewrite" means the content exists but the form fails under
live use; "new" means it does not exist yet.

| § | Title | Source | Work |
|---|---|---|---|
| 00 | 60-Second Admin Overview | Part 1, compressed to one page | New page, old material |
| 01 | Before the Day | Part 2.1–2.4 | Keep |
| 02 | Pre-Game Setup Checklist | Part 2.5 + §7 reset list, inverted into checkboxes | Rewrite as a table |
| 03 | Who Does What | Part 2.1 table + role cards (4 per sector: Chief, Liaison, Systems Lead, Engineer) | Rewrite as a matrix |
| 04 | **Master Run Sheet** | Part 4 and Part 5, merged | New — draft in §5 below |
| 05 | Detailed Runbook | Part 5 as it stands, corrected | Keep, demoted |
| 06 | Fault Control Matrix | New, generated from the deck | New — generate, never type |
| 07 | Council Control Procedure | Part 5 Round 2/3 beats + Charter Clauses 2, 3, 7, 8 | New page, pending C-06 |
| 08 | Trading Validation | Binder p.5 + the request→delivered chain | New checklist |
| 09 | Sector Special Abilities | Binder p.1 "SPECIAL AUTHORITY" of all six | New matrix |
| 10 | When NOT to Help | Part 3.1 principle 2, split into the brief's two lists | Rewrite |
| 11 | Troubleshooting | Part 6 | Keep, add the IF/CHECK/DO/DO NOT columns |
| 12 | End Simulation | Part 5.1 closing note | Rewrite as a page |
| 13 | Debrief | Parts 5.2–5.4 | Keep, visually separated |
| 14 | Reset Between Cohorts | Part 7 | Keep, add a signature line |

Two sections should be **generated from the content pipeline rather than written**, so
they cannot drift the way the current guide did: §06 (fault matrix) and the fault lists
inside §04. They come from the same files the binders are built from.

---

## 5. Master Run Sheet — draft

Clock column is minutes into the round. Every fault is fired by hand from
EVENTS › FAULTS › LIBRARY. Values verified against the scenario and the deck.

| Round | Clock | Facilitator action | Control | Faults / events | Participants | Watch for | May I intervene? | Before continuing |
|---|---|---|---|---|---|---|---|---|
| 0 | 00:00 | Confirm 6 + 1 recorders rolling, then fire the klaxon | Audio | — | Consoles already show Round 0 | Nothing — this is the audio sync | Technical only | Every recorder rolling |
| 0 | 00:01 | Hand out binder, role cards, chit pad, tray, tokens. Charter to COM only. Say: "Everything you need is in the binder. **Start at page 1**." | — | — | 5-step start-up checklist, p.1 | Who opens the binder, who waits | No | Each table has its own binder |
| 0 | 00:03 | Say nothing while roles are assigned | — | — | Binder p.1 step 1 | Volunteering, deferring, loudest takes Chief | No | — |
| 0 | 00:06 | Fire the six tutorial faults | LIBRARY | F-001…F-006, one per sector | Console alert → binder p.4 → p.7 | Procedure read aloud or silently | Console faults only | All six fired |
| 0 | 00:16 | Confirm each sector resolved its tutorial fault | — | — | — | A console on the wrong sector | Wrong sector, dead link | Six consoles correct |
| 0 | 00:19 | NEXT ROUND → Round 1, then START | NEXT ROUND, START | — | Round number changes | Nobody waiting for a pause | No | **Upkeep for Round 0 is charged now** |
| 1 | 00:00 | Fire the round's six faults at the room's pace. Announce: routine shift | LIBRARY | F-101…F-106, one per sector | One fault each | Who speaks first at each table | No | All six on the board |
| 1 | 02:00 | Walk the floor | — | — | — | Crew assignment: discussed or decided by one | No | — |
| 1 | 06:00–14:00 | Fire nothing. Let it be easy | — | — | — | Who is tense at low load | No | Baseline captured |
| 2 | 00:00 | NEXT ROUND → Round 2, START, fire twelve faults, two per sector. Move 2 TRN tokens to MED (F-207). Announce coupling | NEXT ROUND, START, LIBRARY | F-201…F-212 | Every fault needs another binder | How long to the first liaison | No | Upkeep charged; tokens moved |
| 2 | 01:00 | Walk | — | — | — | F-201 is the discrepancy fault — watch WTR | No | — |
| 2 | 03:00 | Watch AGR and POW | — | — | AGR needs COM twice; POW asked by two | Batching or two trips; hoarding | No | — |
| 2 | 04:00 | Watch TRN | — | — | Two workers visibly gone | Does TRN ask MED for them back | No | — |
| 2 | 05:00 | Glance at AGR's console | — | — | First round with TRADE-OFF cards | Is the operating notice still unacknowledged | No | — |
| 2 | 06:00 | CALL COUNCIL. Chiefs and liaisons to the centre | CALL COUNCIL | 60 s, extend before 00:00 | Stations run short-handed | **The key observation window** | No | Declared length announced |
| 2 | 09:00 | CLOSE COUNCIL | CLOSE COUNCIL | — | — | Does anything agreed change behaviour | No | — |
| 2 | 11:30 | Nothing scripted — this wave is inside Round 2 | — | Off-script only | Carrying unfinished work forward | Nobody gets a clean sheet | Off-script faults | — |
| 2 | 13:00 | INJURE WORKER on the busiest sector; one off-script fault into any clear table | INJURE WORKER, LIBRARY | — | — | Who asks for help first | Yes — pacing | — |
| 2 | 14:00 | One more off-script fault into the loudest sector | LIBRARY | — | — | Sectors below 50 Health | Yes | — |
| 3 | 00:00 | NEXT ROUND → Round 3, START, fire six critical faults. Announce Core falling | NEXT ROUND, START, LIBRARY | F-301…F-306, two specs each | Buried Appendix C needed | Who opens the back of the binder | No | Upkeep charged |
| 3 | 01:00 | Walk | — | F-302 decays 3.0/min, F-304 2.5 | — | Panic-guessing at the console | No | — |
| 3 | 01:30 | Watch AGR's hand (MEDIUM/HIGH trade-offs) | — | — | — | Will AGR spend its own Health for a neighbour | No | — |
| 3 | 02:00 | Drop Core output to 60, announce, klaxon | CITY SYSTEMS › CORE | — | Public change | Who moves toward the problem | — | Core reads 60 |
| 3 | 05:00 | CALL COUNCIL, announce the Continuity Order is due, place the form | CALL COUNCIL | Order due before the close | Chiefs at the centre | Clause 7 never defines "essential" | No | **Declare the close time** |
| 3 | 06:30 | Ninety-second warning. No help, no extension | — | — | — | Paralysis or one voice bulldozing | No | — |
| 3 | 08:00 | Submitted → BROWNOUT the two lowest-ranked, one at a time. Not submitted → ROLLING BLACKOUT | BROWNOUT / EVENTS › PRESSURE | — | Consequence is public | Indecision must cost more than any decision | No | Consequence applied |
| 3 | 08:30 | Redeploy brownout sectors as aid crews | — | — | Nobody sits out | How they are treated by their host table | — | — |
| 3 | 11:00–11:30 | Fire nothing for two minutes. Never call it a break | — | — | Clock, decay, repairs all continue | What a team does with slack | No | — |
| 4 | 00:00 | NEXT ROUND → Round 4, START. Restore brownout sectors. Announce seismic activity | NEXT ROUND, START, LIBRARY | F-401…F-406, each needs a buried appendix | Nothing else is given back | Does anyone notice nothing was restored | No | Upkeep charged; broadcast played |
| 4 | 01:00 | LATE SHIFT and REFERENCE CHAIN sections open to you | LIBRARY | P-09 (two sources), P-10 (TIME-CRITICAL) | Two live faults per table | Who is asked by two tables at once | Pacing only | Each sector someone's dependency once |
| 4 | 03:30 | Optional short Council if coping | CALL COUNCIL | — | — | Compare against the first sitting | — | — |
| 4 | 05:00 | Fire into the two weakest sectors | LIBRARY | — | — | Who has stopped asking questions | Yes | — |
| 4 | 06:00 | Announce the time remaining once | — | — | — | What a table spends its last minutes on | — | — |
| 5 | 00:00 | NEXT ROUND → Round 5, START (SYSTEM LOAD INCREASING plays). Fire 2–3 faults that all need one sector, plus one into that sector | NEXT ROUND, START, LIBRARY | Mixed families | One capability wanted by several | Does the bottleneck serve in the order asked or shouted | No | Upkeep charged |
| 5 | 05:00 | One P-10 into a sector already carrying a fault | LIBRARY | TIME-CRITICAL, 3.0/min | — | Does the table drop the old fault for the loud one | Pacing | — |
| 5 | 08:00 | Announce the time once | — | — | — | Transfers nobody can finish | — | — |
| 6 | 00:00 | NEXT ROUND → Round 6, START (CASCADE CONDITIONS DETECTED). One fault into the lowest-Integrity sector and one into the sector it depends on | NEXT ROUND, START, LIBRARY | A P-10 where a movement is already waiting | Earlier decisions arrive | Does the room see the chain | No | Upkeep charged |
| 6 | 03:00 | Walk. Fire nothing more at a table that is drowning | — | — | — | A Round 5 plan that no longer works | Yes — stop firing | — |
| 6 | 06:00 | A second P-10 only if the room is coping | LIBRARY | — | — | Who gives up a value for another sector | Yes | — |
| 7 | 00:00 | NEXT ROUND → Round 7, START (FINAL OPERATING WINDOW). Fire exactly three connected problems | NEXT ROUND, START, LIBRARY | P-10 on a near-CRITICAL sector; a reference chain; a late-shift fault across two silent sectors | Not everything can be solved | Does anyone say "priority" | No | Upkeep charged |
| 7 | 03:00 | Optional Council | CALL COUNCIL | — | — | Measurably different from sitting one | — | — |
| 7 | 05:00 | Nothing new unless a table has gone quiet | — | — | The last five minutes are theirs | Who stops repairing to help a neighbour | No | — |
| 7 | 08:00 | Announce the time remaining once | — | — | — | What a city spends its last minutes on | — | — |
| 7 | 10:00 | END SIMULATION | END SIMULATION | — | Everything freezes, nothing is cleared | Silence, then talk. Explain nothing | — | Final state left on the wall |

**Round lengths (verified):** R0 20:00 · R1 15:00 · R2 15:00 · R3 12:00 · R4 08:00 ·
R5 10:00 · R6 10:00 · R7 10:00. Rounds 1–7 = 80 minutes.

---

## 6. System change list

Where the guide needs something the interface does not have, or the interface says
something the guide forbids.

| # | Change | Why | Size |
|---|---|---|---|
| S-1 | Rename the control panel's preset-wave UI, **or** permit WAVE as facilitator vocabulary | §3.3 forbids wave language on every screen including the facilitator's | Small — pending C-07 |
| S-2 | Remove or populate the preset-wave section | `fault_presets` is `[]`; the UI offers a control with nothing behind it | Small |
| S-3 | Runbook progress panel: current beat, next beat, completed beats | Replaces the claim that the console mirrors the runbook; the brief asks for it too | Medium |
| S-4 | Count the merged deck in `kit/MANIFEST.json` | The kit page reports 36 faults for a 60-fault deck | Small |
| S-5 | ~~Council: extension only before 00:00~~ | **Done 2026-10-05.** `councilClock()` refuses `add`, `set` and `reset` once the status is `expired`; the console disables those three controls and leaves CLOSE COUNCIL live | Shipped |
| S-6 | One word for the sector number across console, wall, rewards and AGR cards | Health and Integrity currently name the same number | Medium — pending C-14 |
| S-7 | Drop `deadline_s` from the content pipeline | Dead field the engine ignores; reads as a live rule | Small — pending C-11 |
| S-8 | Preflight checklist gating START | Requested in the brief; would catch wrong-sector consoles before orientation rather than at 00:16 | Medium |

Not recommended: the brief's "round guardrail" warning before firing an out-of-round
fault. From Round 4 the design deliberately mixes every family, so the warning would
fire constantly in exactly the rounds that matter most.

---

## 7. What I need from you before the rewrite

1. ~~**C-06 Council.**~~ **Answered 2026-10-05: one minute, extend only before 00:00.**
   Built and verified; the guidebook's "+0:30 as often as the room needs it" (Round 2
   beat 06:00 and Round 3 beat 05:00) is now wrong in two places and is corrected in
   the rewrite.
2. **C-07 Wave.** Facilitator-only word allowed on the control panel, or removed from
   the interface?
3. **C-14 Health vs Integrity.** One word for the sector number — which?
4. **C-11 `deadline_s`.** Confirm it can be dropped from the content at the next
   regeneration.
5. **C-03 chits.** Confirm 120 is the intended print target.

Everything else in the conflict log will be corrected to match the running system.
