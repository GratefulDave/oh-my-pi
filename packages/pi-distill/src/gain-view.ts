import { ScrollView, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { type AggregateStats, aggregate, type SessionRecord, type Totals } from "./stats";

const KB = 1024;
const MIN_TABLE_WIDTH = 48;

export interface ThemeLike {
	fg?: (name: string, text: string) => string;
}

export interface TuiLike {
	requestRender: () => void;
}

export interface GainContext {
	hasUI?: boolean;
	ui?: {
		custom?: (
			renderer: (tui: TuiLike, theme: ThemeLike, keybindings: unknown, done: (value?: unknown) => void) => unknown,
			options: { overlay: boolean },
		) => Promise<void>;
		notify?: (message: string, level: "info" | "warning") => void;
	};
	sessionManager?: {
		getSessionId?: () => string;
		getCwd?: () => string;
		getSessionName?: () => string | undefined;
	};
}

export async function showGainView(ctx: GainContext): Promise<void> {
	try {
		const data = aggregate(ctx);
		if (ctx.hasUI && ctx.ui?.custom) {
			await ctx.ui.custom((tui, theme, _keybindings, done) => createGainOverlay(data, tui, theme, done), {
				overlay: true,
			});
			return;
		}
		const text = formatPlainText(data, process.stdout.columns ?? 100);
		ctx.ui?.notify?.(text, "info");
		console.log(text);
	} catch (err) {
		const message = `pi-distill gain view unavailable: ${err instanceof Error ? err.message : String(err)}`;
		ctx.ui?.notify?.(message, "warning");
		console.log(message);
	}
}

function createGainOverlay(data: AggregateStats, tui: TuiLike, theme: ThemeLike, done: (value?: unknown) => void) {
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
			if (input === "\u001b" || input === "\u001b[27u" || input === "\r" || input === "\n" || input === "\r\n") {
				done(undefined);
				return;
			}
			if (input === "\u001b[A" || input === "k") {
				scrollOffset = Math.max(0, scrollOffset - 1);
			} else if (input === "\u001b[B" || input === "j") {
				scrollOffset = Math.min(maxScroll, scrollOffset + 1);
			} else if (input === "\u001b[5~") {
				scrollOffset = Math.max(0, scrollOffset - viewportRows);
			} else if (input === "\u001b[6~") {
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

function formatPlainText(data: AggregateStats, width: number): string {
	const safeWidth = Math.max(MIN_TABLE_WIDTH, width);
	return [
		"pi-distill savings",
		stripAnsi(renderTotalsLine("Project", data.project, safeWidth, {})),
		stripAnsi(renderTotalsLine("Global ", data.global, safeWidth, {})),
		"",
		...dataRows(data).map(row => stripAnsi(fit(row, safeWidth))),
	].join("\n");
}

function dataRows(data: AggregateStats): string[] {
	return [
		`${padCell("Date", 12)} ${padCell("Session", 28)} ${padCell("KB", 9, "right")} ${padCell("Tokens", 8, "right")} ${padCell("Hits", 6, "right")}`,
		`${"-".repeat(12)} ${"-".repeat(28)} ${"-".repeat(9)} ${"-".repeat(8)} ${"-".repeat(6)}`,
		...(data.sessions.length === 0
			? ["No saved output recorded yet."]
			: data.sessions.map(session => formatSessionRow(session))),
	];
}

function renderSessionRows(sessions: SessionRecord[], width: number, theme: ThemeLike): string[] {
	const rows = dataRows({
		project: emptyTotals(),
		global: emptyTotals(),
		sessions,
	});
	return rows.map((row, index) => {
		const text = fit(row, width);
		return index <= 1 ? color(theme, "dim", text) : text;
	});
}

function formatSessionRow(session: SessionRecord): string {
	const label = session.label || session.project;
	const parts = label.split(/[\\/]+/).filter(Boolean);
	const tailLabel = parts.length === 0 ? label || "unknown" : parts.slice(-2).join("/");
	return [
		padCell(formatDate(session.lastTs), 12),
		padCell(tailLabel, 28),
		padCell(`${(Math.max(0, session.savedBytes) / KB).toFixed(1)} KB`, 9, "right"),
		padCell(Math.round(Math.max(0, session.savedBytes) / 4).toLocaleString("en-US"), 8, "right"),
		padCell(Math.round(Math.max(0, session.hits)).toLocaleString("en-US"), 6, "right"),
	].join(" ");
}

function renderTitle(width: number, theme: ThemeLike): string {
	return color(theme, "accent", fit("pi-distill savings", width));
}

function renderTotalsLine(label: string, totals: Totals, width: number, theme: ThemeLike): string {
	const reduction =
		totals.reductionPercent === null ? "reduction n/a" : `${formatPercent(totals.reductionPercent)} reduction`;
	const parts = [
		`${label}:`,
		`${(Math.max(0, totals.savedBytes) / KB).toFixed(1)} KB saved`,
		`${Math.round(Math.max(0, totals.estTokens)).toLocaleString("en-US")} est tokens`,
		reduction,
		`${Math.round(Math.max(0, totals.sessions)).toLocaleString("en-US")} sessions`,
	];
	return color(theme, "muted", fit(parts.join("  "), width));
}

function renderFooter(width: number, theme: ThemeLike): string {
	return color(theme, "dim", fit("Esc/Enter close  Up/Down or j/k scroll  PgUp/PgDn page", width));
}

function emptyTotals(): Totals {
	return {
		savedBytes: 0,
		hits: 0,
		estTokens: 0,
		sessions: 0,
		originalBytes: 0,
		replacementBytes: 0,
		knownSavedBytes: 0,
		reductionPercent: null,
		tools: {},
	};
}

function formatPercent(value: number): string {
	if (!Number.isFinite(value)) return "n/a";
	if (value >= 99.95) return "100%";
	if (value >= 10) return `${value.toFixed(1)}%`;
	return `${value.toFixed(2)}%`;
}

function formatDate(ts: number): string {
	if (!Number.isFinite(ts) || ts <= 0) return "unknown";
	const date = new Date(ts);
	return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().slice(0, 10);
}

function padCell(value: string, width: number, align: "left" | "right" = "left"): string {
	const text = truncateToWidth(value, width);
	const padding = Math.max(0, width - visibleWidth(text));
	return align === "right" ? `${" ".repeat(padding)}${text}` : `${text}${" ".repeat(padding)}`;
}

function fit(value: string, width: number): string {
	const text = truncateToWidth(value, width);
	const padding = Math.max(0, width - visibleWidth(text));
	return `${text}${" ".repeat(padding)}`;
}

function color(theme: ThemeLike, name: string, text: string): string {
	return theme.fg?.(name, text) ?? text;
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}
