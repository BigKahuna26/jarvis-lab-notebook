---
type: protocol
tags: [writing, formatting, proposals, fellowship, workflow]
---

# Document Standards

*Adopted 2026-09-21. The formatting counterpart to [[plotting-standards]]: that file governs what a
figure may look like, this one governs what a document may look like. Prose quality lives separately
in [[writing-for-the-reader]] — voice and structure there, typography and document form here.*

**The reference implementation is a submission pair of your own** —
`fellowships/<application>/drafts/<your-research-plan>.md` and
`<your-personal-statement>.md`, converted from the Word files their author actually writes in.
Every numeric rule below is measured, not asserted, and the measurement is quoted so a future
disagreement is settled by re-measuring rather than by preference.

| measured | research plan (final) | personal statement (final) |
|---|---|---|
| words | 1,271 | 2,099 |
| body paragraphs (excluding section labels) | 8 | 15 |
| median body paragraph | **175 words** | **123 words** |
| standalone bold section labels | 5 | 3 |
| single-sentence beats (under 25 words) | **0** | **0** |
| paragraphs opening with a bold lead-in | 6 / 13 (46%) | 4 / 18 (22%) |
| em dashes per 1,000 words | 2.4 | 4.8 |
| markdown/Word headings | **0** | **0** |
| section labels | bold run-in (`**Approach.**`) | bold standalone (`**Broader Impacts**`) |
| tables | 0 | 0 |

These are the figures `doc_compliance.py` prints, so the standard and its checker cannot drift. Note
what the two columns agree on: **neither final document contains a single paragraph under 25 words
that is not a section label.** Every beat in a submitted NSF document is a label doing structural
work, not a one-line sentence doing rhetorical work.

*Superseded evidence, kept because the first version of this file was built on it:* the earlier
markdown drafts `<an earlier draft>` and `<an earlier draft>` measured
3.3 and 3.4 em dashes per 1,000, medians of 85 and 143 words, bold lead-ins at 39% and 12%, and
used `#`/`##` headings. Those were working drafts, not what gets submitted, and on heading style
they disagree with the finals outright. Where the two conflict, **the submitted document wins.**

---

## Part 1 · Canonical markdown

### D1 · A document that leaves the vault is unwrapped — one paragraph, one line

No hard wrapping at 80, 95, or any other column, in statements, essays, proposals and anything else
exported for a reader outside the vault. The reference documents run 1,081 and 2,123 characters on a
single line. A hard-wrapped paragraph makes `git diff` mark every line as changed when one word
moves, which destroys the diff that made markdown canonical in the first place — and the fellowship
drafts were being wrapped at 95 while the statements they were modelled on were not.

**Scope, measured rather than assumed.** This rule covers deliverables, not vault notes. Protocol
notes and experiment reports here are mixed — `plotting-standards.md` runs to 766 characters on its
longest line but wraps 52 of 241 prose lines, `TC_002_experiment_report.md` 613 and 202 of 364, and
`writing-for-the-reader.md` is wrapped throughout at 100. There is no established convention for
those, so this file does not invent one; it is itself wrapped, consistent with its siblings.

**Frontmatter is never reflowed**, anywhere. Same diff reason, and it also breaks YAML.

### D2 · A short funder statement has no headings at all, and a long document has two levels

**Both NSF finals contain zero headings.** Sections are marked by bold labels instead: a run-in label
opening the paragraph in the dense research plan (`**Introduction.**`, `**Preliminary work.**`,
`**Approach.**`, `**Expected outcomes and alternatives.**`) and a standalone bold line in the roomier
personal statement (`**Background**`, `**Intellectual Merit**`, `**Broader Impacts**`,
`**Future Goals**`). On two or three pages a heading spends a line of the page limit to say what a
bold label says inside a line that is doing other work as well.

So: **two pages or fewer, or any hard page limit → bold labels, no headings.** A longer document — a
full application with many independent sections, a thesis proposal, a report — takes `#` for the
title and `##` for sections, and nothing deeper. A `###` is a sign the section carries two ideas and
should be split or demoted to a bold label.

Label text is either mandated by the funder (*Intellectual Merit*, *Broader Impacts*) or states the
content specifically (*Aim 1: Define what programs CD22 uses to enforce the quiescent state*).
Generic labels are acceptable only in the fixed, expected positions the finals use them in —
*Background*, *Approach*, *Introduction* — where a reviewer is scanning for exactly that word.

### D3 · Bold lead-ins are calibrated per document type, not per taste

This is the rule most often gotten wrong in both directions.

| document type | bold lead-ins | measured from |
|---|---|---|
| research plan, technical statement, project description | roughly 1 paragraph in 2 | 46% (final), 39% (draft) |
| personal statement, narrative essay | roughly 1 in 5, and none in the opening or closing | 22% (final), 12% (draft) |
| an answer typed into a web box | none — see D11 | — |

In a technical document the lead-in is doing work: it labels the paragraph so a reviewer skimming for
*the design* or *my contribution* finds it in one pass. In a narrative it competes with the story and
reads as a slide deck.

### D4 · Em dashes: 2 to 5 per 1,000 words

The four measured reference documents span 2.4 to 4.8 per 1,000 — the denser the document, the fewer.
That is a deliberate rate, not an accident. Past roughly 5 the punctuation becomes the voice of the
document and every clause reads as an aside; one set of project descriptions was at 20. Where the
rate is high the fix is a full stop or a comma, not a rewrite: an em dash pass that changes a claim
is the wrong pass.

### D5 · Paragraphs are substantial, and the floor depends on the document

Measured medians, counting only body paragraphs: **175 words in the research plan, 123 in the
personal statement.** The checker's floor is 70, which is deliberately lenient — the references clear
it by a wide margin, and a document at 70 is at the edge rather than at the standard. A statement
whose body paragraphs median well under that reads as a chat thread, however good the sentences are. This does not license
three subordinate clauses; [[writing-for-the-reader]] rule 2 still binds. One idea, developed, rather
than one idea, asserted.

**A single-sentence paragraph used as a deliberate beat is exempt, and the median should be computed
without it.** *"The decisive consideration was that I did not want an immunology PhD."* is the
strongest line in one application's Q2 and merging it into the paragraph below would destroy the effect to
satisfy an average. The rule targets a document whose paragraphs are *uniformly* short, not one that
uses a beat where a beat belongs — so `doc_compliance.py` excludes paragraphs under 25 words from the
median, and a document where beats are more than about a third of all paragraphs is the actual
failure this rule is looking for. For calibration: both fellowship finals sit at **0% beats**, and a later draft
sits at 28%.

### D6 · No tables in a prose document

Zero in both reference documents. A table in a statement is a figure without a caption: it breaks the
reading line and funders' converters mangle it. If the content is genuinely tabular it belongs in a
figure, an appendix, or a sibling note.

---

## Part 2 · What never ships inside the deliverable

### D7 · Apparatus lives in a sibling note, never in the document

A document that leaves the vault contains the document. It does not contain changelogs, provenance or
fabrication-audit tables, `[YOU ...]` inserts, word-count annotations, reviewer findings, or notes
about what changed since the last version. All of that belongs in `<project>/reviews/` beside the
draft.

*This rule exists because it was broken.* The `.docx` exports handed over in September carried a
Fabrication Audit table and two changelogs inside the same file as the essays — internal working
apparatus shipped inside the deliverable, in a document whose whole purpose was to be read by a
selection committee.

### D8 · Vault syntax is stripped on export, not carried out

Wikilinks, block references, callout syntax, and tags mean nothing to a recipient.
`analysis/scripts/md_to_docx.py` strips wikilinks; anything else it does not strip is a bug to fix in
the script rather than a thing to hand-edit out of the output.

### D9 · One export per target, versioned in the filename, never overwritten under review

`PersonalEssay_v8.docx`, not `PersonalEssay.docx`. A marked-up copy must never be destroyed by
the next export — which a fixed filename guarantees will happen. Harvest comments with
`analysis/scripts/ingest_docx_comments.py` before exporting the next version.

---

## Part 3 · Per-target form

### D10 · The funder's current solicitation governs typography, and it is read, not remembered

Page limits, font size floors, margins, and line spacing come from the current cycle's solicitation
every time. They change between cycles, and a document rejected on formatting is rejected without
being read. Do not take these numbers from memory or from a previous cycle's draft — including the
reference documents above, which were written to a prior year's rules.

### D11 · An answer typed into a web box is plain text

Portal and application forms render nothing: `**bold**`, `|` tables, and `#` headings appear
literally as characters. Write those answers with no markdown syntax at all, use blank lines for
paragraph breaks, and spell out emphasis in the sentence structure instead.

**Word counts are computed, never estimated** — the limit is enforced by the form, and "about 150"
is how an answer gets truncated mid-sentence.

### D12 · An export declares which backend produced it

`md_to_docx.py` prints `[textutil]` or `[python-docx fallback]`. This is not cosmetic: `textutil`
needs a macOS helper that the Claude Science sandbox cannot reach, and it **exits 0 having written
nothing**, so a stale `.docx` at the target path survives with a fresh timestamp. The script now
validates the output and falls back, but an export whose backend was not read is an export whose
freshness was not checked.
