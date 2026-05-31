import { describe, expect, it } from "bun:test";
import { stripCodeBlocks, truncateTitleInput } from "../src/tiny/text";

describe("stripCodeBlocks & truncateTitleInput", () => {
	it("removes fenced code blocks and preserves surrounding prose", () => {
		const message =
			"Some explanation before\n```typescript\nconst x = 5;\nconsole.log(x);\n```\nSome explanation after";
		const stripped = stripCodeBlocks(message);
		expect(stripped).toContain("Some explanation before");
		expect(stripped).toContain("Some explanation after");
		expect(stripped).not.toContain("const x = 5");
	});

	it("preserves surrounding prose and applies character cap", () => {
		const prose = "A".repeat(2100);
		const message = `${prose}\n\`\`\`\ncode\n\`\`\``;
		const result = truncateTitleInput(message);
		expect(result.length).toBe(2001); // 2000 chars + 1 ellipsis char
		expect(result).not.toContain("code");
	});
});
