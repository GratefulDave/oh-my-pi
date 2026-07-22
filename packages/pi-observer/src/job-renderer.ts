import { Text } from "@oh-my-pi/pi-tui";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const COLLAPSED_LIMIT = 6;
const PREVIEW_WIDTH = 88;
const LABEL_WIDTH = 64;

type JobStatus = "running" | "completed" | "failed" | "cancelled";

type ThemeColor = "dim" | "error" | "muted" | "toolOutput";

export interface ThemeLike {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
}

export interface RenderOptions {
	expanded: boolean;
	spinnerFrame?: number;
}

interface JobSnapshot {
	id: string;
	type: string;
	status: JobStatus;
	label: string;
	durationMs: number;
	resultText?: string;
	errorText?: string;
}

interface JobDetails {
	jobs?: JobSnapshot[];
}

export interface ToolResult {
	content?: Array<{ type: string; text?: string }>;
	details?: JobDetails;
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

function truncate(value: string, width: number): string {
	const clean = stripAnsi(value).replace(/\t/g, "  ");
	if (clean.length <= width) return clean;
	return `${clean.slice(0, Math.max(0, width - 1))}…`;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

function statusRank(status: JobStatus): number {
	switch (status) {
		case "running":
			return 0;
		case "failed":
			return 1;
		case "cancelled":
			return 2;
		case "completed":
			return 3;
	}
}

function statusIcon(job: JobSnapshot, options: RenderOptions): string {
	if (job.status === "running") return SPINNER_FRAMES[(options.spinnerFrame ?? 0) % SPINNER_FRAMES.length];
	if (job.status === "completed") return "✓";
	if (job.status === "failed") return "✗";
	return "■";
}

function sortedJobs(jobs: JobSnapshot[]): JobSnapshot[] {
	return [...jobs].sort((a, b) => {
		const byStatus = statusRank(a.status) - statusRank(b.status);
		if (byStatus !== 0) return byStatus;
		return b.durationMs - a.durationMs;
	});
}

function safeFg(theme: ThemeLike, color: ThemeColor, text: string): string {
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

function safeBold(theme: ThemeLike, text: string): string {
	try {
		return theme.bold(text);
	} catch {
		return text;
	}
}

function jobTitle(job: JobSnapshot, theme: ThemeLike): string {
	const rawLabel = job.label.split(/\r?\n/)[0]?.trim() ?? "";
	const label = truncate(rawLabel, LABEL_WIDTH);
	if (!label || label === job.id) return safeBold(theme, job.id);
	return `${safeBold(theme, job.id)} ${safeFg(theme, "toolOutput", label)}`;
}

function previewLines(job: JobSnapshot, expanded: boolean): string[] {
	const preview = (job.errorText ?? job.resultText ?? "").trim();
	if (!preview) return [];
	const maxLines = expanded ? 4 : 1;
	return preview
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean)
		.slice(0, maxLines)
		.map(line => truncate(line, PREVIEW_WIDTH));
}

function renderJobLines(jobs: JobSnapshot[], options: RenderOptions, theme: ThemeLike): string[] {
	const ordered = sortedJobs(jobs);
	const visible = options.expanded ? ordered : ordered.slice(0, COLLAPSED_LIMIT);
	const remaining = ordered.length - visible.length;
	const lines: string[] = [];
	for (let index = 0; index < visible.length; index++) {
		const job = visible[index]!;
		const isLast = remaining === 0 && index === visible.length - 1;
		const branch = isLast ? "└" : "├";
		const childPrefix = isLast ? "  └" : "│ └";
		lines.push(
			`${safeFg(theme, "dim", branch)} ${statusIcon(job, options)} ${jobTitle(job, theme)} · ${safeFg(theme, "dim", formatDuration(job.durationMs))}`,
		);
		if (job.status === "running") {
			lines.push(
				`${safeFg(theme, "dim", childPrefix)} ${safeFg(theme, "dim", `running background detail · ${job.id}`)}`,
			);
		}
		for (const line of previewLines(job, options.expanded)) {
			lines.push(`${safeFg(theme, "dim", childPrefix)} ${safeFg(theme, job.errorText ? "error" : "dim", line)}`);
		}
		if (job.status === "running" && previewLines(job, options.expanded).length === 0) {
			lines.push(`${safeFg(theme, "dim", childPrefix)} ${safeFg(theme, "dim", "thinking…")}`);
		}
	}
	if (remaining > 0) lines.push(`${safeFg(theme, "dim", "└")} ${safeFg(theme, "muted", `○ ${remaining} queued`)}`);
	return lines;
}

export function renderJobResult(result: ToolResult, options: RenderOptions, theme: ThemeLike): Text {
	const jobs = result.details?.jobs ?? [];
	if (jobs.length === 0) {
		const fallback = result.content?.find(item => item.type === "text")?.text ?? "No jobs to process";
		return new Text(truncate(fallback, PREVIEW_WIDTH), 0, 0);
	}
	const hasRunning = jobs.some(job => job.status === "running");
	const lines = [
		...(hasRunning ? [`${SPINNER_FRAMES[(options.spinnerFrame ?? 0) % SPINNER_FRAMES.length]} Working...`] : []),
		"● Phase",
		"├ Agents",
		"└ Tasks",
		...renderJobLines(jobs, options, theme).map(line => `  ${line}`),
	];
	return new Text(lines.join("\n"), 0, 0);
}
