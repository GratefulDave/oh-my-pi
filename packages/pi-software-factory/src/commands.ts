import * as path from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { runFactoryDoctor } from "./doctor";
import {
	parseFactoryGateArgs,
	parseFactoryLaunchArgs,
	parseFactoryPlanArgs,
	parseFactorySendArgs,
} from "./factory-args";
import { createCmuxPaneBackend } from "./panes/cmux";
import type { PaneWorkerBackend } from "./panes/types";
import {
	FACTORY_RUN_SCHEMA_VERSION,
	type FactoryGate,
	type FactoryGateSeverity,
	type FactoryLane,
	type FactoryPlan,
	type FactoryRunMeta,
} from "./run-state/schema";
import {
	appendAudit,
	createFactoryRun,
	factoryRunDir,
	findLatestFactoryRun,
	generateRunId,
	listFactoryRuns,
	listGates,
	readFactoryRun,
	sanitizeRunToken,
	writeFactoryMeta,
	writeFactoryPlan,
	writeGate,
	writeLaneAssignment,
} from "./run-state/store";
import { dryRunScaffoldFactory, dryRunUpgradeFactory, getFactoryPresets, scaffoldFactory } from "./scaffold";
import { renderFactoryTemplate } from "./template-render";
import claudeMainOrchestratorTemplate from "./templates/claude-main-orchestrator.md" with { type: "text" };

const FACTORY_PLAN_USAGE =
	"Usage: /factory-plan [--orchestrator omp|claude] [--workers builder,reviewer] [--run-id <id>] [--title <title>] <objective>";
const FACTORY_LAUNCH_USAGE = "Usage: /factory-launch [--dry-run] [--claude-command <binary>] [run-id]";
const FACTORY_SEND_USAGE = "Usage: /factory-send [run-id] <lane-id> <message>";
const FACTORY_GATE_USAGE =
	"Usage: /factory-gate <run-id> <lane-id> <approved|rejected|needs_changes> --verifier <id> [--severity info|warning|blocking] [--evidence <path>] [--command <command>] [--required-change <text>] [--note <text>]";

export interface FactoryCommandDependencies {
	readonly now: () => Date;
	readonly paneBackend: PaneWorkerBackend;
}

export function createFactoryCommandDependencies(): FactoryCommandDependencies {
	return {
		now: () => new Date(),
		paneBackend: createCmuxPaneBackend(),
	};
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function updateUsageState(
	ctx: { ui: { setEditorText: (value: string) => void; setStatus: (key: string, value: string) => void } },
	usage: string,
	status: string,
): void {
	ctx.ui.setEditorText(usage);
	ctx.ui.setStatus("factory", status);
}

function clearCommandState(
	ctx: { ui: { setEditorText: (value: string) => void; setStatus: (key: string, value: string) => void } },
	status: string,
): void {
	ctx.ui.setEditorText("");
	ctx.ui.setStatus("factory", status);
}

function formatRunTimestamp(now: Date): string {
	const year = String(now.getUTCFullYear());
	const month = String(now.getUTCMonth() + 1).padStart(2, "0");
	const day = String(now.getUTCDate()).padStart(2, "0");
	const hours = String(now.getUTCHours()).padStart(2, "0");
	const minutes = String(now.getUTCMinutes()).padStart(2, "0");
	const seconds = String(now.getUTCSeconds()).padStart(2, "0");
	return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function laneRole(workerId: string): string {
	const lower = workerId.toLowerCase();
	if (lower.includes("review")) return "reviewer";
	if (lower.includes("test") || lower.includes("qa")) return "tester";
	return "implementer";
}

function buildFactoryLanes(orchestrator: "omp" | "claude", workers: string[], cwd: string): FactoryLane[] {
	const lanes: FactoryLane[] = [];
	const seen = new Set<string>();
	if (orchestrator === "claude") {
		lanes.push({
			id: "lead",
			title: "Claude main orchestrator",
			role: "orchestrator",
			workerRuntime: "claude",
			status: "pending",
			assignmentPath: "assignments/lead.md",
			cwd,
			orchestrator: true,
		});
		seen.add("lead");
	}
	for (const worker of workers) {
		let laneId = worker;
		if (laneId === "lead") {
			laneId = "lead-worker";
		}
		if (seen.has(laneId)) {
			let suffix = 2;
			while (seen.has(`${laneId}-${suffix}`)) {
				suffix++;
			}
			laneId = `${laneId}-${suffix}`;
		}
		seen.add(laneId);
		lanes.push({
			id: laneId,
			title: laneId,
			role: laneRole(laneId),
			workerRuntime: "claude",
			status: "pending",
			assignmentPath: `assignments/${laneId}.md`,
			cwd,
			orchestrator: false,
		});
	}
	return lanes;
}

function updatePlanLane(plan: FactoryPlan, lane: FactoryLane): FactoryPlan {
	return {
		...plan,
		lanes: plan.lanes.map(currentLane => (currentLane.id === lane.id ? lane : currentLane)),
	};
}

function buildWorkerPaneSummary(plan: FactoryPlan): string {
	return plan.lanes
		.filter(lane => !lane.orchestrator && lane.pane)
		.map(
			lane =>
				`- ${lane.id}: workspace ${lane.pane?.workspaceId}, surface ${lane.pane?.surfaceId}, role ${lane.role}`,
		)
		.join("\n");
}

function readPaneStatusArgs(args: string): { runId?: string; lines: number } {
	const parts = args.split(/\s+/).filter(Boolean);
	let runId: string | undefined;
	let lines = 80;
	for (let index = 0; index < parts.length; index++) {
		if (parts[index] === "--lines") {
			const parsed = Number.parseInt(parts[index + 1] ?? "", 10);
			lines = Number.isFinite(parsed) && parsed > 0 ? parsed : 80;
			if (index + 1 < parts.length) {
				index++;
			}
			continue;
		}
		if (!runId) {
			runId = parts[index];
		}
	}
	return { runId, lines };
}

function readShowRunId(args: string): string | undefined {
	const value = args.trim();
	return value.length > 0 ? value.split(/\s+/)[0] : undefined;
}

async function resolveRunId(cwd: string, requestedRunId?: string): Promise<string | undefined> {
	if (requestedRunId) return requestedRunId;
	return (await findLatestFactoryRun(cwd))?.runId;
}

async function readAssignment(cwd: string, runId: string, assignmentPath: string): Promise<string> {
	return Bun.file(path.join(factoryRunDir(cwd, runId), assignmentPath)).text();
}

async function handleLaunchFailure(
	ctx: {
		ui: {
			notify: (message: string, level: "info" | "warning") => void;
			setEditorText: (value: string) => void;
			setStatus: (key: string, value: string) => void;
		};
	},
	cwd: string,
	runId: string,
	plan: FactoryPlan,
	meta: FactoryRunMeta,
	laneId: string,
	error: unknown,
): Promise<void> {
	const detail = describeError(error);
	const failedPlan: FactoryPlan = {
		...plan,
		lanes: plan.lanes.map(lane => {
			if (lane.id === laneId) return { ...lane, status: "failed" };
			if (lane.pane) return { ...lane, status: "launched" };
			return lane;
		}),
	};
	const failedMeta: FactoryRunMeta = { ...meta, status: "failed", updatedAt: meta.updatedAt };
	await writeFactoryPlan(cwd, failedPlan);
	await writeFactoryMeta(cwd, failedMeta);
	await appendAudit(cwd, runId, {
		timestamp: failedMeta.updatedAt,
		type: "launch_failed",
		details: { laneId, error: detail },
	});
	ctx.ui.notify(`Factory run ${runId} failed while launching ${laneId}: ${detail}`, "warning");
	clearCommandState(ctx, `Factory failed: ${runId}`);
}

export function registerFactoryCommands(pi: ExtensionAPI, dependencies?: Partial<FactoryCommandDependencies>): void {
	const defaults = createFactoryCommandDependencies();
	const resolvedDependencies: FactoryCommandDependencies = {
		now: dependencies?.now ?? defaults.now,
		paneBackend: dependencies?.paneBackend ?? defaults.paneBackend,
	};

	pi.registerCommand("factory-status", {
		description: "Check factory health and configuration",
		handler: async (_args, ctx) => {
			const result = await runFactoryDoctor(ctx.cwd);
			const lines = [`# Factory Status (${ctx.cwd})`, ""];
			for (const check of result.checks) {
				const icon = check.ok ? "✓" : "✗";
				const checkPath = check.path ? `\`${check.path}\`` : "";
				lines.push(`${icon} ${check.message} ${checkPath}`);
			}
			lines.push("", `**Result**: ${result.ok ? "PASSED" : "FAILED"}`);
			ctx.ui.notify(lines.join("\n"), result.ok ? "info" : "warning");
			clearCommandState(ctx, result.ok ? "Factory: OK" : "Factory: Issues found");
		},
	});

	pi.registerCommand("factory-init", {
		description: "Scaffold a software factory for the current project",
		handler: async (args, ctx) => {
			const parts = args.split(/\s+/).filter(Boolean);
			let preset = "standard";
			const presetIndex = parts.indexOf("--preset");
			if (presetIndex !== -1 && parts[presetIndex + 1]) {
				preset = parts[presetIndex + 1];
			}

			if (parts.includes("--list-presets")) {
				ctx.ui.notify(["# Factory Presets", ...getFactoryPresets().map(name => `- ${name}`)].join("\n"), "info");
				clearCommandState(ctx, "Factory presets listed");
				return;
			}

			if (parts.includes("--dry-run")) {
				const result = await dryRunScaffoldFactory({ cwd: ctx.cwd, preset, enableMemory: true });
				const lines = [
					"# Factory Scaffold Dry Run",
					`Preset: ${preset}`,
					"",
					`Would write ${result.filesToWrite.length} file(s):`,
					...result.filesToWrite.map(file => `- \`${file}\``),
				];
				if (result.filesSkipped.length > 0) {
					lines.push(
						"",
						`Would skip ${result.filesSkipped.length} existing file(s):`,
						...result.filesSkipped.map(file => `- \`${file}\``),
					);
				}
				if (result.errors.length > 0) {
					lines.push("", "## Errors", ...result.errors.map(error => `- ${error.target}: ${error.error}`));
				}
				ctx.ui.notify(lines.join("\n"), result.errors.length > 0 ? "warning" : "info");
				clearCommandState(ctx, `Factory dry run: ${result.filesToWrite.length} files would be written`);
				return;
			}

			ctx.ui.setStatus("factory", `Scaffolding factory (preset: ${preset})...`);
			const result = await scaffoldFactory({ cwd: ctx.cwd, preset, enableMemory: true });
			const lines = [
				"# Factory Scaffolded",
				`Created ${result.filesWritten.length} file(s):`,
				...result.filesWritten.map(file => `- \`${file}\``),
			];
			if (result.errors.length > 0) {
				lines.push("", "## Errors", ...result.errors.map(error => `- ${error.target}: ${error.error}`));
			}
			ctx.ui.notify(lines.join("\n"), result.errors.length > 0 ? "warning" : "info");
			clearCommandState(ctx, `Factory scaffolded: ${result.filesWritten.length} files created`);
		},
	});

	pi.registerCommand("factory-upgrade", {
		description: "Compare existing factory files with current templates",
		handler: async (args, ctx) => {
			const parts = args.split(/\s+/).filter(Boolean);
			let preset = "standard";
			const presetIndex = parts.indexOf("--preset");
			if (presetIndex !== -1 && parts[presetIndex + 1]) {
				preset = parts[presetIndex + 1];
			}
			if (!parts.includes("--dry-run")) {
				ctx.ui.notify("`/factory-upgrade` currently supports only `--dry-run`.", "warning");
				clearCommandState(ctx, "Factory upgrade requires --dry-run");
				return;
			}
			const result = await dryRunUpgradeFactory({ cwd: ctx.cwd, preset, enableMemory: true });
			const lines = [
				"# Factory Upgrade Dry Run",
				`Preset: ${preset}`,
				"",
				`Create (${result.create.length}):`,
				...result.create.map(file => `- \`${file}\``),
				"",
				`Update (${result.update.length}):`,
				...result.update.map(file => `- \`${file}\``),
				"",
				`Conflict (${result.conflict.length}):`,
				...result.conflict.map(item => `- \`${item.target}\`: ${item.error}`),
				"",
				`Unchanged (${result.unchanged.length}):`,
				...result.unchanged.map(file => `- \`${file}\``),
			];
			ctx.ui.notify(lines.join("\n"), result.conflict.length > 0 ? "warning" : "info");
			clearCommandState(
				ctx,
				`Factory upgrade dry run: ${result.create.length} create, ${result.update.length} update`,
			);
		},
	});

	pi.registerCommand("factory-plan", {
		description: "Plan a pane-backed factory run",
		handler: async (args, ctx) => {
			const parsed = parseFactoryPlanArgs(args);
			if ("error" in parsed) {
				updateUsageState(ctx, FACTORY_PLAN_USAGE, "Factory plan arguments invalid");
				return;
			}
			const createdAt = resolvedDependencies.now();
			const runId = parsed.runId ?? generateRunId(parsed.title ?? parsed.objective, createdAt);
			if (await Bun.file(path.join(factoryRunDir(ctx.cwd, runId), "meta.json")).exists()) {
				ctx.ui.notify(`Factory run ${runId} already exists.`, "warning");
				clearCommandState(ctx, `Factory run exists: ${runId}`);
				return;
			}
			const lanes = buildFactoryLanes(parsed.orchestrator, parsed.workers, ctx.cwd);
			await createFactoryRun({
				runId,
				title: parsed.title ?? parsed.objective,
				cwd: ctx.cwd,
				createdAt: createdAt.toISOString(),
				objective: parsed.objective,
				orchestrator: parsed.orchestrator,
				lanes,
			});
			ctx.ui.notify(
				[
					"# Factory Run Planned",
					`Run: \`${runId}\``,
					`Orchestrator: \`${parsed.orchestrator}\``,
					`Workers: \`${lanes
						.filter(lane => lane.id !== "lead")
						.map(lane => lane.id)
						.join(", ")}\``,
					"",
					`Next: \`/factory-launch ${runId}\``,
				].join("\n"),
				"info",
			);
			clearCommandState(ctx, `Factory planned: ${runId}`);
		},
	});

	pi.registerCommand("factory-launch", {
		description: "Launch Claude Code panes for a planned factory run",
		handler: async (args, ctx) => {
			const parsed = parseFactoryLaunchArgs(args);
			if ("error" in parsed) {
				updateUsageState(ctx, FACTORY_LAUNCH_USAGE, "Factory launch arguments invalid");
				return;
			}
			const runId = await resolveRunId(ctx.cwd, parsed.runId);
			if (!runId) {
				ctx.ui.notify("No factory runs found. Use /factory-plan first.", "warning");
				clearCommandState(ctx, "No factory runs found");
				return;
			}
			const record = await readFactoryRun(ctx.cwd, runId);
			if (record.meta.status === "completed" || record.meta.status === "stopped") {
				ctx.ui.notify(`Factory run ${runId} is ${record.meta.status}; refusing to launch.`, "warning");
				clearCommandState(ctx, `Factory run ${runId} is ${record.meta.status}`);
				return;
			}
			if (parsed.dryRun) {
				ctx.ui.notify(
					record.plan.lanes.map(lane => `${lane.id}: ${parsed.claudeCommand} cwd=${lane.cwd}`).join("\n"),
					"info",
				);
				clearCommandState(ctx, `Factory dry launch: ${runId}`);
				return;
			}

			let plan: FactoryPlan = {
				...record.plan,
				lanes: record.plan.lanes.map(lane => ({ ...lane, status: "launching" })),
			};
			let meta: FactoryRunMeta = {
				...record.meta,
				status: "launching",
				updatedAt: resolvedDependencies.now().toISOString(),
			};
			await writeFactoryMeta(ctx.cwd, meta);
			await appendAudit(ctx.cwd, runId, {
				timestamp: meta.updatedAt,
				type: "launch_started",
				details: { runId },
			});
			await writeFactoryPlan(ctx.cwd, plan);

			const workerLanes = plan.lanes.filter(lane => !lane.orchestrator);
			const leadLane = plan.lanes.find(lane => lane.orchestrator);
			const launchOrder = leadLane ? [...workerLanes, leadLane] : workerLanes;
			for (const lane of launchOrder) {
				try {
					let prompt = await readAssignment(ctx.cwd, runId, lane.assignmentPath);
					if (lane.orchestrator) {
						prompt = renderFactoryTemplate(claudeMainOrchestratorTemplate, {
							runId,
							objective: plan.objective,
							workerPanes: buildWorkerPaneSummary(plan),
						});
						await writeLaneAssignment(ctx.cwd, runId, lane.id, prompt);
					} else {
						prompt = `${prompt}\n\nWhen complete, leave a concise completion summary visible in this pane and wait for further instructions.`;
					}
					const launchedLane = {
						...lane,
						pane: await resolvedDependencies.paneBackend.launch({
							runId,
							lane,
							command: [parsed.claudeCommand],
							cwd: lane.cwd,
							prompt,
							launchedAt: resolvedDependencies.now().toISOString(),
						}),
					};
					plan = updatePlanLane(plan, launchedLane);
					await writeFactoryPlan(ctx.cwd, plan);
				} catch (error) {
					meta = { ...meta, status: "failed", updatedAt: resolvedDependencies.now().toISOString() };
					await handleLaunchFailure(ctx, ctx.cwd, runId, plan, meta, lane.id, error);
					return;
				}
			}

			plan = {
				...plan,
				lanes: plan.lanes.map(lane => ({ ...lane, status: "launched" })),
			};
			meta = { ...meta, status: "running", updatedAt: resolvedDependencies.now().toISOString() };
			await writeFactoryPlan(ctx.cwd, plan);
			await writeFactoryMeta(ctx.cwd, meta);
			await appendAudit(ctx.cwd, runId, {
				timestamp: meta.updatedAt,
				type: "launch_completed",
				details: { runId },
			});
			ctx.ui.notify(`Factory run ${runId} launched.`, "info");
			clearCommandState(ctx, `Factory running: ${runId}`);
		},
	});

	pi.registerCommand("factory-pane-status", {
		description: "Show pane output for the latest or selected factory run",
		handler: async (args, ctx) => {
			const parsed = readPaneStatusArgs(args);
			const runId = await resolveRunId(ctx.cwd, parsed.runId);
			if (!runId) {
				ctx.ui.notify("No factory runs found.", "warning");
				clearCommandState(ctx, "No factory runs found");
				return;
			}
			const record = await readFactoryRun(ctx.cwd, runId);
			const lines = [`# Factory Pane Status`, `Run: \`${runId}\``, ""];
			for (const lane of record.plan.lanes) {
				lines.push(`## ${lane.id}`);
				lines.push(`- Role: ${lane.role}`);
				lines.push(`- Status: ${lane.status}`);
				if (!lane.pane) {
					lines.push(`- Workspace: _not launched_`, `- Surface: _not launched_`, "");
					continue;
				}
				lines.push(`- Workspace: ${lane.pane.workspaceId}`);
				lines.push(`- Surface: ${lane.pane.surfaceId}`);
				try {
					const snapshot = await resolvedDependencies.paneBackend.read(lane.pane, parsed.lines);
					lines.push("```text", snapshot.text, "```", "");
				} catch (error) {
					lines.push(`Read failed: ${describeError(error)}`, "");
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
			clearCommandState(ctx, `Factory pane status: ${runId}`);
		},
	});

	pi.registerCommand("factory-send", {
		description: "Send a message to a launched worker pane",
		handler: async (args, ctx) => {
			const parsed = parseFactorySendArgs(args);
			if ("error" in parsed) {
				updateUsageState(ctx, FACTORY_SEND_USAGE, "Factory send arguments invalid");
				return;
			}
			let runId = parsed.runId;
			let laneId = parsed.laneId;
			let message = parsed.message;
			if (runId && !(await Bun.file(path.join(factoryRunDir(ctx.cwd, runId), "meta.json")).exists())) {
				const latest = await findLatestFactoryRun(ctx.cwd);
				if (latest) {
					message = [laneId, message].join(" ");
					laneId = runId;
					runId = latest.runId;
				}
			}
			runId = await resolveRunId(ctx.cwd, runId);
			if (!runId) {
				ctx.ui.notify("No factory runs found.", "warning");
				clearCommandState(ctx, "No factory runs found");
				return;
			}
			const record = await readFactoryRun(ctx.cwd, runId);
			const lane = record.plan.lanes.find(currentLane => currentLane.id === laneId);
			if (!lane) {
				ctx.ui.notify(`Unknown lane ${laneId} in run ${runId}.`, "warning");
				clearCommandState(ctx, `Unknown lane: ${laneId}`);
				return;
			}
			if (!lane.pane) {
				ctx.ui.notify(`Lane ${laneId} has no pane; run /factory-launch ${runId} first.`, "warning");
				clearCommandState(ctx, `Lane ${laneId} not launched`);
				return;
			}
			await resolvedDependencies.paneBackend.send(lane.pane, message);
			await appendAudit(ctx.cwd, runId, {
				timestamp: resolvedDependencies.now().toISOString(),
				type: "pane_message_sent",
				details: { laneId },
			});
			ctx.ui.notify(`Message sent to ${laneId}.`, "info");
			clearCommandState(ctx, `Factory message sent: ${laneId}`);
		},
	});

	pi.registerCommand("factory-gate", {
		description: "Record a verifier gate for a factory lane",
		handler: async (args, ctx) => {
			const parsed = parseFactoryGateArgs(args);
			if ("error" in parsed) {
				updateUsageState(ctx, FACTORY_GATE_USAGE, "Factory gate arguments invalid");
				return;
			}
			const record = await readFactoryRun(ctx.cwd, parsed.runId);
			const lane = record.plan.lanes.find(currentLane => currentLane.id === parsed.laneId);
			if (!lane) {
				ctx.ui.notify(`Unknown lane ${parsed.laneId} in run ${parsed.runId}.`, "warning");
				clearCommandState(ctx, `Unknown lane: ${parsed.laneId}`);
				return;
			}
			const createdAt = resolvedDependencies.now();
			const gateId = `${sanitizeRunToken(parsed.laneId)}-${sanitizeRunToken(parsed.status)}-${formatRunTimestamp(createdAt)}`;
			const severity: FactoryGateSeverity = parsed.severity ?? (parsed.status === "approved" ? "info" : "blocking");
			const gate: FactoryGate = {
				schemaVersion: FACTORY_RUN_SCHEMA_VERSION,
				gateId,
				runId: parsed.runId,
				laneId: parsed.laneId,
				status: parsed.status,
				producer: lane.id,
				verifier: parsed.verifier,
				evidence: parsed.evidence,
				commands: parsed.commands,
				requiredChanges: parsed.requiredChanges,
				severity,
				note: parsed.note,
				createdAt: createdAt.toISOString(),
			};
			const gatePath = await writeGate(ctx.cwd, gate);
			const updatedPlan: FactoryPlan = {
				...record.plan,
				gates: [...record.plan.gates, gatePath],
				lanes: record.plan.lanes.map(currentLane =>
					currentLane.id === lane.id && parsed.status === "approved"
						? { ...currentLane, status: "verified" }
						: currentLane,
				),
			};
			await writeFactoryPlan(ctx.cwd, updatedPlan);
			await writeFactoryMeta(ctx.cwd, { ...record.meta, updatedAt: createdAt.toISOString() });
			ctx.ui.notify(`Gate ${gateId} recorded as ${parsed.status}.`, "info");
			clearCommandState(ctx, `Factory gate recorded: ${gateId}`);
		},
	});

	pi.registerCommand("factory-runs", {
		description: "List recorded factory runs",
		handler: async (_args, ctx) => {
			const runs = await listFactoryRuns(ctx.cwd);
			if (runs.length === 0) {
				ctx.ui.notify("No factory runs found.", "info");
				clearCommandState(ctx, "No factory runs found");
				return;
			}
			const lines = [
				"| Run | Status | Orchestrator | Worker Runtime | Created | Title |",
				"| --- | --- | --- | --- | --- | --- |",
				...runs.map(
					run =>
						`| ${run.runId} | ${run.status} | ${run.orchestrator} | ${run.workerRuntime} | ${run.createdAt} | ${run.title} |`,
				),
			];
			ctx.ui.notify(lines.join("\n"), "info");
			clearCommandState(ctx, `Factory runs: ${runs.length}`);
		},
	});

	pi.registerCommand("factory-show", {
		description: "Show a factory run plan, panes, and gates",
		handler: async (args, ctx) => {
			const runId = await resolveRunId(ctx.cwd, readShowRunId(args));
			if (!runId) {
				ctx.ui.notify("No factory runs found.", "warning");
				clearCommandState(ctx, "No factory runs found");
				return;
			}
			const record = await readFactoryRun(ctx.cwd, runId);
			const gates = await listGates(ctx.cwd, runId);
			const lines = [
				"# Factory Run",
				`Run: \`${record.meta.runId}\``,
				`Title: ${record.meta.title}`,
				`Status: ${record.meta.status}`,
				`Orchestrator: ${record.meta.orchestrator}`,
				`Pane Backend: ${record.meta.paneBackend}`,
				`Worker Runtime: ${record.meta.workerRuntime}`,
				`Created: ${record.meta.createdAt}`,
				`Updated: ${record.meta.updatedAt}`,
				"",
				"## Objective",
				record.plan.objective,
				"",
				"## Lanes",
				"| Lane | Title | Role | Status | Assignment | Workspace | Surface | Orchestrator |",
				"| --- | --- | --- | --- | --- | --- | --- | --- |",
				...record.plan.lanes.map(
					lane =>
						`| ${lane.id} | ${lane.title} | ${lane.role} | ${lane.status} | ${lane.assignmentPath} | ${lane.pane?.workspaceId ?? "-"} | ${lane.pane?.surfaceId ?? "-"} | ${lane.orchestrator ? "yes" : "no"} |`,
				),
				"",
				"## Gates",
				"| Gate | Lane | Status | Severity | Verifier | Created |",
				"| --- | --- | --- | --- | --- | --- |",
				...(gates.length > 0
					? gates.map(
							gate =>
								`| ${gate.gateId} | ${gate.laneId} | ${gate.status} | ${gate.severity} | ${gate.verifier} | ${gate.createdAt} |`,
						)
					: ["| _none_ | - | - | - | - | - |"]),
			];
			ctx.ui.notify(lines.join("\n"), "info");
			clearCommandState(ctx, `Factory show: ${runId}`);
		},
	});
}
