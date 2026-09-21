#!/usr/bin/env python3
"""
The literature wiki holds curated source pages only. This proves it still does.

WHY THIS EXISTS. The bulk Zotero dump was deleted on 2026-08-02 at 19:26 - 538
exported markdown files and 439 auto-generated `zotero: true` stub pages - and
the parked scripts got their `--allow-rebloat` guard in the same commit. Two
hours later, at 21:27, an ordinary vault backup committed all 978 files back.
Nothing recorded it. CLAUDE.md and the memory index both went on describing a
curated-only wiki for seven weeks while 439 orphan stubs sat in it, and it
surfaced only because someone measured the repository for an unrelated reason.

The guard against re-running the sync scripts was never the weak point: it
worked, and the files returned anyway, by a route that is no longer
reconstructible from git. So the check that matters is not "was the script
run" but "is the invariant true right now", which is this one. If the dump
comes back a third time, this fails on the next push instead of in seven weeks.

    python3 _curated_only_check.py
"""
from pathlib import Path

VAULT = Path(__file__).resolve().parents[2]
SOURCES = VAULT / "literature/wiki/sources"
DUMP = VAULT / "literature/zotero"


def main() -> int:
    findings = []

    dumped = sorted(DUMP.glob("*.md")) if DUMP.exists() else []
    if dumped:
        findings.append(
            f"literature/zotero/ is back: {len(dumped)} files. It is the bulk "
            f"export, retired 2026-08-02; papers enter via Consensus -> /ingest-paper.")

    pages = sorted(SOURCES.glob("*.md"))
    stubs = [p for p in pages
             if any(ln.strip() == "zotero: true"
                    for ln in p.read_text(errors="replace").splitlines()[:20])]
    if stubs:
        findings.append(
            f"{len(stubs)} auto-generated `zotero: true` stub pages in "
            f"literature/wiki/sources/ (e.g. {stubs[0].name}). Curated pages only.")

    print(f"literature wiki: {len(pages)} source pages, {len(stubs)} auto-stubs, "
          f"{len(dumped)} files in the retired dump")
    if findings:
        print("\n  REBLOAT:")
        for f in findings:
            print(f"    {f}")
        return 1
    print("  curated-only invariant holds")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
