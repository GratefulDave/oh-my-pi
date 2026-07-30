#!/usr/bin/env zsh
set -euo pipefail

repo_dir="${0:A:h}"
maintenance_dir="${LEX_MAINTENANCE_HOME:-${repo_dir:h}/lex-maintenance}"
maintenance_script="$maintenance_dir/scripts/rebuild-lex.zsh"

if [[ ! -x "$maintenance_script" ]]; then
	printf 'error: Lex maintenance tool unavailable: %s\n' "$maintenance_script" >&2
	printf 'Clone GratefulDave/lex-maintenance beside this checkout or set LEX_MAINTENANCE_HOME.\n' >&2
	exit 2
fi

exec "$maintenance_script" --repo "$repo_dir" "$@"
