/**
 * Shared inspection helpers for CLI and extension commands.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveSwarmWorkspace } from "./runtime";
import { parseSwarmYaml, type SwarmDefinition } from "./schema";
import { StateTracker, type SwarmState } from "./state";
import { projectSwarmTasks, type SwarmTaskRecord } from "./tasks";

export interface SwarmInspection {
	name: string;
	workspace: string;
	stateTracker: StateTracker;
	state: SwarmState;
	definition: SwarmDefinition | null;
	tasks: SwarmTaskRecord[];
}

export async function loadSwarmInspection(target: string, cwd: string): Promise<SwarmInspection> {
	const fromYaml = await tryLoadDefinitionFromYaml(target, cwd);
	if (fromYaml) {
		const { definition, workspace } = fromYaml;
		const stateTracker = new StateTracker(workspace, definition.name);
		const state = await stateTracker.load();
		if (!state) throw new Error(`No state found for swarm '${definition.name}' in ${workspace}`);
		return {
			name: definition.name,
			workspace,
			stateTracker,
			state,
			definition,
			tasks: projectSwarmTasks(state, definition),
		};
	}

	const stateTracker = new StateTracker(cwd, target);
	const state = await stateTracker.load();
	if (!state) throw new Error(`No state found for swarm '${target}' in ${cwd}`);
	const definition = await stateTracker.loadDefinition();
	return {
		name: target,
		workspace: cwd,
		stateTracker,
		state,
		definition,
		tasks: projectSwarmTasks(state, definition),
	};
}

async function tryLoadDefinitionFromYaml(
	target: string,
	cwd: string,
): Promise<{ definition: SwarmDefinition; workspace: string } | null> {
	const resolvedPath = path.isAbsolute(target) ? target : path.resolve(cwd, target);
	try {
		const stat = await fs.stat(resolvedPath);
		if (!stat.isFile()) return null;
	} catch {
		return null;
	}
	const definition = parseSwarmYaml(await Bun.file(resolvedPath).text());
	const workspace = resolveSwarmWorkspace(definition, resolvedPath);
	return { definition, workspace };
}
