// ---------------------------------------------------------------------------
// pi-actor-swarm — mailbox-driven multi-agent swarm coordination.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { SwarmDashboard } from "./dashboard";
import { clearSwarm, getConfig, initSwarm, postMessage, type RoutingPolicy, type SwarmAgent } from "./mailbox";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSwarmInitArgs(args: string): { name: string; routingPolicy: RoutingPolicy } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const name = tokens[0] ?? "default-swarm";
	let routingPolicy: RoutingPolicy = "priority";

	const policyIdx = tokens.findIndex(t => t === "--policy" || t === "-p");
	if (policyIdx >= 0 && policyIdx + 1 < tokens.length) {
		const val = tokens[policyIdx + 1];
		if (val === "round-robin" || val === "priority" || val === "broadcast" || val === "direct") {
			routingPolicy = val;
		}
	}

	return { name, routingPolicy };
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
	},
	{
		id: "builder",
		role: "implementer",
		model: "default",
		state: "idle",
		currentTask: null,
		sentCount: 0,
		receivedCount: 0,
	},
	{
		id: "reviewer",
		role: "code reviewer",
		model: "default",
		state: "idle",
		currentTask: null,
		sentCount: 0,
		receivedCount: 0,
	},
	{ id: "qa", role: "tester", model: "default", state: "idle", currentTask: null, sentCount: 0, receivedCount: 0 },
];

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function actorSwarm(pi: ExtensionAPI): void {
	pi.setLabel("Actor Swarm");

	// /swarm init <name> [--policy <routing>]
	pi.registerCommand("swarm-init", {
		description: "Initialize a multi-agent swarm for coordination",
		handler: async (args, ctx) => {
			const { name, routingPolicy } = parseSwarmInitArgs(args);
			initSwarm({
				name,
				agents: [...DEFAULT_AGENTS],
				routingPolicy,
				createdAt: Date.now(),
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
			const cfg = getConfig();
			if (!cfg) {
				ctx.ui.setEditorText("No active swarm. Use /swarm-init to create one.");
				return;
			}

			ctx.ui.setEditorText("");

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const dashboard = new SwarmDashboard(
						{ fg: theme.fg.bind(theme), bold: theme.bold.bind(theme), dim: theme.dim.bind(theme) },
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

	// /swarm-reset — clear swarm state
	pi.registerCommand("swarm-reset", {
		description: "Clear the active swarm",
		handler: async (_args, ctx) => {
			clearSwarm();
			ctx.ui.setEditorText("Swarm cleared.");
		},
	});
}
