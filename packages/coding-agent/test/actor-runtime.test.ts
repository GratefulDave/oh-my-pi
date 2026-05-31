import { afterEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { JobTool } from "@oh-my-pi/pi-coding-agent/tools/job";
import { sanitizeIrcReplyText } from "../src/actor/mailbox-router";
import { ActorRunStore } from "../src/actor/run-state";

function makeToolSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "0-Main",
		settings: Settings.isolated({ "async.enabled": true }),
	};
}

describe("actor runtime hardening", () => {
	afterEach(() => {
		AsyncJobManager.resetForTests();
		ActorRunStore.resetGlobalForTests();
	});

	it("classifies missing-yield actor failures and exposes artifact URI", () => {
		const store = ActorRunStore.global();
		store.plan({ id: "0-Worker", agentName: "task", assignment: "Do work" });

		store.complete({
			result: {
				id: "0-Worker",
				agent: "task",
				exitCode: 1,
				stderr: "SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.",
				error: "SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.",
				outputPath: "/tmp/0-Worker.md",
			},
		});

		expect(store.get("0-Worker")).toEqual(
			expect.objectContaining({
				status: "failed",
				failureKind: "yield_missing",
				artifactUri: "agent://0-Worker",
			}),
		);
	});

	it("sanitizes IRC replies before mailbox routing", () => {
		const reply = sanitizeIrcReplyText(
			'Useful answer.\n\n```json\n{"tool_call_id":"abc","tool":"read"}\n```\n\nUseful answer.',
		);

		expect(reply).toEqual({ text: "Useful answer.", droppedReason: "tool_fragment" });
	});

	it("renders actor snapshot details in job list text", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		ActorRunStore.global().plan({ id: "0-Worker", agentName: "task", assignment: "Do work", jobId: "0-Worker" });
		ActorRunStore.global().complete({
			result: {
				id: "0-Worker",
				agent: "task",
				exitCode: 0,
				stderr: "",
				outputPath: "/tmp/0-Worker.md",
				lastIntent: "finishing",
			},
		});

		manager.register("task", "Do work", async () => "done", { id: "0-Worker", ownerId: "0-Main" });
		await manager.waitForAll();

		const result = await new JobTool(makeToolSession()).execute("job-1", { list: true });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Actor: yielded");
		expect(text).toContain("Last intent: finishing");
		expect(text).toContain("Artifact: agent://0-Worker");
	});
});
