# Changelog

## [Unreleased]

### Added

- Added the `ag` extension package with Antigravity OAuth login, dynamic model discovery, and package-local contract coverage for provider registration and bridge request shaping.

### Changed

- Switched the local extension bundle path from the old antigravity bridge build to `packages/ag/dist/ag.bundle.js`.

### Fixed

- Fixed AuthStorage Antigravity quota ranking to work for both the built-in `google-antigravity` provider and the extension-owned `ag` provider, including `antigravity-*` model ids.
- Fixed `omp login ag` startup by registering AG's stream transport under an extension-owned custom API id instead of the reserved built-in `google-gemini-cli` API name.
- Fixed the AG OAuth picker label to show `Antigravity (AG extension)`, reducing confusion with the built-in Antigravity login target.
- Fixed AG-backed Claude/Gemini request shaping by inheriting the captured Cloud Code Assist thinking-budget defaults.

- Restored AG Gemini routing to the old adapter contract: canonical selectors are `gemini-3.5-flash:low|medium|high` and `gemini-3.1-pro:low|high`, while legacy aliases like `gemini-3.5-flash-low` still normalize for compatibility.
- Fixed AG runtime prompts to use the same upstream `opencode-antigravity-auth` fetch path/body normalization as the old adapter, clearing the plain `test` Claude 400 and fixing AG Gemini calls by mapping visible Gemini names back to upstream `antigravity-gemini-*` ids.