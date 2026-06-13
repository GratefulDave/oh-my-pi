import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { type AggregateStats, aggregate, type SessionRecord, type Totals } from "./stats";

const KB = 1024;
const MIN_WIDTH = 52;

// ---------------------------------------------------------------------------
// Theme / context interfaces
// ---------------------------------------------------------------------------

export interface ThemeLike {
	fg?: (name: string, text: string) => string;
	bold?: (text: string) => string;
	boxSharp?: { horizontal: string };
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function showGainView(ctx: GainContext): Promise<void> {
	try {
		const data = aggregate(ctx);
		if (ctx.hasUI && ctx.ui?.custom) {
			await ctx.ui.custom(
				(tui, theme, _keybindings, done) => new DistillGainOverlayComponent(data, tui, theme, done),
				{
					overlay: true,
				},
			);
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

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

const TABS = ["Gain", "Status"] as const;
type TabIndex = 0 | 1;

// Column widths for session table
const COL_DATE = 12;
const COL_KB = 9;
const COL_TOK = 10;
const COL_HITS = 7;
const SESSION_FIXED = COL_DATE + 1 + COL_KB + 1 + COL_TOK + 1 + COL_HITS;

// Efficiency bar
const BAR_WIDTH = 22;
const FILL_CHAR = "█";
const EMPTY_CHAR = "░";

class DistillGainOverlayComponent {
	#data: AggregateStats;
	#tui: TuiLike;
	#theme: ThemeLike;
	#done: (value?: unknown) => void;
	#activeTab: TabIndex = 0;
	#scrollOffset = 0;

	constructor(data: AggregateStats, tui: TuiLike, theme: ThemeLike, done: (value?: unknown) => void) {
		this.#data = data;
		this.#tui = tui;
		this.#theme = theme;
		this.#done = done;
	}

	// TUI overlay interface
	invalidate(): void {}

	handleInput(input: string): void {
		const rows = this.#tabRows();
		const termRows = process.stdout.rows ?? 40;
		const viewportRows = Math.max(5, termRows - 10);
		const maxScroll = Math.max(0, rows.length - viewportRows);

		if (input === "\u001b" || input === "\u001b[27u" || input === "\r" || input === "\n" || input === "\r\n") {
			this.#done(undefined);
			return;
		}
		if (input === "\t" || input === "\u001b[27;2;9u") {
			this.#activeTab = ((this.#activeTab + 1) % TABS.length) as TabIndex;
			this.#scrollOffset = 0;
			this.#tui.requestRender();
			return;
		}
		if (input === "\u001b[A" || input === "k") {
			this.#scrollOffset = Math.max(0, this.#scrollOffset - 1);
		} else if (input === "\u001b[B" || input === "j") {
			this.#scrollOffset = Math.min(maxScroll, this.#scrollOffset + 1);
		} else if (input === "\u001b[5~") {
			this.#scrollOffset = Math.max(0, this.#scrollOffset - viewportRows);
		} else if (input === "\u001b[6~") {
			this.#scrollOffset = Math.min(maxScroll, this.#scrollOffset + viewportRows);
		} else if (input === "g") {
			this.#scrollOffset = 0;
		} else if (input === "G") {
			this.#scrollOffset = maxScroll;
		} else {
			return;
		}
		this.#tui.requestRender();
	}

	render(width: number): string[] {
		const w = Math.max(MIN_WIDTH, width);
		const cw = w - 2; // content width (inside 1-char pad each side)

		const lines: string[] = [];

		// Top border + title row
		lines.push(this.#border(w));
		lines.push(
			clean(
				`${this.#heading("pi-distill savings")}  ${this.#formatTab("Gain", this.#activeTab === 0)} ${this.#dim("|")} ${this.#formatTab("Status", this.#activeTab === 1)}`,
				w,
			),
		);
		lines.push(this.#border(w));
		lines.push("");

		const bodyRows = this.#tabRows(cw);
		const termRows = process.stdout.rows ?? 40;
		const viewportRows = Math.max(5, termRows - 10);
		const maxScroll = Math.max(0, bodyRows.length - viewportRows);
		this.#scrollOffset = Math.min(this.#scrollOffset, maxScroll);

		const visible = bodyRows.slice(this.#scrollOffset, this.#scrollOffset + viewportRows);
		for (const row of visible) lines.push(row);

		// Pad to viewport if short
		while (lines.length < viewportRows + 4) lines.push("");

		// Footer
		lines.push(this.#dim(fit("Tab switch  ↑/↓ j/k scroll  PgUp/PgDn page  g/G top/btm  Esc close", w)));
		if (maxScroll > 0) {
			const pct = Math.round((this.#scrollOffset / maxScroll) * 100);
			lines.push(
				this.#dim(
					fit(
						`  ${pct}% (${this.#scrollOffset + 1}–${Math.min(this.#scrollOffset + viewportRows, bodyRows.length)} of ${bodyRows.length})`,
						w,
					),
				),
			);
		}
		lines.push(this.#border(w));
		return lines;
	}

	// -------------------------------------------------------------------
	// Tab content builders
	// -------------------------------------------------------------------

	#tabRows(cw = 80): string[] {
		return this.#activeTab === 0 ? this.#gainRows(cw) : this.#statusRows(cw);
	}

	#gainRows(cw: number): string[] {
		const { project, global: g, sessions } = this.#data;
		const lines: string[] = [];

		// Totals block
		lines.push(clean(this.#heading("Totals"), cw));
		lines.push(this.#border(cw));
		lines.push(this.#row("Project saved", formatKB(project.savedBytes) + this.#efficiencyInline(project), cw));
		lines.push(this.#row("Global saved", formatKB(g.savedBytes) + this.#efficiencyInline(g), cw));
		lines.push(this.#row("Est tokens (project)", formatTokens(project.estTokens), cw));
		lines.push(this.#row("Est tokens (global)", formatTokens(g.estTokens), cw));
		lines.push(this.#row("Project sessions", String(project.sessions), cw));
		lines.push(this.#row("Global sessions", String(g.sessions), cw));
		lines.push(this.#row("Project hits", String(project.hits), cw));
		lines.push(this.#row("Global hits", String(g.hits), cw));
		lines.push("");

		// Efficiency bar
		const ratio = project.reductionPercent !== null ? project.reductionPercent / 100 : null;
		lines.push(clean(this.#heading("Efficiency (project)"), cw));
		lines.push(this.#border(cw));
		lines.push(this.#row("Reduction", this.#efficiencyBar(ratio), cw));
		lines.push("");

		// By-tool breakdown
		const toolEntries = Object.entries(project.tools ?? {}).sort((a, b) => b[1].savedBytes - a[1].savedBytes);
		lines.push(clean(this.#heading("By Tool (project)"), cw));
		lines.push(this.#border(cw));
		if (toolEntries.length === 0) {
			lines.push(clean(this.#dim("  (no tool data yet)"), cw));
		} else {
			const COL_TOOL = Math.max(10, cw - 2 - 9 - 1 - 7 - 1 - 8); // saved, hits, cands
			lines.push(
				clean(
					"  " +
						this.#head("Tool".padEnd(COL_TOOL)) +
						" " +
						this.#head("Saved".padStart(9)) +
						" " +
						this.#head("Hits".padStart(7)) +
						" " +
						this.#head("Cands".padStart(8)),
					cw,
				),
			);
			for (const [name, ts] of toolEntries.slice(0, 12)) {
				const tool = truncateToWidth(name, COL_TOOL).padEnd(COL_TOOL);
				const saved = this.#success(formatKB(ts.savedBytes).padStart(9));
				const hits = this.#dim(String(ts.hits).padStart(7));
				const cands = this.#dim(String(ts.candidates).padStart(8));
				lines.push(clean(`  ${this.#code(tool)} ${saved} ${hits} ${cands}`, cw));
			}
		}
		lines.push("");

		// Session history
		lines.push(clean(this.#heading("Session History (recent first)"), cw));
		lines.push(this.#border(cw));
		const sessWidth = Math.max(10, cw - 2 - SESSION_FIXED);
		lines.push(
			clean(
				"  " +
					this.#head("Date".padEnd(COL_DATE)) +
					" " +
					this.#head("Session".padEnd(sessWidth)) +
					" " +
					this.#head("Saved".padStart(COL_KB)) +
					" " +
					this.#head("Est Tok".padStart(COL_TOK)) +
					" " +
					this.#head("Hits".padStart(COL_HITS)),
				cw,
			),
		);
		if (sessions.length === 0) {
			lines.push(clean(this.#dim("  No sessions recorded yet."), cw));
		} else {
			for (const s of sessions) {
				lines.push(clean(this.#sessionRow(s, sessWidth), cw));
			}
		}

		return lines;
	}

	#statusRows(cw: number): string[] {
		const { project, global: g } = this.#data;
		const lines: string[] = [];

		lines.push(clean(this.#heading("Distill Status"), cw));
		lines.push(this.#border(cw));
		lines.push(this.#row("Project saved", formatKB(project.savedBytes), cw));
		lines.push(this.#row("Global saved", formatKB(g.savedBytes), cw));
		lines.push(this.#row("Project original", formatKB(project.originalBytes), cw));
		lines.push(this.#row("Project replacement", formatKB(project.replacementBytes), cw));
		lines.push(this.#row("Project known saved", formatKB(project.knownSavedBytes), cw));

		const red = project.reductionPercent;
		const redStr = red === null ? "-" : `${formatPercent(red)}`;
		lines.push(this.#row("Reduction %", red !== null && red >= 20 ? this.#success(redStr) : this.#dim(redStr), cw));
		lines.push(this.#row("Est tokens (project)", formatTokens(project.estTokens), cw));
		lines.push(this.#row("Est tokens (global)", formatTokens(g.estTokens), cw));
		lines.push(this.#row("Sessions (project)", String(project.sessions), cw));
		lines.push(this.#row("Sessions (global)", String(g.sessions), cw));
		lines.push(this.#row("Hits (project)", String(project.hits), cw));
		lines.push(this.#row("Hits (global)", String(g.hits), cw));
		lines.push("");

		const toolEntries = Object.entries(project.tools ?? {}).sort((a, b) => b[1].savedBytes - a[1].savedBytes);
		lines.push(clean(this.#heading("Tool Breakdown (project)"), cw));
		lines.push(this.#border(cw));
		if (toolEntries.length === 0) {
			lines.push(clean(this.#dim("  (no data)"), cw));
		} else {
			for (const [name, ts] of toolEntries) {
				const hitRate = ts.candidates > 0 ? (ts.hits / ts.candidates) * 100 : null;
				const rateStr = hitRate !== null ? `  hit rate ${hitRate.toFixed(0)}%` : "";
				const color = hitRate !== null && hitRate >= 50 ? "success" : hitRate !== null ? "warning" : "dim";
				lines.push(
					clean(
						`  ${this.#keyword(name)}:  ${this.#success(formatKB(ts.savedBytes))} saved,  ${String(ts.hits)} hits / ${String(ts.candidates)} cands${this.#theme.fg?.(color, rateStr) ?? rateStr}`,
						cw,
					),
				);
			}
		}

		return lines;
	}

	// -------------------------------------------------------------------
	// Cell / formatting helpers
	// -------------------------------------------------------------------

	#sessionRow(s: SessionRecord, sessWidth: number): string {
		const label = s.label || s.project;
		const parts = label.split(/[/\\]+/).filter(Boolean);
		const tail = parts.length === 0 ? label || "unknown" : parts.slice(-2).join("/");
		const date = padCell(formatDate(s.lastTs), COL_DATE);
		const name = padCell(truncateToWidth(tail, sessWidth), sessWidth);
		const saved = padCell(formatKB(Math.max(0, s.savedBytes)), COL_KB, "right");
		const tok = padCell(formatTokens(Math.round(Math.max(0, s.savedBytes) / 4)), COL_TOK, "right");
		const hits = padCell(String(Math.round(Math.max(0, s.hits))), COL_HITS, "right");
		return `  ${this.#dim(date)} ${name} ${this.#success(saved)} ${this.#dim(tok)} ${this.#dim(hits)}`;
	}

	#efficiencyBar(ratio: number | null): string {
		if (ratio === null) return this.#dim("-");
		const clamped = Math.max(0, Math.min(1, ratio));
		const filled = Math.round(clamped * BAR_WIDTH);
		const empty = BAR_WIDTH - filled;
		const pct = `${(clamped * 100).toFixed(1)}%`;
		const colorKey = ratio >= 0.3 ? "success" : ratio >= 0.1 ? "warning" : "error";
		return `${this.#theme.fg?.(colorKey, FILL_CHAR.repeat(filled)) ?? FILL_CHAR.repeat(filled)}${this.#dim(EMPTY_CHAR.repeat(empty))} ${this.#theme.fg?.(colorKey, pct) ?? pct}`;
	}

	#efficiencyInline(totals: Totals): string {
		const r = totals.reductionPercent;
		if (r === null) return "";
		const pct = ` (${formatPercent(r)} reduction)`;
		const colorKey = r >= 30 ? "success" : r >= 10 ? "warning" : "dim";
		return this.#theme.fg?.(colorKey, pct) ?? pct;
	}

	#border(w: number): string {
		const ch = this.#theme.boxSharp?.horizontal ?? "─";
		return this.#theme.fg?.("border", ch.repeat(Math.max(1, w))) ?? ch.repeat(Math.max(1, w));
	}

	#formatTab(label: string, active: boolean): string {
		if (active)
			return this.#theme.fg?.("accent", this.#theme.bold?.(`[ ${label} ]`) ?? `[ ${label} ]`) ?? `[ ${label} ]`;
		return this.#dim(`  ${label}  `);
	}

	#row(label: string, value: string, w: number): string {
		return clean(`  ${this.#keyword(label)}: ${value}`, w);
	}

	#heading(text: string): string {
		return this.#theme.fg?.("mdHeading", this.#theme.bold?.(text) ?? text) ?? text;
	}

	#head(text: string): string {
		return this.#theme.fg?.("mdHeading", this.#theme.bold?.(text) ?? text) ?? text;
	}

	#code(text: string): string {
		return this.#theme.fg?.("mdCode", text) ?? text;
	}

	#keyword(text: string): string {
		return this.#theme.fg?.("syntaxKeyword", text) ?? text;
	}

	#success(text: string): string {
		return this.#theme.fg?.("success", text) ?? text;
	}

	#dim(text: string): string {
		return this.#theme.fg?.("dim", text) ?? text;
	}
}

// ---------------------------------------------------------------------------
// Plain-text fallback (no TUI)
// ---------------------------------------------------------------------------

function formatPlainText(data: AggregateStats, width: number): string {
	const w = Math.max(MIN_WIDTH, width);
	const { project, global: g, sessions } = data;
	const lines = [
		"pi-distill savings",
		`Project: ${formatKB(project.savedBytes)} saved  ${formatTokens(project.estTokens)} est tokens  ${String(project.hits)} hits  ${String(project.sessions)} sessions`,
		`Global:  ${formatKB(g.savedBytes)} saved  ${formatTokens(g.estTokens)} est tokens  ${String(g.hits)} hits  ${String(g.sessions)} sessions`,
		"",
	];
	if (sessions.length === 0) {
		lines.push("No sessions recorded yet.");
	} else {
		lines.push(
			`${"Date".padEnd(COL_DATE)} ${"Session".padEnd(28)} ${"Saved".padStart(COL_KB)} ${"Est Tok".padStart(COL_TOK)} ${"Hits".padStart(COL_HITS)}`,
		);
		lines.push(
			`${"-".repeat(COL_DATE)} ${"-".repeat(28)} ${"-".repeat(COL_KB)} ${"-".repeat(COL_TOK)} ${"-".repeat(COL_HITS)}`,
		);
		for (const s of sessions) {
			const label = s.label || s.project;
			const parts = label.split(/[/\\]+/).filter(Boolean);
			const tail = parts.length === 0 ? label || "unknown" : parts.slice(-2).join("/");
			lines.push(
				[
					padCell(formatDate(s.lastTs), COL_DATE),
					padCell(tail, 28),
					padCell(formatKB(Math.max(0, s.savedBytes)), COL_KB, "right"),
					padCell(formatTokens(Math.round(Math.max(0, s.savedBytes) / 4)), COL_TOK, "right"),
					padCell(String(Math.round(Math.max(0, s.hits))), COL_HITS, "right"),
				].join(" "),
			);
		}
	}
	return lines.map(line => fit(stripAnsi(line), w)).join("\n");
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function formatKB(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
	if (bytes < KB) return `${bytes} B`;
	return `${(bytes / KB).toFixed(1)} KB`;
}

function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return "0";
	return Math.round(tokens).toLocaleString("en-US");
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

function clean(text: string, width: number): string {
	return fit(text.replace(/\t/g, "    "), width);
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}
