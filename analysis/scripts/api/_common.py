#!/usr/bin/env python3
"""
Shared plumbing for the API-credit scripts: keys, cost estimates, spend cap, ledger.

WHY THIS EXISTS SEPARATELY. The credits are finite and they expire, so every
script here has to answer "what will this cost?" BEFORE it spends anything, and
"what has it cost so far?" afterwards. Putting that in one place means a new
script inherits the guard rails instead of re-inventing them - and means a wrong
price is wrong in exactly one file.

Nothing here calls an API. Import it, call `estimate`, print `dry_run_report`,
then let the caller decide.
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
VAULT = HERE.parents[2]                      # api -> scripts -> analysis -> vault
LEDGER = VAULT / ".claude" / "api_ledger.jsonl"
PRICES = json.loads((HERE / "prices.json").read_text())

# A tokenizer would be exact, but it would also make every script depend on a
# provider SDK just to print an estimate.
#
# MEASURED, NOT ASSUMED. The first real sweep sent 304,008 characters and the
# API billed 124,265 input tokens - 2.45 chars/token, not the 4 I had assumed,
# so the estimate came in at 61% of the true cost. Diffs and code tokenize far
# denser than prose: punctuation, indentation and identifiers each cost a token.
# Re-measure from .claude/api_ledger.jsonl when a run records actual usage.
CHARS_PER_TOKEN = {"prose": 4.0, "code": 3.0, "diff": 2.45}
DEFAULT_KIND = "prose"


class MissingKey(RuntimeError):
    pass


def api_key(provider: str) -> str:
    """Key from the environment only. Never read from a file in the vault: the
    vault is a git repo that pushes to GitHub."""
    var = {"openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY",
           "google": "GEMINI_API_KEY"}[provider]
    key = os.environ.get(var, "").strip()
    if not key:
        raise MissingKey(
            f"{var} is not set.\n"
            f"  export {var}='...'   (add it to your shell profile, not to a vault file)\n"
            f"  Every script here runs --dry-run without a key, so you can cost a job first."
        )
    return key


def estimate_tokens(text: str, kind: str = DEFAULT_KIND) -> int:
    """`kind` picks the density: "prose" for notes, "code" for scripts, "diff"
    for git output. Guessing high is the safe direction for a spend guard."""
    return max(1, int(len(text) / CHARS_PER_TOKEN.get(kind, 4.0)))


@dataclass
class Estimate:
    model: str
    in_tokens: int = 0
    out_tokens: int = 0
    batch: bool = False
    items: int = 1
    kind: str = DEFAULT_KIND
    notes: list[str] = field(default_factory=list)

    @property
    def usd(self) -> float:
        m = effective_price(self.model)
        cost = (self.in_tokens / 1e6) * m["in"] + (self.out_tokens / 1e6) * m["out"]
        if self.batch:
            cost *= PRICES["batch_discount"]
        return cost


def effective_price(model: str) -> dict:
    """The rate in force today. Gemini's introductory pricing doubles on
    2027-01-01, and a table that keeps quoting the old number past that date
    would understate every estimate exactly when a bill starts growing. The
    scheduled rate is carried in prices.json and applied when the date arrives."""
    m = PRICES["models"][model]
    sched = m.get("_scheduled_increase")
    if sched and datetime.now(timezone.utc).date().isoformat() >= sched["on"]:
        return {**m, "in": sched["in"], "out": sched["out"], "_active_schedule": sched["on"]}
    return m


def dry_run_report(est: Estimate, what: str) -> None:
    m = effective_price(est.model)
    print(f"\n── DRY RUN · {what} ──")
    print(f"  model        {est.model}  ({m['provider']})")
    print(f"  items        {est.items}")
    print(f"  tokens in    {est.in_tokens:,}   (estimated, {est.kind} density)")
    print(f"  tokens out   {est.out_tokens:,} (assumed)")
    print(f"  price used   ${m['in']}/M in, ${m['out']}/M out"
          + ("  x0.5 batch" if est.batch else ""))
    print(f"  ESTIMATE     ${est.usd:,.2f}")
    sched = PRICES["models"][est.model].get("_scheduled_increase")
    if sched and "_active_schedule" not in m:
        print(f"  heads up     rate rises to ${sched['in']}/${sched['out']} on {sched['on']}")
    for n in est.notes:
        print(f"  note         {n}")
    print("  prices come from analysis/scripts/api/prices.json — verify before the first real run\n")


def guard(est: Estimate, max_usd: float, yes: bool) -> None:
    """Refuse to spend more than the caller allowed. The default cap is low on
    purpose: an accidental whole-vault run should fail, not surprise you."""
    if est.usd > max_usd:
        sys.exit(f"REFUSED: estimated ${est.usd:,.2f} exceeds --max-usd ${max_usd:,.2f}. "
                 f"Raise the cap deliberately if that is the job you meant.")
    if not yes:
        sys.exit("Stopping before spending. Re-run with --yes once the estimate looks right.")


def record(job: str, model: str, usd: float, detail: dict | None = None) -> None:
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    row = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "job": job, "model": model, "usd": round(usd, 4)}
    if detail:
        row.update(detail)
    with LEDGER.open("a") as fh:
        fh.write(json.dumps(row) + "\n")


def spent_total() -> float:
    if not LEDGER.exists():
        return 0.0
    return sum(json.loads(l)["usd"] for l in LEDGER.read_text().splitlines() if l.strip())


def add_common_args(ap) -> None:
    ap.add_argument("--dry-run", action="store_true", help="estimate and stop (no key needed)")
    ap.add_argument("--yes", action="store_true", help="actually spend")
    ap.add_argument("--max-usd", type=float, default=5.0, help="refuse above this estimate")


if __name__ == "__main__":
    print(f"vault:  {VAULT}")
    print(f"ledger: {LEDGER}  (spent so far: ${spent_total():,.2f})")
    for name, m in PRICES["models"].items():
        print(f"  {name:<24} {m['provider']:<10} ${m['in']}/M in  ${m['out']}/M out")
