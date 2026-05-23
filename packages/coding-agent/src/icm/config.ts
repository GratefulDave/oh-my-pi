import type { Settings } from "../config/settings";

export interface IcmConfig {
	binaryPath: string;
	autoRecall: boolean;
	autoRetain: boolean;
	retainEveryNTurns: number;
	recallLimit: number;
	recallMaxChars: number;
	project: string | null;
	debug: boolean;
}

function envString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function loadIcmConfig(settings: Settings, env: NodeJS.ProcessEnv = process.env): IcmConfig {
	const binaryPath = envString(env.ICM_BIN) ?? String(settings.get("icm.binaryPath") || "icm");
	const project = envString(env.ICM_PROJECT) ?? envString(String(settings.get("icm.project") || "")) ?? null;

	return {
		binaryPath,
		autoRecall: settings.get("icm.autoRecall") !== false,
		autoRetain: settings.get("icm.autoRetain") !== false,
		retainEveryNTurns: positiveInteger(settings.get("icm.retainEveryNTurns"), 3),
		recallLimit: positiveInteger(settings.get("icm.recallLimit"), 8),
		recallMaxChars: positiveInteger(settings.get("icm.recallMaxChars"), 12_000),
		project,
		debug: settings.get("icm.debug") === true,
	};
}
