import { getAntigravityHeaders } from "opencode-antigravity-auth/dist/src/constants";
import { checkAccountsQuota, type QuotaGroup } from "opencode-antigravity-auth/dist/src/plugin/quota";
import { type AccountMetadataV3, loadAccounts } from "opencode-antigravity-auth/dist/src/plugin/storage";
import { refreshAccessToken } from "opencode-antigravity-auth/dist/src/plugin/token";
import type { AuthMethod, OAuthAuthDetails, PluginClient } from "opencode-antigravity-auth/dist/src/plugin/types";
import type { OAuthCredentials, OAuthLoginCallbacks } from "../../ai/src/registry/oauth/types";
import type { ProviderModelConfig } from "../../coding-agent/src/extensibility/extensions/types";
import { AG_API, AG_MODELS, expandDiscoveredAgModel, PROVIDER_ID, sortAgModels, toAgProviderModel } from "./models";

const SERIALIZED_CREDENTIAL_PREFIX = "ag:v2:";
const BRIDGE_MODEL_DISCOVERY_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface PackedRefreshParts {
	refreshToken: string;
	projectId?: string;
	managedProjectId?: string;
}

interface AvailableModelEntry {
	displayName?: string;
	supportsImages?: boolean;
	supportsThinking?: boolean;
	maxTokens?: number;
	maxOutputTokens?: number;
	isInternal?: boolean;
}

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
		throw new Error(result.error || "Antigravity OAuth failed.");
	}

	return toOAuthCredentials(result);
}

export async function probeExistingToken(client: PluginClient): Promise<OAuthCredentials | null> {
	const storage = await loadAccounts();
	if (!storage?.accounts.length) return null;

	const activeAccount = storage.accounts[storage.activeIndex];
	const candidate =
		activeAccount?.enabled !== false && activeAccount?.refreshToken
			? activeAccount
			: storage.accounts.find(account => account.enabled !== false && account.refreshToken);
	if (!candidate) return null;

	try {
		const refresh = [candidate.refreshToken, candidate.projectId ?? "", candidate.managedProjectId ?? ""].join("|");
		const auth: OAuthAuthDetails = { type: "oauth", refresh };
		const refreshed = await refreshAccessToken(auth, client, PROVIDER_ID);
		if (!refreshed?.access) return null;
		return {
			refresh: refreshed.refresh,
			access: refreshed.access,
			expires: refreshed.expires ?? 0,
			...(candidate.email ? { email: candidate.email } : {}),
			...(candidate.projectId ? { projectId: candidate.projectId } : {}),
		};
	} catch {
		return null;
	}
}

export function toOAuthCredentials(result: UpstreamOAuthSuccess): OAuthCredentials {
	return {
		refresh: result.refresh,
		access: result.access,
		expires: result.expires,
		...(result.email ? { email: result.email } : {}),
		...(result.accountId ? { accountId: result.accountId } : {}),
		...(result.enterpriseUrl ? { enterpriseUrl: result.enterpriseUrl } : {}),
		...(result.projectId ? { projectId: result.projectId } : {}),
	};
}

export async function refreshAgCredentials(
	credentials: OAuthCredentials,
	client: PluginClient,
): Promise<OAuthCredentials> {
	const auth = toUpstreamAuthDetails(credentials);
	const refreshed = await refreshAccessToken(auth, client, PROVIDER_ID);
	if (refreshed) {
		return fromUpstreamAuthDetails(refreshed, credentials);
	}
	throw new Error("AG OAuth credentials are missing a refresh token.");
}

export async function fetchAgModels(
	apiKey: string | undefined,
	fetcher: Fetcher = fetch,
): Promise<readonly ProviderModelConfig[]> {
	const credentials = deserializeAgCredentials(apiKey);
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
				...(userAgent ? { "User-Agent": userAgent } : {}),
			},
			body: JSON.stringify(body),
		});
	} catch {
		return AG_MODELS;
	}

	if (!response.ok) {
		return AG_MODELS;
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return AG_MODELS;
	}

	const parsed = parseAvailableModelsResponse(payload);
	if (!parsed) return AG_MODELS;

	const models: ProviderModelConfig[] = [];
	for (const [modelId, entry] of Object.entries(parsed.models ?? {})) {
		if (!modelId || entry.isInternal === true) continue;
		const supportsImages = entry.supportsImages === true;
		const base = toAgProviderModel(modelId, {
			name: entry.displayName ?? modelId,
			api: AG_API,
			reasoning: entry.supportsThinking === true,
			input: supportsImages ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: toPositiveInt(entry.maxTokens, 200_000),
			maxTokens: toPositiveInt(entry.maxOutputTokens, 65_536),
		});
		models.push(...expandDiscoveredAgModel(base));
	}
	return models.length > 0 ? sortAgModels(models) : AG_MODELS;
}

export function serializeAgCredentials(credentials: OAuthCredentials): string {
	return `${SERIALIZED_CREDENTIAL_PREFIX}${encodeURIComponent(JSON.stringify(credentials))}`;
}

export function deserializeAgCredentials(apiKey: string | undefined): OAuthCredentials {
	if (!apiKey) {
		throw new Error("AG requires OAuth credentials. Run `/login ag`.");
	}

	if (!apiKey.startsWith(SERIALIZED_CREDENTIAL_PREFIX)) {
		return { refresh: apiKey, access: apiKey, expires: 0 };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeURIComponent(apiKey.slice(SERIALIZED_CREDENTIAL_PREFIX.length)));
	} catch (error) {
		throw new Error(`AG credentials are corrupt: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!isOAuthCredentials(parsed)) {
		throw new Error("AG credentials are missing refresh/access/expires fields.");
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

export function classifyQuotaGroup(modelId: string): QuotaGroup | null {
	const lower = modelId.toLowerCase();
	if (lower.includes("claude")) return "claude";
	const isGemini3 = lower.includes("gemini-3") || lower.includes("gemini 3");
	if (!isGemini3) return null;
	return lower.includes("flash") ? "gemini-flash" : "gemini-pro";
}

export async function checkAgQuotaExhaustion(
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

async function readManualCode(callbacks: OAuthLoginCallbacks): Promise<string> {
	if (!callbacks.onManualCodeInput) {
		throw new Error("AG OAuth requires manual-code input, but OMP did not provide a callback.");
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
