import type { Settings } from "../config/settings";
import { hindsightBackend } from "../hindsight";
import { mnemosyneBackend } from "../mnemosyne";
import { localBackend } from "./local-backend";
import { offBackend } from "./off-backend";
import type { MemoryBackend } from "./types";

export function resolveMemoryBackend(settings: Settings): MemoryBackend {
	const id = settings.get("memory.backend");
	if (id === "hindsight") return hindsightBackend;
	if (id === "mnemosyne") return mnemosyneBackend;
	if (id === "local") return localBackend;
	return offBackend;
}
