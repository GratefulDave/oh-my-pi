import { Text } from "@oh-my-pi/pi-tui";
import type { ExtensionAPI, Theme, ThemeColor, SymbolKey } from "@oh-my-pi/pi-coding-agent";

const MAX_VISIBLE_TOOLS = 8;

const TOOL_SYMBOLS: Readonly<Record<string, SymbolKey>> = {
	read: "icon.file",
	search: "icon.search",
	find: "icon.folder",
	bash: "tool.bash",
	todo: "tool.todo",
	edit: "tool.edit",
	write: "tool.write",
	task: "tool.task",
	ask: "tool.ask",
	job: "tool.job",
	lsp: "tool.lsp",
	checkpoint: "tool.memory",
	web_search: "tool.webSearch",
	search_tool_bm25: "icon.search",
	rewind: "icon.rewind",
	report_tool_issue: "icon.warning",
};

export default function toolTallyExtension(pi: ExtensionAPI): void {
	pi.setLabel("Tool Tally");
	const counts = new Map<string, number>();
	let total = 0;

	pi.on("session_start", (_event, ctx) => {
		counts.clear();
		total = 0;
		ctx.ui.setWidget("tool-tally", undefined);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		total += 1;
		counts.set(event.toolName, (counts.get(event.toolName) ?? 0) + 1);
		ctx.ui.setWidget("tool-tally", (_tui, theme) => new Text(formatWidgetLine(counts, total, theme), 0, 0), {
			placement: "aboveEditor",
		});
	});

	pi.registerCommand("tools-tally", {
		description: "Show or reset per-tool call counts for this session",
		handler: async (args, ctx) => {
			if (args.trim() === "reset") {
				counts.clear();
				total = 0;
				ctx.ui.setWidget("tool-tally", undefined);
				ctx.ui.notify("Tool tally reset.", "info");
				return;
			}
			ctx.ui.notify(formatWidgetLine(counts, total), "info");
		},
	});
}

export function formatWidgetLine(counts: Map<string, number>, total: number, theme?: ToolTallyTheme): string {
	const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_VISIBLE_TOOLS);
	if (!theme || theme.getSymbolPreset() !== "nerd") {
		const top = sorted.map(([name, count]) => `${name}:${count}`).join("  ");
		return `tools:${total}${top ? `  ${top}` : ""}`;
	}
	const parts = [`${theme.styledSymbol("tab.tools", "accent")} ${theme.fg("accent", `tools:${total}`)}`, ...sorted.map(([name, count]) => formatNerdTool(name, count, theme))];
	return parts.join("  ");
}

type ToolTallyTheme = Pick<Theme, "fg" | "getSymbolPreset" | "styledSymbol">;

function formatNerdTool(name: string, count: number, theme: ToolTallyTheme): string {
	const symbol = toolSymbolFor(name);
	return symbol ? `${theme.styledSymbol(symbol, "muted")} ${theme.fg("muted", `${name}:${count}`)}` : `${name}:${count}`;
}

function toolSymbolFor(name: string): SymbolKey | undefined {
	if (name in TOOL_SYMBOLS) return TOOL_SYMBOLS[name];
	if (name.startsWith("mcp__")) return "tool.mcp";
	return undefined;
}
