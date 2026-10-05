#!/usr/bin/env python3
"""
UNDERCITY — is the B&W Kit really black and white, and really the same kit?

Exports every document in the B&W Kit and its colour original to PDF with
Word, then for each pair:

  * scans every page for coloured pixels (a pixel is coloured when its RGB
    channels differ by more than a small anti-aliasing tolerance) — there must
    be none;
  * compares the page count with the colour original;
  * compares the text of every page with the colour original, whitespace
    collapsed — the conversion may change no word, value or code.

    python tools/kit/check_mono.py ["B&W Kit"] [kit]

Build-machine check: needs Word and `pip install pymupdf pillow`.
"""
import re
import subprocess
import sys
from pathlib import Path

try:
    import pymupdf
except ImportError:  # pragma: no cover
    sys.exit("check_mono: pip install pymupdf")

ROOT = Path(__file__).resolve().parents[2]
BW = ROOT / (sys.argv[1] if len(sys.argv) > 1 else "B&W Kit")
KIT = ROOT / (sys.argv[2] if len(sys.argv) > 2 else "kit")
PDF_BW = ROOT / "build" / "pdf-bw"
PDF_COLOUR = ROOT / "build" / "pdf-colour"
TOLERANCE = 24          # channel spread above which a pixel counts as coloured
ZOOM = 1.4

EXPORT_PS = r"""
$ErrorActionPreference = "Stop"
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
%s
} finally { $word.Quit() }
"""
EXPORT_ONE = r"""  $doc = $word.Documents.Open('%s', $false, $true)
  try { $doc.ExportAsFixedFormat('%s', 17) } finally { $doc.Close($false) }"""


def export(pairs):
    """pairs: [(docx path, pdf path)] — every PDF removed first, so a stale one cannot pass."""
    for _, pdf in pairs:
        pdf.parent.mkdir(parents=True, exist_ok=True)
        if pdf.exists():
            pdf.unlink()
    body = "\n".join(EXPORT_ONE % (str(d).replace("'", "''"), str(p).replace("'", "''")) for d, p in pairs)
    r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", EXPORT_PS % body],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"check_mono: Word export failed\n{r.stderr}")
    missing = [p for _, p in pairs if not p.exists()]
    if missing:
        sys.exit("check_mono: Word produced no PDF for " + ", ".join(m.name for m in missing))


def coloured_pixels(page):
    pix = page.get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM))
    data = pix.samples
    n = pix.width * pix.height
    stride = pix.n
    count = 0
    for i in range(0, n * stride, stride):
        r, g, b = data[i], data[i + 1], data[i + 2]
        if max(r, g, b) - min(r, g, b) > TOLERANCE:
            count += 1
    return count


def text_of(doc):
    return [re.sub(r"\s+", " ", page.get_text()).strip() for page in doc]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    bw_files = sorted(BW.glob("UNDERCITY_*_BW.docx"))
    if not bw_files:
        sys.exit(f"check_mono: nothing to check in {BW}")
    pairs = []
    for bw in bw_files:
        base = bw.name.replace("_BW.docx", ".docx")
        colour = KIT / base
        if not colour.exists():
            sys.exit(f"check_mono: {bw.name} has no colour original {colour}")
        pairs.append((bw, PDF_BW / bw.name.replace(".docx", ".pdf")))
        pairs.append((colour, PDF_COLOUR / base.replace(".docx", ".pdf")))
    export(pairs)
    bad = 0
    for bw in bw_files:
        base = bw.name.replace("_BW.docx", ".docx")
        bdoc = pymupdf.open(PDF_BW / bw.name.replace(".docx", ".pdf"))
        cdoc = pymupdf.open(PDF_COLOUR / base.replace(".docx", ".pdf"))
        problems = []
        worst = max(((coloured_pixels(p), i + 1) for i, p in enumerate(bdoc)), default=(0, 0))
        if worst[0] > 0:
            problems.append(f"coloured pixels: {worst[0]} on page {worst[1]}")
        if len(bdoc) != len(cdoc):
            problems.append(f"pages: {len(bdoc)} vs colour {len(cdoc)}")
        bt, ct = text_of(bdoc), text_of(cdoc)
        for i, (x, y) in enumerate(zip(bt, ct), 1):
            if x != y:
                # the first differing fragment, for the report
                j = next((k for k in range(min(len(x), len(y))) if x[k] != y[k]), min(len(x), len(y)))
                problems.append(f"text differs on page {i} near: …{x[max(0, j - 30):j + 40]}… vs …{y[max(0, j - 30):j + 40]}…")
                break
        bad += bool(problems)
        status = "OK " if not problems else "BAD"
        print(f"{status} {bw.name:46s} {len(bdoc):3d} pages" + ("" if not problems else "  <-- " + "; ".join(problems)))
    if bad:
        sys.exit(f"MONO CHECK FAILED: {bad} document(s)")
    print("MONO CHECK OK: every B&W document is monochrome, the same length and the same words as its colour original")


if __name__ == "__main__":
    main()
