import { afterEach, describe, expect, it, vi } from "bun:test";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import * as bashMinimizerGain from "@oh-my-pi/pi-coding-agent/tools/bash-minimizer-gain";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "bash.stripTrailingHeadTail") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "search.enabled") return false;
				if (key === "find.enabled") return false;
				return undefined;
			},
			getAgentDir() {
				return "/tmp/agent";
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("BashTool non-zero exit", () => {
	it("resolves with an error result carrying execution details instead of throwing", async () => {
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-fail", { command: "exit 3" });

		// A completed command that failed is a non-throwing error result so the
		// renderer keeps the wall time / timeout / exit-code footer.
		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(3);
		expect(result.details?.timeoutSeconds).toBe(300);
		expect(typeof result.details?.wallTimeMs).toBe("number");

		// The LLM-facing text still states the exit code verbatim.
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("Command exited with code 3");
	});

	it("returns a success result with no exit-code detail for a zero exit", async () => {
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-ok", { command: "printf hi" });

		expect(result.isError).toBeUndefined();
		expect(result.details?.exitCode).toBeUndefined();
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("hi");
		expect(text).not.toContain("Command exited with code");
	});

	it("records minimizer gain after a minimized command completes", async () => {
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue({
			output: "filtered output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 15,
			outputLines: 1,
			outputBytes: 15,
			minimized: {
				filter: "bun-test",
				inputBytes: 4_000,
				outputBytes: 1_000,
			},
		});
		const appendSpy = vi.spyOn(bashMinimizerGain, "appendBashMinimizerGainRecord").mockResolvedValue();

		const tool = new BashTool(makeSession());
		await tool.execute("call-minimized", { command: "bun test noisy.test.ts", cwd: "/tmp" });

		expect(appendSpy).toHaveBeenCalledWith({
			command: "bun test noisy.test.ts",
			cwd: "/tmp",
			sessionCwd: "/tmp",
			filter: "bun-test",
			inputBytes: 4_000,
			outputBytes: 1_000,
			exitCode: 0,
			agentDir: "/tmp/agent",
		});
	});
});
