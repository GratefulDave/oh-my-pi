export const FACTORY_RUN_SCHEMA_VERSION = "0.1.0";

export type FactoryOrchestrator = "omp" | "claude";
export type FactoryPaneBackendName = "cmux";
export type FactoryWorkerRuntime = "claude";
export type FactoryRunStatus = "planned" | "launching" | "running" | "completed" | "failed" | "stopped";
export type FactoryLaneStatus = "pending" | "launching" | "launched" | "running" | "done" | "verified" | "failed";
export type FactoryGateStatus = "approved" | "rejected" | "needs_changes";
export type FactoryGateSeverity = "info" | "warning" | "blocking";

export interface FactoryRunMeta {
	schemaVersion: typeof FACTORY_RUN_SCHEMA_VERSION;
	runId: string;
	title: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	status: FactoryRunStatus;
	orchestrator: FactoryOrchestrator;
	paneBackend: FactoryPaneBackendName;
	workerRuntime: FactoryWorkerRuntime;
}

export interface FactoryPaneRef {
	backend: FactoryPaneBackendName;
	workspaceId: string;
	surfaceId: string;
	command: string[];
	cwd: string;
	launchedAt: string;
}

export interface FactoryLane {
	id: string;
	title: string;
	role: string;
	workerRuntime: FactoryWorkerRuntime;
	status: FactoryLaneStatus;
	assignmentPath: string;
	cwd: string;
	orchestrator: boolean;
	pane?: FactoryPaneRef;
}

export interface FactoryPlan {
	schemaVersion: typeof FACTORY_RUN_SCHEMA_VERSION;
	runId: string;
	objective: string;
	orchestrator: FactoryOrchestrator;
	paneBackend: FactoryPaneBackendName;
	workerRuntime: FactoryWorkerRuntime;
	lanes: FactoryLane[];
	gates: string[];
	rollback: string[];
}

export interface FactoryGate {
	schemaVersion: typeof FACTORY_RUN_SCHEMA_VERSION;
	gateId: string;
	runId: string;
	laneId: string;
	status: FactoryGateStatus;
	producer: string;
	verifier: string;
	evidence: string[];
	commands: string[];
	requiredChanges: string[];
	severity: FactoryGateSeverity;
	note?: string;
	createdAt: string;
}

export interface FactoryAuditEvent {
	timestamp: string;
	type: string;
	details: Record<string, unknown>;
}
