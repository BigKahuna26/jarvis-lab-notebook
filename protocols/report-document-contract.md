---
type: protocol
tags: [reporting, tc_002, workflow]
---

# The three-document contract

One experiment produces **three documents plus a deck**, and every figure has exactly one home. This
exists because the same figure was embedded in three places and the copies drifted — the numbers verified
in each, because each copy was internally consistent, while the three disagreed with each other.

## What goes where

| Document | Contains | Never contains |
|:--|:--|:--|
| **Day report** (`TC_002_D8_report.md`) | Measurements from *one* timepoint. Its own gating, its own per-day diagnostics, its own per-day figures. | Anything comparing the two days. Anything whose figure has both days on one canvas. |
| **Experiment report** (`TC_002_experiment_report.md`) | Everything that compares the timepoints: reproducibility, trajectories, attribution, co-expression rewiring, transcription-factor axis. **Plus all experiment-level QC.** | Per-day detail that only one timepoint's reader needs. |
| **Deck** (`presentations/…-combined.md`) | Takeaways only — one claim per slide, and the QC that a PI will ask for on the spot. | Supporting detail. If a slide needs a paragraph to defend it, the paragraph belongs in the experiment report. |

## The scope test

A figure is **cross-day** if both timepoints appear on one canvas, or if it plots a quantity defined
across days (a trajectory, a concordance, a status transition). Those live in the experiment report even
when a day-specific prefix is in the filename — the prefix records which run *built* it, not where it
belongs.

A figure is **QC** if it exists to rule something out rather than to measure something: gating
walkthroughs, congenic specificity, knockdown validation, threshold-free distribution checks behind a
gated number.

## The rule that makes it work

**A number is verified where it is printed.** When content moves between documents, its verifier claims
move with it. If a figure is embedded in two documents, its numbers must be registered in both — which is
why one home per figure is cheaper than the alternative.

Corollaries learned the hard way:

- A day report may *point* to an experiment-report section. It may not restate its numbers.
- An unembedded figure passes every checker: the embed checker sees a resolving reference, parity sees
  identical files, and the number verifiers see no quoted value. `_embed_symmetry.py` exists for this.
- A shared basename across day directories makes an embed **suffix-ambiguous** — Obsidian resolves it to
  whichever copy it finds first, so a report can silently render the other day's figure. Use full
  vault-root paths.

## Current QC inventory (21 per-day families plus the TF pair)

- `QC_01_gating_walkthrough.png`
- `QC_02_phenotype_pairs.png`
- `QC_03_ir_by_state.png`
- `QC_03_ir_by_state_sh1063.png`
- `QC_03_ir_by_state_sh2653.png`
- `QC_03_ir_by_state_sh3418.png`
- `QC_04_tigit_quadrants.png`
- `QC_05_ir_gating.png`
- `QC_06_ir_gating_sh1063.png`
- `QC_06_ir_gating_sh2653.png`
- `QC_06_ir_gating_sh3418.png`
- `QC_07_congenic_specificity.png`
- `QC_08_cd22_tpex.png`
- `QC_09_tigit_overlay_sh1063.png`
- `QC_09_tigit_overlay_sh2653.png`
- `QC_09_tigit_overlay_sh3418.png`
- `QC_10_naive_reference.png`
- `QC_11_quadrant_divider_choice.png`
- `QC_12_divider_recheck.png`
- `QC_13_divider_raw_units.png`
- `QC_14_divider_accepted.png`
- `crossday/TF_QC_01_biaxial_sh2653.png`, `crossday/TF_QC_02_biaxial_sh1063.png`

## Rebuild path

| Document | Command |
|:--|:--|
| Day report figures | `python3 tc_002_run_timepoint.py --day D8 …` |
| Experiment report | `python3 tc_002_experiment_report.py` |
| Cross-day panels | `python3 tc_002_cross_day.py`, `tc_002_crossday_network.py` |
| TF + TF QC | `python3 tc_002_tf_subsets.py`, `python3 tc_002_tf_qc.py` |
| Gate everything | `python3 _suite.py` |

## Cross-day content: the scope test, and what it costs to get wrong

**A figure is cross-day if both timepoints appear on one canvas.** That is the whole test. It does
not matter which directory the file sits in, which report first cited it, or whether the analysis
"belongs" to a day conceptually — if a reader sees Day 8 and Day 15 side by side, the figure is
cross-day and its home is the experiment report.

Three failures this rule exists to prevent, all of them observed in TC_002:

1. **One analysis published as two.** A helper wrote each cross-day panel into *both* day
   directories under both day prefixes, to satisfy the prefix guard. The guard was right; the
   destination was wrong. The result was four byte-identical file pairs, embedded in both day
   reports, so one analysis appeared as two in two documents each supposed to hold one timepoint.
   The fix is a day-neutral `crossday/` canvas, which the prefix guard already exempts. If a figure
   needs two homes to satisfy a guard, the guard is telling you it does not belong in either.
2. **A number verified in the wrong document.** Cross-day claims registered in a day verifier are
   checked against a document that should not be printing them. Move the content and the claims
   move with it — *a number is verified where it is printed*, and a claim left behind either fails
   as a missing anchor or, worse, passes against unrelated prose.
3. **A pointer that restates.** A day report that says "see §5" and then repeats §5's correlation
   has re-created the duplication in prose. A pointer names sections; it prints no numbers. This is
   machine-checked by `_pointer_check.py`.

**Registering a count as a bare integer does not work.** `add("network edges", "3", ...)` passes
whenever any `3` appears within the anchor window, including a table cell about something else.
Register the phrase the reader reads — `"1 of 3"`, `"5 of 6"` — which cannot match by accident. A
p-value of exactly 1.0 has the same problem and is written `1.0000` for that reason.

**Two checks, in opposite directions, and you need both.** The number verifiers check that every
*registered* claim appears in its report. `_orphan_numbers.py` checks the converse: that every
*printed* number is registered by a verifier that reads that report. Only the second catches a
deleted `add(...)` line, which is otherwise a silent regression — the number stays on the page and
the suite stays green.

**A cache read that can silently return nothing is a hazard, not a convenience.** A guessed path
that resolves nowhere makes every dependent claim quietly vanish from the registry, and the suite
reports green over prose nobody is checking. Use `NC._require(name)` for any cache whose absence
means the caller is wrong; it raises. Reserve the None-returning `_load` for genuine optionality.
