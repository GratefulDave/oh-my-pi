# Changelog

## [Unreleased]

### Changed

- Aligned the extension manifest with the built `dist/extension.bundle.js` registration path.
- Swarm progress widget now uses a theme-aware factory: nerd-font status icons per agent state, `statusLineSubagents` blue for agent names, `muted` for summary line; removed redundant `Swarm:` / `Mode:` header lines that duplicated the built-in `Agents` HUD.

### Added

- Added a package-local smoke test for `/swarm run <file.yaml>` command registration.
- Added `/swarm sub <task>` for one-off ad-hoc subagent runs and `/swarm template` for starter pipeline scaffolding.

## [15.9.0] - 2026-06-04

### Fixed
- Fixed swarm `/swarm run` failing with authStorage/modelRegistry identity error ([#1472](https://github.com/can1357/oh-my-pi/issues/1472))
