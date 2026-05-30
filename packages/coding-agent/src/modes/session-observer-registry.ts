import { ASYNC_JOB_OBSERVER_CHANNEL, type AsyncJobObserverPayload } from "../async";
import type {
	AgentProgress,
	AgentRunArtifactRef,
	AgentRunMetadata,
	AgentRunPresentation,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "../task";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task";
import type { EventBus } from "../utils/event-bus";

export interface ObservableSession {
	id: string;
	kind: "main" | "subagent";
	label: string;
	agent?: string;
	description?: string;
	status: "active" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	lastUpdate: number;
	/** Latest progress snapshot from the subagent executor */
	progress?: AgentProgress;
	runMetadata?: AgentRunMetadata;
	source?: {
		kind: "plugin" | "async-job";
		name: string;
		eventChannel?: string;
		ownerId?: string;
		jobType?: "bash" | "task";
	};
}

const STATUS_MAP: Record<string, ObservableSession["status"]> = {
	started: "active",
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
};

const ASYNC_JOB_STATUS_MAP: Record<AsyncJobObserverPayload["status"], ObservableSession["status"]> = {
	running: "active",
	completed: "completed",
	failed: "failed",
	cancelled: "aborted",
};

const ASYNC_JOB_PROGRESS_STATUS_MAP: Record<AsyncJobObserverPayload["status"], AgentProgress["status"]> = {
	running: "running",
	completed: "completed",
	failed: "failed",
	cancelled: "aborted",
};

export class SessionObserverRegistry {
	#sessions = new Map<string, ObservableSession>();
	#listeners = new Set<() => void>();
	#eventBusUnsubscribers: Array<() => void> = [];

	/** Add a change listener. Returns unsubscribe function. */
	onChange(cb: () => void): () => void {
		this.#listeners.add(cb);
		return () => this.#listeners.delete(cb);
	}

	#notifyListeners(): void {
		for (const cb of this.#listeners) cb();
	}

	setMainSession(sessionFile?: string): void {
		const existing = this.#sessions.get("main");
		this.#sessions.set("main", {
			id: "main",
			kind: "main",
			label: "Main Session",
			status: "active",
			sessionFile: sessionFile ?? existing?.sessionFile,
			lastUpdate: Date.now(),
		});
		this.#notifyListeners();
	}

	getSessions(): ObservableSession[] {
		const sessions = [...this.#sessions.values()];
		sessions.sort((a, b) => {
			if (a.kind === "main") return -1;
			if (b.kind === "main") return 1;
			return a.lastUpdate - b.lastUpdate;
		});
		return sessions;
	}

	getActiveSubagentCount(): number {
		let count = 0;
		for (const s of this.#sessions.values()) {
			if (s.kind === "subagent" && s.status === "active") count++;
		}
		return count;
	}

	getActiveSubagentDescriptions(): string[] {
		const descriptions: string[] = [];
		for (const session of this.#sessions.values()) {
			if (session.kind !== "subagent" || session.status !== "active") continue;
			const description = session.description ?? session.label;
			if (description) descriptions.push(description);
		}
		return descriptions;
	}
	getCompletedSubagentDescriptions(): string[] {
		const descriptions: string[] = [];
		for (const session of this.#sessions.values()) {
			if (session.kind !== "subagent" || session.status !== "completed") continue;
			const description = session.description ?? session.label;
			if (description) descriptions.push(description);
		}
		return descriptions;
	}

	/** Clear all tracked sessions (e.g. on session switch). Keeps EventBus subscriptions and listeners. */
	resetSessions(): void {
		this.#sessions.clear();
		this.#notifyListeners();
	}

	dispose(): void {
		for (const unsub of this.#eventBusUnsubscribers) unsub();
		this.#eventBusUnsubscribers = [];
		this.#sessions.clear();
		this.#listeners.clear();
	}

	subscribeToEventBus(eventBus: EventBus): void {
		// Dispose previous EventBus subscriptions if called again
		for (const unsub of this.#eventBusUnsubscribers) unsub();
		this.#eventBusUnsubscribers = [];

		this.#eventBusUnsubscribers.push(
			eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				const payload = data as SubagentLifecyclePayload;
				const status = STATUS_MAP[payload.status];
				if (!status) return;

				const existing = this.#sessions.get(payload.id);
				if (existing) {
					existing.status = status;
					existing.lastUpdate = Date.now();
					if (payload.description) existing.description = payload.description;
					if (payload.sessionFile) existing.sessionFile = payload.sessionFile;
					if (payload.runMetadata) existing.runMetadata = payload.runMetadata;
				} else {
					this.#sessions.set(payload.id, {
						id: payload.id,
						kind: "subagent",
						label: payload.description ?? `Subagent #${payload.index}`,
						agent: payload.agent,
						description: payload.description,
						status,
						sessionFile: payload.sessionFile,
						lastUpdate: Date.now(),
						runMetadata: payload.runMetadata,
					});
				}
				this.#notifyListeners();
			}),
		);

		this.#eventBusUnsubscribers.push(
			eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
				const payload = data as SubagentProgressPayload;
				const progress = payload.progress;
				const id = progress.id;
				const existing = this.#sessions.get(id);

				if (existing) {
					existing.lastUpdate = Date.now();
					existing.progress = progress;
					if (progress.description) existing.description = progress.description;
					if (payload.sessionFile) existing.sessionFile = payload.sessionFile;
					if (payload.runMetadata) existing.runMetadata = payload.runMetadata;
				} else {
					this.#sessions.set(id, {
						id,
						kind: "subagent",
						label: progress.description ?? `Subagent #${payload.index}`,
						agent: payload.agent,
						description: progress.description,
						status: "active",
						sessionFile: payload.sessionFile,
						lastUpdate: Date.now(),
						progress,
						runMetadata: payload.runMetadata ?? progress.runMetadata,
					});
				}
				this.#notifyListeners();
			}),
		);

		this.#eventBusUnsubscribers.push(
			eventBus.on(ASYNC_JOB_OBSERVER_CHANNEL, data => {
				if (!isAsyncJobObserverPayload(data)) return;
				this.upsertAsyncJob(data);
			}),
		);

		this.#eventBusUnsubscribers.push(subscribeToPluginSubagentEvents(this, eventBus));
	}

	/** Upsert a background async job session from the core AsyncJobManager observer channel. */
	upsertAsyncJob(payload: AsyncJobObserverPayload): void {
		const id = `job:${payload.id}`;
		const status = ASYNC_JOB_STATUS_MAP[payload.status];
		const progress = payload.type === "task" ? findAsyncTaskProgress(payload) : undefined;
		const runMetadata = buildAsyncJobRunMetadata(payload, progress);
		const existing = this.#sessions.get(id);
		const description = progress?.description ?? payload.progressText;
		const source: ObservableSession["source"] = {
			kind: "async-job",
			name: "AsyncJobManager",
			eventChannel: ASYNC_JOB_OBSERVER_CHANNEL,
			jobType: payload.type,
		};
		if (payload.ownerId !== undefined) source.ownerId = payload.ownerId;
		if (existing) {
			existing.status = status;
			existing.lastUpdate = Date.now();
			existing.runMetadata = runMetadata;
			existing.source = source;
			if (progress) existing.progress = progress;
			if (description) existing.description = description;
		} else {
			this.#sessions.set(id, {
				id,
				kind: "subagent",
				label: payload.label,
				agent: payload.type,
				description,
				status,
				lastUpdate: Date.now(),
				progress,
				runMetadata,
				source,
			});
		}
		this.#notifyListeners();
	}

	/** Upsert a plugin-originated subagent session from the observer-only EventBus bridge. */
	upsertPluginSubagent(
		id: string,
		agentType: string,
		description: string | undefined,
		status: ObservableSession["status"],
		runMetadata: AgentRunMetadata,
		source: ObservableSession["source"],
	): void {
		const existing = this.#sessions.get(id);
		if (existing) {
			existing.agent = agentType;
			existing.status = status;
			existing.lastUpdate = Date.now();
			existing.runMetadata = runMetadata;
			existing.source = source;
			if (description) {
				existing.description = description;
				existing.label = description;
			}
		} else {
			this.#sessions.set(id, {
				id,
				kind: "subagent",
				label: description ?? agentType,
				agent: agentType,
				description,
				status,
				lastUpdate: Date.now(),
				runMetadata,
				source,
			});
		}
		this.#notifyListeners();
	}
}
// ---- Plugin EventBus bridge (observer-only) ----

function isAsyncJobObserverPayload(data: unknown): data is AsyncJobObserverPayload {
	if (data === null || typeof data !== "object") return false;
	const payload = data as Record<string, unknown>;
	const type = payload.type;
	const status = payload.status;
	return (
		typeof payload.id === "string" &&
		(type === "bash" || type === "task") &&
		typeof payload.label === "string" &&
		(status === "running" || status === "completed" || status === "failed" || status === "cancelled") &&
		typeof payload.startTime === "number"
	);
}

function findAsyncTaskProgress(payload: AsyncJobObserverPayload): AgentProgress | undefined {
	const details = payload.progressDetails;
	if (!details) return undefined;
	const progress = details.progress;
	if (!Array.isArray(progress)) return undefined;
	for (const item of progress) {
		if (!isAgentProgress(item)) continue;
		if (item.runMetadata?.runId === payload.id || item.id === payload.id) return item;
	}
	return undefined;
}

function isAgentProgress(value: unknown): value is AgentProgress {
	if (value === null || typeof value !== "object") return false;
	const progress = value as Record<string, unknown>;
	return (
		typeof progress.id === "string" &&
		typeof progress.index === "number" &&
		typeof progress.agent === "string" &&
		typeof progress.task === "string" &&
		typeof progress.status === "string"
	);
}

function buildAsyncJobRunMetadata(
	payload: AsyncJobObserverPayload,
	progress: AgentProgress | undefined,
): AgentRunMetadata {
	if (payload.runMetadata) return payload.runMetadata;
	if (progress?.runMetadata) return progress.runMetadata;
	return {
		runId: payload.id,
		taskId: payload.id,
		agent: payload.type,
		cwd: process.cwd(),
		status: ASYNC_JOB_PROGRESS_STATUS_MAP[payload.status],
		presentation: { mode: "embedded", backend: "core" },
		artifacts: [],
	};
}

// Handles stable @gotgenes/pi-subagents lifecycle events without importing plugin internals.

/** Plugin lifecycle channel → observable status. */
const PLUGIN_CHANNEL_STATUS: Readonly<Record<string, ObservableSession["status"]>> = {
	"subagents:started": "active",
	"subagents:completed": "completed",
	"subagents:failed": "failed",
};

/** Extract artifact refs from any path-bearing fields in plugin event payloads. */
function extractPluginArtifacts(payload: Record<string, unknown>): AgentRunArtifactRef[] {
	const artifacts: AgentRunArtifactRef[] = [];
	const addArtifact = (kind: AgentRunArtifactRef["kind"], path: string): void => {
		if (artifacts.some(artifact => artifact.path === path)) return;
		artifacts.push({ kind, path });
	};
	const outputFile = typeof payload.outputFile === "string" ? payload.outputFile : undefined;
	const transcriptFile = typeof payload.transcriptFile === "string" ? payload.transcriptFile : undefined;
	const transcriptPath = typeof payload.transcriptPath === "string" ? payload.transcriptPath : undefined;
	const outputPath = typeof payload.outputPath === "string" ? payload.outputPath : undefined;
	const genericPath = typeof payload.path === "string" ? payload.path : undefined;
	if (outputFile) addArtifact("transcript", outputFile);
	if (transcriptFile) addArtifact("transcript", transcriptFile);
	if (transcriptPath) addArtifact("transcript", transcriptPath);
	if (outputPath) addArtifact("raw", outputPath);
	if (genericPath && artifacts.length === 0) {
		addArtifact(genericPath.endsWith(".jsonl") ? "transcript" : "raw", genericPath);
	}
	return artifacts;
}

function extractPluginPresentation(payload: Record<string, unknown>): AgentRunPresentation {
	const mode =
		payload.mode === "pane" || payload.mode === "window" || payload.mode === "embedded" ? payload.mode : "embedded";
	const backend =
		payload.backend === "core" ||
		payload.backend === "acpx" ||
		payload.backend === "tmux" ||
		payload.backend === "cmux"
			? payload.backend
			: "core";
	const presentation: AgentRunPresentation = { mode, backend };
	if (typeof payload.session === "string") presentation.session = payload.session;
	if (typeof payload.paneId === "string") presentation.paneId = payload.paneId;
	if (Array.isArray(payload.command) && payload.command.every(part => typeof part === "string")) {
		presentation.command = payload.command;
	}
	return presentation;
}

/** Build AgentRunMetadata for a plugin subagent event. */
function buildPluginRunMetadata(
	payload: Record<string, unknown>,
	id: string,
	agentType: string,
	observableStatus: ObservableSession["status"],
	artifacts: AgentRunArtifactRef[],
): AgentRunMetadata {
	const progressStatus: AgentProgress["status"] =
		observableStatus === "active" ? "running" : observableStatus === "completed" ? "completed" : "failed";
	const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
	const metadata: AgentRunMetadata = {
		runId: id,
		taskId: id,
		agent: agentType,
		cwd,
		status: progressStatus,
		presentation: extractPluginPresentation(payload),
		artifacts,
	};
	if (typeof payload.worktree === "string") metadata.worktree = payload.worktree;
	return metadata;
}

/** Subscribe to plugin subagent EventBus channels and reflect them as ObservableSessions. */
function subscribeToPluginSubagentEvents(registry: SessionObserverRegistry, eventBus: EventBus): () => void {
	const unsubscribers: Array<() => void> = [];

	const handlePluginEvent = (channel: string, data: unknown): void => {
		if (data === null || typeof data !== "object") return;
		const payload = data as Record<string, unknown>;
		const id = typeof payload.id === "string" ? payload.id : undefined;
		const agentType = typeof payload.type === "string" ? payload.type : "subagent";
		const description = typeof payload.description === "string" ? payload.description : undefined;
		if (!id) return;

		const observableStatus = PLUGIN_CHANNEL_STATUS[channel];
		if (!observableStatus) return;

		const artifacts = extractPluginArtifacts(payload);
		const runMetadata = buildPluginRunMetadata(payload, id, agentType, observableStatus, artifacts);
		const source: ObservableSession["source"] = {
			kind: "plugin",
			name: "@gotgenes/pi-subagents",
			eventChannel: channel,
		};

		registry.upsertPluginSubagent(id, agentType, description, observableStatus, runMetadata, source);
	};
	for (const channel of ["subagents:started", "subagents:completed", "subagents:failed"]) {
		unsubscribers.push(eventBus.on(channel, data => handlePluginEvent(channel, data)));
	}

	return () => {
		for (const unsub of unsubscribers) unsub();
	};
}
