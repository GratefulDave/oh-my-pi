import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";

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
}

export interface MinimizerMissedSummary {
	commands: MinimizerMissedItem[];
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
			.map(parseMinimizerGainRecord)
			.filter(
				(record): record is MinimizerGainRecord =>
					record !== null && matchesGainFilters(record, options.cwd, cutoff),
			);
	} catch {
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
	const commands = [...groups.values()]
		.map(finalizeMissedItem)
		.sort((a, b) => b.inputBytes - a.inputBytes)
		.slice(0, limit);
	return { commands };
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
		_exitCodes: new Set(),
	}));
}

function addExitCode(item: MinimizerMissedAccumulator, exitCode: number | null): void {
	item._exitCodes.add(exitCode);
}

function finalizeMissedItem(item: MinimizerMissedAccumulator): MinimizerMissedItem {
	return {
		command: item.command,
		filter: item.filter,
		commands: item.commands,
		inputBytes: item.inputBytes,
		outputBytes: item.outputBytes,
		avgInputBytes: item.commands === 0 ? 0 : Math.round(item.inputBytes / item.commands),
		exitCodes: [...item._exitCodes].sort(compareExitCodes),
	};
}

function compareExitCodes(a: number | null, b: number | null): number {
	if (a === b) return 0;
	if (a === null) return -1;
	if (b === null) return 1;
	return a - b;
}

function parseMinimizerGainRecord(line: string): MinimizerGainRecord | null {
	const value = parseJsonObject(line);
	return value ? parseRecordFields(value) : null;
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
	};
}

function addRecord(totals: MinimizerGainTotals, record: MinimizerGainRecord): void {
	totals.commands += 1;
	totals.inputBytes += record.inputBytes;
	totals.outputBytes += record.outputBytes;
	totals.savedBytes += record.savedBytes;
	totals.estimatedTokensSaved += record.savedTokens ?? Math.floor(record.savedBytes / BYTES_PER_TOKEN_ESTIMATE);
	totals.usesEstimatedTokensSaved ||= record.savedTokens === undefined;
}

function finalizeTotals<T extends MinimizerGainTotals>(totals: T): T {
	return totals;
}

function finalizeGroups<T extends MinimizerGainTotals>(groups: Map<string, T>): T[] {
	return [...groups.values()].map(finalizeTotals).sort(compareSavedBytesDesc);
}

function compareSavedBytesDesc<T extends MinimizerGainTotals>(a: T, b: T): number {
	return b.savedBytes - a.savedBytes;
}
