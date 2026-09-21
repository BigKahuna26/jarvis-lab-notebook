#!/usr/bin/env python3
"""
Does the table in document-standards.md still describe the reference documents?

WHY THIS EXISTS. That protocol quotes a table of measurements and says "these
are the figures `doc_compliance.py` prints, so the standard and its checker
cannot drift." They cannot drift only if something compares them. The reference
documents are live drafts TC is still editing, so the quoted numbers have a
half-life measured in edits, and a number that was true once and is quoted
forever is indistinguishable from one that was never checked.

IT MEASURES NOTHING ITSELF, DELIBERATELY. The first version of this script
recomputed the em-dash rate and median paragraph length with its own definition
of "body paragraph". That was the same defect the protocol exists to prevent:
two definitions of one measurement, drifting apart, each looking authoritative.
Measurement belongs to `doc_compliance.py`; this reads its JSON and compares it
to what the protocol claims.

    python3 _document_standards_check.py
"""
from __future__ import annotations   # macOS still ships 3.9 as /usr/bin/python3
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
VAULT = HERE.parents[1]
PROTOCOL = VAULT / "protocols/document-standards.md"
COMPLIANCE = HERE / "doc_compliance.py"

# Quoted figures are rounded and the drafts move by a word or two between
# edits; these tolerances are loose enough not to fire on that and tight enough
# to catch a document that has actually been rewritten.
TOL_MEDIAN = 20      # words
TOL_RATE = 0.5       # em dashes per 1,000 words
TOL_WORDS = 0.05     # 5% of the document


def references(text: str) -> list[str]:
    """The reference files, read out of the protocol so the check follows the
    document rather than carrying its own copy of which files matter."""
    block = text.split("reference implementation", 1)[-1][:600]
    return [m for m in re.findall(r'`([^`]*\.md)`', block)
            if not m.startswith('<') and 'protocols/' not in m]


def table(text: str) -> dict:
    """The quoted measurements. Row labels are matched loosely because the
    protocol is prose, not a data file - but a row that disappears entirely is
    reported rather than skipped, since that is the document moving."""
    want = {"words": r"\|\s*words\s*\|",
            "median": r"\|\s*median body paragraph\s*\|",
            "rate": r"\|\s*em dashes per 1,000 words\s*\|"}
    out = {}
    for key, pat in want.items():
        m = re.search(pat + r"([^|]*)\|([^|]*)\|", text)
        if not m:
            continue
        nums = []
        for cell in (m.group(1), m.group(2)):
            n = re.search(r"([\d.,]+)", cell.replace("**", ""))
            nums.append(float(n.group(1).replace(",", "")) if n else None)
        out[key] = nums
    return out


def measure(path: Path) -> dict | None:
    r = subprocess.run([sys.executable, str(COMPLIANCE), str(path), "--json"],
                       cwd=str(VAULT), capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        print(f"  doc_compliance.py could not read {path.name}: "
              f"{(r.stderr or r.stdout)[:160]}")
        return None


def num(detail: str) -> float | None:
    m = re.search(r"([\d.]+)", detail or "")
    return float(m.group(1)) if m else None


def main() -> int:
    if not PROTOCOL.exists() or not COMPLIANCE.exists():
        print("document standards: protocol or doc_compliance.py is missing")
        return 1

    text = PROTOCOL.read_text()
    refs, quoted = references(text), table(text)
    if not refs:
        print("document standards: no reference documents named in the protocol")
        return 1
    if len(quoted) < 3:
        print(f"document standards: the measurement table moved — read "
              f"{sorted(quoted)} of words/median/rate")
        print("  Re-point this check at the new table rather than deleting it.")
        return 1

    found = []
    for name in refs:
        hits = [p for p in VAULT.rglob(Path(name).name) if ".git" not in p.parts]
        (found.append(hits[0]) if hits else
         print(f"document standards: reference not in the vault — {name}"))
    if len(found) != len(refs):
        print("  Commit the references to turn this into a real check.")
        return 0                      # cannot run is not the same as failed

    findings = []
    for i, path in enumerate(found):
        d = measure(path)
        if d is None:
            return 1
        rate = num(d["rules"].get("D4 em dash rate", {}).get("detail", ""))
        median = num(d["rules"].get("D5 paragraph length", {}).get("detail", ""))
        print(f"  {path.name}: {d['words']:,} words, median {median:.0f}, "
              f"{rate} em dashes/1,000")

        for key, got, tol in (("words", d["words"], None),
                              ("median", median, TOL_MEDIAN),
                              ("rate", rate, TOL_RATE)):
            claim = quoted.get(key, [None, None])[i]
            if claim is None or got is None:
                continue
            limit = claim * TOL_WORDS if tol is None else tol
            if abs(got - claim) > limit:
                findings.append(f"{path.name}: {key} is {got:g}, the protocol quotes {claim:g}")

    if findings:
        print("\n  RE-MEASURE:")
        for f in findings:
            print(f"    {f}")
        print("  The reference documents moved. Update the table in "
              "protocols/document-standards.md to what doc_compliance.py now prints.")
        return 1
    print("document standards: the quoted table still matches doc_compliance.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
