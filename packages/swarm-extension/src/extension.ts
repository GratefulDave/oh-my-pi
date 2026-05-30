/**
 * Swarm Extension — Multi-agent pipeline orchestration from YAML definitions.
 *
 * Registers:
 * - /swarm run <file.yaml>   — Execute a swarm pipeline
 * - /swarm status <name>     — Show current pipeline status
 * - /swarm tasks <name>      — Show DAG-backed task board
 * - /swarm feed <name>       — Show durable event feed
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AuthStorage, ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { buildDependencyGraph, buildExecutionWaves, detectCycles } from "./swarm/dag";
import { renderSwarmEvents } from "./swarm/events";
import { formatDuration } from "./swarm/format";
import { loadSwarmInspection } from "./swarm/inspect";
import { PipelineController } from "./swarm/pipeline";
import { renderSwarmMeshSummary, renderSwarmProgress } from "./swarm/render";
import { claimReservation, readReservations, releaseReservation } from "./swarm/reservations";
import { initializeSwarmState, renderAgentStatusLines, resolveSwarmWorkspace } from "./swarm/runtime";
import { parseSwarmYaml, type SwarmDefinition, validateSwarmDefinition } from "./swarm/schema";
import type { StateTracker } from "./swarm/state";
import { renderSwarmTaskDetail, renderSwarmTasks } from "./swarm/tasks";

export default function swarmExtension(pi: ExtensionAPI): void {
	pi.setLabel("Swarm Orchestrator");

	pi.registerCommand("swarm", {
		description: "Run and inspect multi-agent swarm pipelines",
		getArgumentCompletions: prefix => {
			const subcommands = ["run", "status", "tasks", "task", "feed", "agents", "send", "reserve", "release", "help"];
			if (!prefix) return subcommands.map(s => ({ label: s, value: s }));
			return subcommands.filter(s => s.startsWith(prefix)).map(s => ({ label: s, value: s }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = parts[0] ?? "help";

			switch (subcommand) {
				case "run":
					await handleRun(parts[1], ctx, pi);
					return;
				case "status":
					await handleStatus(parts[1], ctx);
					return;
				case "tasks":
					await handleTasks(parts[1], ctx);
					return;
				case "task":
					await handleTask(parts[1], parts[2], ctx);
					return;
				case "feed":
					await handleFeed(parts.slice(1), ctx);
					return;
				case "agents":
					await handleAgents(parts[1], ctx);
					return;
				case "send":
					await handleSend(parts.slice(1), ctx);
					return;
				case "reserve":
					await handleReserve(parts.slice(1), ctx);
					return;
				case "release":
					await handleRelease(parts.slice(1), ctx);
					return;
				default:
					ctx.ui.notify(helpText(), "info");
					return;
			}
		},
	});
}

// ============================================================================
// /swarm run
// ============================================================================

async function handleRun(yamlPath: string | undefined, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	if (!yamlPath) {
		ctx.ui.notify("Usage: /swarm run <path/to/pipeline.yaml>", "error");
		return;
	}

	const resolvedPath = path.isAbsolute(yamlPath) ? yamlPath : path.resolve(ctx.cwd, yamlPath);

	let content: string;
	try {
		content = await Bun.file(resolvedPath).text();
	} catch {
		ctx.ui.notify(`Cannot read file: ${resolvedPath}`, "error");
		return;
	}

	let def: SwarmDefinition;
	try {
		def = parseSwarmYaml(content);
	} catch (err) {
		ctx.ui.notify(`YAML error: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}

	const validationErrors = validateSwarmDefinition(def);
	if (validationErrors.length > 0) {
		ctx.ui.notify(`Validation errors:\n${validationErrors.map(e => `  - ${e}`).join("\n")}`, "error");
		return;
	}

	const deps = buildDependencyGraph(def);
	const cycleNodes = detectCycles(deps);
	if (cycleNodes) {
		ctx.ui.notify(`Cycle detected in agent dependencies: [${cycleNodes.join(", ")}]`, "error");
		return;
	}
	const waves = buildExecutionWaves(deps);

	const workspace = resolveSwarmWorkspace(def, resolvedPath);

	await fs.mkdir(workspace, { recursive: true });

	const stateTracker = await initializeSwarmState(workspace, def);

	const agentList = [...def.agents.keys()].join(", ");
	const waveDesc = waves.map((w, i) => `wave ${i + 1}: [${w.join(", ")}]`).join("; ");
	pi.logger.debug("Swarm starting", {
		name: def.name,
		mode: def.mode,
		agents: agentList,
		waves: waveDesc,
		workspace,
	});

	ctx.ui.notify(
		`Starting swarm '${def.name}': ${def.agents.size} agents, ${waves.length} waves, ${def.targetCount} iteration(s)`,
		"info",
	);

	const widgetKey = `swarm-${def.name}`;
	const updateWidget = () => {
		const lines = renderSwarmProgress(stateTracker.state);
		ctx.ui.setWidget(widgetKey, lines);
	};
	updateWidget();

	let authStorage: AuthStorage | undefined;
	try {
		authStorage = await pi.pi.discoverAuthStorage();
	} catch {
		// Let runSubprocess discover auth per-agent as fallback.
	}

	const controller = new PipelineController(def, waves, stateTracker);

	const result = await controller.run({
		workspace,
		onProgress: () => updateWidget(),
		authStorage,
		modelRegistry: ctx.modelRegistry,
		settings: pi.pi.settings,
		runSubprocess: pi.pi.runSubprocess,
	});

	ctx.ui.setWidget(widgetKey, undefined);

	const elapsed = stateTracker.state.completedAt
		? formatDuration(stateTracker.state.completedAt - stateTracker.state.startedAt)
		: "unknown";

	const summaryParts = [
		`Swarm '${def.name}' ${result.status}`,
		`${result.iterations}/${def.targetCount} iterations`,
		`elapsed: ${elapsed}`,
	];

	if (result.errors.length > 0) {
		summaryParts.push(`${result.errors.length} error(s)`);
	}

	const summaryType = result.status === "completed" ? "info" : "error";
	ctx.ui.notify(summaryParts.join(" | "), summaryType);

	if (result.errors.length > 0) {
		pi.logger.warn("Swarm completed with errors", { errors: result.errors });
	}

	const summaryMessage = buildSummaryMessage(def, result, stateTracker, workspace);
	pi.sendMessage(
		{
			customType: "swarm-result",
			content: [{ type: "text", text: summaryMessage }],
			display: true,
			details: {
				swarmName: def.name,
				status: result.status,
				iterations: result.iterations,
				errorCount: result.errors.length,
			},
		},
		{ triggerTurn: false },
	);
}

// ============================================================================
// Inspection commands
// ============================================================================

async function handleStatus(name: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!name) {
		ctx.ui.notify("Usage: /swarm status <name>  (reads .swarm_<name>/state/pipeline.json from cwd)", "info");
		return;
	}
	try {
		const inspection = await loadSwarmInspection(name, ctx.cwd);
		const events = await inspection.stateTracker.readEvents({ limit: 8 });
		const reservations = await readReservations(inspection.stateTracker.swarmDir);
		ctx.ui.notify(renderSwarmMeshSummary(inspection.state, { events, reservations }).join("\n"), "info");
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
	}
}

async function handleTasks(name: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!name) {
		ctx.ui.notify("Usage: /swarm tasks <name>", "info");
		return;
	}
	try {
		const inspection = await loadSwarmInspection(name, ctx.cwd);
		ctx.ui.notify(renderSwarmTasks(inspection.tasks).join("\n"), "info");
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
	}
}

async function handleTask(
	name: string | undefined,
	agentName: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!name || !agentName) {
		ctx.ui.notify("Usage: /swarm task <name> <agent>", "info");
		return;
	}
	try {
		const inspection = await loadSwarmInspection(name, ctx.cwd);
		const task = inspection.tasks.find(t => t.name === agentName);
		if (!task) {
			ctx.ui.notify(`No agent '${agentName}' in swarm '${name}'`, "error");
			return;
		}
		ctx.ui.notify(renderSwarmTaskDetail(task).join("\n"), "info");
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
	}
}

async function handleFeed(args: string[], ctx: ExtensionCommandContext): Promise<void> {
	const name = args[0];
	if (!name) {
		ctx.ui.notify("Usage: /swarm feed <name> [--channel memory|pipeline]", "info");
		return;
	}
	const channel = parseChannelArg(args.slice(1));
	try {
		const inspection = await loadSwarmInspection(name, ctx.cwd);
		const events = await inspection.stateTracker.readEvents({ channel, limit: 30 });
		ctx.ui.notify(renderSwarmEvents(events).join("\n"), "info");
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
	}
}

async function handleAgents(name: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!name) {
		ctx.ui.notify("Usage: /swarm agents <name>", "info");
		return;
	}
	try {
		const inspection = await loadSwarmInspection(name, ctx.cwd);
		const lines = renderAgentStatusLines(inspection.state);
		ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No agents.", "info");
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
	}
}

async function handleSend(args: string[], ctx: ExtensionCommandContext): Promise<void> {
	const [name, to, ...messageParts] = args;
	const message = messageParts.join(" ").trim();
	if (!name || !to || !message) {
		ctx.ui.notify("Usage: /swarm send <name> <to> <message>", "info");
		return;
	}
	try {
		const inspection = await loadSwarmInspection(name, ctx.cwd);
		await inspection.stateTracker.appendEvent({
			type: "message",
			channel: "memory",
			from: "user",
			to,
			message,
		});
		ctx.ui.notify(`Message recorded for '${to}' in swarm '${name}'`, "info");
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
	}
}

async function handleReserve(args: string[], ctx: ExtensionCommandContext): Promise<void> {
	const [name, resource, ...reasonParts] = args;
	const reason = reasonParts.join(" ").trim() || undefined;
	if (!name || !resource) {
		ctx.ui.notify("Usage: /swarm reserve <name> <resource> [reason]", "info");
		return;
	}
	try {
		const inspection = await loadSwarmInspection(name, ctx.cwd);
		const result = await claimReservation(inspection.stateTracker.swarmDir, resource, "user", reason);
		if (!result.ok && result.conflict) {
			ctx.ui.notify(`Reservation conflict: ${resource} is held by ${result.conflict.holder}`, "error");
			return;
		}
		await inspection.stateTracker.appendEvent({
			type: "reservation.claim",
			channel: "pipeline",
			resource,
			from: "user",
			reason,
			message: `Reserved ${resource}`,
		});
		ctx.ui.notify(`Reserved ${resource}`, "info");
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
	}
}

async function handleRelease(args: string[], ctx: ExtensionCommandContext): Promise<void> {
	const [name, resource] = args;
	if (!name || !resource) {
		ctx.ui.notify("Usage: /swarm release <name> <resource>", "info");
		return;
	}
	try {
		const inspection = await loadSwarmInspection(name, ctx.cwd);
		const released = await releaseReservation(inspection.stateTracker.swarmDir, resource);
		if (!released) {
			ctx.ui.notify(`No reservation for ${resource}`, "info");
			return;
		}
		await inspection.stateTracker.appendEvent({
			type: "reservation.release",
			channel: "pipeline",
			resource,
			from: "user",
			message: `Released ${resource}`,
		});
		ctx.ui.notify(`Released ${resource}`, "info");
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
	}
}

// ============================================================================
// Helpers
// ============================================================================

function buildSummaryMessage(
	def: SwarmDefinition,
	result: { status: string; iterations: number; errors: string[] },
	stateTracker: StateTracker,
	workspace: string,
): string {
	const lines: string[] = [];
	lines.push(`## Swarm Pipeline: ${def.name}`);
	lines.push("");
	lines.push(`- **Status**: ${result.status}`);
	lines.push(`- **Mode**: ${def.mode}`);
	lines.push(`- **Iterations**: ${result.iterations}/${def.targetCount}`);
	lines.push(`- **Workspace**: ${workspace}`);
	lines.push(`- **State dir**: ${stateTracker.swarmDir}`);
	lines.push("");

	lines.push("### Agent Results");
	lines.push("");
	for (const [name, agent] of Object.entries(stateTracker.state.agents)) {
		const duration =
			agent.startedAt && agent.completedAt ? formatDuration(agent.completedAt - agent.startedAt) : "n/a";
		lines.push(`- **${name}**: ${agent.status} (${duration})${agent.error ? ` — ${agent.error}` : ""}`);
	}

	if (result.errors.length > 0) {
		lines.push("");
		lines.push("### Errors");
		lines.push("");
		for (const error of result.errors) {
			lines.push(`- ${error}`);
		}
	}

	lines.push("");
	lines.push("### Mesh commands");
	lines.push("");
	lines.push(`- /swarm status ${def.name}`);
	lines.push(`- /swarm tasks ${def.name}`);
	lines.push(`- /swarm feed ${def.name}`);
	lines.push(`- /swarm agents ${def.name}`);

	return lines.join("\n");
}

function parseChannelArg(args: string[]): string | undefined {
	const channelIndex = args.indexOf("--channel");
	if (channelIndex >= 0) return args[channelIndex + 1];
	return undefined;
}

function helpText(): string {
	return [
		"Swarm — multi-agent pipeline orchestrator",
		"",
		"  /swarm run <file.yaml>                  Run a pipeline",
		"  /swarm status <name>                   Show pipeline status + mesh summary",
		"  /swarm tasks <name>                    Show DAG task board",
		"  /swarm task <name> <agent>             Show one DAG task",
		"  /swarm feed <name> [--channel <name>]  Show event feed",
		"  /swarm agents <name>                   Show agent presence/status",
		"  /swarm send <name> <to> <message>      Record a mesh message",
		"  /swarm reserve <name> <resource> [why] Reserve a resource",
		"  /swarm release <name> <resource>       Release a resource",
		"  /swarm help                            Show this help",
	].join("\n");
}
