// ---------------------------------------------------------------------------
// Observer dashboard — live TUI overlay showing diagnostic agent activity.
// ---------------------------------------------------------------------------

import { buildObserverHierarchy, type ObserverHierarchy, type ObserverNode, statusGlyph } from "./hierarchy";
import { stripAnsi, truncateVisible } from "./renderer";
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
const LEFT_MIN_WIDTH = 20;
const LEFT_MAX_WIDTH = 38;
const ROOT_SCOPE = "__root__";
const FOOTER = "↑↓ select · ↵ drill/expand · ←/esc back";

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

function padPlain(text: string, width: number): string {
	const clean = stripAnsi(text);
	const clipped = truncateVisible(clean, width);
	return clipped + " ".repeat(Math.max(0, width - stripAnsi(clipped).length));
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

export class ObserverDashboard {
	#refreshHandle: TimerHandle | undefined;
	#lastStats: ObserverStats | undefined;
	#path: string[] = [];
	#cursorByParent = new Map<string, number>();
	#scrollByParent = new Map<string, number>();
	#expandedDetailId: string | undefined;
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

	act(key: string): boolean {
		if (isBackKey(key)) {
			if (this.#path.length > 0) {
				this.#path.pop();
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

	render(width: number, height: number): string[] {
		if (width > 0 && height > 0) this.layout(width, height);
		const stats = this.#lastStats ?? (getStats() as ObserverStats);
		const now = Date.now();
		const hierarchy = buildObserverHierarchy(stats, now);
		this.#clampPath(hierarchy);
		const panelWidth = Math.max(60, this.#width - 4);
		const panelHeight = Math.max(12, this.#height - 7);
		const agents = [...stats.subagents.values()];
		const completed = agents.filter(agent => agent.status === "completed").length;
		const lines = ["─".repeat(panelWidth)];
		lines.push(this.theme.bold(this.theme.fg("cyan", "parity-distribution-diagnosis")));
		lines.push(
			this.theme.dim(
				`${`Diagnose agent activity by cluster: root cause + lever + expected movement`.padEnd(
					Math.max(0, panelWidth - 24),
				)}${completed}/${agents.length} agents · ${formatDuration(getSessionUptime())}`,
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

	#renderPanel(hierarchy: ObserverHierarchy, width: number, height: number): string[] {
		const leftWidth = Math.min(LEFT_MAX_WIDTH, Math.max(LEFT_MIN_WIDTH, Math.floor(width * 0.26)));
		const rightWidth = width - leftWidth - 3;
		const bodyHeight = Math.max(1, height - 2);
		const parentId = this.#currentParentId();
		const children = hierarchy.getChildren(parentId);
		const selected = this.#selectedNode(hierarchy);
		const title = this.#panelTitle(hierarchy, selected, children.length, width);
		const top = `┌${title}${"─".repeat(Math.max(0, width - title.length - 2))}┐`;
		const left = this.#renderScopeList(children, selected, leftWidth, bodyHeight, parentId);
		const right = selected
			? this.#renderNodeDetail(selected, rightWidth, bodyHeight)
			: [this.theme.dim("No hierarchy nodes observed yet")];
		const lines = [top];
		for (let i = 0; i < bodyHeight; i++) {
			lines.push(`│${padPlain(left[i] ?? "", leftWidth)}│${padPlain(right[i] ?? "", rightWidth)}│`);
		}
		lines.push(`└${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┘`);
		return lines;
	}

	#renderScopeList(
		children: readonly ObserverNode[],
		selected: ObserverNode | undefined,
		width: number,
		height: number,
		parentId: string | undefined,
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
			return truncateVisible(`${marker} ${statusGlyph(node.status)} ${node.label} ${childHint}`, width);
		});
		if (first > 0 && lines.length > 0) lines[0] = truncateVisible(`↑ ${lines[0].slice(2)}`, width);
		if (first + height < children.length && lines.length > 0) {
			const last = lines.length - 1;
			lines[last] = truncateVisible(`↓ ${lines[last]!.slice(2)}`, width);
		}
		return lines;
	}

	#renderNodeDetail(node: ObserverNode, width: number, height: number): string[] {
		const expanded = this.#expandedDetailId === node.id;
		const lines: string[] = [];
		lines.push(`${statusGlyph(node.status)} ${node.kind.toUpperCase()} · ${node.label}`);
		lines.push(node.summary);
		if (node.children.length > 0) lines.push(`${node.children.length} children · ↵ drill`);
		else lines.push(expanded ? "Expanded · ↵ collapse" : "Leaf · ↵ expand");
		if (node.metrics) {
			const metricParts: string[] = [];
			if (node.metrics.tokens != null) metricParts.push(`${node.metrics.tokens.toLocaleString("en-US")} tok`);
			if (node.metrics.toolCount != null) metricParts.push(`${node.metrics.toolCount} tools`);
			if (node.metrics.durationMs != null) metricParts.push(formatDuration(node.metrics.durationMs));
			if (node.metrics.cost != null) metricParts.push(`$${node.metrics.cost.toFixed(4)}`);
			if (metricParts.length > 0) lines.push(metricParts.join(" · "));
		}
		lines.push("");
		const detailLines = node.detail ?? [node.summary];
		for (const detail of detailLines) {
			for (const wrapped of wrapPlain(detail, width - 2, expanded ? height : 3)) lines.push(wrapped);
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
		const scope = breadcrumb.length > 0 ? breadcrumb.map(node => node.label).join(" · ") : "Diagnose";
		const selectedPart = selected ? ` ┬ ${selected.label}` : "";
		return truncateVisible(
			` ${scope} · ${siblingCount} ${siblingCount === 1 ? "node" : "nodes"}${selectedPart} `,
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
			this.#clampPath(hierarchy);
		} else {
			this.#expandedDetailId = this.#expandedDetailId === selected.id ? undefined : selected.id;
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
