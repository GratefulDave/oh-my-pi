import type { Settings } from "./settings";

export const MODEL_PROFILE_PRESETS = ["openrouter"] as const;

export type ModelProfilePreset = (typeof MODEL_PROFILE_PRESETS)[number];

export function isModelProfilePreset(value: string): value is ModelProfilePreset {
	return MODEL_PROFILE_PRESETS.includes(value as ModelProfilePreset);
}

export function applyModelProfilePreset(settings: Settings, name: string, preset: ModelProfilePreset): void {
	switch (preset) {
		case "openrouter":
			settings.setModelProfileValue(name, "enabledModels", ["openrouter/*"]);
			settings.setModelProfileValue(name, "modelProviderOrder", ["openrouter"]);
			return;
	}
}
