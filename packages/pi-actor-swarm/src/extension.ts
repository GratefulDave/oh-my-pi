// ---------------------------------------------------------------------------
// pi-actor-swarm — mailbox-driven multi-agent swarm coordination.
// ---------------------------------------------------------------------------

import { SwarmDashboard } from "./dashboard";
import {
	clearSwarm,
	exportSwarmLogs,
	getConfig,
	initSwarm,
	postMessage,
	type RoutingPolicy,
	type SwarmAgent,
	setProjectRoot,
} from "./mailbox";

interface SwarmTui {
	requestRender(): void;
}

interface SwarmUi {
	setEditorText(value: string): void;
	custom<T>(
		factory: (tui: SwarmTui, theme: CustomTheme, keybindings: unknown, done: (value: T) => void) => unknown,
		options: { overlay: boolean },
	): Promise<T>;
}

interface SwarmCommandContext {
	cwd: string;
	ui: SwarmUi;
}

interface SwarmExtensionApi {
	setLabel(value: string): void;
	registerCommand(
		name: string,
		command: {
			description: string;
			handler(args: string, ctx: SwarmCommandContext): Promise<void>;
		},
	): void;
}

type CustomTheme = {
	fg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
	dim?: (text: string) => string;
};

function normalizeTheme(theme: CustomTheme): {
	fg(color: string, text: string): string;
	bold(text: string): string;
	dim(text: string): string;
} {
	const rawFg = typeof theme.fg === "function" ? theme.fg.bind(theme) : undefined;
	const fg = (color: string, text: string): string => {
		if (!rawFg) return text;
		try {
			return rawFg(color, text);
		} catch {
			return text;
		}
	};
	const rawBold = typeof theme.bold === "function" ? theme.bold.bind(theme) : undefined;
	const bold = (text: string): string => {
		if (!rawBold) return text;
		try {
			return rawBold(text);
		} catch {
			return text;
		}
	};
	const rawDim = typeof theme.dim === "function" ? theme.dim.bind(theme) : undefined;
	const dim = (text: string): string => {
		if (!rawDim) return fg("dim", text);
		try {
			return rawDim(text);
		} catch {
			return fg("dim", text);
		}
	};
	return { fg, bold, dim };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSwarmInitArgs(args: string): { name: string; routingPolicy: RoutingPolicy; staleAgentTtlMs: number } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const name = tokens[0]?.startsWith("-") ? "default-swarm" : (tokens[0] ?? "default-swarm");
	let routingPolicy: RoutingPolicy = "priority";
	let staleAgentTtlMs = 30 * 60 * 1000;

	const policyIdx = tokens.findIndex(t => t === "--policy" || t === "-p");
	if (policyIdx >= 0 && policyIdx + 1 < tokens.length) {
		const val = tokens[policyIdx + 1];
		if (val === "round-robin" || val === "priority" || val === "broadcast" || val === "direct") {
			routingPolicy = val;
		}
	}

	const ttlIdx = tokens.indexOf("--stale-ttl-ms");
	if (ttlIdx >= 0 && ttlIdx + 1 < tokens.length) {
		const value = Number(tokens[ttlIdx + 1]);
		if (Number.isFinite(value) && value > 0) staleAgentTtlMs = value;
	}

	return { name, routingPolicy, staleAgentTtlMs };
}

const DEFAULT_AGENTS: SwarmAgent[] = [
	{
		id: "scout",
		role: "code investigator",
		model: "default",
		state: "idle",
		currentTask: null,
		sentCount: 0,
		receivedCount: 0,
		lastActivityMs: 0,
		stale: false,
	},
	{
		id: "builder",
		role: "implementer",
		model: "default",
		state: "idle",
		currentTask: null,
		sentCount: 0,
		receivedCount: 0,
		lastActivityMs: 0,
		stale: false,
	},
	{
		id: "reviewer",
		role: "code reviewer",
		model: "default",
		state: "idle",
		currentTask: null,
		sentCount: 0,
		receivedCount: 0,
		lastActivityMs: 0,
		stale: false,
	},
	{
		id: "qa",
		role: "tester",
		model: "default",
		state: "idle",
		currentTask: null,
		sentCount: 0,
		receivedCount: 0,
		lastActivityMs: 0,
		stale: false,
	},
];

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function actorSwarm(pi: SwarmExtensionApi): void {
	pi.setLabel("Actor Swarm");

	// /swarm init <name> [--policy <routing>] [--stale-ttl-ms <ms>]
	pi.registerCommand("swarm-init", {
		description: "Initialize a multi-agent swarm for coordination",
		handler: async (args, ctx) => {
			setProjectRoot(ctx.cwd);
			const { name, routingPolicy, staleAgentTtlMs } = parseSwarmInitArgs(args);
			initSwarm({
				name,
				agents: [...DEFAULT_AGENTS],
				routingPolicy,
				createdAt: Date.now(),
				staleAgentTtlMs,
			});
			ctx.ui.setEditorText(
				`Swarm "${name}" initialized with ${DEFAULT_AGENTS.length} agents (${routingPolicy} routing).\n\nUse /swarm-status to view, /swarm-send <agent> <message> to coordinate.`,
			);
		},
	});

	// /swarm-status — live TUI dashboard
	pi.registerCommand("swarm-status", {
		description: "Show swarm status dashboard",
		handler: async (_args, ctx) => {
			setProjectRoot(ctx.cwd);
			const cfg = getConfig();
			if (!cfg) {
				ctx.ui.setEditorText("No active swarm. Use /swarm-init to create one.");
				return;
			}

			ctx.ui.setEditorText("");

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const dashboard = new SwarmDashboard(
						normalizeTheme(theme),
						() => tui.requestRender(),
						() => done(undefined),
					);
					return dashboard;
				},
				{ overlay: true },
			);
		},
	});

	// /swarm-send <agent> <message>
	pi.registerCommand("swarm-send", {
		description: "Send a message to a swarm agent",
		handler: async (args, ctx) => {
			setProjectRoot(ctx.cwd);
			const cfg = getConfig();
			if (!cfg) {
				ctx.ui.setEditorText("No active swarm. Use /swarm-init to create one.");
				return;
			}

			// Parse: first token is agent ID, rest is message
			const spaceIdx = args.indexOf(" ");
			if (spaceIdx < 0) {
				ctx.ui.setEditorText(
					"Usage: /swarm-send <agent-id> <message>\n\nAvailable agents:\n" +
						cfg.agents.map(a => `  ${a.id} (${a.role}) — ${a.state}`).join("\n"),
				);
				return;
			}

			const agentId = args.slice(0, spaceIdx).trim();
			const message = args.slice(spaceIdx + 1).trim();

			if (!message) {
				ctx.ui.setEditorText(`Usage: /swarm-send ${agentId} <message>`);
				return;
			}

			const agent = cfg.agents.find(a => a.id === agentId);
			if (!agent) {
				ctx.ui.setEditorText(
					`Unknown agent "${agentId}". Available:\n${cfg.agents.map(a => `  ${a.id} (${a.role})`).join("\n")}`,
				);
				return;
			}

			const msg = postMessage({
				from: "user",
				to: agentId,
				subject: message.slice(0, 60),
				body: message,
				priority: "normal",
			});

			ctx.ui.setEditorText(
				`Message ${msg.id} sent to ${agentId}.\n\nUse /swarm-status to view the swarm dashboard.`,
			);
		},
	});

	// /swarm-logs export [path] — export history and final agent states as JSONL
	pi.registerCommand("swarm-logs", {
		description: "Export swarm message history and final agent states",
		handler: async (args, ctx) => {
			setProjectRoot(ctx.cwd);
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			if (tokens[0] !== "export") {
				ctx.ui.setEditorText("Usage: /swarm-logs export [path]");
				return;
			}
			const outputPath = exportSwarmLogs(tokens[1]);
			ctx.ui.setEditorText(`Swarm logs exported to ${outputPath}`);
		},
	});

	// /swarm-reset — clear swarm state
	pi.registerCommand("swarm-reset", {
		description: "Clear the active swarm",
		handler: async (_args, ctx) => {
			setProjectRoot(ctx.cwd);
			clearSwarm();
			ctx.ui.setEditorText("Swarm cleared.");
		},
	});
}
