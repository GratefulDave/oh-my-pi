# pi-minimizer-gain Changelog

## [Unreleased]

### Fixed

- Fixed Active scope staying empty after plugin reloads by matching exact session IDs, falling back to the session start timestamp for legacy records, and writing bash minimizer telemetry again.

### Added

- Added missed-minimization ignored-command configuration.
- Added JSONL export for daily and per-command minimizer gain totals.
- Added source-path breakdown with an explicit `unknown` bucket.
