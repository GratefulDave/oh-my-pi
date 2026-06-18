# antigravity-adapter Changelog

## [Unreleased]

### Added

- Added compatibility smoke documentation for `omp login opencode-antigravity` and model selection.
- Added focused coverage for existing-token refresh failure mapping in the auth adapter.
- Added `/ag status` to inspect loaded Antigravity OAuth account, refresh-token, and project state.

### Fixed

- Fixed the bridge stream model-id rewrite so Antigravity Claude and Gemini requests drop the `antigravity-` quota prefix before entering the shared Google serializer, restoring Claude-compatible tool schema generation after the upstream upgrade.
