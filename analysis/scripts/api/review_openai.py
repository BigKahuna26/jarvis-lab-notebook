#!/usr/bin/env python3
"""
Second-reviewer pass over the vault through the OpenAI API, with no CLI in the way.

WHY THIS EXISTS. The Codex-CLI route needs a host-side watcher, a queue, a
Seatbelt guard and a live session, because `codex exec` sandboxes its own tool
calls and cannot run inside another sandbox. None of that is inherent to getting
a second opinion - it is the cost of driving a CLI. A plain HTTPS call has no
watcher, no queue, no session, and runs several documents at once. It is also the
fallback when the ChatGPT Pro window closes.

THE ONE REAL DIFFERENCE, and the reason this file is more than a POST. Codex
EXPLORES: it greps, opens files, follows references. An API call cannot. So the
evidence has to be assembled and handed over, and what gets left out silently
becomes what the reviewer cannot see. Each class below names its bundle, and any
truncation is stated in the prompt so the model reports on what it actually got.

    python3.11 analysis/scripts/api/review_openai.py --pending --dry-run
    python3.11 analysis/scripts/api/review_openai.py proposals/X.md --yes
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

PROMPTS = C.VAULT / "analysis/scripts/codex_review_prompts"
OUT_ROOT = C.VAULT / ".claude/codex-review/history"
ENDPOINT = "https://api.openai.com/v1/chat/completions"
MODEL = "gpt-5.4"
PER_FILE_CAP = 120_000        # characters; a 120k-char file is ~30k tokens
BUNDLE_CAP = 400_000

# What each class needs in front of it, beyond the file itself. These are the
# documents Codex reaches for on its own; an API call gets them or reviews blind.
CONTEXT = {
    "report": ["protocols/report-document-contract.md",
               "analysis/skills/flow-report-integrity/SKILL.md"],
    "proposal": ["templates/proposal.md"],
    "code": [],
}


def read_capped(path: Path, cap: int = PER_FILE_CAP, number: bool = False) -> tuple[str, bool]:
    """`number` prefixes each line with its number. Without it the reviewer can
    only write "line ~151", because it is reading a blob of text with no line
    structure - the bake-off against Codex showed exactly that gap, since Codex
    opens the file and can cite the line. Numbers cost ~6 characters a line and
    make every finding checkable."""
    try:
        text = path.read_text(errors="replace")
        if number:
            text = "\n".join(f"{i:>5}| {ln}" for i, ln in enumerate(text.splitlines(), 1))
    except OSError as e:
        return f"[unreadable: {e}]", False
    if len(text) <= cap:
        return text, False
    half = cap // 2
    return text[:half] + f"\n\n[... {len(text) - cap:,} characters elided ...]\n\n" + text[-half:], True


def frontmatter_refs(path: Path) -> list[str]:
    """A proposal's declared sources are part of its evidence: without them the
    reviewer cannot check a single traceability claim.

    ONLY the source keys. Matching any frontmatter item that starts `- TC_`
    swept in every other list a proposal carries - supersedes, related, tags -
    and each one was read at up to 90k characters and pushed in FRONT of the
    document under review. The bundle cap then cut the tail, which is the
    document itself. Codex found this by reading this file: a proposal had been
    reviewed through line 225 of 1,418, and the verdict looked entirely normal.
    """
    keys = ("source_report", "source_reports")
    refs, inside, current = [], False, None
    for line in path.read_text(errors="replace").splitlines()[:40]:
        if line.strip() == "---":
            if inside:
                break
            inside = True
            continue
        if not inside:
            continue
        stripped = line.strip()
        if stripped.startswith("- "):
            if current in keys:                     # a list item under a source key
                refs.append(stripped[2:].strip())
            continue
        if ":" in stripped:                         # any other key ends the list
            current, _, value = stripped.partition(":")
            current = current.strip()
            if current in keys and value.strip():
                refs.append(value.strip())
    return [r.strip("[]'\"") for r in refs if r.strip("[]'\"")]


def resolve_ref(stem: str) -> Path | None:
    hits = [p for p in C.VAULT.rglob(f"{stem}.md") if ".git" not in p.parts]
    return hits[0] if hits else None


def bundle(cls: str, paths: list[Path], base: str | None) -> tuple[str, list[str]]:
    """Assemble everything the reviewer is allowed to see, and say what was cut.

    THE FILE UNDER REVIEW IS NEVER THE THING THAT GETS CUT. Context is optional
    - a reviewer without the proposal template writes a weaker review - but a
    reviewer holding half the document writes a confident review of a document
    that does not exist. So the target is assembled first and claims its budget,
    and context is fitted into whatever remains.
    """
    notes = []

    # 1. The targets, in full, first - they set the budget everything else lives in.
    targets = []
    for p in paths:
        text, cut = read_capped(p, number=True)
        targets.append(f"<file path=\"{p.relative_to(C.VAULT)}\">\n{text}\n</file>")
        if cut:
            notes.append(f"WARNING: {p.name} exceeds the {PER_FILE_CAP:,}-char per-file cap "
                         f"and was elided in the middle - findings about the elided region "
                         f"cannot be trusted")
    target_len = sum(len(t) + 2 for t in targets)
    budget = BUNDLE_CAP - target_len
    if budget < 0:
        notes.append(f"WARNING: the files under review alone are {target_len:,} chars, over the "
                     f"{BUNDLE_CAP:,} cap - no context was sent; review fewer files at once")
        budget = 0

    # 2. Context and declared sources, fitted into what is left.
    context = []

    def add(tag: str, attr: str, path: Path, cap: int, label: str):
        nonlocal budget
        if budget <= 0:
            notes.append(f"{label} DROPPED - no budget left after the files under review")
            return
        text, cut = read_capped(path, min(cap, budget))
        block = f"<{tag} {attr}>\n{text}\n</{tag}>"
        if len(block) > budget:
            notes.append(f"{label} DROPPED - no budget left after the files under review")
            return
        context.append(block)
        budget -= len(block) + 2
        if cut:
            notes.append(f"{label} truncated to fit")

    for rel in CONTEXT[cls]:
        p = C.VAULT / rel
        if p.exists():
            add("context", f"path=\"{rel}\"", p, 60_000, rel)

    if cls == "proposal":
        for stem in frontmatter_refs(paths[0]):
            src = resolve_ref(stem)
            if src:
                add("source_report", f"path=\"{src.relative_to(C.VAULT)}\"", src, 90_000, stem)
            else:
                notes.append(f"declared source {stem} NOT FOUND in the vault")

    if cls == "code" and base:
        diff = subprocess.run(["git", "diff", base, "--"] + [str(p) for p in paths],
                              cwd=C.VAULT, capture_output=True, text=True).stdout
        if diff.strip():
            keep = min(120_000, max(budget, 0))
            if keep < len(diff):
                notes.append(f"diff truncated to {keep:,} chars")
            if keep:
                context.append(f"<diff since=\"{base}\">\n{diff[:keep]}\n</diff>")
                budget -= keep

    body = "\n\n".join(context + targets)
    assert len(body) <= BUNDLE_CAP or not context, "context was not fitted to the budget"
    return body, notes




def build_prompt(cls: str, paths: list[Path], base: str | None) -> str:
    tpl = (PROMPTS / f"{cls}.md").read_text()
    files_block = "\n".join(f"- {p.relative_to(C.VAULT)}" for p in paths)
    tpl = (tpl.replace("{{BASE}}", base or "the last review")
              .replace("{{FILES}}", files_block)
              .replace("{{FILE}}", str(paths[0].relative_to(C.VAULT))))
    body, notes = bundle(cls, paths, base)
    caveat = (
        "\n\n<how_you_are_seeing_this>\n"
        "You have no filesystem access in this run: everything you may rely on is "
        "included below. Do not claim a file is missing or unreferenced - you cannot "
        "check that here. If a judgement needs something that is not included, say so "
        "and mark the finding as unverified.\n"
        "Each file under review is line-numbered as `   12| text`. Cite the exact line "
        "number in every finding; never write an approximate one.\n"
        + ("Assembly notes: " + "; ".join(notes) + "\n" if notes else "")
        + "</how_you_are_seeing_this>\n\n"
    )
    return tpl + caveat + body


USAGE: list[dict] = []   # actual token counts, filled per call


def call(prompt: str, model: str, key: str) -> str:
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}]}).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            body = json.loads(r.read())
        if body.get("usage"):
            USAGE.append(body["usage"])
        return body["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as e:
        return f"REQUEST FAILED ({e.code}): {e.read().decode(errors='replace')[:800]}"


def pending_scope() -> list[tuple[str, Path]]:
    out = subprocess.run(["bash", "analysis/scripts/codex_review.sh", "pending"],
                         cwd=C.VAULT, capture_output=True, text=True).stdout
    scope = []
    for line in out.splitlines():
        if "\t" in line:
            cls, rel = line.split("\t", 1)
            scope.append((cls, C.VAULT / rel))
    return scope


def classify(path: Path) -> str:
    rel = str(path.relative_to(C.VAULT))
    if rel.startswith("proposals/"):
        return "proposal"
    if rel.endswith(".md"):
        return "report"
    return "code"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="*", help="files to review; omit with --pending")
    ap.add_argument("--pending", action="store_true", help="review the codex_review.sh backlog")
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--base", default=None, help="git ref for the code diff")
    C.add_common_args(ap)
    a = ap.parse_args()

    if a.pending:
        scope = pending_scope()
    else:
        scope = [(classify(C.VAULT / p if not Path(p).is_absolute() else Path(p)),
                  (C.VAULT / p if not Path(p).is_absolute() else Path(p))) for p in a.paths]
    if not scope:
        sys.exit("nothing to review")

    # one job per document, one job for all code - the same shape as Route 1
    code = [p for cls, p in scope if cls == "code"]
    jobs: list[tuple[str, list[Path]]] = [("code", code)] if code else []
    jobs += [(cls, [p]) for cls, p in scope if cls != "code"]

    # NOT HEAD. `git diff HEAD -- <committed file>` is empty, so defaulting here
    # sent every code review the current file and no diff at all - the reviewer
    # itself caught this on its first run. The review tracker already stores the
    # last-reviewed commit; use that, and fall back to HEAD~1 if it is absent.
    base = a.base
    if not base:
        stored = C.VAULT / ".claude/codex-review/base"
        base = stored.read_text().strip() if stored.exists() else ""
    if not base:
        base = subprocess.run(["git", "rev-parse", "HEAD~1"], cwd=C.VAULT,
                              capture_output=True, text=True).stdout.strip()
    prompts = [(cls, paths, build_prompt(cls, paths, base)) for cls, paths in jobs]

    est = C.Estimate(model=a.model, items=len(prompts),
                     in_tokens=sum(C.estimate_tokens(p, "code") for _, _, p in prompts), kind="code",
                     out_tokens=2500 * len(prompts))
    for cls, paths, _ in prompts:
        est.notes.append(f"{cls}: {', '.join(p.name for p in paths)}")
    C.dry_run_report(est, f"OpenAI review of {len(scope)} file(s)")
    if a.dry_run:
        return
    C.guard(est, a.max_usd, a.yes)

    key = C.api_key("openai")
    rid = datetime.now().strftime("api-%Y%m%d-%H%M%S")
    outdir = OUT_ROOT / rid
    outdir.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda t: call(t[2], a.model, key), prompts))

    for (cls, paths, prompt), text in zip(prompts, results):
        label = f"{cls}-{paths[0].stem}"
        (outdir / f"prompt-{label}.md").write_text(prompt)
        (outdir / f"review-{label}.md").write_text(text)
        print(f"\n===== {a.model} review: {cls}, {', '.join(p.name for p in paths)} =====\n{text}\n")

    # Bill from reported usage when the API gave it; the estimate is a guard,
    # not an accounting record.
    m = C.PRICES["models"][a.model]
    tin = sum(u.get("prompt_tokens", 0) for u in USAGE)
    tout = sum(u.get("completion_tokens", 0) for u in USAGE)
    actual = (tin / 1e6) * m["in"] + (tout / 1e6) * m["out"] if USAGE else est.usd
    C.record("review_openai", a.model, actual,
             {"id": rid, "items": len(prompts), "in": tin, "out": tout,
              "estimated": round(est.usd, 4)})
    print(f"saved to {outdir.relative_to(C.VAULT)}   "
          f"({tin:,} in / {tout:,} out actual; ${actual:,.2f} vs ${est.usd:,.2f} estimated; "
          f"ledger total ${C.spent_total():,.2f})")


if __name__ == "__main__":
    main()
