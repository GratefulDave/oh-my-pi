import type { Component } from "@oh-my-pi/pi-tui";
import type { AgentSession } from "../../session/agent-session";
import type { AgentProgress } from "../../task";
import { formatDuration, replaceTabs, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { theme } from "../theme/theme";
import { formatContextUsage } from "./status-line/context-thresholds";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FINISHED_LINGER_MS = 4000;
const MAX_LINES = 12;

function formatAgentDisplayName(name: string | undefined): string {
	const trimmed = name?.trim();
	if (!trimmed || trimmed === "task") return "Agent";
	return trimmed
		.split(/[-_]+/)
		.filter(segment => segment.length > 0)
		.map(segment => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
		.join(" ");
}

function clean(value: string | undefined): string {
	return replaceTabs(value ?? "").trim();
}

function firstOutputLine(progress: AgentProgress | undefined): string | undefined {
	return progress?.recentOutput.map(line => clean(line)).find(line => line.length > 0);
}

function toolActivity(tool: string): string {
	switch (tool) {
		case "read":
			return "reading";
		case "bash":
			return "running command";
		case "edit":
			return "editing";
		case "write":
			return "writing";
		case "search":
		case "grep":
			return "searching";
		case "find":
			return "finding files";
		case "lsp":
			return "inspecting symbols";
		default:
			return `${clean(tool)}…`;
	}
}

function activityFor(session: ObservableSession): string {
	const progress = session.progress;
	const tool = progress?.currentTool ?? progress?.recentTools[0]?.tool;
	if (tool) return toolActivity(tool);
	return firstOutputLine(progress) ?? "thinking…";
}

function statsFor(session: ObservableSession, now: number): string {
	const progress = session.progress;
	const stats: string[] = [];
	if (progress && progress.toolCount > 0) stats.push(`${progress.toolCount} tool uses`);
	if (progress?.contextTokens !== undefined && progress.contextWindow !== undefined) {
		stats.push(formatContextUsage((progress.contextTokens / progress.contextWindow) * 100, progress.contextWindow));
	}
	if (progress && progress.cost > 0) stats.push(`$${progress.cost.toFixed(2)}`);
	const durationMs = progress?.durationMs ?? Math.max(0, now - session.lastUpdate);
	stats.push(formatDuration(durationMs));
	return stats.join(theme.sep.dot);
}

function descriptionFor(session: ObservableSession): string {
	return (
		clean(session.description) ||
		clean(session.progress?.description) ||
		clean(session.label) ||
		clean(session.id) ||
		"agent"
	);
}

function statusText(status: ObservableSession["status"]): string {
	switch (status) {
		case "completed":
			return "Done";
		case "failed":
			return "Failed";
		case "aborted":
			return "Aborted";
		case "active":
			return "Active";
	}
}

function statusGlyph(status: ObservableSession["status"]): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "aborted":
			return theme.fg("dim", "■");
		case "active":
			return theme.fg("accent", "●");
	}
}

function renderMoreLine(omitted: number): string {
	return theme.fg("dim", `└─ +${omitted} more`);
}

export class SubagentStatusWidget implements Component {
	constructor(
		private readonly registry: SessionObserverRegistry,
		private readonly session: AgentSession,
	) {}

	hasVisibleRows(): boolean {
		return this.#snapshot(Date.now()).length > 0 || this.#queuedTaskCount() > 0;
	}

	#snapshot(now: number): ObservableSession[] {
		return this.registry
			.getSessions()
			.filter(
				session =>
					session.kind === "subagent" &&
					(session.status === "active" || now - session.lastUpdate <= FINISHED_LINGER_MS),
			)
			.sort((a, b) => a.lastUpdate - b.lastUpdate);
	}

	#queuedTaskCount(): number {
		const running = this.session.getAsyncJobSnapshot()?.running ?? [];
		return running.filter(job => job.type === "task" && job.queued).length;
	}

	render(width: number): readonly string[] {
		const now = Date.now();
		const sessions = this.#snapshot(now);
		const queuedCount = this.#queuedTaskCount();
		const active = sessions.filter(session => session.status === "active");
		const finished = sessions.filter(session => session.status !== "active");
		if (active.length === 0 && finished.length === 0 && queuedCount === 0) return [];

		const headingGlyph = active.length > 0 || queuedCount > 0 ? "●" : "○";
		const headingColor = active.length > 0 || queuedCount > 0 ? "statusLineSubagents" : "dim";
		const lines: string[] = [theme.fg(headingColor, `${headingGlyph} Agents`)];
		const rows: string[][] = [];
		const spinner = SPINNER_FRAMES[Math.floor(now / 80) % SPINNER_FRAMES.length];

		active.forEach((session, index) => {
			const hasFollowing = index < active.length - 1 || queuedCount > 0 || finished.length > 0;
			const connector = hasFollowing ? "├─" : "└─";
			const activityPrefix = hasFollowing ? "│    ⎿  " : "     ⎿  ";
			const agent = formatAgentDisplayName(session.agent ?? session.progress?.agent ?? session.label);
			const description = truncateToWidth(descriptionFor(session), Math.max(8, width - 28));
			const stats = statsFor(session, now);
			const activity = truncateToWidth(activityFor(session), Math.max(8, width - 12));
			rows.push([
				truncateToWidth(
					`${connector} ${spinner} ${theme.fg("accent", agent)}  ${theme.fg("accent", description)}${theme.sep.dot}${theme.fg("dim", stats)}`,
					width,
				),
				truncateToWidth(`${activityPrefix}${theme.fg("dim", activity)}`, width),
			]);
		});

		if (queuedCount > 0) {
			const connector = finished.length > 0 ? "├─" : "└─";
			rows.push([truncateToWidth(`${connector} ${theme.fg("dim", `◦ ${queuedCount} queued`)}`, width)]);
		}

		finished.forEach((session, index) => {
			const connector = index < finished.length - 1 ? "├─" : "└─";
			const agent = formatAgentDisplayName(session.agent ?? session.progress?.agent ?? session.label);
			const description = truncateToWidth(descriptionFor(session), Math.max(8, width - 32));
			const status = statusText(session.status);
			rows.push([
				truncateToWidth(
					`${connector} ${statusGlyph(session.status)} ${theme.fg("dim", agent)}  ${theme.fg("dim", description)}${theme.sep.dot}${theme.fg("dim", status)}`,
					width,
				),
			]);
		});

		const capacity = MAX_LINES - lines.length;
		let used = 0;
		let rowIndex = 0;
		for (; rowIndex < rows.length; rowIndex++) {
			const row = rows[rowIndex];
			if (used + row.length > capacity) break;
			lines.push(...row);
			used += row.length;
		}
		if (rowIndex < rows.length && lines.length < MAX_LINES) {
			const omitted = rows.slice(rowIndex).reduce((sum, row) => sum + row.length, 0);
			lines.push(truncateToWidth(renderMoreLine(omitted), width));
		} else if (lines.length > MAX_LINES) {
			const omitted = lines.length - MAX_LINES + 1;
			lines.splice(MAX_LINES - 1, lines.length, truncateToWidth(renderMoreLine(omitted), width));
		}

		return lines;
	}
}
