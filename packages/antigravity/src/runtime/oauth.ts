import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import {
	ANTIGRAVITY_CLIENT_ID,
	ANTIGRAVITY_CLIENT_SECRET,
	ANTIGRAVITY_ENDPOINT_DAILY,
	ANTIGRAVITY_ENDPOINT_PROD,
	ANTIGRAVITY_LOAD_LIST_HEADERS,
	ANTIGRAVITY_REDIRECT_URI,
	ANTIGRAVITY_SCOPES,
} from "./constants";

interface TokenExchangePayload {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
}

interface UserInfoPayload {
	email?: string;
	id?: string;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function loginAntigravity(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const fetcher = callbacks.fetch ?? fetch;
	const verifier = base64Url(randomBytes(32));
	const challenge = await pkceChallenge(verifier);
	const state = base64Url(new TextEncoder().encode(JSON.stringify({ verifier, projectId: "" })));
	const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	authUrl.search = new URLSearchParams({
		client_id: ANTIGRAVITY_CLIENT_ID,
		response_type: "code",
		redirect_uri: ANTIGRAVITY_REDIRECT_URI,
		scope: ANTIGRAVITY_SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		access_type: "offline",
		prompt: "consent",
	}).toString();

	callbacks.onAuth({
		url: authUrl.toString(),
		instructions: "Complete the sign-in in your browser, then paste the returned code or callback URL.",
	});
	if (!callbacks.onManualCodeInput) throw new Error("Antigravity OAuth requires manual code input.");
	const manual = await callbacks.onManualCodeInput();
	const code = extractCode(manual);
	const token = await exchangeCode(code, verifier, fetcher);
	const user = await fetchUserInfo(token.access_token, fetcher);
	const discoveredProjectId = await discoverProjectId(token.access_token, fetcher);
	const projectId = discoveredProjectId ?? "";
	return {
		refresh: `${token.refresh_token ?? ""}|${projectId}`,
		access: token.access_token,
		expires: Date.now() + (token.expires_in ?? 3600) * 1000,
		...(projectId ? { projectId } : {}),
		...(user.email ? { email: user.email } : {}),
		...(user.id ? { accountId: user.id } : {}),
	};
}

async function exchangeCode(code: string, verifier: string, fetcher: Fetcher): Promise<TokenExchangePayload> {
	const response = await fetcher("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"Accept-Encoding": "gzip",
			"User-Agent": "Go-http-client/2.0",
		},
		body: new URLSearchParams({
			client_id: ANTIGRAVITY_CLIENT_ID,
			client_secret: ANTIGRAVITY_CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: ANTIGRAVITY_REDIRECT_URI,
			code_verifier: verifier,
		}).toString(),
	});
	if (!response.ok)
		throw new Error(`Antigravity OAuth token exchange failed (${response.status} ${response.statusText}).`);
	const payload = (await response.json()) as unknown;
	if (!payload || typeof payload !== "object")
		throw new Error("Antigravity OAuth token exchange returned an invalid payload.");
	const record = payload as Record<string, unknown>;
	if (typeof record.access_token !== "string")
		throw new Error("Antigravity OAuth token exchange did not return an access token.");
	return {
		access_token: record.access_token,
		...(typeof record.refresh_token === "string" ? { refresh_token: record.refresh_token } : {}),
		...(typeof record.expires_in === "number" ? { expires_in: record.expires_in } : {}),
	};
}

async function fetchUserInfo(accessToken: string, fetcher: Fetcher): Promise<UserInfoPayload> {
	const response = await fetcher("https://www.googleapis.com/oauth2/v2/userinfo", {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Accept-Encoding": "gzip",
			"User-Agent": "Go-http-client/2.0",
		},
	});
	if (!response.ok) return {};
	const payload = (await response.json()) as unknown;
	if (!payload || typeof payload !== "object") return {};
	const record = payload as Record<string, unknown>;
	return {
		...(typeof record.email === "string" ? { email: record.email } : {}),
		...(typeof record.id === "string" ? { id: record.id } : {}),
	};
}

async function discoverProjectId(accessToken: string, fetcher: Fetcher): Promise<string | undefined> {
	const endpoints = [ANTIGRAVITY_ENDPOINT_DAILY, ANTIGRAVITY_ENDPOINT_PROD] as const;
	for (const endpoint of endpoints) {
		const response = await fetcher(`${endpoint}/v1internal:loadCodeAssist`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				"Accept-Encoding": "gzip",
				...ANTIGRAVITY_LOAD_LIST_HEADERS,
			},
			body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
		});
		if (!response.ok) continue;
		const payload = (await response.json()) as unknown;
		if (!payload || typeof payload !== "object") continue;
		const record = payload as Record<string, unknown>;
		const project = record.cloudaicompanionProject;
		if (typeof project === "string") return project;
		if (project && typeof project === "object") {
			const id = (project as Record<string, unknown>).id;
			if (typeof id === "string") return id;
		}
	}
	return undefined;
}

function extractCode(input: string): string {
	try {
		const url = new URL(input);
		const code = url.searchParams.get("code");
		if (code) return code;
	} catch {
		// Raw authorization codes are not URLs.
	}
	return input.trim();
}

async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64Url(new Uint8Array(digest));
}

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}
