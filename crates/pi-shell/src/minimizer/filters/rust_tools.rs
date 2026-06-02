//! Rust toolchain helper filters (`rustfmt`).
//!
//! `rustfmt` either reformats files in-place (exit 0, minimal output) or
//! emits parse errors (exit 1). The filter strips ANSI noise and caps large
//! passthrough output; error output is kept verbatim so diagnostics are
//! visible.

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(program: &str, _subcommand: Option<&str>) -> bool {
	matches!(program, "rustfmt")
}

pub fn filter(_ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let stripped = primitives::strip_ansi(input);
	// On success rustfmt is nearly silent; on error keep all diagnostic lines.
	let text = if exit_code == 0 && stripped.lines().count() > primitives::CapClass::Errors.lines() {
		primitives::head_tail_cap(&stripped, primitives::CapClass::Errors)
	} else {
		stripped
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}
