/**
 * Incremental ingest of bash-minimizer gain JSONL into stats.db.
 *
 * Writers append to `<agent-dir>/minimizer-gain.jsonl` (default dir plus every
 * `profiles/<name>/agent`). Session sync never opened those files, so the Gain
 * tab re-parsed them on every request and CLI/sqlite had no record of them.
 * Offsets live in the shared `file_offsets` table (paths cannot collide with
 * session JSONL).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, listAgentDirs, logger } from "@oh-my-pi/pi-utils";
import {
	deleteGainRecordsForFile,
	type GainRecordRow,
	getFileOffset,
	initDb,
	insertGainRecords,
	setFileOffset,
} from "./db";

const MINIMIZER_GAIN_FILE = "minimizer-gain.jsonl";
const utf8 = new TextDecoder("utf-8");
const LF = 10;

export async function resolveMinimizerGainPaths(): Promise<string[]> {
	const paths: string[] = [];
	for (const dir of await listAgentDirs()) {
		paths.push(path.join(dir, MINIMIZER_GAIN_FILE));
	}
	return paths;
}

export async function ingestMinimizerGainFiles(): Promise<number> {
	await initDb();
	let inserted = 0;
	for (const filePath of await resolveMinimizerGainPaths()) {
		inserted += await ingestOneGainFile(filePath);
	}
	return inserted;
}

async function ingestOneGainFile(filePath: string): Promise<number> {
	let fileStats: { mtimeMs: number; size: number };
	try {
		fileStats = await fs.stat(filePath);
	} catch (err) {
		if (isEnoent(err)) return 0;
		logger.debug("gain-ingest: failed to stat minimizer-gain.jsonl", { filePath, err: String(err) });
		return 0;
	}

	const lastModified = fileStats.mtimeMs;
	const stored = getFileOffset(filePath);
	if (stored && stored.lastModified >= lastModified) return 0;

	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(filePath).bytes();
	} catch (err) {
		if (isEnoent(err)) return 0;
		logger.debug("gain-ingest: failed to read minimizer-gain.jsonl", { filePath, err: String(err) });
		return 0;
	}

	let fromOffset = stored?.offset ?? 0;
	if (fromOffset > bytes.length) {
		deleteGainRecordsForFile(filePath);
		fromOffset = 0;
	}

	const { rows, newOffset } = parseGainChunk(filePath, bytes, fromOffset);
	const inserted = insertGainRecords(rows);
	setFileOffset(filePath, newOffset, lastModified);
	return inserted;
}

function parseGainChunk(
	sourceFile: string,
	bytes: Uint8Array,
	start: number,
): { rows: GainRecordRow[]; newOffset: number } {
	const unprocessed = bytes.subarray(Math.max(0, Math.min(start, bytes.length)));
	const rows: GainRecordRow[] = [];
	let i = 0;
	while (i < unprocessed.length) {
		let j = i;
		while (j < unprocessed.length && unprocessed[j] !== LF) j++;
		const line = unprocessed.subarray(i, j);
		if (line.length > 0) {
			const row = parseGainLine(sourceFile, start + i, line);
			if (row) rows.push(row);
		}
		i = j < unprocessed.length ? j + 1 : j;
		if (j === unprocessed.length) break;
	}
	return { rows, newOffset: start + unprocessed.length };
}

function parseGainLine(sourceFile: string, byteOffset: number, line: Uint8Array): GainRecordRow | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(utf8.decode(line));
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	const rec = parsed as Record<string, unknown>;
	const timestampRaw = rec.timestamp;
	const timestamp =
		typeof timestampRaw === "number"
			? timestampRaw
			: typeof timestampRaw === "string"
				? new Date(timestampRaw).getTime()
				: Number.NaN;
	if (!Number.isFinite(timestamp)) return null;

	const inputBytes = asNonNegInt(rec.inputBytes);
	const outputBytes = asNonNegInt(rec.outputBytes);
	const savedBytes = asNonNegInt(rec.savedBytes);
	if (inputBytes === null || outputBytes === null || savedBytes === null) return null;

	const filter = typeof rec.filter === "string" && rec.filter.length > 0 ? rec.filter : "missed";
	const kind = rec.kind === "missed" ? "missed" : "saved";
	const savedTokens = asNonNegInt(rec.savedTokens) ?? undefined;
	const command = typeof rec.command === "string" ? rec.command : undefined;
	const cwd = typeof rec.cwd === "string" ? rec.cwd : undefined;
	const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : undefined;

	return {
		sourceFile,
		byteOffset,
		timestamp,
		filter,
		command,
		inputBytes,
		outputBytes,
		savedBytes,
		savedTokens,
		kind,
		cwd,
		sessionId,
	};
}

function asNonNegInt(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	return Math.trunc(value);
}
