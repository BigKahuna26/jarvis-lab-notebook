#!/bin/bash
# Claude Code PostToolUse hook.
# When Claude edits a note under reagents/ (cell lines, reagents, the tracker base),
# tell the jarvis-command-center plugin to reparse those notes so the Bases culture
# tracker updates live — no Cmd+R, no killing the embedded terminal.
#
# Fires via the plugin's custom protocol handler:  obsidian://jcc-refresh-cultures
# Trailing-edge debounced: a burst of edits triggers exactly one refresh (the last one).

input="$(cat)"

# Only act when an edited path is inside reagents/
case "$input" in
  *'/reagents/'*|*'"reagents/'*) ;;
  *) exit 0 ;;
esac

token_file="/tmp/jcc_refresh.token"
stamp="$(date +%s%N)"
printf '%s' "$stamp" > "$token_file"

# Background job: wait for the burst to settle, then refresh only if still the latest edit.
(
  sleep 1.2
  if [ "$(cat "$token_file" 2>/dev/null)" = "$stamp" ]; then
    open "obsidian://jcc-refresh-cultures" >/dev/null 2>&1 || true
  fi
) >/dev/null 2>&1 &

exit 0
