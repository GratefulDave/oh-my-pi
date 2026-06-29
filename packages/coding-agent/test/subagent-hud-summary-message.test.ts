import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	buildSubagentHudSummaryBlock,
	type SubagentHudSummaryDetails,
} from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

let ansi = {
	accent: "",
	success: "",
	error: "",
};

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Failed to load dark theme");
	setThemeInstance(theme);
	ansi = {
		accent: theme.getFgAnsi("accent"),
		success: theme.getFgAnsi("success"),
		error: theme.getFgAnsi("error"),
	};
});

describe("subagent HUD summary message", () => {
	it("renders settled rows with accent labels and status-colored metrics", () => {
		const message: CustomMessage<SubagentHudSummaryDetails> = {
			role: "custom",
			customType: "subagent-hud-summary",
			content: "2 agents settled",
			display: true,
			attribution: "agent",
			timestamp: 1,
			details: {
				emittedAt: 1,
				rows: [
					{
						id: "done-1",
						roleLabel: "task",
						label: "Done worker",
						status: "completed",
						toolCount: 2,
						tokenLabel: "1.2k tokens",
						durationLabel: "1.4s",
					},
					{
						id: "fail-1",
						roleLabel: "reviewer",
						label: "Failed worker",
						status: "failed",
						toolCount: 3,
						tokenLabel: "2.4k tokens",
						durationLabel: "2.3s",
						failureReason: "boom",
					},
				],
			},
		};

		const raw = buildSubagentHudSummaryBlock(message).render(120).join("\n");
		const stripped = Bun.stripANSI(raw);

		expect(stripped).toContain("2 agents settled");
		expect(raw).toContain(`${ansi.accent}[task]\x1b[39m`);
		expect(raw).toContain(`${ansi.accent}Done worker\x1b[39m`);
		expect(raw).toContain(`${ansi.success}2 tool use(s)\x1b[39m`);
		expect(raw).toContain(`${ansi.error}3 tool use(s)\x1b[39m`);
		expect(raw).toContain(`${ansi.accent}[reviewer]\x1b[39m`);
		expect(stripped).toContain("boom");
	});
});
