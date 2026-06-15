import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";

export const BASH_MINIMIZER_GAIN_SCHEMA_VERSION = 2;

export type BashMinimizerGainKind = "saved" | "missed";

export interface AppendBashMinimizerGainRecordInput {
	command: string;
	cwd: string;
	sessionCwd?: string;
	filter: string;
	inputBytes: number;
	outputBytes: number;
	exitCode: number | null;
	kind?: BashMinimizerGainKind;
	agentDir?: string;
}

const BYTES_PER_TOKEN_ESTIMATE = 4;

export function getBashMinimizerGainPath(agentDir?: string): string {
	return path.join(agentDir ?? getAgentDir(), "minimizer-gain.jsonl");
}

export function inferBashMinimizerMissedFilter(command: string): string {
	if (/[;&|]{1,2}/.test(command)) return "compound";
	const base = path.basename(command.trim().split(/\s+/, 1)[0] ?? "");
	return base || "unknown";
}

async function resolveRecordCwd(cwd: string): Promise<string> {
	const resolved = path.resolve(cwd);
	try {
		return await fs.realpath(resolved);
	} catch {
		return resolved;
	}
}

export async function appendBashMinimizerGainRecord(input: AppendBashMinimizerGainRecordInput): Promise<void> {
	const savedBytes = Math.max(0, input.inputBytes - input.outputBytes);
	const kind = input.kind ?? "saved";
	if (kind !== "missed" && savedBytes <= 0) return;

	const recordPath = getBashMinimizerGainPath(input.agentDir);
	try {
		await fs.mkdir(path.dirname(recordPath), { recursive: true });
		const cwd = await resolveRecordCwd(input.cwd);
		const sessionCwd = input.sessionCwd === undefined ? undefined : await resolveRecordCwd(input.sessionCwd);
		await fs.appendFile(
			recordPath,
			`${JSON.stringify({
				schemaVersion: BASH_MINIMIZER_GAIN_SCHEMA_VERSION,
				timestamp: new Date().toISOString(),
				cwd,
				...(sessionCwd === undefined ? {} : { sessionCwd }),
				command: input.command,
				filter: input.filter,
				inputBytes: input.inputBytes,
				outputBytes: input.outputBytes,
				savedBytes,
				...(kind === "missed" ? {} : { savedTokens: Math.floor(savedBytes / BYTES_PER_TOKEN_ESTIMATE) }),
				exitCode: input.exitCode,
				kind,
			})}\n`,
		);
	} catch (err) {
		logger.debug("bash minimizer gain record append failed", { err: String(err) });
	}
}
