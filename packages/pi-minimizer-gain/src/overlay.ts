import * as os from "node:os";
import { formatNumber } from "@oh-my-pi/pi-utils";
import {
	incrementMinimizerGainReadError,
	type MinimizerGainContext,
	type MinimizerGainDiagnostic,
} from "./gain-engine";

interface GainTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	boxSharp: { horizontal: string };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function truncateToWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	const singleLine = text.replace(/[\r\n]+/g, " ");
	let visible = 0;
	let result = "";
	let i = 0;
	while (i < singleLine.length && visible < maxWidth) {
		const m = ANSI_RE.exec(singleLine);
		if (m && m.index === i) {
			result += m[0];
			i = m.index + m[0].length;
			ANSI_RE.lastIndex = i;
			continue;
		}
		result += singleLine[i];
		visible++;
		i++;
	}
	return result;
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "    ");
}

function clean(text: string, width: number): string {
	return truncateToWidth(replaceTabs(text), width);
}

function matchesKey(data: string, expected: string): boolean {
	// Kitty protocol escape key: \x1b[27u (plain) or \x1b[1;27u (with modifiers)
	if (expected === "escape") {
		return data === "\x1b" || data === "\x1b[27u" || data === "\x1b[1;27u";
	}
	if (expected === "tab") return data === "\t" || data === "\x1b[I";
	if (expected === "shift+tab") return data === "\x1b[Z" || data === "\x1b[1;2I";
	return false;
}

function shortenPath(filePath: string): string {
	const home = os.homedir();
	if (filePath.startsWith(home)) {
		return `~${filePath.slice(home.length)}`;
	}
	return filePath;
}

function formatDurationMs(ms: number | null): string {
	if (ms === null) return "-";
	if (ms < 1_000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h`;
}

function formatFullNumber(n: number): string {
	return Math.round(n)
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
type LoadMinimizerGainContext = (scope: ScopeIndex) => Promise<DualContext>;

const REFRESH_INTERVAL_MS = 1000;

const TABS = ["Gain", "Missed", "Status"] as const;
type TabIndex = 0 | 1 | 2;

const SCOPES = ["Current", "All"] as const;
type ScopeIndex = 0 | 1;

export interface DiagnosticErrorSentinel {
	buildError: string;
}

interface DualContext {
	current: MinimizerGainContext;
	all: MinimizerGainContext;
	diagnostic?: MinimizerGainDiagnostic | DiagnosticErrorSentinel;
}

function formatExitCodes(exitCodes: Array<number | null>): string {
	if (exitCodes.length === 0) return "exit=-";
	return `exit=${exitCodes.map(code => (code === null ? "?" : String(code))).join(",")}`;
}

function ratioPercentColor(ratio: number | null): "success" | "warning" | "error" | "dim" {
	if (ratio === null) return "dim";
	if (ratio >= 0.7) return "success";
	if (ratio >= 0.3) return "warning";
	return "error";
}

const COL_COUNT = 6;
const COL_TOTAL = 7;
const COL_AVG = 7;
const COL_EXIT = 8;
const COL_AVG_EST = 8;
const COL_EST_SAVINGS = 12;
const MISSED_TABLE_FIXED = 2 + 1 + COL_COUNT + 1 + COL_TOTAL + 1 + COL_AVG + 1 + COL_EXIT;
const POTENTIAL_TABLE_FIXED = 2 + 1 + COL_COUNT + 1 + COL_AVG_EST + 1 + COL_EST_SAVINGS + 1 + COL_EXIT;

const GAIN_COL_NUM = 4;
const GAIN_COL_COUNT = 7;
const GAIN_COL_SAVED = 9;
const GAIN_COL_AVG_PCT = 12;
const GAIN_COL_IMPACT = 10;
const GAIN_TABLE_FIXED =
	GAIN_COL_NUM + 1 + GAIN_COL_COUNT + 1 + GAIN_COL_SAVED + 1 + GAIN_COL_AVG_PCT + 1 + GAIN_COL_IMPACT;

const EFFICIENCY_BAR_WIDTH = 24;
const EFFICIENCY_FILL_CHAR = "█";
const EFFICIENCY_EMPTY_CHAR = "░";

export class MinimizerGainOverlayComponent {
	#theme: GainTheme;
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
		theme: GainTheme,
		dualContext: DualContext,
		requestRender: () => void,
		onClose: () => void,
		loadContext?: LoadMinimizerGainContext,
		initialScope: ScopeIndex = 0,
	) {
		this.#theme = theme;
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
		const context = await this.#loadContext(this.#activeScopeIndex);
			if (this.#disposed) return;
			this.#dualContext = context;
			this.#requestRender();
		} catch (err) {
			incrementMinimizerGainReadError(err);
		} finally {
			this.#refreshing = false;
		}
	}

	act(key: string): boolean {
		if (key === "escape") {
			this.#onClose();
			return true;
		}
		if (key === "tab") {
			this.#activeTabIndex = ((this.#activeTabIndex + 1) % TABS.length) as TabIndex;
			this.#requestRender();
			return true;
		}
		if (key === "s" || key === "S") {
			this.#activeScopeIndex = ((this.#activeScopeIndex + 1) % SCOPES.length) as ScopeIndex;
			this.#requestRender();
			void this.refresh();
			return true;
		}
		if (key === "r" || key === "R") {
			void this.refresh();
			return true;
		}
		return false;
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
			void this.refresh();
			return;
		}
		if (data === "r" || data === "R") {
			void this.refresh();
		}
	}

	#getActiveContext(): MinimizerGainContext {
		return this.#activeScopeIndex === 0 ? this.#dualContext.current : this.#dualContext.all;
	}

	// -------------------------------------------------------------------
	// Color helpers — professional palette
	// -------------------------------------------------------------------

	#heading(text: string): string {
		return this.#theme.fg("mdHeading", this.#theme.bold(text));
	}
	#code(text: string): string {
		return this.#theme.fg("mdCode", text);
	}
	#link(text: string): string {
		return this.#theme.fg("mdLink", text);
	}
	#keyword(text: string): string {
		return this.#theme.fg("syntaxKeyword", text);
	}
	#success(text: string): string {
		return this.#theme.fg("success", text);
	}
	#warning(text: string): string {
		return this.#theme.fg("warning", text);
	}
	#error(text: string): string {
		return this.#theme.fg("error", text);
	}
	#dim(text: string): string {
		return this.#theme.fg("dim", text);
	}
	#muted(text: string): string {
		return this.#theme.fg("muted", text);
	}
	#accent(text: string): string {
		return this.#theme.fg("accent", text);
	}
	#border(text: string): string {
		return this.#theme.fg("border", text);
	}
	#bold(text: string): string {
		return this.#theme.bold(text);
	}
	#makeBorder(w: number): string {
		return this.#border(this.#theme.boxSharp.horizontal.repeat(Math.max(1, w)));
	}

	#formatTab(label: string, active: boolean): string {
		return active ? this.#accent(this.#bold(`[ ${label} ]`)) : this.#dim(`  ${label}  `);
	}

	#formatRow(label: string, value: string, width: number): string {
		return clean(`  ${this.#keyword(label)}: ${value}`, width);
	}

	#formatEfficiencyBar(ratio: number | null): string {
		if (ratio === null) return "-";
		const clamped = Math.max(0, Math.min(1, ratio));
		const filled = Math.round(clamped * EFFICIENCY_BAR_WIDTH);
		const empty = EFFICIENCY_BAR_WIDTH - filled;
		const colorKey = ratioPercentColor(ratio);
		const pct = `${(clamped * 100).toFixed(1)}%`;
		return `${this.#theme.fg(colorKey, EFFICIENCY_FILL_CHAR.repeat(filled))}${this.#dim(EFFICIENCY_EMPTY_CHAR.repeat(empty))} ${this.#theme.fg(colorKey, pct)}`;
	}

	#renderByCommandTable(
		rows: ReadonlyArray<{
			command: string;
			commands: number;
			estimatedTokensSaved: number;
			tokensSavedRatio: number | null;
		}>,
		contentWidth: number,
	): string[] {
		const t = this.#theme;
		const cmdWidth = Math.min(50, Math.max(10, contentWidth - GAIN_TABLE_FIXED));
		const maxSaved = rows.length > 0 ? Math.max(...rows.map(r => r.estimatedTokensSaved)) : 0;
		const lines: string[] = [];
		// Colored header row
		const hdr = (s: string) => t.fg("mdHeading", t.bold(s));
		lines.push(
			clean(
				hdr("#".padStart(GAIN_COL_NUM)) +
					" " +
					hdr("Command".padEnd(cmdWidth)) +
					" " +
					hdr("Count".padStart(GAIN_COL_COUNT)) +
					" " +
					hdr("Saved".padStart(GAIN_COL_SAVED)) +
					" " +
					hdr("Avg%".padStart(GAIN_COL_AVG_PCT)) +
					" " +
					hdr("Impact".padEnd(GAIN_COL_IMPACT)),
				contentWidth,
			),
		);
		rows.slice(0, 10).forEach((row, idx) => {
			const num = this.#dim(`${idx + 1}.`.padStart(GAIN_COL_NUM));
			const rawCmd = truncateToWidth(replaceTabs(row.command), cmdWidth);
			const cmd = this.#code(rawCmd.padEnd(cmdWidth));
			const count = this.#dim(formatFullNumber(row.commands).padStart(GAIN_COL_COUNT));
			const saved = this.#success(formatNumber(row.estimatedTokensSaved).padStart(GAIN_COL_SAVED));
			const avgPctRaw = row.tokensSavedRatio !== null ? `${(row.tokensSavedRatio * 100).toFixed(1)}%` : "-";
			const avgColor = ratioPercentColor(row.tokensSavedRatio);
			const avgPct = t.fg(avgColor, avgPctRaw.padStart(GAIN_COL_AVG_PCT));
			const barFill = maxSaved > 0 ? Math.round((row.estimatedTokensSaved / maxSaved) * GAIN_COL_IMPACT) : 0;
			const barEmpty = GAIN_COL_IMPACT - barFill;
			const impact = `${t.fg("success", EFFICIENCY_FILL_CHAR.repeat(barFill))}${this.#muted(EFFICIENCY_EMPTY_CHAR.repeat(barEmpty))}`;
			lines.push(clean(`${num} ${cmd} ${count} ${saved} ${avgPct} ${impact}`, contentWidth));
		});
		return lines;
	}

	#tableHeader(
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

	#tableRow(
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

	#renderLargestOutputTable(
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
		lines.push(
			clean(this.#tableHeader(cmdWidth, "Total", COL_TOTAL, "Avg", COL_AVG, "Exit", COL_EXIT), contentWidth),
		);
		for (const row of rows.slice(0, 8)) {
			const cmd = clean(row.command, cmdWidth);
			lines.push(
				clean(
					this.#tableRow(
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

	#renderPotentialTable(
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
				this.#tableHeader(cmdWidth, "Avg Est", COL_AVG_EST, "Est Savings", COL_EST_SAVINGS, "Exit", COL_EXIT),
				contentWidth,
			),
		);
		for (const row of rows.slice(0, 8)) {
			const cmd = clean(row.command, cmdWidth);
			lines.push(
				clean(
					this.#tableRow(
						cmd,
						cmdWidth,
						formatFullNumber(row.commands),
						`${formatNumber(row.avgEstimatedPotentialTokensSaved)} avg`,
						COL_AVG_EST,
						`${formatNumber(row.estimatedPotentialTokensSaved)} tok total`,
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

	#renderStatus(width: number): string[] {
		const lines: string[] = [];
		const diag = this.#dualContext.diagnostic;
		if (!diag) {
			lines.push(clean(this.#dim("  (diagnostic not loaded)"), width));
			return lines;
		}
		if ("buildError" in diag) {
			lines.push(clean(this.#error(`  Diagnostic error: ${diag.buildError}`), width));
			return lines;
		}
		lines.push(clean(this.#heading("Diagnostic"), width));
		lines.push(clean(`  ${this.#keyword("Records (file-wide)")}: ${formatFullNumber(diag.recordCount)}`, width));
		lines.push(
			clean(`  ${this.#keyword("Records (in scope)")}: ${formatFullNumber(diag.recordCountInScope)}`, width),
		);
		lines.push(
			clean(
				`  ${this.#success(`Saved: ${formatFullNumber(diag.savedCount)}`)}  ${this.#error(`Missed: ${formatFullNumber(diag.missedCount)}`)}`,
				width,
			),
		);
		lines.push(clean(`  ${this.#keyword("Most recent")}: ${diag.mostRecentTimestamp ?? "-"}`, width));
		lines.push(
			clean(`  ${this.#keyword("Most recent age")}: ${formatDurationMs(diag.mostRecentRecordAgeMs)}`, width),
		);
		lines.push(
			clean(
				`  ${this.#keyword("Avg saved ratio")}: ${diag.avgSavedRatio === null ? "-" : diag.avgSavedRatio.toFixed(3)}`,
				width,
			),
		);
		lines.push(
			clean(
				`  ${this.#keyword("Recent missed ratio")}: ${diag.recentMissedRatio === null ? "-" : diag.recentMissedRatio.toFixed(3)}`,
				width,
			),
		);
		lines.push(
			clean(
				`  ${this.#keyword("Recent hit ratio")}: ${diag.recentHitRatio === null ? "-" : diag.recentHitRatio.toFixed(3)}`,
				width,
			),
		);
		if (diag.minimizerAppearsInactive) {
			lines.push(clean(this.#warning("  WARN Minimizer appears inactive"), width));
		}
		lines.push(clean(`  ${this.#keyword("Load duration")}: ${diag.loadDurationMs}ms`, width));
		lines.push(clean(`  ${this.#keyword("File size")}: ${formatNumber(diag.fileSizeBytes)} bytes`, width));
		lines.push(clean(`  ${this.#keyword("Gain schema version")}: ${diag.schemaVersion}`, width));
		lines.push(clean(`  ${this.#keyword("Extension bundle path")}: ${shortenPath(diag.extensionBundlePath)}`, width));
		lines.push(clean(`  ${this.#keyword("Extension bundle mtime")}: ${diag.extensionBundleMtime ?? "-"}`, width));
		lines.push(
			clean(`  ${this.#keyword("Records with sessionCwd")}: ${formatFullNumber(diag.recordsWithSessionCwd)}`, width),
		);
		lines.push(
			clean(
				`  ${this.#keyword("Records without sessionCwd")}: ${formatFullNumber(diag.recordsWithoutSessionCwd)}`,
				width,
			),
		);
		lines.push(
			clean(
				`  ${this.#keyword("Current session records")}: ${formatFullNumber(diag.currentSessionRecordCount)}`,
				width,
			),
		);
		lines.push(
			clean(
				`  ${this.#keyword("Scope command/session")}: ${formatFullNumber(diag.commandCwdRecordCountInScope)} / ${formatFullNumber(diag.sessionCwdRecordCountInScope)}`,
				width,
			),
		);
		lines.push(clean(`  ${this.#keyword("Write errors")}: ${diag.writeErrorCount}`, width));
		if (diag.lastWriteError) {
			lines.push(clean(this.#dim(`    last: ${diag.lastWriteError.error}`), width));
		}
		lines.push(clean(`  ${this.#keyword("Read errors")}: ${diag.readErrorCount}`, width));
		if (diag.lastReadError) {
			lines.push(clean(this.#dim(`    last: ${diag.lastReadError.error}`), width));
		}
		lines.push(clean(`  ${this.#keyword("Parse errors")}: ${diag.parseErrorCount}`, width));
		if (diag.lastParseError) {
			lines.push(
				clean(this.#dim(`    last: ${diag.lastParseError.error} (line ${diag.lastParseError.lineNumber})`), width),
			);
		}
		lines.push(clean(`  ${this.#keyword("Minimizer enabled")}: ${diag.minimizerEnabled}`, width));
		lines.push(clean(`  ${this.#keyword("Native binding loaded")}: ${diag.nativeBindingLoaded}`, width));
		lines.push(clean(`  ${this.#keyword("Scope filter")}: ${diag.scopeFilter ?? "(all)"}`, width));
		lines.push(clean(`  ${this.#keyword("Distinct cwds")}: ${formatFullNumber(diag.distinctCwdsCount)}`, width));
		if (diag.recordCountInScope === 0 && diag.distinctCwdsCount > 0) {
			lines.push(clean(this.#dim("  (scope empty but file has records under other cwds)"), width));
			for (const cwd of diag.distinctCwdsSample) {
				lines.push(clean(this.#dim(`    ${shortenPath(cwd)}`), width));
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

		// Top border + title bar
		lines.push(this.#makeBorder(width));
		lines.push(
			clean(
				`${this.#heading("Minimizer Gain")} ${this.#formatTab("Current", activeScope === "Current")} ${this.#dim("|")} ${this.#formatTab("All", activeScope === "All")}`,
				width,
			),
		);
		lines.push(
			clean(
				`${this.#formatTab("Gain", activeTab === "Gain")} ${this.#dim("|")} ${this.#formatTab("Missed", activeTab === "Missed")} ${this.#dim("|")} ${this.#formatTab("Status", activeTab === "Status")}`,
				width,
			),
		);

		lines.push(
			clean(this.#muted(`Scope: ${context.all ? "all repos" : shortenPath(context.cwd ?? process.cwd())}`), width),
		);
		lines.push("");

		if (activeTab === "Status") {
			lines.push(...this.#renderStatus(width));
			lines.push("");
			lines.push(clean(this.#dim("Tab | S switch scope | R refresh | Esc close"), width));
			lines.push(clean(this.#dim(`Path: ${shortenPath(context.path)}`), width));
			lines.push(this.#makeBorder(width));
			return lines;
		}

		if (activeTab === "Gain") {
			const scopeLabel = context.all ? "Global Scope" : "Current Scope";
			lines.push(clean(this.#heading(`Token Savings (${scopeLabel})`), width));
			lines.push(this.#makeBorder(contentWidth));
			lines.push(this.#formatRow("Total commands", formatFullNumber(context.summary.commands), width));
			const inputTok = context.summary.estimatedInputTokens;
			lines.push(this.#formatRow("Input tokens", formatNumber(inputTok), width));
			const savedTok = context.summary.estimatedTokensSaved;
			const outputTok = Math.max(0, inputTok - savedTok);
			lines.push(this.#formatRow("Output tokens", formatNumber(outputTok), width));
			const ratio = context.summary.tokensSavedRatio;
			const ratioStr = ratio !== null ? ` (${(ratio * 100).toFixed(1)}% saved)` : "";
			const savedLabel =
				ratio !== null ? this.#success(`${formatNumber(savedTok)}${ratioStr}`) : formatNumber(savedTok);
			lines.push(this.#formatRow("Tokens saved", savedLabel, width));
			lines.push(this.#formatRow("Efficiency", this.#formatEfficiencyBar(ratio), width));
			lines.push("");
			lines.push(clean(this.#heading("By Command"), width));
			lines.push(clean(this.#border("─".repeat(Math.max(1, contentWidth))), width));
			if (context.summary.byCommand.length === 0) {
				lines.push(clean(this.#dim("  (none)"), width));
			} else {
				lines.push(...this.#renderByCommandTable(context.summary.byCommand, contentWidth));
			}
			lines.push("");
			lines.push(clean(this.#heading("By Source"), width));
			lines.push(clean(this.#border("─".repeat(Math.max(1, contentWidth))), width));
			if (context.summary.bySource.length === 0) {
				lines.push(clean(this.#dim("  (none)"), width));
			} else {
				lines.push(
					...this.#renderByCommandTable(
						context.summary.bySource.map(row => ({ ...row, command: row.source })),
						contentWidth,
					),
				);
			}
			if (context.all) {
				lines.push("");
				lines.push(clean(this.#heading("Repositories"), width));
				lines.push(clean(this.#border("─".repeat(Math.max(1, contentWidth))), width));
				if (context.summary.byCwd.length === 0) {
					lines.push(clean(this.#dim("  (none)"), width));
				} else {
					const t = this.#theme;
					const maxSaved = Math.max(...context.summary.byCwd.map(r => r.savedBytes));
					lines.push(
						clean(
							`  ${t.fg("mdHeading", t.bold("Repository".padEnd(40)))} ${t.fg("mdHeading", t.bold("Cmds".padStart(6)))} ${t.fg("mdHeading", t.bold("Saved".padStart(9)))} ${t.fg("mdHeading", t.bold("Avg%".padStart(12)))} ${t.fg("mdHeading", t.bold("Efficiency".padEnd(24)))}`,
							contentWidth,
						),
					);
					for (const row of context.summary.byCwd.slice(0, 8)) {
						const name = truncateToWidth(shortenPath(row.cwd), 38);
						const cmdCount = formatFullNumber(row.commands).padStart(6);
						const saved = this.#success(formatNumber(row.savedBytes).padStart(9));
						const pctStr =
							row.tokensSavedRatio !== null
								? `${(row.tokensSavedRatio * 100).toFixed(1)}%`.padStart(7)
								: "-".padStart(7);
						const colorKey = ratioPercentColor(row.tokensSavedRatio);
						const barWidth = maxSaved > 0 ? Math.round((row.savedBytes / maxSaved) * 22) : 0;
						const bar = `${t.fg("success", EFFICIENCY_FILL_CHAR.repeat(barWidth))}${this.#muted(EFFICIENCY_EMPTY_CHAR.repeat(22 - barWidth))}`;
						lines.push(
							clean(
								`  ${this.#link(name.padEnd(40))} ${this.#dim(cmdCount)} ${saved} ${t.fg(colorKey, pctStr.padEnd(12))} ${bar}`,
								contentWidth,
							),
						);
					}
				}
			}
		} else {
			lines.push(clean(this.#heading("Largest unminimized shell outputs"), width));
			if (context.missed.commands.length === 0) {
				lines.push(clean(this.#dim("No unminimized shell output recorded for this scope yet."), width));
			} else {
				lines.push(...this.#renderLargestOutputTable(context.missed.commands, contentWidth));
			}
			lines.push("");
			lines.push(clean(this.#heading("Highest potential token savings"), width));
			if (context.missed.potentialTokenSavings.length === 0) {
				lines.push(clean(this.#dim("No potential token savings data."), width));
			} else {
				lines.push(...this.#renderPotentialTable(context.missed.potentialTokenSavings, contentWidth));
			}
		}

		lines.push("");
		lines.push(clean(this.#dim("Tab | S switch scope | R refresh | Esc close"), width));
		lines.push(clean(this.#dim(`Path: ${shortenPath(context.path)}`), width));
		lines.push(this.#makeBorder(width));
		return lines;
	}
}

export type { DualContext, GainTheme, LoadMinimizerGainContext, ScopeIndex };
