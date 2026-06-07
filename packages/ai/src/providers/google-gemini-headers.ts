/**
 * Build a User-Agent string that identifies as Gemini CLI to unlock higher rate limits.
 * Uses the same format as the official Gemini CLI (v0.35+):
 * GeminiCLI/VERSION/MODEL (PLATFORM; ARCH; SURFACE)
 */
export function getGeminiCliUserAgent(modelId = "gemini-3.1-pro-preview"): string {
	const version = process.env.PI_AI_GEMINI_CLI_VERSION || "0.35.3";
	const platform = process.platform === "win32" ? "win32" : process.platform;
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `GeminiCLI/${version}/${modelId} (${platform}; ${arch}; terminal)`;
}

export const getGeminiCliHeaders = (modelId?: string) => ({
	"User-Agent": getGeminiCliUserAgent(modelId),
	"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
});

export const ANTIGRAVITY_SYSTEM_INSTRUCTION =
	"You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding." +
	"You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question." +
	"**Absolute paths only**" +
	"**Proactiveness**";
export const ANTIGRAVITY_PRIMARY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_SECONDARY_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_ENDPOINTS = [ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_SECONDARY_ENDPOINT] as const;
export const ANTIGRAVITY_STREAM_ENDPOINTS = [ANTIGRAVITY_SECONDARY_ENDPOINT] as const;
export const ANTIGRAVITY_LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";
export const ANTIGRAVITY_FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
export const ANTIGRAVITY_STREAM_GENERATE_CONTENT_PATH = "/v1internal:streamGenerateContent?alt=sse";
export const ANTIGRAVITY_CLI_USER_AGENT = "antigravity/cli/1.0.6 darwin/arm64";

/**
 * Antigravity / Cloud Code Assist user agent. Kept in its own file so
 * discovery and usage code can read it without pulling the heavy
 * google-gemini-cli provider graph into startup.
 */
export function getAntigravityUserAgent(): string {
	return ANTIGRAVITY_CLI_USER_AGENT;
}

export function getAntigravityCodeAssistHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"Accept-Encoding": "gzip",
		"User-Agent": getAntigravityUserAgent(),
	};
}
