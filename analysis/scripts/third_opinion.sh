#!/usr/bin/env bash
# Third opinion via the Gemini CLI, on the subscription rather than API credits.
#
# This is to Gemini what `codex_review.sh` is to Codex: the CLI runs on a plan
# you already pay for, so a checkpoint review costs nothing and there is no
# ledger entry to reconcile. `analysis/scripts/api/third_opinion_gemini.py` is
# the same review through the metered API - keep it for when the CLI is not
# logged in, or when a run has to happen without a human at the browser.
#
# THE BLINDING IS THE POINT, AND AN AGENTIC CLI THREATENS IT. Gemini CLI can
# open files on its own, and the vault it would be pointed at contains every
# Codex review and bridge reply. A critic that reads those grades the review
# instead of the work and agrees far too often. Two guards, because instructions
# alone are not a control:
#   1. The bundle is built by the Python script, which REFUSES blinded paths -
#      one definition of the rule, shared by both routes.
#   2. The CLI is run from an empty temp directory, so its working tree contains
#      nothing to wander into. It is handed the work and nothing else.
#
#   bash analysis/scripts/third_opinion.sh proposals/TC_004_TH3_*.md
#   bash analysis/scripts/third_opinion.sh --check        # auth + model only
set -euo pipefail

VAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="${PYTHON:-/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11}"
BUNDLER="$VAULT/analysis/scripts/api/third_opinion_gemini.py"
OUT_ROOT="$VAULT/.claude/third-opinion"
# agy also serves claude-* and gpt-oss-* models. Picking one would quietly
# undo the entire architecture: the third opinion is worth having because it is
# a DIFFERENT model family from the two that already agreed, not because it is
# a third API call. Guarded below rather than left to whoever edits this next.
MODEL="${GEMINI_MODEL:-gemini-3.8-flash-high}"
case "$MODEL" in
  claude-*|gpt-*)
    echo "REFUSED: $MODEL is not an independent opinion here - Claude already" >&2
    echo "  reviewed this, and Codex is the OpenAI family. Use a gemini-* model" >&2
    echo "  (agy models) or the point of the third reviewer is lost." >&2
    exit 2 ;;
esac

# GCA = Gemini Code Assist: the subscription path, as opposed to a metered
# GEMINI_API_KEY. The CLI refuses to start without an auth method chosen, and
# in a non-interactive shell that refusal reads like a hang, so the script
# picks the one this vault means rather than leaving it to the environment.
export GOOGLE_GENAI_USE_GCA="${GOOGLE_GENAI_USE_GCA:-true}"

# Antigravity CLI, not gemini-cli: on 2026-09-20 Google retired gemini-cli for
# individual accounts mid-setup - "This client is no longer supported for Gemini
# Code Assist for individuals. Please migrate to the Antigravity suite." The
# subscription was never the problem; the client was.
AGY="${AGY:-$HOME/.local/bin/agy}"
if ! [ -x "$AGY" ]; then
  AGY="$(command -v agy || true)"
fi
if [ -z "$AGY" ] || ! [ -x "$AGY" ]; then
  echo "agy not found.  curl -fsSL https://antigravity.google/cli/install.sh | bash" >&2
  exit 2
fi

if [ "${1:-}" = "--check" ]; then
  echo "agy      $("$AGY" --version 2>/dev/null || echo '?')"
  echo "model    $MODEL"
  _out="$("$AGY" -p 'reply with exactly: ok' --print-timeout 90s 2>&1 || true)"
  if printf '%s' "$_out" | grep -qi '\bok\b'; then
    echo "status   ok - headless calls work on the subscription"
  else
    echo "status   FAILED. The CLI said:"
    printf '%s\n' "$_out" | head -4 | sed 's/^/         /'
    echo "         -> sign in by running agy once in a REAL terminal window."
    echo "            Backgrounded processes lose stdin, so the prompt never gets your answer."
  fi
  exit 0
fi

[ $# -ge 1 ] || { echo "usage: third_opinion.sh <path> [<path> ...]" >&2; exit 2; }

stamp="$(date -u +%Y%m%d-%H%M%S)"
out="$OUT_ROOT/$stamp"
mkdir -p "$out"

# Build and blind. A refusal here (exit 1 with REFUSED) must stop the run.
if ! "$PY" "$BUNDLER" "$@" --bundle-only > "$out/sent.txt" 2>"$out/notes.txt"; then
  cat "$out/notes.txt" >&2
  rm -rf "$out"
  exit 1
fi

sandbox="$(mktemp -d)"
trap 'rm -rf "$sandbox"' EXIT

# THE WHOLE BUNDLE GOES IN argv, DELIBERATELY. Handing agy a file to open would
# mean it needs its read tool, which means a permission prompt, which in a
# non-interactive run is an invisible hang. Passing the text means the critic
# needs no tools at all - the strongest form of the blinding, since a model with
# no file access cannot wander into .claude/codex-review/ however it is asked.
_bundle="$(cat "$out/sent.txt")"
if [ "${#_bundle}" -gt 800000 ]; then
  echo "[third-opinion] bundle is ${#_bundle} chars, near the 1MB argv limit." >&2
  echo "[third-opinion] Review fewer files at once." >&2
  exit 1
fi

echo "[third-opinion] $MODEL on $# file(s) · blinded · sandboxed · no tools" >&2
# --sandbox            terminal restrictions
# --disable-slash-commands  the bundle is markdown and may contain lines that
#                      would otherwise be read as slash commands
# no --dangerously-skip-permissions: it may argue, not act
if ! (cd "$sandbox" && "$AGY" --model "$MODEL" --sandbox --disable-slash-commands \
        --print-timeout 900s -p "$_bundle") > "$out/opinion.md" 2>"$out/stderr.txt"; then
  echo "[third-opinion] FAILED - stderr tail:" >&2
  tail -5 "$out/stderr.txt" >&2
  echo "[third-opinion] if it mentions auth, run: bash analysis/scripts/third_opinion.sh --check" >&2
  exit 1
fi

# An empty reply that looks like a success is the failure mode that cost $0.82
# on an empty daily_sweep. It costs nothing here, but a silent empty file would
# still read as "the critic had no objections", which is a different claim.
if [ ! -s "$out/opinion.md" ]; then
  echo "[third-opinion] EMPTY reply - not the same thing as 'no objections'." >&2
  tail -5 "$out/stderr.txt" >&2
  exit 1
fi

# RECORD WHAT WAS SEEN, AS A BLOB not a filename. A review covers the text that
# existed when it ran; edit the file afterwards and it must re-enter the
# backlog. This is the same rule codex_review.sh follows, and for the same
# reason - citing yesterday's review as cover for today's draft is exactly the
# failure the blob hash prevents.
mkdir -p "$VAULT/.claude/third-opinion"
for _f in "$@"; do
  _rel="${_f#"$VAULT"/}"
  printf '%s\t%s\t%s\n' "$_rel" "$(git -C "$VAULT" hash-object "$_rel" 2>/dev/null || echo UNKNOWN)" "$stamp" \
    >> "$VAULT/.claude/third-opinion/reviewed.tsv"
done

cat "$out/opinion.md"
printf '\n[third-opinion] saved to %s (subscription, no API spend)\n' "${out#"$VAULT"/}" >&2
printf '[third-opinion] objections, not instructions - resolve with evidence, expect some to be wrong\n' >&2
