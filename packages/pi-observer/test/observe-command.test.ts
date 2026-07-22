import { describe, expect, test } from "bun:test";
import observer from "../src/extension";
import { resetStats } from "../src/stats-collector";

type ObserverCommand = Parameters<Parameters<typeof observer>[0]["registerCommand"]>[1];
type ObserveHandler = ObserverCommand["handler"];
type OverlayFactory = (
	tui: { requestRender(): void },
	theme: { fg(color: string, text: string): string; bold(text: string): string },
	keybindings: unknown,
	done: (result: void) => void,
) => { render(width: number, height: number): string[] };

describe("/observe", () => {
	test("uses the host dim color token without requiring a theme.dim formatter", async () => {
		resetStats();
		let handler: ObserveHandler | undefined;
		const renderedTools: string[] = [];
		const pi = {
			events: { on() {} },
			setLabel() {},
			on() {},
			registerCommand(_name: string, command: ObserverCommand) {
				handler = command.handler;
			},
			registerToolRenderer(name: string) {
				renderedTools.push(name);
			},
		} as Parameters<typeof observer>[0];
		observer(pi);
		expect(handler).toBeDefined();

		const fgCalls: Array<[string, string]> = [];
		const ctx = {
			cwd: ".",
			ui: {
				setEditorText() {},
				custom: async (factory: OverlayFactory) => {
					const dashboard = factory(
						{ requestRender() {} },
						{
							fg(color, text) {
								fgCalls.push([color, text]);
								return text;
							},
							bold: text => text,
						},
						undefined,
						() => {},
					);
					dashboard.render(80, 24);
				},
			},
		} as Parameters<ObserveHandler>[1];

		await handler!("", ctx);
		expect(renderedTools).toEqual(["job"]);
		expect(fgCalls.some(([color, text]) => color === "accent" && text === "session-observability")).toBe(true);
		expect(fgCalls.some(([color, text]) => color === "dim" && text.includes("Real-time agents"))).toBe(true);
	});
});
