import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { getAgentDir } from "@oh-my-pi/pi-utils";

export const MINIMIZER_GAIN_SCHEMA_VERSION = 2;

const MODULE_STARTED_AT = Date.now();

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
	schemaVersion?: number;
	timestamp: string;
	cwd?: string;
	sessionCwd?: string;
	command: string;
	filter: string;
	inputBytes: number;
	outputBytes: number;
	savedBytes: number;
	savedTokens?: number;
	exitCode: number | null;
	kind?: MinimizerGainKind;
	sourcePaths?: string[];
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
export interface MinimizerGainSourceSummary extends MinimizerGainTotals {
	source: string;
}
export interface MinimizerGainDailySummary extends MinimizerGainTotals {
	date: string;
}

export interface MinimizerGainSummary extends MinimizerGainTotals {
	byFilter: MinimizerGainFilterSummary[];
	byCommand: MinimizerGainCommandSummary[];
	byCwd: MinimizerGainCwdSummary[];
	bySource: MinimizerGainSourceSummary[];
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
export interface MinimizerGainConfig {
	ignoredMissedCommands: ReadonlySet<string>;
}

export interface MinimizerGainJsonlExportOptions {
	includeDailyTotals?: boolean;
	includeCommandTotals?: boolean;
}

export async function loadMinimizerGainContext(input: {
	cwd: string;
	all: boolean;
	days?: number;
	agentDir?: string;
	activeSessionFile?: string;
	activeSessionCommands?: Iterable<ActiveSessionCommand>;
	ignoredMissedCommands?: Iterable<string>;
}): Promise<MinimizerGainContext> {
	const days = input.days ?? 30;
	const scope = input.all ? undefined : await resolveMinimizerGainScope(input.cwd);
	const cwd = scope?.cwd;
	const recordsFilePath = getMinimizerGainPath(input.agentDir);
	if (cwd !== undefined) {
		await migrateLegacySessionCwds({ agentDir: input.agentDir, recordsFilePath, scopeCwd: cwd });
	}
	let records = await readMinimizerGain({ sinceDays: days, scope, agentDir: input.agentDir });
	if (cwd !== undefined) {
		if (input.activeSessionCommands !== undefined) {
			records = await filterActiveSessionRecordsByCommands(records, input.activeSessionCommands);
		} else if (input.activeSessionFile !== undefined) {
			records = await filterActiveSessionRecords(records, input.activeSessionFile, cwd);
		}
	}
	const config = await loadMinimizerGainConfig(input.agentDir, input.ignoredMissedCommands);
	return {
		path: getMinimizerGainPath(input.agentDir),
		days,
		cwd,
		all: input.all,
		records,
		summary: summarizeMinimizerGain(records),
		missed: summarizeMissedMinimizerGain(records, 10, config.ignoredMissedCommands),
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

export interface ActiveSessionCommand {
	command: string;
	cwd: string;
}

interface MinimizerGainScope {
	cwd: string;
	aliases: readonly string[];
}

export interface ReadMinimizerGainOptions {
	sinceDays?: number;
	cwd?: string;
	scope?: MinimizerGainScope;
	agentDir?: string;
}

type JsonObject = Record<string, unknown>;
type Invalid = typeof INVALID;
type ParsedRecordFields = {
	schemaVersion: number | undefined | Invalid;
	timestamp: string | Invalid;
	cwd: string | undefined | Invalid;
	sessionCwd: string | undefined | Invalid;
	command: string | Invalid;
	filter: string | Invalid;
	inputBytes: number | Invalid;
	outputBytes: number | Invalid;
	savedBytes: number | Invalid;
	savedTokens: number | undefined | Invalid;
	exitCode: number | null | Invalid;
	kind: MinimizerGainKind | undefined | Invalid;
	sourcePaths: string[] | undefined | Invalid;
};
type ValidRecordFields = {
	schemaVersion: number | undefined;
	timestamp: string;
	cwd: string | undefined;
	sessionCwd: string | undefined;
	command: string;
	filter: string;
	inputBytes: number;
	outputBytes: number;
	savedBytes: number;
	savedTokens?: number;
	exitCode: number | null;
	kind: MinimizerGainKind | undefined;
	sourcePaths: string[] | undefined;
};

const INVALID = Symbol("invalid");
const BYTES_PER_TOKEN_ESTIMATE = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

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

async function resolveMinimizerGainScope(cwd: string | undefined): Promise<MinimizerGainScope | undefined> {
	const resolved = await resolveMinimizerGainCwd(cwd);
	if (resolved === undefined) return undefined;
	const scopeRoot = await resolveMinimizerGainScopeRoot(resolved);
	const aliases = await resolveMinimizerGainCwdAliases(scopeRoot);
	return { cwd: scopeRoot, aliases };
}
async function resolveMinimizerGainScopeRoot(cwd: string): Promise<string> {
	const repoRoot = await findRepoRoot(cwd);
	return repoRoot ?? cwd;
}

async function findRepoRoot(startDir: string): Promise<string | null> {
	let current = startDir;
	while (true) {
		if (await hasGitEntry(current)) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

async function hasGitEntry(dir: string): Promise<boolean> {
	try {
		await fs.stat(path.join(dir, ".git"));
		return true;
	} catch {
		return false;
	}
}

async function resolveMinimizerGainCwdAliases(cwd: string): Promise<readonly string[]> {
	const aliases = [cwd];
	const upstreamCloneMatch = /^(.*)-upstream-(?:v?\d[\w.-]*)$/.exec(path.basename(cwd));
	if (!upstreamCloneMatch) return aliases;
	const sibling = await resolveMinimizerGainCwd(path.join(path.dirname(cwd), upstreamCloneMatch[1]));
	if (sibling && !aliases.includes(sibling)) aliases.push(sibling);
	return aliases;
}

export async function readMinimizerGain(options: ReadMinimizerGainOptions = {}): Promise<MinimizerGainRecord[]> {
	try {
		const content = await fs.readFile(getMinimizerGainPath(options.agentDir), "utf-8");
		const cutoff = resolveCutoff(options.sinceDays);
		const scope = options.scope ?? (options.cwd ? await resolveMinimizerGainScope(options.cwd) : undefined);
		return content
			.split("\n")
			.map((line, idx) => parseMinimizerGainRecord(line, idx + 1))
			.filter(
				(record): record is MinimizerGainRecord => record !== null && matchesGainFilters(record, scope, cutoff),
			);
	} catch (err) {
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
	const bySource = new Map<string, MinimizerGainSourceSummary>();

	for (const record of records) {
		if (!isSavingsRecord(record)) continue;
		addRecord(totals, record);
		addRecord(getFilterSummary(byFilter, record.filter), record);
		addRecord(getCommandSummary(byCommand, record.command), record);
		addRecord(getCwdSummary(byCwd, record.cwd), record);
		addRecord(getSourceSummary(bySource, getSourceBucket(record)), record);
	}

	return {
		...finalizeTotals(totals),
		byFilter: finalizeGroups(byFilter),
		byCommand: finalizeGroups(byCommand),
		byCwd: finalizeGroups(byCwd),
		bySource: finalizeGroups(bySource),
	};
}

export function summarizeMissedMinimizerGain(
	records: MinimizerGainRecord[],
	limit = 10,
	ignoredCommands: Iterable<string> = [],
): MinimizerMissedSummary {
	const ignored = normalizeIgnoredCommands(ignoredCommands);
	const groups = new Map<string, MinimizerMissedAccumulator>();
	for (const record of records) {
		if (record.kind !== "missed" || ignored.has(normalizeCommandName(record.command))) continue;
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
		.filter(a => a.commands > 1)
		.sort((a, b) => b.estimatedPotentialTokensSaved - a.estimatedPotentialTokensSaved)
		.slice(0, limit);
	return { commands, potentialTokenSavings };
}

export async function loadMinimizerGainConfig(
	agentDir?: string,
	ignoredCommands: Iterable<string> = [],
): Promise<MinimizerGainConfig> {
	const fileCommands = await readIgnoredMissedCommandsConfig(agentDir);
	const envCommands = splitCommandList(process.env.PI_MINIMIZER_GAIN_IGNORED_COMMANDS);
	return {
		ignoredMissedCommands: normalizeIgnoredCommands([...fileCommands, ...envCommands, ...ignoredCommands]),
	};
}

export function exportMinimizerGainJsonl(
	context: MinimizerGainContext,
	options: MinimizerGainJsonlExportOptions = {},
): string {
	const includeDailyTotals = options.includeDailyTotals ?? true;
	const includeCommandTotals = options.includeCommandTotals ?? true;
	const lines: string[] = [];
	if (includeDailyTotals) {
		for (const daily of summarizeDailyTotals(context.records)) {
			lines.push(JSON.stringify({ kind: "daily-total", ...daily }));
		}
	}
	if (includeCommandTotals) {
		for (const command of context.summary.byCommand) {
			lines.push(JSON.stringify({ kind: "command-total", ...command }));
		}
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Diagnostic builder
// ---------------------------------------------------------------------------

export interface MinimizerGainDiagnostic {
	recordsFilePath: string;
	exists: boolean;
	fileSizeBytes: number;
	mtime: string | null;
	recordCount: number;
	recordCountInScope: number;
	commandCwdRecordCountInScope: number;
	sessionCwdRecordCountInScope: number;
	sessionScopedRecordCount: number;
	legacyUnscopedRecordCount: number;
	recordsWithSessionCwd: number;
	recordsWithoutSessionCwd: number;
	mostRecentRecordAgeMs: number | null;
	currentSessionRecordCount: number;
	schemaVersion: number;
	extensionBundlePath: string;
	extensionBundleMtime: string | null;
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
	scopeFilter: string | null;
	distinctCwdsCount: number;
	distinctCwdsSample: string[];
}

export interface BuildMinimizerGainDiagnosticInput {
	cwd?: string;
	days?: number;
	recordsFilePath?: string;
	agentDir?: string;
	activeSessionFile?: string;
	activeSessionCommands?: Iterable<ActiveSessionCommand>;
}

const RECENT_MISSED_WINDOW = 50;
const RECENT_MISSED_THRESHOLD = 0.98;
const DISTINCT_CWD_SAMPLE_LIMIT = 10;

export async function buildMinimizerGainDiagnostic(
	input: BuildMinimizerGainDiagnosticInput = {},
): Promise<MinimizerGainDiagnostic> {
	const start = Date.now();
	const recordsFilePath = input.recordsFilePath ?? getMinimizerGainPath(input.agentDir);
	const extensionBundlePath = url.fileURLToPath(import.meta.url);

	let extensionBundleMtime: string | null = null;
	try {
		const stat = await fs.stat(extensionBundlePath);
		extensionBundleMtime = stat.mtime.toISOString();
	} catch {
		extensionBundleMtime = null;
	}

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

	const scope = await resolveMinimizerGainScope(input.cwd);
	const scopeCwd = scope?.cwd;
	if (exists && scopeCwd !== undefined) {
		await migrateLegacySessionCwds({ agentDir: input.agentDir, recordsFilePath, scopeCwd });
	}

	const allRecords = exists ? await readMinimizerGain({ agentDir: input.agentDir }) : [];
	const recordCount = allRecords.length;
	const scopedRecords = await readMinimizerGain({
		agentDir: input.agentDir,
		scope,
		sinceDays: input.days,
	});
	const recordCountInScope = scopedRecords.length;
	const commandCwdRecordCountInScope =
		scope === undefined ? 0 : allRecords.filter(r => matchesScopePath(r.cwd, scope)).length;
	const sessionCwdRecordCountInScope =
		scope === undefined ? 0 : allRecords.filter(r => matchesScopePath(r.sessionCwd, scope)).length;
	const sessionScopedRecordCount = allRecords.filter(r => r.sessionCwd !== undefined).length;
	const legacyUnscopedRecordCount = allRecords.filter(r => r.cwd === undefined && r.sessionCwd === undefined).length;
	const recordsWithSessionCwd = sessionScopedRecordCount;
	const recordsWithoutSessionCwd = recordCount - recordsWithSessionCwd;
	const currentSessionRecordCount =
		scope === undefined
			? 0
			: input.activeSessionCommands !== undefined
				? (await filterActiveSessionRecordsByCommands(scopedRecords, input.activeSessionCommands)).length
				: input.activeSessionFile !== undefined
					? (await filterActiveSessionRecords(scopedRecords, input.activeSessionFile, scopeCwd)).length
					: allRecords.filter(r => matchesCwd(r, scope) && timestampAtOrAfter(r.timestamp, MODULE_STARTED_AT))
							.length;

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
	const mostRecentParsed = mostRecentTimestamp === null ? NaN : Date.parse(mostRecentTimestamp);
	const mostRecentRecordAgeMs =
		mostRecentTimestamp === null || !Number.isFinite(mostRecentParsed)
			? null
			: Math.max(0, Date.now() - mostRecentParsed);

	let recentMissedRatio: number | null = null;
	let recentHitRatio: number | null = null;
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

	const scopeFilter = scopeCwd ?? null;
	const status = getMinimizerGainStatus();
	const loadDurationMs = Date.now() - start;

	const nativeBindingLoaded = allRecords.some(isSavingsRecord);
	const minimizerEnabled = nativeBindingLoaded;

	return {
		recordsFilePath,
		exists,
		fileSizeBytes,
		mtime,
		recordCount,
		recordCountInScope,
		commandCwdRecordCountInScope,
		sessionCwdRecordCountInScope,
		sessionScopedRecordCount,
		legacyUnscopedRecordCount,
		recordsWithSessionCwd,
		recordsWithoutSessionCwd,
		mostRecentRecordAgeMs,
		currentSessionRecordCount,
		schemaVersion: MINIMIZER_GAIN_SCHEMA_VERSION,
		extensionBundlePath,
		extensionBundleMtime,
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
		cwdFilter: scopeFilter,
		scopeFilter,
		distinctCwdsCount: distinctCwds.size,
		distinctCwdsSample,
	};
}

// ---------------------------------------------------------------------------
interface MigrateLegacySessionCwdsInput {
	agentDir?: string;
	recordsFilePath: string;
	scopeCwd: string;
}

interface BashTranscriptCommand {
	command: string;
	cwd: string;
}

async function migrateLegacySessionCwds(input: MigrateLegacySessionCwdsInput): Promise<void> {
	let text: string;
	try {
		text = await fs.readFile(input.recordsFilePath, "utf8");
	} catch {
		return;
	}

	const lines = text.trimEnd().split("\n");
	const candidates = new Map<string, JsonObject>();
	for (const line of lines) {
		const record = parseJsonObject(line);
		if (!record) continue;
		if (typeof record.sessionCwd === "string") continue;
		if (typeof record.cwd !== "string" || typeof record.command !== "string") continue;
		candidates.set(`${record.cwd}\0${record.command}`, record);
	}
	if (candidates.size === 0) return;

	const transcriptCommands = await readSessionTranscriptBashCommands(input.agentDir, input.scopeCwd);
	if (transcriptCommands.size === 0) return;

	let changed = false;
	const migrated = lines.map(line => {
		const record = parseJsonObject(line);
		if (!record) return line;
		if (typeof record.sessionCwd === "string") return line;
		if (typeof record.cwd !== "string" || typeof record.command !== "string") return line;
		if (!transcriptCommands.has(`${record.cwd}\0${record.command}`)) return line;
		changed = true;
		return JSON.stringify({ ...record, schemaVersion: MINIMIZER_GAIN_SCHEMA_VERSION, sessionCwd: input.scopeCwd });
	});
	if (!changed) return;

	const backupPath = `${input.recordsFilePath}.bak-${new Date().toISOString().replaceAll(":", "-")}`;
	try {
		await fs.writeFile(backupPath, text);
		await fs.writeFile(input.recordsFilePath, `${migrated.join("\n")}\n`);
	} catch (err) {
		writeErrorCount += 1;
		lastWriteError = { error: String(err), at: new Date().toISOString() };
	}
}

async function readSessionTranscriptBashCommands(agentDir: string | undefined, scopeCwd: string): Promise<Set<string>> {
	const sessionsDir = path.join(agentDir ?? getAgentDir(), "sessions");
	const result = new Set<string>();
	let projectDirs: string[];
	try {
		projectDirs = await fs.readdir(sessionsDir);
	} catch {
		return result;
	}
	for (const projectDir of projectDirs) {
		const fullDir = path.join(sessionsDir, projectDir);
		let files: string[];
		try {
			files = await fs.readdir(fullDir);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			await readSessionTranscriptFile(path.join(fullDir, file), scopeCwd, result);
		}
	}
	return result;
}

async function readSessionTranscriptFile(filePath: string, scopeCwd: string, result: Set<string>): Promise<void> {
	let text: string;
	try {
		text = await fs.readFile(filePath, "utf8");
	} catch {
		return;
	}
	let sessionCwd: string | undefined;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		const event = parseJsonObject(line);
		if (!event) continue;
		if (event.type === "session" && typeof event.cwd === "string") {
			sessionCwd = await resolveMinimizerGainCwd(event.cwd);
			if (sessionCwd !== scopeCwd) return;
			continue;
		}
		if (sessionCwd !== scopeCwd) continue;
		for (const command of extractBashTranscriptCommands(event, sessionCwd)) {
			result.add(`${command.cwd}\0${command.command}`);
		}
	}
}

async function readActiveSessionTranscriptCommandCounts(
	filePath: string,
	scopeCwd: string,
): Promise<Map<string, number>> {
	const result = new Map<string, number>();
	let text: string;
	try {
		text = await fs.readFile(filePath, "utf8");
	} catch {
		return result;
	}
	let sessionCwd: string | undefined;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		const event = parseJsonObject(line);
		if (!event) continue;
		if (event.type === "session" && typeof event.cwd === "string") {
			sessionCwd = await resolveMinimizerGainCwd(event.cwd);
			if (sessionCwd !== scopeCwd) return new Map();
			continue;
		}
		if (sessionCwd !== scopeCwd) continue;
		for (const command of extractBashTranscriptCommands(event, sessionCwd)) {
			const key = `${command.cwd}\0${command.command}`;
			result.set(key, (result.get(key) ?? 0) + 1);
		}
	}
	return result;
}
async function buildActiveSessionCommandCounts(commands: Iterable<ActiveSessionCommand>): Promise<Map<string, number>> {
	const result = new Map<string, number>();
	for (const command of commands) {
		const cwd = await resolveMinimizerGainCwd(command.cwd);
		if (cwd === undefined) continue;
		const key = `${cwd}\0${command.command}`;
		result.set(key, (result.get(key) ?? 0) + 1);
	}
	return result;
}

function filterActiveSessionRecordsByCounts(
	records: MinimizerGainRecord[],
	remaining: Map<string, number>,
): MinimizerGainRecord[] {
	if (remaining.size === 0) return [];
	const active: MinimizerGainRecord[] = [];
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index];
		if (record === undefined || record.cwd === undefined) continue;
		const key = `${record.cwd}\0${record.command}`;
		const count = remaining.get(key) ?? 0;
		if (count <= 0) continue;
		remaining.set(key, count - 1);
		active.push(record);
	}
	active.reverse();
	return active;
}

async function filterActiveSessionRecordsByCommands(
	records: MinimizerGainRecord[],
	commands: Iterable<ActiveSessionCommand>,
): Promise<MinimizerGainRecord[]> {
	return filterActiveSessionRecordsByCounts(records, await buildActiveSessionCommandCounts(commands));
}

async function filterActiveSessionRecords(
	records: MinimizerGainRecord[],
	activeSessionFile: string,
	scopeCwd: string,
): Promise<MinimizerGainRecord[]> {
	const remaining = await readActiveSessionTranscriptCommandCounts(activeSessionFile, scopeCwd);
	return filterActiveSessionRecordsByCounts(records, remaining);
}

function extractBashTranscriptCommands(event: JsonObject, sessionCwd: string): BashTranscriptCommand[] {
	const message = asJsonObject(event.message);
	const content = message?.content ?? event.content;
	const parts = Array.isArray(content) ? content : [content];
	const commands: BashTranscriptCommand[] = [];
	for (const part of parts) {
		const toolCall = asJsonObject(part);
		if (!toolCall) continue;
		if (toolCall.name !== "bash") continue;
		if (toolCall.type !== "toolCall" && toolCall.type !== "tool_use") continue;
		const input = asJsonObject(toolCall.arguments) ?? asJsonObject(toolCall.input);
		if (!input || typeof input.command !== "string") continue;
		const commandCwd = typeof input.cwd === "string" ? path.resolve(sessionCwd, input.cwd) : sessionCwd;
		commands.push({ command: input.command, cwd: path.resolve(commandCwd) });
	}
	return commands;
}

function getSourceSummary(map: Map<string, MinimizerGainSourceSummary>, source: string): MinimizerGainSourceSummary {
	return getOrInsert(map, source, () => ({ source, ...createTotals() }));
}

function getDailySummary(map: Map<string, MinimizerGainDailySummary>, date: string): MinimizerGainDailySummary {
	return getOrInsert(map, date, () => ({ date, ...createTotals() }));
}

function summarizeDailyTotals(records: MinimizerGainRecord[]): MinimizerGainDailySummary[] {
	const byDay = new Map<string, MinimizerGainDailySummary>();
	for (const record of records) {
		if (!isSavingsRecord(record)) continue;
		const date = record.timestamp.slice(0, 10);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
		addRecord(getDailySummary(byDay, date), record);
	}
	return [...byDay.values()].map(finalizeTotals).sort((a, b) => a.date.localeCompare(b.date));
}

async function readIgnoredMissedCommandsConfig(agentDir: string | undefined): Promise<string[]> {
	const configPath = path.join(agentDir ?? getAgentDir(), "extensions", "pi-minimizer-gain", "config.json");
	try {
		const config = parseJsonObject(await fs.readFile(configPath, "utf8"));
		return stringArray(config?.ignoredMissedCommands);
	} catch {
		return [];
	}
}

function splitCommandList(value: string | undefined): string[] {
	if (value === undefined) return [];
	return value
		.split(",")
		.map(item => item.trim())
		.filter(Boolean);
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function normalizeIgnoredCommands(commands: Iterable<string>): Set<string> {
	const normalized = new Set<string>();
	for (const command of commands) {
		const name = normalizeCommandName(command);
		if (name !== "") normalized.add(name);
	}
	return normalized;
}

function normalizeCommandName(command: string): string {
	const trimmed = command.trim();
	if (trimmed === "") return "";
	const first = trimmed.split(/\s+/, 1)[0] ?? "";
	const slash = first.lastIndexOf("/");
	return (slash === -1 ? first : first.slice(slash + 1)).toLowerCase();
}

function getSourceBucket(record: MinimizerGainRecord): string {
	if (!record.sourcePaths || record.sourcePaths.length === 0) return "unknown";
	const buckets = new Set<string>();
	for (const sourcePath of record.sourcePaths) {
		const ext = path.extname(sourcePath);
		buckets.add(ext.length === 0 ? "no-extension" : ext);
	}
	if (buckets.size === 0) return "unknown";
	if (buckets.size > 1) return "mixed";
	return [...buckets][0] ?? "unknown";
}

// Internal helpers
// ---------------------------------------------------------------------------

function isSavedRecord(record: MinimizerGainRecord): boolean {
	return record.kind === undefined || record.kind === "saved";
}

function isSavingsRecord(record: MinimizerGainRecord): boolean {
	return isSavedRecord(record) && record.savedBytes > 0;
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
	const key = cwd ?? "<unknown>";
	return getOrInsert(map, key, () => ({ cwd: cwd ?? "<unknown>", ...createTotals() }));
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
	if (record.savedTokens !== undefined) {
		totals.estimatedTokensSaved += record.savedTokens;
		totals.usesEstimatedTokensSaved = true;
	} else {
		totals.estimatedTokensSaved += Math.floor(record.savedBytes / BYTES_PER_TOKEN_ESTIMATE);
	}
	totals.estimatedInputTokens += Math.floor(record.inputBytes / BYTES_PER_TOKEN_ESTIMATE);
}

function finalizeTotals<T extends MinimizerGainTotals>(totals: T): T {
	if (totals.inputBytes > 0) {
		totals.tokensSavedRatio = totals.savedBytes / totals.inputBytes;
	}
	return totals;
}

function finalizeGroups<T extends MinimizerGainTotals>(groups: Map<string, T>): T[] {
	return [...groups.values()].map(finalizeTotals).sort(compareSavedBytesDesc);
}

function compareSavedBytesDesc<T extends MinimizerGainTotals>(a: T, b: T): number {
	return b.savedBytes - a.savedBytes;
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
		schemaVersion: optionalNumber(value.schemaVersion),
		timestamp: requiredString(value.timestamp),
		cwd: optionalString(value.cwd),
		sessionCwd: optionalString(value.sessionCwd),
		command: requiredString(value.command),
		filter: requiredString(value.filter),
		inputBytes: requiredNumber(value.inputBytes),
		outputBytes: requiredNumber(value.outputBytes),
		savedBytes: requiredNumber(value.savedBytes),
		savedTokens: optionalNumber(value.savedTokens),
		exitCode: parseExitCode(value.exitCode),
		kind: parseKind(value.kind),
		sourcePaths: optionalStringArray(value.sourcePaths ?? value.sourcePath),
	};
	return hasInvalidField(fields) ? null : toMinimizerGainRecord(fields as ValidRecordFields);
}

function toMinimizerGainRecord(fields: ValidRecordFields): MinimizerGainRecord {
	const { schemaVersion, cwd, sessionCwd, kind, sourcePaths, ...record } = fields;
	return {
		...(schemaVersion === undefined ? {} : { schemaVersion }),
		...record,
		...(cwd === undefined ? {} : { cwd }),
		...(sessionCwd === undefined ? {} : { sessionCwd }),
		...(kind === undefined ? {} : { kind }),
		...(sourcePaths === undefined ? {} : { sourcePaths }),
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

function optionalStringArray(value: unknown): string[] | undefined | Invalid {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value.trim() === "" ? [] : [value];
	if (!Array.isArray(value)) return INVALID;
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return INVALID;
		if (item.trim() !== "") result.push(item);
	}
	return result;
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

function matchesScopePath(candidate: string | undefined, scope: MinimizerGainScope | undefined): boolean {
	if (scope === undefined) return true;
	if (!candidate) return false;
	return scope.aliases.some(alias => candidate === alias || candidate.startsWith(`${alias}${path.sep}`));
}

function matchesCwd(record: MinimizerGainRecord, scope: MinimizerGainScope | undefined): boolean {
	if (scope === undefined) return true;
	return matchesScopePath(record.cwd, scope) || matchesScopePath(record.sessionCwd, scope);
}

function matchesGainFilters(
	record: MinimizerGainRecord,
	scope: MinimizerGainScope | undefined,
	cutoff: number | null,
): boolean {
	return matchesCwd(record, scope) && matchesCutoff(record, cutoff);
}

function matchesCutoff(record: MinimizerGainRecord, cutoff: number | null): boolean {
	return cutoff === null || timestampAtOrAfter(record.timestamp, cutoff);
}

function timestampAtOrAfter(timestamp: string, cutoff: number): boolean {
	return Date.parse(timestamp) >= cutoff;
}
