import { describe, expect, it } from "bun:test";
import { keywordInProse, maskNonProse } from "../../src/modes/markdown-prose";

describe("markdown prose masking", () => {
	it("preserves prose and masks fenced, inline, and XML content", () => {
		const text = [
			"orchestrate prose",
			"```ts",
			"orchestrate code",
			"```",
			"inline `orchestrate` prose workflow",
			"<tag>workflow</tag>",
		].join("\n");

		const masked = maskNonProse(text);

		expect(masked).toContain("orchestrate prose");
		expect(masked).toContain("prose workflow");
		expect(masked).not.toContain("orchestrate code");
		expect(masked).not.toContain("<tag>workflow</tag>");
		expect(masked.length).toBe(text.length);
	});

	it("detects keywords only in prose", () => {
		expect(keywordInProse("please orchestrate", /(?<!\S)orchestrate(?!\S)/)).toBe(true);
		expect(keywordInProse("`orchestrate`", /(?<!\S)orchestrate(?!\S)/)).toBe(false);
	});
});
