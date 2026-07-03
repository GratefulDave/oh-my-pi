import { describe, expect, it, mock } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { applyProfile } from "../../../../.omp/extensions/profile-manager/index.ts";

// ── Stubs ────────────────────────────────────────────────────────────────────

function makeModel(provider: string, id: string): Model {
	return { provider, id } as unknown as Model;
}

interface ApiCallLog {
	replaceModelRoles: ReturnType<typeof mock>;
	overrideEnabledModels: ReturnType<typeof mock>;
	overrideModelRoles: ReturnType<typeof mock>;
	setModel: ReturnType<typeof mock>;
	setThinkingLevel: ReturnType<typeof mock>;
}

function makeStubApi(log: ApiCallLog) {
	return {
		setModel: log.setModel,
		setThinkingLevel: log.setThinkingLevel,
		sendMessage: mock(),
		getFlag: mock(() => undefined),
		// The three methods that are the test subject:
		replaceModelRoles: log.replaceModelRoles,
		overrideEnabledModels: log.overrideEnabledModels,
		overrideModelRoles: log.overrideModelRoles,
	};
}

function makeStubCtx(models: Model[] = []) {
	const allModels = models;
	return {
		models: { list: () => models },
		modelRegistry: {
			getAll: () => allModels,
			find: (_p: string, _id: string) => undefined,
			resolveCanonicalModel: (_id: string) => undefined,
			getCanonicalVariants: () => [],
		},
		hasUI: false,
	};
}

function freshLog(): ApiCallLog {
	return {
		replaceModelRoles: mock(),
		overrideEnabledModels: mock(),
		overrideModelRoles: mock(),
		setModel: mock(() => true),
		setThinkingLevel: mock(),
	};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("profile-manager applyProfile", () => {
	describe("role override method", () => {
		it("calls replaceModelRoles (not additive overrideModelRoles)", async () => {
			const log = freshLog();
			const api = makeStubApi(log);
			const ctx = makeStubCtx([makeModel("ag", "claude-sonnet-4-6")]);

			const profile = {
				modelRoles: { default: "ag/claude-sonnet-4-6:auto" },
				enabledModels: ["ag/*"],
			};

			await applyProfile(api as never, ctx as never, profile);

			expect(log.replaceModelRoles).toHaveBeenCalledTimes(1);
			expect(log.replaceModelRoles).toHaveBeenCalledWith(profile.modelRoles);
			expect(log.overrideModelRoles).not.toHaveBeenCalled();
		});

		it("replaces with empty object when profile has no modelRoles", async () => {
			const log = freshLog();
			const api = makeStubApi(log);
			const ctx = makeStubCtx([]);

			await applyProfile(api as never, ctx as never, {});

			expect(log.replaceModelRoles).toHaveBeenCalledTimes(1);
			expect(log.replaceModelRoles).toHaveBeenCalledWith({});
		});
	});

	describe("enabledModels override", () => {
		it("calls overrideEnabledModels with profile patterns", async () => {
			const log = freshLog();
			const api = makeStubApi(log);
			const ctx = makeStubCtx([makeModel("ag", "claude-sonnet-4-6")]);

			await applyProfile(api as never, ctx as never, {
				modelRoles: { default: "ag/claude-sonnet-4-6:auto" },
				enabledModels: ["ag/*"],
			});

			expect(log.overrideEnabledModels).toHaveBeenCalledTimes(1);
			expect(log.overrideEnabledModels).toHaveBeenCalledWith(["ag/*"]);
		});

		it("calls overrideEnabledModels(null) when profile has no enabledModels", async () => {
			const log = freshLog();
			const api = makeStubApi(log);
			const ctx = makeStubCtx([makeModel("ag", "claude-sonnet-4-6")]);

			await applyProfile(api as never, ctx as never, {
				modelRoles: { default: "ag/claude-sonnet-4-6:auto" },
			});

			expect(log.overrideEnabledModels).toHaveBeenCalledTimes(1);
			expect(log.overrideEnabledModels).toHaveBeenCalledWith(null);
		});

		it("calls overrideEnabledModels(null) when enabledModels is empty array", async () => {
			const log = freshLog();
			const api = makeStubApi(log);
			const ctx = makeStubCtx([makeModel("ag", "claude-sonnet-4-6")]);

			await applyProfile(api as never, ctx as never, {
				modelRoles: { default: "ag/claude-sonnet-4-6:auto" },
				enabledModels: [],
			});

			expect(log.overrideEnabledModels).toHaveBeenCalledTimes(1);
			expect(log.overrideEnabledModels).toHaveBeenCalledWith(null);
		});
	});

	describe("switchModel=false skips model switch but still applies overrides", () => {
		it("applies role + enabledModels overrides even without model switch", async () => {
			const log = freshLog();
			const api = makeStubApi(log);
			const ctx = makeStubCtx([]);

			await applyProfile(api as never, ctx as never, {
				modelRoles: { default: "ag/claude-sonnet-4-6:auto" },
				enabledModels: ["ag/*"],
			}, { switchModel: false });

			expect(log.replaceModelRoles).toHaveBeenCalledTimes(1);
			expect(log.overrideEnabledModels).toHaveBeenCalledTimes(1);
			expect(log.overrideEnabledModels).toHaveBeenCalledWith(["ag/*"]);
			expect(log.setModel).not.toHaveBeenCalled();
		});
	});
});
