// ---------------------------------------------------------------------------
// Observer dashboard — live TUI overlay showing observability data.
// ---------------------------------------------------------------------------

import { matchesKey } from "@oh-my-pi/pi-tui";
import { buildObserverHierarchy, type ObserverHierarchy, type ObserverNode, statusGlyph } from "./hierarchy";
import { stripAnsi, truncateVisible, visibleWidth } from "./renderer";
import { formatDuration, getSessionUptime, getStats, getSubagentTotals, type ObserverStats } from "./stats-collector";

interface ObserverTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	dim(text: string): string;
}

type RequestRender = () => void;
type DoneCallback = () => void;
type TimerHandle = Parameters<typeof clearInterval>[0];

const REFRESH_INTERVAL_MS = 500;
const LEFT_COL_MIN_WIDTH = 16;
const LEFT_COL_MAX_WIDTH = 32;
const DETAIL_MIN_WIDTH = 20;
const MAX_LIST_COLUMNS = 3;
const ROOT_SCOPE = "__root__";
const FOOTER = "↑↓ select · ↵/→ drill · ←/esc back · tab→detail";

type ActivePane = "tree" | "detail";

function isDownKey(key: string): boolean {
	return key === "down" || key === "arrowdown" || key === "j" || key === "ctrl+n";
}

function isUpKey(key: string): boolean {
	return key === "up" || key === "arrowup" || key === "k" || key === "ctrl+p";
}

function isEnterKey(key: string): boolean {
	return key === "enter" || key === "return" || key === "right" || key === "arrowright";
}

function isBackKey(key: string): boolean {
	return key === "escape" || key === "left" || key === "arrowleft" || key === "backspace";
}

function isEscapeInput(data: string): boolean {
	if (data === "escape" || data === "esc" || data === "\x1b") return true;
	// Ghostty/Kitty keyboard protocol may report Escape as CSI 27 variants
	// instead of the legacy single ESC byte.
	return /^\x1b\[(?:27(?:;[0-9]+)*[u~]|27;[0-9;]*27~)$/.test(data);
}

function isArrowInput(data: string, direction: "up" | "down" | "right" | "left"): boolean {
	const finalByte = direction === "up" ? "A" : direction === "down" ? "B" : direction === "right" ? "C" : "D";
	return (
		data === `\x1b[${finalByte}` ||
		data === `\x1bO${finalByte}` ||
		new RegExp(`^\\x1b\\[[0-9;]*${finalByte}$`).test(data)
	);
}

function normalizeInput(data: string): string {
	if (isEscapeInput(data) || matchesKey(data, "escape") || matchesKey(data, "esc")) return "escape";
	if (isArrowInput(data, "up") || matchesKey(data, "up")) return "up";
	if (isArrowInput(data, "down") || matchesKey(data, "down")) return "down";
	if (isArrowInput(data, "right") || matchesKey(data, "right")) return "right";
	if (isArrowInput(data, "left") || matchesKey(data, "left")) return "left";
	if (matchesKey(data, "enter") || matchesKey(data, "return")) return "enter";
	if (matchesKey(data, "tab")) return "tab";
	if (matchesKey(data, "ctrl+n")) return "ctrl+n";
	if (matchesKey(data, "ctrl+p")) return "ctrl+p";
	switch (data) {
		case "\r":
		case "\n":
			return "enter";
		case "\t":
			return "tab";
		case "\x0e":
			return "ctrl+n";
		case "\x10":
			return "ctrl+p";
		default:
			return data;
	}
}

function padLine(text: string, width: number): string {
	const clipped = truncateVisible(text, width);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function wrapPlain(text: string, width: number, maxLines: number): string[] {
	const words = stripAnsi(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		if (line.length === 0) {
			line = word;
			continue;
		}
		if (line.length + word.length + 1 > width) {
			lines.push(line);
			line = word;
			if (lines.length >= maxLines) break;
		} else {
			line += ` ${word}`;
		}
	}
	if (line && lines.length < maxLines) lines.push(line);
	return lines.length > 0 ? lines : [""];
}

function scopeKey(parentId: string | undefined): string {
	return parentId ?? ROOT_SCOPE;
}

function colorForStatus(status: ObserverNode["status"]): string {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
		case "aborted":
			return "error";
		case "running":
		case "active":
			return "accent";
		case "pending":
			return "warning";
		default:
			return "muted";
	}
}

export class ObserverDashboard {
	#refreshHandle: TimerHandle | undefined;
	#lastStats: ObserverStats | undefined;
	#path: string[] = [];
	#cursorByParent = new Map<string, number>();
	#scrollByParent = new Map<string, number>();
	#rightPaneNodeId: string | undefined;
	#expandedDetailId: string | undefined;
	#activePane: ActivePane = "tree";
	#width = 100;
	#height = 36;

	constructor(
		private readonly theme: ObserverTheme,
		readonly requestRender: RequestRender,
		private readonly done: DoneCallback,
	) {
		this.#refreshHandle = setInterval(() => {
			this.#lastStats = getStats() as ObserverStats;
			requestRender();
		}, REFRESH_INTERVAL_MS);
	}

	handleInput(data: string): void {
		this.act(normalizeInput(data));
	}

	invalidate(): void {}

	act(key: string): boolean {
		if (key === "tab") return this.#togglePane();
		if (isBackKey(key)) {
			if (this.#expandedDetailId != null) {
				this.#expandedDetailId = undefined;
				this.#rightPaneNodeId = this.#currentParentId();
				this.#activePane = "tree";
				this.requestRender();
				return true;
			}
			if (this.#path.length > 0) {
				this.#path.pop();
				this.#activePane = "tree";
				this.#rightPaneNodeId = this.#currentParentId();
				this.#expandedDetailId = undefined;
				this.requestRender();
				return true;
			}
			if (key === "escape") {
				this.destroy();
				this.done();
				return true;
			}
			return false;
		}
		if (isEnterKey(key)) return this.#drillOrExpand();
		if (isDownKey(key)) return this.#moveSelection(1);
		if (isUpKey(key)) return this.#moveSelection(-1);
		return false;
	}

	get height(): number {
		const subagentCount = getSubagentTotals().count;
		return subagentCount > 0 ? Math.max(32, Math.min(48, 14 + subagentCount * 3)) : 28;
	}

	layout(width: number, height: number): void {
		this.#width = width;
		this.#height = height;
	}

	render(width: number, height = this.#height): string[] {
		if (width > 0 && height > 0) this.layout(width, height);
		const stats = this.#lastStats ?? (getStats() as ObserverStats);
		const now = Date.now();
		const hierarchy = buildObserverHierarchy(stats, now);
		this.#clampPath(hierarchy);
		const panelWidth = Math.max(60, this.#width - 4);
		const panelHeight = Math.max(12, this.#height - 7);
		const agents = [...stats.subagents.values()];
		const completed = agents.filter(agent => agent.status === "completed").length;
		const lines = [this.theme.fg("border", "─".repeat(panelWidth))];
		lines.push(this.theme.bold(this.theme.fg("accent", "session-observability")));
		lines.push(
			this.theme.dim(
				`${"Real-time agents, tasks, intercom, and metrics".padEnd(Math.max(0, panelWidth - 24))}${completed}/${agents.length} agents · ${formatDuration(getSessionUptime())}`,
			),
		);
		lines.push("");
		lines.push(...this.#renderPanel(hierarchy, panelWidth, panelHeight));
		lines.push(this.theme.dim(FOOTER));
		return lines.slice(0, this.#height);
	}

	destroy(): void {
		if (this.#refreshHandle != null) {
			clearInterval(this.#refreshHandle);
			this.#refreshHandle = undefined;
		}
	}

	#computeColumnLayout(width: number): {
		columns: Array<{ pathIndex: number; parentId: string | undefined; width: number }>;
		detailWidth: number;
	} {
		// At path depth N there are N+1 list columns (root + each drilled level).
		// Cap at MAX_LIST_COLUMNS; oldest columns scroll off to the left.
		const pathLen = this.#path.length;
		const totalLevels = pathLen + 1;
		const visibleLevels = Math.min(totalLevels, MAX_LIST_COLUMNS);

		// Column widths: proportional, clamped to min/max.
		// Borders: 1 left │ + (visibleLevels - 1) internal │ + 1 detail separator │ + 1 right │ = visibleLevels + 2 total.
		const colFractions: number[] =
			visibleLevels === 1 ? [0.3] : visibleLevels === 2 ? [0.25, 0.25] : [0.22, 0.22, 0.22];
		const totalBorders = visibleLevels + 2;
		const colWidths = colFractions.map(f =>
			Math.min(LEFT_COL_MAX_WIDTH, Math.max(LEFT_COL_MIN_WIDTH, Math.floor(width * f))),
		);
		const usedByCols = colWidths.reduce((s, w) => s + w, 0);
		const detailWidth = Math.max(DETAIL_MIN_WIDTH, width - usedByCols - totalBorders);

		// Show the last visibleLevels levels. hiddenLevels scroll off to the left.
		const hiddenLevels = totalLevels - visibleLevels;
		const columns = colWidths.map((w, i) => {
			const levelIndex = hiddenLevels + i;
			// Level 0 → root children (parentId = undefined); level k → children of path[k-1].
			const parentId: string | undefined = levelIndex === 0 ? undefined : this.#path[levelIndex - 1];
			return { pathIndex: levelIndex, parentId, width: w };
		});
		return { columns, detailWidth };
	}

	#renderPanel(hierarchy: ObserverHierarchy, width: number, height: number): string[] {
		const { columns, detailWidth } = this.#computeColumnLayout(width);
		const bodyHeight = Math.max(1, height - 2);
		// Active column is always the rightmost list column.
		const activeColParentId = columns.at(-1)?.parentId;
		const selected = this.#selectedNode(hierarchy);
		const activeChildren = hierarchy.getChildren(activeColParentId);
		const title = this.#panelTitle(hierarchy, selected, activeChildren.length, width);
		const top = this.theme.fg("border", `┌${title}${"─".repeat(Math.max(0, width - visibleWidth(title) - 2))}┐`);

		// Render each list column.
		const renderedCols = columns.map(col => {
			const colChildren = hierarchy.getChildren(col.parentId);
			// For non-active columns, highlight the child that is selected (the path entry drilled into).
			// The selected item in a non-active column is the node at path[levelIndex] (the one we drilled into).
			const colSelected: ObserverNode | undefined =
				col.pathIndex < this.#path.length ? hierarchy.getNode(this.#path[col.pathIndex]) : selected; // active column uses the real cursor selection
			return this.#renderScopeList(
				colChildren,
				colSelected,
				col.width,
				bodyHeight,
				col.parentId,
				col.pathIndex >= this.#path.length,
			);
		});

		const rightNode = this.#rightPaneNode(hierarchy, selected);
		const rightLines = rightNode
			? this.#renderNodeDetail(rightNode, detailWidth, bodyHeight)
			: [this.theme.dim("No hierarchy nodes observed yet")];

		const bdr = this.theme.fg("border", "│");
		const lines = [top];
		for (let i = 0; i < bodyHeight; i++) {
			let row = bdr;
			for (let c = 0; c < columns.length; c++) {
				row += padLine(renderedCols[c]![i] ?? "", columns[c]!.width) + bdr;
			}
			row += padLine(rightLines[i] ?? "", detailWidth) + bdr;
			lines.push(row);
		}
		// Bottom border: each col segment + detail segment joined by ┴.
		const segments = [...columns.map(col => "─".repeat(col.width)), "─".repeat(detailWidth)];
		lines.push(this.theme.fg("border", `└${segments.join("┴")}┘`));
		return lines;
	}

	#renderScopeList(
		children: readonly ObserverNode[],
		selected: ObserverNode | undefined,
		width: number,
		height: number,
		parentId: string | undefined,
		isActive = true,
	): string[] {
		const key = scopeKey(parentId);
		const cursor = this.#cursorByParent.get(key) ?? 0;
		const scroll = this.#scrollByParent.get(key) ?? 0;
		const maxScroll = Math.max(0, children.length - height);
		const first = Math.max(0, Math.min(maxScroll, scroll));
		if (first !== scroll) this.#scrollByParent.set(key, first);
		const visible = children.slice(first, first + height);
		const lines = visible.map((node, offset) => {
			const index = first + offset;
			const marker = selected?.id === node.id || index === cursor ? "❯" : " ";
			const childHint = node.children.length > 0 ? "›" : " ";
			// Show ▌ only in the active (rightmost) column when in tree pane mode.
			const paneMark = isActive && this.#activePane === "tree" && marker === "❯" ? "▌" : " ";
			const label = `${paneMark}${marker} ${statusGlyph(node.status)} ${node.label} ${childHint}`;
			const color = marker === "❯" ? "borderAccent" : colorForStatus(node.status);
			return truncateVisible(this.theme.fg(color, label), width);
		});
		if (first > 0 && lines.length > 0)
			lines[0] = truncateVisible(this.theme.fg("borderAccent", `↑ ${stripAnsi(lines[0]).slice(2)}`), width);
		if (first + height < children.length && lines.length > 0) {
			const last = lines.length - 1;
			lines[last] = truncateVisible(this.theme.fg("borderAccent", `↓ ${stripAnsi(lines[last]!).slice(2)}`), width);
		}
		return lines;
	}

	#renderNodeDetail(node: ObserverNode, width: number, height: number): string[] {
		const expanded = this.#expandedDetailId === node.id;
		const lines: string[] = [];
		const panePrefix = this.#activePane === "detail" ? "▌" : " ";
		lines.push(
			this.theme.fg(
				colorForStatus(node.status),
				`${panePrefix}${statusGlyph(node.status)} ${node.kind.toUpperCase()} · ${node.label}`,
			),
		);
		lines.push(this.theme.fg("toolOutput", node.summary));
		if (node.children.length > 0) lines.push(this.theme.dim(`${node.children.length} children · ↵ drill`));
		else lines.push(this.theme.dim(expanded ? "Expanded · ↵ collapse" : "Leaf · ↵ expand"));
		if (node.metrics) {
			const metricParts: string[] = [];
			if (node.metrics.tokens != null) metricParts.push(`${node.metrics.tokens.toLocaleString("en-US")} tok`);
			if (node.metrics.toolCount != null) metricParts.push(`${node.metrics.toolCount} tools`);
			if (node.metrics.durationMs != null) metricParts.push(formatDuration(node.metrics.durationMs));
			if (node.metrics.cost != null) metricParts.push(`$${node.metrics.cost.toFixed(4)}`);
			if (metricParts.length > 0) lines.push(this.theme.fg("muted", metricParts.join(" · ")));
		}
		lines.push("");
		const detailLines = node.detail ?? [node.summary];
		for (const detail of detailLines) {
			for (const wrapped of wrapPlain(detail, width - 2, expanded ? height * 3 : 3)) {
				lines.push(this.theme.fg(detail.startsWith("  ") ? "toolOutput" : "text", wrapped));
			}
			if (!expanded && lines.length >= height - 2) break;
		}
		return lines.slice(0, height);
	}

	#panelTitle(
		hierarchy: ObserverHierarchy,
		selected: ObserverNode | undefined,
		siblingCount: number,
		width: number,
	): string {
		const breadcrumb = hierarchy.getBreadcrumb(this.#path);
		const scope = breadcrumb.length > 0 ? breadcrumb.map(node => node.label).join(" · ") : "Observability";
		const selectedPart = selected ? ` ┬ ${selected.label}` : "";
		const panePart = this.#activePane === "detail" ? " [detail]" : " [tree]";
		return truncateVisible(
			` ${scope} · ${siblingCount} ${siblingCount === 1 ? "node" : "nodes"}${selectedPart}${panePart} `,
			width - 2,
		);
	}

	#drillOrExpand(): boolean {
		const stats = this.#lastStats ?? (getStats() as ObserverStats);
		const hierarchy = buildObserverHierarchy(stats, Date.now());
		this.#clampPath(hierarchy);
		const selected = this.#selectedNode(hierarchy);
		if (!selected) return false;
		if (selected.children.length > 0) {
			this.#path.push(selected.id);
			this.#rightPaneNodeId = selected.id;
			this.#expandedDetailId = undefined;
			this.#activePane = "tree";
			this.#clampPath(hierarchy);
		} else {
			this.#expandedDetailId = this.#expandedDetailId === selected.id ? undefined : selected.id;
			this.#rightPaneNodeId = this.#expandedDetailId;
			this.#activePane = "detail";
		}
		this.requestRender();
		return true;
	}

	#moveSelection(delta: number): boolean {
		const stats = this.#lastStats ?? (getStats() as ObserverStats);
		const hierarchy = buildObserverHierarchy(stats, Date.now());
		this.#clampPath(hierarchy);
		const parentId = this.#currentParentId();
		const children = hierarchy.getChildren(parentId);
		if (children.length === 0) return false;
		const key = scopeKey(parentId);
		const current = this.#cursorByParent.get(key) ?? 0;
		const next = Math.max(0, Math.min(children.length - 1, current + delta));
		this.#cursorByParent.set(key, next);
		this.#ensureCursorVisible(key, next, Math.max(1, this.#height - 9), children.length);
		this.requestRender();
		return true;
	}

	#togglePane(): boolean {
		const stats = this.#lastStats ?? (getStats() as ObserverStats);
		const hierarchy = buildObserverHierarchy(stats, Date.now());
		if (!this.#selectedNode(hierarchy)) return false;
		this.#activePane = this.#activePane === "tree" ? "detail" : "tree";
		this.requestRender();
		return true;
	}

	#rightPaneNode(hierarchy: ObserverHierarchy, selected: ObserverNode | undefined): ObserverNode | undefined {
		const explicit = hierarchy.getNode(this.#rightPaneNodeId);
		if (explicit) return explicit;
		return selected;
	}

	#clampPath(hierarchy: ObserverHierarchy): void {
		while (this.#path.length > 0 && !hierarchy.getNode(this.#path.at(-1))) this.#path.pop();
		const parentId = this.#currentParentId();
		const children = hierarchy.getChildren(parentId);
		const key = scopeKey(parentId);
		const cursor = this.#cursorByParent.get(key) ?? 0;
		this.#cursorByParent.set(key, Math.max(0, Math.min(Math.max(0, children.length - 1), cursor)));
		this.#ensureCursorVisible(
			key,
			this.#cursorByParent.get(key) ?? 0,
			Math.max(1, this.#height - 9),
			children.length,
		);
	}

	#ensureCursorVisible(key: string, cursor: number, height: number, total: number): void {
		const currentScroll = this.#scrollByParent.get(key) ?? 0;
		let nextScroll = currentScroll;
		if (cursor < currentScroll) nextScroll = cursor;
		else if (cursor >= currentScroll + height) nextScroll = cursor - height + 1;
		this.#scrollByParent.set(key, Math.max(0, Math.min(Math.max(0, total - height), nextScroll)));
	}

	#selectedNode(hierarchy: ObserverHierarchy): ObserverNode | undefined {
		const parentId = this.#currentParentId();
		const children = hierarchy.getChildren(parentId);
		const cursor = this.#cursorByParent.get(scopeKey(parentId)) ?? 0;
		return children[Math.max(0, Math.min(Math.max(0, children.length - 1), cursor))];
	}

	#currentParentId(): string | undefined {
		return this.#path.at(-1);
	}
}
