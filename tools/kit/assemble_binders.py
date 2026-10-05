#!/usr/bin/env python3
r"""
UNDERCITY — binder content assembler.

Reads undercity-crossref-matrix.xlsx (source of truth) and emits
binder_content.json, which build_binders.js renders into six DOCX binders.

Pipeline: matrix -> recalc -> export_faults.py (server JSON)
                           \-> assemble_binders.py -> build_binders.js (paper)

Both branches read the SAME cells, so paper and server cannot disagree.

The sector's self-guided operating manual (sections 1-11 of every binder)
is NOT assembled here: tools/kit/binder_manual.js builds it from the scenario
config, the engine's own modules and roles.json, and build_binders.js renders
it in front of the reference pages this file produces. This file supplies the
reference half: the fault index, the procedures, the specification tables, the
reference directory and Appendix C, plus each sector's identity.

CRITICAL CONTENT RULES ENFORCED HERE:
  1. A binder NEVER prints a full resolution code. It prints the procedure ref,
     the resource/crew cost, and WHERE to fetch each spec value. The team
     assembles the code by talking to other sectors — that assembly IS the game.
  2. A binder NEVER prints another sector's spec values. Only its own tables.
  3. WTR Table W-4 row 3 prints 340. The big screen shows 290. Do not reconcile.
  4. Appendix C gets NO index entry. It is findable only by reading the binder.
"""
import json
import re
import sys
from pathlib import Path

from openpyxl import load_workbook

# Both the progress lines and the content carry glyphs a cp1252 console
# cannot encode. Say UTF-8 rather than inherit whatever the machine has.
sys.stdout.reconfigure(encoding="utf-8")

XLSX = Path(sys.argv[1] if len(sys.argv) > 1 else "undercity-crossref-matrix.xlsx")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "binder_content.json")

SECTOR_INFO = {
    "POW": {
        "name": "Power Grid",
        "colour": "E8B33A",
        "motto": "The city runs on what we hold.",
    },
    "WTR": {
        "name": "Water & Filtration",
        "colour": "3A8FE8",
        "motto": "Nothing here is wasted twice.",
    },
    "MED": {
        "name": "Medical Bay",
        "colour": "E85A5A",
        "motto": "We count in people, not units.",
    },
    "TRN": {
        "name": "Transport & Tunnels",
        "colour": "9A9A9A",
        "motto": "Everything moves through us.",
    },
    "AGR": {
        "name": "Agriculture",
        "colour": "5AB86A",
        "motto": "Slow problems kill slowly.",
    },
    "COM": {
        "name": "Comms & Sensors",
        "colour": "B07AD8",
        "motto": "We see it first. What we do next is the question.",
    },
}

# Opening stock and upkeep are no longer written here: binder_manual.js reads
# them from the scenario the kit is built for, so paper cannot drift from play.

wb = load_workbook(XLSX, data_only=True)

# ---- specs ------------------------------------------------------------------
specs = {}
for row in wb["SpecTables"].iter_rows(min_row=2, values_only=True):
    if not row[0]:
        continue
    specs[row[0]] = {"id": row[0], "binder": row[1], "table_id": row[2],
                     "table_name": row[3], "row_label": row[4], "value": row[5],
                     "buried": row[2] == "App-C"}
if specs["W4-3"]["value"] != 340:
    sys.exit("ABORT: discrepancy seed W4-3 is not 340 — check the workbook.")

# ---- faults -----------------------------------------------------------------
faults = []
for row in wb["Faults"].iter_rows(min_row=2, values_only=True):
    if not row[0]:
        continue
    faults.append({
        "code": row[0], "round": row[1], "sector": row[2], "name": row[3],
        "flavour": row[4], "severity": row[5], "crew": row[7],
        "resources": row[8], "procedure": row[10 - 1],
        "spec1": row[10], "spec2": row[12],
        "deadline": row[15] if row[15] not in ("—", None) else None,
        "notes": row[16] or "",
    })

# ---- reference-chain faults (generated, not from the workbook) --------------
# F-501..F-512 live in content/faults.reference-chain.json because their
# resolution codes are resolved from content/specs.json rather than from an
# Excel formula. The binder needs them in the index, in the procedures and —
# for the sectors that hold one — in subsection 5A. Optional: a checkout that
# has not run the generator simply builds the thirty-six-fault binders.
CHAIN_PATH = Path(__file__).resolve().parents[2] / "content" / "faults.reference-chain.json"
chain = json.loads(CHAIN_PATH.read_text(encoding="utf-8")) if CHAIN_PATH.exists() else {
    "faults": [], "reference_directory": {}}
chain_by_sector = {}
for f in chain["faults"]:
    chain_by_sector.setdefault(f["sector"], []).append(f)

# ---- late-shift faults (generated, not from the workbook) -------------------
# F-601..F-612 live in content/faults.late-shift.json: P-09 and P-10, two
# values from two indexed tables, resolved from content/specs.json by
# tools/build_late_shift_faults.js. They print like any workbook procedure.
LATE_PATH = Path(__file__).resolve().parents[2] / "content" / "faults.late-shift.json"
late = json.loads(LATE_PATH.read_text(encoding="utf-8")) if LATE_PATH.exists() else {"faults": []}
late_by_sector = {}
for f in late["faults"]:
    late_by_sector.setdefault(f["sector"], []).append(f)

# ---- escalate entries (parsed from CrossrefMap) -----------------------------
escalate = {}
for row in wb["CrossrefMap"].iter_rows(min_row=1, values_only=True):
    if row[0] and isinstance(row[0], str) and row[0].endswith("binder index also lists:"):
        binder = row[0].split()[0]
        entries = []
        for part in (row[1] or "").split("·"):
            m = re.search(r"(F-\d+)\s*→\s*escalate to\s*([A-Z]{3})", part)
            if m:
                entries.append({"code": m.group(1), "owner": m.group(2)})
        escalate[binder] = entries

# ---- assemble ---------------------------------------------------------------
binders = {}
for code, info in SECTOR_INFO.items():
    own = [f for f in faults if f["sector"] == code]

    index_rows = []
    for f in sorted(own, key=lambda x: x["code"]):
        if f["procedure"] in (None, "—"):
            sys.exit(f"{f['code']}: no procedure — the deck carries no false alarm, so this is a matrix error")
        index_rows.append({
            "code": f["code"], "name": f["name"],
            "action": f"Procedure {f['procedure']}", "own": True, "no_procedure": False,
        })
    for f in sorted(chain_by_sector.get(code, []), key=lambda x: x["code"]):
        index_rows.append({
            "code": f["code"], "name": f["name"],
            "action": f"Procedure {f['procedure']}", "own": True, "no_procedure": False,
        })
    for f in sorted(late_by_sector.get(code, []), key=lambda x: x["code"]):
        index_rows.append({
            "code": f["code"], "name": f["name"],
            "action": f"Procedure {f['procedure']}" + (" · TIME-CRITICAL" if f.get("time_critical") else ""),
            "own": True, "no_procedure": False,
        })
    for e in escalate.get(code, []):
        index_rows.append({
            "code": e["code"], "name": ("Not an " if code[0] in "AEIOU" else "Not a ") + code + " system fault",
            "action": f"ESCALATE TO {e['owner']}", "own": False, "no_procedure": False,
        })

    procedures = []
    for f in sorted([x for x in own if x["procedure"] not in (None, "—")],
                    key=lambda x: x["procedure"]):
        sources, nparts = [], 0
        for sid in (f["spec1"], f["spec2"]):
            if sid and sid in specs:
                nparts += 1
                s = specs[sid]
                sources.append({"row_label": s["row_label"],
                                "binder": s["binder"], "table_id": s["table_id"],
                                "foreign": s["binder"] != code, "buried": s["buried"]})
        fmt = f["procedure"] + "-[VALUE]" + ("-[VALUE 2]" if nparts == 2 else "")
        procedures.append({
            "id": f["procedure"], "fault_code": f["code"], "title": f["name"],
            "resources": f["resources"], "crew": f["crew"],
            "deadline": f["deadline"], "format": fmt,
            "sources": sources,
            "severity": f["severity"], "time_critical": False,
        })

    # P-07 and P-08. The requesting binder is told ONE thing per chain: which
    # sector to ask, and the name of the row to ask for. It is never told what
    # that row says, and never told where the row will send them next — that
    # is the mechanic, and writing it down here would be giving it away.
    # A procedure is a data row (binder page 7 or 8); the universal repair
    # flow is printed once, on page 4, never repeated per fault.
    for f in sorted(chain_by_sector.get(code, []), key=lambda x: x["code"]):
        n = len(f["reference_chain"])
        fmt = f["procedure"] + "-[VALUE]" + ("-[VALUE 2]" if n == 2 else "")
        mats = ", ".join(f"{v} {k.title()}" for k, v in f["resources_required"].items())
        procedures.append({
            "id": f["procedure"], "fault_code": f["code"], "title": f["name"],
            "resources": mats, "crew": f["crew_required"],
            "deadline": None, "format": fmt,
            # No `sources` block: a chain procedure has no table to send the
            # operator to. The renderer keys off `reference_chain` instead.
            "sources": [],
            "reference_chain": [{"first_sector": c["first_sector"],
                                 "first_reference_name": c["first_reference_name"]}
                                for c in f["reference_chain"]],
            "severity": f["severity"], "time_critical": False,
        })

    # P-09 and P-10 (LATE SHIFT, 2026-10-05): two indexed sources, a row like
    # any other. A P-10 is TIME-CRITICAL: the card says so — nothing counts
    # down, Health simply falls faster while the fault stays open.
    for f in sorted(late_by_sector.get(code, []), key=lambda x: x["code"]):
        sources = []
        for r in f["spec_refs"]:
            s = specs[r["spec_id"]]
            sources.append({"row_label": s["row_label"],
                            "binder": s["binder"], "table_id": s["table_id"],
                            "foreign": s["binder"] != code, "buried": False})
        fmt = f["procedure"] + "-[VALUE]-[VALUE 2]"
        mats = ", ".join(f"{v} {k.title()}" for k, v in f["resources_required"].items())
        procedures.append({
            "id": f["procedure"], "fault_code": f["code"],
            "title": f["name"],
            "resources": mats, "crew": f["crew_required"],
            "deadline": None, "format": fmt,
            "sources": sources, "severity": f["severity"],
            "time_critical": bool(f.get("time_critical")),
        })

    tables = {}
    for s in specs.values():
        if s["binder"] != code or s["buried"]:
            continue
        tables.setdefault(s["table_id"], {"id": s["table_id"], "name": s["table_name"], "rows": []})
        tables[s["table_id"]]["rows"].append({"label": s["row_label"], "value": s["value"]})

    appendix = next(s for s in specs.values() if s["binder"] == code and s["buried"])

    binders[code] = {
        "code": code, "name": info["name"], "colour": info["colour"],
        "motto": info["motto"],
        "index_rows": index_rows,
        "procedures": procedures,
        "tables": sorted(tables.values(), key=lambda t: t["id"]),
        # 5A · Cross-System Reference Directory. Rows that point somewhere
        # instead of answering. They carry no number, which is why the leak
        # check below still passes: a binder may name another sector's asset,
        # it may never print another sector's value.
        "references": [{"name": r["reference_name"], "display": r["display"]}
                       for r in chain["reference_directory"].get(code, [])],
        "appendix": {"row_label": appendix["row_label"], "value": appendix["value"]},
    }

# ---- leak check: no binder may print another binder's values -----------------
for code, b in binders.items():
    printed = {r["value"] for t in b["tables"] for r in t["rows"]} | {b["appendix"]["value"]}
    for sid, s in specs.items():
        if s["binder"] != code and s["value"] in printed:
            sys.exit(f"ABORT: {code} binder prints {s['value']}, which belongs to {s['binder']} ({sid})")

# UTF-8 and LF whatever the machine: the sector lines carry glyphs cp1252
# cannot encode, and a CRLF copy fingerprints differently from the LF one.
OUT.parent.mkdir(parents=True, exist_ok=True)
with OUT.open("w", encoding="utf-8", newline="\n") as fh:
    fh.write(json.dumps({"binders": binders}, indent=2, ensure_ascii=False))
print(f"✓ {OUT}")
for c, b in binders.items():
    print(f"  {c}: {len(b['index_rows'])} index rows "
          f"({sum(1 for r in b['index_rows'] if not r['own'])} escalate), "
          f"{len(b['procedures'])} procedures, {len(b['tables'])} tables, "
          f"appendix '{b['appendix']['row_label']}' = {b['appendix']['value']}")
print("✓ leak check passed — no binder prints another sector's spec values")
