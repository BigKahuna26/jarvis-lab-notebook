---
type: protocol
tags: [writing, proposals, reporting, workflow]
---

# Writing for the reader, not for the argument

*Adopted 2026-09-20. Drafted by Claude Science; moved here from a staging file on 2026-09-20 so it
lives in git rather than only in the gitignored `.claude/CLAUDE.md`.*

TC is a first-year bioengineering PhD student building depth in glyco-immunology — not a specialist
in it. **Documents in this vault are written to be interpretable by him now**, not by the version of
him that exists after three more years of reading. This is standing, not a per-document preference.

The failure mode is not wrong writing. It is writing organised around making the argument airtight,
which reliably produces prose that is precise and unreadable.

## Six rules

1. **Lead with the answer.** Recommendation first, reasons after. Never build to a conclusion across
   several paragraphs — the reader should know the destination from the first sentence of a section.
2. **One idea per paragraph.** If a sentence needs three subordinate clauses to be true, it is three
   sentences.
3. **Define a term at first use in every document, or don't use it.** Avidity, *cis*-masking,
   poly-LacNAc, epistasis, residual — one plain gloss, each time, in each document. Do not rely on a
   definition given in a sibling file.
4. **Say what a thing *is* before what it *implies*.** The physical description comes first — "GD3 is
   a sugar chain sitting on a fat molecule in the membrane" — and only then what follows from it.
5. **Use the concrete noun.** "The seven probes," not "the reagent set." "Antibody," not "binder,"
   where it is in fact an antibody.
6. **A number carries its meaning.** "+3.2 log₂" alone is not informative; "+3.2 log₂ — roughly
   nine-fold — higher in the progenitor compartment" is.

## Where an explanation belongs

The three-document structure exists so that precision and readability do not have to compete. Use it
instead of cramming both into one file.

| What the reader needs | Where it goes |
|---|---|
| the 2-page version to hand someone | the companion brief ([[proposal-pair-contract]]) |
| the underlying biology explained from scratch | the primer's plain-language section |
| the full argument with every caveat and dead end | the full proposal |

**When something reads as unclear, the fix usually belongs in the primer, not in the proposal.**
Adding another qualified sentence to the proposal makes it more precise and less readable, and that
trade is almost always wrong.

## The test, before saving

Read the first sentence of each paragraph in order, and nothing else. If that sequence does not tell
the story, the section is organised for the argument rather than for the reader — fix the
organisation, not the wording.
