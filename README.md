# Jarvis — an AI-reviewed lab notebook, as a skeleton

This is the machinery from a working PhD lab notebook, with the research taken out. It is an
Obsidian vault that three AI models work inside: one writes, and two independently review what the
first one wrote.

Everything here runs. Nothing here is anybody's data.

## The part worth stealing

Most AI-in-the-lab tooling helps you produce things faster. The problem this vault kept running into
was the opposite one: an agent that writes a report, checks its own report, and tells you it is fine.
It is fine until a number in it is wrong, and then it is confidently wrong in a document you are
about to send to your advisor.

So the design principle is that **the model that wrote it does not get to be the one that clears
it**, and the checks that matter are mechanical rather than remembered.

**Numbers are recomputed, not trusted.** A claim registry holds each printed value, the table it
comes from, and the estimator that produced it. A verifier recomputes every one against its source
on each run and fails if the prose and the table disagree. It emits a provenance appendix into the
document stating its own coverage — *"11 of the 457 measurement-shaped numbers on this page are
recomputed from their source table"* — because a table of checked numbers with no denominator
implies a completeness it does not have.

**Two reviewers, and the second one is blinded.** Codex reviews code and claims against evidence.
Then a third model reads the same document *cold* — it is never shown the first reviewer's findings,
and the paths where those findings live are refused by the bundler rather than filtered, because a
silent drop looks exactly like a clean run. Two agents that talk to each other converge; the defect
that survives is the one they agree on.

**Findings are never auto-applied.** Every reviewer's output is verified, argued with, and brought
to a human to decide. Three models means three sets of confident-and-sometimes-wrong claims.

**Guards say when they cannot run.** A check whose inputs are missing prints `SKIPPED` with the
reason. A green suite that silently checked nothing is worse than a red one.

## What is in here

| | |
|---|---|
| `analysis/scripts/` | the review system, the CI guards, the Word round-trip, a few bench tools |
| `analysis/scripts/api/` | metered API tooling — every script estimates before spending, refuses above `--max-usd`, and logs actual spend |
| `analysis/scripts/codex_review_prompts/` | what each reviewer is asked to look for |
| `protocols/` | the document contracts: proposal pairs, report structure, writing rules, formatting standards |
| `.obsidian/plugins/jarvis-command-center/` | the sidebar: token usage, API credit balances, experiment status, and a button that convenes both reviewers on the open document |
| `.github/workflows/` | CI that runs the guards a bare clone can actually run |
| `CLAUDE.md` | the instructions every agent in the vault reads |

Empty folders are the vault's shape — experiments, protocols, daily notes, literature. Your work
goes there.

## What is deliberately not in here

No data, figures, experiment notes, reports, proposals, literature or fellowship material. No API
keys — they live outside the vault by design, in a file the scripts read from the environment.

Two things were removed rather than scrubbed, and the reasons are the useful part:

- **`plotting-standards.md`**, a set of rules about statistical figures, because every rule in it was
  justified by specific unpublished results. Genericising it would have left the rules asserted
  instead of earned, which is the opposite of the point.
- **The sidebar's artwork**, which is not ours to redistribute.

## Running it

You need [Obsidian](https://obsidian.md) and [Claude Code](https://claude.com/claude-code). The two
reviewers are optional and independent: the OpenAI Codex CLI, and Google's Antigravity CLI (`agy`)
for the blinded read. Without either, the verifiers and CI still work — they are ordinary Python.

```bash
git clone <this repo> my-notebook && cd my-notebook
cp CLAUDE.md .claude/CLAUDE.md     # Claude Code reads it from there
python3 analysis/scripts/_ci_suite.py
```

Then edit `CLAUDE.md`. It is written for one person's field and habits; the machinery is general but
the instructions are not. The places to change are marked.

## Honest limits

This was built by and for one graduate student, in the open, largely by the agents it describes. It
has not been used by anyone else, the review costs real money or a subscription, and the whole
approach only pays off if you are producing documents whose numbers have to be right.

The parts most likely to transfer are the claim registry, the blinded second reviewer, and the habit
of making a guard announce when it cannot run. The parts least likely to transfer are the bits
shaped around one person's experiments.

## Licence

MIT. Attribution welcome, not required.
