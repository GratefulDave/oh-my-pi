import { actorFailureMessage, classifyActorFailure } from "./output-contract";
import type { ActorCompletion, ActorRunSpec, ActorRunStatus, ActorSnapshot } from "./types";

export class ActorRunStore {
	static #global: ActorRunStore | undefined;

	static global(): ActorRunStore {
		if (!ActorRunStore.#global) ActorRunStore.#global = new ActorRunStore();
		return ActorRunStore.#global;
	}

	static resetGlobalForTests(): void {
		ActorRunStore.#global = new ActorRunStore();
	}

	readonly #snapshots = new Map<string, ActorSnapshot>();

	plan(spec: ActorRunSpec): ActorSnapshot {
		const now = Date.now();
		const existing = this.#snapshots.get(spec.id);
		const snapshot: ActorSnapshot = {
			id: spec.id,
			agentName: spec.agentName,
			status: existing?.status ?? "planned",
			label: spec.description || spec.assignment,
			startedAt: existing?.startedAt ?? now,
			updatedAt: now,
			...(spec.ownerId ? { ownerId: spec.ownerId } : {}),
			...(spec.parentId ? { parentId: spec.parentId } : {}),
			...(spec.jobId ? { jobId: spec.jobId } : {}),
		};
		this.#snapshots.set(spec.id, snapshot);
		return snapshot;
	}

	update(id: string, patch: Partial<Omit<ActorSnapshot, "id" | "startedAt">>): ActorSnapshot | undefined {
		const existing = this.#snapshots.get(id);
		if (!existing) return undefined;
		const next: ActorSnapshot = { ...existing, ...patch, updatedAt: Date.now() };
		this.#snapshots.set(id, next);
		return next;
	}

	setStatus(id: string, status: ActorRunStatus): ActorSnapshot | undefined {
		return this.update(id, {
			status,
			...(status === "failed" || status === "aborted" || status === "yielded" ? { completedAt: Date.now() } : {}),
		});
	}

	complete(completion: ActorCompletion): ActorSnapshot | undefined {
		const { result } = completion;
		const failureKind = classifyActorFailure(completion);
		const status: ActorRunStatus = result.aborted ? "aborted" : failureKind ? "failed" : "yielded";
		return this.update(result.id, {
			status,
			completedAt: Date.now(),
			...(result.lastIntent ? { lastIntent: result.lastIntent } : {}),
			...(result.outputPath ? { artifactUri: `agent://${result.id}` } : {}),
			...(failureKind ? { failureKind, failureMessage: actorFailureMessage(completion) } : {}),
		});
	}

	get(id: string): ActorSnapshot | undefined {
		return this.#snapshots.get(id);
	}

	list(): ActorSnapshot[] {
		return [...this.#snapshots.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}
}
