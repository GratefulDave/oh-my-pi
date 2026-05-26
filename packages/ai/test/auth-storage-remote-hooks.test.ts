import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	type AuthCredentialStore,
	AuthStorage,
	type OAuthCredential,
	type StoredAuthCredential,
} from "../src/auth-storage";
import * as openaiCodexOAuth from "../src/utils/oauth/openai-codex";

function createHookedStore() {
	let nextId = 1;
	const rows = new Map<string, StoredAuthCredential[]>();
	const calls = {
		remoteReplace: 0,
		remoteUpsert: 0,
		remoteDelete: 0,
		syncReplace: 0,
		syncUpsert: 0,
		syncDelete: 0,
		providers: [] as string[],
	};

	const makeStored = (
		provider: string,
		credential: OAuthCredential | { type: "api_key"; key: string },
	): StoredAuthCredential => ({
		id: nextId++,
		provider,
		credential,
		disabledCause: null,
	});

	const store: AuthCredentialStore = {
		close() {},
		listAuthCredentials(provider?: string): StoredAuthCredential[] {
			if (provider) return [...(rows.get(provider) ?? [])];
			return [...rows.values()].flatMap(entries => [...entries]);
		},
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		replaceAuthCredentialsForProvider() {
			calls.syncReplace += 1;
			throw new Error("sync replace should not be used");
		},
		upsertAuthCredentialForProvider() {
			calls.syncUpsert += 1;
			throw new Error("sync upsert should not be used");
		},
		deleteAuthCredentialsForProvider() {
			calls.syncDelete += 1;
			throw new Error("sync delete should not be used");
		},
		getCache() {
			return null;
		},
		setCache() {},
		cleanExpiredCache() {},
		async replaceAuthCredentialsRemote(provider, credentials) {
			calls.remoteReplace += 1;
			calls.providers.push(provider);
			const stored = credentials.map(credential => makeStored(provider, credential));
			rows.set(provider, stored);
			return [...stored];
		},
		async upsertAuthCredentialRemote(provider, credential) {
			calls.remoteUpsert += 1;
			calls.providers.push(provider);
			const stored = [makeStored(provider, credential)];
			rows.set(provider, stored);
			return [...stored];
		},
		async deleteAuthCredentialsRemote(provider) {
			calls.remoteDelete += 1;
			calls.providers.push(provider);
			rows.delete(provider);
		},
	};

	return { calls, store };
}

describe("AuthStorage remote write hooks", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("set/remove route through remote hooks", async () => {
		const { calls, store } = createHookedStore();
		const storage = new AuthStorage(store);
		await storage.reload();

		await storage.set("kagi", { type: "api_key", key: "new-key" });
		expect(calls.remoteReplace).toBe(1);
		expect(calls.syncReplace).toBe(0);
		expect(storage.get("kagi")).toEqual({ type: "api_key", key: "new-key" });

		await storage.remove("kagi");
		expect(calls.remoteDelete).toBe(1);
		expect(calls.syncDelete).toBe(0);
		expect(storage.get("kagi")).toBeUndefined();
		storage.close();
	});

	test("device login stores under openai-codex via remote upsert hook", async () => {
		const { calls, store } = createHookedStore();
		const storage = new AuthStorage(store);
		await storage.reload();

		const deviceCredentials: OAuthCredential = {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			accountId: "acct-123",
			email: "user@example.com",
		};
		vi.spyOn(openaiCodexOAuth, "loginOpenAICodexDevice").mockResolvedValue(deviceCredentials);

		await storage.login("openai-codex-device", {
			onAuth() {},
			onPrompt: async () => "",
		});

		expect(calls.remoteUpsert).toBe(1);
		expect(calls.syncUpsert).toBe(0);
		expect(calls.providers).toContain("openai-codex");
		expect(storage.get("openai-codex")).toEqual(deviceCredentials);
		expect(storage.get("openai-codex-device")).toBeUndefined();
		storage.close();
	});
});
