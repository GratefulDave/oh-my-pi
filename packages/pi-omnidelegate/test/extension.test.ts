import { describe, expect, test } from "bun:test";
import omnidelegate from "../src/extension";

interface CommandContext {
	cwd: string;
	ui: {
		setStatus: (key: string, value: string) => void;
		setEditorText: (text: string) => void;
		custom: <T>(renderer: unknown, options: { overlay: boolean }) => Promise<T>;
		notify: (message: string, level: "info" | "warning" | "error") => void;
	};
	sessionManager: {
		saveArtifact: (content: string, toolType: string) => Promise<string>;
	};
}

interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: CommandContext) => Promise<void>;
}

function createHarness() {
	const commands = new Map<string, RegisteredCommand>();
	const flags = new Map<string, unknown>();
	let label = "";
	const statuses: Array<{ key: string; value: string }> = [];
	const editorTexts: string[] = [];
	const api = {
		setLabel(value: string) {
			label = value;
		},
		registerFlag(name: string, config: { default: unknown }) {
			flags.set(name, config.default);
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
	};
	const ctx: CommandContext = {
		cwd: process.cwd(),
		ui: {
			setStatus(key: string, value: string) {
				statuses.push({ key, value });
			},
			setEditorText(text: string) {
				editorTexts.push(text);
			},
			async custom<T>() {
				return { successCount: 0, agents: [], contextSummary: "", fullReport: "" } as T;
			},
			notify() {},
		},
		sessionManager: {
			async saveArtifact() {
				return "artifact-id";
			},
		},
	};
	omnidelegate(api as never);
	return {
		commands,
		ctx,
		statuses,
		editorTexts,
		get label() {
			return label;
		},
	};
}

describe("omnidelegate extension", () => {
	test("registers delegate command and flags", async () => {
		const harness = createHarness();
		expect(harness.label).toBe("OmniDelegate");
		expect(harness.commands.has("delegate")).toBe(true);
		expect(harness.commands.has("delegate-results")).toBe(true);
		expect(harness.commands.get("delegate")?.description).toContain("external AI agents");
		expect(harness.commands.get("delegate-results")?.description).toContain("same-session delegate reports");
	});

	test("surfaces usage without launching agents when prompt is missing", async () => {
		const harness = createHarness();
		const command = harness.commands.get("delegate");
		expect(command).toBeDefined();
		await command?.handler("", harness.ctx);
		expect(harness.statuses.at(-1)?.key).toBe("omnidelegate");
		expect(harness.statuses.at(-1)?.value).toContain("Usage: /delegate");
		expect(harness.editorTexts.at(-1)).toBe("");
	});

	test("lists empty same-session delegate results", async () => {
		const harness = createHarness();
		const command = harness.commands.get("delegate-results");
		expect(command).toBeDefined();
		await command?.handler("list", harness.ctx);
		expect(harness.statuses.at(-1)?.key).toBe("omnidelegate");
		expect(harness.statuses.at(-1)?.value).toBe("0 delegate result(s) in this session.");
		expect(harness.editorTexts.at(-1)).toBe("No delegate results in this session.");
	});

	test("surfaces delegate-results usage for invalid subcommands", async () => {
		const harness = createHarness();
		const command = harness.commands.get("delegate-results");
		expect(command).toBeDefined();
		await command?.handler("bogus", harness.ctx);
		expect(harness.statuses.at(-1)?.value).toContain("Usage: /delegate-results");
		expect(harness.editorTexts.at(-1)).toBe("");
	});
});
