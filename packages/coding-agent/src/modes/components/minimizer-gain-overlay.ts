import { type Component, matchesKey, replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import {
	incrementMinimizerGainReadError,
	type MinimizerGainContext,
	type MinimizerGainDiagnostic,
} from "../../minimizer-gain";
import { shortenPath } from "../../tools/render-utils";
import { theme } from "../theme/theme";

type LoadMinimizerGainContext = () => Promise<DualContext>;

const REFRESH_INTERVAL_MS = 1000;

const TABS = ["Gain", "Missed", "Status"] as const;
type TabIndex = 0 | 1 | 2;

const SCOPES = ["Current", "All"] as const;
type ScopeIndex = 0 | 1;

/** Sentinel injected into DualContext when buildMinimizerGainDiagnostic throws. */
export interface DiagnosticErrorSentinel {
	buildError: string;
}

function formatFullNumber(n: number): string {
	return Math.round(n)
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

interface DualContext {
	current: MinimizerGainContext;
	all: MinimizerGainContext;
	diagnostic?: MinimizerGainDiagnostic | DiagnosticErrorSentinel;
}

function clean(text: string, width: number): string {
	const singleLine = text.replace(/[\r\n]+/g, " ");
	return truncateToWidth(replaceTabs(singleLine), width);
}

function border(width: number): string {
	return theme.fg("border", theme.boxSharp.horizontal.repeat(Math.max(1, width)));
}

function formatTokensSavedLabel(usesEstimatedTokensSaved: boolean): string {
	return usesEstimatedTokensSaved ? "Estimated Tokens Saved" : "Tokens Saved";
}

function formatExitCodes(exitCodes: Array<number | null>): string {
	if (exitCodes.length === 0) return "-";
	return exitCodes.map(code => (code === null ? "?" : String(code))).join(",");
}

function formatTab(label: string, active: boolean): string {
	return active ? theme.fg("accent", theme.bold(`[ ${label} ]`)) : theme.fg("dim", `  ${label}  `);
}

function formatRow(label: string, value: string, width: number): string {
	return clean(`  ${label}: ${value}`, width);
}

function formatGainRow<
	T extends {
		commands: number;
		savedBytes: number;
		estimatedTokensSaved: number;
		usesEstimatedTokensSaved: boolean;
		tokensSavedRatio: number | null;
	},
>(label: string, row: T, width: number): string {
	const pctPart = row.tokensSavedRatio !== null ? `, ${(row.tokensSavedRatio * 100).toFixed(1)}% saved` : "";
	return clean(
		`  ${label}: ${formatFullNumber(row.commands)} cmds, ${formatNumber(row.savedBytes)} saved, ${formatNumber(row.estimatedTokensSaved)} ${formatTokensSavedLabel(row.usesEstimatedTokensSaved)}${pctPart}`,
		width,
	);
}

// Fixed column widths for numeric columns in the Missed tab tables.
// Command column is computed from contentWidth minus the sum of fixed widths.
const COL_COUNT = 6;
const COL_TOTAL = 7;
const COL_AVG = 7;
const COL_EXIT = 6;
const COL_AVG_EST = 8;
const COL_EST_SAVINGS = 12;
// 2-char left margin + separator after cmd + 4 numeric cols with 3 separators between them
const MISSED_TABLE_FIXED = 2 + 1 + COL_COUNT + 1 + COL_TOTAL + 1 + COL_AVG + 1 + COL_EXIT;
const POTENTIAL_TABLE_FIXED = 2 + 1 + COL_COUNT + 1 + COL_AVG_EST + 1 + COL_EST_SAVINGS + 1 + COL_EXIT;

// Fixed column widths for By Command table in Gain tab.
// Layout: "  #.  " + cmd + " " + Count + " " + Saved + " " + Avg% + " " + Impact
const GAIN_COL_NUM = 4; // "  1." prefix
const GAIN_COL_COUNT = 7;
const GAIN_COL_SAVED = 9;
const GAIN_COL_AVG_PCT = 6;
const GAIN_COL_IMPACT = 10;
// total fixed: num(4) + 1 + count(7) + 1 + saved(9) + 1 + avg%(6) + 1 + impact(10) = 40; cmd gets the rest
const GAIN_TABLE_FIXED =
	GAIN_COL_NUM + 1 + GAIN_COL_COUNT + 1 + GAIN_COL_SAVED + 1 + GAIN_COL_AVG_PCT + 1 + GAIN_COL_IMPACT;

const EFFICIENCY_BAR_WIDTH = 24;
const EFFICIENCY_FILL_CHAR = "\u2588";
const EFFICIENCY_EMPTY_CHAR = "\u2591";

function formatEfficiencyBar(ratio: number | null): string {
	if (ratio === null) return "-";
	const clamped = Math.max(0, Math.min(1, ratio));
	const filled = Math.round(clamped * EFFICIENCY_BAR_WIDTH);
	const empty = EFFICIENCY_BAR_WIDTH - filled;
	return `${EFFICIENCY_FILL_CHAR.repeat(filled) + EFFICIENCY_EMPTY_CHAR.repeat(empty)} ${(clamped * 100).toFixed(1)}%`;
}

function renderByCommandTable(
	rows: ReadonlyArray<{
		command: string;
		commands: number;
		estimatedTokensSaved: number;
		tokensSavedRatio: number | null;
	}>,
	contentWidth: number,
): string[] {
	const cmdWidth = Math.max(7, contentWidth - GAIN_TABLE_FIXED);
	const maxSaved = rows.length > 0 ? Math.max(...rows.map(r => r.estimatedTokensSaved)) : 0;
	const lines: string[] = [];
	// Header
	lines.push(
		clean(
			"#".padStart(GAIN_COL_NUM) +
				" " +
				"Command".padEnd(cmdWidth) +
				" " +
				"Count".padStart(GAIN_COL_COUNT) +
				" " +
				"Saved".padStart(GAIN_COL_SAVED) +
				" " +
				"Avg%".padStart(GAIN_COL_AVG_PCT) +
				" " +
				"Impact".padEnd(GAIN_COL_IMPACT),
			contentWidth,
		),
	);
	rows.slice(0, 10).forEach((row, idx) => {
		const num = `${idx + 1}.`.padStart(GAIN_COL_NUM);
		const cmd = clean(row.command, cmdWidth).padEnd(cmdWidth);
		const count = formatFullNumber(row.commands).padStart(GAIN_COL_COUNT);
		const saved = formatNumber(row.estimatedTokensSaved).padStart(GAIN_COL_SAVED);
		const avgPct =
			row.tokensSavedRatio !== null
				? `${(row.tokensSavedRatio * 100).toFixed(1)}%`.padStart(GAIN_COL_AVG_PCT)
				: "-".padStart(GAIN_COL_AVG_PCT);
		const barFill = maxSaved > 0 ? Math.round((row.estimatedTokensSaved / maxSaved) * GAIN_COL_IMPACT) : 0;
		const impact = EFFICIENCY_FILL_CHAR.repeat(barFill) + EFFICIENCY_EMPTY_CHAR.repeat(GAIN_COL_IMPACT - barFill);
		lines.push(clean(`${num} ${cmd} ${count} ${saved} ${avgPct} ${impact}`, contentWidth));
	});
	return lines;
}

function tableHeader(
	cmdWidth: number,
	colA: string,
	widthA: number,
	colB: string,
	widthB: number,
	colC: string,
	widthC: number,
): string {
	return (
		"  " +
		"Command".padEnd(cmdWidth) +
		" " +
		"Count".padStart(COL_COUNT) +
		" " +
		colA.padStart(widthA) +
		" " +
		colB.padStart(widthB) +
		" " +
		colC.padStart(widthC)
	);
}

function tableRow(
	cmd: string,
	cmdWidth: number,
	count: string,
	colA: string,
	widthA: number,
	colB: string,
	widthB: number,
	colC: string,
	widthC: number,
): string {
	return (
		"  " +
		cmd.slice(0, cmdWidth).padEnd(cmdWidth) +
		" " +
		count.padStart(COL_COUNT) +
		" " +
		colA.padStart(widthA) +
		" " +
		colB.padStart(widthB) +
		" " +
		colC.padStart(widthC)
	);
}

function renderLargestOutputTable(
	rows: ReadonlyArray<{
		command: string;
		commands: number;
		inputBytes: number;
		avgInputBytes: number;
		exitCodes: Array<number | null>;
	}>,
	contentWidth: number,
): string[] {
	const cmdWidth = Math.max(7, contentWidth - MISSED_TABLE_FIXED);
	const lines: string[] = [];
	lines.push(clean(tableHeader(cmdWidth, "Total", COL_TOTAL, "Avg", COL_AVG, "Exit", COL_EXIT), contentWidth));
	for (const row of rows.slice(0, 8)) {
		const cmd = clean(row.command, cmdWidth);
		lines.push(
			clean(
				tableRow(
					cmd,
					cmdWidth,
					formatFullNumber(row.commands),
					`${formatNumber(row.inputBytes)}B`,
					COL_TOTAL,
					`${formatNumber(row.avgInputBytes)}B`,
					COL_AVG,
					formatExitCodes(row.exitCodes),
					COL_EXIT,
				),
				contentWidth,
			),
		);
	}
	return lines;
}

function renderPotentialTable(
	rows: ReadonlyArray<{
		command: string;
		commands: number;
		avgEstimatedPotentialTokensSaved: number;
		estimatedPotentialTokensSaved: number;
		exitCodes: Array<number | null>;
	}>,
	contentWidth: number,
): string[] {
	const cmdWidth = Math.max(7, contentWidth - POTENTIAL_TABLE_FIXED);
	const lines: string[] = [];
	lines.push(
		clean(
			tableHeader(cmdWidth, "Avg Est", COL_AVG_EST, "Est Savings", COL_EST_SAVINGS, "Exit", COL_EXIT),
			contentWidth,
		),
	);
	for (const row of rows.slice(0, 8)) {
		const cmd = clean(row.command, cmdWidth);
		lines.push(
			clean(
				tableRow(
					cmd,
					cmdWidth,
					formatFullNumber(row.commands),
					formatNumber(row.avgEstimatedPotentialTokensSaved),
					COL_AVG_EST,
					formatNumber(row.estimatedPotentialTokensSaved),
					COL_EST_SAVINGS,
					formatExitCodes(row.exitCodes),
					COL_EXIT,
				),
				contentWidth,
			),
		);
	}
	return lines;
}

export class MinimizerGainOverlayComponent implements Component {
	#dualContext: DualContext;
	readonly #onClose: () => void;
	readonly #requestRender: () => void;
	readonly #loadContext: LoadMinimizerGainContext | undefined;
	#activeTabIndex: TabIndex = 0;
	#activeScopeIndex: ScopeIndex = 0;
	#refreshInterval: ReturnType<typeof setInterval> | undefined;
	#refreshing = false;
	#disposed = false;

	constructor(
		dualContext: DualContext,
		requestRender: () => void,
		onClose: () => void,
		loadContext?: LoadMinimizerGainContext,
		initialScope: ScopeIndex = 0,
	) {
		this.#dualContext = dualContext;
		this.#requestRender = requestRender;
		this.#onClose = onClose;
		this.#loadContext = loadContext;
		this.#activeScopeIndex = initialScope;
		if (loadContext) {
			this.#refreshInterval = setInterval(() => {
				void this.refresh();
			}, REFRESH_INTERVAL_MS);
		}
	}
	dispose(): void {
		this.#disposed = true;
		if (!this.#refreshInterval) return;
		clearInterval(this.#refreshInterval);
		this.#refreshInterval = undefined;
	}

	invalidate(): void {}

	async refresh(): Promise<void> {
		if (!this.#loadContext || this.#refreshing || this.#disposed) return;
		this.#refreshing = true;
		try {
			const context = await this.#loadContext();
			if (this.#disposed) return;
			this.#dualContext = context;
			this.#requestRender();
		} catch (err) {
			// Surface refresh failure via Shape α so the Status tab + `omp gain --diag`
			// reflect it; keep rendering the last complete snapshot for Gain/Missed.
			incrementMinimizerGainReadError(err);
		} finally {
			this.#refreshing = false;
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.#onClose();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.#activeTabIndex = ((this.#activeTabIndex + 1) % TABS.length) as TabIndex;
			this.#requestRender();
			return;
		}
		if (matchesKey(data, "shift+tab") || data === "s" || data === "S") {
			this.#activeScopeIndex = ((this.#activeScopeIndex + 1) % SCOPES.length) as ScopeIndex;
			this.#requestRender();
			return;
		}
		if (data === "r" || data === "R") {
			void this.refresh();
		}
	}

	#getActiveContext(): MinimizerGainContext {
		return this.#activeScopeIndex === 0 ? this.#dualContext.current : this.#dualContext.all;
	}

	#renderStatus(width: number): string[] {
		const lines: string[] = [];
		const diag = this.#dualContext.diagnostic;
		if (!diag) {
			lines.push(clean(theme.fg("dim", "  (diagnostic not loaded)"), width));
			return lines;
		}
		if ("buildError" in diag) {
			lines.push(clean(theme.fg("accent", `  Diagnostic error: ${diag.buildError}`), width));
			return lines;
		}
		lines.push(clean(theme.fg("accent", theme.bold("Diagnostic")), width));
		lines.push(clean(`  Records (file-wide): ${formatFullNumber(diag.recordCount)}`, width));
		lines.push(clean(`  Records (in scope): ${formatFullNumber(diag.recordCountInScope)}`, width));
		lines.push(
			clean(`  Saved: ${formatFullNumber(diag.savedCount)}  Missed: ${formatFullNumber(diag.missedCount)}`, width),
		);
		lines.push(clean(`  Most recent: ${diag.mostRecentTimestamp ?? "-"}`, width));
		lines.push(
			clean(`  Avg saved ratio: ${diag.avgSavedRatio === null ? "-" : diag.avgSavedRatio.toFixed(3)}`, width),
		);
		lines.push(
			clean(
				`  Recent missed ratio (last 50): ${diag.recentMissedRatio === null ? "-" : diag.recentMissedRatio.toFixed(3)}`,
				width,
			),
		);
		lines.push(
			clean(
				`  Recent hit ratio (last 50): ${diag.recentHitRatio === null ? "-" : diag.recentHitRatio.toFixed(3)}`,
				width,
			),
		);
		if (diag.minimizerAppearsInactive) {
			lines.push(clean(theme.fg("accent", "  ⚠ Minimizer appears inactive"), width));
		}
		lines.push(clean(`  Load duration: ${diag.loadDurationMs}ms`, width));
		lines.push(clean(`  File size: ${formatNumber(diag.fileSizeBytes)} bytes`, width));
		lines.push(clean(`  Write errors: ${diag.writeErrorCount}`, width));
		if (diag.lastWriteError) {
			lines.push(clean(theme.fg("dim", `    last: ${diag.lastWriteError.error}`), width));
		}
		lines.push(clean(`  Read errors: ${diag.readErrorCount}`, width));
		if (diag.lastReadError) {
			lines.push(clean(theme.fg("dim", `    last: ${diag.lastReadError.error}`), width));
		}
		lines.push(clean(`  Parse errors: ${diag.parseErrorCount}`, width));
		if (diag.lastParseError) {
			lines.push(
				clean(
					theme.fg("dim", `    last: ${diag.lastParseError.error} (line ${diag.lastParseError.lineNumber})`),
					width,
				),
			);
		}
		lines.push(clean(`  Minimizer enabled: ${diag.minimizerEnabled}`, width));
		lines.push(clean(`  Native binding loaded: ${diag.nativeBindingLoaded}`, width));
		lines.push(clean(`  CWD filter: ${diag.cwdFilter ?? "(all)"}`, width));
		lines.push(clean(`  Distinct cwds: ${formatFullNumber(diag.distinctCwdsCount)}`, width));
		if (diag.recordCountInScope === 0 && diag.distinctCwdsCount > 0) {
			lines.push(clean(theme.fg("dim", "  (scope empty but file has records under other cwds)"), width));
			for (const cwd of diag.distinctCwdsSample) {
				lines.push(clean(theme.fg("dim", `    ${shortenPath(cwd)}`), width));
			}
		}
		return lines;
	}

	render(width: number): string[] {
		const contentWidth = Math.max(24, width - 2);
		const lines: string[] = [];
		const activeTab = TABS[this.#activeTabIndex];
		const activeScope = SCOPES[this.#activeScopeIndex];
		const context = this.#getActiveContext();

		lines.push(border(width));
		lines.push(
			clean(
				`${theme.bold(" Minimizer Gain ")} ${formatTab("Current", activeScope === "Current")} ${theme.fg("dim", "│")} ${formatTab("All", activeScope === "All")}`,
				width,
			),
		);
		lines.push(
			clean(
				`${formatTab("Gain", activeTab === "Gain")} ${theme.fg("dim", "│")} ${formatTab("Missed", activeTab === "Missed")} ${theme.fg("dim", "│")} ${formatTab("Status", activeTab === "Status")}`,
				width,
			),
		);

		lines.push(
			clean(
				theme.fg("muted", `Scope: ${context.all ? "all repos" : shortenPath(context.cwd ?? process.cwd())}`),
				width,
			),
		);
		lines.push("");

		if (activeTab === "Status") {
			lines.push(...this.#renderStatus(width));
			lines.push("");
			lines.push(clean(theme.fg("dim", "Tab · S switch scope · R refresh · Esc close"), width));
			lines.push(clean(theme.fg("dim", `Path: ${shortenPath(context.path)}`), width));
			lines.push(border(width));
			return lines;
		}

		if (activeTab === "Gain") {
			const scopeLabel = context.all ? "Global Scope" : "Current Scope";
			lines.push(clean(theme.fg("accent", theme.bold(`Token Savings (${scopeLabel})`)), width));
			lines.push(border(contentWidth));
			lines.push(formatRow("Total commands", formatFullNumber(context.summary.commands), width));
			const inputTok = context.summary.estimatedInputTokens;
			lines.push(formatRow("Input tokens", formatNumber(inputTok), width));
			const savedTok = context.summary.estimatedTokensSaved;
			const outputTok = Math.max(0, inputTok - savedTok);
			lines.push(formatRow("Output tokens", formatNumber(outputTok), width));
			const ratioStr =
				context.summary.tokensSavedRatio !== null
					? ` (${(context.summary.tokensSavedRatio * 100).toFixed(1)}%)`
					: "";
			lines.push(formatRow("Tokens saved", `${formatNumber(savedTok)}${ratioStr}`, width));
			lines.push(formatRow("Efficiency meter", formatEfficiencyBar(context.summary.tokensSavedRatio), width));
			lines.push("");
			lines.push(clean(theme.fg("accent", theme.bold("By Command")), width));
			lines.push(clean(theme.fg("dim", "\u2500".repeat(Math.max(1, contentWidth))), width));
			if (context.summary.byCommand.length === 0) {
				lines.push(clean(theme.fg("dim", "  (none)"), width));
			} else {
				lines.push(...renderByCommandTable(context.summary.byCommand, contentWidth));
			}
			if (context.all) {
				lines.push("");
				lines.push(clean(theme.fg("muted", "Repositories"), width));
				if (context.summary.byCwd.length === 0) {
					lines.push(clean(theme.fg("dim", "  (none)"), width));
				} else {
					for (const row of context.summary.byCwd.slice(0, 5)) {
						lines.push(formatGainRow(shortenPath(row.cwd), row, contentWidth));
					}
				}
			}
		} else {
			lines.push(clean(theme.fg("accent", theme.bold("Largest unminimized shell outputs")), width));
			if (context.missed.commands.length === 0) {
				lines.push(clean(theme.fg("dim", "No unminimized shell output recorded for this scope yet."), width));
			} else {
				lines.push(...renderLargestOutputTable(context.missed.commands, contentWidth));
			}
			lines.push("");
			lines.push(clean(theme.fg("accent", theme.bold("Highest potential token savings")), width));
			if (context.missed.potentialTokenSavings.length === 0) {
				lines.push(clean(theme.fg("dim", "No potential token savings data."), width));
			} else {
				lines.push(...renderPotentialTable(context.missed.potentialTokenSavings, contentWidth));
			}
		}

		lines.push("");
		lines.push(clean(theme.fg("dim", "Tab · S switch scope · R refresh · Esc close"), width));
		lines.push(clean(theme.fg("dim", `Path: ${shortenPath(context.path)}`), width));
		lines.push(border(width));
		return lines;
	}
}

export type { DualContext, LoadMinimizerGainContext, ScopeIndex };
