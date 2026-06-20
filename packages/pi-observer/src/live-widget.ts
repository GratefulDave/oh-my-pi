import { getOrderedSubagents, IrcRenderer, RenderTheme, renderCompactAgentLines } from "./renderer";
import { getStats, type SubagentActivity } from "./stats-collector";

const MAX_AGENT_ROWS = 6;
const MAX_IRC_ROWS = 3;
const MAX_LINE_WIDTH = 120;

const ircRenderer = new IrcRenderer();

export function renderLiveObserverWidgetLines(now = Date.now(), theme?: RenderTheme): string[] | undefined {
	const stats = getStats();
	if (stats.subagents.size === 0 && stats.ircMessages.length === 0) return undefined;

	const agentLines = renderGroupedAgentLines(getOrderedSubagents(stats).slice(0, MAX_AGENT_ROWS), now, theme);
	const ircLines = ircRenderer.render(stats.ircMessages, {
		width: MAX_LINE_WIDTH,
		now,
		maxIrcMessages: MAX_IRC_ROWS,
		compact: true,
	}).lines;
	const lines = [...agentLines, ...ircLines];
	return lines.length > 0 ? lines : undefined;
}

function renderGroupedAgentLines(
	agents: readonly SubagentActivity[],
	now: number,
	theme?: RenderTheme,
): string[] {
	if (agents.length === 0) return [];
	const lines = theme ? [theme.fg("accent", "● Agents")] : ["● Agents"];
	let currentGroup = "";
	for (const agent of agents) {
		const group = getAgentGroupLabel(agent);
		if (group !== currentGroup) {
			lines.push(`○ ${group}`);
			currentGroup = group;
		}
		for (const line of renderCompactAgentLines(agent, {
			width: MAX_LINE_WIDTH - 2,
			now,
			theme,
		})) {
			lines.push(`  ${line}`);
		}
	}
	return lines;
}

function getAgentGroupLabel(agent: SubagentActivity): string {
	const metadata = readChainMetadata(agent);
	return (
		metadata.activeChain ?? metadata.teamGroup ?? agent.agentSource ?? agent.task ?? agent.description ?? agent.agent
	);
}

function readChainMetadata(agent: SubagentActivity): { activeChain?: string; teamGroup?: string } {
	const candidates = [agent.inflightTaskDetails, ...((agent.extractedToolData?.task as unknown[] | undefined) ?? [])];
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "object") continue;
		const record = candidate as Record<string, unknown>;
		const activeChain = readString(record.activeChain) ?? readString(record.chainId);
		if (activeChain) return { activeChain };
		const teamGroup = readString(record.teamGroup);
		if (teamGroup) return { teamGroup };
	}
	return {};
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
