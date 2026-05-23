import { describe, expect, it } from "bun:test";
import { buildIcmExtractArgs, buildIcmRecallQuery, formatIcmRecallSnippet } from "@oh-my-pi/pi-coding-agent/icm";

describe("ICM backend", () => {
	it("does not ask ICM to store raw session transcripts during retain", () => {
		const args = buildIcmExtractArgs("lex", "user:\nFixed the parser bug");

		expect(args).toEqual([
			"extract",
			"--project",
			"lex",
			"--text",
			"OMP session turn for lex:\n\nuser:\nFixed the parser bug",
		]);
		expect(args).not.toContain("--store-raw");
	});

	it("strips injected ICM context from auto-recall queries", () => {
		const query = buildIcmRecallQuery(`Fix this failure

<icm_memories>
stale memory that was already injected
</icm_memories>

[ICM: 10 tool calls since last store. Consider saving important context with icm_memory_store before it is lost.]`);

		expect(query).toBe("Fix this failure");
	});

	it("does not recall when the prompt only contains ICM-injected context", () => {
		const query = buildIcmRecallQuery(`<icm_memories>
stale memory
</icm_memories>
[ICM: 10 tool calls since last store. Consider saving important context with icm_memory_store before it is lost.]`);

		expect(query).toBeUndefined();
	});

	it("formats recalled context with a hard character cap", () => {
		expect(formatIcmRecallSnippet("abcdef", 3)).toBe("<icm_memories>\nabc\n</icm_memories>");
	});
});
