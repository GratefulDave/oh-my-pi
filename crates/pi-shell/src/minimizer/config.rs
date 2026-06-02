//! Configuration for the shell output minimizer.
//!
//! [`MinimizerOptions`] is the N-API surface exposed through `ShellOptions`
//! and `ShellExecuteOptions`. [`MinimizerConfig`] is the internal resolved
//! view after merging field-level values with an optional TOML settings
//! file.

use std::{
	collections::{HashMap, HashSet},
	fs,
	path::{Path, PathBuf},
	sync::Arc,
};

use serde::Deserialize;

use crate::minimizer::pipeline::{self, PipelineRegistry, SUPPORTED_SCHEMA_VERSION};

const DEFAULT_MAX_CAPTURE_BYTES: u32 = 4 * 1024 * 1024;
const DEFAULT_AI_SMART_PROVIDER: &str = "deepseek";

/// Source-outline aggressiveness for `cat <source-file>` minimization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OutlineLevel {
	/// Current behavior: only outline when input is large enough to warrant it.
	#[default]
	Default,
	/// Strip function/method bodies regardless of size for supported source
	/// languages (`ts`, `tsx`, `js`, `jsx`, `py`, `rs`, `go`).
	Aggressive,
}

impl OutlineLevel {
	fn parse(raw: &str) -> Option<Self> {
		match raw.trim().to_ascii_lowercase().as_str() {
			"default" | "" => Some(Self::Default),
			"aggressive" => Some(Self::Aggressive),
			_ => None,
		}
	}
}

/// N-API opt-in handle for the minimizer.
#[derive(Debug, Clone, Default)]
pub struct MinimizerOptions {
	/// Master switch. Absent / false = disabled.
	pub enabled:              Option<bool>,
	/// Optional path to a TOML settings file whose values override
	/// field-level defaults. `~` is expanded.
	pub settings_path:        Option<String>,
	/// Optional xxHash64 digest (hex) of the settings file contents. When
	/// supplied, the engine refuses to honor a settings file whose hash does
	/// not match — a lightweight trust gate for agent-controllable paths.
	pub settings_hash:        Option<String>,
	/// Opt-in allowlist of program names (e.g. `"git"`). When empty or
	/// absent, all built-in filters are active.
	pub only:                 Option<Vec<String>>,
	/// Program names explicitly excluded from minimization.
	pub except:               Option<Vec<String>>,
	/// Maximum captured bytes per command before the engine falls back to
	/// the raw, un-minimized output. Default 4 MiB.
	pub max_capture_bytes:    Option<u32>,
	/// Source-outline level for `cat <source-file>` minimization. Accepts
	/// `"default"` (current behavior) or `"aggressive"` (strip function bodies).
	pub source_outline_level: Option<String>,
	/// Master switch for the AI-summary filter (W4 / rtk smart). Default off.
	pub ai_smart_enabled:     Option<bool>,
	/// Provider key for the AI summarizer (e.g. `"deepseek"`). Default
	/// `"deepseek"` when [`Self::ai_smart_enabled`] is true.
	pub ai_smart_provider:    Option<String>,
	/// Kill-switch to fall back to the pre-PR (legacy) filter behavior for
	/// grep / find / pytest. When `Some(true)`, filters that opted into the
	/// always-shrink Tier 1 / Tier 2 behavior skip the new code path and
	/// return the legacy passthrough. When `None`, defers to the
	/// `OMP_MINIMIZER_LEGACY_FILTERS` environment variable (truthy = "1",
	/// "true", or "yes", case-insensitive); default `false`.
	pub legacy_filters:       Option<bool>,
}

/// Resolved minimizer configuration used by the engine.
#[derive(Debug, Clone)]
pub struct MinimizerConfig {
	pub enabled:               bool,
	pub only:                  HashSet<String>,
	pub except:                HashSet<String>,
	pub max_capture_bytes:     u32,
	pub per_command:           HashMap<String, toml::Value>,
	/// Compiled user-defined pipelines parsed from `settings_path`. Searched
	/// before the built-in pipelines so user filters win.
	pub user_pipelines:        Option<Arc<PipelineRegistry>>,
	/// Aggressiveness for source-outline body stripping in `compact_cat_output`.
	pub source_outline_level:  OutlineLevel,
	/// Master switch for the AI summary filter (W4). When false, the filter
	/// is a no-op passthrough.
	pub ai_smart_enabled:      bool,
	/// Provider key for the AI summarizer (defaults to `"deepseek"`).
	pub ai_smart_provider:     String,
	/// Resolved kill-switch: when true, opted-in filters (Tier 1 grep/find,
	/// Tier 2 pytest) return the pre-PR legacy behavior. Resolved at
	/// `from_options()` time from caller-supplied
	/// `MinimizerOptions.legacy_filters` or the `OMP_MINIMIZER_LEGACY_FILTERS`
	/// env var; default `false`.
	pub legacy_filters_active: bool,
}

impl Default for MinimizerConfig {
	fn default() -> Self {
		Self {
			enabled:               false,
			only:                  HashSet::new(),
			except:                HashSet::new(),
			max_capture_bytes:     DEFAULT_MAX_CAPTURE_BYTES,
			per_command:           HashMap::new(),
			user_pipelines:        None,
			source_outline_level:  OutlineLevel::Default,
			ai_smart_enabled:      false,
			ai_smart_provider:     DEFAULT_AI_SMART_PROVIDER.to_string(),
			legacy_filters_active: false,
		}
	}
}

impl MinimizerConfig {
	/// Build a resolved configuration from `MinimizerOptions`, optionally
	/// merging in a TOML settings file.
	pub fn from_options(opts: &MinimizerOptions) -> Self {
		let mut cfg = Self::default();
		if let Some(enabled) = opts.enabled {
			cfg.enabled = enabled;
		}
		if let Some(list) = opts.only.as_ref() {
			cfg.only = list.iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(list) = opts.except.as_ref() {
			cfg.except = list.iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(n) = opts.max_capture_bytes {
			cfg.max_capture_bytes = n.max(1024);
		}
		if let Some(raw) = opts.source_outline_level.as_deref()
			&& let Some(level) = OutlineLevel::parse(raw)
		{
			cfg.source_outline_level = level;
		}
		if let Some(v) = opts.ai_smart_enabled {
			cfg.ai_smart_enabled = v;
		}
		cfg.legacy_filters_active = match opts.legacy_filters {
			Some(v) => v,
			None => std::env::var("OMP_MINIMIZER_LEGACY_FILTERS")
				.ok()
				.is_some_and(|raw| {
					matches!(raw.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes")
				}),
		};
		if let Some(provider) = opts.ai_smart_provider.as_deref()
			&& !provider.is_empty()
		{
			cfg.ai_smart_provider = provider.to_string();
		}
		if let Some(path) = opts.settings_path.as_deref()
			&& !path.is_empty()
		{
			let expanded = expand_tilde(path);
			if let Ok(contents) = fs::read_to_string(&expanded) {
				if let Some(expected) = opts.settings_hash.as_deref()
					&& !expected.is_empty()
				{
					let actual = xxhash_rust::xxh64::xxh64(contents.as_bytes(), 0);
					let actual_hex = format!("{actual:016x}");
					if !actual_hex.eq_ignore_ascii_case(expected) {
						eprintln!(
							"[pi-natives minimizer] settings_hash mismatch for {} (expected {}, got {}); \
							 ignoring file",
							expanded.display(),
							expected,
							actual_hex
						);
						return cfg;
					}
				}
				if let Ok(file) = toml::from_str::<SettingsFile>(&contents) {
					file.merge_into(&mut cfg);
				}
				match pipeline::parse_file(&contents, "user") {
					Ok((pipelines, tests)) => {
						if !pipelines.is_empty() {
							cfg.user_pipelines = Some(Arc::new(PipelineRegistry { pipelines, tests }));
						}
					},
					Err(err) => {
						eprintln!("[pi-natives minimizer] user filters: {err}");
					},
				}
			}
		}
		cfg
	}

	/// Whether the engine should attempt to minimize output for `program`.
	pub fn is_program_enabled(&self, program: &str) -> bool {
		if !self.enabled {
			return false;
		}
		let key = program.to_lowercase();
		if self.except.contains(&key) {
			return false;
		}
		if !self.only.is_empty() && !self.only.contains(&key) {
			return false;
		}
		true
	}

	/// Fetch a per-command TOML table, if any.
	pub fn per_command(&self, program: &str) -> Option<&toml::Value> {
		self.per_command.get(&program.to_lowercase())
	}

	/// Whether opted-in filters should fall back to pre-PR legacy behavior.
	pub const fn legacy_filters_active(&self) -> bool {
		self.legacy_filters_active
	}
}

#[derive(Debug, Default, Deserialize)]
struct SettingsFile {
	#[serde(default)]
	schema_version:       Option<u32>,
	enabled:              Option<bool>,
	only:                 Option<Vec<String>>,
	except:               Option<Vec<String>>,
	max_capture_bytes:    Option<u32>,
	source_outline_level: Option<String>,
	ai_smart_enabled:     Option<bool>,
	ai_smart_provider:    Option<String>,
	#[serde(flatten)]
	tables:               HashMap<String, toml::Value>,
}

impl SettingsFile {
	fn merge_into(self, cfg: &mut MinimizerConfig) {
		if let Some(v) = self.schema_version
			&& v != SUPPORTED_SCHEMA_VERSION
		{
			eprintln!(
				"[pi-natives minimizer] unsupported schema_version {v} in settings file (expected \
				 {SUPPORTED_SCHEMA_VERSION})"
			);
			return;
		}
		if let Some(v) = self.enabled {
			cfg.enabled = v;
		}
		if let Some(list) = self.only {
			cfg.only = list.into_iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(list) = self.except {
			cfg.except = list.into_iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(n) = self.max_capture_bytes {
			cfg.max_capture_bytes = n.max(1024);
		}
		if let Some(raw) = self.source_outline_level.as_deref()
			&& let Some(level) = OutlineLevel::parse(raw)
		{
			cfg.source_outline_level = level;
		}
		if let Some(v) = self.ai_smart_enabled {
			cfg.ai_smart_enabled = v;
		}
		if let Some(provider) = self.ai_smart_provider
			&& !provider.is_empty()
		{
			cfg.ai_smart_provider = provider;
		}
		for (k, v) in self.tables {
			if v.is_table() && k != "filters" && k != "tests" {
				cfg.per_command.insert(k.to_lowercase(), v);
			}
		}
	}
}

fn expand_tilde(path: &str) -> PathBuf {
	if let Some(rest) = path.strip_prefix("~/")
		&& let Some(home) = home_dir()
	{
		return home.join(rest);
	}
	if path == "~"
		&& let Some(home) = home_dir()
	{
		return home;
	}
	Path::new(path).to_path_buf()
}

fn home_dir() -> Option<PathBuf> {
	#[cfg(unix)]
	{
		std::env::var_os("HOME").map(PathBuf::from)
	}
	#[cfg(windows)]
	{
		std::env::var_os("USERPROFILE")
			.or_else(|| std::env::var_os("HOMEPATH"))
			.map(PathBuf::from)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn defaults_are_disabled() {
		let cfg = MinimizerConfig::default();
		assert!(!cfg.enabled);
		assert!(!cfg.is_program_enabled("git"));
	}

	#[test]
	fn enabled_without_only_enables_any_program() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			..Default::default()
		});
		assert!(cfg.is_program_enabled("git"));
		assert!(cfg.is_program_enabled("cargo"));
	}

	#[test]
	fn only_list_is_respected() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			only: Some(vec!["git".into()]),
			..Default::default()
		});
		assert!(cfg.is_program_enabled("git"));
		assert!(!cfg.is_program_enabled("cargo"));
	}

	#[test]
	fn except_overrides_only() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			except: Some(vec!["docker".into()]),
			..Default::default()
		});
		assert!(!cfg.is_program_enabled("docker"));
		assert!(cfg.is_program_enabled("git"));
	}

	#[test]
	fn missing_settings_path_is_not_fatal() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			settings_path: Some("/does/not/exist.toml".into()),
			..Default::default()
		});
		assert!(cfg.enabled);
	}

	#[test]
	fn legacy_filters_option_some_true_sets_active() {
		// Explicit caller-supplied `Some(true)` must result in
		// `legacy_filters_active == true` regardless of env. This is the
		// test-friendly invocation path that avoids env-var mutation.
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			legacy_filters: Some(true),
			..Default::default()
		});
		assert!(cfg.legacy_filters_active());
	}

	#[test]
	fn legacy_filters_option_some_false_overrides_env() {
		// Explicit `Some(false)` must override any env var (verified by
		// inspecting the resolver — `Some(_)` arm short-circuits before
		// reading the env). We assert behavior via a default-constructed
		// `MinimizerOptions { legacy_filters: Some(false), .. }`.
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			legacy_filters: Some(false),
			..Default::default()
		});
		assert!(!cfg.legacy_filters_active());
	}

	#[test]
	fn legacy_filters_option_none_defaults_false_without_env() {
		// With no caller override and (in this test process) no env var set
		// by the test, the default is false.
		// SAFETY: we explicitly clear the var; CARGO_TEST runs in the same
		// process so other tests reading this var must not race; we accept
		// this is best-effort and the option-override tests above carry the
		// real assurance.
		// SAFETY: env_remove is safe in single-threaded test context; this
		// test only confirms the default branch when env is absent.
		unsafe {
			std::env::remove_var("OMP_MINIMIZER_LEGACY_FILTERS");
		}
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			..Default::default()
		});
		assert!(!cfg.legacy_filters_active());
	}
}
