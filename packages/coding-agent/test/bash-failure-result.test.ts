import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "session-test-id",
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
			getBashInterceptorRules() {
				return [];
			},
			getAgentDir() {
				return Bun.env.OMP_AGENT_DIR ?? "";
			},
		},
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}
let tempDir: string;
let originalAgentDir: string | undefined;

beforeEach(() => {
	originalAgentDir = Bun.env.OMP_AGENT_DIR;
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bash-gain-"));
	Bun.env.OMP_AGENT_DIR = path.join(tempDir, "agent");
});

afterEach(() => {
	if (originalAgentDir === undefined) delete Bun.env.OMP_AGENT_DIR;
	else Bun.env.OMP_AGENT_DIR = originalAgentDir;
	fs.rmSync(tempDir, { recursive: true, force: true });
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
		const gainPath = path.join(Bun.env.OMP_AGENT_DIR ?? "", "minimizer-gain.jsonl");
		expect(fs.existsSync(gainPath)).toBe(true);
		const records = fs
			.readFileSync(gainPath, "utf8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>);
		expect(records).toHaveLength(1);
		const realTmp = fs.realpathSync("/tmp");
		expect(records[0]).toMatchObject({
			command: "printf hi",
			cwd: realTmp,
			sessionCwd: realTmp,
			sessionId: "session-test-id",
			filter: "printf",
			inputBytes: 2,
			outputBytes: 2,
			savedBytes: 0,
			exitCode: 0,
			kind: "missed",
		});
	});
});
