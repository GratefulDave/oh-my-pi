import { type Component, matchesKey, replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { MinimizerGainContext } from "../../minimizer-gain";
import { shortenPath } from "../../tools/render-utils";
import { theme } from "../theme/theme";

type LoadMinimizerGainContext = () => Promise<MinimizerGainContext>;

const REFRESH_INTERVAL_MS = 1000;

const TABS = ["Gain", "Missed"] as const;
type TabIndex = 0 | 1;

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
	return exitCodes.map(code => (code === null ? "null" : String(code))).join(",");
}

function formatTab(label: string, active: boolean): string {
	return active ? theme.fg("accent", theme.bold(`[ ${label} ]`)) : theme.fg("dim", `  ${label}  `);
}

function formatRow(label: string, value: string, width: number): string {
	return clean(`  ${label}: ${value}`, width);
}

function formatGainRow<
	T extends { commands: number; savedBytes: number; estimatedTokensSaved: number; usesEstimatedTokensSaved: boolean },
>(label: string, row: T, width: number): string {
	return clean(
		`  ${label}: ${formatNumber(row.commands)} cmds, ${formatNumber(row.savedBytes)} bytes, ${formatNumber(row.estimatedTokensSaved)} ${formatTokensSavedLabel(row.usesEstimatedTokensSaved)}`,
		width,
	);
}

function formatMissedRow(
	label: string,
	row: { commands: number; inputBytes: number; avgInputBytes: number; exitCodes: Array<number | null> },
	width: number,
): string {
	return clean(
		`  ${label}: ${formatNumber(row.inputBytes)} bytes total, ${formatNumber(row.avgInputBytes)} avg, ${formatNumber(row.commands)} cmds, exit=${formatExitCodes(row.exitCodes)}`,
		width,
	);
}

export class MinimizerGainOverlayComponent implements Component {
	#context: MinimizerGainContext;
	readonly #onClose: () => void;
	readonly #requestRender: () => void;
	readonly #loadContext: LoadMinimizerGainContext | undefined;
	#activeTabIndex: TabIndex = 0;
	#refreshInterval: ReturnType<typeof setInterval> | undefined;
	#refreshing = false;
	#disposed = false;

	constructor(
		context: MinimizerGainContext,
		requestRender: () => void,
		onClose: () => void,
		loadContext?: LoadMinimizerGainContext,
	) {
		this.#context = context;
		this.#requestRender = requestRender;
		this.#onClose = onClose;
		this.#loadContext = loadContext;
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
			this.#context = context;
			this.#requestRender();
		} catch {
			// Keep rendering the last complete snapshot when best-effort analytics refresh fails.
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
		if (data === "r" || data === "R") {
			void this.refresh();
		}
	}

	render(width: number): string[] {
		const contentWidth = Math.max(24, width - 2);
		const lines: string[] = [];
		const activeTab = TABS[this.#activeTabIndex];

		lines.push(border(width));
		lines.push(
			clean(
				`${theme.bold(" Minimizer Gain ")} ${formatTab("Gain", activeTab === "Gain")} ${theme.fg("dim", "│")} ${formatTab("Missed", activeTab === "Missed")}`,
				width,
			),
		);

		lines.push(
			clean(
				theme.fg(
					"muted",
					`Scope: ${this.#context.all ? "all repos" : shortenPath(this.#context.cwd ?? process.cwd())}`,
				),
				width,
			),
		);
		lines.push("");

		if (activeTab === "Gain") {
			lines.push(clean(theme.fg("accent", theme.bold("Positive minimizer savings")), width));
			lines.push(formatRow("Commands", formatNumber(this.#context.summary.commands), width));
			lines.push(formatRow("Input Bytes", formatNumber(this.#context.summary.inputBytes), width));
			lines.push(formatRow("Output Bytes", formatNumber(this.#context.summary.outputBytes), width));
			lines.push(formatRow("Saved Bytes", formatNumber(this.#context.summary.savedBytes), width));
			lines.push(
				formatRow(
					formatTokensSavedLabel(this.#context.summary.usesEstimatedTokensSaved),
					formatNumber(this.#context.summary.estimatedTokensSaved),
					width,
				),
			);
			lines.push("");
			lines.push(clean(theme.fg("muted", "Top filters"), width));
			if (this.#context.summary.byFilter.length === 0) {
				lines.push(clean(theme.fg("dim", "  (none)"), width));
			} else {
				for (const row of this.#context.summary.byFilter.slice(0, 5)) {
					lines.push(formatGainRow(row.filter, row, contentWidth));
				}
			}
			lines.push("");
			lines.push(clean(theme.fg("muted", "Top commands"), width));
			if (this.#context.summary.byCommand.length === 0) {
				lines.push(clean(theme.fg("dim", "  (none)"), width));
			} else {
				for (const row of this.#context.summary.byCommand.slice(0, 5)) {
					lines.push(formatGainRow(row.command, row, contentWidth));
				}
			}
			if (this.#context.all) {
				lines.push("");
				lines.push(clean(theme.fg("muted", "Repositories"), width));
				if (this.#context.summary.byCwd.length === 0) {
					lines.push(clean(theme.fg("dim", "  (none)"), width));
				} else {
					for (const row of this.#context.summary.byCwd.slice(0, 5)) {
						lines.push(formatGainRow(shortenPath(row.cwd), row, contentWidth));
					}
				}
			}
		} else {
			lines.push(clean(theme.fg("accent", theme.bold("Largest unminimized shell outputs")), width));
			if (this.#context.missed.commands.length === 0) {
				lines.push(clean(theme.fg("dim", "No unminimized shell output recorded for this scope yet."), width));
			} else {
				for (const row of this.#context.missed.commands.slice(0, 8)) {
					lines.push(formatMissedRow(row.command, row, contentWidth));
				}
			}
		}

		lines.push("");
		lines.push(clean(theme.fg("dim", "Tab switch tabs · R refresh · Esc close"), width));
		lines.push(clean(theme.fg("dim", `Path: ${shortenPath(this.#context.path)}`), width));
		lines.push(border(width));
		return lines;
	}
}
