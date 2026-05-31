import { describe, expect, it } from "bun:test";
import type { AgentSession } from "../src/session/agent-session";
import { shakeSession } from "../src/utils/shake-compaction";

describe("shakeSession Compaction", () => {
	it("elides large tool call results and fenced blocks successfully", async () => {
		const mockSessionManager = {
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "toolResult",
						content: [{ type: "text", text: "A".repeat(1500) }],
					},
				},
				{
					type: "message",
					message: {
						role: "user",
						content: [
							{ type: "text", text: `Prose text\n\`\`\`typescript\n${"const x = 5;\n".repeat(100)}\`\`\`` },
						],
					},
				},
			],
			allocateArtifactPath: async () => ({ id: "123", path: "/tmp/shake-123.txt" }),
			rewriteEntries: async () => {},
		};

		const mockSession = {
			messages: mockSessionManager.getBranch().map(e => e.message),
			sessionManager: mockSessionManager,
			settings: {
				get: () => "qwen3-1.7b",
			},
			agent: {
				replaceMessages: () => {},
			},
			buildDisplaySessionContext: () => ({ messages: [] }),
		} as any as AgentSession;

		const result = await shakeSession(mockSession, { summary: false });
		expect(result).not.toBeNull();
		expect(result.elidedCount).toBe(2);
	});
});
