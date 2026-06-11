#!/usr/bin/env bash
# Pull latest upstream OMP and rebase fork commits on top.
# Run from repo root. Conflicts pause for manual resolution.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

echo "==> Fetching upstream (can1357/oh-my-pi)..."
git fetch upstream

# Stash dirty working tree if any
if ! git diff-index --quiet HEAD --; then
	echo "==> Stashing dirty working tree..."
	git stash push -m "auto-stash before upstream rebase $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	STASHED=1
else
	STASHED=0
fi

echo "==> Rebasing onto upstream/main..."
if git rebase upstream/main; then
	echo "==> Rebase succeeded."
else
	echo "==> Rebase paused with conflicts. Resolve, then:"
	echo "    git rebase --continue"
	echo "    git stash pop  (if stashed)"
	echo "    ./rebuild-lex.zsh"
	exit 1
fi

if [[ $STASHED -eq 1 ]]; then
	echo "==> Restoring stashed changes..."
	git stash pop || echo "NOTE: stash pop had conflicts — resolve manually"
fi

echo ""
echo "==> Done. Rebuild:"
echo "    ./rebuild-lex.zsh"
