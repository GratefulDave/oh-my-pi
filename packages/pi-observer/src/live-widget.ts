import { IrcRenderer, SubagentRenderer } from "./renderer";
import { getStats } from "./stats-collector";

const MAX_AGENT_ROWS = 6;
const MAX_IRC_ROWS = 3;
const MAX_LINE_WIDTH = 120;

const subagentRenderer = new SubagentRenderer();
const ircRenderer = new IrcRenderer();

export function renderLiveObserverWidgetLines(now = Date.now()): string[] | undefined {
	const stats = getStats();
	if (stats.subagents.size === 0 && stats.ircMessages.length === 0) return undefined;

	const agentLines = subagentRenderer.render(stats, {
		width: MAX_LINE_WIDTH,
		now,
		maxAgents: MAX_AGENT_ROWS,
		compact: true,
	}).lines;
	const ircLines = ircRenderer.render(stats.ircMessages, {
		width: MAX_LINE_WIDTH,
		now,
		maxIrcMessages: MAX_IRC_ROWS,
		compact: true,
	}).lines;

	return [...agentLines, ...ircLines];
}
