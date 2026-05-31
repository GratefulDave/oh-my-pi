import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getBundledModel, type TextContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ORCHESTRATE_NOTICE } from "@oh-my-pi/pi-coding-agent/modes/orchestrate";
import { WORKFLOW_NOTICE } from "@oh-my-pi/pi-coding-agent/modes/workflow";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

type ObservedCall = { roles: AgentMessage["role"][]; texts: string[] };

function getMessageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((value): value is TextContent => !!value && typeof value === "object" && value.type === "text")
		.map(value => value.text)
		.join("\n");
}

describe("AgentSession magic keyword notices", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	const observedCalls: ObservedCall[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-agent-session-magic-keywords-");
		observedCalls.length = 0;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				observedCalls.push({
					roles: context.messages.map(message => message.role),
					texts: context.messages.map(message => getMessageText(message)),
				});
				const response = createAssistantMessage("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, toolRegistry: new Map() });
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("appends hidden orchestrate and workflow notices for prose keywords", async () => {
		await session.prompt("please orchestrate this workflow");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.texts).toEqual([
			"please orchestrate this workflow",
			ORCHESTRATE_NOTICE,
			WORKFLOW_NOTICE,
		]);
		expect(observedCalls[0]?.roles).toHaveLength(3);
	});

	it("skips hidden notices for synthetic prompts", async () => {
		await session.prompt("please orchestrate this workflow", { synthetic: true });

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.texts).toEqual(["please orchestrate this workflow"]);
		expect(observedCalls[0]?.roles).toHaveLength(1);
	});
});
