import { ScrollView, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { Component } from "@oh-my-pi/pi-tui";

import { aggregate } from "./stats";
import type { SessionRecord, Totals } from "./stats";

interface AggregateView {
	project: Totals;
	global: Totals;
	sessions: SessionRecord[];
}

interface RenderTheme {
	fg?: (name: string, text: string) => string;
}

interface OverlayTui {
	requestRender(): void;
}

const KB = 1024;
const MIN_TABLE_WIDTH = 48;

export async function showGainView(ctx: any): Promise<void> {
	try {
		const data = aggregate(ctx);
		if (ctx?.hasUI && ctx?.ui?.custom) {
			await ctx.ui.custom(
				(tui: OverlayTui, theme: RenderTheme, _keybindings: unknown, done: (result: void) => void) =>
					createGainOverlay(data, tui, theme, done),
				{ overlay: true },
			);
			return;
		}

		const text = formatPlainText(data, process.stdout.columns ?? 100);
		if (ctx?.ui?.notify) {
			ctx.ui.notify(text, "info");
		}
		console.log(text);
	} catch (err) {
		const message = `pi-distill gain view unavailable: ${err instanceof Error ? err.message : String(err)}`;
		try {
			ctx?.ui?.notify?.(message, "warning");
		} catch {
			/* ignore */
		}
		console.log(message);
	}
}

function createGainOverlay(
	data: AggregateView,
	tui: OverlayTui,
	theme: RenderTheme,
	done: (result: void) => void,
): Component {
	let scrollOffset = 0;

	return {
		render(width: number): string[] {
			const safeWidth = Math.max(MIN_TABLE_WIDTH, width);
			const rows = renderSessionRows(data.sessions, safeWidth, theme);
			const terminalRows = process.stdout.rows ?? 40;
			const viewportRows = Math.max(5, terminalRows - 7);
			const maxScroll = Math.max(0, rows.length - viewportRows);
			scrollOffset = Math.min(scrollOffset, maxScroll);

			const scrollView = new ScrollView(rows.slice(scrollOffset, scrollOffset + viewportRows), {
				height: viewportRows,
				scrollbar: "auto",
				totalRows: rows.length,
				theme: {
					track: text => color(theme, "dim", text),
					thumb: text => color(theme, "accent", text),
				},
			});
			scrollView.setScrollOffset(scrollOffset);

			return [
				renderTitle(safeWidth, theme),
				renderTotalsLine("Project", data.project, safeWidth, theme),
				renderTotalsLine("Global ", data.global, safeWidth, theme),
				color(theme, "dim", fit("", safeWidth)),
				...scrollView.render(safeWidth),
				renderFooter(safeWidth, theme),
			];
		},
		handleInput(input: string): void {
			const terminalRows = process.stdout.rows ?? 40;
			const viewportRows = Math.max(5, terminalRows - 7);
			const maxScroll = Math.max(0, dataRows(data).length - viewportRows);

			if (isEscapeInput(input) || isEnterInput(input)) {
				done(undefined);
				return;
			}
			if (input === "\x1b[A" || input === "k") {
				scrollOffset = Math.max(0, scrollOffset - 1);
			} else if (input === "\x1b[B" || input === "j") {
				scrollOffset = Math.min(maxScroll, scrollOffset + 1);
			} else if (input === "\x1b[5~") {
				scrollOffset = Math.max(0, scrollOffset - viewportRows);
			} else if (input === "\x1b[6~") {
				scrollOffset = Math.min(maxScroll, scrollOffset + viewportRows);
			} else if (input === "g") {
				scrollOffset = 0;
			} else if (input === "G") {
				scrollOffset = maxScroll;
			}
			tui.requestRender();
		},
		invalidate(): void {},
	};
}

function formatPlainText(data: AggregateView, width: number): string {
	const safeWidth = Math.max(MIN_TABLE_WIDTH, width);
	return [
		"pi-distill savings",
		stripAnsi(renderTotalsLine("Project", data.project, safeWidth, {})),
		stripAnsi(renderTotalsLine("Global ", data.global, safeWidth, {})),
		"",
		...dataRows(data).map(row => stripAnsi(fit(row, safeWidth))),
	].join("\n");
}

function dataRows(data: AggregateView): string[] {
	return [
		`${padCell("Date", 12)} ${padCell("Session", 28)} ${padCell("KB", 9, "right")} ${padCell("Tokens", 8, "right")} ${padCell("Hits", 6, "right")}`,
		`${"-".repeat(12)} ${"-".repeat(28)} ${"-".repeat(9)} ${"-".repeat(8)} ${"-".repeat(6)}`,
		...(data.sessions.length === 0
			? ["No saved output recorded yet."]
			: data.sessions.map(session => formatSessionRow(session))),
	];
}

function renderSessionRows(sessions: SessionRecord[], width: number, theme: RenderTheme): string[] {
	const rows = dataRows({
		project: emptyTotals(),
		global: emptyTotals(),
		sessions,
	});
	return rows.map((row, index) => {
		const text = fit(row, width);
		if (index <= 1) return color(theme, "dim", text);
		return text;
	});
}

function formatSessionRow(session: SessionRecord): string {
	const label = tailLabel(session.label || session.project);
	return [
		padCell(formatDate(session.lastTs), 12),
		padCell(label, 28),
		padCell(formatKb(session.savedBytes), 9, "right"),
		padCell(formatInteger(Math.round(session.savedBytes / 4)), 8, "right"),
		padCell(formatInteger(session.hits), 6, "right"),
	].join(" ");
}

function renderTitle(width: number, theme: RenderTheme): string {
	return color(theme, "accent", fit("pi-distill savings", width));
}

function renderTotalsLine(label: string, totals: Totals, width: number, theme: RenderTheme): string {
	const parts = [
		`${label}:`,
		`${formatKb(totals.savedBytes)} saved`,
		`${formatInteger(totals.estTokens)} est tokens`,
		"reduction n/a",
		`${formatInteger(totals.sessions)} sessions`,
	];
	return color(theme, "muted", fit(parts.join("  "), width));
}

function renderFooter(width: number, theme: RenderTheme): string {
	return color(theme, "dim", fit("Esc/Enter close  Up/Down or j/k scroll  PgUp/PgDn page", width));
}

function emptyTotals(): Totals {
	return { savedBytes: 0, hits: 0, estTokens: 0, sessions: 0 };
}

function isEscapeInput(data: string): boolean {
	return data === "\x1b" || data === "\x1b[27u";
}

function isEnterInput(data: string): boolean {
	return data === "\r" || data === "\n" || data === "\r\n";
}

function formatDate(ts: number): string {
	if (!Number.isFinite(ts) || ts <= 0) return "unknown";
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return "unknown";
	return date.toISOString().slice(0, 10);
}

function formatKb(bytes: number): string {
	return `${(safeNumber(bytes) / KB).toFixed(1)} KB`;
}

function formatInteger(value: number): string {
	return Math.round(safeNumber(value)).toLocaleString("en-US");
}

function safeNumber(value: number): number {
	return Number.isFinite(value) ? value : 0;
}

function tailLabel(value: string): string {
	const parts = value.split(/[\\/]+/).filter(Boolean);
	if (parts.length === 0) return value || "unknown";
	return parts.slice(-2).join("/");
}

function padCell(value: string, width: number, align: "left" | "right" = "left"): string {
	const text = truncateToWidth(value, width);
	const padding = Math.max(0, width - visibleWidth(text));
	if (align === "right") return `${" ".repeat(padding)}${text}`;
	return `${text}${" ".repeat(padding)}`;
}

function fit(value: string, width: number): string {
	const text = truncateToWidth(value, width);
	const padding = Math.max(0, width - visibleWidth(text));
	return `${text}${" ".repeat(padding)}`;
}

function color(theme: RenderTheme, name: string, text: string): string {
	return theme.fg?.(name, text) ?? text;
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}
