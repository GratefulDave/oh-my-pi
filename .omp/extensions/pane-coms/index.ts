import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

interface CmuxIdentity {
	workspaceRef: string;
	surfaceRef: string;
	paneRef?: string;
}

interface RegistryEntry extends CmuxIdentity {
	name: string;
	socketPath: string;
	cwd: string;
	pid: number;
	updatedAt: number;
}

interface PaneMessage {
	id: string;
	from: string;
	to: string;
	body: string;
	createdAt: number;
	details?: unknown;
}

interface RuntimeState {
	identity?: CmuxIdentity;
	entry?: RegistryEntry;
	server?: net.Server;
	inbox: PaneMessage[];
	waiters: Array<(message: PaneMessage) => void>;
}

const state: RuntimeState = { inbox: [], waiters: [] };
const ROOT = path.join(os.homedir(), ".omp", "pane-coms");
const REGISTRY_FILE = path.join(ROOT, "registry.json");

export default function paneComsExtension(pi: ExtensionAPI): void {
	pi.setLabel("Pane Coms");

	pi.on("session_start", async (_event, ctx) => {
		await registerPane(pi, ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await registerPane(pi, ctx);
	});

	pi.on("session_shutdown", async () => {
		await shutdownPane(pi);
	});

	pi.registerCommand("pane-coms", {
		description: "List or inspect live OMP pane-coms peers",
		handler: async (args, ctx) => {
			const action = args.trim() || "list";
			if (action === "list") {
				ctx.ui.notify(formatRegistry(await readRegistry(), state.entry), "info");
				return;
			}
			if (action === "status") {
				ctx.ui.notify(formatStatus(state.entry, state.inbox), "info");
				return;
			}
			ctx.ui.notify("Usage: /pane-coms [list|status]", "warning");
		},
	});

	const z = pi.zod;
	pi.registerTool({
		name: "pane_list",
		label: "Pane List",
		description: "Lists OMP pane-coms peers in the current cmux workspace.",
		approval: "read",
		parameters: z.object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const entries = await peersInWorkspace();
			return { content: [{ type: "text", text: formatRegistry(entries, state.entry) }], details: entries };
		},
	});

	pi.registerTool({
		name: "pane_send",
		label: "Pane Send",
		description: "Sends a message to another live OMP pane-coms peer on this machine.",
		approval: "write",
		parameters: z.object({
			to: z.string().min(1).describe("Peer name, cmux surface_ref, or pane_ref."),
			message: z.string().min(1),
			details: z.string().optional().describe("Optional JSON-serialized metadata payload."),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const details = parsePaneDetails(params.details);
			const result = await sendToPeer(params.to, params.message, details);
			return { content: [{ type: "text", text: result }], details: { to: params.to } };
		},
	});

	pi.registerTool({
		name: "pane_await",
		label: "Pane Await",
		description: "Waits for a pane-coms message from another live OMP pane.",
		approval: "read",
		parameters: z.object({
			from: z.string().optional().describe("Optional sender name or cmux surface_ref filter."),
			timeoutMs: z.number().int().min(0).max(300000).optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const message = await awaitMessage(params.from, params.timeoutMs ?? 30000);
			if (!message) return { content: [{ type: "text", text: "No pane-coms message received before timeout." }] };
			return { content: [{ type: "text", text: formatMessage(message) }], details: message };
		},
	});
}

function parsePaneDetails(raw: string | undefined): unknown {
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

async function registerPane(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	await fs.mkdir(ROOT, { recursive: true });
	const identity = await identifyCmux(pi);
	const sessionName = pi.getSessionName?.() ?? "omp";
	const fallbackSurface = `${process.pid}`;
	state.identity = identity ?? { workspaceRef: "local", surfaceRef: fallbackSurface };
	const safeName = sanitizeName(`${sessionName}-${state.identity.surfaceRef}`);
	const socketPath = path.join(ROOT, `${safeName}.sock`);
	await fs.rm(socketPath, { force: true });
	state.server?.close();
	state.server = net.createServer(socket => handleSocket(pi, socket));
	await listen(state.server, socketPath);
	state.entry = {
		name: sessionName,
		workspaceRef: state.identity.workspaceRef,
		surfaceRef: state.identity.surfaceRef,
		paneRef: state.identity.paneRef,
		socketPath,
		cwd: ctx.cwd,
		pid: process.pid,
		updatedAt: Date.now(),
	};
	await upsertRegistry(state.entry);
	ctx.ui.setStatus("pane-coms", `pane:${state.entry.surfaceRef.slice(0, 8)}`);
}

async function shutdownPane(pi: ExtensionAPI): Promise<void> {
	state.server?.close();
	if (!state.entry) return;
	const registry = await readRegistry();
	await writeRegistry(registry.filter(entry => entry.socketPath !== state.entry?.socketPath));
	await fs.rm(state.entry.socketPath, { force: true });
	pi.logger.debug("pane-coms unregistered", { surfaceRef: state.entry.surfaceRef });
}

async function identifyCmux(pi: ExtensionAPI): Promise<CmuxIdentity | undefined> {
	try {
		const result = await pi.exec("cmux", ["--json", "identify"], { timeout: 3000 });
		if (result.code !== 0 || result.killed) return undefined;
		const parsed = JSON.parse(result.stdout) as { caller?: { workspace_ref?: string; surface_ref?: string; pane_ref?: string } };
		const workspaceRef = parsed.caller?.workspace_ref;
		const surfaceRef = parsed.caller?.surface_ref;
		if (!workspaceRef || !surfaceRef) return undefined;
		return { workspaceRef, surfaceRef, paneRef: parsed.caller?.pane_ref };
	} catch {
		return undefined;
	}
}

function handleSocket(pi: ExtensionAPI, socket: net.Socket): void {
	let data = "";
	socket.setEncoding("utf8");
	socket.on("data", chunk => {
		data += chunk;
	});
	socket.on("end", () => {
		try {
			const message = JSON.parse(data) as PaneMessage;
			state.inbox.push(message);
			const waiter = state.waiters.shift();
			if (waiter) waiter(message);
			pi.sendMessage(
				{
					customType: "pane-coms-message",
					content: `Pane message from ${message.from}:\n\n${message.body}`,
					display: true,
					details: message,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			socket.write("ok");
		} catch (error) {
			socket.write(error instanceof Error ? error.message : String(error));
		}
	});
}

async function sendToPeer(to: string, body: string, details: unknown): Promise<string> {
	const registry = await peersInWorkspace();
	const peer = registry.find(entry => entry.name === to || entry.surfaceRef === to || entry.paneRef === to);
	if (!peer) return `No pane-coms peer found for "${to}".`;
	const from = state.entry?.name ?? state.entry?.surfaceRef ?? `pid-${process.pid}`;
	const message: PaneMessage = { id: crypto.randomUUID(), from, to, body, details, createdAt: Date.now() };
	await connectAndWrite(peer.socketPath, JSON.stringify(message));
	return `Sent pane-coms message to ${peer.name} (${peer.surfaceRef}).`;
}

async function awaitMessage(from: string | undefined, timeoutMs: number): Promise<PaneMessage | undefined> {
	const existingIndex = state.inbox.findIndex(message => !from || message.from === from || message.from.includes(from));
	if (existingIndex !== -1) return state.inbox.splice(existingIndex, 1)[0];
	if (timeoutMs === 0) return undefined;
	const { promise, resolve } = Promise.withResolvers<PaneMessage | undefined>();
	const timer = setTimeout(() => resolve(undefined), timeoutMs);
	state.waiters.push(message => {
		clearTimeout(timer);
		if (!from || message.from === from || message.from.includes(from)) {
			resolve(message);
			return;
		}
		state.inbox.push(message);
		resolve(undefined);
	});
	return promise;
}

async function peersInWorkspace(): Promise<RegistryEntry[]> {
	const registry = await readRegistry();
	const workspaceRef = state.entry?.workspaceRef;
	return registry.filter(entry => entry.pid !== process.pid && (!workspaceRef || entry.workspaceRef === workspaceRef));
}

async function readRegistry(): Promise<RegistryEntry[]> {
	try {
		const parsed = JSON.parse(await Bun.file(REGISTRY_FILE).text()) as RegistryEntry[];
		return parsed.filter(entry => entry.socketPath && Date.now() - entry.updatedAt < 86_400_000);
	} catch {
		return [];
	}
}

async function writeRegistry(entries: RegistryEntry[]): Promise<void> {
	await fs.mkdir(ROOT, { recursive: true });
	await Bun.write(REGISTRY_FILE, JSON.stringify(entries, null, 2));
}

async function upsertRegistry(entry: RegistryEntry): Promise<void> {
	const registry = await readRegistry();
	await writeRegistry([...registry.filter(item => item.socketPath !== entry.socketPath), entry]);
}

function listen(server: net.Server, socketPath: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(socketPath, () => resolve());
	return promise;
}

function connectAndWrite(socketPath: string, payload: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const socket = net.createConnection(socketPath);
	socket.once("error", reject);
	socket.once("connect", () => socket.end(payload));
	socket.once("data", () => resolve());
	socket.once("close", () => resolve());
	return promise;
}

function sanitizeName(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || `omp-${process.pid}`;
}

function formatRegistry(entries: RegistryEntry[], current: RegistryEntry | undefined): string {
	const lines = ["Pane-coms peers:"];
	if (current) lines.push(`* ${current.name} ${current.surfaceRef} cwd=${current.cwd}`);
	for (const entry of entries) lines.push(`  ${entry.name} ${entry.surfaceRef} cwd=${entry.cwd}`);
	if (lines.length === 1) lines.push("  (none)");
	return lines.join("\n");
}

function formatStatus(entry: RegistryEntry | undefined, inbox: PaneMessage[]): string {
	return [`Pane-coms status:`, `  registered: ${entry ? "yes" : "no"}`, `  inbox: ${inbox.length}`].join("\n");
}

function formatMessage(message: PaneMessage): string {
	return [`From: ${message.from}`, `At: ${new Date(message.createdAt).toISOString()}`, "", message.body].join("\n");
}
