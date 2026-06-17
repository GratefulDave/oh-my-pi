import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isEnoent } from "@oh-my-pi/pi-utils";

import { renderFactoryTemplate } from "../template-render";
import laneAssignmentTemplate from "../templates/lane-assignment.md" with { type: "text" };
import {
	FACTORY_RUN_SCHEMA_VERSION,
	type FactoryAuditEvent,
	type FactoryGate,
	type FactoryLane,
	type FactoryOrchestrator,
	type FactoryPlan,
	type FactoryRunMeta,
} from "./schema";

export interface CreateFactoryRunInput {
	runId: string;
	title: string;
	cwd: string;
	createdAt: string;
	objective: string;
	orchestrator: FactoryOrchestrator;
	lanes: FactoryLane[];
}

export interface FactoryRunRecord {
	meta: FactoryRunMeta;
	plan: FactoryPlan;
}

export function factoryRunsDir(cwd: string): string {
	return path.join(cwd, ".omp/factory/runs");
}

export function factoryRunDir(cwd: string, runId: string): string {
	return path.join(factoryRunsDir(cwd), runId);
}

export function sanitizeRunToken(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "factory-run";
}

export function generateRunId(title: string, now: Date): string {
	const year = String(now.getUTCFullYear());
	const month = String(now.getUTCMonth() + 1).padStart(2, "0");
	const day = String(now.getUTCDate()).padStart(2, "0");
	const hours = String(now.getUTCHours()).padStart(2, "0");
	const minutes = String(now.getUTCMinutes()).padStart(2, "0");
	const seconds = String(now.getUTCSeconds()).padStart(2, "0");
	return `${year}${month}${day}-${hours}${minutes}${seconds}-${sanitizeRunToken(title).slice(0, 32)}`;
}

async function readJsonFile<T>(filePath: string, invalidMessage: string): Promise<T> {
	try {
		return (await Bun.file(filePath).json()) as T;
	} catch (error) {
		if (isEnoent(error)) {
			throw error;
		}
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${invalidMessage}: ${detail}`);
	}
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function createFactoryRun(input: CreateFactoryRunInput): Promise<FactoryRunRecord> {
	const meta: FactoryRunMeta = {
		schemaVersion: FACTORY_RUN_SCHEMA_VERSION,
		runId: input.runId,
		title: input.title,
		cwd: input.cwd,
		createdAt: input.createdAt,
		updatedAt: input.createdAt,
		status: "planned",
		orchestrator: input.orchestrator,
		paneBackend: "cmux",
		workerRuntime: "claude",
	};
	const plan: FactoryPlan = {
		schemaVersion: FACTORY_RUN_SCHEMA_VERSION,
		runId: input.runId,
		objective: input.objective,
		orchestrator: input.orchestrator,
		paneBackend: "cmux",
		workerRuntime: "claude",
		lanes: input.lanes,
		gates: [],
		rollback: [
			`Stop or close launched cmux workspaces for this run.`,
			`Do not delete .omp/factory/runs/${input.runId}; mark the run stopped or failed so evidence remains available.`,
			"Revert code changes through normal repo tooling only after gates/evidence have been reviewed.",
		],
	};
	const runDir = factoryRunDir(input.cwd, input.runId);
	await writeJsonFile(path.join(runDir, "meta.json"), meta);
	await writeJsonFile(path.join(runDir, "plan.json"), plan);
	for (const lane of input.lanes) {
		await writeLaneAssignment(
			input.cwd,
			input.runId,
			lane.id,
			renderFactoryTemplate(laneAssignmentTemplate, {
				runId: input.runId,
				laneTitle: lane.title,
				laneId: lane.id,
				role: lane.role,
				objective: input.objective,
			}),
		);
	}
	await Bun.write(path.join(runDir, "audit.jsonl"), "");
	await Bun.write(path.join(runDir, "gates/.gitkeep"), "");
	await Bun.write(path.join(runDir, "evidence/.gitkeep"), "");
	return { meta, plan };
}

export async function readFactoryRun(cwd: string, runId: string): Promise<FactoryRunRecord> {
	const runDir = factoryRunDir(cwd, runId);
	try {
		const [meta, plan] = await Promise.all([
			readJsonFile<FactoryRunMeta>(path.join(runDir, "meta.json"), `Factory run ${runId} is invalid`),
			readJsonFile<FactoryPlan>(path.join(runDir, "plan.json"), `Factory run ${runId} is invalid`),
		]);
		return { meta, plan };
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`Factory run ${runId} not found.`);
		}
		throw error;
	}
}

export async function listFactoryRuns(cwd: string): Promise<FactoryRunMeta[]> {
	const entries = await fs.readdir(factoryRunsDir(cwd), { withFileTypes: true }).catch(error => {
		if (isEnoent(error)) return [];
		throw error;
	});
	const metas: FactoryRunMeta[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			metas.push((await readFactoryRun(cwd, entry.name)).meta);
		} catch {}
	}
	metas.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	return metas;
}

export async function findLatestFactoryRun(cwd: string): Promise<FactoryRunMeta | undefined> {
	return (await listFactoryRuns(cwd))[0];
}

export async function writeFactoryPlan(cwd: string, plan: FactoryPlan): Promise<void> {
	await writeJsonFile(path.join(factoryRunDir(cwd, plan.runId), "plan.json"), plan);
}

export async function writeFactoryMeta(cwd: string, meta: FactoryRunMeta): Promise<void> {
	await writeJsonFile(path.join(factoryRunDir(cwd, meta.runId), "meta.json"), meta);
}

export async function writeLaneAssignment(
	cwd: string,
	runId: string,
	laneId: string,
	content: string,
): Promise<string> {
	const assignmentPath = `assignments/${laneId}.md`;
	await Bun.write(path.join(factoryRunDir(cwd, runId), assignmentPath), content);
	return assignmentPath;
}

export async function updateLane(cwd: string, runId: string, lane: FactoryLane): Promise<void> {
	const record = await readFactoryRun(cwd, runId);
	const lanes = record.plan.lanes.map(currentLane => (currentLane.id === lane.id ? lane : currentLane));
	await writeFactoryPlan(cwd, { ...record.plan, lanes });
}

export async function appendAudit(cwd: string, runId: string, event: FactoryAuditEvent): Promise<void> {
	const auditPath = path.join(factoryRunDir(cwd, runId), "audit.jsonl");
	let current = "";
	try {
		current = await Bun.file(auditPath).text();
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	await Bun.write(auditPath, `${current}${JSON.stringify(event)}\n`);
}

export async function writeGate(cwd: string, gate: FactoryGate): Promise<string> {
	const gatePath = `gates/${gate.gateId}.json`;
	await writeJsonFile(path.join(factoryRunDir(cwd, gate.runId), gatePath), gate);
	await appendAudit(cwd, gate.runId, {
		timestamp: gate.createdAt,
		type: "gate_recorded",
		details: { gateId: gate.gateId, laneId: gate.laneId, status: gate.status },
	});
	return gatePath;
}

export async function listGates(cwd: string, runId: string): Promise<FactoryGate[]> {
	const entries = await fs
		.readdir(path.join(factoryRunDir(cwd, runId), "gates"), { withFileTypes: true })
		.catch(error => {
			if (isEnoent(error)) return [];
			throw error;
		});
	const gates: FactoryGate[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		gates.push(
			await readJsonFile<FactoryGate>(
				path.join(factoryRunDir(cwd, runId), "gates", entry.name),
				`Factory run ${runId} is invalid`,
			),
		);
	}
	gates.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	return gates;
}
