import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildArtifactRecoveryHint, executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import * as shellSnapshot from "@oh-my-pi/pi-coding-agent/utils/shell-snapshot";
import type { Shell } from "@oh-my-pi/pi-natives";
import * as piNatives from "@oh-my-pi/pi-natives";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import {
	buildMinimizerGainDiagnostic,
	getMinimizerGainStatus,
	readMinimizerGain,
	resetMinimizerGainStatusForTesting,
	summarizeMinimizerGain,
} from "../src/minimizer-gain";

// Matches the schema default for `tools.artifactHeadBytes` (20 KB) used by
// OutputSink when bash-executor pulls settings via resolveOutputSinkHeadBytes.
const ARTIFACT_HEAD_BYTES_DEFAULT = 20 * 1024;
const BACKGROUND_COMPLETION_RACE_MS = 750;
const KILL_MARKER_DELAY_SECONDS = "0.4";
const KILL_MARKER_ASSERTION_WAIT_MS = 900;

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "omp-bash-exec-"));
}

describe("executeBash", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = makeTempDir();
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	it("returns non-zero exit codes without cancellation", async () => {
		const result = await executeBash("exit 7", { cwd: tempDir, timeout: 5000 });
		expect(result.exitCode).toBe(7);
		expect(result.cancelled).toBe(false);
	});

	it("honors cwd", async () => {
		const result = await executeBash("pwd", { cwd: tempDir, timeout: 5000 });
		expect(result.output.trim()).toBe(fs.realpathSync(tempDir));
	});

	it("canonicalizes symlinked cwd before execution", async () => {
		if (process.platform === "win32") {
			return;
		}

		const realDir = path.join(tempDir, "real");
		const linkDir = path.join(tempDir, "link");
		fs.mkdirSync(realDir);
		fs.symlinkSync(realDir, linkDir, "dir");

		const result = await executeBash("pwd", { cwd: linkDir, timeout: 5000 });
		expect(result.output.trim()).toBe(fs.realpathSync(linkDir));
	});

	it("passes env vars", async () => {
		const result = await executeBash("echo $PI_TEST_ENV", {
			cwd: tempDir,
			timeout: 5000,
			env: { PI_TEST_ENV: "hello" },
		});
		expect(result.output.trim()).toBe("hello");
	});

	it("applies non-interactive environment defaults", async () => {
		const result = await executeBash('echo "$GIT_TERMINAL_PROMPT:$PI_TEST_ENV"', {
			cwd: tempDir,
			timeout: 5000,
			env: { PI_TEST_ENV: "hello" },
		});
		expect(result.output.trim()).toBe("0:hello");
	});

	it("invokes onChunk with command output", async () => {
		let seenChunk: string | null = null;
		const result = await executeBash("echo hello", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: chunk => {
				if (seenChunk === null) {
					seenChunk = chunk;
				}
			},
		});
		expect(result.output.trim()).toBe("hello");
		expect(seenChunk).not.toBeNull();
		expect(seenChunk ?? "").toContain("hello");
	});

	it("returns even if command spawns a background job", async () => {
		if (process.platform === "win32") {
			return;
		}
		const runPromise = executeBash("{ sleep 2; } & echo fg", {
			cwd: tempDir,
			timeout: 5000,
		});
		const timed = await Promise.race([
			runPromise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(BACKGROUND_COMPLETION_RACE_MS).then(() => ({ type: "timeout" as const })),
		]);
		expect(timed.type).toBe("result");
		if (timed.type === "result") {
			expect(timed.result.output).toContain("fg");
		}
	});

	it("returns a real PID for background external commands", async () => {
		if (process.platform === "win32") {
			return;
		}

		const result = await executeBash('python3 -c "import time; time.sleep(10)" & echo $!', {
			cwd: tempDir,
			timeout: 5000,
		});
		const pid = Number.parseInt(result.output.trim(), 10);
		expect(Number.isInteger(pid)).toBe(true);
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid, 0)).not.toThrow();
		expect(() => process.kill(pid, "SIGKILL")).not.toThrow();
	});

	it("times out commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const result = await executeBash("sleep 10", { cwd: tempDir, timeout: 50 });
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("timed out");
	});

	it("compresses check output before timeout annotations", async () => {
		if (process.platform === "win32") {
			return;
		}
		fs.writeFileSync(
			path.join(tempDir, "package.json"),
			JSON.stringify({
				scripts: {
					"check:ts":
						"printf '%s\\n' '@oh-my-pi/pi-utils check: Checked 40 files in 11ms. No fixes applied.' '@oh-my-pi/pi-utils check: Exited with code 0'; sleep 10",
				},
			}),
		);

		const result = await executeBash("bun run 'check:ts'", { cwd: tempDir, timeout: 50 });

		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("check:ts: visible checks passed; wrapper timed out");
		expect(result.output).toContain("packages checked: @oh-my-pi/pi-utils");
		expect(result.output).toContain("timeout: Command timed out");
		expect(result.output).not.toContain("No fixes applied");
		expect(result.output).not.toContain("Exited with code 0");
	});

	it("records a positive saved gain for a timed-out reducible command", async () => {
		if (process.platform === "win32") {
			return;
		}

		const previousAgentDir = getAgentDir();
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bash-gain-"));
		try {
			setAgentDir(agentDir);
			fs.writeFileSync(
				path.join(tempDir, "package.json"),
				JSON.stringify({
					scripts: {
						"check:ts":
							"printf '%s\\n' '@oh-my-pi/pi-utils check: Checked 40 files in 11ms. No fixes applied.' '@oh-my-pi/pi-utils check: Exited with code 0'; timeout 1s sh -c 'sleep 10'",
					},
				}),
			);

			const result = await executeBash("bun run 'check:ts'", { cwd: tempDir, timeout: 5000 });
			expect(result.cancelled).toBe(false);

			const records = await readMinimizerGain({ agentDir });
			expect(records).toHaveLength(1);
			const record = records[0];
			if (!record) throw new Error("expected minimizer gain record");
			const summary = summarizeMinimizerGain(records);
			expect(summary.usesEstimatedTokensSaved).toBe(false);
			const savedTokens = record.savedTokens;
			expect(typeof savedTokens).toBe("number");
			if (typeof savedTokens !== "number") throw new Error("expected exact saved token count");
			expect(summary.estimatedTokensSaved).toBe(savedTokens);
			expect(record).toMatchObject({
				cwd: fs.realpathSync(tempDir),
				command: "bun run 'check:ts'",
				kind: "saved",
			});
			expect(record.savedBytes).toBeGreaterThan(0);

			// gain-slash-remediation T6: diagnostic reflects the newly-written
			// record's count and timestamp.
			const diag = await buildMinimizerGainDiagnostic({
				agentDir,
				cwd: fs.realpathSync(tempDir),
			});
			expect(diag.recordCountInScope).toBeGreaterThanOrEqual(1);
			expect(diag.mostRecentTimestamp).toBe(record.timestamp);
		} finally {
			setAgentDir(previousAgentDir);
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("surfaces a writeErrorCount via Shape α when the records file path is unwritable", async () => {
		const previousAgentDir = getAgentDir();
		resetMinimizerGainStatusForTesting();
		// Point the gain logger at a regular file as if it were a directory,
		// forcing fs.mkdir to fail with ENOTDIR. We use a tmp dir that
		// contains a regular file at the expected agentDir target.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bash-werr-"));
		const blocker = path.join(tmp, "blocker");
		fs.writeFileSync(blocker, "x");
		try {
			setAgentDir(blocker);
			// Issue a no-op command — the bash-executor path will attempt
			// to record a gain entry and the write will fail.
			await executeBash("printf done", { cwd: tempDir, timeout: 5000 });
			const status = getMinimizerGainStatus();
			expect(status.writeErrorCount).toBeGreaterThan(0);
			expect(status.lastWriteError).not.toBeNull();
		} finally {
			setAgentDir(previousAgentDir);
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("records a reason label for a native minimizer miss", async () => {
		if (process.platform === "win32") {
			return;
		}

		const previousAgentDir = getAgentDir();
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bash-miss-"));
		const runSpy = vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation(function (
			this: Shell,
			_options,
			onChunk,
		) {
			onChunk?.(null, "hello\n");
			return Promise.resolve({
				exitCode: 0,
				cancelled: false,
				timedOut: false,
				minimized: {
					filter: "compound",
					text: "hello\n",
					originalText: "hello\n",
					inputBytes: 6,
					outputBytes: 6,
				},
			});
		});

		try {
			setAgentDir(agentDir);
			const result = await executeBash("git diff ; printf done", {
				cwd: tempDir,
				timeout: 5000,
				sessionKey: "reason-miss",
			});
			expect(result.cancelled).toBe(false);

			const records = await readMinimizerGain({ agentDir });
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				command: "git diff ; printf done",
				filter: "compound",
				kind: "missed",
			});
		} finally {
			setAgentDir(previousAgentDir);
			runSpy.mockRestore();
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("preserves streamed output while recording native too-large minimizer misses", async () => {
		if (process.platform === "win32") {
			return;
		}

		const previousAgentDir = getAgentDir();
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bash-too-large-"));
		const runSpy = vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation(function (
			this: Shell,
			_options,
			onChunk,
		) {
			onChunk?.(null, "raw output\n");
			return Promise.resolve({
				exitCode: 0,
				cancelled: false,
				timedOut: false,
				minimized: {
					filter: "too-large",
					text: "",
					originalText: "",
					inputBytes: 5_000_000,
					outputBytes: 0,
				},
			});
		});

		try {
			setAgentDir(agentDir);
			const result = await executeBash("bun test", {
				cwd: tempDir,
				timeout: 5000,
				sessionKey: "too-large-miss",
			});
			expect(result.cancelled).toBe(false);
			expect(result.output).toContain("raw output");

			const records = await readMinimizerGain({ agentDir });
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				command: "bun test",
				filter: "too-large",
				kind: "missed",
			});
		} finally {
			setAgentDir(previousAgentDir);
			runSpy.mockRestore();
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("times out before follow-up output", async () => {
		if (process.platform === "win32") {
			return;
		}
		const result = await executeBash("sleep 10; echo done", { cwd: tempDir, timeout: 50 });
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("timed out");
		expect(result.output).not.toContain("done");
	});

	it("aborts commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const controller = new AbortController();
		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
		});
		await Bun.sleep(50);
		controller.abort();
		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");
	});

	it("returns promptly and quarantines the session key when native abort cleanup stalls", async () => {
		if (process.platform === "win32") {
			return;
		}

		const originalRun = piNatives.Shell.prototype.run;
		let runCalls = 0;
		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			runCalls++;
			if (runCalls === 1) {
				onChunk?.(null, "started\n");
				return new Promise(() => {});
			}
			return originalRun.call(this, options, onChunk);
		});
		const abortSpy = vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue();

		const controller = new AbortController();
		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			sessionKey: "hung-native-abort",
		});
		await Bun.sleep(50);
		controller.abort();

		const raced = await Promise.race([
			promise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(750).then(() => ({ type: "timeout" as const })),
		]);

		expect(raced.type).toBe("result");
		if (raced.type === "result") {
			expect(raced.result.cancelled).toBe(true);
			expect(raced.result.output).toContain("Command cancelled");
		}
		expect(abortSpy).toHaveBeenCalled();

		const next = await executeBash("echo next", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "hung-native-abort",
		});
		expect(next.output.trim()).toBe("next");
		expect(runCalls).toBe(1);
	});

	it("restores persistent sessions after native abort cleanup settles", async () => {
		if (process.platform === "win32") {
			return;
		}

		const nativeResult = Promise.withResolvers<{ exitCode: undefined; cancelled: true; timedOut: false }>();
		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation((_options, onChunk) => {
			onChunk?.(null, "started\n");
			return nativeResult.promise;
		});
		vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue();

		const controller = new AbortController();
		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			sessionKey: "settled-native-abort",
		});
		await Bun.sleep(50);
		controller.abort();
		await promise;

		nativeResult.resolve({ exitCode: undefined, cancelled: true, timedOut: false });
		await Bun.sleep(0);
		vi.restoreAllMocks();

		await executeBash("export PI_AFTER_ABORT=still_persistent", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "settled-native-abort",
		});
		const next = await executeBash("printf '%s\n' \"$PI_AFTER_ABORT\"", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "settled-native-abort",
		});
		expect(next.output.trim()).toBe("still_persistent");
	});

	it("returns at the JavaScript timeout when native timeout cleanup stalls", async () => {
		if (process.platform === "win32") {
			return;
		}

		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation((_options, onChunk) => {
			onChunk?.(null, "started\n");
			return new Promise(() => {});
		});
		const abortSpy = vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue();

		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 1000,
			sessionKey: "hung-native-timeout",
		});
		const raced = await Promise.race([
			promise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(1500).then(() => ({ type: "timeout" as const })),
		]);

		expect(raced.type).toBe("result");
		if (raced.type === "result") {
			expect(raced.result.cancelled).toBe(true);
			expect(raced.result.output).toContain("Command timed out after 1 seconds");
		}
		expect(abortSpy).toHaveBeenCalled();
	});

	it("aborts before follow-up output", async () => {
		if (process.platform === "win32") {
			return;
		}
		const controller = new AbortController();
		const promise = executeBash("sleep 10; echo done", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
		});
		await Bun.sleep(100);
		controller.abort();
		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");
		expect(result.output).not.toContain("done");
	});

	it("resets persistent session state after abort", async () => {
		if (process.platform === "win32") {
			return;
		}

		const sessionKey = "reset-on-abort";
		await executeBash("export PI_RESET_VAR=alive", { cwd: tempDir, timeout: 5000, sessionKey });
		const beforeAbort = await executeBash("echo $PI_RESET_VAR", { cwd: tempDir, timeout: 5000, sessionKey });
		expect(beforeAbort.output.trim()).toBe("alive");

		const controller = new AbortController();
		const abortPromise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			sessionKey,
		});
		await Bun.sleep(50);
		controller.abort();
		const aborted = await abortPromise;
		expect(aborted.cancelled).toBe(true);

		// biome-ignore lint/suspicious/noTemplateCurlyInString: this is a bash variable expansion
		const afterAbort = await executeBash("echo ${PI_RESET_VAR:-unset}", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey,
		});
		expect(afterAbort.output.trim()).toBe("unset");
	});
	it("streams output chunks", async () => {
		const chunks: string[] = [];
		const result = await executeBash("i=1; while [ $i -le 20 ]; do echo line$i; i=$((i+1)); done", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: chunk => {
				expect(chunk.length).toBeGreaterThan(0);
				chunks.push(chunk);
			},
		});
		// At least one chunk should have been delivered to onChunk
		expect(chunks.length).toBeGreaterThan(0);
		const combined = chunks.join("");
		expect(combined).toContain("line1");
		// Final result always has the complete output regardless of chunk throttle
		expect(result.output).toContain("line1");
		expect(result.output).toContain("line20");
	});

	it("streams large output without exhausting memory", async () => {
		if (process.platform === "win32") {
			return;
		}
		let sawChunk = false;
		const result = await executeBash("awk 'BEGIN { for (i = 0; i < 100000; i++) printf \"a\" }'", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: () => {
				sawChunk = true;
			},
		});
		expect(sawChunk).toBe(true);
		expect(result.totalBytes).toBe(100000);
		expect(result.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(result.output).toContain("a");
	});

	it("handles multi-million line output without freeze or OOM", async () => {
		if (process.platform === "win32") return;

		// 5 million lines ~= 40MB of output. Before the 64KB read buffer and
		// direct-push fixes, this would freeze or OOM the process.
		const lineCount = 5_000_000;
		let chunkCount = 0;
		const start = Date.now();
		const result = await executeBash(`seq 1 ${lineCount}`, {
			cwd: tempDir,
			timeout: 30_000,
			onChunk: () => {
				chunkCount++;
			},
		});
		const elapsed = Date.now() - start;

		// Should complete, not hang or OOM
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);

		// Output summary should reflect all lines
		expect(result.totalLines).toBeGreaterThanOrEqual(lineCount);

		// Truncated output should be bounded by head + tail + marker overhead
		// (middle-elision keeps the head budget plus the tail spill window).
		expect(result.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + ARTIFACT_HEAD_BYTES_DEFAULT + 1024);

		// The tail should still contain numeric values near the end of the range.
		// BSD `seq` on macOS formats large numbers in scientific notation, so parse
		// the final lines numerically instead of matching one exact decimal string.
		const tailValues = result.output
			.split("\n")
			.slice(-1000)
			.map(line => Number(line.trim()))
			.filter(Number.isFinite);
		expect(tailValues.some(value => value >= lineCount - 500 && value <= lineCount)).toBe(true);

		// With 64KB read buffer, ~40MB should produce ~600 chunks, not 5M.
		// Allow generous headroom but ensure it's orders of magnitude below lineCount.
		expect(chunkCount).toBeLessThan(lineCount / 100);

		// Should complete in reasonable time (not frozen). On a modern machine
		// seq 1 5000000 itself takes ~0.5s; with JS overhead allow 20s.
		expect(elapsed).toBeLessThan(20_000);
	}, 35_000);

	it("sources snapshot env vars across session commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const bashPath = Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash";
		if (!fs.existsSync(bashPath)) {
			return;
		}
		const snapshotPath = path.join(tempDir, "snapshot.sh");
		fs.writeFileSync(snapshotPath, "export PI_SNAPSHOT_TEST=from_snapshot\n");
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: bashPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: Bun.env.HOME ?? tempDir,
			},
			prefix: undefined,
		});
		vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(snapshotPath);
		const sessionKey = "snapshot-test";
		await executeBash("true", { cwd: tempDir, timeout: 5000, sessionKey });
		const result = await executeBash("echo $PI_SNAPSHOT_TEST", { cwd: tempDir, timeout: 5000, sessionKey });
		expect(result.output.trim()).toBe("from_snapshot");
	});

	it("sources large bash functions without base64 eval wrappers", async () => {
		if (process.platform === "win32") {
			return;
		}
		const realBashPath = Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash";
		if (!fs.existsSync(realBashPath)) {
			return;
		}

		const bashPath = path.join(tempDir, "test-bash");
		fs.symlinkSync(realBashPath, bashPath);
		const largeBody = Array.from({ length: 200 }, (_, index) => `    echo "snapshot ${index}"`).join("\n");
		fs.writeFileSync(path.join(tempDir, ".bashrc"), `pi_snapshot_large_function ()\n{\n${largeBody}\n}\n`);

		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: bashPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: tempDir,
			},
			prefix: undefined,
		});

		const snapshotPath = await shellSnapshot.getOrCreateSnapshot(bashPath, {
			PATH: Bun.env.PATH ?? "",
			HOME: tempDir,
		});
		expect(snapshotPath).not.toBeNull();
		const snapshot = fs.readFileSync(snapshotPath!, "utf8");
		expect(snapshot).toContain("pi_snapshot_large_function");
		expect(snapshot).not.toContain("base64 -d");

		const result = await executeBash("printf 'snapshot_ok\\n'", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "large-function-snapshot",
		});
		expect(result.cancelled).toBe(false);
		expect(result.output.trim()).toBe("snapshot_ok");
	});

	it("does not allow exec to replace the host", async () => {
		const result = await executeBash("exec echo hi", { cwd: tempDir, timeout: 5000 });
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).not.toBeUndefined();
		if (!result.output.includes("hi")) {
			expect(result.output.toLowerCase()).toContain("exec");
		}
	});

	it("completes even when background job keeps stdout pipe open", async () => {
		if (process.platform === "win32") return;

		const runPromise = executeBash("{ sleep 2; echo late; } & echo immediate", {
			cwd: tempDir,
			timeout: 5000,
		});
		const timed = await Promise.race([
			runPromise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(BACKGROUND_COMPLETION_RACE_MS).then(() => ({ type: "timeout" as const })),
		]);

		expect(timed.type).toBe("result");
		if (timed.type === "result") {
			expect(timed.result.cancelled).toBe(false);
			expect(timed.result.exitCode).toBe(0);
			expect(timed.result.output).toContain("immediate");
		}
	});
	it("kills spawned process on timeout (not just orphans it)", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker.txt");
		const markerEscaped = marker.replace(/'/g, "'\\''");

		// Command creates marker after a short delay, but we timeout before then.
		const result = await executeBash(`sleep ${KILL_MARKER_DELAY_SECONDS} && echo done > '${markerEscaped}'`, {
			cwd: tempDir,
			timeout: 100,
		});

		expect(result.cancelled).toBe(true);

		// Wait longer than the command would have needed to create the marker.
		await Bun.sleep(KILL_MARKER_ASSERTION_WAIT_MS);

		// If process was killed (not orphaned), marker should NOT exist
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("kills background jobs on timeout", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker-bg.txt");
		const markerEscaped = marker.replace(/'/g, "'\\''");

		const result = await executeBash(
			`{ sleep ${KILL_MARKER_DELAY_SECONDS}; echo done > '${markerEscaped}'; } & sleep 10`,
			{
				cwd: tempDir,
				timeout: 100,
			},
		);

		expect(result.cancelled).toBe(true);

		await Bun.sleep(KILL_MARKER_ASSERTION_WAIT_MS);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("kills background jobs on abort", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker-bg-abort.txt");
		const markerEscaped = marker.replace(/'/g, "'\\''");
		const controller = new AbortController();

		const promise = executeBash(
			`{ sleep ${KILL_MARKER_DELAY_SECONDS}; echo done > '${markerEscaped}'; } & sleep 10`,
			{
				cwd: tempDir,
				timeout: 10000,
				signal: controller.signal,
			},
		);

		await Bun.sleep(100);
		controller.abort();
		const result = await promise;

		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");

		await Bun.sleep(KILL_MARKER_ASSERTION_WAIT_MS);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("kills spawned process on abort (not just orphans it)", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker.txt");
		const markerEscaped = marker.replace(/'/g, "'\\''");
		const controller = new AbortController();

		// Command creates marker after a short delay.
		const promise = executeBash(`sleep ${KILL_MARKER_DELAY_SECONDS} && echo done > '${markerEscaped}'`, {
			cwd: tempDir,
			timeout: 10000,
			signal: controller.signal,
		});

		// Abort before the command can create the marker.
		await Bun.sleep(100);
		controller.abort();
		const result = await promise;

		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");

		// Wait longer than the command would have needed to create the marker.
		await Bun.sleep(KILL_MARKER_ASSERTION_WAIT_MS);

		// If process was killed (not orphaned), marker should NOT exist
		expect(fs.existsSync(marker)).toBe(false);
	});
	describe("buildArtifactRecoveryHint", () => {
		it("returns null when no omission marker is present", () => {
			const text = "line1\nline2\nline3\n";
			const hint = buildArtifactRecoveryHint(text, "abc123");
			expect(hint).toBeNull();
		});

		it("returns hint when lines-omitted marker is present", () => {
			const text = "head1\nhead2\n… 500 lines omitted …\ntail1\ntail2\n";
			const hint = buildArtifactRecoveryHint(text, "abc123");
			expect(hint).toBe("[see remaining: read artifact://abc123:3]\n");
		});

		it("returns hint for commits-omitted marker", () => {
			const text =
				"abcdef1 message 0\nabcdef1 message 1\n… 22 commits omitted …\nabcdef1 message 69\nabcdef1 message 70\n";
			const hint = buildArtifactRecoveryHint(text, "x");
			expect(hint).toBe("[see remaining: read artifact://x:3]\n");
		});

		it("returns hint for entries-omitted marker", () => {
			const text = "… 10 entries omitted …\nremaining1\n";
			const hint = buildArtifactRecoveryHint(text, "y");
			expect(hint).toBe("[see remaining: read artifact://y:1]\n");
		});

		it("returns hint for package-entries omitted", () => {
			const text = "dep000 1.0.0\ndep001 1.0.1\n… 11 package entries omitted …\n";
			const hint = buildArtifactRecoveryHint(text, "pkgs");
			expect(hint).toBe("[see remaining: read artifact://pkgs:3]\n");
		});
		it("returns hint for files-omitted-from-changes marker", () => {
			const text = "src/a.rs | 2 +-\nsrc/b.rs | 1 +\n… 3 files omitted from changes\n";
			const hint = buildArtifactRecoveryHint(text, "diff");
			expect(hint).toBe("[see remaining: read artifact://diff:3]\n");
		});

		it("points to line 1 when omission marker is at the start", () => {
			const text = "… 999 lines omitted …\ntail only\n";
			const hint = buildArtifactRecoveryHint(text, "z");
			expect(hint).toBe("[see remaining: read artifact://z:1]\n");
		});
	});
});
