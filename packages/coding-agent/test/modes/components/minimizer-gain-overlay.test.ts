import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { MinimizerGainContext } from "../../../src/minimizer-gain";
import { type DualContext, MinimizerGainOverlayComponent } from "../../../src/modes/components/minimizer-gain-overlay";
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

function makeDualContext(): DualContext {
	const current = makeContext();
	const all: MinimizerGainContext = {
		...current,
		all: true,
		summary: {
			...current.summary,
			byCwd: [
				{
					cwd: "/repo/with\ttab",
					commands: 2,
					inputBytes: 3500,
					outputBytes: 900,
					savedBytes: 2600,
					estimatedTokensSaved: 650,
					usesEstimatedTokensSaved: true,
				},
			],
		},
	};
	return { current, all };
}

function render(component: MinimizerGainOverlayComponent, width = 100): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

describe("MinimizerGainOverlayComponent", () => {
	beforeAll(() => {
		initTheme();
	});

	it("switches tabs on Tab, scope on Shift+Tab/S, and closes on Escape", () => {
		const onClose = vi.fn();
		const component = new MinimizerGainOverlayComponent(makeDualContext(), () => {}, onClose);

		expect(render(component)).toContain("Positive minimizer savings");
		expect(render(component)).toContain("[ Current ]");

		component.handleInput("\t");
		expect(render(component)).toContain("Largest unminimized shell outputs");
		expect(render(component)).not.toContain("Positive minimizer savings");

		component.handleInput("s");
		expect(render(component)).toContain("[ All ]");
		component.handleInput("\t");
		expect(render(component)).toContain("Repositories");
		component.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("sanitizes tab characters in displayed paths and commands", () => {
		const component = new MinimizerGainOverlayComponent(
			makeDualContext(),
			() => {},
			() => {},
		);
		const output = render(component);

		expect(output).not.toContain("\t");
		expect(output).toContain("minimizer-gain.jsonl");
		expect(output).toContain("git status --short");
	});

	it("refreshes rendered stats from the latest context", async () => {
		const updatedCurrent = makeContext();
		updatedCurrent.summary.commands = 3;
		updatedCurrent.summary.savedBytes = 3100;
		updatedCurrent.summary.estimatedTokensSaved = 775;
		updatedCurrent.summary.byCommand[0]!.commands = 3;
		updatedCurrent.summary.byCommand[0]!.savedBytes = 3100;
		updatedCurrent.summary.byCommand[0]!.estimatedTokensSaved = 775;

		const updatedAll: MinimizerGainContext = {
			...updatedCurrent,
			all: true,
			summary: {
				...updatedCurrent.summary,
				byCwd: [
					{
						cwd: "/repo/with\ttab",
						commands: 3,
						inputBytes: 3500,
						outputBytes: 900,
						savedBytes: 3100,
						estimatedTokensSaved: 775,
						usesEstimatedTokensSaved: true,
					},
				],
			},
		};

		const requestRender = vi.fn();
		const component = new MinimizerGainOverlayComponent(
			makeDualContext(),
			requestRender,
			() => {},
			async () => ({ current: updatedCurrent, all: updatedAll }),
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
