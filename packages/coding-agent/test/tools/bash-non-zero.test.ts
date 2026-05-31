import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";

describe("BashTool non-zero exit status", () => {
	it("returns isError: true and styled exit details instead of throwing ToolError", async () => {
		const mockSession: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated(),
		} as any;

		const tool = new BashTool(mockSession);
		const result = await tool.execute("bash-1", {
			command: "exit 2",
		});

		expect(result).not.toBeNull();
		expect(result.isError).toBe(true);
		expect(result.details).not.toBeUndefined();
		expect((result.details as any).exitCode).toBe(2);
		expect((result.details as any).timedOut).toBe(false);
	});
});
