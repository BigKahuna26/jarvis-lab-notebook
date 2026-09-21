#!/usr/bin/env python3
"""
stain_volumes.py — per-tube pipetting volumes to stain a target cell number.

Given measured cell concentrations (in e6/mL, i.e. millions of cells per mL),
compute how much to pull from each tube to stain a fixed target number of cells
(default 10e6). Flags low-yield tubes that can't reach the target.

Formula:  volume_uL = (target_e6 / conc_e6_per_mL) * 1000

Input: one "sample <sep> concentration" pair per line on stdin or via --file.
Separators accepted: '-', ',', tab, or whitespace. Blank lines and lines
starting with '#' are ignored. Concentration is read as e6/mL.

Examples
--------
  # paste counts, target 10e6 each:
  python3 analysis/scripts/stain_volumes.py --target 10 <<'EOF'
  a1 - 8.16
  a2 - 9.1
  d5 - 2.32
  EOF

  # give the resuspension volume so feasibility is checked per tube:
  python3 analysis/scripts/stain_volumes.py --target 10 --tube-vol 3000 --file counts.txt

Output: summary stats, then a Markdown table ready to paste into a day file.
Group column = first character of the sample ID (A-F …) when it is a letter.
"""
import argparse
import re
import statistics
import sys


def parse_counts(text):
    """Yield (sample_id, conc_e6_per_mL) from loosely-formatted lines."""
    rows = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # split on ' - ', ',', tab, or run of whitespace
        parts = re.split(r"\s*-\s*|\s*,\s*|\t+|\s+", line, maxsplit=1)
        if len(parts) < 2:
            print(f"  ! skipped (no value): {raw!r}", file=sys.stderr)
            continue
        sample = parts[0].strip()
        m = re.search(r"[-+]?\d*\.?\d+", parts[1])
        if not m:
            print(f"  ! skipped (no number): {raw!r}", file=sys.stderr)
            continue
        rows.append((sample, float(m.group())))
    return rows


def group_of(sample):
    c = sample[:1].upper()
    return c if c.isalpha() else "?"


def main():
    ap = argparse.ArgumentParser(description="Per-tube staining volumes for a target cell number.")
    ap.add_argument("--target", type=float, default=10.0,
                    help="target cells to stain per sample, in e6 (default 10 = 10e6)")
    ap.add_argument("--tube-vol", type=float, default=None,
                    help="resuspension volume per tube in uL; enables feasibility check")
    ap.add_argument("--warn-vol", type=float, default=2000.0,
                    help="flag any sample needing more than this many uL (default 2000)")
    ap.add_argument("--file", default=None, help="read counts from this file instead of stdin")
    ap.add_argument("--round", type=int, default=0,
                    help="round volumes to nearest this many uL for pipetting (0 = whole uL)")
    args = ap.parse_args()

    text = open(args.file).read() if args.file else sys.stdin.read()
    rows = parse_counts(text)
    if not rows:
        sys.exit("No valid sample,concentration pairs found.")

    target = args.target  # e6

    def vol_uL(conc):
        return (target / conc) * 1000.0

    def rnd(v):
        if args.round and args.round > 0:
            return round(v / args.round) * args.round
        return round(v)

    results = []
    for sample, conc in rows:
        v = vol_uL(conc)
        flag = ""
        actual_e6 = None
        if args.tube_vol is not None:
            avail_e6 = conc * (args.tube_vol / 1000.0)
            if avail_e6 < target or v > args.tube_vol:
                flag = "INSUFFICIENT"
                actual_e6 = avail_e6
        if not flag and v > args.warn_vol:
            flag = "high-vol"
        results.append(dict(sample=sample, group=group_of(sample), conc=conc,
                            vol=v, flag=flag, actual=actual_e6))

    # ---- summary stats (printed before the table) ----
    concs = [r["conc"] for r in results]
    vols = [r["vol"] for r in results]
    print(f"# Staining volumes — target {target:g}e6 cells/sample", file=sys.stderr)
    print(f"  n = {len(results)} samples", file=sys.stderr)
    print(f"  concentration (e6/mL): min {min(concs):.2f}  median {statistics.median(concs):.2f}  max {max(concs):.2f}", file=sys.stderr)
    print(f"  volume needed (uL):    min {min(vols):.0f}  median {statistics.median(vols):.0f}  max {max(vols):.0f}", file=sys.stderr)
    flagged = [r for r in results if r["flag"]]
    if flagged:
        print(f"  flagged: {', '.join(r['sample'] + '(' + r['flag'] + ')' for r in flagged)}", file=sys.stderr)
    # per-group mean concentration
    groups = sorted({r["group"] for r in results})
    if len(groups) > 1:
        print("  per-group mean conc (e6/mL): " +
              "  ".join(f"{g}={statistics.mean([r['conc'] for r in results if r['group']==g]):.1f}"
                        for g in groups), file=sys.stderr)
    print("", file=sys.stderr)

    # ---- Markdown table (stdout — paste into day file) ----
    has_groups = any(r["group"] != "?" for r in results)
    hdr = "| Sample |"
    sep = "|--------|"
    if has_groups:
        hdr += " Group |"; sep += "-------|"
    hdr += " Conc (e6/mL) | µL for %ge6 | Flag |" % target
    sep += "-------------:|--------------:|------|"
    print(hdr)
    print(sep)
    for r in results:
        cells = [r["sample"]]
        if has_groups:
            cells.append(r["group"])
        vtxt = f"**{rnd(r['vol'])}**"
        note = ""
        if r["flag"] == "INSUFFICIENT":
            vtxt = f"⚠️ {rnd(r['vol'])}"
            note = f"stain whole tube (~{r['actual']:.1f}e6) #needs-review"
        elif r["flag"] == "high-vol":
            note = "⚠️ high volume — check tube holds this"
        cells += [f"{r['conc']:g}", vtxt, note]
        print("| " + " | ".join(str(c) for c in cells) + " |")


if __name__ == "__main__":
    main()
