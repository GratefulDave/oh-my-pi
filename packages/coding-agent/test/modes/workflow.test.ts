import { describe, expect, it } from "bun:test";
import { containsWorkflow, WORKFLOW_NOTICE } from "../../src/modes/workflow";

describe("workflow keyword", () => {
	it("matches singular and plural lowercase prose only", () => {
		expect(containsWorkflow("build workflow")).toBe(true);
		expect(containsWorkflow("build workflows")).toBe(true);
		expect(containsWorkflow("build Workflow")).toBe(false);
		expect(containsWorkflow("workflow.ts")).toBe(false);
		expect(containsWorkflow("`workflow`")).toBe(false);
	});

	it("documents eval DAG helpers in hidden notice", () => {
		expect(WORKFLOW_NOTICE).toContain("agent(prompt");
		expect(WORKFLOW_NOTICE).toContain("parallel(thunks");
		expect(WORKFLOW_NOTICE).toContain("pipeline(items");
		expect(WORKFLOW_NOTICE).toContain("barrier");
	});
});
