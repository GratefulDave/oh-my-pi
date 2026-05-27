import { beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { TempDir } from "@oh-my-pi/pi-utils";

import { applyFactoryScaffold } from "../../src/factory/scaffold";

describe("software-factory runtime templates", () => {
	let tempDir: TempDir;
	let cwd: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@factory-runtime-");
		cwd = tempDir.path();
		await Bun.write(path.join(cwd, "package.json"), JSON.stringify({ name: "runtime-demo" }, null, 2));
		await applyFactoryScaffold({
			cwd,
			preset: "software-factory",
			dryRun: false,
			existing: false,
			force: false,
			enableMemory: false,
		});
	});

	it("evaluates safety decisions for dangerous commands and protected paths", async () => {
		const safetyModule = await import(
			pathToFileURL(path.join(cwd, ".omp", "extensions", "software-factory", "safety.ts")).href
		);
		const configModule = await import(
			pathToFileURL(path.join(cwd, ".omp", "extensions", "software-factory", "config.ts")).href
		);
		const rules = await configModule.loadFactorySafetyRules(cwd, await configModule.loadFactoryConfig(cwd));
		const bashDecision = safetyModule.evaluateSafetyEvent(
			{ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "rm -rf /tmp/demo" } },
			cwd,
			rules,
		);
		expect(bashDecision.action).toBe("block");
		const writeDecision = safetyModule.evaluateSafetyEvent(
			{ type: "tool_call", toolCallId: "2", toolName: "write", input: { path: ".env", content: "X=1" } },
			cwd,
			rules,
		);
		expect(writeDecision.action).toBe("ask");
	});

	it("parses verifier reports and requests bounded follow-up on failures", async () => {
		const verifierModule = await import(
			pathToFileURL(path.join(cwd, ".omp", "extensions", "software-factory", "verifier.ts")).href
		);
		const report = verifierModule.parseVerifierReport(
			[
				"STATUS: failed",
				"CONFIDENCE: FEEDBACK",
				"CLAIMS:",
				"- [failed] missing verification",
				"GAPS:",
				"- verify.sh still placeholder",
				"CORRECTION:",
				"- implement repo-specific oracle",
			].join("\n"),
		);
		expect(report.status).toBe("failed");
		expect(report.gaps).toEqual(["verify.sh still placeholder"]);
		expect(verifierModule.shouldRequestFollowUp(report, 0, 2)).toBe(true);
		expect(verifierModule.shouldRequestFollowUp(report, 2, 2)).toBe(false);
		expect(verifierModule.buildVerifierFollowUp(report)).toContain("implement repo-specific oracle");
	});

	it("formats durable memory candidates without inventing verification", async () => {
		const configModule = await import(
			pathToFileURL(path.join(cwd, ".omp", "extensions", "software-factory", "config.ts")).href
		);
		const candidate = configModule.buildFactoryMemoryCandidate({
			kind: "error",
			summary: "Verifier caught missing oracle",
			keywords: ["verifier", "oracle"],
			backend: "off",
		});
		expect(candidate.kind).toBe("error");
		expect(candidate.backend).toBe("off");
		expect(candidate.verification).toBeUndefined();
		expect(candidate.keywords).toEqual(["verifier", "oracle"]);
	});
});
