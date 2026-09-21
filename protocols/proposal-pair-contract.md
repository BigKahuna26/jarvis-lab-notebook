---
type: protocol
tags: [proposals, writing, workflow]
---

# The proposal pair — full proposal and companion brief

*Adopted 2026-09-19. Drafted by Claude Science; moved here from a staging file on 2026-09-20 so it
lives in git — `.claude/CLAUDE.md` is gitignored, and convention that only exists on one machine is
convention waiting to be lost.*

A proposal is **two documents, not one**. They are written and maintained together.

| | Full proposal | Companion brief |
|---|---|---|
| File | `{ID}_thesis_{slug}.md`, `{ID}_{slug}.md` | `{ID}_brief_{slug}.md` |
| Template | `templates/proposal.md` | `templates/proposal-brief.md` |
| For | us — thinking, arguing, deciding | the PI, the lab, a committee |
| Length | as long as the argument needs | **2–3 pages, ~1,200 words, hard** |
| Contains | every number, caveat, rejected alternative, superseded claim | only what a decision needs |

**Same stem, different slot**, so the pair sorts adjacent and the relationship is visible from the
filename: `TC_004_TH3_thesis_glycan…` / `TC_004_TH3_brief_glycan…`. The full proposal carries
`companion_brief:` in frontmatter; the brief carries `parent_proposal:` and `parent_version:`.

## Rules, in the order they get broken

1. **No number appears in a brief that is not in its parent.** The brief is a projection of the
   parent, never a source. A figure that exists only in the brief is a provenance break — the same
   defect as a figure with no script.
2. **The brief never carries a claim the parent has not argued.** If a compression makes a stronger
   claim than the parent supports, the parent is what needs fixing.
3. **Compression removes detail, never risk.** Every caveat in the brief must also be in the parent,
   unsoftened. Scope words matter most here — if the assay reads a subset, the brief says the subset.
4. **Biology first, platform second.** The brief leads with the question about the system; the
   measurement is how, not why.
5. **One decision, asked out loud.** A brief that asks for nothing is a status update.
6. **Parent moves → brief is stale.** Bump the parent's version, then re-check the brief against it
   and update `parent_version:`. A brief pointing at a superseded parent version is the pair's main
   failure mode.

**Which to write first:** the parent, always. The brief is compression, and compressing an argument
that has not been made yet produces confident prose with nothing underneath it.

## Review

**Codex review covers both** — they are proposals. Review the pair *together*, since most defects are
drift between them rather than errors within either.

> **Rule 1 is not hypothetical.** The 2026-09-20 review of `TC_004_TH3_brief_glycan-state-exhaustion`
> found an effect size, an FDR, a reagent-panel description, a donor count and a variance
> estimate all present in the brief and absent from the report it declared as its source. Some of
> those numbers were real and lived in a *different* report; the brief had become a source in its own
> right, which is exactly the failure this rule names.

**In use:** `proposals/TC_004_TH3_thesis_systems-glycoimmunology-exhaustion.md` paired with
`proposals/TC_004_TH3_brief_glycan-state-exhaustion.md`.
