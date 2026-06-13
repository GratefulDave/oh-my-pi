# antigravity Changelog

## [Unreleased]

### Added

- Added compatibility smoke documentation for `omp login antigravity` and model selection.
- Added focused coverage for existing-token refresh failure mapping in the auth adapter.

### Changed

- Renamed the active provider to antigravity, made its OAuth/request path self-contained in OMP/Lex, and disabled the previous OpenCode-plugin bridge as a backup.

### Fixed

- Fixed installed Antigravity visibility by pinning the extension label/provider namespace in tests.
- Fixed Antigravity endpoint compatibility coverage and added a gated live Cloud Code endpoint smoke test for the self-contained extension.
- Fixed Cloud Code streaming responses by unwrapping Antigravity envelopes before the Google stream parser and filtering advertised models to content-endpoint models that do not 404.
- Fixed the self-contained Antigravity extension to use the captured Antigravity CLI model ids, Cloud Code headers, daily model-discovery endpoint, and preserved thinking config.
