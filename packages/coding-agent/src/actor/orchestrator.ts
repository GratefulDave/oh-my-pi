import { ActorRunStore } from "./run-state";
import type { ActorCompletion, ActorRunSpec, ActorRunStatus, ActorSnapshot } from "./types";

export class ActorOrchestrator {
	constructor(readonly store: ActorRunStore = ActorRunStore.global()) {}

	plan(spec: ActorRunSpec): ActorSnapshot {
		return this.store.plan(spec);
	}

	setStatus(id: string, status: ActorRunStatus): ActorSnapshot | undefined {
		return this.store.setStatus(id, status);
	}

	update(id: string, patch: Partial<Omit<ActorSnapshot, "id" | "startedAt">>): ActorSnapshot | undefined {
		return this.store.update(id, patch);
	}

	complete(completion: ActorCompletion): ActorSnapshot | undefined {
		return this.store.complete(completion);
	}

	get(id: string): ActorSnapshot | undefined {
		return this.store.get(id);
	}
}
