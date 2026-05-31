import type { ActorCompletion, ActorFailureKind } from "./types";

const SUBAGENT_WARNING_MISSING_YIELD = "SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.";

function includesAny(value: string, needles: readonly string[]): boolean {
	const lower = value.toLowerCase();
	return needles.some(needle => lower.includes(needle));
}

export function classifyActorFailure(completion: ActorCompletion): ActorFailureKind | undefined {
	const { result } = completion;
	if (result.aborted) return "execution_failed";
	if (result.exitCode === 0 && !result.error) return undefined;

	const message = `${result.error ?? ""}\n${result.stderr ?? ""}\n${result.abortReason ?? ""}`;
	if (message.includes(SUBAGENT_WARNING_MISSING_YIELD)) return "yield_missing";
	if (includesAny(message, ["schema", "validate", "validation"])) return "schema_invalid";
	if (includesAny(message, ["no auth", "missing auth", "api key", "credentials", "unauthorized"]))
		return "auth_missing";
	if (includesAny(message, ["provider not found", "unknown provider", "unsupported provider"]))
		return "provider_not_found";
	if (includesAny(message, ["model not found", "unsupported model", "unknown model", "404"])) {
		return "model_unsupported";
	}
	return "execution_failed";
}

export function actorFailureMessage(completion: ActorCompletion): string | undefined {
	const { result } = completion;
	return result.error || result.stderr || result.abortReason || undefined;
}
