import { describe, expect, it } from "bun:test";
import { shouldShowUpdateVersion } from "@oh-my-pi/pi-coding-agent/main";

describe("shouldShowUpdateVersion", () => {
	it("does not report the matching upstream stable release as newer than a lex fork build", () => {
		expect(shouldShowUpdateVersion("15.10.3", "15.10.3-lex")).toBe(false);
	});

	it("still reports a later upstream release as newer than a lex fork build", () => {
		expect(shouldShowUpdateVersion("15.10.4", "15.10.3-lex")).toBe(true);
	});

	it("preserves normal stable version update checks", () => {
		expect(shouldShowUpdateVersion("15.10.3", "15.10.2")).toBe(true);
		expect(shouldShowUpdateVersion("15.10.3", "15.10.3")).toBe(false);
	});
});
