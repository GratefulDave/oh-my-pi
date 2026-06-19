export const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_CLIENT_SECRET = "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";
export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";

export const ANTIGRAVITY_SCOPES = [
	"openid",
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

export const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
export const LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";

export const ANTIGRAVITY_CLI_HEADERS = {
	"User-Agent": "antigravity/cli/1.0.6 darwin/arm64",
};

export const ANTIGRAVITY_NODE_HEADERS = ANTIGRAVITY_CLI_HEADERS;

export const ANTIGRAVITY_LOAD_LIST_HEADERS = ANTIGRAVITY_CLI_HEADERS;

export const ANTIGRAVITY_CLOUD_CODE_METADATA = {
	ideName: "Antigravity IDE",
	ideType: "VSCODE",
	ideVersion: "1.107.0",
	platform: "DARWIN_ARM64",
	pluginType: "CLOUD_CODE",
	pluginVersion: "2.85.0",
};

export function createAntigravityCloudCodeMetadata(projectId?: string): Record<string, string> {
	return {
		...(projectId ? { duetProject: projectId } : {}),
		...ANTIGRAVITY_CLOUD_CODE_METADATA,
	};
}

export function getAntigravityHeaders(): Record<string, string> {
	return { ...ANTIGRAVITY_NODE_HEADERS };
}
