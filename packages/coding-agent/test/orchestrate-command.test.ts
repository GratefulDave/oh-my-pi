import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import type { SessionManager } from "../src/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import type { AcpBuiltinCommandRuntime } from "../src/slash-commands/types";

const FAKE_ACPX = `#!/bin/sh
set -eu
printf 'acpx %s\n' "$*" >> "$FAKE_EXTERNAL_AGENT_LOG"
provider=""
session=""
previous=""
for arg in "$@"; do
	if [ "$previous" = "-s" ]; then
		session="$arg"
	fi
	case "$arg" in
		gemini|claude|codex) provider="$arg" ;;
	esac
	previous="$arg"
done
printf '{"type":"final","text":"fake acpx %s %s"}\n' "$provider" "$session"
`;

const FAKE_TMUX = `#!/bin/sh
set -eu
printf 'tmux %s\n' "$*" >> "$FAKE_EXTERNAL_AGENT_LOG"
`;

function createRuntime(cwd: string): { output: string[]; runtime: AcpBuiltinCommandRuntime } {
	const output: string[] = [];
	return {
		output,
		runtime: {
			session: {} as AgentSession,
			sessionManager: { getCwd: () => cwd } as unknown as SessionManager,
			settings: Settings.isolated(),
			cwd,
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		},
	};
}

async function readLog(logPath: string): Promise<string> {
	try {
		return await fs.readFile(logPath, "utf8");
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return "";
		throw error;
	}
}

async function withFakeBinaries<T>(
	scripts: Record<string, string>,
	run: (paths: { cwd: string; logPath: string }) => Promise<T>,
): Promise<T> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-orchestrate-command-"));
	const binDir = path.join(root, "bin");
	const cwd = path.join(root, "project");
	const logPath = path.join(root, "external-agent.log");
	const previousPath = process.env.PATH;
	const previousLogPath = process.env.FAKE_EXTERNAL_AGENT_LOG;

	try {
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		await Promise.all(
			Object.entries(scripts).map(async ([name, content]) => {
				const scriptPath = path.join(binDir, name);
				await fs.writeFile(scriptPath, content);
				await fs.chmod(scriptPath, 0o755);
			}),
		);
		process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
		process.env.FAKE_EXTERNAL_AGENT_LOG = logPath;
		return await run({ cwd, logPath });
	} finally {
		if (previousPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = previousPath;
		}
		if (previousLogPath === undefined) {
			delete process.env.FAKE_EXTERNAL_AGENT_LOG;
		} else {
			process.env.FAKE_EXTERNAL_AGENT_LOG = previousLogPath;
		}
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("orchestrate/delegate builtin slash commands", () => {
	it("runs /orchestrate through fake acpx and reports both providers and sessions", async () => {
		await withFakeBinaries({ acpx: FAKE_ACPX }, async ({ cwd, logPath }) => {
			const { output, runtime } = createRuntime(cwd);

			const result = await executeAcpBuiltinSlashCommand(
				'/orchestrate --backend acpx --agents gemini,claude --session review --mode exec "review diff"',
				runtime,
			);

			expect(result).toEqual({ consumed: true });
			expect(output).toHaveLength(1);
			const report = output[0]!;
			expect(report).toContain("- Backend: `acpx`");
			expect(report).toContain("## gemini");
			expect(report).toContain("## claude");
			expect(report).toContain("- Session: `review-gemini`");
			expect(report).toContain("- Session: `review-claude`");

			const logLines = (await readLog(logPath)).trim().split("\n").filter(Boolean);
			expect(logLines).toHaveLength(2);
			expect(logLines.some(line => line.includes("gemini") && line.includes("review-gemini"))).toBe(true);
			expect(logLines.some(line => line.includes("claude") && line.includes("review-claude"))).toBe(true);
		});
	});

	it("runs /delegate through fake tmux and reports backend and provider", async () => {
		await withFakeBinaries({ tmux: FAKE_TMUX }, async ({ cwd, logPath }) => {
			const { output, runtime } = createRuntime(cwd);

			const result = await executeAcpBuiltinSlashCommand(
				'/delegate --backend tmux --agents gemini "review diff"',
				runtime,
			);

			expect(result).toEqual({ consumed: true });
			expect(output).toHaveLength(1);
			const report = output[0]!;
			expect(report).toContain("- Backend: `tmux`");
			expect(report).toContain("## gemini");

			const logLines = (await readLog(logPath)).trim().split("\n").filter(Boolean);
			expect(logLines).toHaveLength(2);
			expect(logLines[0]).toContain("tmux new-session -d -s");
			expect(logLines[0]).toContain("gemini");
			expect(logLines[1]).toContain("tmux send-keys -t");
			expect(logLines[1]).toContain("review diff");
		});
	});

	it("returns usage for invalid backend or missing prompt without spawning external binaries", async () => {
		await withFakeBinaries({ acpx: FAKE_ACPX, tmux: FAKE_TMUX }, async ({ cwd, logPath }) => {
			const { output, runtime } = createRuntime(cwd);

			expect(await executeAcpBuiltinSlashCommand('/orchestrate --backend invalid "review diff"', runtime)).toEqual({
				consumed: true,
			});
			expect(await executeAcpBuiltinSlashCommand("/delegate --backend tmux --agents gemini", runtime)).toEqual({
				consumed: true,
			});

			expect(output).toHaveLength(2);
			expect(output[0]).toContain("Usage: /orchestrate");
			expect(output[1]).toContain("Usage: /orchestrate");
			expect(await readLog(logPath)).toBe("");
		});
	});
});
