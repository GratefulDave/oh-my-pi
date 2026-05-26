import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { MinimizerGainContext } from "../../../src/minimizer-gain";
import { MinimizerGainOverlayComponent } from "../../../src/modes/components/minimizer-gain-overlay";
import { initTheme } from "../../../src/modes/theme/theme";

function makeContext(): MinimizerGainContext {
	return {
		path: "/agent/minimizer-gain.jsonl",
		days: 30,
		cwd: "/repo/with\ttab",
		all: false,
		records: [],
		summary: {
			commands: 2,
			inputBytes: 3500,
			outputBytes: 900,
			savedBytes: 2600,
			estimatedTokensSaved: 650,
			usesEstimatedTokensSaved: true,
			byFilter: [
				{
					filter: "git\tstatus",
					commands: 2,
					inputBytes: 3500,
					outputBytes: 900,
					savedBytes: 2600,
					estimatedTokensSaved: 650,
					usesEstimatedTokensSaved: true,
				},
			],
			byCommand: [
				{
					command: "git status --short --branch --long --very-long --with-tabs\t",
					commands: 2,
					inputBytes: 3500,
					outputBytes: 900,
					savedBytes: 2600,
					estimatedTokensSaved: 650,
					usesEstimatedTokensSaved: true,
				},
			],
			byCwd: [],
		},
		missed: {
			commands: [
				{
					command: "cargo test --workspace --no-fail-fast --\tverbose",
					filter: "missed",
					commands: 3,
					inputBytes: 12000,
					outputBytes: 12000,
					avgInputBytes: 4000,
					exitCodes: [0, 1],
				},
			],
		},
	};
}

function render(component: MinimizerGainOverlayComponent, width = 100): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

describe("MinimizerGainOverlayComponent", () => {
	beforeAll(() => {
		initTheme();
	});

	it("switches tabs on Tab and closes on Escape", () => {
		const onClose = vi.fn();
		const component = new MinimizerGainOverlayComponent(makeContext(), () => {}, onClose);

		expect(render(component)).toContain("Positive minimizer savings");

		component.handleInput("\t");
		expect(render(component)).toContain("Largest unminimized shell outputs");
		expect(render(component)).not.toContain("Positive minimizer savings");

		component.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("sanitizes tab characters in displayed paths and commands", () => {
		const component = new MinimizerGainOverlayComponent(
			makeContext(),
			() => {},
			() => {},
		);
		const output = render(component);

		expect(output).not.toContain("\t");
		expect(output).toContain("minimizer-gain.jsonl");
		expect(output).toContain("git status --short");
	});
	it("refreshes rendered stats from the latest context", async () => {
		const updated = makeContext();
		updated.summary.commands = 3;
		updated.summary.savedBytes = 3100;
		updated.summary.estimatedTokensSaved = 775;
		updated.summary.byCommand[0]!.commands = 3;
		updated.summary.byCommand[0]!.savedBytes = 3100;
		updated.summary.byCommand[0]!.estimatedTokensSaved = 775;
		const requestRender = vi.fn();
		const component = new MinimizerGainOverlayComponent(
			makeContext(),
			requestRender,
			() => {},
			async () => updated,
		);

		try {
			expect(render(component)).toContain("Commands: 2");

			await component.refresh();

			const output = render(component);
			expect(output).toContain("Commands: 3");
			expect(output).toContain("Saved Bytes: 3.1K");
			expect(requestRender).toHaveBeenCalledTimes(1);
		} finally {
			component.dispose();
		}
	});
});
