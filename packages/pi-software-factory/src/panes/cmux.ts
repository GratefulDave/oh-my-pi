import type { FactoryPaneRef } from "../run-state/schema";
import type { PaneSnapshot, PaneWorkerBackend } from "./types";

export interface CmuxCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface CmuxCommandRunner {
	run(args: string[], cwd: string): Promise<CmuxCommandResult>;
}

const defaultRunner: CmuxCommandRunner = {
	async run(args, cwd) {
		const proc = Bun.spawn(["cmux", ...args], {
			cwd,
			env: process.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, stdout, stderr };
	},
};

function commandFailure(args: string[], result: CmuxCommandResult): Error {
	return new Error(`cmux ${args.join(" ")} failed (${result.exitCode}): ${result.stderr}`);
}

function ensureSuccess(args: string[], result: CmuxCommandResult): void {
	if (result.exitCode !== 0) {
		throw commandFailure(args, result);
	}
}

function coerceRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function parseJson(text: string, description: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${description}: ${detail}`);
	}
}

export function shellJoin(args: readonly string[]): string {
	return args.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

export function firstRef(stdout: string, prefix: string): string {
	const ref = stdout.split(/\s+/).find(token => token.startsWith(prefix));
	if (!ref) {
		throw new Error(`expected ${prefix} ref in cmux output: ${stdout}`);
	}
	return ref;
}

export function findTerminalSurfaceId(value: unknown): string | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const nested = findTerminalSurfaceId(item);
			if (nested) return nested;
		}
		return undefined;
	}
	const record = coerceRecord(value);
	if (!record) return undefined;
	const surfaceKind = record.type ?? record.kind;
	if (surfaceKind === "terminal" || surfaceKind === "pane-terminal") {
		for (const key of ["id", "surface_id", "surface"] as const) {
			if (typeof record[key] === "string") {
				return record[key];
			}
		}
	}
	for (const nested of Object.values(record)) {
		const nestedSurface = findTerminalSurfaceId(nested);
		if (nestedSurface) return nestedSurface;
	}
	return undefined;
}

async function readPaneSnapshot(runner: CmuxCommandRunner, pane: FactoryPaneRef, lines: number): Promise<PaneSnapshot> {
	const args = [
		"read-screen",
		"--workspace",
		pane.workspaceId,
		"--surface",
		pane.surfaceId,
		"--scrollback",
		"--lines",
		String(lines),
	];
	const result = await runner.run(args, pane.cwd);
	ensureSuccess(args, result);
	return { pane, text: result.stdout };
}

async function sendPaneMessage(runner: CmuxCommandRunner, pane: FactoryPaneRef, message: string): Promise<void> {
	const args = ["send", "--workspace", pane.workspaceId, "--surface", pane.surfaceId, `${message}\n`];
	const result = await runner.run(args, pane.cwd);
	ensureSuccess(args, result);
}

export function createCmuxPaneBackend(runner: CmuxCommandRunner = defaultRunner): PaneWorkerBackend {
	return {
		name: "cmux",
		async launch(request) {
			const launchArgs = [
				"new-workspace",
				"--name",
				`${request.runId}:${request.lane.id}`,
				"--cwd",
				request.cwd,
				"--command",
				shellJoin(request.command),
				"--focus",
				"false",
			];
			const launchResult = await runner.run(launchArgs, request.cwd);
			ensureSuccess(launchArgs, launchResult);
			const workspaceId = firstRef(launchResult.stdout, "workspace:");

			const surfaceArgs = ["list-pane-surfaces", "--workspace", workspaceId, "--json"];
			const surfaceResult = await runner.run(surfaceArgs, request.cwd);
			ensureSuccess(surfaceArgs, surfaceResult);
			const surfaceId = findTerminalSurfaceId(parseJson(surfaceResult.stdout, "invalid cmux surface json"));
			if (!surfaceId) {
				throw new Error(`expected terminal surface in cmux output: ${surfaceResult.stdout}`);
			}

			const pane: FactoryPaneRef = {
				backend: "cmux",
				workspaceId,
				surfaceId,
				command: [...request.command],
				cwd: request.cwd,
				launchedAt: request.launchedAt,
			};
			await sendPaneMessage(runner, pane, request.prompt);

			const statusArgs = [
				"set-status",
				"omp",
				`${request.runId}/${request.lane.id}`,
				"--icon",
				"sparkle",
				"--color",
				"#4c71f2",
				"--priority",
				"80",
				"--workspace",
				workspaceId,
			];
			await runner.run(statusArgs, request.cwd);
			return pane;
		},
		send(pane, message) {
			return sendPaneMessage(runner, pane, message);
		},
		read(pane, lines) {
			return readPaneSnapshot(runner, pane, lines);
		},
	};
}
