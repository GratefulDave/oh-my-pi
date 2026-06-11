import { type Component, matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";
import type { ExternalAgentBackend, ExternalAgentEvent, ExternalAgentProvider, ExternalAgentRequest } from "./types";

interface EventEntry {
	event: ExternalAgentEvent;
	provider: ExternalAgentProvider;
}

interface ProviderGroup {
	provider: ExternalAgentProvider;
	events: EventEntry[];
}

const PROVIDER_LABEL: Record<ExternalAgentProvider, string> = {
	claude: "Claude",
	codex: "Codex",
	gemini: "Gemini",
};

const BACKEND_LABEL: Record<ExternalAgentBackend, string> = {
	acpx: "acpx",
	tmux: "tmux",
	cmux: "cmux",
};

function eventPrefix(type: ExternalAgentEvent["type"]): string {
	switch (type) {
		case "status":
			return "●";
		case "error":
			return "✗";
		case "tool_start":
			return "▶";
		case "tool_end":
			return "◀";
		case "terminal":
			return "▸";
		default:
			return " ";
	}
}

function formatEventLine(event: ExternalAgentEvent, width: number): string {
	const prefix = eventPrefix(event.type);
	const indent = "  ";

	switch (event.type) {
		case "status":
			return `${indent}${prefix} ${truncateToWidth(event.message, width)}`;
		case "text": {
			const text = event.text
				.split("\n")
				.map(line => line.trimEnd())
				.filter(line => line.length > 0)
				.join(" ");
			return `${indent}${truncateToWidth(text, width)}`;
		}
		case "error":
			return `${indent}${prefix} ${truncateToWidth(event.message, width)}`;
		case "tool_start": {
			const name = event.toolName ?? "unknown";
			return `${indent}${prefix} ${truncateToWidth(name, width)}`;
		}
		case "tool_end": {
			const name = event.toolName ?? "unknown";
			return `${indent}${prefix} ${truncateToWidth(name, width)}`;
		}
		case "terminal": {
			return `${indent}${prefix} ${truncateToWidth(event.lines, width)}`;
		}
		case "json":
			return `${indent}{json}`;
		default:
			return `${indent}?`;
	}
}

export class DelegateMonitorComponent implements Component {
	readonly #backendLabel: string;
	readonly #agentLabels: string;
	readonly #providers: ProviderGroup[];
	readonly #providerIndex: Map<ExternalAgentProvider, ProviderGroup> = new Map();
	readonly #getRows: () => number;
	#scrollOffset = 0;
	#followTail = true;
	#done = false;
	#successCount = 0;
	#totalAgents = 0;
	#artifactId?: string;
	#reusedCount = 0;
	#onClose?: () => void;
	#requestRender: () => void;

	constructor(
		backend: ExternalAgentBackend,
		providers: ExternalAgentProvider[],
		getRows: () => number,
		requestRender: () => void,
		onClose?: () => void,
	) {
		this.#backendLabel = BACKEND_LABEL[backend];
		this.#agentLabels = providers.map(p => PROVIDER_LABEL[p]).join(", ");
		this.#providers = providers.map(p => {
			const group: ProviderGroup = { provider: p, events: [] };
			this.#providerIndex.set(p, group);
			return group;
		});
		this.#totalAgents = providers.length;
		this.#getRows = getRows;
		this.#requestRender = requestRender;
		this.#onClose = onClose;
	}

	append(event: ExternalAgentEvent, _index: number, request: ExternalAgentRequest): void {
		const group = this.#providerIndex.get(request.provider);
		if (!group) return;
		group.events.push({ event, provider: request.provider });
		if (this.#followTail) {
			this.#scrollOffset = Number.MAX_SAFE_INTEGER;
		}
		this.#requestRender();
	}

	complete(successCount: number, artifactId?: string, reusedCount = 0): void {
		this.#done = true;
		this.#successCount = successCount;
		this.#artifactId = artifactId;
		this.#reusedCount = reusedCount;
		this.#requestRender();
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.#done && (matchesKey(data, "escape") || data === "q" || data === "Q")) {
			this.#onClose?.();
			return;
		}

		this.#normalizeScroll();

		if (matchesKey(data, "up") || data === "k") {
			this.#followTail = false;
			this.#scrollOffset = Math.max(0, this.#scrollOffset - 1);
			this.#requestRender();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.#scrollOffset += 1;
			this.#requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.#followTail = false;
			this.#scrollOffset = Math.max(0, this.#scrollOffset - 10);
			this.#requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.#scrollOffset += 10;
			this.#requestRender();
			return;
		}
		if (matchesKey(data, "home")) {
			this.#followTail = false;
			this.#scrollOffset = 0;
			this.#requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.#followTail = true;
			this.#scrollOffset = Number.MAX_SAFE_INTEGER;
			this.#requestRender();
			return;
		}
	}

	#normalizeScroll(): void {
		const rows = this.#getRows();
		const headerLines = 1;
		const footerLines = this.#done ? 2 : 0;
		const available = Math.max(3, rows - headerLines - footerLines);

		let eventLineCount = 0;
		for (const group of this.#providers) {
			eventLineCount += 1; // group header
			eventLineCount += group.events.length === 0 ? 1 : group.events.length;
		}

		const maxScroll = Math.max(0, eventLineCount - available);
		if (this.#followTail || this.#scrollOffset > maxScroll) {
			this.#scrollOffset = maxScroll;
		}
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScroll));
	}

	render(width: number): string[] {
		const contentWidth = Math.max(20, width - 2);
		const rows = this.#getRows();
		const headerLines = 1;
		const footerLines = this.#done ? 2 : 0;
		const available = Math.max(3, rows - headerLines - footerLines);

		const lines: string[] = [];

		// Header
		const status = this.#done ? "done" : "running";
		const header = ` delegate  ${this.#backendLabel}  ${this.#agentLabels}  ${status}`;
		lines.push(truncateToWidth(header, width));

		// Build all event lines
		const eventLines: string[] = [];
		for (const group of this.#providers) {
			const label = PROVIDER_LABEL[group.provider];
			eventLines.push(`── ${label} ──`);
			if (group.events.length === 0) {
				eventLines.push("  (no events yet)");
			} else {
				for (const entry of group.events) {
					eventLines.push(formatEventLine(entry.event, contentWidth));
				}
			}
		}

		const maxScroll = Math.max(0, eventLines.length - available);
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScroll));

		const visible = eventLines.slice(this.#scrollOffset, this.#scrollOffset + available);
		for (const line of visible) {
			lines.push(truncateToWidth(line, width));
		}

		const paddingLines = available - visible.length;
		for (let i = 0; i < paddingLines; i++) {
			lines.push("");
		}

		if (this.#done) {
			const parts = [` ${this.#successCount}/${this.#totalAgents} succeeded`];
			if (this.#reusedCount > 0) parts.push(`${this.#reusedCount} reused exact same-session result(s)`);
			if (this.#artifactId) parts.push(`artifact: ${this.#artifactId}`);
			parts.push("Esc/q to close");
			lines.push(truncateToWidth(parts.join("  "), width));
			lines.push("");
		}

		return lines;
	}
}
