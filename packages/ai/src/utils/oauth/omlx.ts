/**
 * OMLX login flow.
 *
 * OMLX provides an OpenAI-compatible API at a local base URL.
 * It usually runs unauthenticated but can be configured to require a bearer token.
 *
 * This flow stores an API-key-style credential used by `/login` and auth storage.
 */

import type { OAuthController, OAuthProvider } from "./types";

const PROVIDER_ID: OAuthProvider = "omlx";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:18790/v1";
export const DEFAULT_LOCAL_TOKEN = "omlx-local";

/**
 * Login to OMLX.
 *
 * Prompts for an optional token and returns a stored key value.
 */
export async function loginOmlx(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error(`${PROVIDER_ID} login requires onPrompt callback`);
	}

	const apiKey = await options.onPrompt({
		message: `Optional: Paste OMLX API key (default base URL: ${DEFAULT_LOCAL_BASE_URL})`,
		placeholder: DEFAULT_LOCAL_TOKEN,
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	return trimmed || DEFAULT_LOCAL_TOKEN;
}
