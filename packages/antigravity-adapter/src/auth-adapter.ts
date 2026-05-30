import type { OAuthCredentials } from "@oh-my-pi/pi-ai";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/utils/oauth/types";
import type { AuthDetails, AuthMethod } from "opencode-antigravity-auth/dist/src/plugin/types";

const SERIALIZED_CREDENTIAL_PREFIX = "opencode-antigravity:v1:";

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

export function toUpstreamAuthDetails(credentials: OAuthCredentials): AuthDetails {
	return {
		type: "oauth",
		refresh: credentials.refresh,
		access: credentials.access,
		expires: credentials.expires,
	};
}

async function readManualCode(callbacks: OAuthLoginCallbacks): Promise<string> {
	if (!callbacks.onManualCodeInput) {
		throw new Error("OpenCode Antigravity OAuth requires manual-code input, but OMP did not provide a callback.");
	}
	return callbacks.onManualCodeInput();
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
