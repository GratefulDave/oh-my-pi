/** Shared runtime helpers for CLI and extension entrypoints. */
import * as path from "node:path";
import type { SwarmDefinition } from "./schema";
import { StateTracker, type SwarmState } from "./state";

export function resolveSwarmWorkspace(def: SwarmDefinition, definitionPath: string): string {
	return path.isAbsolute(def.workspace) ? def.workspace : path.resolve(path.dirname(definitionPath), def.workspace);
}

export async function initializeSwarmState(workspace: string, def: SwarmDefinition): Promise<StateTracker> {
	const stateTracker = new StateTracker(workspace, def.name);
	await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);
	await stateTracker.saveDefinition(def);
	return stateTracker;
}

export function renderAgentStatusLines(state: SwarmState): string[] {
	return Object.values(state.agents).map(agent => {
		const error = agent.error ? ` error=${agent.error}` : "";
		return `${agent.name}: ${agent.status} iteration=${agent.iteration + 1} wave=${agent.wave + 1}${error}`;
	});
}
