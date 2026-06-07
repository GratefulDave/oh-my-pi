import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme, theme } from "../src/modes/theme/theme";
import { type JobToolDetails, jobToolRenderer } from "../src/tools/job";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

beforeAll(async () => {
	await initTheme(false);
});

describe("job tool renderer", () => {
	test("renders running async jobs as the compact agents tree", () => {
		const component = jobToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					jobs: [
						{
							id: "BridgeReview",
							type: "task",
							status: "running",
							label: "BridgeReview",
							durationMs: 131_000,
						},
						{
							id: "AccountReview",
							type: "task",
							status: "running",
							label: "AccountReview",
							durationMs: 131_000,
						},
					],
				} satisfies JobToolDetails,
			},
			{ expanded: false, isPartial: false, spinnerFrame: 0 },
			theme,
		);
		const lines = component.render(120).map(line => line.replace(ANSI_PATTERN, ""));

		expect(lines[0]).toMatch(/^[^ ]+ Working\.\.\.$/);
		expect(lines[1]).toBe("● Agents");
		expect(lines.some(line => /^├ [^ ]+ BridgeReview · 2m11s$/.test(line))).toBe(true);
		expect(lines).toContain("│ └ Running in background (ID: BridgeReview)");
		expect(lines).toContain("│ └ thinking…");
		expect(lines.some(line => /^└ [^ ]+ AccountReview · 2m11s$/.test(line))).toBe(true);
		expect(lines).not.toContain("ⓘ Job: waiting on 2 of 2 2 running");
		expect(lines.some(line => line.includes("⟦task⟧"))).toBe(false);
	});
});
