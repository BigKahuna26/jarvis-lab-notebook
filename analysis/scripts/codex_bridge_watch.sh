#!/bin/bash
# Codex bridge: runs Codex on the host for requests dropped into inbox/.
# Start once in a terminal; it then needs no further human action per exchange.
#   bash analysis/scripts/codex_bridge_watch.sh
# Stop with Ctrl-C. Nothing runs when it is not running.
set -uo pipefail

# THE QUEUE LIVES AT THE VAULT ROOT, not beside the script. `dirname "$0"` put
# inbox/, outbox/, processed/ and logs/ inside analysis/scripts/ - a directory
# that holds scripts - and it did not match the codex_bridge/inbox/ path
# CLAUDE.md documents. BRIDGE_DIR overrides it for a queue somewhere else.
if [ -n "${BRIDGE_DIR:-}" ]; then
  BRIDGE="$BRIDGE_DIR"
else
  # analysis/codex_bridge, NOT the vault root: every root folder here holds
  # notebook content, and a queue directory at root reads as notes in Obsidian's
  # explorer. Living under analysis/ also means the root rule needs no exception.
  _root="$(cd "$(dirname "$0")" && git rev-parse --show-toplevel 2>/dev/null)"
  BRIDGE="${_root:-$(cd "$(dirname "$0")/../.." && pwd)}/analysis/codex_bridge"
fi
CODEX_BIN="${CODEX_BIN:-$HOME/.codex/packages/standalone/current/bin/codex}"
POLL="${POLL:-5}"
SANDBOX="${SANDBOX:-workspace-write}"

# WHERE A BRIEF MAY POINT CODEX. The `<!-- workdir: -->` directive used to accept
# any absolute path, so a brief - written by an agent, or dropped in by anything
# that can write to inbox/ - could hand Codex workspace-write access to the whole
# home directory. The queue is a standing capability; its blast radius should be
# the projects it exists to review. Widen deliberately with BRIDGE_ALLOWED_ROOTS
# (colon-separated).
_vault="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd -P)"   # scripts -> analysis -> vault
ALLOWED_ROOTS="${BRIDGE_ALLOWED_ROOTS:-$_vault:$HOME/Documents/pythonProject10}"

canon() { (cd "$1" 2>/dev/null && pwd -P); }

workdir_allowed() {
  local wd canon_wd r canon_r
  canon_wd="$(canon "$1")"
  [ -n "$canon_wd" ] || return 1
  # canonicalised on both sides, so ../ traversal and symlinks cannot escape
  old_ifs="$IFS"; IFS=:
  for r in $ALLOWED_ROOTS; do
    IFS="$old_ifs"
    canon_r="$(canon "$r")"
    [ -n "$canon_r" ] || continue
    case "$canon_wd" in "$canon_r"|"$canon_r"/*) return 0 ;; esac
    IFS=:
  done
  IFS="$old_ifs"
  return 1
}

mkdir -p "$BRIDGE"/inbox "$BRIDGE"/outbox "$BRIDGE"/processed "$BRIDGE"/logs

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
PIDFILE="$BRIDGE/.watcher.pid"
# 0 = never quit, and that is the default. A 5-second poll loop costs nothing,
# while an idle timeout costs a a race nobody can see: the requester has to
# guess whether the watcher is still alive, and a brief queued a minute late
# lands in a drained queue. Set IDLE_EXIT=<seconds> to opt back in.
IDLE_EXIT="${IDLE_EXIT:-0}"        # seconds with no request before quitting; 0 = never
mode="${1:-watch}"

alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }

# Codex sandboxes its OWN tool calls with macOS Seatbelt, and Seatbelt cannot
# initialize inside an already-sandboxed process - which is what a Claude Science
# cell is. Started there, the watcher looks healthy, drains nothing, and fills its
# log with `sandbox_apply: Operation not permitted`. Refuse up front instead:
# whoever starts this must be on the host (Terminal, or Claude Code).
require_seatbelt() {
  [ "${SKIP_SEATBELT_CHECK:-0}" = 1 ] && return 0
  if /usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true 2>/dev/null; then
    return 0
  fi
  echo "[bridge] REFUSING TO START: macOS Seatbelt cannot initialize here." >&2
  echo "[bridge] Codex sandboxes its own tool calls; every read and write would" >&2
  echo "[bridge] fail with 'sandbox_apply: Operation not permitted'." >&2
  echo "[bridge] Start this on the host - Terminal, or Claude Code - not from an" >&2
  echo "[bridge] agent sandbox. Override with SKIP_SEATBELT_CHECK=1 only if you" >&2
  echo "[bridge] know Seatbelt is available." >&2
  exit 3
}

case "$mode" in
  ensure)
    # START ON DEMAND, so nobody has to remember to run this. A LaunchAgent is
    # not an option here: macOS Full Disk Access blocks launchd jobs that touch
    # ~/Documents, which is why the nightly git backup and the auto-sweep were
    # abandoned. Instead whoever sends a request calls `ensure` first; it is
    # idempotent, and the watcher exits by itself once it has gone quiet.
    if alive; then echo "[bridge] already running (pid $(cat "$PIDFILE"))"; exit 0; fi
    require_seatbelt
    nohup "$SELF" watch >> "$BRIDGE/logs/watcher.log" 2>&1 &
    echo $! > "$PIDFILE"
    if [ "$IDLE_EXIT" = 0 ]; then _idle_msg="no idle timeout"; else _idle_msg="idle timeout ${IDLE_EXIT}s"; fi
    echo "[bridge] started (pid $!), $_idle_msg -> $BRIDGE/logs/watcher.log"
    exit 0 ;;
  stop)
    if ! alive; then echo "[bridge] not running"; exit 0; fi
    _pid="$(cat "$PIDFILE")"
    kill "$_pid" 2>/dev/null
    # Confirm it is gone before claiming so; escalate if it is not.
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$_pid" 2>/dev/null || break; sleep 0.5; done
    if kill -0 "$_pid" 2>/dev/null; then
      kill -9 "$_pid" 2>/dev/null; sleep 0.5
      kill -0 "$_pid" 2>/dev/null && { echo "[bridge] FAILED to stop pid $_pid" >&2; exit 1; }
      echo "[bridge] stopped (SIGKILL) pid $_pid"
    else
      echo "[bridge] stopped pid $_pid"
    fi
    rm -f "$PIDFILE"
    exit 0 ;;
  status)
    if ! alive; then echo "[bridge] not running"; exit 0; fi
    echo "[bridge] running (pid $(cat "$PIDFILE")), queue $BRIDGE"
    if [ -f "$BRIDGE/.watcher.state" ]; then
      awk -F= '{ printf "[bridge]   %-10s %s\n", $1, $2 }' "$BRIDGE/.watcher.state"
      _idle="$(awk -F= '$1=="idle_exit"{print $2}' "$BRIDGE/.watcher.state")"
      [ "$_idle" = 0 ] && echo "[bridge]   idle_exit  0 means it does not time out"
    fi
    echo "[bridge]   queued     $(ls "$BRIDGE"/inbox/*.md 2>/dev/null | wc -l | tr -d ' ') request(s) waiting"
    exit 0 ;;
  watch) : ;;
  *) echo "usage: codex_bridge_watch.sh [watch|ensure|stop|status]" >&2; exit 2 ;;
esac

require_seatbelt

if [ ! -x "$CODEX_BIN" ]; then
  echo "[bridge] FATAL: codex not executable at $CODEX_BIN" >&2
  echo "[bridge] set CODEX_BIN=/path/to/codex and retry" >&2
  exit 1
fi

echo "[bridge] watching $BRIDGE/inbox  (poll ${POLL}s, sandbox=$SANDBOX)"
echo "[bridge] codex: $CODEX_BIN"

echo $$ > "$PIDFILE"
# The requester cannot read this process's environment, so record the settings
# where `status` can show them - guessing from the script default is what made
# a live 8-hour watcher look like a dead 30-minute one.
printf 'pid=%s\nstarted=%s\nidle_exit=%s\npoll=%s\nqueue=%s\n' \
  "$$" "$(date '+%Y-%m-%d %H:%M:%S')" "$IDLE_EXIT" "$POLL" "$BRIDGE" > "$BRIDGE/.watcher.state"
# A TERM handler that only cleans up and returns leaves the watcher ALIVE while
# `stop` reports success - and the next `ensure`, seeing no pidfile, starts a
# second watcher competing for the same replies. Clean up on EXIT; make the
# signals exit.
cleanup() { rm -f "$PIDFILE"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

last_activity="$(date +%s)"
while true; do
  for req in "$BRIDGE"/inbox/*.md; do
    [ -e "$req" ] || continue
    id="$(basename "$req" .md)"

    # NEVER REUSE AN ID. Every artifact is keyed on the basename, so re-dropping
    # a request with a name already used would truncate the earlier reply, log,
    # metadata and processed brief - deleting the evidence a report cites. Now
    # that briefs are git-tracked, that loss would be committed too.
    if [ -e "$BRIDGE/outbox/$id.reply.md" ] || [ -e "$BRIDGE/processed/$id.md" ]; then
      newid="$id-$(date +%Y%m%d%H%M%S)"
      mv "$req" "$BRIDGE/inbox/$newid.md"
      req="$BRIDGE/inbox/$newid.md"
      echo "[bridge] id '$id' already has artifacts - processing as '$newid'"
      id="$newid"
    fi

    # Skip a file still being written: require its size to be stable.
    s1=$(wc -c <"$req" 2>/dev/null || echo 0); sleep 1
    s2=$(wc -c <"$req" 2>/dev/null || echo 0)
    [ "$s1" = "$s2" ] && [ "$s2" -gt 0 ] || continue

    # Optional first-line directive: <!-- workdir: /abs/path -->
    workdir="$(sed -n 's/^<!-- *workdir: *\(.*[^ ]\) *-->.*/\1/p' "$req" | head -1)"
    if [ -z "$workdir" ] || [ ! -d "$workdir" ]; then workdir="$BRIDGE"; fi

    if ! workdir_allowed "$workdir"; then
      # Refuse, do not silently retarget: a brief that asked for the wrong place
      # should be answered, not quietly run somewhere else.
      { echo "REFUSED — workdir outside the allowed roots."
        echo
        echo "    requested : $workdir"
        echo "    allowed   : $ALLOWED_ROOTS"
        echo
        echo "Nothing was run. Point the brief inside an allowed root, or set"
        echo "BRIDGE_ALLOWED_ROOTS deliberately before starting the watcher."
      } > "$BRIDGE/outbox/$id.reply.md"
      printf '{"id":"%s","exit":null,"refused":"workdir","requested_workdir":"%s","finished_at":"%s"}\n' \
        "$id" "$workdir" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$BRIDGE/outbox/$id.meta.json"
      mv "$req" "$BRIDGE/processed/$id.md"
      echo "[bridge] REFUSED $id: workdir outside allowlist -> $workdir"
      continue
    fi

    # WHICH REVIEWER. Claude Science cannot run either CLI - Codex refuses to
    # nest its Seatbelt sandbox inside the cell, and TLS interception in that
    # environment blocks chatgpt.com outright - so the bridge is its only route
    # to both. Default stays codex; a brief opts in with:
    #     <!-- reviewer: gemini -->
    #     <!-- files: proposals/x.md analysis/scripts/y.py -->
    # With `files:` the Gemini run is the BLINDED third opinion (the bundle is
    # built by third_opinion.sh, which refuses to include any Codex review or
    # bridge reply). Without it, the brief text is sent as written and the
    # blinding is NOT enforced - the reply and meta say which one happened,
    # because "a third opinion" that read the second opinion is a different
    # thing wearing the same name.
    reviewer="$(sed -n 's/^<!-- *reviewer: *\([a-z][a-z]*\) *-->.*/\1/p' "$req" | head -1)"
    [ -z "$reviewer" ] && reviewer=codex
    files="$(sed -n 's/^<!-- *files: *\(.*[^ ]\) *-->.*/\1/p' "$req" | head -1)"
    blinded="n/a"

    echo "[bridge] $id -> $reviewer (workdir=$workdir)"
    start=$(date +%s)
    # A REVIEW OF A MOVING TARGET IS WORSE THAN NO REVIEW. REQ-th2-design-005400
    # ran 20:56-21:12 while the script it reviewed was edited at 21:05: four of
    # its findings described code that no longer existed, and nothing in the
    # reply said so. Snapshot the repo before and after, and say so on the reply
    # itself if anything moved.
    snap_before="$( { git -C "$workdir" rev-parse HEAD; git -C "$workdir" status --porcelain; } 2>/dev/null )"
    case "$reviewer" in
      gemini|third-opinion|gemini-cli)
        AGY="${AGY:-$HOME/.local/bin/agy}"
        if ! [ -x "$AGY" ]; then AGY="$(command -v agy || true)"; fi
        if [ -z "$AGY" ] || ! [ -x "$AGY" ]; then
          echo "agy not installed on the host" > "$BRIDGE/outbox/$id.reply.md"
          rc=127
        elif [ -n "$files" ]; then
          # Blinded path: one definition of the rules, shared with the CLI route.
          blinded="yes"
          ( cd "$_vault" && bash analysis/scripts/third_opinion.sh $files ) \
            > "$BRIDGE/outbox/$id.reply.md" 2> "$BRIDGE/logs/$id.log"
          rc=$?
        else
          blinded="no"
          _sbx="$(mktemp -d)"
          ( cd "$_sbx" && "$AGY" --model "${GEMINI_MODEL:-gemini-3.8-flash-high}" \
              --sandbox --disable-slash-commands --print-timeout 900s \
              -p "$(cat "$req")" ) \
            > "$BRIDGE/outbox/$id.reply.md" 2> "$BRIDGE/logs/$id.log"
          rc=$?
          rm -rf "$_sbx"
        fi ;;
      *)
        ( cd "$workdir" && "$CODEX_BIN" exec --skip-git-repo-check -s "$SANDBOX" \
            -o "$BRIDGE/outbox/$id.reply.md" - < "$req" ) \
            > "$BRIDGE/logs/$id.log" 2>&1
        rc=$? ;;
    esac
    dur=$(( $(date +%s) - start ))
    snap_after="$( { git -C "$workdir" rev-parse HEAD; git -C "$workdir" status --porcelain; } 2>/dev/null )"
    changed=""
    if [ "$snap_before" != "$snap_after" ]; then
      # EXCLUDE THE BRIDGE'S OWN TRAFFIC. The reply, meta, log and processed
      # brief are written by this loop, so they always differ between the two
      # snapshots - REQ-th2-fixes-0448 warned that its own reply file had
      # changed mid-review. A warning that fires on every run teaches everyone
      # to ignore the one that matters.
      bridge_rel="${BRIDGE#"$workdir"/}"
      changed="$(diff <(printf '%s\n' "$snap_before") <(printf '%s\n' "$snap_after") |
                 grep '^[<>]' | awk '{ print $NF }' | sort -u |
                 grep -v "^${bridge_rel}/" | paste -sd', ' -)"
    fi
    if [ -n "$changed" ]; then
      { echo
        echo "---"
        echo "> [!warning] Files changed while this review was running"
        echo "> The working tree moved between $(date -r $start +%H:%M:%S) and $(date +%H:%M:%S):"
        echo "> \`$changed\`"
        echo "> Findings that cite those paths may describe code that no longer exists."
        echo "> Re-check each against the current file before acting on it."
      } >> "$BRIDGE/outbox/$id.reply.md"
      echo "[bridge] WARNING $id: tree changed during the run -> $changed"
    fi

    # `reviewer` and `blinded` are part of the record, not decoration: a finding
    # is worth a different amount depending on whether the critic had seen the
    # other critic, and six weeks later the reply alone cannot tell you.
    printf '{"id":"%s","exit":%d,"seconds":%d,"reviewer":"%s","blinded":"%s","workdir":"%s","finished_at":"%s","changed_during_run":"%s"}\n' \
      "$id" "$rc" "$dur" "$reviewer" "$blinded" "$workdir" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$changed" \
      > "$BRIDGE/outbox/$id.meta.json"

    mv "$req" "$BRIDGE/processed/$id.md"
    echo "[bridge] $id done  exit=$rc  ${dur}s  -> outbox/$id.reply.md"
    last_activity="$(date +%s)"
  done

  # Quit when nothing has arrived for a while. The next `ensure` starts a fresh
  # watcher, so an idle process never lingers against the poll loop.
  if [ "$IDLE_EXIT" -gt 0 ] && [ $(( $(date +%s) - last_activity )) -ge "$IDLE_EXIT" ]; then
    echo "[bridge] idle ${IDLE_EXIT}s - exiting; the next request starts a new watcher"
    exit 0
  fi
  sleep "$POLL"
done
