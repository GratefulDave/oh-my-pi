//! Binary/hex inspection tool filters (`xxd`, `strings`, `od`).
//!
//! These tools produce verbose per-byte or per-word output that grows
//! linearly with file size. The filter caps the output to a readable head/tail
//! window so the compacted result stays token-efficient.

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(program: &str, _subcommand: Option<&str>) -> bool {
	matches!(program, "xxd" | "strings" | "od")
}

pub fn filter(_ctx: &MinimizerCtx<'_>, input: &str, _exit_code: i32) -> MinimizerOutput {
	let stripped = primitives::strip_ansi(input);
	let text = if stripped.lines().count() > primitives::CapClass::Large.lines() {
		primitives::head_tail_cap(&stripped, primitives::CapClass::Large)
	} else {
		stripped
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}
