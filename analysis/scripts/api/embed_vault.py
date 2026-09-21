#!/usr/bin/env python3
"""
Semantic index over the vault: build it once, query it for free afterwards.

WHY. Grep finds the word you thought of. When the D8 report says "the gate
concealed 19 percentage points" and you search for "gating bias", grep returns
nothing. The PaperQA index that used to cover this was deleted in August, and
nothing replaced it - /query-wiki falls through to Consensus for anything the
wiki has not already compiled, which cannot see your own unpublished notes.

Cost is the argument. The vault is ~755k words; embedding all of it is cents,
and queries are a rounding error. Re-embed weekly and it stays cents.

WHAT IT DELIBERATELY DOES NOT DO. No answer generation - it returns passages and
their paths. An index that paraphrases is an index you have to fact-check; this
one hands you the note and lets you read it.

    python3.11 analysis/scripts/api/embed_vault.py build --dry-run
    python3.11 analysis/scripts/api/embed_vault.py build --yes
    python3.11 analysis/scripts/api/embed_vault.py query "why did the gate hide the knockdown"
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

INDEX_DIR = C.VAULT / "data/derived/vault_index"
VECTORS = INDEX_DIR / "vectors.npy"
CHUNKS = INDEX_DIR / "chunks.jsonl"
MODEL = "text-embedding-3-small"
ENDPOINT = "https://api.openai.com/v1/embeddings"
CHUNK_CHARS = 4000
OVERLAP = 400

# Directories whose contents are machine-written, enormous, or both. Indexing
# them buries the notes you actually wrote under generated text.
SKIP = {".git", ".obsidian", "node_modules", "data", "_Unfiled",
        "codex_bridge", "literature/zotero", ".claude"}


def eligible(p: Path) -> bool:
    rel = p.relative_to(C.VAULT)
    return p.suffix == ".md" and not any(part in SKIP for part in rel.parts)


def chunk(text: str) -> list[str]:
    """Split on headings first - a section is the unit a reader wants back -
    then hard-wrap anything still oversized."""
    blocks, cur = [], []
    for line in text.splitlines():
        if line.startswith("#") and sum(len(x) for x in cur) > CHUNK_CHARS // 2:
            blocks.append("\n".join(cur)); cur = []
        cur.append(line)
    blocks.append("\n".join(cur))
    out = []
    for b in blocks:
        if len(b) <= CHUNK_CHARS:
            if b.strip():
                out.append(b)
            continue
        for i in range(0, len(b), CHUNK_CHARS - OVERLAP):
            piece = b[i:i + CHUNK_CHARS]
            if piece.strip():
                out.append(piece)
    return out


def collect() -> list[dict]:
    rows = []
    for p in sorted(C.VAULT.rglob("*.md")):
        if not eligible(p):
            continue
        text = p.read_text(errors="replace")
        for i, ch in enumerate(chunk(text)):
            head = next((l for l in ch.splitlines() if l.startswith("#")), "")
            rows.append({"path": str(p.relative_to(C.VAULT)), "i": i,
                         "heading": re.sub(r"^#+\s*", "", head)[:120], "text": ch})
    return rows


def embed(texts: list[str], key: str, model: str) -> np.ndarray:
    out = []
    for start in range(0, len(texts), 128):          # batch of 128 per request
        batch = texts[start:start + 128]
        req = urllib.request.Request(
            ENDPOINT, data=json.dumps({"model": model, "input": batch}).encode(),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.loads(r.read())["data"]
        out.extend(d["embedding"] for d in sorted(data, key=lambda d: d["index"]))
        print(f"  embedded {min(start + 128, len(texts)):,}/{len(texts):,}", end="\r")
    print()
    return np.asarray(out, dtype=np.float32)


def cmd_build(a) -> None:
    rows = collect()
    est = C.Estimate(model=a.model, items=len(rows),
                     in_tokens=sum(C.estimate_tokens(r["text"]) for r in rows))
    est.notes.append(f"{len({r['path'] for r in rows}):,} notes -> {len(rows):,} chunks")
    C.dry_run_report(est, "embed the vault")
    if a.dry_run:
        return
    C.guard(est, a.max_usd, a.yes)

    vecs = embed([r["text"] for r in rows], C.api_key("openai"), a.model)
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    np.save(VECTORS, vecs)
    with CHUNKS.open("w") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    C.record("embed_vault", a.model, est.usd, {"chunks": len(rows)})
    print(f"index written to {INDEX_DIR.relative_to(C.VAULT)}  ({len(rows):,} chunks)")


def cmd_query(a) -> None:
    if not VECTORS.exists():
        sys.exit("no index yet — run: embed_vault.py build --yes")
    vecs = np.load(VECTORS)
    rows = [json.loads(l) for l in CHUNKS.read_text().splitlines()]
    q = embed([a.question], C.api_key("openai"), a.model)[0]
    sims = vecs @ q / (np.linalg.norm(vecs, axis=1) * np.linalg.norm(q) + 1e-9)
    for rank, idx in enumerate(np.argsort(-sims)[:a.k], 1):
        r = rows[idx]
        snippet = " ".join(r["text"].split())[:280]
        print(f"\n{rank}. {sims[idx]:.3f}  {r['path']}"
              + (f"  §{r['heading']}" if r["heading"] else ""))
        print(f"   {snippet}…")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build"); b.add_argument("--model", default=MODEL); C.add_common_args(b)
    b.set_defaults(fn=cmd_build)
    q = sub.add_parser("query"); q.add_argument("question"); q.add_argument("-k", type=int, default=8)
    q.add_argument("--model", default=MODEL); C.add_common_args(q)
    q.set_defaults(fn=cmd_query)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
