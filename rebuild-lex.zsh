#!/usr/bin/env zsh
set -euo pipefail

repo_dir="${0:A:h}"
binary="$repo_dir/packages/coding-agent/dist/omp"
link_dir="$HOME/.local/bin"
zshrc="$HOME/.zshrc"
path_line='export PATH="$HOME/.local/bin:$PATH"'

print_step() {
	printf '\n==> %s\n' "$1"
}

print_step "Building fork from $repo_dir"
cd "$repo_dir"

bun install
bun run build

if [[ ! -x "$binary" ]]; then
	printf 'error: expected executable was not created: %s\n' "$binary" >&2
	exit 1
fi

print_step "Linking fork binary into $link_dir"
mkdir -p "$link_dir"
ln -sf "$binary" "$link_dir/omp"
ln -sf "$binary" "$link_dir/lex"

print_step "Ensuring zsh PATH prefers $link_dir"
touch "$zshrc"
if ! grep -Fqx "$path_line" "$zshrc"; then
	{
		printf '\n# Prefer locally built fork binaries.\n'
		printf '%s\n' "$path_line"
	} >> "$zshrc"
fi

export PATH="$link_dir:$PATH"
hash -r 2>/dev/null || true

print_step "Verification"
printf 'omp path: '
command -v omp
printf 'lex path: '
command -v lex
lex --version

cat <<'EOF'

Done. For the current interactive shell, run:
  source ~/.zshrc
  hash -r

Then verify:
  command -v lex
  lex --version
EOF
