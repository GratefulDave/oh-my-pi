import type { SingleResult } from "../task/types";

export type ActorRunStatus = "planned" | "scheduled" | "starting" | "running" | "yielded" | "failed" | "aborted";

export type ActorFailureKind =
	| "model_unsupported"
	| "auth_missing"
	| "provider_not_found"
	| "yield_missing"
	| "schema_invalid"
	| "execution_failed";

export interface ActorSnapshot {
	id: string;
	agentName: string;
	status: ActorRunStatus;
	label: string;
	ownerId?: string;
	jobId?: string;
	parentId?: string;
	failureKind?: ActorFailureKind;
	failureMessage?: string;
	artifactUri?: string;
	lastIntent?: string;
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
}

export interface ActorRunSpec {
	id: string;
	agentName: string;
	assignment: string;
	description?: string;
	ownerId?: string;
	parentId?: string;
	jobId?: string;
}

export interface ActorCompletion {
	result: Pick<
		SingleResult,
		"id" | "agent" | "exitCode" | "error" | "stderr" | "aborted" | "abortReason" | "lastIntent" | "outputPath"
	>;
}
