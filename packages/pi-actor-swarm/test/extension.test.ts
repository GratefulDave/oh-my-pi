import { describe, expect, test } from "bun:test";
import actorSwarm from "../src/extension";

interface CustomComponent {
	render(width: number, height: number): string[];
	destroy(): void;
}

type CustomFactory<T> = (
	tui: { requestRender(): void },
	theme: { fg(color: string, text: string): string; bold(text: string): string },
	keybindings: unknown,
	done: (result: T) => void,
) => CustomComponent;

interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: CommandContext) => Promise<void>;
}

interface CommandContext {
	ui: {
		setEditorText: (text: string) => void;
		custom: <T>(renderer: CustomFactory<T>, options: { overlay: boolean }) => Promise<T>;
	};
}

function createHarness() {
	const commands = new Map<string, RegisteredCommand>();
	let label = "";
	const editorTexts: string[] = [];
	const api = {
		setLabel(value: string) {
			label = value;
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
	};
	const ctx: CommandContext = {
		ui: {
			setEditorText(text: string) {
				editorTexts.push(text);
			},
			async custom<T>(renderer: CustomFactory<T>) {
				const component = renderer(
					{ requestRender() {} },
					{ fg: (color, text) => `<${color}>${text}</${color}>`, bold: text => `<b>${text}</b>` },
					undefined,
					() => {},
				);
				try {
					component.render(80, 24);
				} finally {
					component.destroy();
				}
				return undefined as T;
			},
		},
	};
	actorSwarm(api as never);
	return {
		commands,
		ctx,
		editorTexts,
		get label() {
			return label;
		},
	};
}

describe("actor swarm extension", () => {
	test("registers swarm commands and initializes a named swarm", async () => {
		const harness = createHarness();
		expect(harness.label).toBe("Actor Swarm");
		expect([...harness.commands.keys()]).toEqual(["swarm-init", "swarm-status", "swarm-send", "swarm-reset"]);

		await harness.commands.get("swarm-init")?.handler("alpha --policy broadcast", harness.ctx);

		expect(harness.editorTexts.at(-1)).toContain('Swarm "alpha" initialized');
		expect(harness.editorTexts.at(-1)).toContain("broadcast routing");
	});

	test("renders status with host themes that do not expose dim", async () => {
		const harness = createHarness();
		await harness.commands.get("swarm-init")?.handler("alpha", harness.ctx);
		await harness.commands.get("swarm-status")?.handler("", harness.ctx);

		expect(harness.editorTexts.at(-1)).toBe("");
	});

	test("reports missing swarm before send", async () => {
		const harness = createHarness();
		await harness.commands.get("swarm-reset")?.handler("", harness.ctx);
		await harness.commands.get("swarm-send")?.handler("scout hello", harness.ctx);
		expect(harness.editorTexts.at(-1)).toBe("No active swarm. Use /swarm-init to create one.");
	});
});
