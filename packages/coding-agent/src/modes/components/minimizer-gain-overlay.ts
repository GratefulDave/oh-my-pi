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

interface DualContext {
	current: MinimizerGainContext;
	all: MinimizerGainContext;
	diagnostic?: MinimizerGainDiagnostic | DiagnosticErrorSentinel;
}

function clean(text: string, width: number): string {
	return truncateToWidth(replaceTabs(text), width);
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
		`  ${label}: ${formatNumber(row.commands)} cmds, ${formatNumber(row.savedBytes)} saved, ${formatNumber(row.estimatedTokensSaved)} ${formatTokensSavedLabel(row.usesEstimatedTokensSaved)}${pctPart}`,
		width,
	);
}

function formatMissedRow(
	label: string,
	row: { commands: number; inputBytes: number; avgInputBytes: number; exitCodes: Array<number | null> },
	width: number,
): string {
	return clean(
		`  ${label}: ${formatNumber(row.commands)} cmds, ${formatNumber(row.inputBytes)}B total (${formatNumber(row.avgInputBytes)} avg), exit=${formatExitCodes(row.exitCodes)}`,
		width,
	);
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
		lines.push(clean(`  Records (file-wide): ${formatNumber(diag.recordCount)}`, width));
		lines.push(clean(`  Records (in scope): ${formatNumber(diag.recordCountInScope)}`, width));
		lines.push(clean(`  Saved: ${formatNumber(diag.savedCount)}  Missed: ${formatNumber(diag.missedCount)}`, width));
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
		lines.push(clean(`  Distinct cwds: ${formatNumber(diag.distinctCwdsCount)}`, width));
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
			lines.push(clean(theme.fg("accent", theme.bold("Positive minimizer savings")), width));
			lines.push(formatRow("Commands", formatNumber(context.summary.commands), width));
			lines.push(formatRow("Input Bytes", formatNumber(context.summary.inputBytes), width));
			lines.push(formatRow("Output Bytes", formatNumber(context.summary.outputBytes), width));
			lines.push(formatRow("Saved Bytes", formatNumber(context.summary.savedBytes), width));
			lines.push(
				formatRow(
					formatTokensSavedLabel(context.summary.usesEstimatedTokensSaved),
					formatNumber(context.summary.estimatedTokensSaved),
					width,
				),
			);
			if (context.summary.tokensSavedRatio !== null) {
				lines.push(formatRow("% Tokens Saved", `${(context.summary.tokensSavedRatio * 100).toFixed(1)}%`, width));
			}
			lines.push("");
			lines.push(clean(theme.fg("muted", "Top filters"), width));
			if (context.summary.byFilter.length === 0) {
				lines.push(clean(theme.fg("dim", "  (none)"), width));
			} else {
				for (const row of context.summary.byFilter.slice(0, 5)) {
					lines.push(formatGainRow(row.filter, row, contentWidth));
				}
			}
			lines.push("");
			lines.push(clean(theme.fg("muted", "Top commands"), width));
			if (context.summary.byCommand.length === 0) {
				lines.push(clean(theme.fg("dim", "  (none)"), width));
			} else {
				for (const row of context.summary.byCommand.slice(0, 5)) {
					lines.push(formatGainRow(row.command, row, contentWidth));
				}
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
				for (const row of context.missed.commands.slice(0, 8)) {
					lines.push(formatMissedRow(row.command, row, contentWidth));
				}
			}
			lines.push("");
			lines.push(clean(theme.fg("accent", theme.bold("Highest potential token savings")), width));
			if (context.missed.potentialTokenSavings.length === 0) {
				lines.push(clean(theme.fg("dim", "No potential token savings data."), width));
			} else {
				for (const row of context.missed.potentialTokenSavings.slice(0, 8)) {
					lines.push(
						clean(
							`  ${row.command}: ${formatNumber(row.commands)} cmds × ${formatNumber(row.avgEstimatedPotentialTokensSaved)} avg = ${formatNumber(row.estimatedPotentialTokensSaved)} est. tokens, exit=${formatExitCodes(row.exitCodes)}`,
							contentWidth,
						),
					);
				}
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
