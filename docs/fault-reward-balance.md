# Fault reward balance — audit and rebalance (2026-10-05)

**Scope.** The authoritative reward data is `lib/fault-rewards.json` (one fixed reward per fault, FAULT
REWARDS v2) joined to the three fault decks the engine loads through `lib/content.js`: the 36 workbook
faults (`content/faults.json`, Rounds 0–4), the 12 reference chains (`content/faults.reference-chain.json`)
and the 12 late-shift faults (`content/faults.late-shift.json`). Sixty faults, ten per sector. The scenario
`haven9-standard` carries no `fault_reward_overrides`, so the table is what every run pays.

**Two views.** A fault with a round is on the runbook's script: the guidebook tells the Game Master to fire
F-001–F-006 in Round 0, F-101–F-106 in Round 1, the twelve R2 faults, the six R3 faults and the six R4
faults, one per sector each time. The reference chains (from Round 3) and the late shift (from Round 4) are
library faults the Game Master mixes in at discretion. "Standard scripted run" below means the 36 faults
with a round; "library" means the other 24.

**Timing bands.** early = Rounds 0–1; mid = Rounds 2–3 plus the reference chains; late = Round 4 plus the
late shift.

**Balancing score (internal, never shown).** Starting weights from the brief: Power 1, Water 1, Parts 2,
Med 2, +5 Health 2, Reserve Crew 2, Second Chance 2, Emergency Repair Kit 3, Stabiliser 3. Checked against
the mechanics: the Repair Kit saves exactly one Spare Part on one repair, so it is worth at most a Parts
reward (2, and less flexible: a Part can also be traded, spent on an upgrade or an emergency restart); the
Stabiliser blocks one minute of one fault's decay, which at 3.0/min is three Health points, so it is worth
about a +5 Health reward or less (1.5). Both weightings are shown; the matrix is balanced under either.
"Cost" in the fault tables is crew + materials weighted Parts 2, Med 2, Power 1, Water 1.

## CURRENT REWARD BALANCE

| Sector | Power | Water | Parts | Med | +5 Health | Reserve Crew | Second Chance | Repair Kit | Stabiliser | Faults | Value (start) | Value (adj) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| POW | 0 | 0 | 8 | 0 | 2 | 0 | 0 | 0 | 0 | 10 | 20 | 20 |
| WTR | 1 | 0 | 2 | 0 | 6 | 0 | 1 | 0 | 0 | 10 | 19 | 19 |
| MED | 1 | 1 | 0 | 5 | 3 | 0 | 0 | 0 | 0 | 10 | 18 | 18 |
| TRN | 1 | 0 | 7 | 0 | 1 | 1 | 0 | 0 | 0 | 10 | 19 | 19 |
| AGR | 1 | 2 | 0 | 0 | 5 | 1 | 0 | 1 | 0 | 10 | 18 | 17 |
| COM | 1 | 0 | 0 | 0 | 3 | 1 | 2 | 2 | 1 | 10 | 22 | 18.5 |
| **City** | 5 | 3 | 17 | 5 | 20 | 3 | 3 | 3 | 1 | 60 | 116 | 111.5 |

| Sector | Power | Water | Parts | Med | +5 Health | Reserve Crew | Second Chance | Repair Kit | Stabiliser | Faults | Value (start) | Value (adj) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| POW | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 12 | 12 |
| WTR | 0 | 0 | 2 | 0 | 4 | 0 | 0 | 0 | 0 | 6 | 12 | 12 |
| MED | 0 | 1 | 0 | 3 | 2 | 0 | 0 | 0 | 0 | 6 | 11 | 11 |
| TRN | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 12 | 12 |
| AGR | 1 | 0 | 0 | 0 | 3 | 1 | 0 | 1 | 0 | 6 | 12 | 11 |
| COM | 0 | 0 | 0 | 0 | 1 | 1 | 2 | 1 | 1 | 6 | 14 | 11.5 |
| **City** | 1 | 1 | 14 | 3 | 10 | 2 | 2 | 2 | 1 | 36 | 73 | 69.5 |

| Sector | Power | Water | Parts | Med | +5 Health | Reserve Crew | Second Chance | Repair Kit | Stabiliser | Faults | Value (start) | Value (adj) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| POW | 0 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 4 | 8 | 8 |
| WTR | 1 | 0 | 0 | 0 | 2 | 0 | 1 | 0 | 0 | 4 | 7 | 7 |
| MED | 1 | 0 | 0 | 2 | 1 | 0 | 0 | 0 | 0 | 4 | 7 | 7 |
| TRN | 1 | 0 | 1 | 0 | 1 | 1 | 0 | 0 | 0 | 4 | 7 | 7 |
| AGR | 0 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 4 | 6 | 6 |
| COM | 1 | 0 | 0 | 0 | 2 | 0 | 0 | 1 | 0 | 4 | 8 | 7 |
| **City** | 4 | 2 | 3 | 2 | 10 | 1 | 1 | 1 | 0 | 24 | 43 | 42 |

### Who gets what, when (current)

| Sector | early (R0, R1) | mid (R2, R2, R3 + chains) | late (R4 + late shift) |
|---|---|---|---|
| POW | F-001 Parts, F-101 Parts | F-201 Parts, F-202 Parts, F-301 Parts, F-501 Parts, F-502 +5 Health | F-401 Parts, F-601 Parts, F-602 +5 Health |
| WTR | F-002 Parts, F-102 +5 Health | F-203 +5 Health, F-204 Parts, F-302 +5 Health, F-503 +5 Health, F-504 Second Chance | F-403 +5 Health, F-603 Power, F-604 +5 Health |
| MED | F-003 Med, F-103 Water | F-205 Med, F-206 +5 Health, F-303 Med, F-505 Med, F-506 Med | F-402 +5 Health, F-605 Power, F-606 +5 Health |
| TRN | F-004 Parts, F-104 Parts | F-207 Parts, F-208 Parts, F-304 Parts, F-507 Parts, F-508 Reserve Crew | F-404 Parts, F-607 Power, F-608 +5 Health |
| AGR | F-005 +5 Health, F-105 Reserve Crew | F-209 Power, F-210 Repair Kit, F-305 +5 Health, F-509 Water, F-510 +5 Health | F-405 +5 Health, F-609 Water, F-610 +5 Health |
| COM | F-006 Second Chance, F-106 Repair Kit | F-211 +5 Health, F-212 Second Chance, F-306 Stabiliser, F-511 +5 Health, F-512 Repair Kit | F-406 Reserve Crew, F-611 Power, F-612 +5 Health |

### Imbalance observations

- **Value was roughly level, categories were not.** Every sector sat between 18 and 22 on the score, but
  the categories were sector identities: POW held 8 of the 17 Parts rewards and TRN 7, while MED, AGR and
  COM held none. All five Med rewards were MED's. Six of the ten tokens were COM's; POW and MED had none.
- **The scarce resources were concentrated.** Spare Parts and Med Supplies are the two resources nobody
  generates. Four sectors could never earn a Part by repairing, and five could never earn a Med Supply.
- **The scripted run was more skewed than the library.** Over the 36 scripted faults POW and TRN each
  earned 6 Parts and nothing else; WTR earned 4 of its 6 rewards as Health; COM earned 5 tokens; MED alone
  earned Med. A normal session, not just the full library, told each table a different story about what
  repairing is worth.
- **Health rewards were paid where they could not count.** F-005 (AGR, Round 0) and F-102 (WTR, Round 1)
  paid +5 Health while a sector is still at or near 100 — the console says AT MAXIMUM and nothing moves.
  The Round 0 faults do not even decay.
- **Timing was lopsided.** POW's and TRN's Parts arrived in every round; AGR's and COM's never. COM had
  four tokens before Round 3; WTR's only token and TRN's only token sat on a library chain fault.
- **Library-only value.** WTR's one token and TRN's one token existed only on an optional reference chain
  (F-504, F-508), while AGR and COM earned tokens from guaranteed scripted faults.
- **Only one Stabiliser existed** (COM, F-306), so three token types had three holders and one had one.
- **Totals.** City: 17 Parts, 5 Med, 5 Power, 3 Water, 20 × +5 Health, 10 tokens (3 Reserve Crew, 3 Second
  Chance, 3 Repair Kit, 1 Stabiliser); score 116. Scripted run: 14 Parts, 3 Med, 1 Power, 1 Water, 10
  Health, 7 tokens; score 73. Library: 3 Parts, 2 Med, 4 Power, 2 Water, 10 Health, 3 tokens; score 43.

## Balancing decisions

- **One matrix per sector (ten faults).** 3 Parts, 1 Med, 1 Power, 0 Water, 3 × +5 Health, 2 tokens. The
  sum must be ten and every category a multiple of six city-wide, so the nearest totals to the current
  design are 18 Parts (+1), 6 Med (+1), 18 Health (−2), 12 tokens (+2) and six utility rewards.
- **Tokens in pairs.** Each sector holds one of Reserve Crew / Second Chance and one of Emergency Repair
  Kit / Stabiliser; three of each token in the city. The pairs follow the sector's own faults: Reserve Crew
  to TRN (F-207 injures two workers and needs three crew), MED and AGR (three-crew chains and P-10s);
  Repair Kit to the Parts-heavy POW, TRN and AGR; Stabiliser to the fast-decaying WTR (F-302 at 3.0/min),
  MED (cold chain 2.0–2.5/min) and COM; Second Chance to POW, WTR and COM. AGR keeps both of its current
  tokens; COM keeps its Round 0 Second Chance.
- **Power and Water, analysed separately.** Exact parity on Power (one per sector) is safe: one Power Cell
  per sector over a whole run, against an upkeep of two per round plus repairs, cannot make any sector
  self-sufficient, and POW's identity rests on being the only generator, which a single cell in its own tray
  does not touch. Exact parity on Water at one per sector is impossible inside ten slots without breaking
  a strict rule (it would need Health at two per sector, −8 city-wide); the parity that fits is zero per
  sector. That is the smallest change available under the parity rule: Power 5 → 6, Water 3 → 0, and the
  city's resource units stay at 30. The one alternative — one utility per sector, three Power and three
  Water, no sector ever earning what it generates — moves fewer units (−2) but breaks per-resource parity;
  it is not taken because parity was safe, and it stays available as a one-line change to six entries.
- **Timing.** One Parts reward in each band for every sector. No Health reward before Round 2: a sector
  starts at 100 and nothing in Round 0 decays, so +5 there is paid at the maximum. Every sector earns its Med
  and one token inside Rounds 0–4; the other token comes from its double reference chain. Med arrives when
  it can matter: TRN's in Round 2 (its F-207 injuries cost a Med each to recover), AGR's in Round 2 (its
  Round 3 fault needs one), WTR's in Round 1 (its Round 2 fault needs one).
- **Scripted path first.** The 36 scripted faults carry the same sub-matrix in every sector: 2 Parts, 1 Med,
  2 Health, 1 token (score 12–13). The 24 library faults carry 1 Parts, 1 Power, 1 Health, 1 token (7–8),
  on one rule the facilitator can hold in their head: a single reference chain (P-07) pays +1 Power, a double
  chain (P-08) pays the token, a P-09 pays +1 Parts, a TIME-CRITICAL P-10 pays +5 Health. So every sector's
  third Part comes from the late shift and its Power from a chain: identical timing for the scarce resource.
  The late shift's previous rule ("P-09 pays its first staged material", which gave only POW a Part) is
  superseded; P-10 is unchanged.
- **Comparable faults, comparable rewards.** Within every procedure (the same slot across six sectors) the
  reward values differ by at most one unit on the score, and the one-unit cases are the token class. The
  lowest-value reward (Power, 1) sits on the two-crew library faults, never on a three-crew one.
- **Different journeys.** No fault number carries the same reward in every sector except where the library
  rule says so; the scripted slots that pay Parts, Med and the token differ from sector to sector (see the
  timing table). 24 of the sixty entries are unchanged.

## PROPOSED REWARD BALANCE

| Sector | Power | Water | Parts | Med | +5 Health | Reserve Crew | Second Chance | Repair Kit | Stabiliser | Faults | Value (start) | Value (adj) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| POW | 1 | 0 | 3 | 1 | 3 | 0 | 1 | 1 | 0 | 10 | 20 | 19 |
| WTR | 1 | 0 | 3 | 1 | 3 | 0 | 1 | 0 | 1 | 10 | 20 | 18.5 |
| MED | 1 | 0 | 3 | 1 | 3 | 1 | 0 | 0 | 1 | 10 | 20 | 18.5 |
| TRN | 1 | 0 | 3 | 1 | 3 | 1 | 0 | 1 | 0 | 10 | 20 | 19 |
| AGR | 1 | 0 | 3 | 1 | 3 | 1 | 0 | 1 | 0 | 10 | 20 | 19 |
| COM | 1 | 0 | 3 | 1 | 3 | 0 | 1 | 0 | 1 | 10 | 20 | 18.5 |
| **City** | 6 | 0 | 18 | 6 | 18 | 3 | 3 | 3 | 3 | 60 | 120 | 112.5 |

| Sector | Power | Water | Parts | Med | +5 Health | Reserve Crew | Second Chance | Repair Kit | Stabiliser | Faults | Value (start) | Value (adj) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| POW | 0 | 0 | 2 | 1 | 2 | 0 | 0 | 1 | 0 | 6 | 13 | 12 |
| WTR | 0 | 0 | 2 | 1 | 2 | 0 | 0 | 0 | 1 | 6 | 13 | 11.5 |
| MED | 0 | 0 | 2 | 1 | 2 | 0 | 0 | 0 | 1 | 6 | 13 | 11.5 |
| TRN | 0 | 0 | 2 | 1 | 2 | 1 | 0 | 0 | 0 | 6 | 12 | 12 |
| AGR | 0 | 0 | 2 | 1 | 2 | 1 | 0 | 0 | 0 | 6 | 12 | 12 |
| COM | 0 | 0 | 2 | 1 | 2 | 0 | 1 | 0 | 0 | 6 | 12 | 12 |
| **City** | 0 | 0 | 12 | 6 | 12 | 2 | 1 | 1 | 2 | 36 | 75 | 71 |

| Sector | Power | Water | Parts | Med | +5 Health | Reserve Crew | Second Chance | Repair Kit | Stabiliser | Faults | Value (start) | Value (adj) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| POW | 1 | 0 | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 4 | 7 | 7 |
| WTR | 1 | 0 | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 4 | 7 | 7 |
| MED | 1 | 0 | 1 | 0 | 1 | 1 | 0 | 0 | 0 | 4 | 7 | 7 |
| TRN | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 1 | 0 | 4 | 8 | 7 |
| AGR | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 1 | 0 | 4 | 8 | 7 |
| COM | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 4 | 8 | 6.5 |
| **City** | 6 | 0 | 6 | 0 | 6 | 1 | 2 | 2 | 1 | 24 | 45 | 41.5 |

### Who gets what, when (proposed)

| Sector | early (R0, R1) | mid (R2, R2, R3 + chains) | late (R4 + late shift) |
|---|---|---|---|
| POW | F-001 Med, F-101 Parts | F-201 Parts, F-202 Repair Kit, F-301 +5 Health, F-501 Power, F-502 Second Chance | F-401 +5 Health, F-601 Parts, F-602 +5 Health |
| WTR | F-002 Parts, F-102 Med | F-203 +5 Health, F-204 Parts, F-302 +5 Health, F-503 Power, F-504 Second Chance | F-403 Stabiliser, F-603 Parts, F-604 +5 Health |
| MED | F-003 Med, F-103 Parts | F-205 Stabiliser, F-206 +5 Health, F-303 Parts, F-505 Power, F-506 Reserve Crew | F-402 +5 Health, F-605 Parts, F-606 +5 Health |
| TRN | F-004 Parts, F-104 Reserve Crew | F-207 Parts, F-208 Med, F-304 +5 Health, F-507 Power, F-508 Repair Kit | F-404 +5 Health, F-607 Parts, F-608 +5 Health |
| AGR | F-005 Parts, F-105 Reserve Crew | F-209 Parts, F-210 Med, F-305 +5 Health, F-509 Power, F-510 Repair Kit | F-405 +5 Health, F-609 Parts, F-610 +5 Health |
| COM | F-006 Second Chance, F-106 Parts | F-211 +5 Health, F-212 Parts, F-306 Med, F-511 Power, F-512 Stabiliser | F-406 +5 Health, F-611 Parts, F-612 +5 Health |

### City-wide totals, before and after

| Quantity | Before | After | Change |
|---|---|---|---|
| Spare Parts rewards | 17 | 18 | +1 |
| Med Supply rewards | 5 | 6 | +1 |
| Power rewards | 5 | 6 | +1 |
| Water rewards | 3 | 0 | −3 |
| Resource units in all | 30 | 30 | 0 |
| +5 Health rewards | 20 | 18 | −2 (−10 Health points) |
| Reserve Crew tokens | 3 | 3 | 0 |
| Second Chance tokens | 3 | 3 | 0 |
| Emergency Repair Kit tokens | 3 | 3 | 0 |
| Stabiliser tokens | 1 | 3 | +2 |
| Score (starting weights) | 116 | 120 | +4 |
| Score (adjusted weights) | 111.5 | 112.5 | +1 |

### Total reward value per sector

| Sector | Before (start / adj) | After (start / adj) | Scripted after (start / adj) | Library after (start / adj) |
|---|---|---|---|---|
| POW | 20 / 20 | 20 / 19 | 13 / 12 | 7 / 7 |
| WTR | 19 / 19 | 20 / 18.5 | 13 / 11.5 | 7 / 7 |
| MED | 18 / 18 | 20 / 18.5 | 13 / 11.5 | 7 / 7 |
| TRN | 19 / 19 | 20 / 19 | 12 / 12 | 8 / 7 |
| AGR | 18 / 17 | 20 / 19 | 12 / 12 | 8 / 7 |
| COM | 22 / 18.5 | 20 / 18.5 | 12 / 12 | 8 / 6.5 |

| Fault | Sector | Origin | Band | Sev | Crew | Materials | Cost | Reward (before) | Reward (after) |
|---|---|---|---|---|---|---|---|---|---|
| F-001 | POW | R0 scripted | early | 1 | 1 | parts 1 | 3 | Parts | Med |
| F-005 | AGR | R0 scripted | early | 1 | 1 | water 1 | 2 | +5 Health | Parts |
| F-102 | WTR | R1 scripted | early | 1 | 1 | power 1 | 2 | +5 Health | Med |
| F-103 | MED | R1 scripted | early | 1 | 1 | power 1 water 1 | 3 | Water | Parts |
| F-104 | TRN | R1 scripted | early | 1 | 1 | parts 1 | 3 | Parts | Reserve Crew |
| F-106 | COM | R1 scripted | early | 1 | 1 | power 1 | 2 | Repair Kit | Parts |
| F-202 | POW | R2 scripted | mid | 2 | 2 | parts 1 water 1 | 5 | Parts | Repair Kit |
| F-205 | MED | R2 scripted | mid | 2 | 2 | power 1 med 1 | 5 | Med | Stabiliser |
| F-208 | TRN | R2 scripted | mid | 2 | 2 | power 1 parts 1 | 5 | Parts | Med |
| F-209 | AGR | R2 scripted | mid | 2 | 2 | power 1 parts 1 | 5 | Power | Parts |
| F-210 | AGR | R2 scripted | mid | 2 | 2 | water 1 parts 1 | 5 | Repair Kit | Med |
| F-212 | COM | R2 scripted | mid | 2 | 2 | power 1 | 3 | Second Chance | Parts |
| F-301 | POW | R3 scripted | mid | 3 | 3 | parts 3 water 2 | 11 | Parts | +5 Health |
| F-303 | MED | R3 scripted | mid | 3 | 3 | power 2 med 1 | 7 | Med | Parts |
| F-304 | TRN | R3 scripted | mid | 3 | 2 | parts 2 power 1 | 7 | Parts | +5 Health |
| F-306 | COM | R3 scripted | mid | 3 | 3 | power 2 parts 1 | 7 | Stabiliser | Med |
| F-401 | POW | R4 scripted | late | 2 | 2 | power 2 parts 1 | 6 | Parts | +5 Health |
| F-403 | WTR | R4 scripted | late | 2 | 2 | parts 2 | 6 | +5 Health | Stabiliser |
| F-404 | TRN | R4 scripted | late | 2 | 2 | power 1 parts 1 | 5 | Parts | +5 Health |
| F-406 | COM | R4 scripted | late | 2 | 2 | power 2 parts 1 | 6 | Reserve Crew | +5 Health |
| F-501 | POW | chain (library, R3+) | mid | 2 | 2 | parts 1 water 1 | 5 | Parts | Power |
| F-502 | POW | chain (library, R3+) | mid | 3 | 3 | parts 2 water 1 | 8 | +5 Health | Second Chance |
| F-503 | WTR | chain (library, R3+) | mid | 2 | 2 | power 1 parts 1 | 5 | +5 Health | Power |
| F-505 | MED | chain (library, R3+) | mid | 2 | 2 | power 1 water 1 | 4 | Med | Power |
| F-506 | MED | chain (library, R3+) | mid | 3 | 3 | power 2 med 1 | 7 | Med | Reserve Crew |
| F-507 | TRN | chain (library, R3+) | mid | 2 | 2 | power 1 parts 1 | 5 | Parts | Power |
| F-508 | TRN | chain (library, R3+) | mid | 3 | 3 | parts 2 power 1 | 8 | Reserve Crew | Repair Kit |
| F-509 | AGR | chain (library, R3+) | mid | 2 | 2 | water 1 parts 1 | 5 | Water | Power |
| F-510 | AGR | chain (library, R3+) | mid | 3 | 3 | water 2 power 1 med 1 | 8 | +5 Health | Repair Kit |
| F-511 | COM | chain (library, R3+) | mid | 2 | 2 | power 1 parts 1 | 5 | +5 Health | Power |
| F-512 | COM | chain (library, R3+) | mid | 3 | 3 | power 2 parts 1 | 7 | Repair Kit | Stabiliser |
| F-603 | WTR | late shift (library, R4+) | late | 2 | 2 | power 1 med 1 | 5 | Power | Parts |
| F-605 | MED | late shift (library, R4+) | late | 2 | 2 | power 1 med 1 | 5 | Power | Parts |
| F-607 | TRN | late shift (library, R4+) | late | 2 | 2 | power 1 parts 1 | 5 | Power | Parts |
| F-609 | AGR | late shift (library, R4+) | late | 2 | 2 | water 1 parts 1 | 5 | Water | Parts |
| F-611 | COM | late shift (library, R4+) | late | 2 | 2 | power 1 parts 1 | 5 | Power | Parts |

## What changed where

- `lib/fault-rewards.json` — version 2.1: 36 entries re-pointed, a `balance` block that states the matrix,
  the note and source updated. Every entry keeps the v2 shape, so the engine, the console (REPAIR REWARD on
  the card, TACTICAL OPPORTUNITIES), the control panel's library preview and the Session Review read it
  unchanged.
- `test/reward-balance.test.js` — RB-001…RB-009: every fault rewarded; the per-sector matrix; the token
  pairs and city counts; the approved city total and equal per-sector value; the scripted and library
  sub-matrices within tolerance; the timing rules; comparable rewards within a procedure and the library
  rule; every fault fires on the console carrying its reward text and the screen knows every token; the
  documents carry the engine's token definitions and no per-fault reward.
- `test/engine.test.js` — the table totals; the capped-Integrity test moves from F-102 (now Med) to F-203;
  the Emergency Repair Kit test moves from COM/F-106 to AGR/F-510; the Stabiliser test takes COM's token
  from F-512. `test/late-shift.test.js` — the P-09 rule.
- `README.md`, `docs/undercity-message-contract.md` — the counts and the matrix.
- **Documents are not regenerated.** No kit generator reads the reward table and no binder, fault card,
  answer key or guidebook page names a fault's reward: the console is the only place a reward is shown, and
  the binders print the token definitions straight from `lib/rewards.js`. RB-009 holds that line, so the
  colour kit and the B&W Kit stay byte-for-byte what they were.

## For the owner

- **Water is no longer a repair reward anywhere.** Parity inside ten slots forced the choice between zero
  Water rewards (taken: −3 units) and zero Power rewards (−5). If a Water reward should exist, the one-line
  alternative is three Power → Water swaps on the library resource slots (POW, AGR and one more sector),
  which keeps one utility per sector but gives up per-resource parity.
- **The late-shift rule changed.** P-09 no longer pays "its first staged material" (which gave only POW a
  Part); every P-09 pays +1 Parts and every single reference chain (P-07) pays +1 Power. P-10 still pays
  +5 Health; a double chain (P-08) now always pays the token.
- **Only the entries moved.** No reward type, amount, token or mechanic changed; the city's resource units
  are unchanged at 30; Health rewards fell by two (ten points) and Stabilisers rose by two.

| Fault | Sector | Origin | Band | Sev | Crew | Materials | Cost | Reward (before) | Reward (after) |
|---|---|---|---|---|---|---|---|---|---|
| F-001 | POW | R0 scripted | early | 1 | 1 | parts 1 | 3 | Parts | Med |
| F-002 | WTR | R0 scripted | early | 1 | 1 | parts 1 | 3 | Parts | unchanged |
| F-003 | MED | R0 scripted | early | 1 | 1 | med 1 | 3 | Med | unchanged |
| F-004 | TRN | R0 scripted | early | 1 | 1 | parts 1 | 3 | Parts | unchanged |
| F-005 | AGR | R0 scripted | early | 1 | 1 | water 1 | 2 | +5 Health | Parts |
| F-006 | COM | R0 scripted | early | 1 | 1 | power 1 | 2 | Second Chance | unchanged |
| F-101 | POW | R1 scripted | early | 1 | 1 | parts 1 water 1 | 4 | Parts | unchanged |
| F-102 | WTR | R1 scripted | early | 1 | 1 | power 1 | 2 | +5 Health | Med |
| F-103 | MED | R1 scripted | early | 1 | 1 | power 1 water 1 | 3 | Water | Parts |
| F-104 | TRN | R1 scripted | early | 1 | 1 | parts 1 | 3 | Parts | Reserve Crew |
| F-105 | AGR | R1 scripted | early | 1 | 1 | water 1 | 2 | Reserve Crew | unchanged |
| F-106 | COM | R1 scripted | early | 1 | 1 | power 1 | 2 | Repair Kit | Parts |
| F-201 | POW | R2 scripted | mid | 2 | 2 | parts 2 water 1 | 7 | Parts | unchanged |
| F-202 | POW | R2 scripted | mid | 2 | 2 | parts 1 water 1 | 5 | Parts | Repair Kit |
| F-203 | WTR | R2 scripted | mid | 2 | 2 | power 1 med 1 | 5 | +5 Health | unchanged |
| F-204 | WTR | R2 scripted | mid | 2 | 2 | parts 2 | 6 | Parts | unchanged |
| F-205 | MED | R2 scripted | mid | 2 | 2 | power 1 med 1 | 5 | Med | Stabiliser |
| F-206 | MED | R2 scripted | mid | 2 | 2 | power 1 parts 1 | 5 | +5 Health | unchanged |
| F-207 | TRN | R2 scripted | mid | 2 | 3 | parts 2 water 1 | 8 | Parts | unchanged |
| F-208 | TRN | R2 scripted | mid | 2 | 2 | power 1 parts 1 | 5 | Parts | Med |
| F-209 | AGR | R2 scripted | mid | 2 | 2 | power 1 parts 1 | 5 | Power | Parts |
| F-210 | AGR | R2 scripted | mid | 2 | 2 | water 1 parts 1 | 5 | Repair Kit | Med |
| F-211 | COM | R2 scripted | mid | 2 | 2 | power 1 parts 1 | 5 | +5 Health | unchanged |
| F-212 | COM | R2 scripted | mid | 2 | 2 | power 1 | 3 | Second Chance | Parts |
| F-301 | POW | R3 scripted | mid | 3 | 3 | parts 3 water 2 | 11 | Parts | +5 Health |
| F-302 | WTR | R3 scripted | mid | 3 | 3 | parts 2 power 1 | 8 | +5 Health | unchanged |
| F-303 | MED | R3 scripted | mid | 3 | 3 | power 2 med 1 | 7 | Med | Parts |
| F-304 | TRN | R3 scripted | mid | 3 | 2 | parts 2 power 1 | 7 | Parts | +5 Health |
| F-305 | AGR | R3 scripted | mid | 3 | 2 | water 2 med 1 | 6 | +5 Health | unchanged |
| F-306 | COM | R3 scripted | mid | 3 | 3 | power 2 parts 1 | 7 | Stabiliser | Med |
| F-401 | POW | R4 scripted | late | 2 | 2 | power 2 parts 1 | 6 | Parts | +5 Health |
| F-402 | MED | R4 scripted | late | 2 | 2 | power 1 med 2 | 7 | +5 Health | unchanged |
| F-403 | WTR | R4 scripted | late | 2 | 2 | parts 2 | 6 | +5 Health | Stabiliser |
| F-404 | TRN | R4 scripted | late | 2 | 2 | power 1 parts 1 | 5 | Parts | +5 Health |
| F-405 | AGR | R4 scripted | late | 2 | 2 | water 2 parts 1 | 6 | +5 Health | unchanged |
| F-406 | COM | R4 scripted | late | 2 | 2 | power 2 parts 1 | 6 | Reserve Crew | +5 Health |
| F-501 | POW | chain (library, R3+) | mid | 2 | 2 | parts 1 water 1 | 5 | Parts | Power |
| F-502 | POW | chain (library, R3+) | mid | 3 | 3 | parts 2 water 1 | 8 | +5 Health | Second Chance |
| F-503 | WTR | chain (library, R3+) | mid | 2 | 2 | power 1 parts 1 | 5 | +5 Health | Power |
| F-504 | WTR | chain (library, R3+) | mid | 3 | 3 | power 1 med 1 parts 1 | 8 | Second Chance | unchanged |
| F-505 | MED | chain (library, R3+) | mid | 2 | 2 | power 1 water 1 | 4 | Med | Power |
| F-506 | MED | chain (library, R3+) | mid | 3 | 3 | power 2 med 1 | 7 | Med | Reserve Crew |
| F-507 | TRN | chain (library, R3+) | mid | 2 | 2 | power 1 parts 1 | 5 | Parts | Power |
| F-508 | TRN | chain (library, R3+) | mid | 3 | 3 | parts 2 power 1 | 8 | Reserve Crew | Repair Kit |
| F-509 | AGR | chain (library, R3+) | mid | 2 | 2 | water 1 parts 1 | 5 | Water | Power |
| F-510 | AGR | chain (library, R3+) | mid | 3 | 3 | water 2 power 1 med 1 | 8 | +5 Health | Repair Kit |
| F-511 | COM | chain (library, R3+) | mid | 2 | 2 | power 1 parts 1 | 5 | +5 Health | Power |
| F-512 | COM | chain (library, R3+) | mid | 3 | 3 | power 2 parts 1 | 7 | Repair Kit | Stabiliser |
| F-601 | POW | late shift (library, R4+) | late | 2 | 2 | parts 1 water 1 | 5 | Parts | unchanged |
| F-602 | POW | late shift (library, R4+) | late | 3 | 3 | parts 2 water 1 | 8 | +5 Health | unchanged |
| F-603 | WTR | late shift (library, R4+) | late | 2 | 2 | power 1 med 1 | 5 | Power | Parts |
| F-604 | WTR | late shift (library, R4+) | late | 3 | 3 | parts 2 power 1 | 8 | +5 Health | unchanged |
| F-605 | MED | late shift (library, R4+) | late | 2 | 2 | power 1 med 1 | 5 | Power | Parts |
| F-606 | MED | late shift (library, R4+) | late | 3 | 3 | power 2 parts 1 | 7 | +5 Health | unchanged |
| F-607 | TRN | late shift (library, R4+) | late | 2 | 2 | power 1 parts 1 | 5 | Power | Parts |
| F-608 | TRN | late shift (library, R4+) | late | 3 | 3 | parts 2 power 1 | 8 | +5 Health | unchanged |
| F-609 | AGR | late shift (library, R4+) | late | 2 | 2 | water 1 parts 1 | 5 | Water | Parts |
| F-610 | AGR | late shift (library, R4+) | late | 3 | 3 | water 2 power 1 med 1 | 8 | +5 Health | unchanged |
| F-611 | COM | late shift (library, R4+) | late | 2 | 2 | power 1 parts 1 | 5 | Power | Parts |
| F-612 | COM | late shift (library, R4+) | late | 3 | 3 | power 2 parts 2 | 9 | +5 Health | unchanged |
