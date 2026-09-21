#!/usr/bin/env python3
"""
Read a returned .docx back into the vault: comments, insertions, deletions.

This is the inbound half of `md_to_docx.py`. That script sends a document out;
this one brings the marked-up copy back as markdown, so the edits become
something git can diff, Codex can read, and the Tribunal can be pointed at.
`CLAUDE.md` already promised "analysis/scripts/ has the reader" — it did not,
until now.

WHY NOT A TEXT DIFF. A .docx stores review markup structurally: comments live in
`word/comments.xml` with an author and a timestamp, anchored into the body by
`<w:commentRangeStart>`/`<w:commentRangeEnd>` around the exact run of text they
refer to; tracked edits are `<w:ins>` and `<w:del>` elements wrapping the runs
they affect. Reading those elements gives you precisely what Word's review pane
shows. Inferring the same thing from before/after text does not: a reworded
sentence becomes one deletion plus one insertion, and a marginal comment has no
textual trace at all, so it vanishes entirely. The structural read is the only
one that recovers "what did he want changed, and where."

WHAT IT DOES NOT DO. It does not touch the source markdown. The output is a
review note for you to read and rule on, the same contract the Tribunal follows:
findings are proposals, and applying them is a decision, not a consequence.
Formatting-only changes are invisible, which is intended — a font change is not
an edit to the argument.

    ingest_docx_comments.py <returned.docx>              # review note to stdout
    ingest_docx_comments.py <returned.docx> --out <note.md>
    ingest_docx_comments.py <returned.docx> --json

TRACKED-CHANGES SUPPORT IS UNTESTED ON A REAL RETURNED FILE. The comment path is
exercised (it recovered nine margin comments with their anchors from a Word file
TC marked up by hand). The `<w:ins>`/`<w:del>` path is written from the OOXML
spec and has only been tested on a file with no tracked changes, where it
correctly finds none. Revision markup varies between Word versions and between
Word and Google Docs; expect to fix this the first time a real edited copy
arrives, and check the counts against what the review pane reports.
"""
import json
import re
import sys
import zipfile
from datetime import date
from pathlib import Path
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
P, T, DELTEXT = f"{W}p", f"{W}t", f"{W}delText"
CRS, CRE, CREF = f"{W}commentRangeStart", f"{W}commentRangeEnd", f"{W}commentReference"
INS, DEL, PSTYLE = f"{W}ins", f"{W}del", f"{W}pStyle"


def _text(el) -> str:
    return "".join(t.text or "" for t in el.iter(T))


def _squash(s: str) -> str:
    return " ".join(s.split())


def read(path: Path) -> dict:
    z = zipfile.ZipFile(path)
    names = z.namelist()

    # --- the comments themselves -------------------------------------------
    meta = {}
    if "word/comments.xml" in names:
        for c in ET.fromstring(z.read("word/comments.xml")).findall(f"{W}comment"):
            meta[c.get(f"{W}id")] = {
                "id": c.get(f"{W}id"),
                "author": c.get(f"{W}author"),
                "date": (c.get(f"{W}date") or "")[:10],
                "comment": _squash(_text(c)),
            }

    body = ET.fromstring(z.read("word/document.xml")).find(f"{W}body")

    # --- walk the body in order, so every comment gets its anchor ----------
    spans = {cid: [] for cid in meta}          # text the comment is attached to
    where = {}                                 # heading it sits under
    para_of = {}                               # the paragraph containing it
    open_ids: set[str] = set()
    heading = "(before first heading)"
    ins, dels = [], []

    for para in body.iter(P):
        style = para.find(f".//{PSTYLE}")
        is_head = style is not None and (style.get(f"{W}val") or "").startswith("Heading")
        ptext_parts = []

        for el in para.iter():
            tag = el.tag
            if tag == CRS:
                cid = el.get(f"{W}id")
                open_ids.add(cid)
                where.setdefault(cid, heading)
            elif tag == CRE:
                open_ids.discard(el.get(f"{W}id"))
            elif tag == CREF:
                cid = el.get(f"{W}id")                 # point comment, no range
                where.setdefault(cid, heading)
                para_of.setdefault(cid, None)
            elif tag == T:
                s = el.text or ""
                ptext_parts.append(s)
                for cid in open_ids:
                    spans.setdefault(cid, []).append(s)

        ptext = _squash("".join(ptext_parts))
        for cid in list(open_ids) + [c for c in where if c not in para_of]:
            if ptext:
                para_of.setdefault(cid, ptext)

        # --- tracked changes in this paragraph -----------------------------
        for e in para.iter(INS):
            t = _squash(_text(e))
            if t:
                ins.append({"author": e.get(f"{W}author"), "date": (e.get(f"{W}date") or "")[:10],
                            "section": heading, "text": t})
        for e in para.iter(DEL):
            t = _squash("".join(x.text or "" for x in e.iter(DELTEXT)))
            if t:
                dels.append({"author": e.get(f"{W}author"), "date": (e.get(f"{W}date") or "")[:10],
                             "section": heading, "text": t})

        if is_head and ptext:
            heading = ptext

    comments, orphaned = [], []
    for cid, m in meta.items():
        anchor = _squash("".join(spans.get(cid, [])))
        row = {**m, "section": where.get(cid, "(unanchored)"),
               "anchor": anchor, "paragraph": para_of.get(cid)}
        (comments if anchor else orphaned).append(row)

    comments.sort(key=lambda r: int(r["id"]))
    orphaned.sort(key=lambda r: int(r["id"]))
    return {"file": path.name, "comments": comments, "orphaned": orphaned,
            "insertions": ins, "deletions": dels,
            "authors": sorted({r["author"] for r in comments + orphaned + ins + dels if r["author"]}),
            "read": date.today().isoformat()}


def note(d: dict) -> str:
    who = ", ".join(d["authors"]) or "unknown"
    out = [
        "---", "type: review", "tags: [review, docx-ingest, needs-review]",
        f"source: {d['file']}", f"authors: {who}", f"ingested: {d['read']}",
        "status: awaiting decision — source markdown untouched",
        "---", "",
        f"# Edits returned on `{d['file']}`", "",
        f"Read from the file's own review markup by `analysis/scripts/ingest_docx_comments.py` "
        f"on {d['read']}. Nothing has been applied.", "",
        f"**{len(d['comments'])} comments · {len(d['insertions'])} insertions · "
        f"{len(d['deletions'])} deletions · {len(d['orphaned'])} orphaned**", "",
    ]
    if d["comments"]:
        out += ["## Comments", ""]
        for c in d["comments"]:
            out += [f"### {c['id']} · {c['author']} · {c['date']}",
                    f"**On:** “{c['anchor']}”  ",
                    f"**Section:** {c['section']}", "",
                    f"> {c['comment']}", ""]
    if d["insertions"]:
        out += ["## Insertions", ""]
        out += [f"- *{i['section']}* — **+** “{i['text']}”  ({i['author']})" for i in d["insertions"]]
        out += [""]
    if d["deletions"]:
        out += ["## Deletions", ""]
        out += [f"- *{x['section']}* — **−** “{x['text']}”  ({x['author']})" for x in d["deletions"]]
        out += [""]
    if d["orphaned"]:
        out += ["## Orphaned comments", "",
                "The commented text is gone from the document, so these have no anchor. "
                "Usually it means the passage was deleted after being commented on — read them "
                "against the previous version.", ""]
        for c in d["orphaned"]:
            out += [f"- **{c['author']}** ({c['date']}): {c['comment']}"]
        out += [""]
    if not (d["comments"] or d["insertions"] or d["deletions"] or d["orphaned"]):
        out += ["No comments and no tracked changes found. If the reviewer edited without "
                "tracking changes, this script cannot see it — diff the exported markdown "
                "against the source instead.", ""]
    return "\n".join(out)


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        print("usage: ingest_docx_comments.py <returned.docx> [--out note.md] [--json]",
              file=sys.stderr)
        return 2
    src = Path(args[0]).expanduser()
    if not src.exists():
        print(f"no such file: {src}", file=sys.stderr)
        return 1
    d = read(src)
    if "--json" in sys.argv:
        print(json.dumps(d, indent=2))
        return 0
    text = note(d)
    if "--out" in sys.argv:
        out = Path(sys.argv[sys.argv.index("--out") + 1]).expanduser()
        out.write_text(text)
        print(f"{out}  ({len(d['comments'])} comments, {len(d['insertions'])} ins, "
              f"{len(d['deletions'])} del, {len(d['orphaned'])} orphaned)")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
