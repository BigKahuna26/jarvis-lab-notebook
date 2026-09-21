#!/usr/bin/env bash
# Consult the Tribunal: both reviewers on one document, in the order that works.
#
# Three judges, and the point is that they are not the same mind. Claude writes
# it; Codex checks the claims against the evidence and the code against what it
# says it does; Gemini reads it cold, having been shown neither Claude's
# reasoning nor Codex's findings. Two agents that talk to each other converge,
# and the defect that survives is the one they agree on - that is the whole
# argument for a third that was not in the room.
#
# ORDER MATTERS, which is why this is a script and not a habit. Codex first: it
# catches the technical and evidentiary defects, and a cold reader spends its
# attention on obvious problems if obvious problems are still there. The third
# opinion last, on a draft that two of us already think is good, is where it is
# worth the most.
#
#   bash analysis/scripts/tribunal.sh proposals/TC_004_TH3_brief_glycan.md
#   bash analysis/scripts/tribunal.sh --codex-only <path>     # skip the cold read
#
# Neither verdict is ever applied on its own authority. The findings come back
# to be verified, argued with, and brought to TC to decide - three reviewers
# means three sets of confident-and-sometimes-wrong claims, and on the first
# blinded run one of three "alternatives never considered" appeared in five
# vault documents.
set -euo pipefail

VAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$VAULT"
codex_only=false
force=false
while :; do
  case "${1:-}" in
    --codex-only) codex_only=true; shift ;;
    --force)      force=true; shift ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || { echo "usage: tribunal.sh [--codex-only] <path> [<path> ...]" >&2; exit 2; }

# PID IN THE NAME, because the in-flight guard lives in one plugin instance.
# Two Obsidian windows, or a click racing the terminal, would otherwise share a
# second-resolution directory and write over each other's verdicts - and an
# interleaved review reads like a coherent one. Codex found this at 0.98; the
# guard covers the common case and this covers the rest.
stamp="$(date -u +%Y%m%d-%H%M%S)-$$"
out=".claude/tribunal/$stamp"
if [ -e "$out" ]; then echo "a sitting is already writing to $out" >&2; exit 1; fi
mkdir -p "$out"
printf '%s\n' "$@" > "$out/files.txt"
for _f in "$@"; do printf '%s %s\n' "$_f" "$(git hash-object "$_f" 2>/dev/null || echo X)"; done > "$out/blobs.txt"

echo "══ THE TRIBUNAL ══ $# document(s)" >&2
echo "   $*" >&2
echo >&2

# ── First judge: Codex, on the evidence ──────────────────────────────────────
echo "[1/2] Codex — claims against evidence…" >&2
id="$(bash analysis/scripts/codex_review.sh begin "$@" 2>/dev/null | sed -n 's/^id //p' | head -1)"
if [ -z "$id" ]; then
  echo "      nothing pending for Codex at this text (already reviewed)" >&2
  echo "nothing pending — already reviewed at this blob" > "$out/codex.md"
else
  if bash analysis/scripts/codex_review.sh run "$id" > "$out/codex.md" 2>&1; then
    echo "      done → $out/codex.md" >&2
  else
    echo "      FAILED (see $out/codex.md)" >&2
  fi
fi

# ── Second judge: Gemini, cold ───────────────────────────────────────────────
if [ "$codex_only" = true ]; then
  echo "[2/2] third opinion SKIPPED (--codex-only)" >&2
else
  # Codex dedupes by blob on its own; make the cold read do the same, or
  # pressing the button twice on an unchanged draft spends a second pass to
  # re-read identical text. --force overrides, because a second cold read of the
  # SAME text is occasionally what you want - it is a different sample, not a
  # cached answer.
  _unseen=false
  for _f in "$@"; do
    _b="$(git hash-object "$_f" 2>/dev/null || echo X)"
    # BASELINE ROWS DO NOT COUNT AS A READING. On 2026-09-20 the backlog was
    # baselined at 24 documents so old work would not queue - a reasonable
    # thing to suppress a NOTICE with. It then suppressed an explicit request:
    # TC pressed Consult the Tribunal on TH3 and got Codex only, silently,
    # because a marker written by that baseline looked like a completed cold
    # read. "Stop nagging me about this" and "refuse to read this when I ask"
    # are different instructions.
    _s="$(awk -F'\t' -v q="$_f" '$1 == q && $3 != "baseline" { h = $2 } END { print h }' \
          .claude/third-opinion/reviewed.tsv 2>/dev/null || true)"
    [ "$_b" = "$_s" ] || _unseen=true
  done
  if [ "$_unseen" = false ] && [ "$force" = false ]; then
    echo "[2/2] third opinion SKIPPED — already read at this exact text (--force to repeat)" >&2
    echo "already read at this blob" > "$out/third_opinion.md"
  else
  echo "[2/2] Third opinion — blinded cold read…" >&2
  if bash analysis/scripts/third_opinion.sh "$@" > "$out/third_opinion.md" 2>"$out/third_opinion.err"; then
    echo "      done → $out/third_opinion.md" >&2
  else
    echo "      FAILED:" >&2
    tail -3 "$out/third_opinion.err" >&2
  fi
  fi
fi

# A REVIEW OF A MOVING TARGET IS WORSE THAN NO REVIEW - the bridge learned this
# when a run described four findings about code that had been edited underneath
# it, and said nothing. Switching FILES during a run is free, because the target
# was fixed at launch; EDITING the judged file is not.
for _f in "$@"; do
  _now="$(git hash-object "$_f" 2>/dev/null || echo X)"
  _then="$(awk -v q="$_f" '$1 == q { print $2 }' "$out/blobs.txt" 2>/dev/null)"
  if [ -n "$_then" ] && [ "$_now" != "$_then" ]; then
    echo "WARNING: $_f changed while it was being judged - findings may cite text that no longer exists" \
      | tee -a "$out/codex.md" >&2
  fi
done

# THE RESULT OUTLIVES THE APP THAT ASKED FOR IT. Obsidian's Notice lasts 15
# seconds and its in-memory state dies with a restart, so a run started before
# bed would otherwise leave no trace but a directory nobody was told about.
# This file is what the panel reads on load and what review_status.sh reports.
cat > .claude/tribunal/latest.json <<JSON
{"dir": "$out",
 "files": "$*",
 "finished_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "codex": $([ -s "$out/codex.md" ] && echo true || echo false),
 "third_opinion": $([ -s "$out/third_opinion.md" ] && echo true || echo false)}
JSON

echo >&2
echo "══ verdicts in $out ══" >&2
echo "Findings are not instructions. Verify each one, attach agree/disagree, then decide." >&2
echo "$out"
