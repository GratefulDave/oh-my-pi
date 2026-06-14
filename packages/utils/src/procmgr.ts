import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import type { Subprocess } from "bun";
import { $env, filterProcessEnv } from "./env";
import { $which } from "./which";

export interface ShellConfig {
	shell: string;
	args: string[];
	env: Record<string, string>;
	prefix: string | undefined;
}
let cachedShellConfig: ShellConfig | null = null;

/**
 * Check if a shell binary is executable.
 */
export function isExecutable(path: string): boolean {
	try {
		fs.accessSync(path, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Build the spawn environment (cached).
 */
function buildSpawnEnv(shell: string): Record<string, string> {
	const noCI = $env.PI_BASH_NO_CI || $env.CLAUDE_BASH_NO_CI;
	return {
		...filterProcessEnv(Bun.env),
		SHELL: shell,
		GIT_EDITOR: "true",
		GPG_TTY: "not a tty",
		OMPCODE: "1",
		CLAUDECODE: "1",
		...(noCI ? {} : { CI: "true" }),
	} as Record<string, string>;
}

/**
 * Get shell args, optionally including login shell flag.
 * Supports PI_BASH_NO_LOGIN and CLAUDE_BASH_NO_LOGIN to skip -l.
 */
function getShellArgs(): string[] {
	const noLogin = $env.PI_BASH_NO_LOGIN || $env.CLAUDE_BASH_NO_LOGIN;
	return noLogin ? ["-c"] : ["-l", "-c"];
}

/**
 * Get shell prefix for wrapping commands (profilers, strace, etc.).
 */
function getShellPrefix(): string | undefined {
	return $env.PI_SHELL_PREFIX || $env.CLAUDE_CODE_SHELL_PREFIX;
}

/** Detect the login shell when GUI apps were launched without $SHELL. */
function isSupportedUnixShell(shell: string | undefined): shell is string {
	return Boolean(shell && (shell.includes("bash") || shell.includes("zsh")));
}
function cleanShell(shell: string | null | undefined): string | undefined {
	const trimmed = shell?.trim();
	return trimmed ? trimmed : undefined;
}

function getMacLoginShell(username: string): string | undefined {
	if (process.platform !== "darwin") return undefined;
	try {
		const proc = Bun.spawnSync(["dscl", ".", "-read", `/Users/${username}`, "UserShell"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		if (proc.exitCode !== 0) return undefined;
		const text = new TextDecoder().decode(proc.stdout);
		return cleanShell(text.match(/^UserShell:\s*(.+)$/m)?.[1]);
	} catch {
		return undefined;
	}
}

function getPasswdLoginShell(username: string): string | undefined {
	try {
		const passwd = fs.readFileSync("/etc/passwd", "utf8");
		for (const line of passwd.split("\n")) {
			const fields = line.split(":");
			if (fields[0] === username) return cleanShell(fields[6]);
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function getLoginShell(): string | undefined {
	try {
		const info = os.userInfo();
		return cleanShell(info.shell) ?? getMacLoginShell(info.username) ?? getPasswdLoginShell(info.username);
	} catch {
		return undefined;
	}
}

function buildConfig(shell: string): ShellConfig {
	return {
		shell,
		args: getShellArgs(),
		env: buildSpawnEnv(shell),
		prefix: getShellPrefix(),
	};
}

/**
 * Resolve a basic shell (bash or sh) as fallback.
 */
export function resolveBasicShell(): string | undefined {
	for (const name of ["bash", "bash.exe", "sh", "sh.exe"]) {
		const resolved = $which(name);
		if (resolved) return resolved;
	}

	if (process.platform !== "win32") {
		const searchPaths = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
		const candidates = ["bash", "sh"];

		for (const name of candidates) {
			for (const dir of searchPaths) {
				const fullPath = path.join(dir, name);
				if (fs.existsSync(fullPath)) return fullPath;
			}
		}
	}

	return undefined;
}

/**
 * Get shell configuration based on platform.
 * Resolution order:
 * 1. User-specified shellPath in settings.json
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: $SHELL if bash/zsh, then OS login shell if bash/zsh
 * 4. Fallback: sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	if (cachedShellConfig) {
		return cachedShellConfig;
	}

	// 1. Check user-specified shell path
	if (customShellPath) {
		if (fs.existsSync(customShellPath)) {
			cachedShellConfig = buildConfig(customShellPath);
			return cachedShellConfig;
		}
		throw new Error(
			`Custom shell path not found: ${customShellPath}\nPlease update shellPath in ~/.omp/agent/settings.json`,
		);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = Bun.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = Bun.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (fs.existsSync(path)) {
				cachedShellConfig = buildConfig(path);
				return cachedShellConfig;
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = $which("bash.exe");
		if (bashOnPath) {
			cachedShellConfig = buildConfig(bashOnPath);
			return cachedShellConfig;
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				`  3. Set shellPath in ~/.omp/agent/settings.json\n\n` +
				`Searched Git Bash in:\n${paths.map(p => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: prefer $SHELL, but GUI apps launched by launchd may omit it. Fall
	// back to the account login shell before dropping to a generic bash/sh.
	for (const shell of [Bun.env.SHELL, getLoginShell()]) {
		if (isSupportedUnixShell(shell) && isExecutable(shell)) {
			cachedShellConfig = buildConfig(shell);
			return cachedShellConfig;
		}
	}

	// 4. Fallback: use basic shell
	const basicShell = resolveBasicShell();
	if (basicShell) {
		cachedShellConfig = buildConfig(basicShell);
		return cachedShellConfig;
	}
	cachedShellConfig = buildConfig("sh");
	return cachedShellConfig;
}

/**
 * Check if a process is running.
 */
export function isPidRunning(pid: number | Subprocess): boolean {
	if (typeof pid !== "number") {
		if (pid.killed) return false;
		if (pid.exitCode !== null) return false;
		return true;
	}

	return Process.fromPid(pid)?.status() === ProcessStatus.Running;
}

export async function onProcessExit(proc: Subprocess | number, abortSignal?: AbortSignal): Promise<boolean> {
	if (typeof proc !== "number") {
		return proc.exited.then(
			() => true,
			() => true,
		);
	}

	return (await Process.fromPid(proc)?.waitForExit({ signal: abortSignal })) ?? true;
}
