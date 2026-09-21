#!/usr/bin/env python3
"""
Markdown -> .docx for documents that leave the vault, via textutil.

WHY NOT PANDOC. It is not installed and this needs no dependency: macOS ships
textutil, which converts HTML to Word format. So the path is markdown -> a
styled HTML document -> textutil -convert docx. The styling lives here rather
than in Word, which means the export is reproducible - the same markdown
produces the same document every time, and a reviewer's copy can be regenerated
from the source that was reviewed rather than from whichever .docx was last
saved.

The markdown is the source. The .docx is an artifact, and it belongs in
~/Downloads rather than the vault - the same rule PDF export follows.

    python3 md_to_docx.py <input.md> [output.docx]
"""
import html
import re
import subprocess
import sys
import zipfile
from pathlib import Path

CSS = """
@page { margin: 0.75in; }
body { font-family: Cambria, Georgia, serif; font-size: 10.5pt; line-height: 1.32;
       color: #000; }
h1 { font-size: 14pt; margin: 0 0 2pt 0; line-height: 1.2; }
h2 { font-size: 11.5pt; margin: 11pt 0 3pt 0; }
h3 { font-size: 10.5pt; margin: 8pt 0 2pt 0; font-style: italic; }
p  { margin: 0 0 6pt 0; text-align: justify; }
.byline { font-style: italic; font-size: 9.5pt; margin: 0 0 10pt 0; color: #333; }
blockquote { margin: 7pt 0; padding: 6pt 9pt; border-left: 2pt solid #999;
             background: #f4f4f4; font-size: 9.5pt; }
ul { margin: 0 0 6pt 0; padding-left: 16pt; }
li { margin: 0 0 3pt 0; }
code { font-family: Consolas, monospace; font-size: 9.5pt; }
.refs { font-size: 9pt; }
"""


def inline(t: str) -> str:
    t = html.escape(t)
    t = re.sub(r'`([^`]+)`', r'<code>\1</code>', t)
    t = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', t)
    t = re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)', r'<i>\1</i>', t)
    # a wikilink is vault navigation and means nothing to the recipient
    t = re.sub(r'\[\[([^\]|]*\|)?([^\]]+)\]\]', r'\2', t)
    return t


def convert(md: str) -> str:
    body, in_list, first_para = [], False, True
    # frontmatter is vault metadata, not part of the document
    if md.startswith('---'):
        md = md.split('---', 2)[-1]

    for raw in md.splitlines():
        line = raw.rstrip()
        if not line.strip():
            if in_list:
                body.append('</ul>'); in_list = False
            continue
        if line.startswith('- '):
            if not in_list:
                body.append('<ul>'); in_list = True
            body.append(f'<li>{inline(line[2:])}</li>'); continue
        if in_list:
            body.append('</ul>'); in_list = False

        if line.startswith('> '):
            body.append(f'<blockquote>{inline(line[2:])}</blockquote>'); continue
        m = re.match(r'^(#{1,4})\s+(.*)$', line)
        if m:
            lvl = len(m.group(1))
            body.append(f'<h{lvl}>{inline(m.group(2))}</h{lvl}>'); continue
        # the italic line right under the title is the byline
        if first_para and line.startswith('*') and line.endswith('*'):
            body.append(f'<p class="byline">{inline(line)}</p>')
            first_para = False; continue
        first_para = False
        cls = ' class="refs"' if re.match(r'^\d+\.\s', line) else ''
        body.append(f'<p{cls}>{inline(line)}</p>')

    if in_list:
        body.append('</ul>')
    return (f'<!DOCTYPE html><html><head><meta charset="utf-8">'
            f'<style>{CSS}</style></head><body>' + "\n".join(body) + '</body></html>')


def _fallback(md: str, out: Path) -> None:
    """Render without textutil, for callers that cannot reach it.

    `textutil` needs a macOS helper service over XPC. Claude Science runs its
    shell inside a sandbox where that service is unreachable, so the call fails
    with "Couldn't communicate with a helper application" and — because the
    output path is only written on success — silently leaves whatever .docx was
    already there. That failure mode is worse than no export at all: the file's
    timestamp says fresh and its contents are stale.

    So: same markdown in, a .docx out, via python-docx. Fidelity is lower
    (python-docx has no CSS, so the styling below approximates the stylesheet
    above rather than reproducing it, and justification is per-paragraph). It
    is a fallback, not a second supported format — when both paths are
    available, textutil is the one whose output has been eyeballed in Word.
    """
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Inches, Pt

    doc = Document()
    normal = doc.styles['Normal']
    normal.font.name, normal.font.size = 'Cambria', Pt(10.5)
    for s in doc.sections:
        s.left_margin = s.right_margin = s.top_margin = s.bottom_margin = Inches(0.75)
    if md.startswith('---'):
        md = md.split('---', 2)[-1]

    def para(text: str, *, style=None, italic=False, justify=False):
        p = doc.add_paragraph(style=style)
        p.paragraph_format.space_after = Pt(6)
        if justify:
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        for part in re.split(r'(\*\*[^*]+\*\*|(?<!\*)\*[^*]+\*(?!\*)|`[^`]+`)', text):
            if not part:
                continue
            if part.startswith('**'):
                r = p.add_run(part[2:-2]); r.bold = True
            elif part.startswith('`'):
                r = p.add_run(part[1:-1]); r.font.name = 'Consolas'
            elif part.startswith('*'):
                r = p.add_run(part[1:-1]); r.italic = True
            else:
                r = p.add_run(part)
            r.italic = r.italic or italic

    buf: list[str] = []

    def flush():
        nonlocal buf
        if buf:
            para(' '.join(' '.join(buf).split()), justify=True)
        buf = []

    for raw in md.splitlines():
        line = raw.strip()
        # a wikilink means nothing to the recipient — same rule as inline()
        line = re.sub(r'\[\[([^\]|]*\|)?([^\]]+)\]\]', r'\2', line)
        if line.startswith('|'):                      # tables: one row per line
            flush()
            cells = [c.strip() for c in line.strip('|').split('|')]
            if set(''.join(cells)) <= set('-: '):
                continue
            para(' — '.join(c for c in cells if c))
            continue
        if line.startswith('- '):
            flush(); para(line[2:], style='List Bullet'); continue
        if line.startswith('> '):
            flush(); para(line[2:], italic=True); continue
        m = re.match(r'^(#{1,4})\s+(.*)$', line)
        if m:
            flush(); doc.add_heading(m.group(2), min(len(m.group(1)), 4)); continue
        if not line:
            flush(); continue
        buf.append(line)
    flush()
    doc.save(out)


def main() -> None:
    src = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2]).expanduser() if len(sys.argv) > 2 else \
        Path.home() / 'Downloads' / (src.stem + '.docx')
    md = src.read_text()
    tmp = out.with_suffix('.html')
    tmp.write_text(convert(md))

    # WHY THE OUTPUT IS VALIDATED RATHER THAN THE EXIT CODE: inside a sandbox
    # that cannot reach the XPC helper, textutil prints "Couldn't communicate
    # with a helper application" to stderr and STILL EXITS 0, having written
    # nothing. With `check=True` that raises no error, so an earlier .docx at
    # the same path survives with a fresh mtime and stale contents — a
    # document that looks exported and is not. So convert to a scratch path,
    # confirm a real .docx came out of it, and only then move it into place.
    stage = out.with_suffix('.textutil.docx')
    stage.unlink(missing_ok=True)
    r = subprocess.run(['textutil', '-convert', 'docx', '-output', str(stage), str(tmp)],
                       capture_output=True, text=True)
    tmp.unlink()

    def usable(p: Path) -> bool:
        if not p.exists() or p.stat().st_size == 0:
            return False
        try:
            with zipfile.ZipFile(p) as z:
                return bool(z.read('word/document.xml'))
        except Exception:
            return False

    if usable(stage):
        stage.replace(out)
        backend = 'textutil'
    else:
        stage.unlink(missing_ok=True)
        out.unlink(missing_ok=True)      # never leave a stale file looking fresh
        _fallback(md, out)
        why = (r.stderr.strip().splitlines() or [f'exit {r.returncode}, no output'])[-1]
        backend = f'python-docx fallback (textutil unusable here: {why})'
    print(f"{out}  ({out.stat().st_size:,} bytes)  [{backend}]")


if __name__ == '__main__':
    main()
