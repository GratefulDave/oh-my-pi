/**
 * Antigravity OAuth ranking smoke tests. Prove the
 * `antigravityRankingStrategy` is wired into the default ranking map for both
 * the built-in `google-antigravity` provider and the extension-owned `ag`
 * provider id.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

const HOUR_MS = 60 * 60 * 1000;

const PROVIDER_CASES = [
	{
		provider: "google-antigravity",
		geminiModelId: "gemini-3-flash",
		claudeModelId: "claude-sonnet-4-5",
	},
	{
		provider: "ag",
		geminiModelId: "antigravity-gemini-3-flash",
		claudeModelId: "antigravity-claude-sonnet-4-6",
	},
] as const;

type ProviderId = (typeof PROVIDER_CASES)[number]["provider"];
type AntigravityWindowSpec = {
	counter: "google" | "anthropic" | "openai" | "default";
	usedFraction: number;
	resetInMs: number;
};

function createAntigravityLimit(spec: AntigravityWindowSpec, projectId: string, provider: ProviderId): UsageLimit {
	const used = Math.min(Math.max(spec.usedFraction, 0), 1);
	return {
		id: `${provider}:${spec.counter}:default:WINDOW_DAILY`,
		label: `Usage (${spec.counter})`,
		scope: {
			provider,
			projectId,
			windowId: "WINDOW_DAILY",
		},
		window: {
			id: "WINDOW_DAILY",
			label: "Default",
			resetsAt: Date.now() + spec.resetInMs,
		},
		amount: {
			unit: "percent",
			used: used * 100,
			limit: 100,
			remaining: (1 - used) * 100,
			usedFraction: used,
			remainingFraction: 1 - used,
		},
		status: used >= 1 ? "exhausted" : used >= 0.9 ? "warning" : "ok",
	};
}

function createAntigravityReport(args: {
	provider: ProviderId;
	projectId: string;
	accountId: string;
	windows: AntigravityWindowSpec[];
}): UsageReport {
	const limits = args.windows
		.map(window => createAntigravityLimit(window, args.projectId, args.provider))
		.sort((left, right) => (left.amount.remainingFraction ?? 1) - (right.amount.remainingFraction ?? 1));
	return {
		provider: args.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: { accountId: args.accountId, projectId: args.projectId },
	};
}

function createCredential(accountId: string, projectId: string, email: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + HOUR_MS,
		accountId,
		projectId,
		email,
	};
}

for (const providerCase of PROVIDER_CASES) {
	describe(`AuthStorage ${providerCase.provider} oauth ranking`, () => {
		let tempDir = "";
		let store: AuthCredentialStore | null = null;
		let authStorage: AuthStorage | null = null;
		const usageByAccount = new Map<string, UsageReport>();

		const usageProvider: UsageProvider = {
			id: providerCase.provider,
			async fetchUsage(params) {
				const accountId = params.credential.accountId;
				if (!accountId) return null;
				return usageByAccount.get(accountId) ?? null;
			},
		};

		beforeEach(async () => {
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `pi-ai-auth-${providerCase.provider}-selection-`));
			store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
			authStorage = new AuthStorage(store, {
				usageProviderResolver: provider => (provider === providerCase.provider ? usageProvider : undefined),
			});
			usageByAccount.clear();
			vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
				const candidate = credentials[providerCase.provider];
				if (!candidate || typeof candidate !== "object") return null;
				const accountId =
					"accountId" in candidate && typeof candidate.accountId === "string" ? candidate.accountId : undefined;
				if (!accountId) return null;
				return {
					apiKey: `api-${accountId}`,
					newCredentials: candidate,
				};
			});
		});

		afterEach(async () => {
			vi.restoreAllMocks();
			store?.close();
			store = null;
			authStorage = null;
			if (!tempDir) return;
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		});

		test("blocks exhausted Gemini counter without blocking healthy Claude counter", async () => {
			if (!authStorage) throw new Error("test setup failed");

			await authStorage.set(providerCase.provider, [
				{
					type: "oauth",
					...createCredential("acct-gemini-exhausted", "proj-gemini-exhausted", "exhausted@example.com"),
				},
				{ type: "oauth", ...createCredential("acct-gemini-healthy", "proj-gemini-healthy", "healthy@example.com") },
			]);

			usageByAccount.set(
				"acct-gemini-exhausted",
				createAntigravityReport({
					provider: providerCase.provider,
					accountId: "acct-gemini-exhausted",
					projectId: "proj-gemini-exhausted",
					windows: [
						{ counter: "google", usedFraction: 1, resetInMs: 12 * HOUR_MS },
						{ counter: "anthropic", usedFraction: 0.05, resetInMs: 12 * HOUR_MS },
					],
				}),
			);
			usageByAccount.set(
				"acct-gemini-healthy",
				createAntigravityReport({
					provider: providerCase.provider,
					accountId: "acct-gemini-healthy",
					projectId: "proj-gemini-healthy",
					windows: [
						{ counter: "google", usedFraction: 0.3, resetInMs: 20 * HOUR_MS },
						{ counter: "anthropic", usedFraction: 0.7, resetInMs: 20 * HOUR_MS },
					],
				}),
			);

			const geminiKey = await authStorage.getApiKey(
				providerCase.provider,
				`session-${providerCase.provider}-gemini`,
				{
					modelId: providerCase.geminiModelId,
				},
			);
			expect(geminiKey).toBe("api-acct-gemini-healthy");

			const counts = new Map<string, number>();
			for (let index = 0; index < 80; index += 1) {
				const apiKey = await authStorage.getApiKey(
					providerCase.provider,
					`session-${providerCase.provider}-claude-${index}`,
					{
						modelId: providerCase.claudeModelId,
					},
				);
				if (!apiKey) continue;
				counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
			}

			expect(counts.get("api-acct-gemini-exhausted") ?? 0).toBeGreaterThan(
				counts.get("api-acct-gemini-healthy") ?? 0,
			);
		});

		test("ranks by bottleneck counter instead of healthier secondary counter", async () => {
			if (!authStorage) throw new Error("test setup failed");

			await authStorage.set(providerCase.provider, [
				{ type: "oauth", ...createCredential("acct-gemini-hot", "proj-gemini-hot", "hot@example.com") },
				{ type: "oauth", ...createCredential("acct-balanced", "proj-balanced", "balanced@example.com") },
			]);

			usageByAccount.set(
				"acct-gemini-hot",
				createAntigravityReport({
					provider: providerCase.provider,
					accountId: "acct-gemini-hot",
					projectId: "proj-gemini-hot",
					windows: [
						{ counter: "google", usedFraction: 0.95, resetInMs: 8 * HOUR_MS },
						{ counter: "anthropic", usedFraction: 0, resetInMs: 8 * HOUR_MS },
					],
				}),
			);
			usageByAccount.set(
				"acct-balanced",
				createAntigravityReport({
					provider: providerCase.provider,
					accountId: "acct-balanced",
					projectId: "proj-balanced",
					windows: [
						{ counter: "google", usedFraction: 0.8, resetInMs: 8 * HOUR_MS },
						{ counter: "anthropic", usedFraction: 0.7, resetInMs: 8 * HOUR_MS },
					],
				}),
			);

			const counts = new Map<string, number>();
			for (let index = 0; index < 80; index += 1) {
				const apiKey = await authStorage.getApiKey(
					providerCase.provider,
					`session-${providerCase.provider}-bottleneck-${index}`,
					{
						modelId: providerCase.geminiModelId,
					},
				);
				if (!apiKey) continue;
				counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
			}

			expect(counts.get("api-acct-balanced") ?? 0).toBeGreaterThan(counts.get("api-acct-gemini-hot") ?? 0);
		});

		test("prefers less-pressured account when neither is exhausted", async () => {
			if (!authStorage) throw new Error("test setup failed");

			await authStorage.set(providerCase.provider, [
				{ type: "oauth", ...createCredential("acct-loaded", "proj-loaded", "loaded@example.com") },
				{ type: "oauth", ...createCredential("acct-fresh", "proj-fresh", "fresh@example.com") },
			]);

			usageByAccount.set(
				"acct-loaded",
				createAntigravityReport({
					provider: providerCase.provider,
					accountId: "acct-loaded",
					projectId: "proj-loaded",
					windows: [{ counter: "google", usedFraction: 0.8, resetInMs: 4 * HOUR_MS }],
				}),
			);
			usageByAccount.set(
				"acct-fresh",
				createAntigravityReport({
					provider: providerCase.provider,
					accountId: "acct-fresh",
					projectId: "proj-fresh",
					windows: [{ counter: "google", usedFraction: 0.05, resetInMs: 4 * HOUR_MS }],
				}),
			);

			const counts = new Map<string, number>();
			for (let index = 0; index < 60; index += 1) {
				const apiKey = await authStorage.getApiKey(
					providerCase.provider,
					`session-${providerCase.provider}-fresh-${index}`,
					{
						modelId: providerCase.geminiModelId,
					},
				);
				if (!apiKey) continue;
				counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
			}

			const fresh = counts.get("api-acct-fresh") ?? 0;
			const loaded = counts.get("api-acct-loaded") ?? 0;
			expect(fresh).toBeGreaterThan(loaded);
		});
	});
}
