#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_dir"

echo "==> Rebuilding all managed extension bundles and pi-natives"
bun scripts/rebuild-extensions.ts

echo "==> Installing extension symlinks into ~/.omp/agent/extensions/"
bun scripts/install-user-extensions.ts

echo "==> Verifying extension registration"
bun run extensions:smoke:stock

echo ""
echo "Done. Extension bundles are rebuilt and registered."
echo "If you run from source (bun run dev), the changes are live now."
echo "If you use the installed binary (lex/omp), it picks up the symlinked bundles."
