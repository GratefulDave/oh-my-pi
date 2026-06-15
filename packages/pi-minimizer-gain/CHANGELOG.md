# pi-minimizer-gain Changelog

## [Unreleased]

### Fixed

- Fixed Active scope staying empty after plugin reloads by filtering from the session start timestamp and writing bash minimizer telemetry again.

### Added

- Added missed-minimization ignored-command configuration.
- Added JSONL export for daily and per-command minimizer gain totals.
- Added source-path breakdown with an explicit `unknown` bucket.
