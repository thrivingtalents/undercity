#!/usr/bin/env python3
"""
UNDERCITY — does each binder section start on the page its cover promises?

build_binders.js lays every section out for a declared number of pages and
prints the resulting page numbers on the cover (build/binder_pages.json). Only
a layout engine can say whether a section really fits, so this exports each
binder to PDF with Word (COM, hidden) and reads the PDF back with PyMuPDF: a
section title is the only text set at 15 pt, so the page it is found on is the
page the section starts on. Any drift fails the run.

    python tools/kit/check_binder_pages.py [kit] [build/binder_pages.json]

Build-machine check, not a kit dependency: needs Word and `pip install pymupdf`.
The PDFs are written beside the binders as build/pdf/UNDERCITY_Binder_<CODE>.pdf
and are useful in their own right (print-ready, every page as it will print).
"""
import json
import subprocess
import sys
from pathlib import Path

try:
    import pymupdf
except ImportError:  # pragma: no cover
    sys.exit("check_binder_pages: pip install pymupdf")

ROOT = Path(__file__).resolve().parents[2]
KIT = ROOT / (sys.argv[1] if len(sys.argv) > 1 else "kit")
PLAN = ROOT / (sys.argv[2] if len(sys.argv) > 2 else "build/binder_pages.json")
PDF_DIR = ROOT / "build" / "pdf"
SECTORS = ["POW", "WTR", "MED", "TRN", "AGR", "COM"]
TITLE_PT = 15  # the section head's title size, and nothing else's

EXPORT_PS = r"""
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
  foreach ($code in @(%s)) {
    $doc = $word.Documents.Open("%s\UNDERCITY_Binder_$code.docx", $false, $true)
    try { $doc.ExportAsFixedFormat("%s\UNDERCITY_Binder_$code.pdf", 17) } finally { $doc.Close($false) }
  }
} finally { $word.Quit() }
"""


def export_pdfs():
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    script = EXPORT_PS % (", ".join(f'"{c}"' for c in SECTORS), str(KIT), str(PDF_DIR))
    r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"check_binder_pages: Word export failed\n{r.stderr}")


def title_pages(pdf):
    """{title text: first page it appears on at TITLE_PT}"""
    found = {}
    for i, page in enumerate(pymupdf.open(pdf), 1):
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                text = "".join(s["text"] for s in line["spans"] if abs(s["size"] - TITLE_PT) < 0.6).strip()
                if text:
                    found.setdefault(text, i)
    return found


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    plans = json.loads(PLAN.read_text(encoding="utf-8"))
    export_pdfs()
    bad = 0
    for code in SECTORS:
        pdf = PDF_DIR / f"UNDERCITY_Binder_{code}.pdf"
        found = title_pages(pdf)
        total = len(pymupdf.open(pdf))
        plan = plans[code]
        expected_total = plan[-1]["page"]
        flag = "" if total == expected_total else "  <-- TOTAL DRIFT"
        bad += bool(flag)
        print(f"{code}: {total} pages (planned {expected_total}){flag}")
        for entry in plan:
            title = entry["title"]
            # a wrapped title is split over lines; the first line is enough to identify it
            key = next((k for k in found if title.startswith(k[:20]) or k.startswith(title[:20])), None)
            page = found.get(key)
            if entry["id"] == "quick-back":
                page = total if key else None   # the back page carries the same title as page 2
            if page is None:
                bad += 1
                print(f"   §{entry['num']} {title}: NOT FOUND")
                continue
            mark = "" if page == entry["page"] else f"  <-- DRIFT (planned {entry['page']})"
            bad += bool(mark)
            print(f"   p.{page:>2}  §{str(entry['num'] or ''):<3} {title}{mark}")
    if bad:
        sys.exit(f"PAGE CHECK FAILED: {bad} problem(s)")
    print("PAGE CHECK OK: every section starts where the cover says")


if __name__ == "__main__":
    main()
