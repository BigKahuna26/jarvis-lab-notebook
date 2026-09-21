# API-credit tooling

Four scripts that spend Anthropic/OpenAI API credits on work the subscriptions
cannot do. **Nothing here runs without a key and an explicit `--yes`** — every
script estimates first, refuses above `--max-usd` (default $5), and appends what
it spent to `.claude/api_ledger.jsonl`.

    python3.11 analysis/scripts/api/_common.py        # prices + spend so far

## The division of labour

Claude Max and ChatGPT Pro cover interactive work at zero marginal cost, so
**Claude Code stays on the subscription** — routing it through the API would
burn the credits in days at the rate these sessions run. Credits go to the three
things a subscription cannot do: run without a session, run in bulk, and run
without a CLI.

| Script | Spends | What it buys |
|---|---|---|
| `review_openai.py` | OpenAI | The second reviewer, without the CLI. No watcher, no queue, no Seatbelt guard, no session. Whole backlog ≈ **$0.77**. |
| `embed_vault.py` | OpenAI | Semantic search over 1,257 notes. Full index ≈ **$0.02**. |
| `audit_batch.py` | OpenAI | Every report and proposal audited at once, half price. 22 documents ≈ **$0.06**. |
| `daily_sweep_anthropic.py` | Anthropic | Cross-document contradictions introduced by the day's edits ≈ **$0.47/day**. |

## Verify the prices before the first real run

`prices.json` was written from memory on 2026-09-19 and model pricing moves.
Every `--dry-run` prints the table it used, so a wrong number is visible before
it is spent. Check the two links in that file and correct it once.

## What these replace, and what they do not

`review_openai.py` is the fallback for when ChatGPT Pro lapses, and the better
path regardless: the bridge exists only because `codex exec` sandboxes its own
tool calls and therefore needs a host-side watcher. **Keep both until they have
been run against the same brief and the findings compared** — the API model has
no filesystem access, so it reviews the bundle it is handed, while Codex
explores. That difference is the whole risk, and it is why each prompt states
what was included and what was truncated.

Nothing here does deterministic work. "Does this figure have a generating
script" is a filesystem question and belongs in the verifier suite, where it
cannot hallucinate.

## Scheduling

`daily_sweep_anthropic.py` cannot be a LaunchAgent. launchd jobs are denied
access to `~/Documents` — probed 2026-09-17, `Operation not permitted` — and the
vault lives there. Run it from a Claude Code session hook or by hand, the same
constraint that shapes the bridge watcher.
