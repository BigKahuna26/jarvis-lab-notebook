#!/usr/bin/env python3
"""
Check a document against protocols/document-standards.md, and fix the one rule
that is safe to fix automatically.

A standard nobody can run is a preference. `plotting-standards.md` is enforced
by `_parity_check.py` and friends; this is the equivalent for prose — so the
question "does this draft comply" has a computed answer instead of an opinion.

    doc_compliance.py <file.md>                # report
    doc_compliance.py <file.md> --fix-wrapping # rewrite unwrapped, in place
    doc_compliance.py <file.md> --json

WHAT IS AND IS NOT AUTOMATED. Only D1 (unwrapping) is applied: joining the
lines of a paragraph is a lossless transformation of bytes with no editorial
content. Everything else is reported with locations and left alone —

  D4 (em dash rate) and D5 (paragraph length) cannot be fixed without writing
  new sentences, and a script that silently rewrites a sentence in a fellowship
  essay is doing the author's job without being asked.
  D2 (heading depth) and D7 (apparatus) need a decision about where the content
  goes, not a substitution.

The thresholds live in THRESHOLDS below and come from the measurements recorded
in document-standards.md. Change them there and here together, or the standard
and its checker drift apart — which is the failure mode this script exists to
prevent.
"""
import json
import re
import sys
from pathlib import Path

# from document-standards.md; NSF reference pair measured 3.3-3.4 em dashes per
# 1k words and medians of 85 (technical) / 143 (narrative) words per paragraph
# D5's floor is 70 for a dense technical document, 100 for a narrative one; the
# checker applies the lower bound, since it cannot know which kind it is reading
THRESHOLDS = {"emdash_per_1k": 5.0, "median_para_words": 70, "beat_words": 25,
              "beat_share_max": 0.34, "wrapped_line_lo": 70, "wrapped_line_hi": 105,
              "wrapped_tolerance": 5}

APPARATUS = re.compile(
    r"Fabrication Audit|What changed in Draft|\[YOU[\s:—-]|^\*\(.*words?.*\)\*$|"
    r"Notes before you submit|status: awaiting|\u2039TODO", re.M)
# ‹TODO n› is the marker a working draft carries where an open item belongs. It
# is deliberately caught here: a draft with open items is NOT submission-ready,
# and D7 should keep saying so until every one is answered. The marker's job is
# to make that check mechanical instead of remembered — the full instruction for
# each one lives in the draft's open-items note, not in the document.


def split_frontmatter(text: str) -> tuple[str, str]:
    m = re.match(r"^(---\n.*?\n---\n)(.*)$", text, re.S)
    return (m.group(1), m.group(2)) if m else ("", text)


def is_structural(line: str) -> bool:
    """A line that must keep its own line: heading, table, list, quote, rule."""
    s = line.strip()
    return bool(re.match(r"(#{1,6} |\||> |[-*+] |\d+\. |---$|```)", s)) or not s


CONTINUABLE = re.compile(r"([-*+] |\d+\. |> )")


def unwrap(body: str) -> str:
    """Join the lines of each prose paragraph onto one line. Lossless.

    A list item or block quote carries its wrapped continuation lines onto its
    OWN line rather than orphaning them into a following paragraph. Getting this
    wrong leaves a numbered citation as "1. Park SL, Painter MM, ..." followed by
    a separate line holding the rest of the reference — which markdown still
    renders as one item by lazy continuation, so the damage is invisible in the
    output and obvious in the source.
    """
    out, buf = [], []

    def flush():
        if buf:
            out.append(" ".join(" ".join(buf).split()))
        buf.clear()

    in_fence = False
    for line in body.split("\n"):
        if line.strip().startswith("```"):
            flush(); in_fence = not in_fence; out.append(line); continue
        if in_fence:
            out.append(line); continue
        if is_structural(line):
            if CONTINUABLE.match(line.strip()):
                flush(); buf.append(line.rstrip())      # keep collecting onto it
            else:
                flush(); out.append(line)               # heading, table, rule, blank
            continue
        buf.append(line)
    flush()
    return "\n".join(out)


def audit(text: str) -> dict:
    fm, body = split_frontmatter(text)
    words = len(body.split())
    lines = body.split("\n")
    paras = [p for p in re.split(r"\n\s*\n", body) if p.strip()]
    prose = [p for p in paras if not re.match(r"(#|\||> |[-*+] |\d+\. )", p)]
    # a paragraph that is only a ‹TODO n› placeholder is not prose, and counting
    # it drags the D5 median toward zero — which would make a document look
    # WORSE for having its open items enumerated rather than inlined
    prose = [p for p in prose if not re.fullmatch(r"\s*\u2039TODO \d+\u203a\s*", p)]
    # A paragraph that is ENTIRELY a bold span is a section label, not prose —
    # per D2 that is how a short funder statement marks its sections, so counting
    # `**Intellectual Merit**` as a 2-word paragraph would make a correctly
    # formatted NSF statement fail the paragraph-length rule.
    labels = [p for p in prose if re.fullmatch(r"\s*\*\*[^*]+\*\*[.:]?\s*", p)]
    prose = [p for p in prose if p not in labels]
    # A deliberate single-sentence beat is exempt from the median; a document
    # that is MOSTLY beats is the failure this rule is actually looking for.
    beats = [p for p in prose if len(p.split()) < THRESHOLDS["beat_words"]]
    # NB: not `body` — that name already holds the document text in this scope
    body_paras = [p for p in prose if len(p.split()) >= THRESHOLDS["beat_words"]] or prose
    beat_share = len(beats) / len(prose) if prose else 0.0
    wl = sorted(len(p.split()) for p in body_paras) or [0]
    median = wl[len(wl) // 2]
    # A line is only evidence of WRAPPING if the paragraph continues on the next
    # line. A short single-line paragraph that happens to be 80 characters long
    # is not wrapped, and counting it makes the rule unsatisfiable.
    def continues(i: int) -> bool:
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        return bool(nxt.strip()) and not re.match(
            r"(#{1,6} |\||---$|```)", nxt.strip())

    wrapped = [i + 1 for i, l in enumerate(lines)
               if THRESHOLDS["wrapped_line_lo"] < len(l) <= THRESHOLDS["wrapped_line_hi"]
               and not is_structural(l) and continues(i)]
    deep = [(i + 1, l.strip()) for i, l in enumerate(lines) if re.match(r"#{3,6} ", l.strip())]
    em = 1000 * body.count("—") / words if words else 0.0
    appar = [(body[:m.start()].count("\n") + 1, m.group(0)[:48]) for m in APPARATUS.finditer(body)]
    tables = [i + 1 for i, l in enumerate(lines) if l.strip().startswith("|")]

    # Document class decides which rules apply. D1, D2 and D6 are scoped by the
    # standard to documents that LEAVE the vault; a protocol note legitimately
    # uses ### rule headings, tables, and wrapped prose. A checker that flags
    # those is a checker nobody runs, so the class comes from frontmatter
    # `type:` — draft/proposal/manuscript are deliverables, everything else
    # (protocol, reference, review, finding, experiment) is a vault note.
    doc_type = ""
    mt = re.search(r"^type:\s*(\S+)", fm, re.M)
    if mt:
        doc_type = mt.group(1).strip().lower()
    deliverable = doc_type in {"draft", "proposal", "manuscript", "statement", ""}

    rules = {
        "D1 prose unwrapped": (len(wrapped) <= THRESHOLDS["wrapped_tolerance"],
                               f"{len(wrapped)} wrapped prose lines"),
        "D2 two heading levels": (not deep, f"{len(deep)} headings at ### or deeper"),
        "D4 em dash rate": (em <= THRESHOLDS["emdash_per_1k"], f"{em:.1f} per 1,000 words"),
        "D5 paragraph length": (median >= THRESHOLDS["median_para_words"]
                                and beat_share <= THRESHOLDS["beat_share_max"],
                                f"median {median} words across {len(body_paras)} body paragraphs; "
                                f"{len(labels)} section labels, {len(beats)} beats "
                                f"({beat_share:.0%} of prose)"),
        "D6 no tables": (not tables, f"{len(tables)} table rows"),
        "D7 no apparatus": (not appar, f"{len(appar)} apparatus markers"),
    }
    if not deliverable:                      # scope-limited rules do not apply
        for k in ("D1 prose unwrapped", "D2 two heading levels", "D6 no tables"):
            rules[k] = (None, rules[k][1] + f"  [n/a — type: {doc_type}]")

    return {"file": None, "words": words, "doc_type": doc_type, "deliverable": deliverable, "rules": {k: {"pass": v[0], "detail": v[1]}
                                                    for k, v in rules.items()},
            # wrapped_lines is truncated for display; wrapped_count is the real
            # total — report the count, never len(wrapped_lines), or a 215-line
            # violation prints as 40
            "wrapped_count": len(wrapped),
            "wrapped_lines": wrapped[:40], "deep_headings": deep,
            "apparatus": appar, "table_lines": tables[:20],
            "para_words_quartiles": [wl[0], wl[len(wl) // 4], median,
                                     wl[3 * len(wl) // 4], wl[-1]]}


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print("usage: doc_compliance.py <file.md> [--fix-wrapping] [--json]", file=sys.stderr)
        return 2
    src = Path(args[0]).expanduser()
    text = src.read_text()

    if "--fix-wrapping" in sys.argv:
        fm, body = split_frontmatter(text)
        fixed = fm + unwrap(body)                 # frontmatter is never reflowed
        before = audit(text)["wrapped_count"]
        src.write_text(fixed)
        after = audit(fixed)["wrapped_count"]
        print(f"{src.name}: unwrapped — wrapped prose lines {before} -> {after}")
        text = fixed

    rep = audit(text)
    rep["file"] = src.name
    if "--json" in sys.argv:
        print(json.dumps(rep, indent=2)); return 0

    print(f"{src.name}  ({rep['words']:,} words)")
    print(f"  class: {rep['doc_type'] or 'unset'} "
          f"({'deliverable — all rules apply' if rep['deliverable'] else 'vault note — D1/D2/D6 n/a'})")
    for name, r in rep["rules"].items():
        mark = "n/a " if r["pass"] is None else ("pass" if r["pass"] else "FAIL")
        print(f"  {mark}  {name:24s} {r['detail']}")
    if rep["deep_headings"]:
        print("  D2 locations:", ", ".join(f"L{n}" for n, _ in rep["deep_headings"]))
    if rep["apparatus"]:
        print("  D7 locations:", ", ".join(f"L{n}" for n, _ in rep["apparatus"]))
    q = rep["para_words_quartiles"]
    print(f"  paragraph words min/Q1/median/Q3/max: {q[0]}/{q[1]}/{q[2]}/{q[3]}/{q[4]}")
    return 0 if all(r["pass"] is not False for r in rep["rules"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
