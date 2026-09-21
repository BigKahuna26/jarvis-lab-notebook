#!/bin/bash
# sweep_unfiled.sh — Move stray root-level files in the Jarvis vault into _Unfiled/.
#
# Obsidian resolves [[wikilinks]] by filename (not path), so relocating a file
# between folders does NOT break links as long as its name stays unique.
#
# Files intentionally kept at the vault root are listed in KEEP.
# Only regular files directly at the root (depth 1) are swept — never subfolders,
# never dotfiles (.obsidian, .git, .gitignore, …). Files touched in the last
# minute are left alone to avoid racing a note you're actively creating/renaming.
set -euo pipefail

VAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRAWER="$VAULT/_Unfiled"
KEEP=("dashboard.md" "README.md")

mkdir -p "$DRAWER"

shopt -s nullglob
moved=0
for path in "$VAULT"/*; do
    [ -f "$path" ] || continue                      # only regular files at root
    name="$(basename "$path")"

    keep=0
    for k in "${KEEP[@]}"; do
        [ "$name" = "$k" ] && keep=1
    done
    [ "$keep" -eq 1 ] && continue

    # Only sweep files untouched for >1 min (don't grab a brand-new file mid-rename)
    [ -n "$(find "$path" -maxdepth 0 -mmin +1 2>/dev/null)" ] || continue

    target="$DRAWER/$name"
    if [ -e "$target" ]; then                        # collision — timestamp the mover
        if [[ "$name" == *.* ]]; then
            target="$DRAWER/${name%.*}_$(date +%Y%m%d%H%M%S).${name##*.}"
        else
            target="$DRAWER/${name}_$(date +%Y%m%d%H%M%S)"
        fi
    fi

    mv "$path" "$target"
    moved=$((moved+1))
    echo "$(date '+%Y-%m-%d %H:%M:%S') moved: $name -> $(basename "$target")"
done

[ "$moved" -gt 0 ] && echo "$(date '+%Y-%m-%d %H:%M:%S') swept $moved file(s) into _Unfiled/"
exit 0
