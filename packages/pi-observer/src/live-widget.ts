import { getOrderedSubagents, IrcRenderer, RenderTheme, renderCompactAgentLines } from "./renderer";
import { getStats, type SubagentActivity } from "./stats-collector";

const MAX_AGENT_ROWS = 6;
const MAX_IRC_ROWS = 3;
const MAX_LINE_WIDTH = 120;

const ircRenderer = new IrcRenderer();

export function renderLiveObserverWidgetLines(
	now = Date.now(),
	theme?: RenderTheme,
	width = MAX_LINE_WIDTH,
): string[] | undefined {
	const stats = getStats();
	if (stats.subagents.size === 0 && stats.ircMessages.length === 0) return undefined;

	const renderWidth = Math.min(width, MAX_LINE_WIDTH);
	const { visibleAgents, hiddenCount } = selectVisibleAgents(getOrderedSubagents(stats), MAX_AGENT_ROWS);
	const agentLines = renderGroupedAgentLines(visibleAgents, now, hiddenCount, theme, renderWidth);
	const ircLines = ircRenderer.render(stats.ircMessages, {
		width: renderWidth,
		now,
		maxIrcMessages: MAX_IRC_ROWS,
		compact: true,
	}).lines;
	const lines = [...agentLines, ...ircLines];
	return lines.length > 0 ? lines : undefined;
}
function isActiveAgent(agent: SubagentActivity): boolean {
	return agent.status === "running" || agent.status === "pending";
}

function selectVisibleAgents(
	agents: readonly SubagentActivity[],
	maxRows: number,
): { visibleAgents: SubagentActivity[]; hiddenCount: number } {
	if (agents.length <= maxRows) return { visibleAgents: [...agents], hiddenCount: 0 };
	const active = agents.filter(isActiveAgent);
	const settled = agents.filter(agent => !isActiveAgent(agent));
	if (active.length >= maxRows) {
		return { visibleAgents: active.slice(0, maxRows), hiddenCount: agents.length - maxRows };
	}
	const visibleAgents = [...active, ...settled.slice(-(maxRows - active.length))];
	return { visibleAgents, hiddenCount: agents.length - visibleAgents.length };
}

function renderGroupedAgentLines(
	agents: readonly SubagentActivity[],
	now: number,
	hiddenCount: number,
	theme?: RenderTheme,
	width = MAX_LINE_WIDTH,
): string[] {
	if (agents.length === 0) return [];
	const hasActive = agents.some(isActiveAgent);
	const headingColor = hasActive ? "accent" : "dim";
	const headingIcon = hasActive ? "●" : "○";
	const lines = theme ? [theme.fg(headingColor, `${headingIcon} Agents`)] : [`${headingIcon} Agents`];
	for (const agent of agents) {
		for (const line of renderCompactAgentLines(agent, {
			width: width - 2,
			now,
			theme,
		})) {
			lines.push(`  ${line}`);
		}
	}
	if (hiddenCount > 0) {
		lines.push(theme ? theme.fg("dim", `  … ${hiddenCount} more agents`) : `  … ${hiddenCount} more agents`);
	}
	return lines;
}

