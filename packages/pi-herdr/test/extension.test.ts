import { describe, expect, test } from "bun:test";

interface SchemaShim {
	optional(): SchemaShim;
	describe(description: string): SchemaShim;
	min(value: number): SchemaShim;
	max(value: number): SchemaShim;
	regex(pattern: RegExp): SchemaShim;
	int(): SchemaShim;
}

function createSchema(): SchemaShim {
	const schema: SchemaShim = {
		optional: () => schema,
		describe: () => schema,
		min: () => schema,
		max: () => schema,
		regex: () => schema,
		int: () => schema,
	};
	return schema;
}

const z = {
	object: (_shape: Record<string, unknown>) => createSchema(),
	boolean: () => createSchema(),
	string: () => createSchema(),
	enum: (_values: readonly string[]) => createSchema(),
	array: (_item: SchemaShim) => createSchema(),
	number: () => createSchema(),
	record: (_key: SchemaShim, _value: SchemaShim) => createSchema(),
};

import herdrExtension, {
	buildSpawnAgentArgs,
	createHerdrExtension,
	detectHerdrEnv,
	HERDR_CONTROL_TOOLS,
	type HerdrIdentity,
	type HerdrState,
	herdrActivityState,
} from "../src/extension";

interface CommandContext {
	hasUI: boolean;
	isIdle: () => boolean;
	cwd: string;
	ui: {
		setStatus: (key: string, value: string) => void;
		notify: (message: string, level: "info" | "warning" | "error") => void;
	};
	sessionManager: {
		getBranch: () => unknown[];
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
		onUpdate: ((update: ToolResult) => void) | undefined,
		ctx: CommandContext,
	) => Promise<ToolResult>;
}

interface ExecCall {
	command: string;
	args: string[];
	options?: { cwd?: string; timeout?: number };
}

interface HerdrRequestCall {
	method: string;
	params: Record<string, unknown>;
}

type HerdrRequest = <T>(
	identity: HerdrIdentity,
	method: string,
	params: Record<string, unknown>,
	timeoutMs?: number,
) => Promise<T>;

const identity: HerdrIdentity = {
	binPath: "/bin/herdr",
	socketPath: "/tmp/herdr.sock",
	workspaceId: "w1",
	tabId: "w1:t1",
	paneId: "w1:p1",
};

function jsonResponse(result: unknown): { stdout: string; stderr: string; code: number; killed: boolean } {
	return { stdout: JSON.stringify({ id: "test", result }), stderr: "", code: 0, killed: false };
}

function createHarness(
	options: {
		getState?: () => Promise<HerdrState>;
		request?: HerdrRequest;
		useDefaultExport?: boolean;
		exec?: (
			args: string[],
			execOptions?: { cwd?: string; timeout?: number },
		) => { stdout: string; stderr: string; code: number; killed: boolean };
	} = {},
) {
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, RegisteredTool>();
	const events = new Map<string, (event: unknown, ctx: CommandContext) => Promise<void> | void>();
	const customEvents = new Map<string, (event: unknown) => void>();
	const execCalls: ExecCall[] = [];
	const statuses: Array<{ key: string; value: string }> = [];
	const notifications: Array<{ message: string; level: "info" | "warning" | "error" }> = [];
	const requests: HerdrRequestCall[] = [];
	let label = "";
	let activeTools = ["herdr_status"];
	let idle = true;
	const api = {
		events: {
			on(event: string, handler: (event: unknown) => void) {
				customEvents.set(event, handler);
			},
		},
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
		async exec(command: string, args: string[], execOptions?: { cwd?: string; timeout?: number }) {
			execCalls.push({ command, args, options: execOptions });
			return options.exec?.(args, execOptions) ?? { stdout: "", stderr: "", code: 0, killed: false };
		},
	};
	const request: HerdrRequest = async <T>(
		requestIdentity: HerdrIdentity,
		method: string,
		params: Record<string, unknown>,
		timeoutMs?: number,
	) => {
		requests.push({ method, params });
		if (options.request) return options.request<T>(requestIdentity, method, params, timeoutMs);
		return {} as T;
	};
	const ctx: CommandContext = {
		hasUI: true,
		isIdle() {
			return idle;
		},
		cwd: "/repo",
		ui: {
			setStatus(key: string, value: string) {
				statuses.push({ key, value });
			},
			notify(message: string, level: "info" | "warning" | "error") {
				notifications.push({ message, level });
			},
		},
		sessionManager: {
			getBranch() {
				return [];
			},
		},
	};
	if (options.useDefaultExport) herdrExtension(api as never);
	else createHerdrExtension(api as never, { getState: options.getState, request });
	return {
		commands,
		tools,
		events,
		customEvents,
		requests,
		execCalls,
		ctx,
		statuses,
		notifications,
		setIdle(value: boolean) {
			idle = value;
		},
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
			"herdr",
		]);
		for (const name of HERDR_CONTROL_TOOLS) expect(harness.tools.get(name)?.defaultInactive).toBe(true);
	});

	test("keeps Herdr working while either main or subagent runs", () => {
		expect(herdrActivityState(false, 0)).toBe("idle");
		expect(herdrActivityState(true, 0)).toBe("working");
		expect(herdrActivityState(false, 1)).toBe("working");
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

	test("reports a stale root end as working until the live session becomes idle", async () => {
		const harness = createHarness({ getState: async () => ({ available: true, identity, reason: "available" }) });
		const sessionStart = harness.events.get("session_start");
		const agentStart = harness.events.get("agent_start");
		const agentEnd = harness.events.get("agent_end");
		if (!sessionStart || !agentStart || !agentEnd) throw new Error("activity lifecycle handlers were not registered");

		await sessionStart({}, harness.ctx);
		harness.setIdle(false);
		await agentStart({}, harness.ctx);
		await agentEnd({}, harness.ctx);
		harness.setIdle(true);
		await agentEnd({}, harness.ctx);

		expect(harness.requests.map(request => ({ method: request.method, state: request.params.state }))).toEqual([
			{ method: "pane.report_agent", state: "idle" },
			{ method: "pane.report_agent", state: "working" },
			{ method: "pane.report_agent", state: "working" },
			{ method: "pane.report_agent", state: "idle" },
		]);
	});

	test("keeps reporting working until the final subagent terminal event", async () => {
		const harness = createHarness({ getState: async () => ({ available: true, identity, reason: "available" }) });
		const sessionStart = harness.events.get("session_start");
		const agentEnd = harness.events.get("agent_end");
		const subagentLifecycle = harness.customEvents.get("task:subagent:lifecycle");
		if (!sessionStart || !agentEnd || !subagentLifecycle)
			throw new Error("activity lifecycle handlers were not registered");

		await sessionStart({}, harness.ctx);
		await subagentLifecycle({ id: "subagent-1", status: "started" });
		await agentEnd({}, harness.ctx);
		await subagentLifecycle({ id: "subagent-1", status: "completed" });

		expect(harness.requests.map(request => ({ method: request.method, state: request.params.state }))).toEqual([
			{ method: "pane.report_agent", state: "idle" },
			{ method: "pane.report_agent", state: "working" },
			{ method: "pane.report_agent", state: "working" },
			{ method: "pane.report_agent", state: "idle" },
		]);
	});

	test("herdr wait_agent accepts either idle or done as a completion state", async () => {
		const targetPane = {
			pane_id: "w1:p2",
			workspace_id: "w1",
			tab_id: "w1:t1",
			agent_status: "done",
		};
		const harness = createHarness({
			getState: async () => ({ available: true, identity, reason: "available" }),
			exec: args => {
				if (args[0] === "pane" && args[1] === "current")
					return jsonResponse({ pane: { ...targetPane, pane_id: identity.paneId } });
				if (args[0] === "pane" && args[1] === "get") return jsonResponse({ pane: targetPane });
				throw new Error(`unexpected command: ${args.join(" ")}`);
			},
		});
		const tool = harness.tools.get("herdr");
		if (!tool) throw new Error("herdr tool was not registered");

		const result = await tool.execute(
			"tool-call",
			{ action: "wait_agent", pane: targetPane.pane_id, statuses: ["idle", "done"] },
			undefined,
			undefined,
			harness.ctx,
		);

		expect(result.content[0]?.text).toContain(`${targetPane.pane_id}=done`);
		expect(harness.execCalls.map(call => call.args)).toContainEqual(["pane", "get", targetPane.pane_id]);
	});

	test("herdr stop refuses to close the pane running OMP", async () => {
		const harness = createHarness({
			getState: async () => ({ available: true, identity, reason: "available" }),
			exec: args => {
				if (args[0] === "pane" && args[1] === "current") {
					return jsonResponse({
						pane: {
							pane_id: identity.paneId,
							workspace_id: identity.workspaceId,
							tab_id: identity.tabId,
							agent_status: "working",
						},
					});
				}
				throw new Error(`unexpected command: ${args.join(" ")}`);
			},
		});
		const tool = harness.tools.get("herdr");
		if (!tool) throw new Error("herdr tool was not registered");

		await expect(
			tool.execute("tool-call", { action: "stop", pane: identity.paneId }, undefined, undefined, harness.ctx),
		).rejects.toThrow("Refusing to close the pane pi is running in.");
		expect(harness.execCalls.map(call => call.args)).toEqual([["pane", "current", "--current"]]);
	});

	test("herdr watch gives explicit waits grace and leaves unbounded waits to Herdr", async () => {
		const targetPane = {
			pane_id: "w1:p2",
			workspace_id: "w1",
			tab_id: "w1:t1",
			agent_status: "working",
		};
		const harness = createHarness({
			getState: async () => ({ available: true, identity, reason: "available" }),
			exec: args => {
				if (args[0] === "pane" && args[1] === "current")
					return jsonResponse({ pane: { ...targetPane, pane_id: identity.paneId } });
				if (args[0] === "pane" && args[1] === "get") return jsonResponse({ pane: targetPane });
				if (args[0] === "wait" && args[1] === "output") return jsonResponse({ matched_line: "ready" });
				throw new Error(`unexpected command: ${args.join(" ")}`);
			},
		});
		const tool = harness.tools.get("herdr");
		if (!tool) throw new Error("herdr tool was not registered");

		await tool.execute(
			"tool-call",
			{ action: "watch", pane: targetPane.pane_id, match: "ready", timeout: 60_000 },
			undefined,
			undefined,
			harness.ctx,
		);
		await tool.execute(
			"tool-call",
			{ action: "watch", pane: targetPane.pane_id, match: "ready" },
			undefined,
			undefined,
			harness.ctx,
		);

		const waits = harness.execCalls.filter(call => call.args[0] === "wait" && call.args[1] === "output");
		expect(waits.map(call => call.options?.timeout)).toEqual([61_000, undefined]);
	});

	test("herdr aliases retain transient failures and serialize __proto__ as an own key", async () => {
		const targetPane = {
			pane_id: "w1:p2",
			workspace_id: "w1",
			tab_id: "w1:t1",
			agent_status: "idle",
		};
		let transient = true;
		const harness = createHarness({
			getState: async () => ({ available: true, identity, reason: "available" }),
			exec: args => {
				if (args[0] === "pane" && args[1] === "current")
					return jsonResponse({ pane: { ...targetPane, pane_id: identity.paneId } });
				if (args[0] === "workspace" && args[1] === "create") {
					return jsonResponse({
						workspace: { workspace_id: "w1", label: "workspace", focused: true, agent_status: "idle" },
						root_pane: targetPane,
					});
				}
				if (args[0] === "pane" && args[1] === "get") {
					if (transient) return { stdout: "", stderr: "temporary socket failure", code: 1, killed: false };
					return jsonResponse({ pane: targetPane });
				}
				if (args[0] === "agent" && args[1] === "focus")
					return jsonResponse({ agent: { ...targetPane, terminal_id: "t1", focused: true } });
				throw new Error(`unexpected command: ${args.join(" ")}`);
			},
		});
		const tool = harness.tools.get("herdr");
		if (!tool) throw new Error("herdr tool was not registered");

		const created = await tool.execute(
			"create",
			{ action: "workspace_create", pane: "__proto__" },
			undefined,
			undefined,
			harness.ctx,
		);
		const details = created.details as { aliases: Record<string, unknown> };
		expect(Object.hasOwn(details.aliases, "__proto__")).toBe(true);

		await expect(
			tool.execute("focus", { action: "focus", pane: "__proto__" }, undefined, undefined, harness.ctx),
		).rejects.toThrow("temporary socket failure");
		transient = false;
		await tool.execute("focus", { action: "focus", pane: "__proto__" }, undefined, undefined, harness.ctx);
		expect(harness.execCalls.map(call => call.args)).toContainEqual(["agent", "focus", targetPane.pane_id]);
	});
});
