import type { Api, Model, OAuthCredentials } from "@oh-my-pi/pi-ai";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/utils/oauth/types";
import { getAntigravityHeaders } from "opencode-antigravity-auth/dist/src/constants";
import { checkAccountsQuota, type QuotaGroup } from "opencode-antigravity-auth/dist/src/plugin/quota";
import type { AccountMetadataV3 } from "opencode-antigravity-auth/dist/src/plugin/storage";
import { refreshAccessToken } from "opencode-antigravity-auth/dist/src/plugin/token";
import type { AuthMethod, OAuthAuthDetails, PluginClient } from "opencode-antigravity-auth/dist/src/plugin/types";
import { BRIDGE_API, GOOGLE_GENERATIVE_LANGUAGE_BASE, PROVIDER_ID } from "./models";

const SERIALIZED_CREDENTIAL_PREFIX = "opencode-antigravity:v1:";

const BRIDGE_MODEL_DISCOVERY_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface PackedRefreshParts {
	refreshToken: string;
	projectId?: string;
	managedProjectId?: string;
}

/** Raw model entry from fetchAvailableModels. */
interface AvailableModelEntry {
	displayName?: string;
	supportsImages?: boolean;
	supportsThinking?: boolean;
	maxTokens?: number;
	maxOutputTokens?: number;
	isInternal?: boolean;
}

/** Raw response from fetchAvailableModels. */
interface AvailableModelsResponse {
	models?: Record<string, AvailableModelEntry>;
}

type UpstreamOAuthSuccess = {
	type: "success";
	refresh: string;
	access: string;
	expires: number;
	email?: string;
	accountId?: string;
	enterpriseUrl?: string;
	projectId?: string;
};

type UpstreamOAuthFailure = {
	type: "failed";
	error?: string;
};

export interface BridgeQuotaExhaustion {
	quotaGroup: QuotaGroup;
	remainingFraction: number;
	resetTime?: string;
	resetMs?: number;
}

type UpstreamOAuthCallbackResult = UpstreamOAuthSuccess | UpstreamOAuthFailure;

type UpstreamOAuthMethod = AuthMethod & {
	type: "oauth";
	authorize: NonNullable<AuthMethod["authorize"]>;
};

export function findUpstreamOAuthMethod(methods: AuthMethod[]): UpstreamOAuthMethod {
	const method = methods.find((candidate): candidate is UpstreamOAuthMethod => {
		return candidate.type === "oauth" && typeof candidate.authorize === "function";
	});
	if (!method) throw new Error("opencode-antigravity-auth did not expose an OAuth authorization method.");
	return method;
}

export async function loginWithUpstreamOAuth(
	method: UpstreamOAuthMethod,
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	const authorization = await method.authorize();
	callbacks.onAuth({ url: authorization.url, instructions: authorization.instructions });

	const result: UpstreamOAuthCallbackResult =
		authorization.method === "code"
			? await authorization.callback(await readManualCode(callbacks))
			: await authorization.callback();

	if (result.type === "failed") {
		throw new Error(result.error || "OpenCode Antigravity OAuth failed.");
	}

	return toOAuthCredentials(result);
}

export function toOAuthCredentials(result: UpstreamOAuthSuccess): OAuthCredentials {
	return {
		refresh: result.refresh,
		access: result.access,
		expires: result.expires,
		...(result.email && { email: result.email }),
		...(result.accountId && { accountId: result.accountId }),
		...(result.enterpriseUrl && { enterpriseUrl: result.enterpriseUrl }),
		...(result.projectId && { projectId: result.projectId }),
	};
}

/**
 * Plugin-compatible credential refresh.
 * Calls upstream `refreshAccessToken(auth, client, PROVIDER_ID)` so refresh
 * semantics, revocation handling, and persisted credential updates match the plugin.
 */
export async function refreshBridgeCredentials(
	credentials: OAuthCredentials,
	client: PluginClient,
): Promise<OAuthCredentials> {
	const auth = toUpstreamAuthDetails(credentials);
	const refreshed = await refreshAccessToken(auth, client, PROVIDER_ID);
	if (refreshed) {
		return fromUpstreamAuthDetails(refreshed, credentials);
	}
	// Plugin returned undefined — refresh token may be missing; fall through to error.
	throw new Error("OpenCode Antigravity OAuth credentials are missing a refresh token.");
}

/**
 * Fetches dynamic bridge models from the production Cloud Code endpoint.
 * Never hits autopush or sandbox endpoints; those remain owned by the plugin
 * request/project fallback path.
 */
export async function fetchBridgeModels(
	apiKey: string | undefined,
	fetcher: Fetcher = fetch,
): Promise<readonly Model<Api>[] | null | undefined> {
	const credentials = deserializeBridgeCredentials(apiKey);
	const headers = getAntigravityHeaders();
	const userAgent = headers["User-Agent"];

	const parts = parsePackedRefresh(credentials.refresh);
	const body = parts.managedProjectId
		? { project: parts.managedProjectId }
		: parts.projectId
			? { project: parts.projectId }
			: {};
	let response: Response;
	try {
		response = await fetcher(`${BRIDGE_MODEL_DISCOVERY_ENDPOINT}${FETCH_AVAILABLE_MODELS_PATH}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${credentials.access}`,
				"Content-Type": "application/json",
				"User-Agent": userAgent,
			},
			body: JSON.stringify(body),
		});
	} catch {
		return [];
	}

	if (!response.ok) {
		return [];
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return [];
	}

	const parsed = parseAvailableModelsResponse(payload);
	if (!parsed) return [];

	const models: Model<Api>[] = [];
	for (const [modelId, entry] of Object.entries(parsed.models ?? {})) {
		if (!modelId || entry.isInternal === true) continue;
		const supportsImages = entry.supportsImages === true;
		models.push({
			id: modelId,
			name: entry.displayName ? `${entry.displayName} (Antigravity Bridge)` : modelId,
			api: BRIDGE_API,
			provider: PROVIDER_ID,
			baseUrl: GOOGLE_GENERATIVE_LANGUAGE_BASE,
			reasoning: entry.supportsThinking === true,
			input: supportsImages ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: toPositiveInt(entry.maxTokens, 200_000),
			maxTokens: toPositiveInt(entry.maxOutputTokens, 65_536),
		});
	}
	return models;
}

export function serializeBridgeCredentials(credentials: OAuthCredentials): string {
	return `${SERIALIZED_CREDENTIAL_PREFIX}${encodeURIComponent(JSON.stringify(credentials))}`;
}

export function deserializeBridgeCredentials(apiKey: string | undefined): OAuthCredentials {
	if (!apiKey) {
		throw new Error("OpenCode Antigravity bridge requires OAuth credentials. Run `/login opencode-antigravity`.");
	}

	if (!apiKey.startsWith(SERIALIZED_CREDENTIAL_PREFIX)) {
		return { refresh: apiKey, access: apiKey, expires: 0 };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeURIComponent(apiKey.slice(SERIALIZED_CREDENTIAL_PREFIX.length)));
	} catch (error) {
		throw new Error(
			`OpenCode Antigravity bridge credentials are corrupt: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!isOAuthCredentials(parsed)) {
		throw new Error("OpenCode Antigravity bridge credentials are missing refresh/access/expires fields.");
	}
	return parsed;
}

export function toUpstreamAuthDetails(credentials: OAuthCredentials): OAuthAuthDetails {
	return {
		type: "oauth",
		refresh: credentials.refresh,
		access: credentials.access,
		expires: credentials.expires,
	};
}

/**
 * Maps packed OAuth credentials to the plugin `AccountMetadataV3` shape required
 * by `checkAccountsQuota` and related plugin quota helpers.
 *
 * Exported for use by session quota monitoring.
 */
export function toPluginAccountMetadata(credentials: OAuthCredentials, now = Date.now()): AccountMetadataV3 {
	const parts = parsePackedRefresh(credentials.refresh);
	return {
		refreshToken: parts.refreshToken,
		...(parts.projectId ? { projectId: parts.projectId } : {}),
		...(parts.managedProjectId ? { managedProjectId: parts.managedProjectId } : {}),
		...(credentials.email ? { email: credentials.email } : {}),
		addedAt: now,
		lastUsed: now,
		enabled: true,
	};
}

/**
 * Classifies an opencode-antigravity model id into a plugin quota group.
 * Mirrors the upstream plugin's `classifyQuotaGroup` logic.
 *
 * Returns `null` for models that do not belong to a known quota group
 * (e.g. Gemini 2.x models billed against Gemini CLI quota).
 *
 * Exported for adapter quota monitoring and focused tests.
 */
export function classifyQuotaGroup(modelId: string): QuotaGroup | null {
	const lower = modelId.toLowerCase();
	if (lower.includes("claude")) return "claude";
	// Only Gemini 3.x (or named "gemini 3") belong to AG quota groups.
	const isGemini3 = lower.includes("gemini-3") || lower.includes("gemini 3");
	if (!isGemini3) return null;
	// Flash variants → gemini-flash; everything else (pro, preview, etc.) → gemini-pro.
	const isFlash = lower.includes("flash");
	return isFlash ? "gemini-flash" : "gemini-pro";
}

export async function checkBridgeQuotaExhaustion(
	credentials: OAuthCredentials,
	modelId: string,
	client: PluginClient,
): Promise<BridgeQuotaExhaustion | null> {
	const quotaGroup = classifyQuotaGroup(modelId);
	if (!quotaGroup) return null;

	const [result] = await checkAccountsQuota([toPluginAccountMetadata(credentials)], client, PROVIDER_ID);
	const group = result?.quota?.groups[quotaGroup];
	if (!group) return null;
	const remainingFraction =
		typeof group.remainingFraction === "number" && Number.isFinite(group.remainingFraction)
			? group.remainingFraction
			: 0;
	const resetMs = group.resetTime ? Date.parse(group.resetTime) : undefined;
	const resetInFuture = resetMs !== undefined && Number.isFinite(resetMs) && resetMs > Date.now();
	if (remainingFraction > 0 || !resetInFuture) return null;
	return {
		quotaGroup,
		remainingFraction,
		...(group.resetTime ? { resetTime: group.resetTime } : {}),
		...(resetInFuture ? { resetMs } : {}),
	};
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function readManualCode(callbacks: OAuthLoginCallbacks): Promise<string> {
	if (!callbacks.onManualCodeInput) {
		throw new Error("OpenCode Antigravity OAuth requires manual-code input, but OMP did not provide a callback.");
	}
	return callbacks.onManualCodeInput();
}

function fromUpstreamAuthDetails(auth: OAuthAuthDetails, original: OAuthCredentials): OAuthCredentials {
	return {
		...original,
		refresh: auth.refresh,
		access: auth.access ?? original.access,
		expires: auth.expires ?? original.expires,
	};
}

function isOAuthCredentials(value: unknown): value is OAuthCredentials {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.refresh === "string" &&
		typeof candidate.access === "string" &&
		typeof candidate.expires === "number"
	);
}

function parsePackedRefresh(refresh: string): PackedRefreshParts {
	const [refreshToken = "", projectId = "", managedProjectId = ""] = refresh.split("|");
	return {
		refreshToken,
		...(projectId ? { projectId } : {}),
		...(managedProjectId ? { managedProjectId } : {}),
	};
}

function parseAvailableModelsResponse(value: unknown): AvailableModelsResponse | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.models !== "undefined" && (typeof candidate.models !== "object" || candidate.models === null)) {
		return null;
	}
	return candidate as AvailableModelsResponse;
}

function toPositiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
