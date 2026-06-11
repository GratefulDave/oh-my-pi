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

interface ToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

type ToolCallHandler = (event: ToolCallEvent, ctx: CommandContext) => Promise<ToolCallResult | undefined>;

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
	const toolCallHandlers: ToolCallHandler[] = [];
	const api = {
		setLabel(value: string) {
			label = value;
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		on(event: string, handler: ToolCallHandler) {
			if (event === "tool_call") {
				toolCallHandlers.push(handler);
			}
		},
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
		toolCallHandlers,
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
		expect([...harness.commands.keys()]).toEqual(["factory-status", "factory-init", "factory-upgrade"]);

		await harness.commands.get("factory-status")?.handler("", harness.ctx);

		expect(harness.notifications.at(-1)?.level).toBe("warning");
		expect(harness.notifications.at(-1)?.message).toContain("Factory Status");
		expect(harness.notifications.at(-1)?.message).toContain("FAILED");
		expect(harness.statuses.at(-1)).toEqual({ key: "factory", value: "Factory: Issues found" });
		expect(harness.editorTexts.at(-1)).toBe("");
	});

	test("lists presets and dry-runs init without writing files", async () => {
		const harness = await createHarness();

		await harness.commands.get("factory-init")?.handler("--list-presets", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toContain("standard");
		expect(harness.notifications.at(-1)?.message).toContain("minimal");

		await harness.commands.get("factory-init")?.handler("--dry-run", harness.ctx);

		expect(harness.notifications.at(-1)?.message).toContain("Factory Scaffold Dry Run");
		expect(harness.notifications.at(-1)?.message).toContain("Would write");
		expect(await Bun.file(path.join(harness.ctx.cwd, ".omp/factory/factory.json")).exists()).toBe(false);
	});

	test("dry-runs upgrade with create and update buckets", async () => {
		const harness = await createHarness();
		await fs.mkdir(path.join(harness.ctx.cwd, ".omp/factory"), { recursive: true });
		await Bun.write(path.join(harness.ctx.cwd, ".omp/factory/factory.json"), "{}");

		await harness.commands.get("factory-upgrade")?.handler("--dry-run", harness.ctx);

		const message = harness.notifications.at(-1)?.message ?? "";
		expect(message).toContain("Factory Upgrade Dry Run");
		expect(message).toContain("Create (");
		expect(message).toContain("Update (1)");
		expect(message).toContain(".omp/factory/factory.json");
	});

	test("warns and blocks matching safety rules", async () => {
		const harness = await createHarness();
		await fs.mkdir(path.join(harness.ctx.cwd, ".omp/factory"), { recursive: true });
		await Bun.write(
			path.join(harness.ctx.cwd, ".omp/factory/safety.rules.json"),
			JSON.stringify({
				rules: [
					{ name: "bash", pattern: "git reset --hard", action: "warn", message: "dangerous git" },
					{ name: "bash", pattern: "rm -rf /", action: "block", message: "dangerous rm" },
				],
			}),
		);

		const handler = harness.toolCallHandlers[0];
		expect(handler).toBeDefined();

		const warnResult = await handler?.(
			{ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "git reset --hard" } },
			harness.ctx,
		);
		expect(warnResult).toBeUndefined();
		expect(harness.notifications.at(-1)).toEqual({ message: "dangerous git", level: "warning" });

		const blockResult = await handler?.(
			{ type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "rm -rf /" } },
			harness.ctx,
		);
		expect(blockResult).toEqual({ block: true, reason: "dangerous rm" });
	});
});
