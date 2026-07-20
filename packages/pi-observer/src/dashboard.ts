// ---------------------------------------------------------------------------
// Observer dashboard — live TUI overlay showing agent activity stats.
// ---------------------------------------------------------------------------

import {
	formatCount,
	formatDuration,
	getSessionUptime,
	getStats,
	getSubagentTotals,
	type ObserverStats,
} from "./stats-collector";

// ---------------------------------------------------------------------------
// Minimal interfaces matching what TUI passes to custom components.
// ---------------------------------------------------------------------------

interface ObserverTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	dim(text: string): string;
}

/** Called to request a re-render (e.g. from a timer). */
type RequestRender = () => void;
/** Called when user dismisses the overlay (Esc). */
type DoneCallback = () => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REFRESH_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildBar(ratio: number, width: number): string {
	const fill = "█";
	const empty = "░";
	const fillCount = Math.round(ratio * width);
	return fill.repeat(fillCount) + empty.repeat(width - fillCount);
}

function formatDollar(n: number): string {
	return `$${n.toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export class ObserverDashboard {
	#refreshHandle: ReturnType<typeof setInterval> | undefined;
	#lastStats: ObserverStats | undefined;

	constructor(
		private readonly theme: ObserverTheme,
		readonly requestRender: RequestRender,
		private readonly done: DoneCallback,
	) {
		this.#refreshHandle = setInterval(() => {
			this.#lastStats = getStats();
			requestRender();
		}, REFRESH_INTERVAL_MS);
	}

	act(key: string): boolean {
		if (key === "escape") {
			this.destroy();
			this.done();
			return true;
		}
		return false;
	}

	get height(): number {
		return getSubagentTotals().count > 0 ? 36 : 28;
	}

	layout(_width: number, _height: number): void {}

	render(_width: number, _height: number): string[] {
		const s = this.#lastStats ?? getStats();
		const lines: string[] = [];
		const { fg, bold, dim } = this.theme;

		// Header
		lines.push("");
		lines.push(bold(fg("cyan", "  Agent Activity Monitor")));
		lines.push(
			dim(`  Uptime: ${formatDuration(getSessionUptime())} | Runs: ${s.agentRuns} | Turns: ${s.turns.length}`),
		);
		lines.push("");

		// Active tools section
		const active = [...s.activeToolCalls.values()];
		if (active.length > 0) {
			lines.push(bold("  Active Tools:"));
			for (const tc of active) {
				const elapsed = formatDuration(Date.now() - tc.startTime);
				lines.push(`    ${fg("yellow", tc.toolName)} — ${elapsed} elapsed`);
			}
		} else {
			lines.push(dim("  Active Tools: none"));
		}
		lines.push("");

		// Token usage
		lines.push(bold("  Token Usage:"));
		lines.push(`    Input:  ${formatCount(s.totalTokensInput)}`);
		lines.push(`    Output: ${formatCount(s.totalTokensOutput)}`);
		lines.push(`    Total:  ${formatCount(s.totalTokensInput + s.totalTokensOutput)}`);
		lines.push(`    Cost:   ${formatDollar(s.estimatedCost)}`);
		lines.push("");

		// Subagent activity (fanned in from the parent EventBus). Subagents run in
		// separate sessions, so this is the only place their activity rolls up.
		const sub = getSubagentTotals();
		if (sub.count > 0) {
			lines.push(bold("  Subagent Activity:"));
			lines.push(`    Subagents:  ${sub.count} (${sub.activeCount} active)`);
			lines.push(`    Tokens:     ${formatCount(sub.tokens)}`);
			lines.push(`    Tool Calls: ${formatCount(sub.toolCount)}`);
			lines.push(`    Cost:       ${formatDollar(sub.cost)}`);
			const grandTokens = s.totalTokensInput + s.totalTokensOutput + sub.tokens;
			const grandCost = s.estimatedCost + sub.cost;
			lines.push(dim(`    Grand Total: ${formatCount(grandTokens)} tokens | ${formatDollar(grandCost)}`));
			lines.push("");
		}

		// Context pressure gauge
		const totalTokens = s.totalTokensInput + s.totalTokensOutput;
		const contextWindowTokens = 200_000;
		if (totalTokens > 0) {
			const contextRatio = Math.min(1, totalTokens / contextWindowTokens);
			const bar = buildBar(contextRatio, 16);
			lines.push(bold("  Context Pressure:"));
			lines.push(`    ${bar} ${(contextRatio * 100).toFixed(1)}%`);
			if (contextRatio > 0.85) {
				lines.push(fg("red", "    ⚠ Near context limit — compaction recommended"));
			}
		} else {
			lines.push(dim("  Context Pressure: no data yet"));
		}
		lines.push("");

		// Tool call frequency
		if (s.toolCallCounts.size > 0) {
			lines.push(bold("  Tool Calls:"));
			const sorted = [...s.toolCallCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
			const maxCount = sorted[0]?.[1] ?? 1;
			for (const [name, count] of sorted) {
				const ratio = count / maxCount;
				const freqBar = buildBar(ratio, 10);
				lines.push(`    ${name.padEnd(14)} ${freqBar} ${count}`);
			}
		}
		lines.push("");

		// Recent turns
		const recentTurns = s.turns.slice(-5);
		if (recentTurns.length > 0) {
			lines.push(bold("  Recent Turns:"));
			for (const turn of recentTurns) {
				const turnDur = turn.endTime != null ? formatDuration(turn.endTime - turn.startTime) : "running";
				const toolCount = turn.toolCalls.length;
				const tInput = turn.tokensInput != null ? formatCount(turn.tokensInput) : "—";
				const tOutput = turn.tokensOutput != null ? formatCount(turn.tokensOutput) : "—";
				lines.push(`    Turn #${turn.turnNumber}: ${turnDur} | ${toolCount} tools | ${tInput}/${tOutput} tokens`);
			}
		}

		lines.push("");
		lines.push(dim("  Press Esc to close"));

		return lines;
	}

	destroy(): void {
		if (this.#refreshHandle != null) {
			clearInterval(this.#refreshHandle);
			this.#refreshHandle = undefined;
		}
	}
}
