import type { FactoryLane, FactoryPaneRef } from "../run-state/schema";

export interface PaneLaunchRequest {
	runId: string;
	lane: FactoryLane;
	command: string[];
	cwd: string;
	prompt: string;
	launchedAt: string;
}

export interface PaneSnapshot {
	pane: FactoryPaneRef;
	text: string;
}

export interface PaneWorkerBackend {
	readonly name: "cmux";
	launch(request: PaneLaunchRequest): Promise<FactoryPaneRef>;
	send(pane: FactoryPaneRef, message: string): Promise<void>;
	read(pane: FactoryPaneRef, lines: number): Promise<PaneSnapshot>;
}
