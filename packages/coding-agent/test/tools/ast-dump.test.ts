import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createTestSession(cwd = "/tmp/test", overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("ast_dump", () => {
	it("is registered and dumps inline code with an explicit language", async () => {
		const tools = await createTools(createTestSession());
		const tool = tools.find(entry => entry.name === "ast_dump");
		expect(tool).toBeDefined();

		const result = await tool!.execute("ast-dump-code", {
			code: "export function greet(name: string) { return name.trim(); }\n",
			lang: "typescript",
		});

		const text = result.content.find(content => content.type === "text")?.text ?? "";
		const details = result.details as { language?: string; hasErrors?: boolean; tree?: string } | undefined;

		expect(text).toContain("language: typescript");
		expect(text).toContain("function_declaration");
		expect(details?.language).toBe("typescript");
		expect(details?.hasErrors).toBe(false);
		expect(details?.tree).toContain("program");
	});

	it("dumps a file path using extension inference", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-dump-path-"));
		try {
			const filePath = path.join(tempDir, "sample.ts");
			await Bun.write(filePath, "const answer = 42;\n");

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "ast_dump");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-dump-path", { path: filePath });
			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details as { language?: string; hasErrors?: boolean; path?: string } | undefined;

			expect(text).toContain("path: ");
			expect(text).toContain("lexical_declaration");
			expect(details?.language).toBe("typescript");
			expect(details?.hasErrors).toBe(false);
			expect(details?.path).toBe(filePath);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
