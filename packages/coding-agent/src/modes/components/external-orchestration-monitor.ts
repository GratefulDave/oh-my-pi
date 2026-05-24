import { type Component, matchesKey, replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import type {
	ExternalAgentBackend,
	ExternalAgentEvent,
	ExternalAgentProvider,
	ExternalAgentRequest,
} from "../../external-agents/types";
import type { Theme, ThemeColor } from "../theme/theme";

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

function eventColor(type: ExternalAgentEvent["type"]): ThemeColor {
	switch (type) {
		case "status":
			return "muted";
		case "error":
			return "error";
		case "tool_start":
			return "accent";
		case "tool_end":
			return "accent";
		case "terminal":
			return "warning";
		default:
			return "muted";
	}
}

function formatEventLine(event: ExternalAgentEvent, theme: Theme, width: number): string {
	const prefix = eventPrefix(event.type);
	const color = eventColor(event.type);
	const indent = "  ";

	switch (event.type) {
		case "status":
			return `${indent}${theme.fg(color, prefix)} ${theme.fg("dim", truncateToWidth(replaceTabs(event.message), width))}`;
		case "text": {
			const text = replaceTabs(event.text)
				.split("\n")
				.map(line => line.trimEnd())
				.filter(line => line.length > 0)
				.join(" ");
			return `${indent}${truncateToWidth(text, width)}`;
		}
		case "error":
			return `${indent}${theme.fg(color, prefix)} ${theme.fg("error", truncateToWidth(replaceTabs(event.message), width))}`;
		case "tool_start": {
			const name = event.name ?? "unknown";
			return `${indent}${theme.fg(color, prefix)} ${theme.fg("accent", truncateToWidth(name, width))}`;
		}
		case "tool_end": {
			const name = event.name ?? "unknown";
			return `${indent}${theme.fg(color, prefix)} ${theme.fg("dim", truncateToWidth(name, width))}`;
		}
		case "terminal": {
			const cmd = event.command.join(" ");
			return `${indent}${theme.fg(color, prefix)} ${truncateToWidth(replaceTabs(cmd), width)}`;
		}
		case "json":
			return `${indent}${theme.fg("dim", "{json}")}`;
		default:
			return `${indent}${theme.fg("dim", "?")}`;
	}
}

export class ExternalOrchestrationMonitorComponent implements Component {
	readonly #theme: Theme;
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
	#onClose?: () => void;
	#requestRender: () => void;

	constructor(
		theme: Theme,
		backend: ExternalAgentBackend,
		providers: ExternalAgentProvider[],
		getRows: () => number,
		requestRender: () => void,
		onClose?: () => void,
	) {
		this.#theme = theme;
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
		// Auto-scroll to bottom if user hasn't scrolled up
		if (this.#followTail) {
			this.#scrollOffset = Number.MAX_SAFE_INTEGER;
		}
		this.#requestRender();
	}

	complete(successCount: number, artifactId?: string): void {
		this.#done = true;
		this.#successCount = successCount;
		this.#artifactId = artifactId;
		this.#requestRender();
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.#done && (matchesKey(data, "escape") || data === "q" || data === "Q")) {
			this.#onClose?.();
			return;
		}

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

	render(width: number): string[] {
		const contentWidth = Math.max(20, width - 2);
		const rows = this.#getRows();
		const headerLines = 1;
		const footerLines = this.#done ? 2 : 0;
		const available = Math.max(3, rows - headerLines - footerLines);

		const lines: string[] = [];

		// Header
		const status = this.#done
			? this.#theme.fg("success", "done")
			: this.#theme.fg("accent", this.#theme.bold("running"));
		const header = `${this.#theme.fg("accent", this.#theme.bold(" delegate "))}${this.#theme.fg("muted", ` ${this.#backendLabel}  ${this.#agentLabels} `)}${status}`;
		lines.push(truncateToWidth(header, width));

		// Build all event lines
		const eventLines: string[] = [];
		for (const group of this.#providers) {
			const label = PROVIDER_LABEL[group.provider];
			eventLines.push(this.#theme.fg("accent", this.#theme.bold(`── ${label} ──`)));
			if (group.events.length === 0) {
				eventLines.push(this.#theme.fg("dim", "  (no events yet)"));
			} else {
				for (const entry of group.events) {
					eventLines.push(formatEventLine(entry.event, this.#theme, contentWidth));
				}
			}
		}

		// Clamp scroll offset
		const maxScroll = Math.max(0, eventLines.length - available);
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScroll));

		const visible = eventLines.slice(this.#scrollOffset, this.#scrollOffset + available);
		for (const line of visible) {
			lines.push(truncateToWidth(line, width));
		}

		// Pad to full height
		const paddingLines = available - visible.length;
		for (let i = 0; i < paddingLines; i++) {
			lines.push("");
		}

		// Footer
		if (this.#done) {
			const statusParts = [` ${this.#successCount}/${this.#totalAgents} succeeded`];
			if (this.#artifactId) {
				statusParts.push(`artifact: ${this.#artifactId}`);
			}
			statusParts.push("Esc/q to close");
			lines.push(truncateToWidth(this.#theme.fg("dim", statusParts.join("  ")), width));
			lines.push("");
		}

		return lines;
	}
}
