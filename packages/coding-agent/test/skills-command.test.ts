import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import type { SessionManager } from "../src/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import type { AcpBuiltinCommandRuntime } from "../src/slash-commands/types";

function createRuntime(
	cwd: string,
	settingsOverrides?: Partial<Record<string, unknown>>,
): { output: string[]; runtime: AcpBuiltinCommandRuntime } {
	const output: string[] = [];
	return {
		output,
		runtime: {
			session: {} as AgentSession,
			sessionManager: { getCwd: () => cwd } as unknown as SessionManager,
			settings: Settings.isolated(settingsOverrides ?? {}),
			cwd,
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		},
	};
}

describe("/skills slash command", () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	async function createProjectWithSkill(cwd: string): Promise<void> {
		const ompSkills = path.join(cwd, ".omp", "skills", "test-skill");
		await fs.mkdir(ompSkills, { recursive: true });
		await fs.writeFile(
			path.join(ompSkills, "SKILL.md"),
			"---\nname: test-skill\ndescription: A test skill\n---\n\nTest body.\n",
		);
	}

	it("renders source toggles and skill counts in ACP output", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skills-cmd-"));
		await createProjectWithSkill(tempDir);

		const { output, runtime } = createRuntime(tempDir);

		const result = await executeAcpBuiltinSlashCommand("/skills", runtime);

		expect(result).toEqual({ consumed: true });
		const fullOutput = output.join("\n");
		expect(fullOutput).toContain("# Skills");
		expect(fullOutput).toContain("## Sources");
		expect(fullOutput).toContain("## Skills");
	});

	it("returns consumed result", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skills-cmd-"));
		await createProjectWithSkill(tempDir);

		const { runtime } = createRuntime(tempDir);

		const result = await executeAcpBuiltinSlashCommand("/skills", runtime);

		expect(result).toEqual({ consumed: true });
	});
});
