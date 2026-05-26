import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { AgentStorage } from "../../../session/agent-storage";
import type { SearchProviderId, SearchSource } from "../../../web/search/types";
import { dateToAgeSeconds } from "../utils";

/**
 * Search for an API credential by checking an env-derived key first,
 * then falling back to agent.db stored credentials for the given providers.
 *
 * @param envKey - Pre-resolved environment variable value (or null)
 * @param storageProviders - Provider names to look up in AgentStorage
 */
export async function findCredential(
	envKey: string | null | undefined,
	...storageProviders: string[]
): Promise<string | null> {
	if (envKey) return envKey;

	try {
		const storage = await AgentStorage.open(getAgentDbPath());
		for (const provider of storageProviders) {
			const records = storage.listAuthCredentials(provider);
			for (const record of records) {
				const credential = record.credential;
				if (credential.type === "api_key" && credential.key.trim().length > 0) {
					return credential.key;
				}
				if (credential.type === "oauth" && credential.access.trim().length > 0) {
					return credential.access;
				}
			}
		}
	} catch {
		return null;
	}

	return null;
}

/**
 * Probe whether a provider's API key lookup resolves to a truthy value.
 * Swallows lookup errors and reports unavailability.
 */
export async function isApiKeyAvailable(findApiKey: () => string | null | Promise<string | null>) {
	try {
		return !!(await findApiKey());
	} catch {
		return false;
	}
}

function formatProviderLabel(provider: SearchProviderId): string {
	switch (provider) {
		case "exa":
			return "Exa";
		case "brave":
			return "Brave";
		case "jina":
			return "Jina";
		case "kimi":
			return "Kimi";
		case "zai":
			return "Z.AI";
		case "anthropic":
			return "Anthropic";
		case "perplexity":
			return "Perplexity";
		case "gemini":
			return "Gemini";
		case "codex":
			return "Codex";
		case "tavily":
			return "Tavily";
		case "parallel":
			return "Parallel";
		case "kagi":
			return "Kagi";
		case "synthetic":
			return "Synthetic";
		case "searxng":
			return "SearXNG";
		default:
			return provider;
	}
}

function extractMessageFromJson(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			const message = extractMessageFromJson(item);
			if (message) return message;
		}
		return null;
	}

	if (!value || typeof value !== "object") return null;

	const record = value as Record<string, unknown>;
	for (const key of ["error", "message", "detail", "description", "error_description", "title"] as const) {
		const message = extractMessageFromJson(record[key]);
		if (message) return message;
	}

	return null;
}

function extractBodyMessage(body: string): string {
	const trimmed = body.trim();
	if (trimmed.length === 0) return "";

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		const fromJson = extractMessageFromJson(parsed);
		if (fromJson) return fromJson;
	} catch {
		// Ignore JSON parse failures; fall through to the raw response text.
	}

	return trimmed;
}

function includesAny(text: string, phrases: readonly string[]): boolean {
	return phrases.some(phrase => text.includes(phrase));
}

const AUTH_ERROR_PHRASES = [
	"invalid api key",
	"invalid credentials",
	"unauthorized",
	"authentication failed",
	"auth failed",
	"forbidden",
	"permission denied",
	"login required",
	"token expired",
	"expired token",
	"missing api key",
] as const;

const QUOTA_ERROR_PHRASES = [
	"quota exceeded",
	"out of credits",
	"insufficient credits",
	"insufficient quota",
	"credit limit",
	"billing",
	"payment required",
	"balance",
	"subscription required",
] as const;

const RATE_LIMIT_ERROR_PHRASES = ["rate limit", "too many requests", "retry after", "throttl"] as const;

/**
 * Map HTTP failures into actionable provider errors.
 */
export function classifyProviderHttpError(provider: SearchProviderId, status: number, body: string): string | null {
	const detail = extractBodyMessage(body);
	const message = detail.length > 0 ? detail : "check API key, account access, or billing status.";
	const lower = message.toLowerCase();
	const providerLabel = formatProviderLabel(provider);

	const authStatus = status === 401 || status === 403 || status === 400;
	if (authStatus && includesAny(lower, AUTH_ERROR_PHRASES)) {
		return `${providerLabel} authorization failed (${status}): ${message}`;
	}

	const quotaStatus = status === 402 || status === 400;
	if (quotaStatus && includesAny(lower, QUOTA_ERROR_PHRASES)) {
		return `${providerLabel} quota exhausted (${status}): ${message}`;
	}

	if (status === 429 || includesAny(lower, RATE_LIMIT_ERROR_PHRASES)) {
		return `${providerLabel} rate limited (${status}): ${message}`;
	}

	return null;
}

/**
 * Default hard ceiling for a single web-search round-trip. 60s tolerates
 * legitimate slow LLM-mediated responses (anthropic web_search_20250305,
 * perplexity, gemini, codex) while still guaranteeing the session unfreezes
 * within a minute if Bun's `AbortSignal` fails to propagate on Windows.
 *
 * Pure search APIs (brave, exa, jina, tavily, searxng, synthetic, zai)
 * settle far faster in practice; reusing the same ceiling keeps the wiring
 * uniform without compromising correctness.
 */
export const SEARCH_HARD_TIMEOUT_MS = 60_000;

/**
 * Compose a caller-supplied {@link AbortSignal} with a hard timeout so an
 * outbound `fetch()` is guaranteed to settle within `ms` even when the
 * runtime fails to propagate cancellation to the underlying transport.
 *
 * Bun's WinHTTP backend on Windows is known to ignore `AbortSignal` once a
 * TCP/TLS connection stalls (oven-sh/bun#15275, oven-sh/bun#18536); without
 * this safety net a stalled web-search request freezes the entire session
 * because the user's Esc is never delivered to the native layer.
 *
 * @param signal - Caller cancellation signal, if any.
 * @param ms - Hard timeout in milliseconds. Defaults to {@link SEARCH_HARD_TIMEOUT_MS}.
 */
export function withHardTimeout(signal: AbortSignal | undefined, ms: number = SEARCH_HARD_TIMEOUT_MS): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Map a provider's raw source list to the unified SearchSource shape,
 * clamped to the requested result count and annotated with ageSeconds.
 */
export function toSearchSources(
	sources: ReadonlyArray<{
		title: string;
		url: string;
		snippet?: string;
		publishedDate?: string;
	}>,
	numResults: number,
): SearchSource[] {
	return sources.slice(0, numResults).map(source => ({
		title: source.title,
		url: source.url,
		snippet: source.snippet,
		publishedDate: source.publishedDate,
		ageSeconds: dateToAgeSeconds(source.publishedDate),
	}));
}
