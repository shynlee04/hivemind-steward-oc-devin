#!/usr/bin/env bash
# Build the public tree: tracked files at HEAD minus every .publicignore path.
# The export is a filter, never a transform — fixtures are scrubbed in-repo so
# the public tree is byte-identical to the dev tree outside .publicignore.
# Usage: scripts/sync-public.sh <dest-dir>
set -euo pipefail

src="$(git rev-parse --show-toplevel)"
dest="${1:?usage: sync-public.sh <dest-dir>}"
mkdir -p "$dest"

git -C "$src" archive HEAD | tar -x -C "$dest"

while IFS= read -r path; do
  path="${path%%#*}"
  path="${path#"${path%%[![:space:]]*}"}"
  path="${path%/}"
  [ -z "$path" ] && continue
  rm -rf "${dest:?}/$path"
done < "$src/.publicignore"

find "$dest" -type d -empty -delete 2>/dev/null || true
echo "public tree: $(find "$dest" -type f | wc -l | tr -d ' ') files -> $dest"
