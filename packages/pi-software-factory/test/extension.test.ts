import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import softwareFactory from "../src/extension";

interface CommandContext {
	cwd: string;
	ui: {
		notify: (message: string, level: "info" | "warning") => void;
		setStatus: (key: string, value: string) => void;
		setEditorText: (text: string) => void;
	};
}

interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: CommandContext) => Promise<void>;
}

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function createHarness() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "factory-extension-"));
	tempDirs.push(cwd);
	const commands = new Map<string, RegisteredCommand>();
	let label = "";
	const notifications: Array<{ message: string; level: "info" | "warning" }> = [];
	const statuses: Array<{ key: string; value: string }> = [];
	const editorTexts: string[] = [];
	const api = {
		setLabel(value: string) {
			label = value;
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		on() {},
	};
	const ctx: CommandContext = {
		cwd,
		ui: {
			notify(message: string, level: "info" | "warning") {
				notifications.push({ message, level });
			},
			setStatus(key: string, value: string) {
				statuses.push({ key, value });
			},
			setEditorText(text: string) {
				editorTexts.push(text);
			},
		},
	};
	softwareFactory(api as never);
	return {
		commands,
		ctx,
		notifications,
		statuses,
		editorTexts,
		get label() {
			return label;
		},
	};
}

describe("software factory extension", () => {
	test("registers factory commands and reports missing config", async () => {
		const harness = await createHarness();
		expect(harness.label).toBe("Software Factory");
		expect([...harness.commands.keys()]).toEqual(["factory-status", "factory-init"]);

		await harness.commands.get("factory-status")?.handler("", harness.ctx);

		expect(harness.notifications.at(-1)?.level).toBe("warning");
		expect(harness.notifications.at(-1)?.message).toContain("Factory Status");
		expect(harness.notifications.at(-1)?.message).toContain("FAILED");
		expect(harness.statuses.at(-1)).toEqual({ key: "factory", value: "Factory: Issues found" });
		expect(harness.editorTexts.at(-1)).toBe("");
	});
});
