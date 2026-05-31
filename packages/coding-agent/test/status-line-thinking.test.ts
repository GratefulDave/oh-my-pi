import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, getBundledModel } from "@oh-my-pi/pi-ai";
import type { SegmentContext } from "../src/modes/components/status-line/segments";
import { renderSegment } from "../src/modes/components/status-line/segments";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(() => {
	initTheme();
});

const reasoningModel = {
	...getBundledModel("anthropic", "claude-sonnet-4-5")!,
	reasoning: true,
	thinking: undefined,
};

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function createCtx(session: Partial<SegmentContext["session"]>): SegmentContext {
	return {
		session: {
			state: {} as SegmentContext["session"]["state"],
			isFastModeActive: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
			...session,
		} as unknown as SegmentContext["session"],
		width: 120,
		options: {},
		planMode: null,
		loopMode: null,
		goalMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		subagentQueued: 0,
		sessionStartTime: Date.now(),
		git: { branch: null, status: null, pr: null },
	};
}

describe("status-line thinking indicator", () => {
	it("renders concrete thinking for reasoning models without thinking metadata", () => {
		const rendered = renderSegment(
			"model",
			createCtx({
				state: { model: reasoningModel, thinkingLevel: Effort.High } as SegmentContext["session"]["state"],
				thinkingLevel: Effort.High,
			}),
		);

		expect(stripAnsi(rendered.content)).toContain("high");
	});

	it("renders auto pending", () => {
		const rendered = renderSegment(
			"model",
			createCtx({
				state: { model: reasoningModel } as SegmentContext["session"]["state"],
				thinkingLevel: ThinkingLevel.Auto,
				configuredThinkingLevel: () => ThinkingLevel.Auto,
				isAutoThinking: true,
				autoThinkingResolving: true,
			}),
		);

		expect(stripAnsi(rendered.content)).toContain("auto");
	});

	it("renders auto resolved", () => {
		const rendered = renderSegment(
			"model",
			createCtx({
				state: { model: reasoningModel } as SegmentContext["session"]["state"],
				thinkingLevel: ThinkingLevel.Auto,
				configuredThinkingLevel: () => ThinkingLevel.Auto,
				isAutoThinking: true,
				autoThinkingResolving: false,
				autoResolvedThinkingLevel: () => Effort.Medium,
			}),
		);

		const content = stripAnsi(rendered.content);
		expect(content).toContain("auto →");
		expect(content).toContain("med");
	});
});
