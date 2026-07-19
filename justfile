# Lex fork recipes.  RUN FROM REPO ROOT: /Users/davidandrews/PycharmProjects/lex
# `just` finds this file in the cwd or any parent, so any subdir of the repo works too.
#
#   just                 # list recipes
#   just install         # build every extension bundle + rebuild & install the lex binary
#   just rebase          # pull upstream and rebase the current branch
#
set shell := ["bash", "-uc"]

# Extensions that have a build step (bundle -> packages/<name>/dist/*.bundle.js).
# swarm-extension is pre-bundled; profile-manager / semantic-search are not bundled.
BUILDABLE_EXTS := "pi-minimizer-gain pi-distill pi-observer pi-omnidelegate pi-software-factory"

# Show all recipes.
default:
    @just --list

# ----------------------------------------------------------------------------
# EXTENSIONS
# ----------------------------------------------------------------------------

# Build ONE extension bundle.  e.g. `just build-ext pi-observer`
build-ext name:
    bun --cwd=packages/{{name}} run build

# Build ALL buildable extension bundles.
build-exts:
    #!/usr/bin/env bash
    set -euo pipefail
    for ext in {{BUILDABLE_EXTS}}; do
        echo "==> building $ext"
        bun --cwd=packages/"$ext" run build
    done
    echo "==> done. registered extensions:"
    just ext-list

# Print the extensions currently registered in .omp/settings.json.
ext-list:
    @node -e "console.log(require('./.omp/settings.json').extensions.join('\n'))"

# Run an extension's unit tests.  e.g. `just test-ext pi-observer`
test-ext name:
    bun --cwd=packages/{{name}} run test

# Lint/typecheck one extension.  e.g. `just check-ext pi-observer`
check-ext name:
    bun --cwd=packages/{{name}} run check

# Build every extension, then rebuild + install the lex binary that loads them.
# This is the "install the extensions into omp" recipe.
install: build-exts rebuild

# USER-GLOBAL install: copy built bundles into ~/.omp/agent/extensions/ and
# register them in ~/.omp/agent/settings.json so omp loads them from ANY cwd
# (no need to launch from this repo).
install-user: build-exts
    bun scripts/install-user-extensions.ts

# Preview the user-global install without copying or writing anything.
install-user-dry:
    bun scripts/install-user-extensions.ts --dry-run

# Show user-scope registered extensions.
ext-list-user:
    @node -e "try{console.log((require('os').homedir()+'/.omp/agent/settings.json'))}catch{}" ; node -e "const f=require('os').homedir()+'/.omp/agent/settings.json';try{console.log((require(f).extensions||[]).join('\n'))}catch{console.log('(none — run: just install-user)')}"

# Launch omp from source (loads extensions per .omp/settings.json, cwd = repo).
dev:
    bun run dev

# ----------------------------------------------------------------------------
# BUILD / INSTALL THE BINARY
# ----------------------------------------------------------------------------

# Full workspace build (TypeScript + native NAPI).
build:
    bun run build

# Native (Rust/NAPI) only — faster when you only touched crates/.
build-native:
    bun run build:native

# Build everything and symlink ~/.local/bin/lex -> the fresh binary.
rebuild:
    ./rebuild-lex.zsh

# Show the installed binary + version.
verify:
    @command -v lex && lex --version

# Fast scoped Rust check.  e.g. `just rs-check pi-shell`
rs-check crate="pi-shell":
    cargo check -p {{crate}}

# ----------------------------------------------------------------------------
# UPSTREAM REBASE
# ----------------------------------------------------------------------------

# Pull upstream (can1357/oh-my-pi) and rebase the CURRENT branch onto upstream/main.
# Pauses on conflict; follow the printed steps, then `just rebuild`.
rebase:
    ./scripts/update-from-upstream.sh

# Rebase a SPECIFIC branch.  e.g. `just rebase-branch wip/lex-binary-extraction`
rebase-branch branch:
    git checkout {{branch}}
    ./scripts/update-from-upstream.sh

# After a rebase: re-stamp the fork version everywhere (default 15.7.3-lex).
stamp version="15.7.3-lex":
    bun scripts/sync-versions.ts {{version}}

# Full post-rebase fixup: re-stamp version, then rebuild + install.
post-rebase version="15.7.3-lex": (stamp version) rebuild
