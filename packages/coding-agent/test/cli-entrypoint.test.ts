import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const packageDir = new URL("..", import.meta.url).pathname;

describe("CLI entrypoint", () => {
	it("starts far enough to handle --version before command dispatch", async () => {
		const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cli-entrypoint-"));
		try {
			const proc = Bun.spawn(["bun", "src/cli.ts", "--version"], {
				cwd: packageDir,
				env: {
					...Bun.env,
					PI_CODING_AGENT_DIR: tmpRoot,
				},
				stdout: "pipe",
				stderr: "pipe",
			});

			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(exitCode).toBe(0);
			expect(stdout.trim()).toMatch(/^lex\/\d+\.\d+\.\d+/);
			expect(stderr).not.toContain("ReferenceError");
		} finally {
			await fs.rm(tmpRoot, { recursive: true, force: true });
		}
	});
});
