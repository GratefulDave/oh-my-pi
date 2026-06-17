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
				"tool.todo": "[todo]",
				"tool.edit": "[edit]",
				"icon.folder": "[find]",
				"icon.rewind": "[rewind]",
				"icon.warning": "[warn]",
				"tool.mcp": "[mcp]",
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

	test("uses nerd glyph prefixes for mapped tools including rewind and report_tool_issue", () => {
		expect(
			formatWidgetLine(
				new Map([
					["read", 38],
					["search", 36],
					["bash", 17],
					["rewind", 9],
					["report_tool_issue", 4],
					["edit", 5],
					["find", 2],
					["search_tool_bm25", 1],
					["mcp__auggie_codebase_retrieval", 1],
					["unknown_tool", 1],
				]),
				108,
				nerdTheme,
			),
		).toBe("[tools]108  [read]38  [search]36  [bash]17  [rewind]9  [edit]5  [warn]4  [find]2  [search]1");
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
