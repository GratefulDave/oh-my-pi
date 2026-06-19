import type { SymbolKey, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import { formatDuration, truncate } from "./format";
import type { AgentState, SwarmState } from "./state";

// Plain-text icons (fallback when no theme / non-nerd preset)
const STATUS_LABELS: Record<string, string> = {
	completed: "[done]",
	running: "[....]",
	failed: "[FAIL]",
	pending: "[    ]",
	waiting: "[wait]",
	idle: "[idle]",
	aborted: "[stop]",
};

// Nerd-font icons paired with theme colors per status
const STATUS_NERD: Record<string, { symbol: SymbolKey; color: ThemeColor }> = {
	completed: { symbol: "status.success", color: "success" },
	running: { symbol: "status.running", color: "accent" },
	failed: { symbol: "status.error", color: "error" },
	pending: { symbol: "status.pending", color: "muted" },
	waiting: { symbol: "status.pending", color: "muted" },
	idle: { symbol: "status.disabled", color: "dim" },
	aborted: { symbol: "status.aborted", color: "warning" },
};

type SwarmTheme = Pick<Theme, "fg" | "styledSymbol" | "getSymbolPreset">;

export function renderSwarmProgress(state: SwarmState, theme?: SwarmTheme): string[] {
	const agents: AgentState[] = Object.values(state.agents);
	if (agents.length === 0) {
		return ["  (no agents)"];
	}

	const nerd = theme?.getSymbolPreset() === "nerd";
	const lines: string[] = [];

	for (const agent of agents) {
		const duration = formatAgentDuration(agent);
		const errorSuffix = agent.error ? ` - ${truncate(agent.error, 60)}` : "";
		let icon: string;
		let nameStr: string;
		let statusStr: string;
		if (nerd && theme) {
			const nerdEntry = STATUS_NERD[agent.status];
			icon = nerdEntry ? theme.styledSymbol(nerdEntry.symbol, nerdEntry.color) : theme.fg("muted", "?");
			nameStr = theme.fg("statusLineSubagents", agent.name);
			statusStr = nerdEntry ? theme.fg(nerdEntry.color, agent.status) : agent.status;
		} else {
			icon = STATUS_LABELS[agent.status] ?? "[????]";
			nameStr = agent.name;
			statusStr = agent.status;
		}
		lines.push(`  ${icon} ${nameStr}: ${statusStr}${duration}${errorSuffix}`);
	}

	// Summary line
	const completed = agents.filter(a => a.status === "completed").length;
	const failed = agents.filter(a => a.status === "failed").length;
	const running = agents.filter(a => a.status === "running").length;

	const parts = [
		`${completed}/${agents.length} done`,
		...(running > 0 ? [`${running} running`] : []),
		...(failed > 0 ? [`${failed} failed`] : []),
		...(state.startedAt ? [`elapsed: ${formatDuration(Date.now() - state.startedAt)}`] : []),
	];
	const summary = parts.join(" | ");
	lines.push("");
	lines.push(theme ? `  ${theme.fg("muted", summary)}` : `  ${summary}`);

	return lines;
}

function formatAgentDuration(agent: { startedAt?: number; completedAt?: number; status: string }): string {
	if (agent.startedAt && agent.completedAt) {
		return ` (${formatDuration(agent.completedAt - agent.startedAt)})`;
	}
	if (agent.startedAt && (agent.status === "running" || agent.status === "waiting")) {
		return ` (${formatDuration(Date.now() - agent.startedAt)}...)`;
	}
	return "";
}
