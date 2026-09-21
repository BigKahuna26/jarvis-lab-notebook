---
type: reference
tags: [tooling, api, claude-science, codex]
updated: 2026-09-20
---

# API tooling — what it is, who can run it, how to ask for a run

Five scripts in `analysis/scripts/api/` spend Anthropic, OpenAI and Google API credits on
work the subscriptions cannot do: run without a session, run in bulk, and run
without a CLI. This page is the vault-visible contract so **Claude Science** and
any future agent know what exists and how to reach it.

## The scripts

| Script | Spends | What it does | Measured cost |
|---|---|---|---|
| `review_openai.py` | OpenAI | Second-reviewer pass over code, reports, proposals — no CLI, no watcher, no queue | ~$0.77 for a 23-file backlog |
| `embed_vault.py` | OpenAI | Semantic index over every note; `query` returns passages and paths | ~$0.02 to build |
| `audit_batch.py` | OpenAI | Every report and proposal audited at once via Batch API, half price | ~$0.07 for 23 documents |
| `daily_sweep_anthropic.py` | Anthropic | Reads the day's git diff for cross-document contradictions | ~$0.41/day on `claude-opus-5` |
| `third_opinion_gemini.py` | Google | An independent critic that has **not** seen what Claude and Codex said — the **fallback** route; prefer the CLI below | ~$0.08 for a 15,000-word proposal |

Every one estimates before spending, refuses above `--max-usd`, needs an explicit
`--yes`, and appends actual spend to `.claude/api_ledger.jsonl`. `--dry-run`
needs no key, so **any agent can cost a job without being able to run it.**

## The third opinion, and why it is blinded (adopted 2026-09-20)

Claude and Codex review each other, and two agents that talk to each other
converge. The failure that survives that loop is the one they **agree** on, and
this vault has produced several — on 2026-09-20 alone, Codex audited a proposal
against the wrong source report, and Claude "corrected" seven glycan values that
were already right. Neither caught the other.

So `third_opinion_gemini.py` is not a better reviewer. It is a
**differently-wrong** one, asked the question cold. It is given the work — the
report, the proposal, the script, plus the declared source report — and never
the Codex review, the bridge replies, or Claude's analysis. That blinding is
enforced in code: paths under `.claude/codex-review/`, `.claude/third-opinion/`
and the bridge outbox are **refused**, not filtered, because a silent drop looks
exactly like a clean run. Shown a review, a model grades the review and agrees
far too often.

It returns disagreements, unargued assumptions, unconsidered alternatives,
failure modes, and — importantly — what it could not judge. Not another draft.

### Two routes, same as Codex

| Route | Command | Spends |
|---|---|---|
| **CLI (default)** | `bash analysis/scripts/third_opinion.sh <paths>` | nothing — runs on the Gemini subscription |
| API (fallback) | `python3 analysis/scripts/api/third_opinion_gemini.py <paths> --yes` | ~$0.08 a pass |

The CLI is `@google/gemini-cli`, authenticated once with **Sign in with Google**
on the account holding the subscription (`gemini`, then a browser). A paid Code
Assist seat also wants `GOOGLE_CLOUD_PROJECT` exported; without one it falls back
to the free tier, which is still 1,000 requests/day — far more than checkpoint
reviews need. `third_opinion.sh --check` reports version, model and auth state.

**An agentic CLI threatens the blinding**, because it can open files on its own
and the vault is full of Codex reviews. So the bundle is built by the Python
script — one definition of the rules, shared by both routes — and the CLI is run
from an **empty temp directory**, with nothing in its working tree to wander
into. Instructions alone are not a control.

**Use it at checkpoints, not continuously.** A design is settled; a pipeline is
written; a surprising result appears; a conclusion is about to leave the vault.
The loop is: Claude + Codex work normally → at a checkpoint, Gemini sees the work
cold → its objections come back to Claude and Codex → each is resolved with
evidence or a test, not with an argument → stop when nothing substantive is left.
At ~$0.08 a pass, the cost is never the reason to skip it.

The same rule as every other reviewer: **findings are never auto-applied.** Three
models produce three sets of confident-and-sometimes-wrong claims; the third one
is not privileged for being newest.

## Who can actually run these

**Claude Code, on the host.** The keys live in `~/.config/jarvis/api-keys.env`
(mode 600), sourced from `~/.zshrc`. That path is outside the vault on purpose:
the vault is a git repo that pushes to GitHub.

**Claude Science almost certainly cannot**, for the same structural reason it
cannot start the bridge watcher: its sandbox has the vault mounted, not the home
directory, and outbound network access is not guaranteed. Do not assume a failed
run means a broken script — check whether the key resolved at all.

**So the request path for Claude Science is the same as for a Codex review:**
leave a brief in `analysis/codex_bridge/inbox/<ID>.md` naming the script and the
arguments, or ask the user. Claude Code runs it and the output lands in the vault.

## Using the semantic index without a key

`embed_vault.py query` needs a key, because the question itself has to be
embedded. But the index is **files in the vault**, so an agent with no key can
still use it:

- `data/derived/vault_index/chunks.jsonl` — one JSON object per chunk with
  `path`, `heading`, `text`. Greppable, and far better than `rg` over the vault
  because chunks carry their section heading.
- `data/derived/vault_index/vectors.npy` — the embedding matrix, row-aligned to
  the JSONL. Usable for similarity between *existing* chunks without any API call.

Rebuild after a batch of writing: `python3.11 analysis/scripts/api/embed_vault.py build --yes`.

## Model choice, and who makes it

`claude-opus-5` is the default for Anthropic work. Choosing a cheaper model is a
judgement about what an answer is worth, which belongs to whoever pays — pass
`--model` deliberately rather than defaulting down to save money.

## Prices

`analysis/scripts/api/prices.json` drives every estimate. The Anthropic rows were
verified 2026-09-20 (Opus 5 $5/$25 per MTok, Sonnet 5 $2/$10, Haiku 4.5 $1/$5);
an earlier version had Opus at $15/$75, wrong by 3x, which is why every dry run
prints the table it used. **The OpenAI rows are still unverified** — their pricing
page does not parse from a CLI. Correct them from the usage dashboard after a run
rather than trusting the file.

## Related

- `analysis/codex-collaboration.md` — the two Codex routes and the bridge
- `analysis/scripts/api/README.md` — implementation notes
- `.claude/codex-review/` — Route 1 state and saved reviews (gitignored)
