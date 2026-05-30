import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

async function readText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	return await new Response(stream).text();
}

describe("top-level install command", () => {
	it("routes npm: package refs to plugin install instead of launching a session", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "lex-install-home-"));
		try {
			const proc = Bun.spawn(["bun", "src/cli.ts", "install", "npm:pi-cmux", "--dry-run"], {
				cwd: path.resolve(import.meta.dir, ".."),
				env: {
					...process.env,
					HOME: home,
					PI_CONFIG_DIR: ".lex",
					PI_CODING_AGENT_DIR: path.join(home, ".lex", "agent"),
					XDG_DATA_HOME: "",
					XDG_STATE_HOME: "",
					XDG_CACHE_HOME: "",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});

			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				readText(proc.stdout),
				readText(proc.stderr),
			]);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("[dry-run] Would install pi-cmux");
			expect(`${stdout}\n${stderr}`).not.toContain("How can I");
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	});
});
