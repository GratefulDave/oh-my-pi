#!/usr/bin/env bash
set -euo pipefail

echo "factory verify script placeholder for __FACTORY_REPO_NAME__"
echo
echo "Replace this file with repo-specific oracle commands."
echo "Recommended starting points:"
__FACTORY_VERIFY_COMMANDS__
echo
echo "Contract:"
echo "- exit 0 when verification passes"
echo "- exit non-zero on real failure"
echo "- print concise failure evidence"
echo
echo "Current state: placeholder only. Verifier must treat this as oracle gap."
exit 2
