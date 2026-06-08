import { describe, expect, test } from "bun:test";
import { renderJobResult } from "../src/job-renderer";
import { stripAnsi } from "../src/renderer";

const theme = {
	fg(_color: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
};

describe("observer job renderer extension", () => {
	test("replaces old job waiting header with phase task hierarchy", () => {
		const lines = renderJobResult(
			{
				content: [],
				details: {
					jobs: [
						{
							id: "PaperAppendixReviewer",
							type: "task",
							status: "running",
							label: "PaperAppendixReviewer",
							durationMs: 94_000,
						},
						{
							id: "StatusLockedReviewer",
							type: "task",
							status: "running",
							label: "StatusLockedReviewer",
							durationMs: 94_000,
						},
						{
							id: "NoEmailStrategyReviewer",
							type: "task",
							status: "running",
							label: "NoEmailStrategyReviewer",
							durationMs: 94_000,
						},
					],
				},
			},
			{ expanded: false, spinnerFrame: 0 },
			theme,
		)
			.render(120)
			.map(line => stripAnsi(line).trimEnd());

		expect(lines[0]).toBe("⠋ Working...");
		expect(lines[1]).toBe("● Phase");
		expect(lines[2]).toBe("├ Agents");
		expect(lines[3]).toBe("└ Tasks");
		expect(lines).toContain("  ├ ⠋ PaperAppendixReviewer · 1m34s");
		expect(lines).toContain("  │ └ running background detail · PaperAppendixReviewer");
		expect(lines).toContain("  └ ⠋ NoEmailStrategyReviewer · 1m34s");
		expect(lines.join("\n")).not.toContain("Job: waiting on");
		expect(lines.join("\n")).not.toContain("⟦task⟧");
	});
});
