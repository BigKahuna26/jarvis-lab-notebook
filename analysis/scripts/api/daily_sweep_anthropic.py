#!/usr/bin/env python3
"""
Daily integrity sweep over what changed in the vault, via the Anthropic API.

WHY A SEPARATE PATH FROM THE REVIEWER. The Codex/OpenAI reviews answer "is this
document sound?" one document at a time, when asked. This answers a different
question that nobody currently asks: "did today's edits break their agreement
with yesterday's?" That is where this vault actually bleeds - a report corrected
while the proposal deriving from it was not, a table regenerated while the prose
quoting it stayed, a protocol settling a number three documents still contradict.

It reads the diff, not the files, so it stays cheap enough to run every day.

SCHEDULING, HONESTLY. This cannot be a LaunchAgent: launchd jobs are denied
access to ~/Documents (probed 2026-09-17, "Operation not permitted"), and the
vault lives there. Run it from a Claude Code session hook, or by hand. The same
wall that blocks the bridge watcher blocks this.

    python3.11 analysis/scripts/api/daily_sweep_anthropic.py --dry-run
    python3.11 analysis/scripts/api/daily_sweep_anthropic.py --since '2 days ago' --yes
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from datetime import date
from pathlib import Path

import anthropic

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

OUT = C.VAULT / "data/derived/daily_sweeps"
# claude-opus-5 by default. A cheaper model is a judgement about how much
# the answer is worth, which belongs to whoever is paying: --model swaps it.
MODEL = "claude-opus-5"
IN_SCOPE = (".py", ".sh", ".md")
SKIP_PARTS = ("daily-notes/", "codex_bridge/", "data/derived/", ".claude/",
              "_Unfiled/", "_legacy/")   # junk drawer and archived copies are not live documents

PROMPT = """You are the standing consistency check on a PhD lab notebook.

Below is everything that changed in the vault since {since}, as a git diff.

Report ONLY disagreements that the diff itself demonstrates:
- a number, date, or parameter changed in one file while another file still
  states the old value
- a claim corrected in one document that another document still repeats
- a script's output contract changed without its consumer changing
- a correction recorded in one place and contradicted in another

For each: what disagrees, the two locations, and which one looks stale. If the
diff shows no such disagreement, say "no cross-document disagreement in this
window" and stop - do not pad the report with observations about code quality.
You are reading a diff, not the whole vault, so say when a judgement would need
a file you cannot see.

<diff since="{since}">
{diff}
</diff>
"""


def collect_diff(since: str) -> tuple[str, list[str]]:
    names = subprocess.run(["git", "log", f"--since={since}", "--name-only", "--format="],
                           cwd=C.VAULT, capture_output=True, text=True).stdout.split()
    files = sorted({f for f in names if f.endswith(IN_SCOPE)
                    and not any(s in f for s in SKIP_PARTS)})
    if not files:
        return "", []
    diff = subprocess.run(["git", "log", f"--since={since}", "-p", "--format=commit %h %s", "--"] + files,
                          cwd=C.VAULT, capture_output=True, text=True).stdout
    return diff[:600_000], files


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", default="1 day ago")
    ap.add_argument("--model", default=MODEL)
    C.add_common_args(ap)
    a = ap.parse_args()

    diff, files = collect_diff(a.since)
    if not diff:
        print(f"nothing in scope changed since {a.since} — nothing to sweep")
        return

    prompt = PROMPT.format(since=a.since, diff=diff)
    est = C.Estimate(model=a.model, items=1,
                     in_tokens=C.estimate_tokens(prompt, "diff"), out_tokens=6000, kind="diff")
    est.notes.append(f"{len(files)} changed file(s): " + ", ".join(Path(f).name for f in files[:6])
                     + (" …" if len(files) > 6 else ""))
    C.dry_run_report(est, f"daily sweep since {a.since}")
    if a.dry_run:
        return
    C.guard(est, a.max_usd, a.yes)

    # Zero-arg client: the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
    # or an `ant auth login` profile, in that order. Streaming because a whole
    # day's diff is a long input and a non-streaming call can hit the timeout.
    client = anthropic.Anthropic()
    try:
        with client.messages.stream(
            model=a.model,
            # Thinking tokens come out of max_tokens. At 8,000 the first run spent
            # the whole budget reasoning about a 124k-token diff and emitted no
            # text at all - billed $0.82 for an empty report. Give it room, and
            # check stop_reason below rather than trusting that text exists.
            max_tokens=32000,
            thinking={"type": "adaptive"},
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            msg = stream.get_final_message()
    except anthropic.AuthenticationError:
        sys.exit("No usable Anthropic credential. Set ANTHROPIC_API_KEY, or run `ant auth login`.")
    except anthropic.RateLimitError as e:
        sys.exit(f"Rate limited: {e}")
    except anthropic.APIStatusError as e:
        sys.exit(f"API error {e.status_code}: {str(e)[:300]}")

    if msg.stop_reason == "refusal":
        sys.exit("The model declined this request; nothing written.")
    text = "".join(b.text for b in msg.content if b.type == "text")
    if not text.strip():
        sys.exit(f"Model returned no text (stop_reason={msg.stop_reason}, "
                 f"{msg.usage.output_tokens:,} output tokens spent). Raise --max-tokens "
                 f"or narrow --since; nothing written.")
    usage = f"{msg.usage.input_tokens:,} in / {msg.usage.output_tokens:,} out (actual)"

    OUT.mkdir(parents=True, exist_ok=True)
    dest = OUT / f"{date.today()}_sweep.md"
    dest.write_text(f"# Vault consistency sweep — {date.today()}\n\n"
                    f"*Window: {a.since} · {len(files)} changed files · {a.model}*\n\n{text}\n")
    # Bill from the usage the API reports, not from my 4-chars-per-token guess:
    # the ledger should record what was actually spent.
    m = C.PRICES["models"][a.model]
    actual = (msg.usage.input_tokens / 1e6) * m["in"] + (msg.usage.output_tokens / 1e6) * m["out"]
    C.record("daily_sweep", a.model, actual, {"files": len(files), "usage": usage})
    print(text)
    print(f"\nwrote {dest.relative_to(C.VAULT)}  ({usage}; ${actual:,.2f}, "
          f"ledger total ${C.spent_total():,.2f})")


if __name__ == "__main__":
    main()
