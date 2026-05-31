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
			estimatedInputTokens: 875,
			tokensSavedRatio: 650 / 875,
			usesEstimatedTokensSaved: true,
			byFilter: [
				{
					filter: "git\tstatus",
					commands: 2,
					inputBytes: 3500,
					outputBytes: 900,
					savedBytes: 2600,
					estimatedTokensSaved: 650,
					estimatedInputTokens: 875,
					tokensSavedRatio: 650 / 875,
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
					estimatedInputTokens: 875,
					tokensSavedRatio: 650 / 875,
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
					estimatedPotentialTokensSaved: 3000,
					avgEstimatedPotentialTokensSaved: 1000,
					exitCodes: [0, 1],
				},
			],
			potentialTokenSavings: [
				{
					command: "cargo test --workspace --no-fail-fast --\tverbose",
					filter: "missed",
					commands: 3,
					inputBytes: 12000,
					outputBytes: 12000,
					avgInputBytes: 4000,
					exitCodes: [0, 1],
					estimatedPotentialTokensSaved: 3000,
					avgEstimatedPotentialTokensSaved: 1000,
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
					estimatedInputTokens: 875,
					tokensSavedRatio: 650 / 875,
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

		expect(render(component)).toContain("Token Savings (Current Scope)");
		expect(render(component)).toContain("[ Current ]");

		component.handleInput("\t");
		expect(render(component)).toContain("Largest unminimized shell outputs");
		expect(render(component)).not.toContain("Token Savings");

		component.handleInput("s");
		expect(render(component)).toContain("[ All ]");
		// Tab cycle was Gain→Missed. Status tab added (Tier 1 plan T4)
		// extends the cycle to Gain→Missed→Status→Gain. We're currently
		// on Missed; two more Tabs lands us back on Gain.
		component.handleInput("\t");
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
	it("sanitizes and flattens newlines in multiline commands", () => {
		const context = makeDualContext();
		context.current.missed.commands[0]!.command = "python - <<'PY'\nimport asyncio\nfrom pathlib import Path\nPY";
		const component = new MinimizerGainOverlayComponent(
			context,
			() => {},
			() => {},
		);
		// Switch to Missed tab to render the missed command table
		component.handleInput("\t");
		const output = render(component);
		// The command should be flattened to one line using space
		expect(output).toContain("python - <<'PY' import asyncio from pathlib import Path PY");
		// Ensure the newlines from the command don't leak into the output
		const lines = component.render(100);
		for (const line of lines) {
			expect(line).not.toContain("\n");
			expect(line).not.toContain("\r");
		}
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
						estimatedInputTokens: 875,
						tokensSavedRatio: 775 / 875,
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
			expect(render(component)).toContain("Total commands: 2");

			await component.refresh();

			const output = render(component);
			expect(output).toContain("Total commands: 3");
			expect(output).toContain("775");
			expect(requestRender).toHaveBeenCalledTimes(1);
		} finally {
			component.dispose();
		}
	});

	it("renders Status tab from diagnostic payload", () => {
		const dual: DualContext = {
			...makeDualContext(),
			diagnostic: {
				recordsFilePath: "/agent/minimizer-gain.jsonl",
				exists: true,
				fileSizeBytes: 12345,
				mtime: "2026-05-28T00:00:00.000Z",
				recordCount: 100,
				recordCountInScope: 42,
				savedCount: 30,
				missedCount: 12,
				mostRecentTimestamp: "2026-05-28T00:00:00.000Z",
				recentMissedRatio: 0.25,
				recentHitRatio: 0.75,
				minimizerAppearsInactive: false,
				avgSavedRatio: 0.85,
				loadDurationMs: 7,
				writeErrorCount: 0,
				lastWriteError: null,
				readErrorCount: 0,
				lastReadError: null,
				parseErrorCount: 0,
				lastParseError: null,
				minimizerEnabled: true,
				nativeBindingLoaded: true,
				cwdFilter: "/repo",
				distinctCwdsCount: 3,
				distinctCwdsSample: ["/repo", "/other"],
			},
		};
		const component = new MinimizerGainOverlayComponent(
			dual,
			() => {},
			() => {},
		);
		// Tab to Status (Gain→Missed→Status).
		component.handleInput("\t");
		component.handleInput("\t");
		const output = render(component);
		expect(output).toContain("Diagnostic");
		expect(output).toContain("Records (file-wide): 100");
		expect(output).toContain("Records (in scope): 42");
		expect(output).toContain("Saved: 30");
		expect(output).toContain("Missed: 12");
		expect(output).toContain("Avg saved ratio: 0.850");
		expect(output).toContain("Recent hit ratio (last 50): 0.750");
		expect(output).toContain("Recent missed ratio (last 50): 0.250");
		expect(output).toContain("Native binding loaded: true");
	});

	it("renders Missed tab dual-view with byte and token savings sections", () => {
		const component = new MinimizerGainOverlayComponent(
			makeDualContext(),
			() => {},
			() => {},
		);
		// Tab once: Gain → Missed.
		component.handleInput("\t");
		const output = render(component);

		// Both section headings must be present.
		expect(output).toContain("Largest unminimized shell outputs");
		expect(output).toContain("Highest potential token savings");

		// Byte-view row: fixture has 3 commands, 12000B total, 4000 avg.
		expect(output).toContain("12K");
		expect(output).toContain("4K");

		// Token-view row: estimatedPotentialTokensSaved=3000 → "3K tok total", avg=1000 → "1K avg".
		expect(output).toContain("3K tok total");
		expect(output).toContain("1K avg");

		// Exit codes from fixture: [0, 1].
		expect(output).toContain("exit=0,1");

		// Tab characters in command must be sanitized.
		expect(output).not.toContain("\t");
		expect(output).toContain("cargo test --workspace");
	});

	it("renders Gain tab with % tokens saved in summary row and filter/command rows", () => {
		const component = new MinimizerGainOverlayComponent(
			makeDualContext(),
			() => {},
			() => {},
		);
		// Default tab is Gain — no navigation needed.
		const output = render(component);

		// Summary row: estimatedTokensSaved=650, tokensSavedRatio=650/875≈0.742857 → 74.3%
		// Renderer produces: "Estimated Tokens Saved: 650 (74.3% tokens saved)"
		expect(output).toContain("74.3%");
		expect(output).toContain("tokens saved");

		// formatGainRow for byFilter row produces: "... (74.3% saved)"
		// Both the summary row suffix ("tokens saved") and gain-row suffix ("saved") include 74.3%.
		expect(output).toContain("74.3% tokens saved");
		expect(output).toContain("74.3% saved");
	});

	it("renders Status tab buildError sentinel", () => {
		const dual: DualContext = {
			...makeDualContext(),
			diagnostic: { buildError: "stat ENOENT" },
		};
		const component = new MinimizerGainOverlayComponent(
			dual,
			() => {},
			() => {},
		);
		component.handleInput("\t");
		component.handleInput("\t");
		const output = render(component);
		expect(output).toContain("Diagnostic error: stat ENOENT");
	});

	it("Missed tab renders both largest-output and highest-potential-token-savings views", () => {
		const component = new MinimizerGainOverlayComponent(
			makeDualContext(),
			() => {},
			() => {},
		);
		// Navigate to Missed tab (Tab from Gain)
		component.handleInput("\t");
		const output = render(component);
		expect(output).toContain("Largest unminimized shell outputs");
		expect(output).toContain("Highest potential token savings");
		// Largest-output table headers
		expect(output).toContain("Command");
		expect(output).toContain("Count");
		expect(output).toContain("Total");
		expect(output).toContain("Avg");
		expect(output).toContain("Exit");
		// Highest-potential table headers
		expect(output).toContain("Avg Est");
		expect(output).toContain("Est Savings");
		// Fixture row values for potential table:
		// command prefix, count=3, avg=1K, total est=3K, exits=0,1
		expect(output).toContain("cargo test");
		expect(output).toContain("3");
		expect(output).toContain("1K");
		expect(output).toContain("3K");
		expect(output).toContain("0,1");
	});

	it("Status tab shows recent hit ratio", () => {
		const dual: DualContext = {
			...makeDualContext(),
			diagnostic: {
				recordsFilePath: "/agent/minimizer-gain.jsonl",
				exists: true,
				fileSizeBytes: 12345,
				mtime: "2026-05-28T00:00:00.000Z",
				recordCount: 100,
				recordCountInScope: 50,
				savedCount: 30,
				missedCount: 20,
				mostRecentTimestamp: "2026-05-28T00:00:00.000Z",
				recentMissedRatio: 0.4,
				recentHitRatio: 0.6,
				minimizerAppearsInactive: false,
				avgSavedRatio: 0.75,
				loadDurationMs: 5,
				writeErrorCount: 0,
				lastWriteError: null,
				readErrorCount: 0,
				lastReadError: null,
				parseErrorCount: 0,
				lastParseError: null,
				minimizerEnabled: true,
				nativeBindingLoaded: true,
				cwdFilter: "/repo",
				distinctCwdsCount: 2,
				distinctCwdsSample: ["/repo"],
			},
		};
		const component = new MinimizerGainOverlayComponent(
			dual,
			() => {},
			() => {},
		);
		// Navigate to Status tab (Tab × 2 from Gain)
		component.handleInput("\t");
		component.handleInput("\t");
		const output = render(component);
		expect(output).toContain("Recent hit ratio (last 50): 0.600");
		expect(output).toContain("Recent missed ratio (last 50): 0.400");
	});

	it("Gain tab renders token savings table with summary and By Command table", () => {
		const component = new MinimizerGainOverlayComponent(
			makeDualContext(),
			() => {},
			() => {},
		);
		const output = render(component);
		// makeContext has tokensSavedRatio = 650/875 ≈ 0.743 → 74.3%
		expect(output).toContain("Token Savings (Current Scope)");
		expect(output).toContain("Total commands:");
		expect(output).toContain("Input tokens:");
		expect(output).toContain("Output tokens:");
		expect(output).toContain("Tokens saved:");
		expect(output).toContain("74.3%");
		expect(output).toContain("Efficiency meter:");
		expect(output).toContain("By Command");
		// Table header columns
		expect(output).toContain("#");
		expect(output).toContain("Command");
		expect(output).toContain("Count");
		expect(output).toContain("Saved");
		expect(output).toContain("Avg%");
		expect(output).toContain("Impact");
	});
});
