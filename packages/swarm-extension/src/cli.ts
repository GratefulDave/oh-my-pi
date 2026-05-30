#!/usr/bin/env bun
/**
 * Direct pipeline runner and mesh inspector.
 *
 * Usage:
 *   omp-swarm <path-to-yaml>
 *   omp-swarm tasks <yaml-or-name>
 *   omp-swarm task <yaml-or-name> <agent>
 *   omp-swarm feed <yaml-or-name> [--channel memory|pipeline]
 *   omp-swarm agents <yaml-or-name>
 *   omp-swarm send <yaml-or-name> <to> <message>
 *   omp-swarm reserve <yaml-or-name> <resource> [reason]
 *   omp-swarm release <yaml-or-name> <resource>
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildDependencyGraph, buildExecutionWaves, detectCycles } from "./swarm/dag";
import { renderSwarmEvents } from "./swarm/events";
import { loadSwarmInspection } from "./swarm/inspect";
import { claimReservation, readReservations, releaseReservation, renderReservations } from "./swarm/reservations";
import { initializeSwarmState, renderAgentStatusLines, resolveSwarmWorkspace } from "./swarm/runtime";
import { parseSwarmYaml, validateSwarmDefinition } from "./swarm/schema";
import { renderSwarmTaskDetail, renderSwarmTasks } from "./swarm/tasks";

const [, , commandOrYaml, ...rest] = process.argv;

if (!commandOrYaml) {
	usage(1);
}

switch (commandOrYaml) {
	case "tasks":
		await printTasks(rest[0]);
		break;
	case "task":
		await printTask(rest[0], rest[1]);
		break;
	case "feed":
		await printFeed(rest);
		break;
	case "agents":
		await printAgents(rest[0]);
		break;
	case "send":
		await sendMessage(rest);
		break;
	case "reserve":
		await reserveResource(rest);
		break;
	case "release":
		await releaseResource(rest);
		break;
	case "status":
		await printStatus(rest[0]);
		break;
	case "help":
	case "--help":
	case "-h":
		usage(0);
		break;
	default:
		await runPipeline(commandOrYaml);
		break;
}

async function runPipeline(yamlPath: string): Promise<void> {
	const resolvedPath = path.resolve(yamlPath);
	console.log(`Reading: ${resolvedPath}`);

	const content = await Bun.file(resolvedPath).text();
	const def = parseSwarmYaml(content);

	console.log(`Swarm: ${def.name}`);
	console.log(`Mode: ${def.mode}`);
	console.log(`Target count: ${def.targetCount}`);
	console.log(`Agents: ${[...def.agents.keys()].join(", ")}`);

	const errors = validateSwarmDefinition(def);
	if (errors.length > 0) {
		console.error("Validation errors:", errors);
		process.exit(1);
	}

	const deps = buildDependencyGraph(def);
	const cycles = detectCycles(deps);
	if (cycles) {
		console.error("Cycle detected:", cycles);
		process.exit(1);
	}
	const waves = buildExecutionWaves(deps);
	console.log(`Waves: ${waves.map((w, i) => `W${i + 1}:[${w.join(",")}]`).join(" -> ")}`);

	const workspace = resolveSwarmWorkspace(def, resolvedPath);

	await fs.mkdir(workspace, { recursive: true });
	console.log(`Workspace: ${workspace}`);

	const stateTracker = await initializeSwarmState(workspace, def);

	const [{ discoverAuthStorage, runSubprocess }, { ModelRegistry }, { Settings }] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent"),
		import("@oh-my-pi/pi-coding-agent/config/model-registry"),
		import("@oh-my-pi/pi-coding-agent/config/settings"),
	]);
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	const settings = Settings.isolated();

	let lastProgressDump = 0;
	const PROGRESS_INTERVAL_MS = 5000;

	console.log("\n--- Pipeline starting ---\n");
	const { PipelineController } = await import("./swarm/pipeline");
	const { renderSwarmMeshSummary, renderSwarmProgress } = await import("./swarm/render");

	const controller = new PipelineController(def, waves, stateTracker);
	const result = await controller.run({
		workspace,
		onProgress: () => {
			const now = Date.now();
			if (now - lastProgressDump > PROGRESS_INTERVAL_MS) {
				lastProgressDump = now;
				const lines = renderSwarmProgress(stateTracker.state);
				console.log(lines.join("\n"));
				console.log();
			}
		},
		authStorage,
		modelRegistry,
		settings,
		runSubprocess,
	});

	console.log("\n--- Pipeline finished ---\n");
	console.log(`Status: ${result.status}`);
	console.log(`Iterations completed: ${result.iterations}/${def.targetCount}`);
	if (result.errors.length > 0) {
		console.log(`Errors (${result.errors.length}):`);
		for (const err of result.errors) {
			console.log(`  - ${err}`);
		}
	}
	console.log(`\nState saved to: ${stateTracker.swarmDir}`);

	const events = await stateTracker.readEvents({ limit: 8 });
	const reservations = await readReservations(stateTracker.swarmDir);
	const lines = renderSwarmMeshSummary(stateTracker.state, { events, reservations });
	console.log(lines.join("\n"));
}

async function printStatus(target: string | undefined): Promise<void> {
	const inspection = await requireInspection(target, "status <yaml-or-name>");
	const events = await inspection.stateTracker.readEvents({ limit: 8 });
	const reservations = await readReservations(inspection.stateTracker.swarmDir);
	const { renderSwarmMeshSummary } = await import("./swarm/render");
	console.log(renderSwarmMeshSummary(inspection.state, { events, reservations }).join("\n"));
}

async function printTasks(target: string | undefined): Promise<void> {
	const inspection = await requireInspection(target, "tasks <yaml-or-name>");
	console.log(renderSwarmTasks(inspection.tasks).join("\n"));
}

async function printTask(target: string | undefined, agentName: string | undefined): Promise<void> {
	const inspection = await requireInspection(target, "task <yaml-or-name> <agent>");
	if (!agentName) usageError("task <yaml-or-name> <agent>");
	const task = inspection.tasks.find(t => t.name === agentName);
	if (!task) {
		console.error(`No agent '${agentName}' in swarm '${inspection.name}'`);
		process.exit(1);
	}
	console.log(renderSwarmTaskDetail(task).join("\n"));
}

async function printFeed(args: string[]): Promise<void> {
	const inspection = await requireInspection(args[0], "feed <yaml-or-name> [--channel <name>]");
	const events = await inspection.stateTracker.readEvents({ channel: parseChannelArg(args.slice(1)), limit: 50 });
	console.log(renderSwarmEvents(events).join("\n"));
}

async function printAgents(target: string | undefined): Promise<void> {
	const inspection = await requireInspection(target, "agents <yaml-or-name>");
	const lines = renderAgentStatusLines(inspection.state);
	console.log(lines.length > 0 ? lines.join("\n") : "No agents.");
}

async function sendMessage(args: string[]): Promise<void> {
	const inspection = await requireInspection(args[0], "send <yaml-or-name> <to> <message>");
	const to = args[1];
	const message = args.slice(2).join(" ").trim();
	if (!to || !message) usageError("send <yaml-or-name> <to> <message>");
	await inspection.stateTracker.appendEvent({
		type: "message",
		channel: "memory",
		from: "cli",
		to,
		message,
	});
	console.log(`Message recorded for '${to}' in swarm '${inspection.name}'`);
}

async function reserveResource(args: string[]): Promise<void> {
	const inspection = await requireInspection(args[0], "reserve <yaml-or-name> <resource> [reason]");
	const resource = args[1];
	if (!resource) usageError("reserve <yaml-or-name> <resource> [reason]");
	const reason = args.slice(2).join(" ").trim() || undefined;
	const result = await claimReservation(inspection.stateTracker.swarmDir, resource, "cli", reason);
	if (!result.ok && result.conflict) {
		console.error(`Reservation conflict: ${resource} is held by ${result.conflict.holder}`);
		process.exit(1);
	}
	await inspection.stateTracker.appendEvent({
		type: "reservation.claim",
		channel: "pipeline",
		from: "cli",
		resource,
		reason,
		message: `Reserved ${resource}`,
	});
	console.log(`Reserved ${resource}`);
	console.log(renderReservations(await readReservations(inspection.stateTracker.swarmDir)).join("\n"));
}

async function releaseResource(args: string[]): Promise<void> {
	const inspection = await requireInspection(args[0], "release <yaml-or-name> <resource>");
	const resource = args[1];
	if (!resource) usageError("release <yaml-or-name> <resource>");
	const released = await releaseReservation(inspection.stateTracker.swarmDir, resource);
	if (!released) {
		console.log(`No reservation for ${resource}`);
		return;
	}
	await inspection.stateTracker.appendEvent({
		type: "reservation.release",
		channel: "pipeline",
		from: "cli",
		resource,
		message: `Released ${resource}`,
	});
	console.log(`Released ${resource}`);
}

async function requireInspection(target: string | undefined, usageText: string) {
	if (!target) usageError(usageText);
	return loadSwarmInspection(target, process.cwd());
}

function parseChannelArg(args: string[]): string | undefined {
	const channelIndex = args.indexOf("--channel");
	if (channelIndex >= 0) return args[channelIndex + 1];
	return undefined;
}

function usageError(command: string): never {
	console.error(`Usage: omp-swarm ${command}`);
	process.exit(1);
}

function usage(code: number): never {
	console.error(
		[
			"Usage:",
			"  omp-swarm <path-to-yaml>",
			"  omp-swarm status <yaml-or-name>",
			"  omp-swarm tasks <yaml-or-name>",
			"  omp-swarm task <yaml-or-name> <agent>",
			"  omp-swarm feed <yaml-or-name> [--channel <name>]",
			"  omp-swarm agents <yaml-or-name>",
			"  omp-swarm send <yaml-or-name> <to> <message>",
			"  omp-swarm reserve <yaml-or-name> <resource> [reason]",
			"  omp-swarm release <yaml-or-name> <resource>",
		].join("\n"),
	);
	process.exit(code);
}
