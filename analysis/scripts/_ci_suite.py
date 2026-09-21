#!/usr/bin/env python3
"""
The part of the check suite a bare clone can run. Entry point for GitHub CI.

WHY THIS EXISTS, AND WHY IT IS NOT `_suite.py`. The full suite imports flowkit
and reads the Aurora exports from absolute paths under ~/Documents, and it
checks figures that `.gitignore` excludes as "reproducible from scripts". None
of that is in the repository, so `_suite.py` on a runner is not a stricter
check - it is a red suite for reasons that are not defects, which is the fastest
way to teach everyone to ignore it.

WHAT PROMPTED IT. On 2026-09-06 the TC_002 reports moved into a reports/
subfolder. Three guards kept the old path: the synthesis verifier crashed on a
missing file, and the copy and orphan checks reported "missing copy" - a finding
that reads like a complaint about the reports rather than about the path list.
The suite stayed red and nobody looked for two weeks, during which 361
synthesis claims were verified against nothing at all. Every guard below would
have caught that on the commit that caused it.

WHAT IT COVERS: claims recomputed from committed tables and matched against the
report text, and the converse - printed numbers that no verifier registers.
WHAT IT DOES NOT: figures, embeds, gate fingerprints, copy divergence against
the data/figures mirrors, day parity. Those need the untracked outputs and stay
with `_suite.py` on the machine that has them. A green run here is not a green
suite, and this script says so on every run rather than letting the badge imply
it.

    python3 _ci_suite.py
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# (label, argv, the regex-free substring that proves the check actually ran)
CHECKS = [
    ("TC_004 report claims", ["tc004_report_verify.py"], "verified"),
    ("TC_002 synthesis claims", ["tc_002_report_verify.py", "--no-figures"], "claims checked"),
    ("orphan numbers", ["_orphan_numbers.py"], "printed values checked"),
    ("curated-only wiki", ["_curated_only_check.py"], "source pages"),
    # Prints SKIPPED while its reference documents are absent, which is the
    # honest state rather than a pass - and it flips to a real check the moment
    # they are committed, with no edit here.
    ("document standards", ["_document_standards_check.py"], "document standards:"),
]


def main() -> int:
    print("CI suite - the checks a clone can run (figures and raw data are not in git)\n")
    failed = []
    for label, argv, evidence in CHECKS:
        r = subprocess.run([sys.executable, str(HERE / argv[0])] + argv[1:],
                           cwd=str(HERE), capture_output=True, text=True)
        out = (r.stdout + r.stderr).strip()
        # A check that exits 0 without printing its count has not proven
        # anything - the lesson _suite.py was built on. Treat it as a failure.
        ran = evidence in out
        ok = r.returncode == 0 and ran
        print(f"[{'ok  ' if ok else 'FAIL'}] {label}")
        for line in out.splitlines():
            print(f"       {line}")
        if not ok:
            failed.append(f"{label} (exit {r.returncode}"
                          + ("" if ran else ", no count printed") + ")")
        print()

    if failed:
        print("CI SUITE: RED")
        for f in failed:
            print(f"  {f}")
        return 1
    print("CI SUITE: GREEN - figures, gates and parity were NOT checked here; "
          "run analysis/scripts/_suite.py locally for those")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
