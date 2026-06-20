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
	const hasActive = agents.some(a => a.status === "running" || a.status === "pending");
	const headingColor = hasActive ? "accent" : "dim";
	const headingIcon = hasActive ? "●" : "○";
	const lines = theme ? [theme.fg(headingColor, `${headingIcon} Agents`)] : [`${headingIcon} Agents`];
	for (const agent of agents) {
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

