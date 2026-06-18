import { describe, expect, test } from "bun:test";
import toolTallyExtension, { formatWidgetLine } from "./index";
import bundledToolTallyExtension, { formatWidgetLine as formatBundledWidgetLine } from "./dist/index.js";


const nerdTheme = {
	getSymbolPreset: () => "nerd" as const,
	styledSymbol: (key: string) =>
		(
			{
				"tab.tools": "[tools]",
				"icon.file": "[read]",
				"icon.search": "[search]",
				"tool.bash": "[bash]",
				"tool.job": "[job]",
				"tool.lsp": "[lsp]",
				"tool.memory": "[checkpoint]",
				"tool.edit": "[edit]",
				"icon.folder": "[find]",
				"icon.rewind": "[rewind]",
				"icon.warning": "[warn]",
			} as Record<string, string>
		)[key] ?? `[${key}]`,
	fg: (_color: string, text: string) => text,
};

describe("tool tally widget", () => {
	test("keeps the plain ANSI line outside nerd preset", () => {
		expect(
			formatWidgetLine(
				new Map([
					["read", 38],
					["search", 36],
					["bash", 17],
				]),
				108,
			),
		).toBe("tools:108  read:38  search:36  bash:17");
	});

	test("uses nerd glyphs plus text labels for mapped and unmapped tools", () => {
		expect(
			formatWidgetLine(
				new Map([
					["read", 38],
					["search", 36],
					["bash", 17],
					["rewind", 9],
					["lsp", 8],
					["job", 6],
					["checkpoint", 5],
					["report_tool_issue", 4],
					["edit", 3],
					["find", 2],
					["unknown_tool", 1],
				]),
				108,
				nerdTheme,
			),
		).toBe(
			"[tools] tools:108  [read] read:38  [search] search:36  [bash] bash:17  [rewind] rewind:9  [lsp] lsp:8  [job] job:6  [checkpoint] checkpoint:5  [warn] report_tool_issue:4",
		);
	});

	test("bundled helper stays in sync with source helper", () => {
		const tally = new Map([
			["read", 4],
			["search", 3],
			["mcp__auggie_codebase_retrieval", 1],
		]);
		expect(formatBundledWidgetLine(tally, 8, nerdTheme)).toBe(formatWidgetLine(tally, 8, nerdTheme));
	});

	test("source and bundled extensions both register the tally command", () => {
		for (const extension of [toolTallyExtension, bundledToolTallyExtension]) {
			const commands = new Map<string, { description: string }>();
			extension({
				setLabel() {},
				on() {},
				registerCommand(name: string, command: { description: string }) {
					commands.set(name, command);
				},
			} as never);
			expect(commands.get("tools-tally")?.description).toBe("Show or reset per-tool call counts for this session");
		}
	});
});
