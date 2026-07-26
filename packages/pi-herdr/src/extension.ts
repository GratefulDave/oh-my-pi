import * as net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

const HERDR_UNAVAILABLE_REASON =
	"not running inside a Herdr-managed pane (HERDR_ENV=1, HERDR_SOCKET_PATH, HERDR_WORKSPACE_ID, HERDR_TAB_ID, HERDR_PANE_ID required)";

export const HERDR_CONTROL_TOOLS = [
	"herdr_list_panes",
	"herdr_spawn_agent",
	"herdr_read_pane",
	"herdr_send_pane",
	"herdr",
] as const;

const HERDR_CONTROL_ACTIONS = [
	"list",
	"current",
	"workspace_list",
	"workspace_create",
	"workspace_focus",
	"tab_list",
	"tab_create",
	"tab_focus",
	"focus",
	"pane_rename",
	"pane_split",
	"agent_list",
	"agent_get",
	"run",
	"read",
	"watch",
	"wait_agent",
	"send",
	"stop",
] as const;

const HERDR_AGENT_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;
const HERDR_WATCH_TIMEOUT_GRACE_MS = 1000;

class HerdrCommandError extends Error {
	constructor(
		message: string,
		readonly responseError: unknown,
	) {
		super(message);
	}
}

function isDefinitivePaneNotFound(error: unknown): boolean {
	if (!(error instanceof HerdrCommandError)) return false;
	const response = asRecord(error.responseError);
	const code = stringField(response, "code");
	const message =
		stringField(response, "message") ?? (typeof error.responseError === "string" ? error.responseError : "");
	return (
		code === "pane_not_found" ||
		(code === "not_found" && /\bpane\b/i.test(message)) ||
		/\bpane\b.*\bnot found\b/i.test(message)
	);
}

export type HerdrControlAction = (typeof HERDR_CONTROL_ACTIONS)[number];
type HerdrAgentStatus = (typeof HERDR_AGENT_STATUSES)[number];

export interface HerdrIdentity {
	binPath: string;
	socketPath: string;
	workspaceId: string;
	tabId: string;
	paneId: string;
}

export interface HerdrState {
	identity?: HerdrIdentity;
	available: boolean;
	reason: string;
}

type HerdrRequest = <T>(
	identity: HerdrIdentity,
	method: string,
	params: Record<string, unknown>,
	timeoutMs?: number,
) => Promise<T>;

type HerdrGetState = () => Promise<HerdrState>;

interface HerdrExtensionOptions {
	getState?: HerdrGetState;
	request?: HerdrRequest;
}

interface SpawnAgentParams {
	name: string;
	kind: "claude" | "argv";
	prompt?: string;
	model?: string;
	argv?: string[];
	cwd?: string;
	direction?: "right" | "down";
	env?: Record<string, string>;
	focus?: boolean;
}

interface ReadPaneParams {
	pane_id: string;
	source?: "visible" | "recent" | "recent-unwrapped";
	lines?: number;
}

interface SendPaneParams {
	pane_id: string;
	text?: string;
	keys?: string[];
}

interface HerdrExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

interface ManagedPane {
	paneId: string;
	workspaceId: string;
}

interface HerdrControlParams {
	action: HerdrControlAction;
	pane?: string;
	panes?: string[];
	workspace?: string;
	tab?: string;
	label?: string;
	newPane?: string;
	direction?: "right" | "down";
	agent?: string;
	command?: string;
	match?: string;
	regex?: boolean;
	status?: HerdrAgentStatus;
	statuses?: HerdrAgentStatus[];
	mode?: "all" | "any";
	timeout?: number;
	lines?: number;
	source?: "visible" | "recent" | "recent-unwrapped" | "detection";
	raw?: boolean;
	text?: string;
	keys?: string;
	cwd?: string;
	focus?: boolean;
}

interface HerdrPaneInfo {
	pane_id: string;
	workspace_id: string;
	tab_id: string;
	focused?: boolean;
	cwd?: string;
	label?: string;
	agent?: string;
	agent_status: HerdrAgentStatus;
}

interface HerdrAgentInfo {
	terminal_id: string;
	name?: string;
	agent?: string;
	display_agent?: string;
	pane_id: string;
	workspace_id: string;
	tab_id: string;
	focused: boolean;
	cwd?: string;
	agent_status: HerdrAgentStatus;
}

interface HerdrWorkspaceInfo {
	workspace_id: string;
	label: string;
	focused: boolean;
	agent_status: HerdrAgentStatus;
}

interface HerdrTabInfo {
	tab_id: string;
	workspace_id: string;
	label: string;
	focused: boolean;
	agent_status: HerdrAgentStatus;
}

interface HerdrPaneLayout {
	panes: Array<{ pane_id: string; rect: { width: number; height: number } }>;
}

interface HerdrControlResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

interface SubagentLifecycleEvent {
	id?: string;
	status?: "started" | "completed" | "failed" | "aborted";
}

function isSubagentLifecycleEvent(value: unknown): value is SubagentLifecycleEvent {
	return typeof value === "object" && value !== null;
}

export function herdrActivityState(mainActive: boolean, activeSubagentCount: number): "working" | "idle" {
	return mainActive || activeSubagentCount > 0 ? "working" : "idle";
}

let state: HerdrState = { available: false, reason: HERDR_UNAVAILABLE_REASON };

export default function herdrExtension(pi: ExtensionAPI): void {
	createHerdrExtension(pi);
}

export function createHerdrExtension(pi: ExtensionAPI, options: HerdrExtensionOptions = {}): void {
	pi.setLabel("herdr:\uf0c0");

	const request = options.request ?? herdrRequest;
	const getState = options.getState ?? getHerdrState;
	const requireAvailable = async (): Promise<HerdrIdentity> => requireHerdr(getState);
	const aliases = new Map<string, ManagedPane>();
	const aliasOrder: string[] = [];
	const activeSubagents = new Set<string>();
	let currentSessionContext: ExtensionContext | undefined;
	let reporterActive = false;
	let activitySequence = Date.now();
	let activityReporterEpoch = 0;
	let activityInFlight = false;
	let activityRetryTimer: NodeJS.Timeout | undefined;
	let desiredActivity: { state: "working" | "idle"; retries: number } | undefined;

	const clearActivityRetry = (): void => {
		if (activityRetryTimer !== undefined) {
			clearTimeout(activityRetryTimer);
			activityRetryTimer = undefined;
		}
	};

	const isCurrentReporter = (epoch: number): boolean =>
		reporterActive && epoch === activityReporterEpoch && state.available && state.identity !== undefined;

	const flushActivity = async (): Promise<void> => {
		if (activityInFlight || !desiredActivity || !reporterActive || !state.available || !state.identity) return;

		const report = desiredActivity;
		const identity = state.identity;
		const epoch = activityReporterEpoch;
		activityInFlight = true;

		try {
			await request(identity, "pane.report_agent", {
				pane_id: identity.paneId,
				source: "herdr:omp",
				agent: "omp",
				state: report.state,
				seq: ++activitySequence,
			});
		} catch {
			if (isCurrentReporter(epoch) && desiredActivity === report) {
				if (report.retries < 2) {
					report.retries += 1;
					activityRetryTimer = setTimeout(() => {
						activityRetryTimer = undefined;
						void flushActivity();
					}, 50);
					return;
				}
				desiredActivity = undefined;
			}
		} finally {
			activityInFlight = false;
		}

		if (!isCurrentReporter(epoch)) {
			if (reporterActive && desiredActivity) void flushActivity();
			return;
		}
		if (desiredActivity === report) desiredActivity = undefined;
		if (desiredActivity) void flushActivity();
	};

	const reportActivity = (): void => {
		if (!reporterActive || !state.available || !state.identity) return;

		desiredActivity = {
			state: herdrActivityState(currentSessionContext?.isIdle() === false, activeSubagents.size),
			retries: 0,
		};
		clearActivityRetry();
		void flushActivity();
	};

	const prepareActivityReporter = async (ctx: ExtensionContext): Promise<void> => {
		const activationEpoch = ++activityReporterEpoch;
		reporterActive = false;
		currentSessionContext = undefined;
		desiredActivity = undefined;
		activeSubagents.clear();
		clearActivityRetry();

		reconstructAliases(ctx, aliases, aliasOrder);
		await refreshHerdrActivation(pi, ctx, getState);
		if (activationEpoch !== activityReporterEpoch) return;

		currentSessionContext = ctx;
		reporterActive = ctx.hasUI === true;
		reportActivity();
	};

	pi.on("session_start", async (_event, ctx) => {
		await prepareActivityReporter(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await prepareActivityReporter(ctx);
	});

	pi.on("agent_start", () => {
		reportActivity();
	});

	pi.on("agent_end", () => {
		reportActivity();
	});

	pi.events.on("task:subagent:lifecycle", event => {
		if (!reporterActive || !isSubagentLifecycleEvent(event) || typeof event.id !== "string") return;
		if (event.status === "started") activeSubagents.add(event.id);
		else if (event.status === "completed" || event.status === "failed" || event.status === "aborted")
			activeSubagents.delete(event.id);
		else return;
		reportActivity();
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructAliases(ctx, aliases, aliasOrder);
	});

	pi.registerCommand("herdr", {
		description: "Inspect Herdr pane integration status",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action !== "status") {
				ctx.ui.notify("Usage: /herdr status", "warning");
				return;
			}
			state = await getState();
			ctx.ui.notify(formatHerdrStatus(state), state.available ? "info" : "warning");
		},
	});

	const z = pi.zod;

	pi.registerTool({
		name: "herdr_status",
		label: "Herdr Status",
		description: "Reports whether this OMP session can control Herdr panes.",
		approval: "read",
		parameters: z.object({}),
		async execute() {
			state = await getState();
			return { content: [{ type: "text", text: formatHerdrStatus(state) }], details: state };
		},
	});

	pi.registerTool({
		name: "herdr_list_panes",
		label: "Herdr List Panes",
		description: "Lists panes in the current Herdr tab.",
		approval: "read",
		defaultInactive: true,
		parameters: z.object({
			includeJson: z
				.boolean()
				.optional()
				.describe("Include raw Herdr layout JSON in details; text summary is always returned."),
		}),
		async execute(_toolCallId, params) {
			const identity = await requireAvailable();
			const layout = await request<unknown>(identity, "pane.layout", { pane_id: identity.paneId });
			return {
				content: [{ type: "text", text: formatPaneLayout(identity, layout) }],
				details: params.includeJson ? layout : { workspaceId: identity.workspaceId, tabId: identity.tabId },
			};
		},
	});

	pi.registerTool({
		name: "herdr_spawn_agent",
		label: "Herdr Spawn Agent",
		description: "Starts a visible Herdr-managed agent process in the current Herdr tab.",
		approval: "exec",
		defaultInactive: true,
		parameters: z.object({
			name: z
				.string()
				.min(1)
				.max(64)
				.regex(/^[A-Za-z0-9._-]+$/)
				.describe("Herdr agent label/target name."),
			kind: z
				.enum(["claude", "argv"])
				.describe("claude builds a Claude Code command; argv runs the provided argv unchanged."),
			prompt: z
				.string()
				.optional()
				.describe("Required for kind=claude; passed as Claude Code's final positional prompt."),
			model: z.string().optional().describe("Optional Claude model for kind=claude, e.g. opus or sonnet."),
			argv: z
				.array(z.string().min(1))
				.optional()
				.describe("Required for kind=argv; executable and arguments after Herdr's -- separator."),
			cwd: z
				.string()
				.optional()
				.describe("Working directory for the new Herdr agent process; defaults to the current OMP ctx.cwd."),
			direction: z.enum(["right", "down"]).optional(),
			env: z
				.record(z.string(), z.string())
				.optional()
				.describe("Extra environment variables for Herdr to inject into the launched process."),
			focus: z.boolean().optional().describe("Whether Herdr should focus the new pane. Defaults false."),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const identity = await requireAvailable();
			const args = buildSpawnAgentArgs(identity, params as SpawnAgentParams, ctx.cwd);
			const result = await runHerdrResult(pi, identity, args, ctx);
			const parsed = parseJson(result.stdout);
			return {
				content: [{ type: "text", text: result.stdout }],
				details: parsed ?? { stdout: result.stdout, stderr: result.stderr },
			};
		},
	});

	pi.registerTool({
		name: "herdr_read_pane",
		label: "Herdr Read Pane",
		description: "Reads visible or recent text from a Herdr pane.",
		approval: "read",
		defaultInactive: true,
		parameters: z.object({
			pane_id: z.string().min(1),
			source: z.enum(["visible", "recent", "recent-unwrapped"]).optional(),
			lines: z.number().int().min(1).max(500).optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const identity = await requireAvailable();
			const readParams = params as ReadPaneParams;
			const text = await runHerdr(
				pi,
				identity,
				[
					"pane",
					"read",
					readParams.pane_id,
					"--source",
					readParams.source ?? "recent",
					"--lines",
					String(readParams.lines ?? 80),
					"--format",
					"text",
				],
				ctx,
			);
			return { content: [{ type: "text", text }], details: { pane_id: readParams.pane_id } };
		},
	});

	pi.registerTool({
		name: "herdr_send_pane",
		label: "Herdr Send Pane",
		description: "Sends text and/or keys to a Herdr pane.",
		approval: "exec",
		defaultInactive: true,
		parameters: z.object({
			pane_id: z.string().min(1),
			text: z.string().optional(),
			keys: z.array(z.string().min(1)).optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const identity = await requireAvailable();
			const sendParams = params as SendPaneParams;
			if (sendParams.text === undefined && (!sendParams.keys || sendParams.keys.length === 0)) {
				throw new Error("herdr_send_pane requires text or keys");
			}
			const outputs: string[] = [];
			if (sendParams.text !== undefined) {
				outputs.push(await runHerdr(pi, identity, ["pane", "send-text", sendParams.pane_id, sendParams.text], ctx));
			}
			if (sendParams.keys?.length) {
				outputs.push(
					await runHerdr(pi, identity, ["pane", "send-keys", sendParams.pane_id, ...sendParams.keys], ctx),
				);
			}
			const text = outputs.filter(Boolean).join("\n") || "sent";
			return { content: [{ type: "text", text }], details: { pane_id: sendParams.pane_id } };
		},
	});

	pi.registerTool({
		name: "herdr",
		label: "Herdr Control",
		description:
			"Controls Herdr workspaces, tabs, panes, and agents. Preserves focus unless explicitly requested; use run for atomic command submission.",
		approval: "exec",
		defaultInactive: true,
		parameters: z.object({
			action: z.enum(HERDR_CONTROL_ACTIONS),
			pane: z.string().min(1).optional().describe("Pane id or remembered alias."),
			panes: z.array(z.string().min(1)).optional().describe("Pane ids or aliases for wait_agent."),
			workspace: z.string().min(1).optional(),
			tab: z.string().min(1).optional(),
			label: z.string().min(1).optional(),
			newPane: z.string().min(1).optional().describe("Alias remembered for a new split pane."),
			direction: z.enum(["right", "down"]).optional(),
			agent: z.string().min(1).optional(),
			command: z.string().min(1).optional().describe("Command submitted atomically by run."),
			match: z.string().min(1).optional().describe("Output text or regex watched by watch."),
			regex: z.boolean().optional(),
			status: z.enum(HERDR_AGENT_STATUSES).optional(),
			statuses: z.array(z.enum(HERDR_AGENT_STATUSES)).optional(),
			mode: z.enum(["all", "any"]).optional(),
			timeout: z.number().int().min(1).optional().describe("Timeout in milliseconds."),
			lines: z.number().int().min(1).max(500).optional(),
			source: z.enum(["visible", "recent", "recent-unwrapped", "detection"]).optional(),
			raw: z.boolean().optional(),
			text: z.string().optional(),
			keys: z.string().optional().describe("Space-separated literal keys for send."),
			cwd: z.string().min(1).optional(),
			focus: z.boolean().optional(),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const identity = await requireAvailable();
			return executeHerdrControl(pi, identity, params as HerdrControlParams, ctx, signal, aliases, aliasOrder);
		},
	});
}

export function detectHerdrEnv(env: NodeJS.ProcessEnv = process.env): HerdrIdentity | undefined {
	if (env.HERDR_ENV !== "1") return undefined;
	const socketPath = env.HERDR_SOCKET_PATH;
	const workspaceId = env.HERDR_WORKSPACE_ID;
	const tabId = env.HERDR_TAB_ID;
	const paneId = env.HERDR_PANE_ID;
	if (!socketPath || !workspaceId || !tabId || !paneId) return undefined;
	return {
		binPath: env.HERDR_BIN_PATH || "herdr",
		socketPath,
		workspaceId,
		tabId,
		paneId,
	};
}

export async function herdrRequest<T>(
	identity: HerdrIdentity,
	method: string,
	params: Record<string, unknown>,
	timeoutMs = 3000,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		let buffer = "";
		let settled = false;
		const socket = net.createConnection(identity.socketPath);
		const finish = (error: Error | undefined, value?: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.removeAllListeners();
			if (!socket.destroyed) socket.end();
			if (error) reject(error);
			else resolve(value as T);
		};
		const timer = setTimeout(() => {
			if (!socket.destroyed) socket.destroy();
			finish(new Error(`Herdr socket request timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ id, method, params })}\n`);
		});
		socket.on("data", chunk => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line) continue;
				let response: { id?: unknown; result?: T; error?: unknown };
				try {
					response = JSON.parse(line) as { id?: unknown; result?: T; error?: unknown };
				} catch (error) {
					finish(error instanceof Error ? error : new Error("Invalid Herdr socket JSON response"));
					return;
				}
				if (response.id !== id) continue;
				if (response.error !== undefined) {
					finish(new Error(`Herdr socket error: ${formatErrorValue(response.error)}`));
					return;
				}
				if (!("result" in response)) {
					finish(new Error("Herdr socket response missing result"));
					return;
				}
				finish(undefined, response.result as T);
				return;
			}
		});
		socket.on("error", error => finish(error));
		socket.on("end", () => finish(new Error("Herdr socket closed before response")));
		socket.on("close", () => finish(new Error("Herdr socket closed before response")));
	});
}

export async function getHerdrState(): Promise<HerdrState> {
	const identity = detectHerdrEnv();
	if (!identity) return { available: false, reason: HERDR_UNAVAILABLE_REASON };
	try {
		await herdrRequest(identity, "ping", {});
		return { available: true, identity, reason: "available" };
	} catch (error) {
		return { available: false, identity, reason: `Herdr socket ping failed: ${errorMessage(error)}` };
	}
}

export async function requireHerdr(getState: HerdrGetState = getHerdrState): Promise<HerdrIdentity> {
	const current = await getState();
	if (current.available && current.identity) return current.identity;
	throw new Error(`pi-herdr unavailable: ${current.reason}`);
}

export async function runHerdr(
	pi: ExtensionAPI,
	identity: HerdrIdentity,
	args: string[],
	ctx: ExtensionContext,
	timeoutMs = 30000,
	signal?: AbortSignal,
): Promise<string> {
	return (await runHerdrResult(pi, identity, args, ctx, timeoutMs, signal)).stdout;
}

async function runHerdrJson<T>(
	pi: ExtensionAPI,
	identity: HerdrIdentity,
	args: string[],
	ctx: ExtensionContext,
	signal?: AbortSignal,
	timeoutMs: number | null = 30000,
): Promise<T> {
	const result = await runHerdrResult(pi, identity, args, ctx, timeoutMs, signal);
	const response = asRecord(parseJson(result.stdout));
	if (!response) throw new Error(`Expected JSON output from herdr ${args.join(" ")}`);
	if (response.error !== undefined) {
		throw new HerdrCommandError(`Herdr command error: ${formatErrorValue(response.error)}`, response.error);
	}
	if (!("result" in response)) throw new Error(`Herdr JSON response missing result for ${args.join(" ")}`);
	return response.result as T;
}

function rememberAlias(
	aliases: Map<string, ManagedPane>,
	aliasOrder: string[],
	alias: string,
	pane: HerdrPaneInfo,
): void {
	aliases.set(alias, { paneId: pane.pane_id, workspaceId: pane.workspace_id });
	const priorIndex = aliasOrder.indexOf(alias);
	if (priorIndex !== -1) aliasOrder.splice(priorIndex, 1);
	aliasOrder.push(alias);
}

function forgetAlias(aliases: Map<string, ManagedPane>, aliasOrder: string[], alias: string): void {
	aliases.delete(alias);
	const index = aliasOrder.indexOf(alias);
	if (index !== -1) aliasOrder.splice(index, 1);
}

function controlResult(
	text: string,
	details: Record<string, unknown>,
	aliases: Map<string, ManagedPane>,
	aliasOrder: string[],
): HerdrControlResult {
	const aliasSnapshot = Object.fromEntries([...aliases].map(([alias, pane]) => [alias, { ...pane }]));
	return {
		content: [{ type: "text", text }],
		details: { ...details, aliases: aliasSnapshot, aliasOrder: [...aliasOrder] },
	};
}

function reconstructAliases(ctx: ExtensionContext, aliases: Map<string, ManagedPane>, aliasOrder: string[]): void {
	let latestAliases: Map<string, ManagedPane> | undefined;
	let latestOrder: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== "herdr") continue;
		const details = asRecord(message.details);
		const savedAliases = asRecord(details?.aliases);
		if (!savedAliases) continue;

		const reconstructed = new Map<string, ManagedPane>();
		for (const [alias, value] of Object.entries(savedAliases)) {
			const saved = asRecord(value);
			const paneId = stringField(saved, "paneId") ?? stringField(saved, "pane_id");
			const workspaceId = stringField(saved, "workspaceId") ?? stringField(saved, "workspace_id");
			if (paneId && workspaceId) reconstructed.set(alias, { paneId, workspaceId });
		}
		latestAliases = reconstructed;
		latestOrder = Array.isArray(details?.aliasOrder)
			? details.aliasOrder.filter((value): value is string => typeof value === "string" && value.length > 0)
			: [...reconstructed.keys()];
	}

	aliases.clear();
	aliasOrder.length = 0;
	if (!latestAliases) return;
	for (const [alias, pane] of latestAliases) aliases.set(alias, pane);
	for (const alias of latestOrder) {
		if (aliases.has(alias)) aliasOrder.push(alias);
	}
	for (const alias of aliases.keys()) {
		if (!aliasOrder.includes(alias)) aliasOrder.push(alias);
	}
}

async function resolvePaneReference(
	pi: ExtensionAPI,
	identity: HerdrIdentity,
	ref: string,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	aliases: Map<string, ManagedPane>,
	aliasOrder: string[],
): Promise<{ pane: HerdrPaneInfo; alias?: string }> {
	const managed = aliases.get(ref);
	const paneId = managed?.paneId ?? ref;
	try {
		const response = await runHerdrJson<{ pane: HerdrPaneInfo }>(pi, identity, ["pane", "get", paneId], ctx, signal);
		if (!response.pane) throw new Error(`Pane '${ref}' not found.`);
		if (managed) managed.workspaceId = response.pane.workspace_id;
		const alias = managed
			? ref
			: [...aliases.entries()].find(([, candidate]) => candidate.paneId === response.pane.pane_id)?.[0];
		return { pane: response.pane, alias };
	} catch (error) {
		if (managed && isDefinitivePaneNotFound(error)) forgetAlias(aliases, aliasOrder, ref);
		throw error;
	}
}

function summarizePane(pane: HerdrPaneInfo, alias?: string, currentPaneId?: string): string {
	const name = alias ?? pane.label ?? pane.pane_id;
	const flags = [
		pane.pane_id === currentPaneId || pane.focused ? "current" : undefined,
		pane.agent,
		pane.agent_status === "unknown" ? undefined : pane.agent_status,
	]
		.filter((value): value is string => Boolean(value))
		.join(", ");
	return `${name}: [${pane.pane_id}]${flags ? ` (${flags})` : ""}${pane.cwd ? ` ${pane.cwd}` : ""}`;
}

function summarizeAgent(agent: HerdrAgentInfo): string {
	const name = agent.name ?? agent.display_agent ?? agent.agent ?? agent.pane_id;
	const flags = [agent.focused ? "focused" : undefined, agent.agent_status].filter((value): value is string =>
		Boolean(value),
	);
	return `${name}: [${agent.pane_id}] (${flags.join(", ")})${agent.cwd ? ` ${agent.cwd}` : ""}`;
}

function waitForStatusPoll(signal: AbortSignal | undefined): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (!signal) {
		setTimeout(resolve, 250);
		return promise;
	}
	if (signal.aborted) {
		reject(new Error("wait_agent canceled."));
		return promise;
	}
	const timer = setTimeout(() => {
		signal.removeEventListener("abort", onAbort);
		resolve();
	}, 250);
	const onAbort = () => {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
		reject(new Error("wait_agent canceled."));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	return promise;
}

async function executeHerdrControl(
	pi: ExtensionAPI,
	identity: HerdrIdentity,
	params: HerdrControlParams,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	aliases: Map<string, ManagedPane>,
	aliasOrder: string[],
): Promise<HerdrControlResult> {
	if (signal?.aborted) throw new Error(`${params.action} canceled.`);
	const currentResponse = await runHerdrJson<{ pane: HerdrPaneInfo }>(
		pi,
		identity,
		["pane", "current", "--current"],
		ctx,
		signal,
	);
	const currentPane = currentResponse.pane;

	switch (params.action) {
		case "list": {
			const response = await runHerdrJson<{ panes?: HerdrPaneInfo[] }>(
				pi,
				identity,
				["pane", "list", "--workspace", currentPane.workspace_id],
				ctx,
				signal,
			);
			const panes = response.panes ?? [];
			const aliasesByPane = new Map<string, string>();
			for (const [alias, pane] of aliases) {
				if (pane.workspaceId === currentPane.workspace_id) aliasesByPane.set(pane.paneId, alias);
			}
			return controlResult(
				panes.length
					? panes.map(pane => summarizePane(pane, aliasesByPane.get(pane.pane_id), currentPane.pane_id)).join("\n")
					: "No panes in current workspace.",
				{
					action: "list",
					panes,
					currentPaneId: currentPane.pane_id,
					workspaceId: currentPane.workspace_id,
					paneAliases: Object.fromEntries(aliasesByPane),
				},
				aliases,
				aliasOrder,
			);
		}

		case "current":
			return controlResult(
				summarizePane(currentPane, undefined, currentPane.pane_id),
				{ action: "current", pane: currentPane },
				aliases,
				aliasOrder,
			);

		case "workspace_list": {
			const response = await runHerdrJson<{ workspaces?: HerdrWorkspaceInfo[] }>(
				pi,
				identity,
				["workspace", "list"],
				ctx,
				signal,
			);
			const workspaces = response.workspaces ?? [];
			const text = workspaces.length
				? workspaces
						.map(
							workspace =>
								`${workspace.label}: [${workspace.workspace_id}]${workspace.focused ? " (focused)" : ""}`,
						)
						.join("\n")
				: "No workspaces.";
			return controlResult(text, { action: "workspace_list", workspaces }, aliases, aliasOrder);
		}

		case "workspace_create": {
			const args = ["workspace", "create"];
			if (params.cwd) args.push("--cwd", params.cwd);
			if (params.label) args.push("--label", params.label);
			if (params.focus !== true) args.push("--no-focus");
			const response = await runHerdrJson<{ workspace: HerdrWorkspaceInfo; root_pane?: HerdrPaneInfo }>(
				pi,
				identity,
				args,
				ctx,
				signal,
			);
			if (params.pane && response.root_pane) rememberAlias(aliases, aliasOrder, params.pane, response.root_pane);
			const rootPaneText = response.root_pane
				? `, root pane ${response.root_pane.pane_id}${params.pane ? ` aliased as '${params.pane}'` : ""}`
				: "";
			return controlResult(
				`Created workspace '${response.workspace.label}' (${response.workspace.workspace_id})${rootPaneText}`,
				{ action: "workspace_create", workspace: response.workspace, rootPaneId: response.root_pane?.pane_id },
				aliases,
				aliasOrder,
			);
		}

		case "workspace_focus": {
			if (!params.workspace) throw new Error("'workspace' is required for workspace_focus");
			const response = await runHerdrJson<{ workspace: HerdrWorkspaceInfo }>(
				pi,
				identity,
				["workspace", "focus", params.workspace],
				ctx,
				signal,
			);
			return controlResult(
				`Focused workspace '${response.workspace.label}'`,
				{ action: "workspace_focus", workspace: response.workspace },
				aliases,
				aliasOrder,
			);
		}

		case "tab_list": {
			const workspaceId = params.workspace ?? currentPane.workspace_id;
			const response = await runHerdrJson<{ tabs?: HerdrTabInfo[] }>(
				pi,
				identity,
				["tab", "list", "--workspace", workspaceId],
				ctx,
				signal,
			);
			const tabs = response.tabs ?? [];
			const text = tabs.length
				? tabs.map(tab => `${tab.label}: [${tab.tab_id}]${tab.focused ? " (focused)" : ""}`).join("\n")
				: "No tabs.";
			return controlResult(text, { action: "tab_list", tabs, workspaceId }, aliases, aliasOrder);
		}

		case "tab_create": {
			const workspaceId = params.workspace ?? currentPane.workspace_id;
			const args = ["tab", "create", "--workspace", workspaceId];
			if (params.cwd) args.push("--cwd", params.cwd);
			if (params.label) args.push("--label", params.label);
			if (params.focus !== true) args.push("--no-focus");
			const response = await runHerdrJson<{ tab: HerdrTabInfo; root_pane?: HerdrPaneInfo }>(
				pi,
				identity,
				args,
				ctx,
				signal,
			);
			if (params.pane && response.root_pane) rememberAlias(aliases, aliasOrder, params.pane, response.root_pane);
			const rootPaneText = response.root_pane
				? `, root pane ${response.root_pane.pane_id}${params.pane ? ` aliased as '${params.pane}'` : ""}`
				: "";
			return controlResult(
				`Created tab '${response.tab.label}' (${response.tab.tab_id})${rootPaneText}`,
				{ action: "tab_create", tab: response.tab, rootPaneId: response.root_pane?.pane_id },
				aliases,
				aliasOrder,
			);
		}

		case "tab_focus": {
			if (!params.tab) throw new Error("'tab' is required for tab_focus");
			const response = await runHerdrJson<{ tab: HerdrTabInfo }>(
				pi,
				identity,
				["tab", "focus", params.tab],
				ctx,
				signal,
			);
			return controlResult(
				`Focused tab '${response.tab.label}'`,
				{ action: "tab_focus", tab: response.tab },
				aliases,
				aliasOrder,
			);
		}

		case "focus": {
			if (params.pane) {
				const target = await resolvePaneReference(pi, identity, params.pane, ctx, signal, aliases, aliasOrder);
				const response = await runHerdrJson<{ agent: HerdrAgentInfo }>(
					pi,
					identity,
					["agent", "focus", target.pane.pane_id],
					ctx,
					signal,
				);
				return controlResult(
					`Focused pane '${target.alias ?? params.pane}'`,
					{ action: "focus", target: "pane", agent: response.agent },
					aliases,
					aliasOrder,
				);
			}
			if (params.tab) {
				const response = await runHerdrJson<{ tab: HerdrTabInfo }>(
					pi,
					identity,
					["tab", "focus", params.tab],
					ctx,
					signal,
				);
				return controlResult(
					"Focused tab",
					{ action: "focus", target: "tab", tab: response.tab },
					aliases,
					aliasOrder,
				);
			}
			if (params.workspace) {
				const response = await runHerdrJson<{ workspace: HerdrWorkspaceInfo }>(
					pi,
					identity,
					["workspace", "focus", params.workspace],
					ctx,
					signal,
				);
				return controlResult(
					"Focused workspace",
					{ action: "focus", target: "workspace", workspace: response.workspace },
					aliases,
					aliasOrder,
				);
			}
			throw new Error("'workspace', 'tab', or 'pane' is required for focus");
		}

		case "pane_rename": {
			if (!params.pane) throw new Error("'pane' is required for pane_rename");
			if (!params.label) throw new Error("'label' is required for pane_rename");
			const target = await resolvePaneReference(pi, identity, params.pane, ctx, signal, aliases, aliasOrder);
			const response = await runHerdrJson<{ pane: HerdrPaneInfo }>(
				pi,
				identity,
				["pane", "rename", target.pane.pane_id, params.label],
				ctx,
				signal,
			);
			return controlResult(
				`Renamed pane '${target.alias ?? params.pane}' to '${params.label}'`,
				{ action: "pane_rename", pane: response.pane, alias: target.alias },
				aliases,
				aliasOrder,
			);
		}

		case "pane_split": {
			const source = params.pane
				? await resolvePaneReference(pi, identity, params.pane, ctx, signal, aliases, aliasOrder)
				: { pane: currentPane, alias: undefined };
			let direction = params.direction;
			if (!direction) {
				const response = await runHerdrJson<{ layout: HerdrPaneLayout }>(
					pi,
					identity,
					["pane", "layout", "--pane", source.pane.pane_id],
					ctx,
					signal,
				);
				const sourceRect = response.layout.panes.find(pane => pane.pane_id === source.pane.pane_id)?.rect;
				direction =
					sourceRect && sourceRect.width >= 80 && sourceRect.width >= sourceRect.height * 2 ? "right" : "down";
			}
			const args = ["pane", "split", source.pane.pane_id, "--direction", direction];
			if (params.cwd) args.push("--cwd", params.cwd);
			if (params.focus !== true) args.push("--no-focus");
			const response = await runHerdrJson<{ pane: HerdrPaneInfo }>(pi, identity, args, ctx, signal);
			const paneLabel = params.label ?? params.newPane;
			if (paneLabel) {
				await runHerdrJson<{ pane: HerdrPaneInfo }>(
					pi,
					identity,
					["pane", "rename", response.pane.pane_id, paneLabel],
					ctx,
					signal,
				);
			}
			if (params.newPane) rememberAlias(aliases, aliasOrder, params.newPane, response.pane);
			return controlResult(
				`Created pane '${response.pane.pane_id}' by splitting '${source.alias ?? params.pane ?? currentPane.pane_id}' ${direction}`,
				{
					action: "pane_split",
					pane: source.alias ?? params.pane ?? currentPane.pane_id,
					newPane: params.newPane ?? response.pane.pane_id,
					newPaneId: response.pane.pane_id,
					direction,
				},
				aliases,
				aliasOrder,
			);
		}

		case "agent_list": {
			const response = await runHerdrJson<{ agents?: HerdrAgentInfo[] }>(
				pi,
				identity,
				["agent", "list"],
				ctx,
				signal,
			);
			const agents = response.agents ?? [];
			return controlResult(
				agents.length ? agents.map(summarizeAgent).join("\n") : "No agents.",
				{ action: "agent_list", agents },
				aliases,
				aliasOrder,
			);
		}

		case "agent_get": {
			let target = params.agent ?? params.pane;
			if (!target) throw new Error("'agent' or 'pane' is required for agent_get");
			if (aliases.has(target))
				target = (await resolvePaneReference(pi, identity, target, ctx, signal, aliases, aliasOrder)).pane.pane_id;
			const response = await runHerdrJson<{ agent: HerdrAgentInfo }>(
				pi,
				identity,
				["agent", "get", target],
				ctx,
				signal,
			);
			return controlResult(
				summarizeAgent(response.agent),
				{ action: "agent_get", agent: response.agent },
				aliases,
				aliasOrder,
			);
		}

		case "run": {
			if (!params.pane) throw new Error("'pane' is required for run");
			if (!params.command) throw new Error("'command' is required for run");
			const target = await resolvePaneReference(pi, identity, params.pane, ctx, signal, aliases, aliasOrder);
			await runHerdrResult(pi, identity, ["pane", "run", target.pane.pane_id, params.command], ctx, 30000, signal);
			return controlResult(
				`Started '${params.command}' in pane '${target.alias ?? params.pane}' (${target.pane.pane_id})`,
				{
					action: "run",
					pane: target.alias ?? params.pane,
					paneId: target.pane.pane_id,
					command: params.command,
					workspaceId: target.pane.workspace_id,
				},
				aliases,
				aliasOrder,
			);
		}

		case "read": {
			if (!params.pane) throw new Error("'pane' is required for read");
			const target = await resolvePaneReference(pi, identity, params.pane, ctx, signal, aliases, aliasOrder);
			const args = [
				"pane",
				"read",
				target.pane.pane_id,
				"--source",
				params.source ?? "recent",
				"--lines",
				String(params.lines ?? 20),
			];
			if (params.raw) args.push("--raw");
			const text = await runHerdr(pi, identity, args, ctx, 30000, signal);
			return controlResult(
				text,
				{
					action: "read",
					pane: target.alias ?? params.pane,
					paneId: target.pane.pane_id,
					source: params.source ?? "recent",
				},
				aliases,
				aliasOrder,
			);
		}

		case "watch": {
			if (!params.pane) throw new Error("'pane' is required for watch");
			if (!params.match) throw new Error("'match' is required for watch");
			if (params.source === "detection")
				throw new Error("watch does not support source=detection; use read instead");
			const target = await resolvePaneReference(pi, identity, params.pane, ctx, signal, aliases, aliasOrder);
			const args = ["wait", "output", target.pane.pane_id, "--match", params.match];
			if (params.source) args.push("--source", params.source);
			if (params.lines !== undefined) args.push("--lines", String(params.lines));
			if (params.timeout !== undefined) args.push("--timeout", String(params.timeout));
			if (params.regex) args.push("--regex");
			if (params.raw) args.push("--raw");
			const matched = await runHerdrJson<{ matched_line?: string; read?: { text?: string } }>(
				pi,
				identity,
				args,
				ctx,
				signal,
				params.timeout === undefined ? null : params.timeout + HERDR_WATCH_TIMEOUT_GRACE_MS,
			);
			const matchedLine = matched.matched_line ?? "Output matched.";
			const text = matched.read?.text
				? `Matched: ${matchedLine}\n\n${matched.read.text}`
				: `Matched: ${matchedLine}`;
			return controlResult(
				text,
				{ action: "watch", pane: target.alias ?? params.pane, paneId: target.pane.pane_id, matchedLine },
				aliases,
				aliasOrder,
			);
		}

		// biome-ignore lint/suspicious/noFallthroughSwitchClause: the loop returns, throws, or awaits before its next iteration.
		case "wait_agent": {
			const paneRefs = params.panes?.length ? params.panes : params.pane ? [params.pane] : [];
			if (!paneRefs.length) throw new Error("'pane' or 'panes' is required for wait_agent");
			const acceptedStatuses: HerdrAgentStatus[] = params.statuses?.length
				? params.statuses
				: params.status
					? [params.status]
					: ["idle", "done"];
			const mode = params.mode ?? "all";
			const targets = await Promise.all(
				paneRefs.map(async paneRef => ({
					ref: paneRef,
					target: await resolvePaneReference(pi, identity, paneRef, ctx, signal, aliases, aliasOrder),
				})),
			);
			const deadline = params.timeout === undefined ? undefined : Date.now() + params.timeout;
			while (true) {
				if (signal?.aborted) throw new Error("wait_agent canceled.");
				const snapshot = await Promise.all(
					targets.map(async ({ ref, target }) => {
						const response = await runHerdrJson<{ pane: HerdrPaneInfo }>(
							pi,
							identity,
							["pane", "get", target.pane.pane_id],
							ctx,
							signal,
						);
						return {
							pane: target.alias ?? ref,
							paneId: response.pane.pane_id,
							status: response.pane.agent_status,
							agent: response.pane.agent,
						};
					}),
				);
				const satisfied =
					mode === "all"
						? snapshot.every(item => acceptedStatuses.includes(item.status))
						: snapshot.some(item => acceptedStatuses.includes(item.status));
				if (satisfied) {
					const summary = snapshot.map(item => `${item.pane}=${item.status}`).join(", ");
					return controlResult(
						`wait_agent satisfied (${mode}: ${acceptedStatuses.join("|")})\n\n${summary}`,
						{
							action: "wait_agent",
							panes: snapshot.map(item => item.pane),
							paneIds: snapshot.map(item => item.paneId),
							statuses: acceptedStatuses,
							mode,
							snapshot,
						},
						aliases,
						aliasOrder,
					);
				}
				if (deadline !== undefined && Date.now() >= deadline) {
					throw new Error(
						`Timed out waiting for panes [${snapshot.map(item => item.pane).join(", ")}] to reach ${mode} of statuses '${acceptedStatuses.join("|")}'. Last statuses: ${snapshot.map(item => `${item.pane}=${item.status}`).join(", ")}`,
					);
				}
				await waitForStatusPoll(signal);
			}
		}

		case "send": {
			if (!params.pane) throw new Error("'pane' is required for send");
			if (params.text === undefined && !params.keys?.trim())
				throw new Error("'text' or 'keys' is required for send");
			const target = await resolvePaneReference(pi, identity, params.pane, ctx, signal, aliases, aliasOrder);
			if (params.text !== undefined) {
				await runHerdrResult(
					pi,
					identity,
					["pane", "send-text", target.pane.pane_id, params.text],
					ctx,
					30000,
					signal,
				);
			}
			const keys = params.keys?.trim().split(/\s+/).filter(Boolean) ?? [];
			if (keys.length) {
				await runHerdrResult(pi, identity, ["pane", "send-keys", target.pane.pane_id, ...keys], ctx, 30000, signal);
			}
			return controlResult(
				`Sent to pane '${target.alias ?? params.pane}'`,
				{ action: "send", pane: target.alias ?? params.pane, paneId: target.pane.pane_id, text: params.text, keys },
				aliases,
				aliasOrder,
			);
		}

		case "stop": {
			if (!params.pane) throw new Error("'pane' is required for stop");
			if (params.pane === currentPane.pane_id) throw new Error("Refusing to close the pane pi is running in.");
			const target = await resolvePaneReference(pi, identity, params.pane, ctx, signal, aliases, aliasOrder);
			if (target.pane.pane_id === currentPane.pane_id)
				throw new Error("Refusing to close the pane pi is running in.");
			await runHerdrResult(pi, identity, ["pane", "close", target.pane.pane_id], ctx, 30000, signal);
			if (target.alias) forgetAlias(aliases, aliasOrder, target.alias);
			return controlResult(
				`Closed pane '${target.alias ?? params.pane}'`,
				{ action: "stop", pane: target.alias ?? params.pane, paneId: target.pane.pane_id },
				aliases,
				aliasOrder,
			);
		}
	}
}

export function buildSpawnAgentArgs(identity: HerdrIdentity, params: SpawnAgentParams, defaultCwd: string): string[] {
	const cwd = params.cwd ?? defaultCwd;
	const direction = params.direction ?? "right";
	const focusArg = (params.focus ?? false) ? "--focus" : "--no-focus";
	let commandArgv: string[];
	if (params.kind === "claude") {
		if (!params.prompt?.trim()) throw new Error("herdr_spawn_agent kind=claude requires prompt");
		commandArgv = [
			"claude",
			"--dangerously-skip-permissions",
			...(params.model ? ["--model", params.model] : []),
			params.prompt,
		];
	} else {
		if (!params.argv?.length) throw new Error("herdr_spawn_agent kind=argv requires argv");
		commandArgv = params.argv;
	}
	const envArgs = Object.entries(params.env ?? {})
		.sort(([left], [right]) => left.localeCompare(right))
		.flatMap(([key, value]) => ["--env", `${key}=${value}`]);
	return [
		"agent",
		"start",
		params.name,
		"--cwd",
		cwd,
		"--tab",
		identity.tabId,
		"--split",
		direction,
		focusArg,
		...envArgs,
		"--",
		...commandArgv,
	];
}

export function formatHerdrStatus(current: HerdrState): string {
	const lines = [`Herdr status: ${current.available ? "available" : "unavailable"}`, `Reason: ${current.reason}`];
	if (current.identity) {
		lines.push(
			`binPath: ${current.identity.binPath}`,
			`socketPath: ${current.identity.socketPath}`,
			`workspaceId: ${current.identity.workspaceId}`,
			`tabId: ${current.identity.tabId}`,
			`paneId: ${current.identity.paneId}`,
		);
	}
	return lines.join("\n");
}

async function refreshHerdrActivation(pi: ExtensionAPI, ctx: ExtensionContext, getState: HerdrGetState): Promise<void> {
	state = await getState();
	const next = new Set(pi.getActiveTools());
	next.add("herdr_status");
	if (state.available) {
		for (const tool of HERDR_CONTROL_TOOLS) next.add(tool);
	} else {
		for (const tool of HERDR_CONTROL_TOOLS) next.delete(tool);
	}
	await pi.setActiveTools([...next]);
	try {
		ctx.ui.setStatus?.("herdr", state.available ? "herdr:on" : "herdr:off");
	} catch {
		// Status UI failures must not block tool activation.
	}
}

async function runHerdrResult(
	pi: ExtensionAPI,
	identity: HerdrIdentity,
	args: string[],
	ctx: ExtensionContext,
	timeoutMs: number | null = 30000,
	signal?: AbortSignal,
): Promise<HerdrExecResult> {
	const result = await pi.exec(identity.binPath, args, { cwd: ctx.cwd, timeout: timeoutMs ?? undefined, signal });
	if (result.killed || result.code !== 0) {
		const stdoutResponse = asRecord(parseJson(result.stdout));
		const stderrResponse = asRecord(parseJson(result.stderr));
		const responseError = stdoutResponse?.error ?? stderrResponse?.error;
		const message = [
			`Herdr command failed: ${identity.binPath} ${args.join(" ")}`,
			`exit: ${result.code}`,
			`killed: ${result.killed}`,
			result.stdout ? `stdout:\n${result.stdout}` : undefined,
			result.stderr ? `stderr:\n${result.stderr}` : undefined,
		]
			.filter(Boolean)
			.join("\n");
		if (responseError !== undefined) throw new HerdrCommandError(message, responseError);
		throw new Error(message);
	}
	return result;
}

function formatPaneLayout(identity: HerdrIdentity, layout: unknown): string {
	const root = asRecord(layout);
	const layoutRecord = asRecord(root?.layout);
	const panes = Array.isArray(layoutRecord?.panes) ? layoutRecord.panes : undefined;
	if (!root || !layoutRecord || !panes) return JSON.stringify(layout, null, 2);
	const paneIds = panes.map(extractPaneId);
	if (paneIds.some(id => !id)) return JSON.stringify(layout, null, 2);
	const focusedPaneId = stringField(layoutRecord, "focused_pane_id") ?? stringField(layoutRecord, "focusedPaneId");
	const lines = ["Herdr panes:", `  workspace: ${identity.workspaceId}`, `  tab: ${identity.tabId}`];
	if (focusedPaneId) lines.push(`  focused: ${focusedPaneId}`);
	lines.push("  panes:", ...paneIds.map(id => `    - ${id}`));
	return lines.join("\n");
}

function extractPaneId(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	const record = asRecord(value);
	return stringField(record, "id") ?? stringField(record, "pane_id") ?? stringField(record, "paneId");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJson(value: string): unknown | undefined {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatErrorValue(error: unknown): string {
	if (typeof error === "string") return error;
	return JSON.stringify(error);
}
