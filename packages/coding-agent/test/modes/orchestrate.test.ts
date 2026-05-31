import { describe, expect, it } from "bun:test";
import { containsOrchestrate, ORCHESTRATE_NOTICE } from "../../src/modes/orchestrate";

describe("orchestrate keyword", () => {
	it("matches lowercase whitespace-delimited prose only", () => {
		expect(containsOrchestrate("please orchestrate this change")).toBe(true);
		expect(containsOrchestrate("please Orchestrate this change")).toBe(false);
		expect(containsOrchestrate("orchestrate.ts")).toBe(false);
		expect(containsOrchestrate("`orchestrate`")).toBe(false);
		expect(containsOrchestrate("<mode>orchestrate</mode>")).toBe(false);
	});

	it("requires DAG execution contract in hidden notice", () => {
		expect(ORCHESTRATE_NOTICE).toContain("dependency graph");
		expect(ORCHESTRATE_NOTICE).toContain("parallel waves");
		expect(ORCHESTRATE_NOTICE).toContain("verification gate");
	});
});
