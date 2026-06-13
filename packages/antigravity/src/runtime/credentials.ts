import type { OAuthCredentials } from "@oh-my-pi/pi-ai";
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from "./constants";

export const ANTIGRAVITY_CREDENTIAL_PREFIX = "antigravity:v1:";

export interface AntigravityRefreshParts {
	refreshToken: string;
	projectId: string;
	managedProjectId?: string;
}

export interface AntigravityAuthDetails {
	access: string;
	refresh: string;
	expires: number;
	projectId: string;
	managedProjectId?: string;
	email?: string;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function serializeAntigravityCredentials(credentials: OAuthCredentials): string {
	return `${ANTIGRAVITY_CREDENTIAL_PREFIX}${encodeURIComponent(JSON.stringify(credentials))}`;
}

export function deserializeAntigravityCredentials(apiKey: string | undefined): OAuthCredentials {
	if (!apiKey) throw new Error("Antigravity requires OAuth credentials. Run `/login antigravity`.");
	if (!apiKey.startsWith(ANTIGRAVITY_CREDENTIAL_PREFIX)) {
		throw new Error("Antigravity received credentials in an unsupported format. Run `/login antigravity` again.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeURIComponent(apiKey.slice(ANTIGRAVITY_CREDENTIAL_PREFIX.length)));
	} catch (error) {
		throw new Error("Antigravity OAuth credentials are corrupt. Run `/login antigravity` again.", { cause: error });
	}
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Antigravity OAuth credentials are corrupt. Run `/login antigravity` again.");
	}
	const value = parsed as Record<string, unknown>;
	if (typeof value.refresh !== "string" || typeof value.access !== "string" || typeof value.expires !== "number") {
		throw new Error("Antigravity OAuth credentials are incomplete. Run `/login antigravity` again.");
	}
	return parsed as OAuthCredentials;
}

export function parseRefreshParts(refresh: string): AntigravityRefreshParts {
	const [refreshToken = "", projectId = "", managedProjectId] = refresh.split("|");
	return {
		refreshToken,
		projectId,
		...(managedProjectId ? { managedProjectId } : {}),
	};
}

export function formatRefreshParts(parts: AntigravityRefreshParts): string {
	return [parts.refreshToken, parts.projectId, parts.managedProjectId]
		.filter((part): part is string => part !== undefined)
		.join("|");
}

export function toAntigravityAuthDetails(credentials: OAuthCredentials): AntigravityAuthDetails {
	const parts = parseRefreshParts(credentials.refresh);
	return {
		access: credentials.access,
		refresh: parts.refreshToken,
		expires: credentials.expires,
		projectId: credentials.projectId ?? parts.projectId,
		...(parts.managedProjectId ? { managedProjectId: parts.managedProjectId } : {}),
		...(credentials.email ? { email: credentials.email } : {}),
	};
}

export async function refreshAntigravityCredentials(
	credentials: OAuthCredentials,
	fetcher: Fetcher = fetch,
): Promise<OAuthCredentials> {
	const parts = parseRefreshParts(credentials.refresh);
	const requestStart = Date.now();
	const response = await fetcher("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: parts.refreshToken,
			client_id: ANTIGRAVITY_CLIENT_ID,
			client_secret: ANTIGRAVITY_CLIENT_SECRET,
		}).toString(),
	});

	let payload: unknown;
	try {
		payload = await response.clone().json();
	} catch {
		payload = await response.text();
	}

	if (!response.ok) {
		const message = formatRefreshError(payload);
		throw new Error(
			`Antigravity token refresh failed (${response.status} ${response.statusText})${message ? ` - ${message}` : ""}`,
		);
	}
	if (!payload || typeof payload !== "object")
		throw new Error("Antigravity token refresh returned an invalid payload.");
	const record = payload as Record<string, unknown>;
	if (typeof record.access_token !== "string")
		throw new Error("Antigravity token refresh did not return an access token.");
	const expiresIn =
		typeof record.expires_in === "number" && Number.isFinite(record.expires_in) ? record.expires_in : 3600;
	return {
		...credentials,
		refresh: formatRefreshParts(parts),
		access: record.access_token,
		expires: requestStart + expiresIn * 1000,
	};
}

function formatRefreshError(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (!payload || typeof payload !== "object") return "";
	const record = payload as Record<string, unknown>;
	const code = typeof record.error === "string" ? record.error : undefined;
	const description = typeof record.error_description === "string" ? record.error_description : undefined;
	return [code, description].filter((part): part is string => Boolean(part)).join(" - ");
}
