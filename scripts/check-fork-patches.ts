#!/usr/bin/env bun
/**
 * Post-merge fork-patch integrity checker.
 *
 * Verifies that all known fork-only patches survived an upstream merge.
 * Run after every `git merge upstream/main` and before `./rebuild-lex.zsh`.
 *
 * Usage: bun scripts/check-fork-patches.ts
 *
 * Exit code: 0 = all patches present, 1 = one or more patches missing.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

interface PatchCheck {
	id: string;
	description: string;
	/** Returns a string describing what's missing, or null if the patch is intact. */
	check(): string | null;
}

function fileContains(file: string, pattern: string | RegExp): boolean {
	try {
		const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
		return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
	} catch {
		return false;
	}
}

function fileExists(file: string): boolean {
	return fs.existsSync(path.join(repoRoot, file));
}

function countMatches(file: string, pattern: RegExp): number {
	try {
		const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
		return (text.match(pattern) ?? []).length;
	} catch {
		return 0;
	}
}

const checks: PatchCheck[] = [
	// ── Patch 1: replaceModelRoles ────────────────────────────────────────────
	{
		id: "P1a",
		description: "settings.ts: replaceModelRoles() method",
		check() {
			return fileContains("packages/coding-agent/src/config/settings.ts", "replaceModelRoles")
				? null
				: "replaceModelRoles() missing from settings.ts";
		},
	},
	{
		id: "P1b",
		description: "types.ts: replaceModelRoles in ExtensionAPI/ExtensionActions",
		check() {
			return fileContains("packages/coding-agent/src/extensibility/extensions/types.ts", "replaceModelRoles")
				? null
				: "replaceModelRoles missing from extensions/types.ts";
		},
	},
	{
		id: "P1c",
		description: "loader.ts: replaceModelRoles stub + real impl",
		check() {
			const count = countMatches(
				"packages/coding-agent/src/extensibility/extensions/loader.ts",
				/replaceModelRoles/g,
			);
			return count >= 2 ? null : `replaceModelRoles wiring in loader.ts: expected ≥2, got ${count}`;
		},
	},
	{
		id: "P1d",
		description: "runner.ts: replaceModelRoles wired to actions",
		check() {
			return fileContains("packages/coding-agent/src/extensibility/extensions/runner.ts", "replaceModelRoles")
				? null
				: "replaceModelRoles missing from runner.ts";
		},
	},
	{
		id: "P1e",
		description: "runtime-init.ts: replaceModelRoles wired",
		check() {
			return fileContains("packages/coding-agent/src/modes/runtime-init.ts", "replaceModelRoles")
				? null
				: "replaceModelRoles missing from runtime-init.ts";
		},
	},
	{
		id: "P1f",
		description: "acp-agent.ts: replaceModelRoles wired",
		check() {
			return fileContains("packages/coding-agent/src/modes/acp/acp-agent.ts", "replaceModelRoles")
				? null
				: "replaceModelRoles missing from acp-agent.ts";
		},
	},
	{
		id: "P1g",
		description: "extension-ui-controller.ts: replaceModelRoles wired (×2)",
		check() {
			const count = countMatches(
				"packages/coding-agent/src/modes/controllers/extension-ui-controller.ts",
				/replaceModelRoles/g,
			);
			return count >= 2 ? null : `replaceModelRoles in extension-ui-controller.ts: expected ≥2, got ${count}`;
		},
	},
	{
		id: "P1h",
		description: "executor.ts: replaceModelRoles wired",
		check() {
			return fileContains("packages/coding-agent/src/task/executor.ts", "replaceModelRoles")
				? null
				: "replaceModelRoles missing from task/executor.ts";
		},
	},

	// ── Patch 2: bash.ts env type widening ───────────────────────────────────
	{
		id: "P2",
		description: "bash.ts: env typed as Record<string, unknown>",
		check() {
			const count = countMatches("packages/coding-agent/src/tools/bash.ts", /Record<string,\s*unknown>/g);
			return count >= 3 ? null : `bash.ts Record<string, unknown> env widening: expected ≥3, got ${count}`;
		},
	},

	// ── Patch 3: Subagent HUD spinner + settle summary ────────────────────────
	{
		id: "P3a",
		description: "interactive-mode.ts: spinner + settle detection",
		check() {
			const missing: string[] = [];
			if (!fileContains("packages/coding-agent/src/modes/interactive-mode.ts", "#subagentSpinnerInterval"))
				missing.push("#subagentSpinnerInterval");
			if (!fileContains("packages/coding-agent/src/modes/interactive-mode.ts", "#hadActiveSubagents"))
				missing.push("#hadActiveSubagents");
			if (!fileContains("packages/coding-agent/src/modes/interactive-mode.ts", "SUBAGENT_HUD_SUMMARY_MESSAGE_TYPE"))
				missing.push("SUBAGENT_HUD_SUMMARY_MESSAGE_TYPE reference");
			return missing.length === 0 ? null : `interactive-mode.ts missing: ${missing.join(", ")}`;
		},
	},
	{
		id: "P3b",
		description: "transcript-render-helpers.ts: SubagentHudSummaryDetails + buildSubagentHudSummaryBlock",
		check() {
			const missing: string[] = [];
			if (
				!fileContains(
					"packages/coding-agent/src/modes/utils/transcript-render-helpers.ts",
					"SUBAGENT_HUD_SUMMARY_MESSAGE_TYPE",
				)
			)
				missing.push("SUBAGENT_HUD_SUMMARY_MESSAGE_TYPE");
			if (
				!fileContains(
					"packages/coding-agent/src/modes/utils/transcript-render-helpers.ts",
					"buildSubagentHudSummaryBlock",
				)
			)
				missing.push("buildSubagentHudSummaryBlock");
			return missing.length === 0 ? null : `transcript-render-helpers.ts missing: ${missing.join(", ")}`;
		},
	},
	{
		id: "P3c",
		description: "chat-transcript-builder.ts + ui-helpers.ts: render subagent-hud-summary",
		check() {
			const missing: string[] = [];
			if (
				!fileContains(
					"packages/coding-agent/src/modes/components/chat-transcript-builder.ts",
					"SUBAGENT_HUD_SUMMARY_MESSAGE_TYPE",
				)
			)
				missing.push("chat-transcript-builder.ts");
			if (!fileContains("packages/coding-agent/src/modes/utils/ui-helpers.ts", "SUBAGENT_HUD_SUMMARY_MESSAGE_TYPE"))
				missing.push("ui-helpers.ts");
			return missing.length === 0 ? null : `subagent-hud-summary render missing from: ${missing.join(", ")}`;
		},
	},

	// ── Patch 4: status-line metaColor option ────────────────────────────────
	{
		id: "P4",
		description: "status-line.ts: metaColor option",
		check() {
			return fileContains("packages/coding-agent/src/tui/status-line.ts", "metaColor")
				? null
				: "metaColor option missing from status-line.ts";
		},
	},

	// ── Patch 5: sdk.ts extension preload inheritance ─────────────────────────
	{
		id: "P5",
		description: "sdk.ts: getPreloadedExtensions / preloadedExtensions",
		check() {
			const count = countMatches("packages/coding-agent/src/sdk.ts", /getPreloadedExtensions|preloadedExtensions/g);
			return count >= 2 ? null : `sdk.ts preload inheritance: expected ≥2 occurrences, got ${count}`;
		},
	},

	// ── Patch 6: task/disabled-agents.ts ─────────────────────────────────────
	{
		id: "P6",
		description: "task/disabled-agents.ts: isAlwaysEnabledAgent()",
		check() {
			return fileExists("packages/coding-agent/src/task/disabled-agents.ts")
				? null
				: "task/disabled-agents.ts missing";
		},
	},

	// ── Patch 7: natives nightly PATH fix ────────────────────────────────────
	{
		id: "P7",
		description: "natives/scripts/build-native.ts: Homebrew rustc PATH fix",
		check() {
			return fileContains("packages/natives/scripts/build-native.ts", "toolchainBin")
				? null
				: "nightly toolchain PATH prepend missing from build-native.ts";
		},
	},

	// ── Patch 8: automatic agents use OpenAI Codex, never OpenRouter ──────────
	{
		id: "P8",
		description: "automatic agent routing: OpenRouter families map to OpenAI Codex",
		check() {
			const missing: string[] = [];
			const executor = "packages/coding-agent/src/task/executor.ts";
			if (!fileContains(executor, '"claude-opus": "openai-codex/gpt-5.6-sol:auto"')) missing.push("Opus → Sol");
			if (!fileContains(executor, '"claude-sonnet": "openai-codex/gpt-5.6-terra:auto"'))
				missing.push("Sonnet → Terra");
			if (!fileContains(executor, '"claude-haiku": "openai-codex/gpt-5.6-luna:auto"')) missing.push("Haiku → Luna");
			if (!fileContains(executor, 'model.provider !== "openrouter"')) missing.push("OpenRouter exclusion");
			if (!fileContains("packages/coding-agent/src/task/structured-subagent.ts", "enforceAutomaticModelPolicy"))
				missing.push("task routing enforcement");
			if (!fileContains("packages/coding-agent/src/vibe/runtime.ts", "enforceAutomaticModelPolicy"))
				missing.push("Vibe routing enforcement");
			if (!fileContains("rebuild-lex.zsh", "set-agent-codex-defaults.ts"))
				missing.push("rebuild config normalization");
			return missing.length === 0 ? null : `automatic agent Codex policy missing: ${missing.join(", ")}`;
		},
	},

	// ── Patch 9: fork tooling scripts ─────────────────────────────────────────
	{
		id: "P9",
		description: "rebuild-lex.zsh: fork rebuild entrypoint",
		check() {
			return fileExists("rebuild-lex.zsh") ? null : "rebuild-lex.zsh missing";
		},
	},

	// ── Patch 10: profile-manager uses replaceModelRoles + overrideEnabledModels ──
	{
		id: "P10a",
		description: "profile-manager: applyProfile calls replaceModelRoles (not overrideModelRoles)",
		check() {
			const file = ".omp/extensions/profile-manager/index.ts";
			if (!fileContains(file, "replaceModelRoles")) {
				return "replaceModelRoles missing from profile-manager/index.ts";
			}
			// The applyProfile function must not call overrideModelRoles (additive).
			// overrideModelRoles may still appear in the ExtensionAPIWithSessionOverrides interface declaration.
			const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
			const applyProfileStart = text.indexOf("async function applyProfile(");
			if (applyProfileStart === -1) return "applyProfile function not found in profile-manager/index.ts";
			// Find the end of the function (next function declaration or closing brace at column 0)
			const afterFn = text.slice(applyProfileStart);
			const nextFnIdx = afterFn.search(/\n(?:function|async function|export )/);
			const fnBody = nextFnIdx > 0 ? afterFn.slice(0, nextFnIdx) : afterFn;
			if (fnBody.includes("overrideModelRoles")) {
				return "applyProfile calls overrideModelRoles (additive) instead of replaceModelRoles";
			}
			return null;
		},
	},
	{
		id: "P10b",
		description: "profile-manager: applyProfile calls overrideEnabledModels",
		check() {
			const file = ".omp/extensions/profile-manager/index.ts";
			const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
			const applyProfileStart = text.indexOf("async function applyProfile(");
			if (applyProfileStart === -1) return "applyProfile function not found in profile-manager/index.ts";
			const afterFn = text.slice(applyProfileStart);
			const nextFnIdx = afterFn.search(/\n(?:function|async function|export )/);
			const fnBody = nextFnIdx > 0 ? afterFn.slice(0, nextFnIdx) : afterFn;
			return fnBody.includes("overrideEnabledModels")
				? null
				: "overrideEnabledModels call missing from applyProfile in profile-manager/index.ts";
		},
	},
];

// ── Run checks ────────────────────────────────────────────────────────────────

const failures: { id: string; description: string; message: string }[] = [];
const passes: string[] = [];

for (const check of checks) {
	const result = check.check();
	if (result === null) {
		passes.push(check.id);
	} else {
		failures.push({ id: check.id, description: check.description, message: result });
	}
}

// ── Report ────────────────────────────────────────────────────────────────────

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

console.log();
console.log(bold("Fork patch integrity check"));
console.log(`  ${passes.length} passed, ${failures.length} failed\n`);

if (passes.length > 0) {
	console.log(green(`  ✓ ${passes.join("  ✓ ")}`));
}

if (failures.length > 0) {
	console.log();
	for (const f of failures) {
		console.log(red(`  ✗ [${f.id}] ${f.description}`));
		console.log(`       ${yellow(f.message)}`);
	}
	console.log();
	console.log(red(bold("  PATCHES MISSING — re-apply before rebuilding.")));
	console.log("  See docs/upstream-rebase-and-fork-maintenance.md §3 for each patch.");
	console.log();
	process.exit(1);
} else {
	console.log();
	console.log(green(bold("  All fork patches intact.")));
	console.log();
}
