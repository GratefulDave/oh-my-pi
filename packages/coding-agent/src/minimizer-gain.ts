import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";

// ----------------------------------------------------------------------------
// Shape α — module-level error counters (gain-slash-remediation T2, M3 locked)
// ----------------------------------------------------------------------------

interface ErrorStamp {
	error: string;
	at: string;
}

interface ParseErrorStamp extends ErrorStamp {
	lineNumber: number;
}

let writeErrorCount = 0;
let readErrorCount = 0;
let parseErrorCount = 0;
let lastWriteError: ErrorStamp | null = null;
let lastReadError: ErrorStamp | null = null;
let lastParseError: ParseErrorStamp | null = null;

export interface MinimizerGainStatus {
	writeErrorCount: number;
	readErrorCount: number;
	parseErrorCount: number;
	lastWriteError: ErrorStamp | null;
	lastReadError: ErrorStamp | null;
	lastParseError: ParseErrorStamp | null;
}

export function getMinimizerGainStatus(): MinimizerGainStatus {
	return {
		writeErrorCount,
		readErrorCount,
		parseErrorCount,
		lastWriteError,
		lastReadError,
		lastParseError,
	};
}

/** Test-only reset for Shape α counters. */
export function resetMinimizerGainStatusForTesting(): void {
	writeErrorCount = 0;
	readErrorCount = 0;
	parseErrorCount = 0;
	lastWriteError = null;
	lastReadError = null;
	lastParseError = null;
}

/** Test-only / overlay write-side counter increment for the gain pipeline. */
export function incrementMinimizerGainReadError(error: unknown): void {
	readErrorCount += 1;
	lastReadError = { error: String(error), at: new Date().toISOString() };
}

export type MinimizerGainKind = "saved" | "missed";

export interface MinimizerGainRecord {
	timestamp: string;
	cwd?: string;
	command: string;
	filter: string;
	inputBytes: number;
	outputBytes: number;
	savedBytes: number;
	savedTokens?: number;
	exitCode: number | null;
	kind?: MinimizerGainKind;
}

export interface MinimizerGainTotals {
	commands: number;
	inputBytes: number;
	outputBytes: number;
	savedBytes: number;
	estimatedTokensSaved: number;
	usesEstimatedTokensSaved: boolean;
	estimatedInputTokens: number;
	tokensSavedRatio: number | null;
}

export interface MinimizerGainFilterSummary extends MinimizerGainTotals {
	filter: string;
}

export interface MinimizerGainCommandSummary extends MinimizerGainTotals {
	command: string;
}

export interface MinimizerGainCwdSummary extends MinimizerGainTotals {
	cwd: string;
}

export interface MinimizerGainSummary extends MinimizerGainTotals {
	byFilter: MinimizerGainFilterSummary[];
	byCommand: MinimizerGainCommandSummary[];
	byCwd: MinimizerGainCwdSummary[];
}

export interface MinimizerGainContext {
	path: string;
	days: number;
	cwd?: string;
	all: boolean;
	records: MinimizerGainRecord[];
	summary: MinimizerGainSummary;
	missed: MinimizerMissedSummary;
}

export async function loadMinimizerGainContext(input: {
	cwd: string;
	all: boolean;
	days?: number;
	agentDir?: string;
}): Promise<MinimizerGainContext> {
	const days = input.days ?? 30;
	const cwd = input.all ? undefined : await resolveMinimizerGainCwd(input.cwd);
	const records = await readMinimizerGain({ sinceDays: days, cwd, agentDir: input.agentDir });
	return {
		path: getMinimizerGainPath(input.agentDir),
		days,
		cwd,
		all: input.all,
		records,
		summary: summarizeMinimizerGain(records),
		missed: summarizeMissedMinimizerGain(records),
	};
}

export interface MinimizerGainDiscoveryItem extends MinimizerGainTotals {
	command: string;
	filter: string;
	avgSavedBytes: number;
}

export interface MinimizerGainDiscovery {
	commands: MinimizerGainDiscoveryItem[];
}

export interface MinimizerMissedItem {
	command: string;
	filter: string;
	commands: number;
	inputBytes: number;
	outputBytes: number;
	avgInputBytes: number;
	exitCodes: Array<number | null>;
	estimatedPotentialTokensSaved: number;
	avgEstimatedPotentialTokensSaved: number;
}

export interface MinimizerMissedSummary {
	commands: MinimizerMissedItem[];
	potentialTokenSavings: MinimizerMissedItem[];
}

export interface ReadMinimizerGainOptions {
	sinceDays?: number;
	cwd?: string;
	agentDir?: string;
}

export interface RecordMinimizerGainOptions {
	agentDir?: string;
}

type JsonObject = Record<string, unknown>;
type Invalid = typeof INVALID;
type ParsedRecordFields = {
	timestamp: string | Invalid;
	cwd: string | undefined | Invalid;
	command: string | Invalid;
	filter: string | Invalid;
	inputBytes: number | Invalid;
	outputBytes: number | Invalid;
	savedBytes: number | Invalid;
	savedTokens: number | undefined | Invalid;
	exitCode: number | null | Invalid;
	kind: MinimizerGainKind | undefined | Invalid;
};
type ValidRecordFields = {
	timestamp: string;
	cwd: string | undefined;
	command: string;
	filter: string;
	inputBytes: number;
	outputBytes: number;
	savedBytes: number;
	savedTokens?: number;
	exitCode: number | null;
	kind: MinimizerGainKind | undefined;
};

const INVALID = Symbol("invalid");
const BYTES_PER_TOKEN_ESTIMATE = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const MISSED_FILTER = "missed";

export function getMinimizerGainPath(agentDir?: string): string {
	return path.join(agentDir ?? getAgentDir(), "minimizer-gain.jsonl");
}
export async function resolveMinimizerGainCwd(cwd: string | undefined): Promise<string | undefined> {
	if (!cwd) return undefined;
	const resolved = path.resolve(cwd);
	try {
		return await fs.realpath(resolved);
	} catch {
		return resolved;
	}
}

export async function recordMinimizerGain(
	record: MinimizerGainRecord,
	options: RecordMinimizerGainOptions = {},
): Promise<void> {
	try {
		const filePath = getMinimizerGainPath(options.agentDir);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf-8");
	} catch (err) {
		writeErrorCount += 1;
		lastWriteError = { error: String(err), at: new Date().toISOString() };
		logger.warn("Failed to record minimizer gain", { error: String(err) });
	}
}

export function buildMinimizerMissedRecord(input: {
	timestamp: string;
	cwd?: string;
	command: string;
	totalBytes: number;
	exitCode: number | null;
	filter?: string;
}): MinimizerGainRecord | null {
	if (input.totalBytes <= 0) return null;
	return {
		timestamp: input.timestamp,
		...(input.cwd === undefined ? {} : { cwd: input.cwd }),
		command: input.command,
		filter: input.filter ?? MISSED_FILTER,
		inputBytes: input.totalBytes,
		outputBytes: input.totalBytes,
		savedBytes: 0,
		exitCode: input.exitCode,
		kind: "missed",
	};
}

export async function readMinimizerGain(options: ReadMinimizerGainOptions = {}): Promise<MinimizerGainRecord[]> {
	try {
		const content = await fs.readFile(getMinimizerGainPath(options.agentDir), "utf-8");
		const cutoff = resolveCutoff(options.sinceDays);
		return content
			.split("\n")
			.map((line, idx) => parseMinimizerGainRecord(line, idx + 1))
			.filter(
				(record): record is MinimizerGainRecord =>
					record !== null && matchesGainFilters(record, options.cwd, cutoff),
			);
	} catch (err) {
		// Missing file (ENOENT) is the empty-state happy path; do not count
		// it as a read error. Anything else is surfaced via Shape α.
		if (!(err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT")) {
			readErrorCount += 1;
			lastReadError = { error: String(err), at: new Date().toISOString() };
		}
		return [];
	}
}

export function summarizeMinimizerGain(records: MinimizerGainRecord[]): MinimizerGainSummary {
	const totals = createTotals();
	const byFilter = new Map<string, MinimizerGainFilterSummary>();
	const byCommand = new Map<string, MinimizerGainCommandSummary>();
	const byCwd = new Map<string, MinimizerGainCwdSummary>();

	for (const record of records) {
		if (!isSavingsRecord(record)) continue;
		addRecord(totals, record);
		addRecord(getFilterSummary(byFilter, record.filter), record);
		addRecord(getCommandSummary(byCommand, record.command), record);
		addRecord(getCwdSummary(byCwd, record.cwd), record);
	}

	return {
		...finalizeTotals(totals),
		byFilter: finalizeGroups(byFilter),
		byCommand: finalizeGroups(byCommand),
		byCwd: finalizeGroups(byCwd),
	};
}

export function discoverMinimizerGain(records: MinimizerGainRecord[], limit = 10): MinimizerGainDiscovery {
	const groups = new Map<string, MinimizerGainDiscoveryItem>();
	for (const record of records) {
		if (!isSavingsRecord(record)) continue;
		const item = getDiscoveryItem(groups, record);
		addRecord(item, record);
	}
	return { commands: finalizeGroups(groups).slice(0, limit).map(finalizeDiscoveryItem) };
}

export function summarizeMissedMinimizerGain(records: MinimizerGainRecord[], limit = 10): MinimizerMissedSummary {
	const groups = new Map<string, MinimizerMissedAccumulator>();
	for (const record of records) {
		if (record.kind !== "missed") continue;
		const item = getMissedItem(groups, record);
		item.commands += 1;
		item.inputBytes += record.inputBytes;
		item.outputBytes += record.outputBytes;
		addExitCode(item, record.exitCode);
	}
	const finalized = [...groups.values()].map(finalizeMissedItem);
	const commands = finalized
		.slice()
		.sort((a, b) => b.inputBytes - a.inputBytes)
		.slice(0, limit);
	const potentialTokenSavings = finalized
		.slice()
		.sort((a, b) => b.estimatedPotentialTokensSaved - a.estimatedPotentialTokensSaved)
		.slice(0, limit);
	return { commands, potentialTokenSavings };
}

function isSavedRecord(record: MinimizerGainRecord): boolean {
	return record.kind === undefined || record.kind === "saved";
}

// Records with kind="saved" but savedBytes===0 are intentionally excluded from totals:
// they represent text-rewriting minimizations that did not shrink bytes (rare, e.g. pure
// reordering). Legacy records (kind=undefined) are treated as saved for backward compat.
function isSavingsRecord(record: MinimizerGainRecord): boolean {
	return isSavedRecord(record) && record.savedBytes > 0;
}

function getDiscoveryItem(
	map: Map<string, MinimizerGainDiscoveryItem>,
	record: MinimizerGainRecord,
): MinimizerGainDiscoveryItem {
	const key = `${record.command}\0${record.filter}`;
	return getOrInsert(map, key, () => ({
		command: record.command,
		filter: record.filter,
		avgSavedBytes: 0,
		...createTotals(),
	}));
}

function finalizeDiscoveryItem(item: MinimizerGainDiscoveryItem): MinimizerGainDiscoveryItem {
	item.avgSavedBytes = item.commands === 0 ? 0 : Math.round(item.savedBytes / item.commands);
	return item;
}

interface MinimizerMissedAccumulator extends MinimizerMissedItem {
	_exitCodes: Set<number | null>;
}

function getMissedItem(
	map: Map<string, MinimizerMissedAccumulator>,
	record: MinimizerGainRecord,
): MinimizerMissedAccumulator {
	const key = `${record.command}\0${record.filter}`;
	return getOrInsert(map, key, () => ({
		command: record.command,
		filter: record.filter,
		commands: 0,
		inputBytes: 0,
		outputBytes: 0,
		avgInputBytes: 0,
		exitCodes: [],
		estimatedPotentialTokensSaved: 0,
		avgEstimatedPotentialTokensSaved: 0,
		_exitCodes: new Set(),
	}));
}

function addExitCode(item: MinimizerMissedAccumulator, exitCode: number | null): void {
	item._exitCodes.add(exitCode);
}

function finalizeMissedItem(item: MinimizerMissedAccumulator): MinimizerMissedItem {
	const estimatedPotentialTokensSaved = Math.floor(item.inputBytes / BYTES_PER_TOKEN_ESTIMATE);
	const avgEstimatedPotentialTokensSaved =
		item.commands === 0 ? 0 : Math.floor(estimatedPotentialTokensSaved / item.commands);
	return {
		command: item.command,
		filter: item.filter,
		commands: item.commands,
		inputBytes: item.inputBytes,
		outputBytes: item.outputBytes,
		avgInputBytes: item.commands === 0 ? 0 : Math.round(item.inputBytes / item.commands),
		exitCodes: [...item._exitCodes].sort(compareExitCodes),
		estimatedPotentialTokensSaved,
		avgEstimatedPotentialTokensSaved,
	};
}

function compareExitCodes(a: number | null, b: number | null): number {
	if (a === b) return 0;
	if (a === null) return -1;
	if (b === null) return 1;
	return a - b;
}

function parseMinimizerGainRecord(line: string, lineNumber = 0): MinimizerGainRecord | null {
	// Empty lines (trailing newline after appendFile) are not errors.
	if (line.trim() === "") return null;
	const value = parseJsonObject(line);
	if (!value) {
		parseErrorCount += 1;
		lastParseError = { error: "invalid JSON", lineNumber, at: new Date().toISOString() };
		return null;
	}
	const record = parseRecordFields(value);
	if (!record) {
		parseErrorCount += 1;
		lastParseError = { error: "missing required fields", lineNumber, at: new Date().toISOString() };
	}
	return record;
}

function parseRecordFields(value: JsonObject): MinimizerGainRecord | null {
	const fields: ParsedRecordFields = {
		timestamp: requiredString(value.timestamp),
		cwd: optionalString(value.cwd),
		command: requiredString(value.command),
		filter: requiredString(value.filter),
		inputBytes: requiredNumber(value.inputBytes),
		outputBytes: requiredNumber(value.outputBytes),
		savedBytes: requiredNumber(value.savedBytes),
		savedTokens: optionalNumber(value.savedTokens),
		exitCode: parseExitCode(value.exitCode),
		kind: parseKind(value.kind),
	};
	return hasInvalidField(fields) ? null : toMinimizerGainRecord(fields as ValidRecordFields);
}

function toMinimizerGainRecord(fields: ValidRecordFields): MinimizerGainRecord {
	const { cwd, kind, ...record } = fields;
	return {
		...record,
		...(cwd === undefined ? {} : { cwd }),
		...(kind === undefined ? {} : { kind }),
	};
}

function hasInvalidField(fields: Record<string, unknown>): boolean {
	return Object.values(fields).includes(INVALID);
}

function parseJsonObject(line: string): JsonObject | null {
	try {
		return asJsonObject(JSON.parse(line));
	} catch {
		return null;
	}
}

function asJsonObject(value: unknown): JsonObject | null {
	if (value === null) return null;
	if (typeof value !== "object") return null;
	if (Array.isArray(value)) return null;
	return value as JsonObject;
}

function requiredString(value: unknown): string | Invalid {
	return typeof value === "string" ? value : INVALID;
}

function optionalString(value: unknown): string | undefined | Invalid {
	return value === undefined || typeof value === "string" ? value : INVALID;
}

function requiredNumber(value: unknown): number | Invalid {
	return typeof value === "number" && Number.isFinite(value) ? value : INVALID;
}

function optionalNumber(value: unknown): number | undefined | Invalid {
	return value === undefined || (typeof value === "number" && Number.isFinite(value)) ? value : INVALID;
}

function parseExitCode(value: unknown): number | null | Invalid {
	return value === null || (typeof value === "number" && Number.isInteger(value)) ? value : INVALID;
}

function parseKind(value: unknown): MinimizerGainKind | undefined | Invalid {
	if (value === undefined) return undefined;
	return value === "saved" || value === "missed" ? value : INVALID;
}

function resolveCutoff(sinceDays: number | undefined): number | null {
	return typeof sinceDays === "number" ? Date.now() - sinceDays * DAY_MS : null;
}

function matchesGainFilters(record: MinimizerGainRecord, cwd: string | undefined, cutoff: number | null): boolean {
	return matchesCwd(record, cwd) && matchesCutoff(record, cutoff);
}

function matchesCwd(record: MinimizerGainRecord, cwd: string | undefined): boolean {
	if (cwd === undefined) return true;
	if (!record.cwd) return false;
	if (record.cwd === cwd) return true;
	// Prefix-match so a scope query at a parent dir aggregates subdir activity.
	// Guard against false prefixes like "/repo" matching "/repo-sibling" by
	// requiring a path separator immediately after the prefix.
	const sep = cwd.endsWith(path.sep) ? "" : path.sep;
	return record.cwd.startsWith(cwd + sep);
}

function matchesCutoff(record: MinimizerGainRecord, cutoff: number | null): boolean {
	return cutoff === null || timestampAtOrAfter(record.timestamp, cutoff);
}

function timestampAtOrAfter(timestamp: string, cutoff: number): boolean {
	const time = Date.parse(timestamp);
	return Number.isFinite(time) && time >= cutoff;
}

function getFilterSummary(map: Map<string, MinimizerGainFilterSummary>, filter: string): MinimizerGainFilterSummary {
	return getOrInsert(map, filter, () => ({ filter, ...createTotals() }));
}

function getCommandSummary(
	map: Map<string, MinimizerGainCommandSummary>,
	command: string,
): MinimizerGainCommandSummary {
	return getOrInsert(map, command, () => ({ command, ...createTotals() }));
}

function getCwdSummary(map: Map<string, MinimizerGainCwdSummary>, cwd: string | undefined): MinimizerGainCwdSummary {
	const label = cwd ?? "(unknown cwd)";
	return getOrInsert(map, label, () => ({ cwd: label, ...createTotals() }));
}

function getOrInsert<T>(map: Map<string, T>, key: string, create: () => T): T {
	const existing = map.get(key);
	if (existing) return existing;
	const value = create();
	map.set(key, value);
	return value;
}

function createTotals(): MinimizerGainTotals {
	return {
		commands: 0,
		inputBytes: 0,
		outputBytes: 0,
		savedBytes: 0,
		estimatedTokensSaved: 0,
		usesEstimatedTokensSaved: false,
		estimatedInputTokens: 0,
		tokensSavedRatio: null,
	};
}

function addRecord(totals: MinimizerGainTotals, record: MinimizerGainRecord): void {
	totals.commands += 1;
	totals.inputBytes += record.inputBytes;
	totals.outputBytes += record.outputBytes;
	totals.savedBytes += record.savedBytes;
	totals.estimatedTokensSaved += record.savedTokens ?? Math.floor(record.savedBytes / BYTES_PER_TOKEN_ESTIMATE);
	totals.usesEstimatedTokensSaved ||= record.savedTokens === undefined;
	totals.estimatedInputTokens += Math.floor(record.inputBytes / BYTES_PER_TOKEN_ESTIMATE);
}

function finalizeTotals<T extends MinimizerGainTotals>(totals: T): T {
	totals.tokensSavedRatio =
		totals.estimatedInputTokens > 0 ? totals.estimatedTokensSaved / totals.estimatedInputTokens : null;
	return totals;
}

function finalizeGroups<T extends MinimizerGainTotals>(groups: Map<string, T>): T[] {
	return [...groups.values()].map(finalizeTotals).sort(compareSavedBytesDesc);
}

function compareSavedBytesDesc<T extends MinimizerGainTotals>(a: T, b: T): number {
	return b.savedBytes - a.savedBytes;
}

// ----------------------------------------------------------------------------
// Diagnostic builder (gain-slash-remediation T3) — surfaces pipeline health
// for the overlay Status tab and the `omp gain --diag` CLI flag.
// ----------------------------------------------------------------------------

export interface MinimizerGainDiagnostic {
	recordsFilePath: string;
	exists: boolean;
	fileSizeBytes: number;
	mtime: string | null;
	recordCount: number;
	recordCountInScope: number;
	savedCount: number;
	missedCount: number;
	mostRecentTimestamp: string | null;
	recentMissedRatio: number | null;
	recentHitRatio: number | null;
	minimizerAppearsInactive: boolean;
	avgSavedRatio: number | null;
	loadDurationMs: number;
	writeErrorCount: number;
	lastWriteError: ErrorStamp | null;
	readErrorCount: number;
	lastReadError: ErrorStamp | null;
	parseErrorCount: number;
	lastParseError: ParseErrorStamp | null;
	minimizerEnabled: boolean;
	nativeBindingLoaded: boolean;
	cwdFilter: string | null;
	distinctCwdsCount: number;
	distinctCwdsSample: string[];
}

export interface BuildMinimizerGainDiagnosticInput {
	cwd?: string;
	days?: number;
	recordsFilePath?: string;
	agentDir?: string;
}

const RECENT_MISSED_WINDOW = 50;
const RECENT_MISSED_THRESHOLD = 0.98;
const DISTINCT_CWD_SAMPLE_LIMIT = 10;

export async function buildMinimizerGainDiagnostic(
	input: BuildMinimizerGainDiagnosticInput = {},
): Promise<MinimizerGainDiagnostic> {
	const start = Date.now();
	const recordsFilePath = input.recordsFilePath ?? getMinimizerGainPath(input.agentDir);

	let exists = false;
	let fileSizeBytes = 0;
	let mtime: string | null = null;
	try {
		const stat = await fs.stat(recordsFilePath);
		exists = true;
		fileSizeBytes = stat.size;
		mtime = stat.mtime.toISOString();
	} catch (err) {
		if (!(err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT")) {
			readErrorCount += 1;
			lastReadError = { error: String(err), at: new Date().toISOString() };
		}
	}

	// Read full file (filter-free) for the file-wide recordCount + distinct-
	// cwd metrics; then apply scope-aware filters for *InScope counters.
	const allRecords = exists ? await readMinimizerGain({ agentDir: input.agentDir }) : [];
	const recordCount = allRecords.length;

	const scopedRecords = await readMinimizerGain({
		agentDir: input.agentDir,
		cwd: input.cwd,
		sinceDays: input.days,
	});
	const recordCountInScope = scopedRecords.length;

	let savedCount = 0;
	let missedCount = 0;
	let savedSumInput = 0;
	let savedSumSaved = 0;
	let mostRecentTimestamp: string | null = null;
	for (const r of scopedRecords) {
		if (isSavingsRecord(r)) {
			savedCount += 1;
			savedSumInput += r.inputBytes;
			savedSumSaved += r.savedBytes;
		} else if (r.kind === "missed") {
			missedCount += 1;
		}
		if (!mostRecentTimestamp || r.timestamp > mostRecentTimestamp) {
			mostRecentTimestamp = r.timestamp;
		}
	}

	const avgSavedRatio = savedCount > 0 && savedSumInput > 0 ? savedSumSaved / savedSumInput : null;

	let recentMissedRatio: number | null = null;
	let recentHitRatio: number | null = null;
	// Sort scoped records by timestamp for the recent window to be deterministic.
	const sortedScoped = scopedRecords
		.slice()
		.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
	if (sortedScoped.length >= RECENT_MISSED_WINDOW) {
		const window = sortedScoped.slice(-RECENT_MISSED_WINDOW);
		let s = 0;
		let m = 0;
		for (const r of window) {
			if (isSavingsRecord(r)) s += 1;
			else if (r.kind === "missed") m += 1;
		}
		const denom = s + m;
		recentMissedRatio = denom === 0 ? null : m / denom;
		recentHitRatio = denom === 0 ? null : s / denom;
	}
	const minimizerAppearsInactive = recentMissedRatio !== null && recentMissedRatio >= RECENT_MISSED_THRESHOLD;

	const distinctCwds = new Set<string>();
	for (const r of allRecords) {
		if (r.cwd) distinctCwds.add(r.cwd);
	}
	const distinctCwdsSample = [...distinctCwds].slice(0, DISTINCT_CWD_SAMPLE_LIMIT);

	const cwdFilter = input.cwd ?? null;

	const status = getMinimizerGainStatus();
	const loadDurationMs = Date.now() - start;

	// minimizerEnabled: we cannot directly inspect the settings group from
	// this module without import cycles; surface a best-effort indicator
	// based on whether the native binding is reachable (the binding is the
	// gate the rest of the pipeline depends on).
	let nativeBindingLoaded = false;
	try {
		const piNatives = await import("@oh-my-pi/pi-natives");
		nativeBindingLoaded = typeof piNatives.applyShellMinimizer === "function";
	} catch {
		nativeBindingLoaded = false;
	}
	const minimizerEnabled = nativeBindingLoaded;

	return {
		recordsFilePath,
		exists,
		fileSizeBytes,
		mtime,
		recordCount,
		recordCountInScope,
		savedCount,
		missedCount,
		mostRecentTimestamp,
		recentMissedRatio,
		recentHitRatio,
		minimizerAppearsInactive,
		avgSavedRatio,
		loadDurationMs,
		writeErrorCount: status.writeErrorCount,
		lastWriteError: status.lastWriteError,
		readErrorCount: status.readErrorCount,
		lastReadError: status.lastReadError,
		parseErrorCount: status.parseErrorCount,
		lastParseError: status.lastParseError,
		minimizerEnabled,
		nativeBindingLoaded,
		cwdFilter,
		distinctCwdsCount: distinctCwds.size,
		distinctCwdsSample,
	};
}
