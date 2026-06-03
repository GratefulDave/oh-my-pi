//! AI-summary post-step (feature `ai-smart`).
//!
//! Placeholder implementation that exposes the engine-facing surface so the
//! `ai-smart` feature gate compiles and the overlay in
//! [`crate::minimizer::engine`] is a fail-closed no-op. The real summarizer
//! (provider client, prompt, budget) lands in a separate change; until then
//! enabling the feature and the runtime `ai_smart_enabled` flag simply leaves
//! output untouched.

use crate::minimizer::MinimizerCtx;

/// Reset the per-`apply()` summarization budget. No-op in the placeholder.
pub fn reset_apply_budget() {}

/// Summarize `input` for the given command context.
///
/// Returns `None` (no rewrite) in the placeholder implementation, so the
/// overlay passes the upstream minimizer output through unchanged.
pub fn maybe_summarize(_ctx: &MinimizerCtx<'_>, _input: &str) -> Option<String> {
	None
}
