#!/usr/bin/env zsh
set -euo pipefail

# Ensure nightly cargo (required for #![feature(alloc_error_hook)]) is found
# before Homebrew's stable cargo. rustup shims don't activate when a system
# cargo is earlier in PATH. We read rust-toolchain.toml if present, else pick
# any installed nightly.
if [[ -f "${0:A:h}/rust-toolchain.toml" ]]; then
	_tc_channel=$(awk -F'"' '/^channel/{print $2}' "${0:A:h}/rust-toolchain.toml")
	_tc_arch="$(rustc --print host-target 2>/dev/null || uname -m)-apple-darwin"
	_tc_path="$HOME/.rustup/toolchains/${_tc_channel}-${_tc_arch}/bin"
	[[ -d "$_tc_path" ]] && export PATH="$_tc_path:$PATH"
	unset _tc_channel _tc_arch _tc_path
fi

repo_dir="${0:A:h}"
binary="$repo_dir/packages/coding-agent/dist/omp"
link_dir="$HOME/.local/bin"
zshrc="$HOME/.zshrc"
path_line='export PATH="$HOME/.local/bin:$PATH"'

print_step() {
	printf '\n==> %s\n' "$1"
}

tracked_settings_files=(
	"$HOME/.omp/agent/config.yml"
	"$HOME/.lex/agent/config.yml"
)
settings_guard_paths=()
settings_guard_hashes=()
settings_guard_realpaths=()

settings_hash() {
	shasum -a 256 "$1" | cut -d ' ' -f 1
}

capture_settings_guard() {
	settings_guard_paths=()
	settings_guard_hashes=()
	settings_guard_realpaths=()
	for file in "${tracked_settings_files[@]}"; do
		if [[ -e "$file" ]]; then
			settings_guard_paths+=("$file")
			settings_guard_hashes+=("$(settings_hash "$file")")
			settings_guard_realpaths+=("${file:A}")
		fi
	done
}

verify_settings_guard() {
	local current_hash current_realpath
	for (( i = 1; i <= ${#settings_guard_paths[@]}; i++ )); do
		if [[ ! -e "${settings_guard_paths[$i]}" ]]; then
			printf 'error: rebuild removed protected settings file: %s\n' "${settings_guard_paths[$i]}" >&2
			exit 1
		fi
		current_hash="$(settings_hash "${settings_guard_paths[$i]}")"
		current_realpath="${settings_guard_paths[$i]:A}"
		if [[ "$current_hash" != "${settings_guard_hashes[$i]}" || "$current_realpath" != "${settings_guard_realpaths[$i]}" ]]; then
			printf 'error: rebuild changed protected settings file: %s\n' "${settings_guard_paths[$i]}" >&2
			printf '  before: %s  %s\n' "${settings_guard_hashes[$i]}" "${settings_guard_realpaths[$i]}" >&2
			printf '  after:  %s  %s\n' "$current_hash" "$current_realpath" >&2
			printf 'Refusing to finish: rebuild-lex.zsh must not overwrite user config.yml settings.\n' >&2
			exit 1
		fi
	done
}

capture_settings_guard

print_step "Building fork from $repo_dir"
cd "$repo_dir"

print_step "Verifying fork patches"
if ! bun scripts/check-fork-patches.ts; then
	printf '\nFork patches missing. Re-apply before rebuilding (see docs/upstream-rebase-and-fork-maintenance.md §3).\n' >&2
	exit 1
fi

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

bun install
bun run build

if [[ ! -x "$binary" ]]; then
	printf 'error: expected executable was not created: %s\n' "$binary" >&2
	exit 1
fi

# profile-manager lives in .omp/extensions (NOT a workspace package), so the
# root `bun run build` skips it. Build its bundle here so edits to its source
# actually ship instead of silently serving a stale dist.
print_step "Building profile-manager extension"
bun build .omp/extensions/profile-manager/index.ts \
	--outfile .omp/extensions/profile-manager/dist/index.js \
	--target bun --format esm

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

print_step "Linking fork binary into $link_dir"
mkdir -p "$link_dir"
ln -sf "$binary" "$link_dir/lex"
ln -sf "$binary" "$link_dir/omp"

# Rebuild personal extensions against the freshly compiled lex binary, then install
# the fork-managed extension set last. Some package names exist in both repos; the
# user-level config must resolve those to this lex checkout, while personal-only
# extensions stay registered from the external repo.
personal_ext_repo="$HOME/PycharmProjects/omp-personal-extensions"
if [[ -d "$personal_ext_repo" ]]; then
	print_step "Rebuilding personal extensions ($personal_ext_repo)"
	bun --cwd="$personal_ext_repo" run build
	print_step "Installing personal-only global extensions (~/.omp/agent/extensions)"
	bun --cwd="$personal_ext_repo" run install:user
fi

print_step "Installing and verifying lex-managed global extensions (~/.omp/agent/extensions)"
bun scripts/install-user-extensions.ts

# settings.json registers profile-manager at extensions/profile-manager/index.js
# but install-user-extensions.ts removes index.js (it's in STALE_MANAGED_DISCOVERY_FILES)
# and installs profile-manager.bundle.js instead. Re-create the index.js symlink
# so the settings.json path keeps working without editing that protected file.
pm_ext_dir="$HOME/.omp/agent/extensions/profile-manager"
pm_bundle="$pm_ext_dir/profile-manager.bundle.js"
pm_index="$pm_ext_dir/index.js"
if [[ ( -e "$pm_bundle" || -L "$pm_bundle" ) && ! -e "$pm_index" && ! -L "$pm_index" ]]; then
	ln -sf "$pm_bundle" "$pm_index"
	printf '  profile-manager: created index.js -> profile-manager.bundle.js\n'
fi

print_step "Profile-manager installed /pm smoke test"
bun scripts/smoke-profile-manager.ts "$pm_index"

print_step "Minimizer gain installed bundle session-scope smoke test"
bun run --filter pi-minimizer-gain smoke:installed

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
bun --cwd=packages/pi-minimizer-gain run smoke:bundle

# Smoke-test the extension path that has broken repeatedly: the global
# Antigravity adapter extension bundle must exist and be readable.
# (--list-models was removed in v16; verify via symlink presence instead.)
print_step "Extension load smoke test"
antigravity_bundle="$HOME/.omp/agent/extensions/antigravity-adapter/antigravity.bundle.js"
if [[ ! -f "$antigravity_bundle" ]]; then
	printf 'error: antigravity extension bundle missing after rebuild: %s\n' "$antigravity_bundle" >&2
	exit 1
fi
printf '  antigravity extension bundle present: %s\n' "$antigravity_bundle"

print_step "Verifying OpenAI Codex agent defaults"
bun scripts/set-agent-codex-defaults.ts --check
verify_settings_guard
printf '  protected settings YAML unchanged\n'

cat <<'EOF'

Done. For the current interactive shell, run:
  source ~/.zshrc
  hash -r

Then verify:
  command -v lex
  lex --version
EOF
