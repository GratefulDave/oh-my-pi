import * as net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

const HERDR_UNAVAILABLE_REASON =
	"not running inside a Herdr-managed pane (HERDR_ENV=1, HERDR_SOCKET_PATH, HERDR_WORKSPACE_ID, HERDR_TAB_ID, HERDR_PANE_ID required)";

export const HERDR_CONTROL_TOOLS = [
	"herdr_list_panes",
	"herdr_spawn_agent",
	"herdr_read_pane",
	"herdr_send_pane",
] as const;

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

let state: HerdrState = { available: false, reason: HERDR_UNAVAILABLE_REASON };

export default function herdrExtension(pi: ExtensionAPI): void {
	createHerdrExtension(pi);
}

export function createHerdrExtension(pi: ExtensionAPI, options: HerdrExtensionOptions = {}): void {
	pi.setLabel("herdr:\uf0c0");

	const request = options.request ?? herdrRequest;
	const getState = options.getState ?? getHerdrState;
	const requireAvailable = async (): Promise<HerdrIdentity> => requireHerdr(getState);

	pi.on("session_start", async (_event, ctx) => {
		await refreshHerdrActivation(pi, ctx, getState);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await refreshHerdrActivation(pi, ctx, getState);
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
): Promise<string> {
	return (await runHerdrResult(pi, identity, args, ctx, timeoutMs)).stdout;
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
	timeoutMs = 30000,
): Promise<HerdrExecResult> {
	const result = await pi.exec(identity.binPath, args, { cwd: ctx.cwd, timeout: timeoutMs });
	if (result.killed || result.code !== 0) {
		throw new Error(
			[
				`Herdr command failed: ${identity.binPath} ${args.join(" ")}`,
				`exit: ${result.code}`,
				`killed: ${result.killed}`,
				result.stdout ? `stdout:\n${result.stdout}` : undefined,
				result.stderr ? `stderr:\n${result.stderr}` : undefined,
			]
				.filter(Boolean)
				.join("\n"),
		);
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
