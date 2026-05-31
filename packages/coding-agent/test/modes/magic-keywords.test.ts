import { beforeAll, describe, expect, it } from "bun:test";
import { highlightMagicKeywords } from "../../src/modes/magic-keywords";
import { initTheme } from "../../src/modes/theme/theme";

beforeAll(() => {
	initTheme();
});

describe("magic keyword highlighting", () => {
	it("highlights prose keywords without changing visible text", () => {
		const text = "ultrathink orchestrate workflow";
		const highlighted = highlightMagicKeywords(text);

		expect(highlighted).not.toBe(text);
		expect(highlighted.replace(/\x1b\[[0-9;]*m/g, "")).toBe(text);
	});

	it("does not highlight code spans", () => {
		const text = "`orchestrate`";

		expect(highlightMagicKeywords(text)).toBe(text);
	});
});
