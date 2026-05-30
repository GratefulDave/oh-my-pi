/**
 * Session observer overlay component.
 *
 * Overview mode: lists all subagent sessions as a table (Agent | Task | Status | Message).
 *   ↑/↓ or j/k to select, Enter to open detail, Esc to close.
 * Detail mode: renders a scrollable, interactive transcript of the selected subagent's session
 *   by reading its JSONL session file — shows thinking, text, tool calls, results
 *   with expand/collapse per entry and breadcrumb navigation for nested sub-agents.
 *
 * Lifecycle:
 *   - shortcut opens overview (if subagents exist), else closes immediately
 *   - Enter on a row → detail viewer
 *   - Esc from detail → back to overview (or pop breadcrumb)
 *   - Esc from overview → close overlay
 *   - Ctrl+S closes from anywhere
 */
import * as fs from "node:fs";

import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { Container, type LocalMouseEvent, Markdown, type MarkdownTheme, matchesKey } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, logger } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import { isSilentAbort } from "../../session/messages";
import type { CustomMessageEntry, SessionMessageEntry } from "../../session/session-manager";
import { parseSessionEntries } from "../../session/session-manager";
import { PREVIEW_LIMITS, replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type {
	IrcConversationRow,
	ObservableSession,
	ObserverRow,
	SessionObserverRegistry,
} from "../session-observer-registry";
import { getMarkdownTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

/** IRC custom message types that are displayed in the observer transcript. */
const IRC_CUSTOM_TYPES = new Set(["irc:incoming", "irc:autoreply", "irc:relay", "irc_message"]);

const OVERVIEW_AGENT_WIDTH = 14;
const OVERVIEW_STATUS_WIDTH = 11;
const OVERVIEW_ROW_CHROME_WIDTH = 11; // cursor + spaces + three " │ " separators
const OVERVIEW_MIN_TASK_WIDTH = 12;
const OVERVIEW_MIN_MESSAGE_WIDTH = 12;
const OVERVIEW_MAX_TASK_FRACTION = 0.45;
const OVERVIEW_TARGET_TASK_FRACTION = 0.34;
const OVERVIEW_IRC_DIRECTION_WIDTH = 28;
const OVERVIEW_IRC_ROW_CHROME_WIDTH = 7; // leading marker + " │ "

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function getOverviewColumnWidths(width: number): { agentW: number; taskW: number; statusW: number; msgW: number } {
	const contentWidth = Math.max(1, width - 1); // #renderOverview prefixes each row with one leading space.
	const available = contentWidth - OVERVIEW_AGENT_WIDTH - OVERVIEW_STATUS_WIDTH - OVERVIEW_ROW_CHROME_WIDTH;
	const taskUpperBound = Math.max(1, available - OVERVIEW_MIN_MESSAGE_WIDTH);
	const desiredTaskW = Math.floor(contentWidth * OVERVIEW_TARGET_TASK_FRACTION);
	const maxTaskW = Math.max(OVERVIEW_MIN_TASK_WIDTH, Math.floor(contentWidth * OVERVIEW_MAX_TASK_FRACTION));
	const taskW = Math.min(clamp(desiredTaskW, OVERVIEW_MIN_TASK_WIDTH, maxTaskW), taskUpperBound);
	const msgW = Math.max(1, available - taskW);
	return { agentW: OVERVIEW_AGENT_WIDTH, taskW, statusW: OVERVIEW_STATUS_WIDTH, msgW };
}

/** Union of transcript entries held in the cache. */
type TranscriptEntry = SessionMessageEntry | CustomMessageEntry;

/** Max thinking characters in collapsed state */
const MAX_THINKING_CHARS_COLLAPSED = 200;
/** Max thinking characters in expanded state */
const MAX_THINKING_CHARS_EXPANDED = 4000;
/** Max tool args characters to display */
const MAX_TOOL_ARGS_CHARS = 500;
/** Lines per page for PageUp/PageDown */
const PAGE_SIZE = 15;
/** Left indent for content under entry headers */
const INDENT = "    ";

/** Compute the max content width for the current terminal, accounting for indent and chrome. */
function contentWidth(indent = INDENT): number {
	return Math.max(TRUNCATE_LENGTHS.SHORT, (process.stdout.columns || 80) - indent.length - 2);
}

/** Sanitize a line for TUI display: replace tabs, then truncate to viewport width. */
function sanitizeLine(text: string, maxWidth?: number): string {
	return truncateToWidth(replaceTabs(text), maxWidth ?? contentWidth());
}

/** Represents a rendered entry in the viewer for selection/expand tracking */
interface ViewerEntry {
	lineStart: number;
	lineCount: number;
	kind: "thinking" | "text" | "toolCall" | "user" | "irc";
}

/** Breadcrumb item for nested session navigation */
interface BreadcrumbItem {
	sessionId: string;
	label: string;
	sessionFile: string;
}

export class SessionObserverOverlayComponent extends Container {
	#registry: SessionObserverRegistry;
	#onDone: () => void;
	#selectedSessionId?: string;
	#observeKeys: KeyId[];
	#transcriptCache?: { path: string; bytesRead: number; entries: TranscriptEntry[]; model?: string };

	// View mode
	#mode: "overview" | "detail" = "overview";

	// Overview state
	#overviewRows: ObserverRow[] = [];
	#overviewSelectedIndex = 0;
	#overviewHeaderLines: string[] = [];
	#overviewFooterLines: string[] = [];
	#overviewContentLines: string[] = [];

	// Scroll state (shared between overview + detail)
	#scrollOffset = 0;
	#renderedLines: string[] = [];
	#viewportHeight = 20;
	#wasAtBottom = true;

	// Entry selection & expand/collapse (detail mode)
	#viewerEntries: ViewerEntry[] = [];
	#selectedEntryIndex = 0;
	#expandedEntries = new Set<number>();

	// Breadcrumb navigation (detail mode)
	#navigationStack: BreadcrumbItem[] = [];

	// Cached header/footer for detail viewer (rebuilt on refresh)
	#viewerHeaderLines: string[] = [];
	#viewerFooterLines: string[] = [];
	// Markdown rendering
	#mdTheme: MarkdownTheme = getMarkdownTheme();

	constructor(registry: SessionObserverRegistry, onDone: () => void, observeKeys: KeyId[]) {
		super();
		this.#registry = registry;
		this.#onDone = onDone;
		this.#observeKeys = observeKeys;

		const rows = this.#registry.getObserverRows();
		if (rows.length > 0) {
			this.#mode = "overview";
			this.#setupOverview();
		} else {
			// No sub-agents — close immediately
			queueMicrotask(() => this.#onDone());
		}
	}

	override render(width: number): string[] {
		if (this.#mode === "overview") {
			this.#buildOverviewContent(width);
			return this.#renderOverview(width);
		}
		return this.#renderViewer(width);
	}

	#setupViewer(): void {
		this.children = [];
		this.#scrollOffset = 0;
		this.#selectedEntryIndex = 0;
		this.#expandedEntries.clear();
		this.#wasAtBottom = true;
		this.#rebuildViewerContent();
		// Auto-scroll to bottom and select last entry on init
		if (this.#viewerEntries.length > 0) {
			this.#selectedEntryIndex = this.#viewerEntries.length - 1;
			this.#wasAtBottom = true;
			this.#rebuildViewerContent();
		}
	}

	// =========================================================================
	// Overview mode
	// =========================================================================

	/** (Re)build the overview table from live registry data */
	#setupOverview(): void {
		this.#overviewRows = this.#registry.getObserverRows();
		// Clamp selection
		if (this.#overviewRows.length > 0) {
			this.#overviewSelectedIndex = Math.min(this.#overviewSelectedIndex, this.#overviewRows.length - 1);
		}
		this.#buildOverviewContent();
	}

	/** Build overview header/footer/content lines */
	#buildOverviewContent(width = process.stdout.columns || 80): void {
		const { agentW, taskW, statusW, msgW: actualMsgW } = getOverviewColumnWidths(width);

		const pad = (s: string, w: number): string => {
			// Truncate if too long (ignoring ANSI), then left-pad with spaces to width.
			// We use a raw approach: slice to w chars, pad remainder.
			const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
			if (stripped.length > w) {
				// Truncate the raw string to fit (we sanitize before calling this)
				return s.slice(0, w);
			}
			return s + " ".repeat(w - stripped.length);
		};
		const headerRow = `${pad(theme.bold("Agent"), agentW)} │ ${pad(theme.bold("Task"), taskW)} │ ${pad(theme.bold("Status"), statusW)} │ ${theme.bold("Message")}`;
		const sepRow = `${"─".repeat(agentW)}─┼─${"─".repeat(taskW)}─┼─${"─".repeat(statusW)}─┼─${"─".repeat(actualMsgW)}`;

		this.#overviewHeaderLines = [theme.fg("accent", "Session Observer")];
		this.#overviewContentLines = [headerRow, theme.fg("dim", sepRow)];

		for (let i = 0; i < this.#overviewRows.length; i++) {
			const row = this.#overviewRows[i];
			const selected = i === this.#overviewSelectedIndex;
			const cursor = selected ? theme.fg("accent", "▶") : " ";

			const agentRaw = sanitizeLine(row.agent, agentW);
			const taskRaw = sanitizeLine(row.task, taskW);
			const { status } = row;
			const msgRaw = sanitizeLine(row.message, actualMsgW);

			const statusColor: "success" | "error" | "warning" | "dim" =
				status === "running"
					? "success"
					: status === "failed"
						? "error"
						: status === "cancelled"
							? "warning"
							: "dim";

			const agentStr = selected ? theme.bold(agentRaw) : agentRaw;
			const taskStr = selected ? theme.bold(taskRaw) : theme.fg("muted", taskRaw);
			const statusStr = theme.fg(statusColor, pad(status, statusW));
			const msgStr = theme.fg("dim", msgRaw);
			const renderedRow = `${cursor} ${pad(agentStr, agentW)} │ ${pad(taskStr, taskW)} │ ${statusStr} │ ${msgStr}`;
			this.#overviewContentLines.push(renderedRow);
		}

		const ircRows = this.#registry.getIrcConversationRows();
		if (ircRows.length > 0) {
			const directionW = Math.min(OVERVIEW_IRC_DIRECTION_WIDTH, Math.max(12, Math.floor(width * 0.3)));
			const bodyW = Math.max(1, width - directionW - OVERVIEW_IRC_ROW_CHROME_WIDTH);
			this.#overviewContentLines.push("");
			this.#overviewContentLines.push(theme.fg("accent", "IRC conversations"));
			this.#overviewContentLines.push(`${pad(theme.bold("Direction"), directionW)} │ ${theme.bold("Message")}`);
			this.#overviewContentLines.push(theme.fg("dim", `${"─".repeat(directionW)}─┼─${"─".repeat(bodyW)}`));
			for (const row of ircRows.slice(-20)) {
				this.#overviewContentLines.push(this.#renderIrcOverviewRow(row, directionW, bodyW, pad));
			}
		}
		this.#overviewFooterLines = [theme.fg("dim", "↑/↓ select  Enter open  Esc/Ctrl+S close  r refresh")];
	}

	#renderIrcOverviewRow(
		row: IrcConversationRow,
		directionW: number,
		bodyW: number,
		pad: (s: string, w: number) => string,
	): string {
		const arrow = row.kind === "reply" ? "←" : "→";
		const direction = sanitizeLine(`${row.from} ${arrow} ${row.to}`, directionW);
		const body = sanitizeLine(row.body.split("\n")[0] ?? "", bodyW);
		return `  ${pad(theme.fg("accent", direction), directionW)} │ ${theme.fg("dim", body)}`;
	}

	/** Render the overview pane into terminal lines */
	#renderOverview(width: number): string[] {
		const termHeight = process.stdout.rows || 40;
		const headerChrome = this.#overviewHeaderLines.length + 2;
		const footerChrome = this.#overviewFooterLines.length + 2;
		const viewport = Math.max(5, termHeight - headerChrome - footerChrome);

		// Scroll to keep selected row visible (rows start at line 2: header + sep)
		const selectedLine = 2 + this.#overviewSelectedIndex;
		if (selectedLine < this.#scrollOffset) this.#scrollOffset = selectedLine;
		if (selectedLine >= this.#scrollOffset + viewport) this.#scrollOffset = selectedLine - viewport + 1;
		this.#scrollOffset = Math.max(
			0,
			Math.min(this.#scrollOffset, Math.max(0, this.#overviewContentLines.length - viewport)),
		);

		const lines: string[] = [];

		// Header
		lines.push(...new DynamicBorder().render(width));
		for (const hl of this.#overviewHeaderLines) {
			lines.push(` ${hl}`);
		}
		lines.push(...new DynamicBorder().render(width));

		// Content viewport
		const visible = this.#overviewContentLines.slice(this.#scrollOffset, this.#scrollOffset + viewport);
		for (const vl of visible) {
			lines.push(` ${vl}`);
		}
		const pad2 = viewport - visible.length;
		for (let i = 0; i < pad2; i++) {
			lines.push("");
		}

		// Footer
		lines.push("");
		for (const fl of this.#overviewFooterLines) {
			lines.push(` ${fl}`);
		}
		lines.push(...new DynamicBorder().render(width));

		return lines;
	}

	/** Enter detail view for the currently selected overview row */
	#enterDetail(): void {
		const row = this.#overviewRows[this.#overviewSelectedIndex];
		if (!row) return;
		this.#mode = "detail";
		this.#selectedSessionId = row.session.id;
		this.#navigationStack = [];
		this.#transcriptCache = undefined;
		this.#scrollOffset = 0;
		this.#selectedEntryIndex = 0;
		this.#expandedEntries.clear();
		this.#wasAtBottom = true;
		this.#setupViewer();
	}

	/** Return from detail view back to overview */
	#returnToOverview(): void {
		this.#mode = "overview";
		this.#selectedSessionId = undefined;
		this.#transcriptCache = undefined;
		this.#navigationStack = [];
		this.#scrollOffset = 0;
		this.#setupOverview();
	}

	/** Handle key input when in overview mode */
	#handleOverviewInput(keyData: string): void {
		const rowCount = this.#overviewRows.length;
		// j / down — move selection down
		if (keyData === "j" || matchesKey(keyData, "down")) {
			if (rowCount > 0) {
				this.#overviewSelectedIndex = Math.min(this.#overviewSelectedIndex + 1, rowCount - 1);
			}
			this.#buildOverviewContent();
			return;
		}

		// k / up — move selection up
		if (keyData === "k" || matchesKey(keyData, "up")) {
			if (rowCount > 0) {
				this.#overviewSelectedIndex = Math.max(this.#overviewSelectedIndex - 1, 0);
			}
			this.#buildOverviewContent();
			return;
		}

		// G — jump to last row
		if (keyData === "G" && rowCount > 0) {
			this.#overviewSelectedIndex = rowCount - 1;
			this.#buildOverviewContent();
			return;
		}

		// g — jump to first row
		if (keyData === "g") {
			this.#overviewSelectedIndex = 0;
			this.#buildOverviewContent();
			return;
		}

		// r — refresh overview
		if (keyData === "r") {
			this.#setupOverview();
			return;
		}

		// Enter — open detail for selected row
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			this.#enterDetail();
			return;
		}

		// Escape — close overlay
		if (matchesKey(keyData, "escape")) {
			this.#onDone();
			return;
		}
	}

	/** Rebuild content from live registry data */
	refreshFromRegistry(): void {
		if (this.#mode === "overview") {
			this.#setupOverview();
		} else if (this.#selectedSessionId) {
			// Keep auto-scrolling to bottom unless the user navigated away from the last entry
			this.#wasAtBottom = this.#selectedEntryIndex >= this.#viewerEntries.length - 1;
			this.#rebuildViewerContent();
		}
	}

	/** Rebuild the transcript content lines (called on setup and refresh) */
	#rebuildViewerContent(): void {
		const sessions = this.#registry.getSessions();
		const session = sessions.find(s => s.id === this.#selectedSessionId);

		// Load transcript first so model info is available for header
		let messageEntries: TranscriptEntry[] | null = null;
		if (session?.sessionFile) {
			messageEntries = this.#loadTranscript(session.sessionFile);
		}

		// Header
		this.#viewerHeaderLines = [];
		const breadcrumb = this.#buildBreadcrumb(session);
		this.#viewerHeaderLines.push(theme.fg("accent", breadcrumb));
		if (session) {
			const statusColor = session.status === "active" ? "success" : session.status === "failed" ? "error" : "dim";
			const statusText = theme.fg(statusColor, `[${session.status}]`);
			const agentTag = session.agent ? theme.fg("dim", ` ${session.agent}`) : "";
			const subagentIds = this.#getSubagentSessionIds();
			const posIdx = subagentIds.indexOf(this.#selectedSessionId ?? "");
			const posLabel =
				subagentIds.length > 1 && posIdx >= 0 ? theme.fg("dim", ` (${posIdx + 1}/${subagentIds.length})`) : "";
			const modelName = this.#transcriptCache?.model;
			const modelLabel = modelName ? theme.fg("muted", ` · ${modelName}`) : "";
			this.#viewerHeaderLines.push(`${theme.bold(session.label)} ${statusText}${agentTag}${posLabel}${modelLabel}`);
		}

		// Content
		const contentLines: string[] = [];
		this.#viewerEntries = [];

		if (!session) {
			contentLines.push(theme.fg("dim", "Session no longer available."));
		} else if (!session.sessionFile && session.source?.kind === "async-job") {
			this.#buildAsyncJobLines(session, contentLines);
		} else if (!session.sessionFile) {
			this.#buildObservableMetadataLines(session, contentLines);
		} else if (!messageEntries) {
			contentLines.push(theme.fg("dim", "Unable to read session file."));
			this.#buildObservableMetadataLines(session, contentLines);
		} else if (messageEntries.length === 0) {
			contentLines.push(theme.fg("dim", "No messages yet."));
		} else {
			this.#buildTranscriptLines(messageEntries, contentLines);
		}
		this.#renderedLines = contentLines;

		// Footer
		this.#viewerFooterLines = [];
		const statsLine = this.#buildStatsLine(session);
		if (statsLine) this.#viewerFooterLines.push(statsLine);
		this.#viewerFooterLines.push(
			theme.fg(
				"dim",
				"j/k:scroll  Enter:expand  [/]/←→:cycle agents  Esc:back to overview  Ctrl+S:close  g/G:top/bottom",
			),
		);

		// Auto-scroll to bottom if we were at bottom
		if (this.#wasAtBottom) {
			this.#scrollOffset = Math.max(0, contentLines.length - this.#viewportHeight);
		}
	}

	/** Produce the final viewer output for the overlay system */
	#renderViewer(width: number): string[] {
		const termHeight = process.stdout.rows || 40;

		// Compute viewport: total height minus header chrome and footer chrome
		// Header: border(1) + headerLines + border(1) = headerLines.length + 2
		// Footer: spacer(1) + scrollInfo(1) + footerLines + border(1) = footerLines.length + 2
		const headerChrome = this.#viewerHeaderLines.length + 2;
		const footerChrome = this.#viewerFooterLines.length + 2;
		this.#viewportHeight = Math.max(5, termHeight - headerChrome - footerChrome);

		// Clamp scroll offset
		const maxScroll = Math.max(0, this.#renderedLines.length - this.#viewportHeight);
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScroll));

		const lines: string[] = [];

		// --- Header ---
		lines.push(...new DynamicBorder().render(width));
		for (const hl of this.#viewerHeaderLines) {
			lines.push(` ${hl}`);
		}
		lines.push(...new DynamicBorder().render(width));

		// --- Scrolled content viewport ---
		const visibleLines = this.#renderedLines.slice(this.#scrollOffset, this.#scrollOffset + this.#viewportHeight);
		for (const vl of visibleLines) {
			lines.push(` ${vl}`);
		}
		// Pad to fill viewport if content is shorter
		const pad = this.#viewportHeight - visibleLines.length;
		for (let i = 0; i < pad; i++) {
			lines.push("");
		}

		// --- Footer ---
		const scrollInfo =
			this.#renderedLines.length > this.#viewportHeight
				? ` ${theme.fg("dim", `[${this.#scrollOffset + 1}-${Math.min(this.#scrollOffset + this.#viewportHeight, this.#renderedLines.length)}/${this.#renderedLines.length}]`)}`
				: "";
		lines.push("");
		lines.push(` ${this.#viewerFooterLines[0] ?? ""}${scrollInfo}`);
		for (let i = 1; i < this.#viewerFooterLines.length; i++) {
			lines.push(` ${this.#viewerFooterLines[i]}`);
		}
		lines.push(...new DynamicBorder().render(width));

		return lines;
	}

	#buildBreadcrumb(session: ObservableSession | undefined): string {
		const parts: string[] = ["Session Observer"];
		for (const item of this.#navigationStack) {
			parts.push(item.label);
		}
		if (session) parts.push(session.label);
		return parts.join(" > ");
	}

	#buildStatsLine(session: ObservableSession | undefined): string {
		const progress = session?.progress;
		if (!progress) return "";
		const stats: string[] = [];
		if (progress.toolCount > 0) stats.push(`${formatNumber(progress.toolCount)} tools`);
		// Current per-turn context — what the user reads as "how full is the context".
		// Falls back to cumulative billing volume (Σ-prefixed) when context size is unknown.
		if (progress.contextTokens && progress.contextTokens > 0) {
			const ctx =
				progress.contextWindow && progress.contextWindow > 0
					? `${formatNumber(progress.contextTokens)}/${formatNumber(progress.contextWindow)} ctx`
					: `${formatNumber(progress.contextTokens)} ctx`;
			stats.push(ctx);
			if (progress.tokens > 0) stats.push(`Σ${formatNumber(progress.tokens)}`);
		} else if (progress.tokens > 0) {
			stats.push(`Σ${formatNumber(progress.tokens)}`);
		}
		if (progress.durationMs > 0) stats.push(formatDuration(progress.durationMs));
		const parts: string[] = [];
		if (stats.length > 0) parts.push(theme.fg("dim", stats.join(theme.sep.dot)));
		if (progress.cost > 0) parts.push(theme.fg("statusLineCost", `$${progress.cost.toFixed(2)}`));
		return parts.join(theme.sep.dot);
	}

	#buildAsyncJobLines(session: ObservableSession, lines: string[]): void {
		const job = session.asyncJob;
		const progress = session.progress;
		const kind = session.source?.jobType === "bash" ? "Bash job" : "Task agent";
		const status = job?.status ?? session.status;
		const statusTone =
			status === "running" || session.status === "active"
				? "success"
				: status === "failed"
					? "error"
					: status === "cancelled" || session.status === "aborted"
						? "warning"
						: "dim";
		const icon =
			status === "running" || session.status === "active"
				? "●"
				: status === "failed"
					? "✕"
					: status === "cancelled" || session.status === "aborted"
						? "■"
						: "✓";
		const elapsedMs = job?.startTime ? Math.max(0, Date.now() - job.startTime) : 0;
		const titleParts = [
			theme.fg(statusTone, icon),
			theme.bold(kind),
			theme.fg(statusTone, `[${status}]`),
			elapsedMs > 0 ? theme.fg("dim", formatDuration(elapsedMs)) : "",
		].filter(Boolean);

		lines.push(
			`${titleParts.join(" ")} ${theme.fg("muted", sanitizeLine(job?.label ?? session.label, contentWidth()))}`,
		);
		const description = progress?.description ?? session.description;
		if (description && description !== job?.label) {
			lines.push(`${INDENT}${theme.fg("dim", "↳")} ${sanitizeLine(description, contentWidth())}`);
		}
		if (progress?.currentTool) {
			const currentTool = progress.currentToolArgs
				? `${progress.currentTool} ${progress.currentToolArgs}`
				: progress.currentTool;
			lines.push(`${INDENT}${theme.fg("dim", "tool")} ${sanitizeLine(currentTool, contentWidth())}`);
		}
		const statsLine = this.#buildStatsLine(session);
		if (statsLine) lines.push(`${INDENT}${statsLine}`);

		const output = job?.errorText ?? job?.resultText ?? job?.progressText;
		if (output) {
			const tone = job?.errorText ? "error" : job?.resultText ? "dim" : "muted";
			const label = job?.errorText ? "error" : job?.resultText ? "output" : "progress";
			lines.push(`${INDENT}${theme.fg("dim", `${label}:`)}`);
			for (const outputLine of output
				.split("\n")
				.filter(line => line.length > 0)
				.slice(0, PREVIEW_LIMITS.COLLAPSED_LINES)) {
				lines.push(`${INDENT}  ${theme.fg(tone, sanitizeLine(outputLine, contentWidth("      ")))}`);
			}
		}
	}

	#buildObservableMetadataLines(session: ObservableSession, lines: string[]): void {
		const progress = session.progress;
		const metadata = session.runMetadata ?? progress?.runMetadata;
		const artifacts = metadata?.artifacts ?? [];
		const hasTranscriptArtifact = artifacts.some(artifact => artifact.kind === "transcript");

		lines.push(
			theme.fg(
				"dim",
				hasTranscriptArtifact
					? "Transcript view unavailable until a session file is attached; transcript artifact is listed below."
					: "Captured transcript unavailable; this run has not published a session file.",
			),
		);
		lines.push("");
		lines.push(theme.bold("Observable run"));
		this.#appendMetadataLine(
			lines,
			"Status",
			metadata?.status ? `${session.status} (${metadata.status})` : session.status,
		);
		this.#appendMetadataLine(lines, "Label", session.label);
		if (session.asyncJob) {
			this.#appendMetadataLine(lines, "Job", session.asyncJob.id);
			this.#appendMetadataLine(lines, "Type", session.asyncJob.type);
			this.#appendMetadataLine(
				lines,
				"Started",
				formatDuration(Math.max(0, Date.now() - session.asyncJob.startTime)),
			);
		}
		if (session.description && session.description !== session.label)
			this.#appendMetadataLine(lines, "Description", session.description);
		this.#appendMetadataLine(lines, "Agent", session.agent ?? metadata?.agent);
		if (session.source) {
			this.#appendMetadataLine(
				lines,
				"Source",
				[session.source.kind, session.source.name, session.source.eventChannel].filter(Boolean).join(" · "),
			);
		}
		if (metadata?.runId) this.#appendMetadataLine(lines, "Run", metadata.runId);
		if (metadata?.taskId && metadata.taskId !== metadata.runId)
			this.#appendMetadataLine(lines, "Task", metadata.taskId);
		if (metadata?.parentRunId) this.#appendMetadataLine(lines, "Parent", metadata.parentRunId);
		this.#appendMetadataLine(lines, "Model", this.#formatMetadataValue(metadata?.resolvedModel ?? metadata?.model));
		if (metadata?.runtimeFallbackUsed) {
			this.#appendMetadataLine(
				lines,
				"Fallback",
				[metadata.fallbackFrom, metadata.fallbackTo].filter(Boolean).join(" → "),
			);
		}
		if (metadata?.thinkingLevel) this.#appendMetadataLine(lines, "Thinking", metadata.thinkingLevel);

		if (metadata?.presentation) {
			const presentation = metadata.presentation;
			this.#appendMetadataLine(
				lines,
				"Presentation",
				[
					presentation.mode,
					presentation.backend ? `backend=${presentation.backend}` : "",
					presentation.session ? `session=${presentation.session}` : "",
					presentation.paneId ? `paneId=${presentation.paneId}` : "",
					presentation.windowId ? `windowId=${presentation.windowId}` : "",
				]
					.filter(Boolean)
					.join(" · "),
			);
		}
		if (metadata?.cwd) this.#appendMetadataLine(lines, "Cwd", this.#formatMetadataPath(metadata.cwd));
		if (metadata?.worktree && metadata.worktree !== metadata.cwd)
			this.#appendMetadataLine(lines, "Worktree", this.#formatMetadataPath(metadata.worktree));

		const asyncPreview =
			session.asyncJob?.errorText ?? session.asyncJob?.resultText ?? session.asyncJob?.progressText;
		if (asyncPreview) {
			lines.push("");
			lines.push(theme.bold(session.asyncJob?.errorText ? "Error output" : "Latest output"));
			const previewLines = asyncPreview
				.split(/\r?\n/)
				.filter(line => line.trim())
				.slice(0, PREVIEW_LIMITS.COLLAPSED_LINES);
			for (const previewLine of previewLines) {
				lines.push(`${INDENT}${theme.fg("dim", sanitizeLine(previewLine, contentWidth()))}`);
			}
		}
		if (progress) {
			lines.push("");
			lines.push(theme.bold("Progress"));
			if (progress.description) this.#appendMetadataLine(lines, "Description", progress.description);
			if (progress.task && progress.task !== progress.description)
				this.#appendMetadataLine(lines, "Task", progress.task);
			if (progress.lastIntent) this.#appendMetadataLine(lines, "Intent", progress.lastIntent);
			if (progress.currentTool) {
				const currentTool = progress.currentToolArgs
					? `${progress.currentTool} ${progress.currentToolArgs}`
					: progress.currentTool;
				this.#appendMetadataLine(lines, "Current tool", currentTool);
			}
			const statsLine = this.#buildStatsLine(session);
			if (statsLine) this.#appendMetadataLine(lines, "Usage", statsLine);
			if (progress.recentOutput.length > 0) {
				const recentOutput = progress.recentOutput.slice(-PREVIEW_LIMITS.COLLAPSED_LINES);
				lines.push(`${INDENT}${theme.fg("dim", "Recent output:")}`);
				for (const outputLine of recentOutput) {
					lines.push(`${INDENT}  ${theme.fg("dim", sanitizeLine(outputLine, contentWidth("      ")))}`);
				}
			}
		}

		if (artifacts.length > 0) {
			lines.push("");
			lines.push(theme.bold("Artifacts"));
			for (const artifact of artifacts) {
				this.#appendMetadataLine(lines, artifact.kind, this.#formatArtifactRef(artifact));
			}
		}
	}

	#appendMetadataLine(lines: string[], label: string, value: string | undefined): void {
		if (!value) return;
		lines.push(`${INDENT}${theme.fg("dim", `${label}:`)} ${sanitizeLine(value, contentWidth())}`);
	}

	#formatMetadataValue(value: string | string[] | undefined): string | undefined {
		if (Array.isArray(value)) return value.join(", ");
		return value;
	}

	#formatArtifactRef(artifact: { url?: string; path?: string; mime?: string }): string {
		const refs = [
			artifact.url ? `url=${artifact.url}` : "",
			artifact.path ? `path=${this.#formatMetadataPath(artifact.path)}` : "",
			artifact.mime ? `mime=${artifact.mime}` : "",
		].filter(Boolean);
		return refs.length > 0 ? refs.join(" · ") : "reference unavailable";
	}

	#formatMetadataPath(pathValue: string): string {
		return shortenPath(pathValue);
	}

	#buildTranscriptLines(messageEntries: TranscriptEntry[], lines: string[]): void {
		// Build a tool call ID -> tool result map (only from normal message entries)
		const toolResults = new Map<string, ToolResultMessage>();
		for (const entry of messageEntries) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				toolResults.set(entry.message.toolCallId, entry.message);
			}
		}

		let entryIndex = 0;
		for (const entry of messageEntries) {
			if (entry.type === "custom_message") {
				// IRC custom messages
				const text =
					typeof entry.content === "string"
						? entry.content
						: entry.content
								.filter((b): b is { type: "text"; text: string } => b.type === "text")
								.map(b => b.text)
								.join("\n");
				if (text.trim()) {
					const startLine = lines.length;
					const isSelected = entryIndex === this.#selectedEntryIndex;
					const isExpanded = this.#expandedEntries.has(entryIndex);
					this.#renderIrcLines(lines, entry, text.trim(), isExpanded, isSelected);
					this.#viewerEntries.push({ lineStart: startLine, lineCount: lines.length - startLine, kind: "irc" });
					entryIndex++;
				}
				continue;
			}

			const msg = entry.message;

			if (msg.role === "assistant") {
				// Handle error messages with empty content
				if (msg.content.length === 0 && msg.errorMessage && !isSilentAbort(msg.errorMessage)) {
					const startLine = lines.length;
					const isSelected = entryIndex === this.#selectedEntryIndex;
					const cursor = isSelected ? theme.fg("accent", "▶") : " ";
					lines.push("");
					const errorLines = msg.errorMessage.split("\n");
					const maxWidth = contentWidth();
					lines.push(`${cursor} ${theme.fg("error", `✗ Error: ${sanitizeLine(errorLines[0], maxWidth)}`)}`);
					for (let i = 1; i < errorLines.length; i++) {
						lines.push(`${INDENT}${theme.fg("error", sanitizeLine(errorLines[i], maxWidth))}`);
					}
					this.#viewerEntries.push({ lineStart: startLine, lineCount: lines.length - startLine, kind: "text" });
					entryIndex++;
				} else {
					for (const content of msg.content) {
						if (content.type === "thinking" && content.thinking.trim()) {
							const startLine = lines.length;
							const isExpanded = this.#expandedEntries.has(entryIndex);
							const isSelected = entryIndex === this.#selectedEntryIndex;
							this.#renderThinkingLines(lines, content.thinking.trim(), isExpanded, isSelected);
							this.#viewerEntries.push({
								lineStart: startLine,
								lineCount: lines.length - startLine,
								kind: "thinking",
							});
							entryIndex++;
						} else if (content.type === "text" && content.text.trim()) {
							const startLine = lines.length;
							const isExpanded = this.#expandedEntries.has(entryIndex);
							const isSelected = entryIndex === this.#selectedEntryIndex;
							this.#renderTextLines(lines, content.text.trim(), isExpanded, isSelected);
							this.#viewerEntries.push({
								lineStart: startLine,
								lineCount: lines.length - startLine,
								kind: "text",
							});
							entryIndex++;
						} else if (content.type === "toolCall") {
							const startLine = lines.length;
							const isExpanded = this.#expandedEntries.has(entryIndex);
							const isSelected = entryIndex === this.#selectedEntryIndex;
							const result = toolResults.get(content.id);
							this.#renderToolCallLines(lines, content, result, isExpanded, isSelected);
							this.#viewerEntries.push({
								lineStart: startLine,
								lineCount: lines.length - startLine,
								kind: "toolCall",
							});
							entryIndex++;
						}
					}
				}
			} else if (msg.role === "user" || msg.role === "developer") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
								.filter((b): b is { type: "text"; text: string } => b.type === "text")
								.map(b => b.text)
								.join("\n");
				if (text.trim()) {
					const startLine = lines.length;
					const isSelected = entryIndex === this.#selectedEntryIndex;
					const isExpanded = this.#expandedEntries.has(entryIndex);
					const label = msg.role === "developer" ? "System" : "User";
					const cursor = isSelected ? theme.fg("accent", "▶") : " ";
					lines.push("");
					if (isExpanded) {
						lines.push(`${cursor} ${theme.fg("dim", `[${label}]`)}`);
						const mdLines = this.#renderMarkdownToLines(text.trim());
						for (const ml of mdLines) {
							lines.push(ml);
						}
					} else {
						const firstLine = text.trim().split("\n")[0];
						const totalLines = text.trim().split("\n").length;
						const hint = totalLines > 1 ? theme.fg("dim", ` (${totalLines} lines)`) : "";
						lines.push(
							`${cursor} ${theme.fg("dim", `[${label}]`)} ${theme.fg("muted", sanitizeLine(firstLine, TRUNCATE_LENGTHS.TITLE))}${hint}`,
						);
					}
					this.#viewerEntries.push({ lineStart: startLine, lineCount: lines.length - startLine, kind: "user" });
					entryIndex++;
				}
			}
		}
	}

	/** Derive a directional label for an IRC custom message entry. */
	#ircLabel(entry: CustomMessageEntry): string {
		const d = entry.details as Record<string, unknown> | undefined;
		const from = typeof d?.from === "string" ? d.from : undefined;
		const to = typeof d?.to === "string" ? d.to : undefined;
		const kind = d?.kind;

		if (from !== undefined && to !== undefined) {
			// relay with explicit kind
			if (entry.customType === "irc:relay") {
				if (kind === "reply") {
					return `[IRC ${from} → (auto) ${to}]`;
				}
				return `[IRC ${from} → ${to}]`;
			}
			return `[IRC ${from} → ${to}]`;
		}
		if (entry.customType === "irc:incoming" && from !== undefined) {
			return `[IRC ${from} → you]`;
		}
		if (entry.customType === "irc:autoreply" && to !== undefined) {
			return `[IRC you → ${to} (auto)]`;
		}
		return "";
	}

	/** Render an IRC custom message entry in collapsed or expanded form. */
	#renderIrcLines(
		lines: string[],
		entry: CustomMessageEntry,
		text: string,
		expanded: boolean,
		selected: boolean,
	): void {
		const cursor = selected ? theme.fg("accent", "▶") : " ";

		// Derive the label from metadata; fall back to content-prefix detection.
		let label = this.#ircLabel(entry);
		let body = text;

		if (!label) {
			const firstNewline = text.indexOf("\n");
			const firstLine = firstNewline === -1 ? text : text.slice(0, firstNewline);
			if (firstLine.startsWith("[IRC")) {
				// Use first line as label; strip it from the body.
				label = firstLine.trimEnd();
				body = firstNewline === -1 ? "" : text.slice(firstNewline + 1).trimStart();
			} else {
				label = "[IRC]";
			}
		}

		const styledLabel = theme.fg("dim", label);
		lines.push("");
		if (expanded) {
			lines.push(`${cursor} ${styledLabel}`);
			if (body) {
				const mdLines = this.#renderMarkdownToLines(body);
				for (const ml of mdLines) {
					lines.push(ml);
				}
			}
		} else {
			const bodyLines = body.split("\n");
			const firstBodyLine = bodyLines[0] ?? "";
			const totalBodyLines = bodyLines.filter(l => l.trim()).length;
			const hint = totalBodyLines > 1 ? theme.fg("dim", ` (${totalBodyLines} lines)`) : "";
			lines.push(
				`${cursor} ${styledLabel} ${theme.fg("muted", sanitizeLine(firstBodyLine, TRUNCATE_LENGTHS.TITLE))}${hint}`,
			);
		}
	}

	/** Render markdown text into indented lines using the theme's markdown renderer */
	#renderMarkdownToLines(text: string, indent: string = INDENT): string[] {
		const width = Math.max(40, (process.stdout.columns || 80) - indent.length - 4);
		const md = new Markdown(text, 0, 0, this.#mdTheme);
		const rendered = md.render(width);
		return rendered.map(line => `${indent}${line.trimEnd()}`);
	}

	#renderThinkingLines(lines: string[], thinking: string, expanded: boolean, selected: boolean): void {
		const cursor = selected ? theme.fg("accent", "▶") : " ";
		const maxChars = expanded ? MAX_THINKING_CHARS_EXPANDED : MAX_THINKING_CHARS_COLLAPSED;
		const truncated = thinking.length > maxChars;
		const expandLabel = !expanded && truncated ? theme.fg("dim", " ↵") : "";

		lines.push("");
		lines.push(`${cursor} ${theme.fg("dim", "💭 Thinking")}${expandLabel}`);

		const displayText = truncated ? `${thinking.slice(0, maxChars)}...` : thinking;
		if (expanded) {
			// Expanded thinking: render as markdown for readable formatting
			const mdLines = this.#renderMarkdownToLines(displayText);
			const maxLines = 100;
			for (let i = 0; i < Math.min(mdLines.length, maxLines); i++) {
				lines.push(mdLines[i]);
			}
			if (mdLines.length > maxLines) {
				lines.push(`${INDENT}${theme.fg("dim", `... ${mdLines.length - maxLines} more lines`)}`);
			}
		} else {
			// Collapsed thinking: brief italic preview
			const thinkingLines = displayText.split("\n");
			const maxLines = PREVIEW_LIMITS.COLLAPSED_LINES;
			for (let i = 0; i < Math.min(thinkingLines.length, maxLines); i++) {
				lines.push(`${INDENT}${theme.fg("thinkingText", sanitizeLine(thinkingLines[i]))}`);
			}
			if (thinkingLines.length > maxLines) {
				lines.push(`${INDENT}${theme.fg("dim", `... ${thinkingLines.length - maxLines} more lines`)}`);
			}
		}
	}

	#renderTextLines(lines: string[], text: string, expanded: boolean, selected: boolean): void {
		const cursor = selected ? theme.fg("accent", "▶") : " ";

		lines.push("");
		lines.push(`${cursor} ${theme.fg("muted", "Response")}`);

		if (expanded) {
			// Expanded: full markdown rendering
			const mdLines = this.#renderMarkdownToLines(text);
			for (const ml of mdLines) {
				lines.push(ml);
			}
		} else {
			// Collapsed: first few lines as plain text
			const textLines = text.split("\n");
			const maxLines = PREVIEW_LIMITS.COLLAPSED_LINES;
			const maxWidth = contentWidth();
			for (let i = 0; i < Math.min(textLines.length, maxLines); i++) {
				lines.push(`${INDENT}${sanitizeLine(textLines[i], maxWidth)}`);
			}
			if (textLines.length > maxLines) {
				lines.push(`${INDENT}${theme.fg("dim", `... ${textLines.length - maxLines} more lines`)}`);
			}
		}
	}

	#renderToolCallLines(
		lines: string[],
		call: { id: string; name: string; arguments: Record<string, unknown>; intent?: string },
		result: ToolResultMessage | undefined,
		expanded: boolean,
		selected: boolean,
	): void {
		const cursor = selected ? theme.fg("accent", "▶") : " ";
		lines.push("");

		// Tool call header
		const intentStr = call.intent ? theme.fg("dim", ` ${sanitizeLine(call.intent, TRUNCATE_LENGTHS.SHORT)}`) : "";
		lines.push(`${cursor} ${theme.fg("accent", "▸")} ${theme.bold(theme.fg("muted", call.name))}${intentStr}`);

		// Key arguments
		const argSummary = this.#formatToolArgs(call.name, call.arguments);
		if (argSummary) {
			lines.push(`${INDENT}${theme.fg("dim", sanitizeLine(argSummary, contentWidth()))}`);
		}

		// Tool result
		if (result) {
			this.#renderToolResultLines(lines, result, expanded);
		}
	}

	#renderToolResultLines(lines: string[], result: ToolResultMessage, expanded: boolean): void {
		const textParts = result.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map(p => p.text);
		const text = textParts.join("\n").trim();

		if (result.isError) {
			const errorLines = text.split("\n");
			const maxErrorLines = expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
			const maxWidth = contentWidth();
			lines.push(`${INDENT}${theme.fg("error", `✗ ${sanitizeLine(errorLines[0] || "Error", maxWidth)}`)}`);
			for (let i = 1; i < Math.min(errorLines.length, maxErrorLines); i++) {
				lines.push(`${INDENT}  ${theme.fg("error", sanitizeLine(errorLines[i], maxWidth))}`);
			}
			if (errorLines.length > maxErrorLines) {
				lines.push(`${INDENT}  ${theme.fg("dim", `... ${errorLines.length - maxErrorLines} more lines`)}`);
			}
			return;
		}

		if (!text) {
			lines.push(`${INDENT}${theme.fg("dim", "✓ done")}`);
			return;
		}

		const resultLines = text.split("\n");
		const maxLines = expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.OUTPUT_COLLAPSED;

		// Status line
		const statusPrefix = `${INDENT}${theme.fg("success", "✓")}`;

		if (resultLines.length === 1 && text.length < TRUNCATE_LENGTHS.LONG) {
			lines.push(`${statusPrefix} ${theme.fg("dim", sanitizeLine(text))}`);
			return;
		}

		lines.push(`${statusPrefix} ${theme.fg("dim", `${resultLines.length} lines`)}`);
		const displayLines = resultLines.slice(0, maxLines);
		for (const rl of displayLines) {
			lines.push(`${INDENT}  ${theme.fg("dim", sanitizeLine(rl))}`);
		}
		if (resultLines.length > maxLines) {
			lines.push(`${INDENT}  ${theme.fg("dim", `... ${resultLines.length - maxLines} more`)}`);
		}
	}

	#formatToolArgs(toolName: string, args: Record<string, unknown>): string {
		switch (toolName) {
			case "read":
			case "write":
			case "edit":
				return args.path ? `path: ${args.path}` : "";
			case "search":
				return [
					args.pattern ? `pattern: ${args.pattern}` : "",
					Array.isArray(args.paths)
						? `paths: ${args.paths.join(", ")}`
						: typeof args.paths === "string"
							? `paths: ${args.paths}`
							: "",
				]
					.filter(Boolean)
					.join(", ");
			case "find":
				return Array.isArray(args.paths) ? `paths: ${args.paths.join(", ")}` : "";
			case "bash": {
				const cmd = args.command;
				return typeof cmd === "string" ? replaceTabs(cmd) : "";
			}
			case "lsp":
				return [args.action, args.file, args.symbol].filter(Boolean).join(" ");
			case "ast_grep":
			case "ast_edit":
				return args.path ? `path: ${args.path}` : "";
			case "task": {
				const tasks = args.tasks;
				return Array.isArray(tasks) ? `${tasks.length} task(s)` : "";
			}
			default: {
				const parts: string[] = [];
				let total = 0;
				for (const [key, value] of Object.entries(args)) {
					if (key.startsWith("_")) continue;
					const v = typeof value === "string" ? value : JSON.stringify(value);
					const entry = `${key}: ${replaceTabs(v ?? "")}`;
					if (total + entry.length > MAX_TOOL_ARGS_CHARS) break;
					parts.push(entry);
					total += entry.length;
				}
				return parts.join(", ");
			}
		}
	}

	#loadTranscript(sessionFile: string): TranscriptEntry[] | null {
		if (this.#transcriptCache && this.#transcriptCache.path !== sessionFile) {
			this.#transcriptCache = undefined;
		}

		const fromByte = this.#transcriptCache?.bytesRead ?? 0;
		const result = readFileIncremental(sessionFile, fromByte);
		if (!result) {
			logger.debug("Session observer: failed to read session file", { path: sessionFile });
			return this.#transcriptCache?.entries ?? null;
		}

		if (result.newSize < fromByte) {
			this.#transcriptCache = undefined;
			return this.#loadTranscript(sessionFile);
		}

		if (!this.#transcriptCache) {
			this.#transcriptCache = { path: sessionFile, bytesRead: 0, entries: [] };
		}

		if (result.text.length > 0) {
			const lastNewline = result.text.lastIndexOf("\n");
			if (lastNewline >= 0) {
				const completeChunk = result.text.slice(0, lastNewline + 1);
				const newEntries = parseSessionEntries(completeChunk);
				for (const entry of newEntries) {
					if (entry.type === "message") {
						this.#transcriptCache.entries.push(entry);
						// Extract model from first assistant message
						const msg = entry.message;
						if (!this.#transcriptCache.model && msg.role === "assistant") {
							this.#transcriptCache.model = msg.model;
						}
					} else if (entry.type === "custom_message" && IRC_CUSTOM_TYPES.has(entry.customType)) {
						this.#transcriptCache.entries.push(entry);
					} else if (entry.type === "model_change") {
						this.#transcriptCache.model = entry.model;
					}
				}
				this.#transcriptCache.bytesRead = fromByte + Buffer.byteLength(completeChunk, "utf-8");
			}
		}
		return this.#transcriptCache.entries;
	}

	#navigateBack(): boolean {
		if (this.#navigationStack.length === 0) return false;
		const prev = this.#navigationStack.pop()!;
		this.#selectedSessionId = prev.sessionId;
		this.#transcriptCache = undefined;
		this.#scrollOffset = 0;
		this.#selectedEntryIndex = 0;
		this.#expandedEntries.clear();
		this.#rebuildViewerContent();
		return true;
	}

	handleInput(keyData: string): void {
		// Ctrl+S (observe key) always closes the overlay
		for (const key of this.#observeKeys) {
			if (matchesKey(keyData, key)) {
				this.#onDone();
				return;
			}
		}

		if (this.#mode === "overview") {
			this.#handleOverviewInput(keyData);
		} else {
			this.#handleViewerInput(keyData);
		}
	}

	handleMouse(event: LocalMouseEvent): void {
		if (event.released || event.button !== 0) return;
		if (this.#mode === "overview") {
			// Click on a data row: rows start at line (headerChrome + 2) for header + sep
			const overviewHeaderChrome = this.#overviewHeaderLines.length + 2;
			// +2 for table header row + separator row (both at start of content)
			const rowLine = event.localY - 1 - overviewHeaderChrome - 2 + this.#scrollOffset;
			if (rowLine >= 0 && rowLine < this.#overviewRows.length) {
				this.#overviewSelectedIndex = rowLine;
				this.#buildOverviewContent();
				this.#enterDetail();
			}
			return;
		}
		// Detail mode: toggle expand/collapse on clicked entry
		const headerChrome = this.#viewerHeaderLines.length + 2;
		const renderedLineIndex = event.localY - 1 - headerChrome + this.#scrollOffset;
		if (renderedLineIndex < 0) return;
		for (let index = 0; index < this.#viewerEntries.length; index++) {
			const entry = this.#viewerEntries[index];
			if (renderedLineIndex < entry.lineStart || renderedLineIndex >= entry.lineStart + entry.lineCount) continue;
			this.#selectedEntryIndex = index;
			if (this.#expandedEntries.has(index)) {
				this.#expandedEntries.delete(index);
			} else {
				this.#expandedEntries.add(index);
			}
			this.#rebuildAndScroll();
			return;
		}
	}

	#handleViewerInput(keyData: string): void {
		const entryCount = this.#viewerEntries.length;

		// Escape — pop breadcrumb navigation, then return to overview
		if (matchesKey(keyData, "escape")) {
			if (!this.#navigateBack()) {
				this.#returnToOverview();
			}
			return;
		}

		// j / down — move selection down
		if (keyData === "j" || matchesKey(keyData, "down")) {
			if (entryCount > 0) {
				this.#selectedEntryIndex = Math.min(this.#selectedEntryIndex + 1, entryCount - 1);
			}
			this.#rebuildAndScroll();
			return;
		}

		// k / up — move selection up
		if (keyData === "k" || matchesKey(keyData, "up")) {
			if (entryCount > 0) {
				this.#selectedEntryIndex = Math.max(this.#selectedEntryIndex - 1, 0);
			}
			this.#rebuildAndScroll();
			return;
		}

		// Page Down
		if (matchesKey(keyData, "pageDown")) {
			if (entryCount > 0) {
				const prevIndex = this.#selectedEntryIndex;
				this.#selectedEntryIndex = Math.min(this.#selectedEntryIndex + 5, entryCount - 1);
				// If selection didn't move (bottom of list or single oversized entry), fall back to line scroll
				if (this.#selectedEntryIndex === prevIndex) {
					this.#scrollOffset = Math.min(
						this.#scrollOffset + PAGE_SIZE,
						Math.max(0, this.#renderedLines.length - this.#viewportHeight),
					);
				}
			} else {
				this.#scrollOffset = Math.min(
					this.#scrollOffset + PAGE_SIZE,
					Math.max(0, this.#renderedLines.length - this.#viewportHeight),
				);
			}
			this.#rebuildAndScroll();
			return;
		}

		// Page Up
		if (matchesKey(keyData, "pageUp")) {
			if (entryCount > 0) {
				const prevIndex = this.#selectedEntryIndex;
				this.#selectedEntryIndex = Math.max(this.#selectedEntryIndex - 5, 0);
				// If selection didn't move (top of list or single oversized entry), fall back to line scroll
				if (this.#selectedEntryIndex === prevIndex) {
					this.#scrollOffset = Math.max(this.#scrollOffset - PAGE_SIZE, 0);
				}
			} else {
				this.#scrollOffset = Math.max(this.#scrollOffset - PAGE_SIZE, 0);
			}
			this.#rebuildAndScroll();
			return;
		}

		// Enter — toggle expand/collapse, or dive into nested session
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			if (entryCount > 0 && this.#selectedEntryIndex < entryCount) {
				// Toggle expand/collapse
				if (this.#expandedEntries.has(this.#selectedEntryIndex)) {
					this.#expandedEntries.delete(this.#selectedEntryIndex);
				} else {
					this.#expandedEntries.add(this.#selectedEntryIndex);
				}
				this.#rebuildAndScroll();
			}
			return;
		}

		// G — jump to bottom
		if (keyData === "G") {
			if (entryCount > 0) this.#selectedEntryIndex = entryCount - 1;
			this.#scrollOffset = Math.max(0, this.#renderedLines.length - this.#viewportHeight);
			this.#rebuildAndScroll();
			return;
		}

		// g — jump to top
		if (keyData === "g") {
			this.#selectedEntryIndex = 0;
			this.#scrollOffset = 0;
			this.#rebuildAndScroll();
			return;
		}

		// ] / → / Tab — next sub-agent session
		if (keyData === "]" || matchesKey(keyData, "tab") || matchesKey(keyData, "right")) {
			this.#cycleSession(1);
			return;
		}

		// [ / ← / Shift+Tab — previous sub-agent session
		if (keyData === "[" || matchesKey(keyData, "shift+tab") || matchesKey(keyData, "left")) {
			this.#cycleSession(-1);
			return;
		}
	}

	/** Get the ordered list of sub-agent session IDs (excludes main), matching overview order. */
	#getSubagentSessionIds(): string[] {
		return this.#registry.getObserverRows().map(r => r.session.id);
	}

	/** Cycle to next (+1) or previous (-1) sub-agent session */
	#cycleSession(direction: 1 | -1): void {
		const ids = this.#getSubagentSessionIds();
		if (ids.length <= 1) return;
		const currentIdx = ids.indexOf(this.#selectedSessionId ?? "");
		if (currentIdx < 0) return;
		const nextIdx = (currentIdx + direction + ids.length) % ids.length;
		this.#selectedSessionId = ids[nextIdx];
		this.#transcriptCache = undefined;
		this.#scrollOffset = 0;
		this.#selectedEntryIndex = 0;
		this.#expandedEntries.clear();
		this.#wasAtBottom = true;
		this.#rebuildViewerContent();
		// Auto-scroll to bottom: select last entry
		if (this.#viewerEntries.length > 0) {
			this.#selectedEntryIndex = this.#viewerEntries.length - 1;
			this.#wasAtBottom = true;
			this.#rebuildViewerContent();
		}
	}

	/** Rebuild transcript lines (which depend on selectedEntryIndex/expandedEntries) and scroll to selection */
	#rebuildAndScroll(): void {
		// Resume auto-scrolling once selection returns to the last entry
		this.#wasAtBottom = this.#selectedEntryIndex >= this.#viewerEntries.length - 1;
		this.#rebuildViewerContent();
		this.#scrollToSelectedEntry();
	}

	#scrollToSelectedEntry(): void {
		if (this.#viewerEntries.length === 0) return;
		const entry = this.#viewerEntries[this.#selectedEntryIndex];
		if (!entry) return;

		const entryTop = entry.lineStart;
		const entryBottom = entry.lineStart + entry.lineCount;

		if (entry.lineCount >= this.#viewportHeight) {
			// Entry taller than viewport: only snap when it's completely out of view.
			// If the viewport overlaps the entry at all, the user may be paging within it.
			if (this.#scrollOffset + this.#viewportHeight <= entryTop) {
				// Viewport is entirely above the entry — snap to entry top
				this.#scrollOffset = Math.max(0, entryTop - 1);
			} else if (this.#scrollOffset >= entryBottom) {
				// Viewport is entirely below the entry — snap to show entry bottom
				this.#scrollOffset = Math.max(0, entryBottom - this.#viewportHeight);
			}
			// Otherwise: viewport overlaps the entry — don't override manual scroll
		} else {
			// Entry fits in viewport: ensure it's fully visible
			if (entryTop < this.#scrollOffset) {
				this.#scrollOffset = Math.max(0, entryTop - 1);
			}
			if (entryBottom > this.#scrollOffset + this.#viewportHeight) {
				this.#scrollOffset = Math.max(0, entryBottom - this.#viewportHeight + 1);
			}
		}
	}
}

// Sync helpers for render path

function readFileIncremental(filePath: string, fromByte: number): { text: string; newSize: number } | null {
	try {
		const stat = fs.statSync(filePath);
		if (stat.size <= fromByte) return { text: "", newSize: stat.size };
		const buf = Buffer.alloc(stat.size - fromByte);
		const fd = fs.openSync(filePath, "r");
		try {
			fs.readSync(fd, buf, 0, buf.length, fromByte);
		} finally {
			fs.closeSync(fd);
		}
		return { text: buf.toString("utf-8"), newSize: stat.size };
	} catch {
		return null;
	}
}
