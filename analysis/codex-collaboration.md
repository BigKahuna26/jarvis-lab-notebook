---
type: methods
date: 2026-09-17
title: Claude and Codex collaboration routes
tags:
  - methods
  - codex-review
  - tooling
---

# Claude and Codex collaboration routes

Two working routes exist. They differ only in which Claude initiates; Codex always runs on
the host as a read-only second reviewer, per the Codex Review section of [[CLAUDE]].

Deliberately **not** a new folder: state lives in `.claude/codex-review/` (gitignored),
prompts in `analysis/scripts/codex_review_prompts/` (tracked), scripts in
`analysis/scripts/` (tracked), doctrine here. A parallel folder would fragment that.

## Route 1 — Claude Code in the vault (established)

`/codex-review` or `/codex-review <path>`. Backlog tracked by git state via
`analysis/scripts/codex_review.sh`; history in `.claude/codex-review/`. Use for anything
inside the vault: scripts, reports, proposals.

## Route 2 — Claude Science via the bridge (added 2026-09-17)

Claude Science can write host files but cannot run host programs, so a watcher does the
running:

    bash analysis/scripts/codex_bridge_watch.sh ensure     # from the vault, on the host

**The watcher does not time out** (since 2026-09-18, `IDLE_EXIT=0` by default), so there is no window to race: queue the brief whenever it is ready. Do not infer its state from the script default — run `codex_bridge_watch.sh status`, which reports the live pid, start time, idle setting and queue depth from the running process's own state file. A Claude Code `SessionStart` hook starts it, so opening Claude Code in the vault is enough; `analysis/scripts/codex_bridge.launchagent.plist` documents an always-on LaunchAgent and the one Full Disk Access grant it needs.

**There is now a third route: the API tooling** — `analysis/api-tooling.md`. Review, semantic search, bulk audits and the daily consistency sweep run as plain HTTPS calls with no CLI and no watcher. Claude Science cannot run them (keys live outside the vault), so request a run the same way you request a Codex review: a brief in the inbox, or ask the user.

The queue is `<vault>/analysis/codex_bridge/`. `~/Documents/codex_bridge` is a SYMLINK to it,
kept so the older path in earlier notes still works — both names are the same directory, and
replies are git-tracked because they live in the vault.

Then `inbox/<ID>.md` in, `outbox/<ID>.reply.md` out, transcript in `logs/<ID>.log`. First
line may set the working directory:

    <!-- workdir: /abs/path -->

Use for pipelines that live outside the vault, or when the reviewing agent needs the data
object open at the same time.

### Constraints found by testing (2026-09-17)

- **Codex cannot run inside a Claude Science cell.** It sandboxes its own tool calls with
  macOS Seatbelt, which will not initialize inside the already-sandboxed cell: every read
  and write fails with `sandbox_apply: Operation not permitted`. It reports the blocker
  rather than inventing findings, but the run is a no-op that still bills tokens. Same cause
  makes Codex unusable as a Claude Science local-command MCP connector.
- **Codex 0.154.0 has no MCP server mode.** No `mcp-server` subcommand; `codex mcp` is the
  client-side manager for servers Codex consumes. `codex exec` is the entry point.
- **`--skip-git-repo-check`** is needed for a bundle that is not a git repo.
- **TLS, if ever run from a cell:** Codex's Rust trust store rejects the sandbox's inspecting
  proxy (`invalid peer certificate: UnknownIssuer`); `SSL_CERT_FILE` pointed at the
  environment's certifi bundle fixes it. Not needed on the host.
- **`-s workspace-write`**, never `--dangerously-bypass-approvals-and-sandbox`.

### What the watcher grants

While it runs, anything placed in `inbox/` executes as a Codex prompt on this machine under
the Codex account, with write access to the named workdir. A standing capability, not a
per-run approval. Stop it when not in use.

## Which prompt belongs to which route

`codex_review.sh` picks a prompt from the file's category — `classify()` maps
`experiments/*/reports/*.md` to `report`, `proposals/*.md` to `proposal`, and every
in-scope source file to `code` (all code files batch into a single run, which is why
`code.md` is referenced directly rather than through `$c`).

| Prompt | Route | Reached by |
|---|---|---|
| `code.md` | 1 | `/codex-review` — all in-scope source files, batched |
| `report.md` | 1 | `/codex-review` — `experiments/*/reports/*.md` |
| `proposal.md` | 1 | `/codex-review` — `proposals/*.md` |
| `pipeline_statistics.md` | **2 only** | dropped into `codex_bridge/inbox/` by hand |

`pipeline_statistics.md` is deliberately outside the Route 1 router: it reviews a
multi-script pipeline that lives **outside** the vault, and `IN_SCOPE_RE` only matches
vault paths. It will never fire from `/codex-review`, and that is correct. Fill in its
`<design>` block with the replicate structure before sending it — that block is what makes
the pseudoreplication check possible.

## The watcher refuses to start in an agent sandbox

`codex_bridge_watch.sh` probes Seatbelt before starting (`ensure` and `watch` both) and
exits 3 with an explanation if it cannot initialize. This is what stops a Claude Science
cell from launching a watcher that looks healthy, drains nothing, and fills its log with
`sandbox_apply: Operation not permitted`. `SKIP_SEATBELT_CHECK=1` overrides it.

Consequence: **Claude Science cannot start the watcher.** Whoever sends a Route 2 request
either starts it from Terminal / Claude Code first, or asks for it to be started.

## Reading the output

Per [[CLAUDE]]: never auto-apply Codex findings. Verify the checkable ones, attach an
agree/disagree to each, then ask which to fix.

Worked example: `experiments/TC_004_2026-09-04_glycan-receptors-chronic-stim/reports/TC_004_report_codex_pipeline_review.md`
— nine findings, all 19 numeric claims independently reproduced by
`analysis/scripts/tc004_codex_verify.py`, one inference disputed.

**Concordance between Claude and Codex is weak evidence** — shared training data, correlated
blind spots. Disagreement is the useful signal. Point the pair at checkable things (does this
code compute what the caption claims, is this test's unit of observation right) rather than
at whether a hypothesis is plausible.
