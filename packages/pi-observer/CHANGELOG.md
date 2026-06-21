# pi-observer Changelog

## [Unreleased]

### Added

- Added `/observe-export json|csv [path]` for exporting current observer stats without resetting counters.
- Added dashboard filtering for IRC/subagent detail panes and configurable refresh interval support.

### Changed

- Changed the live widget to group subagents by chain/team label and refresh after session, turn, lifecycle, progress, and IRC observer events.

### Fixed

- Fixed the live observer widget to render in the coding-agent subagent HUD slot, stop overriding the native `job` renderer, strip task scaffolding from compact labels, and avoid leaking ANSI reset codes in full-width agent rows.
- Fixed the live subagent HUD to use the active theme on every render, switch running task labels and completed rows to the shared accent blue, and keep a capped scrolling window that retains the newest settled rows.
