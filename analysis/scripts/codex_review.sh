#!/usr/bin/env bash
# Codex as a second reviewer: track what Codex has not yet seen, and run it.
#
# REVIEWED: code and analysis scripts, experiment reports, proposals.
# NEVER REVIEWED: notes, day files, data files, figures. A CSV cannot be judged
# without re-running the analysis, so data is reviewed through the script that
# made it; report-number drift is already owned by the verifier suite.
#
# WHY GIT STATE, NOT TOOL CALLS. The earlier latch (codex_review_latch.sh)
# recorded Edit/Write paths, so a script patched with sed or a report rebuilt by
# its generator never counted. Comparing the tree against the last-reviewed state
# catches every writer. The vault auto-commits every 30-60 min, so the comparison
# starts from a stored commit - never HEAD~1, which a backup commit can move.
#
# State (gitignored), under .claude/codex-review/:
#   base          commit the last full-backlog review started from
#   reviewed.tsv  path<TAB>blob - each file as Codex last saw it
#   notified      backlog paths last announced, so a backlog is not re-announced
#   inflight/<id> a review's frozen scope and rendered prompts
#   history/<id>  finished reviews, with Codex's output kept
#
# Modes:
#   pending            print "<class><TAB><path>" for each unreviewed file
#   notify             Stop hook: one systemMessage when the backlog gains a file
#   begin [paths...]   freeze a scope (the whole backlog if no paths); prints its id
#   run <id>           run Codex read-only on that scope and print the reviews
#   resume <id>        print + commit a run that finished but was interrupted
#   abort <id>         discard a frozen scope
#
# bash 3.2 compatible: macOS /bin/bash is what hooks run under.

set -uo pipefail

root="$(command git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" || exit 0
state="$root/.claude/codex-review"
prompts="$root/analysis/scripts/codex_review_prompts"

git() { command git -c core.quotepath=off "$@"; }
die() { echo "codex_review: $*" >&2; exit 1; }

# code | report | proposal | nothing (out of scope).
classify() {
  case "$1" in
    */_jcc_backup_*|*.backup.js|*/__pycache__/*) ;;
    *.py|*.sh|*.R|*.r|*.js|*.mjs|*.cjs|*.ts|*.tsx|*.jsx|*.ipynb) echo code ;;
    .obsidian/plugins/jarvis-command-center/styles.css|.obsidian/snippets/*.css) echo code ;;
    experiments/*/reports/*.md) echo report ;;
    proposals/*.md) echo proposal ;;
  esac
}
# Prefilter, so a long diff of notes never reaches the per-file loop.
IN_SCOPE_RE='\.(py|sh|R|r|js|mjs|cjs|ts|tsx|jsx|ipynb|css)$|^experiments/.*/reports/.*\.md$|^proposals/.*\.md$'

base() {
  local b
  b="$(cat "$state/base" 2>/dev/null)"
  if [ -z "$b" ] || ! git cat-file -e "$b^{commit}" 2>/dev/null; then
    # First run, or history rewritten: start with an empty backlog at HEAD.
    mkdir -p "$state" || return 1
    b="$(git rev-parse HEAD)" || return 1
    printf '%s\n' "$b" > "$state/base"
  fi
  printf '%s\n' "$b"
}

# A DELETED FILE IS STILL A CHANGE TO REVIEW. The first version skipped
# anything not on disk, so removing a script dropped it from the backlog and a
# whole-backlog review could pass without anyone asking whether the deletion
# took a guard or a validation step with it. Codex caught this on its first run,
# citing the deletion of codex_review_latch.sh by this very tool.
blob_of() {
  if [ -f "$1" ]; then git hash-object -- "$1"; else echo DELETED; fi
}

reviewed_blob() {
  [ -f "$state/reviewed.tsv" ] || return 0
  awk -F'\t' -v p="$1" '$1 == p { h = $2 } END { print h }' "$state/reviewed.tsv"
}

pending() {
  local b p c
  b="$(base)" || return 0
  { git diff --name-only "$b" --; git ls-files --others --exclude-standard; } |
    grep -E "$IN_SCOPE_RE" | sort -u |
    while IFS= read -r p; do
      c="$(classify "$p")"; [ -n "$c" ] || continue
      [ "$(blob_of "$p")" = "$(reviewed_blob "$p")" ] && continue
      printf '%s\t%s\n' "$c" "$p"
    done
}

notify() {
  cat >/dev/null                                    # drain the hook payload
  command -v jq >/dev/null 2>&1 || return 0
  local list paths summary names n msg
  list="$(pending)"
  if [ -z "$list" ]; then rm -f "$state/notified"; return 0; fi
  paths="$(printf '%s\n' "$list" | cut -f2 | sort)"
  # Announce only when the backlog gains a file. Further edits to a file already
  # announced, or a shrinking backlog, stay quiet - a notice every turn is noise.
  if [ -f "$state/notified" ] &&
     [ -z "$(printf '%s\n' "$paths" | comm -13 "$state/notified" -)" ]; then
    printf '%s\n' "$paths" > "$state/notified"
    return 0
  fi
  printf '%s\n' "$paths" > "$state/notified"
  summary="$(printf '%s\n' "$list" | cut -f1 | sort | uniq -c |
    awk '{ s = ($1 > 1 && $2 != "code") ? "s" : ""; printf "%s%d %s%s", (NR > 1 ? ", " : ""), $1, $2, s }')"
  n="$(printf '%s\n' "$list" | grep -c .)"
  names="$(printf '%s\n' "$list" | cut -f2 | sed 's|.*/||' | head -3 |
    awk '{ printf "%s%s", (NR > 1 ? ", " : ""), $0 }')"
  [ "$n" -gt 3 ] && names="$names, +$((n - 3)) more"
  msg="Codex review pending: $summary ($names). Run /codex-review for a second reviewer."
  jq -n --arg m "$msg" '{systemMessage: $m}'
}

begin() {
  local b head id dir full=0 p rel c
  b="$(base)" || die "not a git repository"
  head="$(git rev-parse HEAD)"
  id="$(date +%Y%m%d-%H%M%S)-$$"
  dir="$state/inflight/$id"
  mkdir -p "$dir" || die "cannot create $dir"
  if [ $# -eq 0 ]; then
    full=1
    pending > "$dir/scope.raw"
  else
    : > "$dir/scope.raw"
    for p in "$@"; do
      rel="${p#"$root"/}"; rel="${rel#./}"
      [ -f "$rel" ] || { rm -rf "$dir"; die "not found: $p"; }
      c="$(classify "$rel")"
      if [ -z "$c" ]; then
        case "$rel" in
          *.md) c=report ;;
          *) rm -rf "$dir"
             die "$rel is not code, a report, or a proposal. Review the script that produced it instead." ;;
        esac
      fi
      printf '%s\t%s\n' "$c" "$rel" >> "$dir/scope.raw"
    done
  fi
  if [ ! -s "$dir/scope.raw" ]; then
    rm -rf "$dir"
    echo "Nothing pending review."
    return 0
  fi
  sort -u "$dir/scope.raw" | while IFS=$'\t' read -r c p; do
    printf '%s\t%s\t%s\n' "$c" "$p" "$(blob_of "$p")"
  done > "$dir/scope.tsv"
  rm -f "$dir/scope.raw"
  printf '%s\n' "$b" > "$dir/base"
  printf '%s\n' "$head" > "$dir/head"
  printf '%s\n' "$full" > "$dir/full"
  echo "id $id"
  cut -f1,2 "$dir/scope.tsv"
}

# Fill {{BASE}}, {{FILE}} and {{FILES}} by plain substring splicing, so paths
# containing & or | survive (sed and awk gsub treat both as special).
render() {
  BASE="$1" FILE="$2" FILES="$3" awk '
    function fill(s, t, v,    i, out) {
      out = ""
      while ((i = index(s, t)) > 0) { out = out substr(s, 1, i - 1) v; s = substr(s, i + length(t)) }
      return out s
    }
    { line = fill($0, "{{BASE}}", ENVIRON["BASE"])
      line = fill(line, "{{FILES}}", ENVIRON["FILES"])
      print fill(line, "{{FILE}}", ENVIRON["FILE"]) }' "$4"
}

companion() {
  ls -d "$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null |
    sort -V | tail -1
}

print_job() {
  local dir="$1" nn="$2" rc
  echo "===== Codex review: $(cat "$dir/label-$nn") ====="
  rc="$(cat "$dir/rc-$nn" 2>/dev/null || echo 1)"
  if [ "$rc" = 0 ] && [ -s "$dir/review-$nn.md" ]; then
    cat "$dir/review-$nn.md"; echo
    return 0
  fi
  echo "FAILED (exit $rc)"
  tail -n 20 "$dir/stderr-$nn.log" 2>/dev/null
  echo
  return 1
}

commit() {
  local dir="$1"
  touch "$state/reviewed.tsv"
  awk -F'\t' 'NR == FNR { seen[$2] = 1; next } !($1 in seen)' \
    "$dir/scope.tsv" "$state/reviewed.tsv" > "$state/reviewed.tmp"
  cut -f2,3 "$dir/scope.tsv" >> "$state/reviewed.tmp"
  mv "$state/reviewed.tmp" "$state/reviewed.tsv"
  # Only a whole-backlog review may move the base. Moving it after a single-file
  # review would drop committed-but-unreviewed files off the backlog.
  [ "$(cat "$dir/full")" = 1 ] && cp "$dir/head" "$state/base"
  rm -f "$state/notified"
  mkdir -p "$state/history" && mv "$dir" "$state/history/"
}

run() {
  local id="${1:-}" dir cc b files j nn pf c p rc ok=1
  dir="$state/inflight/$id"
  { [ -n "$id" ] && [ -f "$dir/scope.tsv" ]; } || die "no frozen scope '$id'. Run: codex_review.sh begin"
  cc="$(companion)"; [ -n "$cc" ] || die "Codex plugin not found. Run /codex:setup."
  command -v node >/dev/null 2>&1 || die "node is not on PATH"
  b="$(cat "$dir/base")"
  rm -f "$dir"/prompt-* "$dir"/label-* "$dir"/review-* "$dir"/stderr-* "$dir"/rc-*

  # One Codex run for all code (a change often spans files); one per document.
  files="$(awk -F'\t' '$1 == "code" { print ($3 == "DELETED") \
      ? "- " $2 "   (DELETED since base - review the removal in the diff)" : "- " $2 }' "$dir/scope.tsv")"
  if [ -n "$files" ]; then
    render "$b" "" "$files" "$prompts/code.md" > "$dir/prompt-00.md"
    echo "code, $(printf '%s\n' "$files" | grep -c .) file(s)" > "$dir/label-00"
  fi
  j=1
  while IFS=$'\t' read -r c p h; do
    [ "$c" = code ] && continue
    # A deleted document has nothing to read; it is marked reviewed, not sent.
    if [ "$h" = DELETED ]; then echo "skipped (deleted): $p"; continue; fi
    nn="$(printf '%02d' "$j")"
    render "$b" "$p" "" "$prompts/$c.md" > "$dir/prompt-$nn.md"
    echo "$c, $p" > "$dir/label-$nn"
    j=$((j + 1))
  done < "$dir/scope.tsv"

  for pf in "$dir"/prompt-*.md; do
    nn="${pf##*/prompt-}"; nn="${nn%.md}"
    ( node "$cc" task --prompt-file "$pf" > "$dir/review-$nn.md" 2> "$dir/stderr-$nn.log"
      echo $? > "$dir/rc-$nn" ) &
  done

  # PRINT EACH REVIEW THE MOMENT IT LANDS, rather than after every job. A long
  # code review should not hold back a finished document review, and when the
  # run is killed mid-flight - which happened on the first real run - whatever
  # finished is already on screen instead of sitting unread in inflight/.
  printed=""
  while :; do
    waiting=0
    for pf in "$dir"/prompt-*.md; do
      nn="${pf##*/prompt-}"; nn="${nn%.md}"
      if [ -f "$dir/rc-$nn" ]; then
        case " $printed " in
          *" $nn "*) ;;
          *) print_job "$dir" "$nn" || ok=0; printed="$printed $nn" ;;
        esac
      else
        waiting=1
      fi
    done
    [ "$waiting" = 0 ] && break
    sleep 2
  done
  wait

  if [ "$ok" = 1 ]; then
    commit "$dir"
    echo "Marked reviewed. Saved to .claude/codex-review/history/$id/"
  else
    echo "Not marked reviewed. Retry: bash analysis/scripts/codex_review.sh run $id"
    return 1
  fi
}

# A run killed after Codex finished but before the bookkeeping leaves finished
# reviews stranded in inflight/. `resume` prints and commits them without
# spending another Codex call.
resume() {
  local id="${1:-}" dir ok=1 pf nn
  dir="$state/inflight/$id"
  [ -n "$id" ] && [ -f "$dir/scope.tsv" ] || die "no frozen scope '$id'"
  # Nothing to resume when the run never started: say so rather than letting
  # print_job cat a label file that was never written.
  ls "$dir"/prompt-*.md >/dev/null 2>&1 || die "scope '$id' was frozen but never run. Use: run $id"
  for pf in "$dir"/prompt-*.md; do
    nn="${pf##*/prompt-}"; nn="${nn%.md}"
    # ok=0, not ok=1. print_job already checks BOTH the exit code and that the
    # review is non-empty; assigning 1 here threw its verdict away, so a run that
    # exited 0 with an empty review committed the scope and advanced the base
    # with no findings in hand - the one outcome this guard exists to prevent.
    print_job "$dir" "$nn" || ok=0
  done
  if [ "$ok" = 1 ]; then
    commit "$dir"
    echo "Marked reviewed. Saved to .claude/codex-review/history/$id/"
  else
    echo "Some runs never finished. Re-run: bash analysis/scripts/codex_review.sh run $id"
    return 1
  fi
}

abort() { [ -n "${1:-}" ] && rm -rf "$state/inflight/$1"; }

mode="${1:-}"
[ $# -gt 0 ] && shift
case "$mode" in
  pending) pending ;;
  notify)  notify || true; exit 0 ;;      # a hook must never break the session
  begin)   begin ${1+"$@"} ;;
  run)     run ${1+"$@"} ;;
  resume)  resume ${1+"$@"} ;;
  abort)   abort ${1+"$@"} ;;
  *) echo "usage: codex_review.sh pending | notify | begin [paths...] | run <id> | resume <id> | abort <id>" >&2; exit 2 ;;
esac
