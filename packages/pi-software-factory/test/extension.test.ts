import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { type FactoryCommandDependencies, registerFactoryCommands } from "../src/commands";
import softwareFactory from "../src/extension";
import { createCmuxPaneBackend, findTerminalSurfaceId } from "../src/panes/cmux";
import type { PaneLaunchRequest, PaneSnapshot, PaneWorkerBackend } from "../src/panes/types";
import type { FactoryAuditEvent, FactoryPaneRef, FactoryPlan, FactoryRunMeta } from "../src/run-state/schema";
import { evaluateSafetyRule } from "../src/safety";
import { getPlannedFactoryTemplates } from "../src/scaffold";

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

interface HarnessOptions {
	dependencies?: Partial<FactoryCommandDependencies>;
	injectCommands?: boolean;
}

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function createNowSequence(values: string[]): () => Date {
	let index = 0;
	return () => new Date(values[index++] ?? values[values.length - 1]);
}

function createPaneBackend(): {
	launches: Array<{ laneId: string; prompt: string; command: string[] }>;
	sends: Array<{ workspaceId: string; surfaceId: string; message: string }>;
	reads: Array<{ workspaceId: string; surfaceId: string; lines: number }>;
	backend: PaneWorkerBackend;
} {
	const launches: Array<{ laneId: string; prompt: string; command: string[] }> = [];
	const sends: Array<{ workspaceId: string; surfaceId: string; message: string }> = [];
	const reads: Array<{ workspaceId: string; surfaceId: string; lines: number }> = [];
	const backend: PaneWorkerBackend = {
		name: "cmux",
		async launch(request: PaneLaunchRequest): Promise<FactoryPaneRef> {
			launches.push({ laneId: request.lane.id, prompt: request.prompt, command: [...request.command] });
			return {
				backend: "cmux",
				workspaceId: `workspace:${request.lane.id}`,
				surfaceId: `surface:${request.lane.id}`,
				command: [...request.command],
				cwd: request.cwd,
				launchedAt: request.launchedAt,
			};
		},
		async send(pane: FactoryPaneRef, message: string): Promise<void> {
			sends.push({ workspaceId: pane.workspaceId, surfaceId: pane.surfaceId, message });
		},
		async read(pane: FactoryPaneRef, lines: number): Promise<PaneSnapshot> {
			reads.push({ workspaceId: pane.workspaceId, surfaceId: pane.surfaceId, lines });
			return { pane, text: `screen:${pane.surfaceId}` };
		},
	};
	return { launches, sends, reads, backend };
}

async function readJsonFile<T>(filePath: string): Promise<T> {
	return (await Bun.file(filePath).json()) as T;
}

async function readAudit(cwd: string, runId: string): Promise<FactoryAuditEvent[]> {
	const auditText = await Bun.file(path.join(cwd, ".omp/factory/runs", runId, "audit.jsonl")).text();
	return auditText
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as FactoryAuditEvent);
}

async function createHarness(options: HarnessOptions = {}) {
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
	if (options.injectCommands) {
		api.setLabel("Software Factory");
		registerFactoryCommands(api as never, options.dependencies);
		api.on("tool_call", async (event, eventCtx) => evaluateSafetyRule(event, eventCtx));
	} else {
		softwareFactory(api as never);
	}
	return {
		commands,
		toolCallHandlers,
		ctx,
		notifications,
		statuses,
		editorTexts,
		async runCommand(name: string, args: string) {
			const command = commands.get(name);
			expect(command).toBeDefined();
			await command?.handler(args, ctx);
		},
		get label() {
			return label;
		},
	};
}

describe("software factory extension", () => {
	test("registers factory commands and reports missing config", async () => {
		const harness = await createHarness();
		expect(harness.label).toBe("Software Factory");
		expect([...harness.commands.keys()]).toEqual([
			"factory-status",
			"factory-init",
			"factory-upgrade",
			"factory-plan",
			"factory-launch",
			"factory-pane-status",
			"factory-send",
			"factory-gate",
			"factory-runs",
			"factory-show",
		]);

		await harness.runCommand("factory-status", "");

		expect(harness.notifications.at(-1)?.level).toBe("warning");
		expect(harness.notifications.at(-1)?.message).toContain("Factory Status");
		expect(harness.notifications.at(-1)?.message).toContain("FAILED");
		expect(harness.statuses.at(-1)).toEqual({ key: "factory", value: "Factory: Issues found" });
		expect(harness.editorTexts.at(-1)).toBe("");
	});

	test("lists pane presets and dry-runs strav scaffold without forbidden runtime strings", async () => {
		const harness = await createHarness();

		await harness.runCommand("factory-init", "--list-presets");
		expect(harness.notifications.at(-1)?.message).toContain("pane-factory");
		expect(harness.notifications.at(-1)?.message).toContain("strav");

		await harness.runCommand("factory-init", "--dry-run --preset strav");
		const message = harness.notifications.at(-1)?.message ?? "";
		expect(message).toContain(".omp/factory/prompts/claude-main-orchestrator.md");
		expect(message).toContain(".omp/factory/workflows/strav-pane-factory.md");
		expect(message).toContain(".omp/factory/model-roles.json");

		for (const preset of ["pane-factory", "strav"] as const) {
			for (const template of getPlannedFactoryTemplates({ cwd: harness.ctx.cwd, preset, enableMemory: true })) {
				const content = template.content.toLowerCase();
				expect(content).not.toContain("omx");
				expect(content).not.toContain("$team");
				expect(content).not.toContain("codex");
				expect(content).not.toContain("codex-teams");
				expect(content).not.toContain("runtime: codex");
			}
		}
	});

	test("plans a claude-orchestrated run with lane assignments", async () => {
		const harness = await createHarness({
			injectCommands: true,
			dependencies: { now: createNowSequence(["2026-06-16T06:00:00.000Z"]) },
		});

		await harness.runCommand(
			"factory-plan",
			'--orchestrator claude --workers builder,reviewer --run-id demo "ship pane support"',
		);

		const meta = await readJsonFile<FactoryRunMeta>(path.join(harness.ctx.cwd, ".omp/factory/runs/demo/meta.json"));
		const plan = await readJsonFile<FactoryPlan>(path.join(harness.ctx.cwd, ".omp/factory/runs/demo/plan.json"));
		const assignment = await Bun.file(
			path.join(harness.ctx.cwd, ".omp/factory/runs/demo/assignments/builder.md"),
		).text();

		expect(meta.orchestrator).toBe("claude");
		expect(meta.status).toBe("planned");
		expect(meta.workerRuntime).toBe("claude");
		expect(plan.lanes.map(lane => lane.id)).toEqual(["lead", "builder", "reviewer"]);
		expect(plan.lanes[0]?.orchestrator).toBe(true);
		expect(assignment).toContain("Use only the assigned Claude Code pane");
	});

	test("dry-run launch leaves planned run untouched and skips pane backend", async () => {
		const paneBackend = createPaneBackend();
		const harness = await createHarness({
			injectCommands: true,
			dependencies: {
				now: createNowSequence(["2026-06-16T06:00:00.000Z", "2026-06-16T06:00:01.000Z"]),
				paneBackend: paneBackend.backend,
			},
		});

		await harness.runCommand(
			"factory-plan",
			'--orchestrator claude --workers builder,reviewer --run-id demo "ship pane support"',
		);
		await harness.runCommand("factory-launch", "demo --dry-run");

		const meta = await readJsonFile<FactoryRunMeta>(path.join(harness.ctx.cwd, ".omp/factory/runs/demo/meta.json"));
		expect(meta.status).toBe("planned");
		expect(paneBackend.launches).toHaveLength(0);
		expect(harness.notifications.at(-1)?.message).toContain(`lead: claude cwd=${harness.ctx.cwd}`);
	});

	test("real launch records pane refs, rewrites lead assignment, and appends audit", async () => {
		const paneBackend = createPaneBackend();
		const harness = await createHarness({
			injectCommands: true,
			dependencies: {
				now: createNowSequence([
					"2026-06-16T06:00:00.000Z",
					"2026-06-16T06:00:01.000Z",
					"2026-06-16T06:00:02.000Z",
					"2026-06-16T06:00:03.000Z",
					"2026-06-16T06:00:04.000Z",
					"2026-06-16T06:00:05.000Z",
					"2026-06-16T06:00:06.000Z",
				]),
				paneBackend: paneBackend.backend,
			},
		});

		await harness.runCommand(
			"factory-plan",
			'--orchestrator claude --workers builder,reviewer --run-id demo "ship pane support"',
		);
		await harness.runCommand("factory-launch", "demo --claude-command claude");

		const meta = await readJsonFile<FactoryRunMeta>(path.join(harness.ctx.cwd, ".omp/factory/runs/demo/meta.json"));
		const plan = await readJsonFile<FactoryPlan>(path.join(harness.ctx.cwd, ".omp/factory/runs/demo/plan.json"));
		const leadAssignment = await Bun.file(
			path.join(harness.ctx.cwd, ".omp/factory/runs/demo/assignments/lead.md"),
		).text();
		const audit = await readAudit(harness.ctx.cwd, "demo");

		expect(paneBackend.launches.map(launch => launch.laneId)).toEqual(["builder", "reviewer", "lead"]);
		expect(plan.lanes.every(lane => lane.pane?.workspaceId && lane.pane?.surfaceId)).toBe(true);
		expect(leadAssignment).toContain("cmux send --workspace");
		expect(meta.status).toBe("running");
		expect(audit.map(event => event.type)).toContain("launch_completed");
	});

	test("sends pane messages without command-added newline and records audit", async () => {
		const paneBackend = createPaneBackend();
		const harness = await createHarness({
			injectCommands: true,
			dependencies: {
				now: createNowSequence([
					"2026-06-16T06:00:00.000Z",
					"2026-06-16T06:00:01.000Z",
					"2026-06-16T06:00:02.000Z",
					"2026-06-16T06:00:03.000Z",
					"2026-06-16T06:00:04.000Z",
					"2026-06-16T06:00:05.000Z",
					"2026-06-16T06:00:06.000Z",
					"2026-06-16T06:00:07.000Z",
				]),
				paneBackend: paneBackend.backend,
			},
		});

		await harness.runCommand(
			"factory-plan",
			'--orchestrator claude --workers builder,reviewer --run-id demo "ship pane support"',
		);
		await harness.runCommand("factory-launch", "demo --claude-command claude");
		await harness.runCommand("factory-send", 'demo builder "continue"');

		const audit = await readAudit(harness.ctx.cwd, "demo");
		expect(paneBackend.sends).toHaveLength(1);
		expect(paneBackend.sends[0]).toEqual({
			workspaceId: "workspace:builder",
			surfaceId: "surface:builder",
			message: "continue",
		});
		expect(audit.map(event => event.type)).toContain("pane_message_sent");
	});

	test("records approved gate and marks lane verified", async () => {
		const paneBackend = createPaneBackend();
		const harness = await createHarness({
			injectCommands: true,
			dependencies: {
				now: createNowSequence([
					"2026-06-16T06:00:00.000Z",
					"2026-06-16T06:00:01.000Z",
					"2026-06-16T06:00:02.000Z",
					"2026-06-16T06:00:03.000Z",
					"2026-06-16T06:00:04.000Z",
					"2026-06-16T06:00:05.000Z",
					"2026-06-16T06:00:06.000Z",
				]),
				paneBackend: paneBackend.backend,
			},
		});

		await harness.runCommand(
			"factory-plan",
			'--orchestrator claude --workers builder,reviewer --run-id demo "ship pane support"',
		);
		await harness.runCommand(
			"factory-gate",
			'demo builder approved --verifier reviewer --evidence evidence/builder.md --command "bun test" --note "looks good"',
		);

		const gateFiles = (await fs.readdir(path.join(harness.ctx.cwd, ".omp/factory/runs/demo/gates"))).filter(name =>
			name.endsWith(".json"),
		);
		expect(gateFiles).toHaveLength(1);
		const gate = await readJsonFile(path.join(harness.ctx.cwd, ".omp/factory/runs/demo/gates", gateFiles[0]));
		const plan = await readJsonFile<FactoryPlan>(path.join(harness.ctx.cwd, ".omp/factory/runs/demo/plan.json"));
		expect(gate).toMatchObject({
			status: "approved",
			severity: "info",
			commands: ["bun test"],
		});
		expect(plan.lanes.find(lane => lane.id === "builder")?.status).toBe("verified");
	});

	test("cmux backend launches workspace sequence and finds nested terminal surfaces", async () => {
		const calls: string[][] = [];
		const backend = createCmuxPaneBackend({
			async run(args) {
				calls.push(args);
				if (args[0] === "new-workspace") {
					return { exitCode: 0, stdout: "workspace:demo-run", stderr: "" };
				}
				if (args[0] === "list-pane-surfaces") {
					return {
						exitCode: 0,
						stdout: JSON.stringify({ items: [{ kind: "pane-terminal", surface_id: "surface-1" }] }),
						stderr: "",
					};
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});

		const pane = await backend.launch({
			runId: "demo",
			lane: {
				id: "builder",
				title: "builder",
				role: "implementer",
				workerRuntime: "claude",
				status: "pending",
				assignmentPath: "assignments/builder.md",
				cwd: "/tmp/demo",
				orchestrator: false,
			},
			command: ["claude"],
			cwd: "/tmp/demo",
			prompt: "hello",
			launchedAt: "2026-06-16T06:00:00.000Z",
		});

		expect(calls.map(call => call[0])).toEqual(["new-workspace", "list-pane-surfaces", "send", "set-status"]);
		expect(pane.workspaceId).toBe("workspace:demo-run");
		expect(findTerminalSurfaceId({ nested: [{ kind: "pane-terminal", surface_id: "surface-2" }] })).toBe("surface-2");
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
