#!/usr/bin/env python3
"""
Whole-vault audits through the Batch API, at half price and all at once.

WHY BATCH. The failures this vault keeps hitting are not one-document problems.
A number quoted from a table no report prints; a figure with no builder; a claim
that outruns its evidence - each was found one document at a time, by a review
that happened to look. There are 21 reports and proposals. Auditing all of them
interactively costs attention; as a batch it costs a few cents and returns while
you do something else.

TWO AUDITS, BOTH AIMED AT A FAILURE THAT ACTUALLY HAPPENED HERE:
  numbers  every figure quoted in prose, and whether the document names where it
           came from - the TH1 traceability failure, applied everywhere
  claims   sentences that assert more than the cited evidence supports - the
           "transcript measured as a glycan" class

NOT AN LLM JOB, so deliberately absent: "does this figure have a generating
script" is a filesystem question. Deterministic checks belong in the verifier
suite, where they cannot hallucinate.

    python3.11 analysis/scripts/api/audit_batch.py numbers --dry-run
    python3.11 analysis/scripts/api/audit_batch.py numbers --yes      # submits
    python3.11 analysis/scripts/api/audit_batch.py fetch <batch_id>
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

OUT = C.VAULT / "data/derived/vault_audits"
MODEL = "gpt-5.4-mini"
API = "https://api.openai.com/v1"

AUDITS = {
    "numbers": (
        "You are auditing one lab document for number provenance.\n"
        "List every quantitative claim in the prose (effect sizes, counts, percentages, p-values, "
        "resource totals). For each, say whether the document names a source for it — a table, a "
        "file, another report, a named analysis — or whether it appears without provenance.\n"
        "Return a Markdown table: value | where it appears (section) | source named in the document "
        "| sourced?  Then one line: how many of N values name a source.\n"
        "You cannot open other files. Judge only what this document states about its own sources.\n"
    ),
    "claims": (
        "You are auditing one lab document for claims that outrun their evidence.\n"
        "Find sentences that assert more than what is cited supports: a measurement claimed from a "
        "proxy, causal language over correlational data, 'no effect' from a non-significant test, "
        "equivalence from a failure to reject, replication claimed across different comparisons.\n"
        "For each: quote the sentence, name the overreach in one clause, and give a rewrite that "
        "keeps the finding but not the overreach. Severity high/medium/low. If none, say so.\n"
    ),
}


def targets() -> list[Path]:
    return sorted([*(C.VAULT / "proposals").glob("*.md"),
                   *C.VAULT.glob("experiments/*/reports/*.md")])


def build_requests(audit: str, model: str) -> list[dict]:
    reqs = []
    for p in targets():
        text = p.read_text(errors="replace")[:180_000]
        reqs.append({
            "custom_id": str(p.relative_to(C.VAULT)),
            "method": "POST", "url": "/v1/chat/completions",
            "body": {"model": model, "messages": [
                {"role": "user", "content": AUDITS[audit] + f"\n\n<document path=\"{p.relative_to(C.VAULT)}\">\n{text}\n</document>"}]},
        })
    return reqs


def post(path: str, payload: bytes, key: str, ctype: str = "application/json") -> dict:
    req = urllib.request.Request(f"{API}{path}", data=payload,
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def cmd_run(a) -> None:
    reqs = build_requests(a.audit, a.model)
    est = C.Estimate(model=a.model, items=len(reqs), batch=True,
                     in_tokens=sum(C.estimate_tokens(json.dumps(r)) for r in reqs),
                     out_tokens=1500 * len(reqs))
    est.notes.append(f"{len(reqs)} documents; results land asynchronously")
    C.dry_run_report(est, f"batch audit: {a.audit}")
    if a.dry_run:
        return
    C.guard(est, a.max_usd, a.yes)

    OUT.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    jsonl = OUT / f"{a.audit}-{stamp}.requests.jsonl"
    jsonl.write_text("\n".join(json.dumps(r) for r in reqs))

    key = C.api_key("openai")
    # Upload, then submit. Two steps, because the Batch API takes a file id.
    boundary = "----jarvisbatch"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nbatch\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{jsonl.name}\"\r\n"
            f"Content-Type: application/jsonl\r\n\r\n").encode() + jsonl.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    up = post("/files", body, key, f"multipart/form-data; boundary={boundary}")
    batch = post("/batches", json.dumps({"input_file_id": up["id"], "endpoint": "/v1/chat/completions",
                                         "completion_window": "24h"}).encode(), key)
    (OUT / f"{a.audit}-{stamp}.batch.json").write_text(json.dumps(batch, indent=2))
    C.record(f"audit_batch:{a.audit}", a.model, est.usd, {"batch_id": batch.get("id"), "items": len(reqs)})
    print(f"submitted batch {batch.get('id')} ({len(reqs)} documents)\n"
          f"  fetch with: python3.11 analysis/scripts/api/audit_batch.py fetch {batch.get('id')}")


def cmd_fetch(a) -> None:
    key = C.api_key("openai")
    req = urllib.request.Request(f"{API}/batches/{a.batch_id}", headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        b = json.loads(r.read())
    print(f"status: {b['status']}  ({b.get('request_counts')})")
    if b["status"] != "completed":
        return
    req = urllib.request.Request(f"{API}/files/{b['output_file_id']}/content",
                                 headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        lines = r.read().decode().splitlines()
    OUT.mkdir(parents=True, exist_ok=True)
    dest = OUT / f"{a.batch_id}.results.md"
    with dest.open("w") as fh:
        for line in lines:
            row = json.loads(line)
            content = row["response"]["body"]["choices"][0]["message"]["content"]
            fh.write(f"\n\n## {row['custom_id']}\n\n{content}\n")
    print(f"wrote {dest.relative_to(C.VAULT)}  ({len(lines)} documents)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in AUDITS:
        s = sub.add_parser(name); s.add_argument("--model", default=MODEL); C.add_common_args(s)
        s.set_defaults(fn=cmd_run, audit=name)
    f = sub.add_parser("fetch"); f.add_argument("batch_id"); f.set_defaults(fn=cmd_fetch)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
