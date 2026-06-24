import { describe, expect, test } from "bun:test";
import { z } from "zod";
import herdrExtension, {
	buildSpawnAgentArgs,
	createHerdrExtension,
	detectHerdrEnv,
	HERDR_CONTROL_TOOLS,
	type HerdrIdentity,
	type HerdrState,
} from "../src/extension";

interface CommandContext {
	cwd: string;
	ui: {
		setStatus: (key: string, value: string) => void;
		notify: (message: string, level: "info" | "warning" | "error") => void;
	};
}

interface RegisteredCommand {
	description?: string;
	handler: (args: string, ctx: CommandContext) => Promise<void>;
}

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
}

interface RegisteredTool {
	name: string;
	defaultInactive?: boolean;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: CommandContext,
	) => Promise<ToolResult>;
}

interface ExecCall {
	command: string;
	args: string[];
	options?: { cwd?: string; timeout?: number };
}

const identity: HerdrIdentity = {
	binPath: "/bin/herdr",
	socketPath: "/tmp/herdr.sock",
	workspaceId: "w1",
	tabId: "w1:t1",
	paneId: "w1:p1",
};

function createHarness(options: { getState?: () => Promise<HerdrState>; useDefaultExport?: boolean } = {}) {
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, RegisteredTool>();
	const events = new Map<string, (event: unknown, ctx: CommandContext) => Promise<void> | void>();
	const execCalls: ExecCall[] = [];
	const statuses: Array<{ key: string; value: string }> = [];
	const notifications: Array<{ message: string; level: "info" | "warning" | "error" }> = [];
	let label = "";
	let activeTools = ["herdr_status"];
	const api = {
		zod: z,
		setLabel(value: string) {
			label = value;
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: (event: unknown, ctx: CommandContext) => Promise<void> | void) {
			events.set(event, handler);
		},
		getActiveTools() {
			return [...activeTools];
		},
		async setActiveTools(toolNames: string[]) {
			activeTools = [...toolNames];
		},
		async exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }) {
			execCalls.push({ command, args, options });
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};
	const ctx: CommandContext = {
		cwd: "/repo",
		ui: {
			setStatus(key: string, value: string) {
				statuses.push({ key, value });
			},
			notify(message: string, level: "info" | "warning" | "error") {
				notifications.push({ message, level });
			},
		},
	};
	if (options.useDefaultExport) herdrExtension(api as never);
	else createHerdrExtension(api as never, { getState: options.getState });
	return {
		commands,
		tools,
		events,
		execCalls,
		ctx,
		statuses,
		notifications,
		get activeTools() {
			return activeTools;
		},
		get label() {
			return label;
		},
	};
}

describe("pi-herdr extension", () => {
	test("registers nerd-font Herdr label, /herdr command, and five herdr tools", () => {
		const harness = createHarness({ useDefaultExport: true });
		expect(harness.label).toBe("herdr:\uf0c0");
		expect(harness.commands.has("herdr")).toBe(true);
		expect([...harness.tools.keys()]).toEqual([
			"herdr_status",
			"herdr_list_panes",
			"herdr_spawn_agent",
			"herdr_read_pane",
			"herdr_send_pane",
		]);
		for (const name of HERDR_CONTROL_TOOLS) expect(harness.tools.get(name)?.defaultInactive).toBe(true);
	});

	test("detectHerdrEnv refuses non-Herdr sessions", () => {
		expect(detectHerdrEnv({})).toBeUndefined();
		expect(detectHerdrEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" })).toBeUndefined();
	});

	test("detectHerdrEnv accepts Herdr-managed panes", () => {
		expect(
			detectHerdrEnv({
				HERDR_ENV: "1",
				HERDR_SOCKET_PATH: "/tmp/herdr.sock",
				HERDR_WORKSPACE_ID: "w1",
				HERDR_TAB_ID: "w1:t1",
				HERDR_PANE_ID: "w1:p1",
				HERDR_BIN_PATH: "/bin/herdr",
			}),
		).toEqual(identity);
	});

	test("buildSpawnAgentArgs builds current-tab Claude launch", () => {
		expect(
			buildSpawnAgentArgs(
				identity,
				{
					name: "Researcher",
					kind: "claude",
					prompt: "review auth",
					model: "opus",
					cwd: "/repo",
					direction: "right",
					focus: false,
					env: { ROLE: "reviewer" },
				},
				"/fallback",
			),
		).toEqual([
			"agent",
			"start",
			"Researcher",
			"--cwd",
			"/repo",
			"--tab",
			"w1:t1",
			"--split",
			"right",
			"--no-focus",
			"--env",
			"ROLE=reviewer",
			"--",
			"claude",
			"--dangerously-skip-permissions",
			"--model",
			"opus",
			"review auth",
		]);
	});

	test("herdr_send_pane sends text before keys", async () => {
		const harness = createHarness({ getState: async () => ({ available: true, identity, reason: "available" }) });
		await harness.tools
			.get("herdr_send_pane")
			?.execute(
				"tool-call",
				{ pane_id: "w1:p2", text: "hello", keys: ["enter"] },
				undefined,
				undefined,
				harness.ctx,
			);
		expect(harness.execCalls.map(call => call.args)).toEqual([
			["pane", "send-text", "w1:p2", "hello"],
			["pane", "send-keys", "w1:p2", "enter"],
		]);
	});

	test("session_start activates control tools only when Herdr env is complete and ping succeeds", async () => {
		let available = true;
		const harness = createHarness({
			getState: async () =>
				available
					? { available: true, identity, reason: "available" }
					: { available: false, reason: "missing env" },
		});
		await harness.events.get("session_start")?.({}, harness.ctx);
		expect(harness.activeTools).toEqual(["herdr_status", ...HERDR_CONTROL_TOOLS]);
		expect(harness.statuses.at(-1)).toEqual({ key: "herdr", value: "herdr:on" });

		available = false;
		await harness.events.get("session_start")?.({}, harness.ctx);
		expect(harness.activeTools).toEqual(["herdr_status"]);
		expect(harness.statuses.at(-1)).toEqual({ key: "herdr", value: "herdr:off" });
	});
});
