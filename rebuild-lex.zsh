#!/usr/bin/env zsh
set -euo pipefail

repo_dir="${0:A:h}"
binary="$repo_dir/packages/coding-agent/dist/omp"
personal_extensions_dir="$HOME/PycharmProjects/omp-personal-extensions"
link_dir="$HOME/.local/bin"
bun_link_dir="$HOME/.bun/bin"
zshrc="$HOME/.zshrc"
path_line='export PATH="$HOME/.local/bin:$PATH"'

print_step() {
	printf '\n==> %s\n' "$1"
}

print_step "Building fork from $repo_dir"
cd "$repo_dir"

# Keep the pi-natives version sentinel in sync with package.json#version.
# Upstream's scripts/release.ts rewrites this on every release; a manual
# version stamp (e.g. syncing to a new upstream) skips it, leaving the Rust
# .node exporting a stale `__piNativesV…` symbol that the JS loader (which
# derives the expected name from package.json#version) rejects at startup.
# Symptom: "Failed to load pi_natives native addon" -> binary half-crashes ->
# extensions never load -> models/profiles vanish. Sync it here so every
# rebuild produces a matching native.
print_step "Syncing pi-natives version sentinel"
natives_version="$(node -p "require('./packages/natives/package.json').version" 2>/dev/null)"
if [[ -z "$natives_version" ]]; then
	printf 'error: could not read packages/natives/package.json#version\n' >&2
	exit 1
fi
sentinel="__piNativesV${natives_version//[^A-Za-z0-9]/_}"
sentinel_files=(
	crates/pi-natives/src/lib.rs
	packages/natives/native/index.js
	packages/natives/native/index.d.ts
)
perl -pi -e "s/__piNativesV[A-Za-z0-9_]+/${sentinel}/g" "${sentinel_files[@]}"
if ! grep -q "js_name = \"${sentinel}\"" crates/pi-natives/src/lib.rs; then
	printf 'error: failed to set sentinel %s in lib.rs\n' "$sentinel" >&2
	exit 1
fi
printf '  sentinel: %s\n' "$sentinel"

nightly_path="$(rustup which cargo | xargs dirname)"
print_step "Ensuring nightly toolchain is used for native builds"
export PATH="$nightly_path:$PATH"
bun install

print_step "Building pi-natives addon"
bun --cwd=packages/natives run build

print_step "Rebuilding managed extension bundles"
bun scripts/rebuild-extensions.ts

print_step "Building lex binary"
bun --cwd=packages/coding-agent run build

if [[ ! -x "$binary" ]]; then
	printf 'error: expected executable was not created: %s\n' "$binary" >&2
	exit 1
fi

# Refresh the native cache the binary loads from. It is keyed by version
# string only (~/.omp/natives/<version>/), so a freshly built .node never
# overwrites a stale same-version cache on its own. Wipe and repopulate from
# the build output so no stale native survives a rebuild.
print_step "Refreshing native cache for $natives_version"
built_natives=(packages/natives/native/pi_natives.*.node(N))
if (( ${#built_natives} == 0 )); then
	printf 'error: no built native found under packages/natives/native/\n' >&2
	exit 1
fi
native_cache="$HOME/.omp/natives/$natives_version"
rm -rf "$native_cache"
mkdir -p "$native_cache"
for n in "${built_natives[@]}"; do
	cp "$n" "$native_cache/${n:t}"
	printf '  installed: %s\n' "$native_cache/${n:t}"
done

print_step "Linking fork binary into $link_dir and $bun_link_dir"
mkdir -p "$link_dir" "$bun_link_dir"
ln -sf "$binary" "$link_dir/lex"
ln -sf "$binary" "$link_dir/omp"
ln -sf "$binary" "$bun_link_dir/lex"
ln -sf "$binary" "$bun_link_dir/omp"

# Refresh user-level extension bundle symlinks only. User configs are protected:
# ~/.omp/agent/settings.json and ~/.omp/agent/config.yml must survive fork
# rebuilds byte-for-byte, because they hold profiles, model roles, disabled
# providers, MCPs, skills, and other Lex/OMP runtime state.
print_step "Installing and verifying global extension symlinks (~/.omp/agent/extensions)"
settings_checksum_before="$(shasum "$HOME/.omp/agent/settings.json" "$HOME/.omp/agent/config.yml" 2>/dev/null || true)"
bun scripts/install-user-extensions.ts
settings_checksum_after="$(shasum "$HOME/.omp/agent/settings.json" "$HOME/.omp/agent/config.yml" 2>/dev/null || true)"
if [[ "$settings_checksum_before" != "$settings_checksum_after" ]]; then
	printf 'error: extension install changed protected user config files\n' >&2
	exit 1
fi
printf '  protected user configs unchanged\n'
print_step "Minimizer gain installed bundle session-scope smoke test"
bun --cwd="$personal_extensions_dir/packages/pi-minimizer-gain" run smoke:installed

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
printf 'lex path: '
command -v lex
lex --version
printf 'omp path: '
command -v omp
omp --version

# Smoke-test that the native actually loads. `lex --version` returns before the
# native is needed, so it passes even when the addon is broken; `--help` forces
# the full load path. Fail loud here instead of shipping a half-dead binary.
print_step "Native load smoke test"
help_out="$(lex --help 2>&1 || true)"
if grep -q "Failed to load pi_natives" <<<"$help_out"; then
	printf 'error: native addon failed to load after rebuild:\n%s\n' "$help_out" >&2
	exit 1
fi
printf '  native loads OK\n'

print_step "Minimizer gain bundle smoke test"
bun --cwd="$personal_extensions_dir/packages/pi-minimizer-gain" run smoke:bundle

# Smoke-test the extension path that has broken repeatedly: the ag extension
# must load and expose its provider models for BOTH command names. Run from
# repo_dir so the repo .omp/settings.json is used (no enabledModels filter).
# With --no-extensions the provider must disappear, proving the selected
# namespace is the extension path, not a built-in provider.
print_step "Extension load smoke test"
lex_models_out="$(cd "$repo_dir" && NO_COLOR=1 FORCE_COLOR=0 lex models ag 2>&1 || true)"
omp_models_out="$(cd "$repo_dir" && NO_COLOR=1 FORCE_COLOR=0 omp models ag 2>&1 || true)"
no_ext_out="$(cd "$repo_dir" && NO_COLOR=1 FORCE_COLOR=0 lex models ag --no-extensions 2>&1 || true)"
if [[ "$lex_models_out" == *"Failed to load extension"* ]]; then
	printf 'error: lex still reports an extension load failure after rebuild:\n%s\n' "$lex_models_out" >&2
	exit 1
fi
if [[ "$omp_models_out" == *"Failed to load extension"* ]]; then
	printf 'error: omp still reports an extension load failure after rebuild:\n%s\n' "$omp_models_out" >&2
	exit 1
fi
if [[ "$lex_models_out" != *"ag ("* ]]; then
	printf 'error: lex ag extension provider section not visible after rebuild:\n%s\n' "$lex_models_out" >&2
	exit 1
fi
if [[ "$omp_models_out" != *"ag ("* ]]; then
	printf 'error: omp ag extension provider section not visible after rebuild:\n%s\n' "$omp_models_out" >&2
	exit 1
fi
if [[ "$no_ext_out" == *"ag ("* ]]; then
	printf 'error: ag provider section still visible with --no-extensions (should be absent):\n%s\n' "$no_ext_out" >&2
	exit 1
fi
printf '  lex and omp both load the ag antigravity provider through the extension-only path\n'
cat <<'EOF'

Done. For the current interactive shell, run:
  source ~/.zshrc
  hash -r

Then verify:
  command -v lex
  lex --version
EOF
