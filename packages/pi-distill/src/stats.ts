import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEBOUNCE_MS = 250;

export interface ToolStats {
	candidates: number;
	hits: number;
	savedBytes: number;
}

export interface SessionRecord {
	sessionId: string;
	project: string;
	label: string;
	savedBytes: number;
	hits: number;
	originalBytes?: number;
	replacementBytes?: number;
	firstTs: number;
	lastTs: number;
	tools?: Record<string, ToolStats>;
}

interface RuntimeRecord extends SessionRecord {
	projectStorePath: string;
	globalStorePath: string;
}

interface StatsStore {
	sessions: Record<string, SessionRecord>;
}

export interface Totals {
	savedBytes: number;
	hits: number;
	estTokens: number;
	sessions: number;
	originalBytes: number;
	replacementBytes: number;
	knownSavedBytes: number;
	reductionPercent: number | null;
	tools: Record<string, ToolStats>;
}

export interface AggregateStats {
	project: Totals;
	global: Totals;
	sessions: SessionRecord[];
}

interface StatsContext {
	sessionManager?: {
		getSessionId?: () => string;
		getCwd?: () => string;
		getSessionName?: () => string | undefined;
	};
}

const recordsByKey = new Map<string, RuntimeRecord>();
const dirtyKeys = new Set<string>();
let persistTimer: Timer | undefined;

function emptyStore(): StatsStore {
	return { sessions: {} };
}

function projectStatsPath(project: string): string {
	return path.join(project, ".omp", "pi-distill-stats.json");
}

function globalStatsPath(): string {
	return path.join(process.env.HOME ?? os.homedir(), ".omp", "agent", "pi-distill", "stats.json");
}

function toStoreRecord(record: RuntimeRecord): SessionRecord {
	const tools = copyToolStats(record.tools);
	return {
		sessionId: record.sessionId,
		project: record.project,
		label: record.label,
		savedBytes: record.savedBytes,
		...(record.originalBytes === undefined ? {} : { originalBytes: record.originalBytes }),
		...(record.replacementBytes === undefined ? {} : { replacementBytes: record.replacementBytes }),
		hits: record.hits,
		...(tools === undefined ? {} : { tools }),
		firstTs: record.firstTs,
		lastTs: record.lastTs,
	};
}

function readStoreSync(filePath: string): StatsStore {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<StatsStore> | null;
		if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object") {
			return emptyStore();
		}
		return { sessions: parsed.sessions };
	} catch {
		return emptyStore();
	}
}

async function readStore(filePath: string): Promise<StatsStore> {
	try {
		const parsed = JSON.parse(await fs.promises.readFile(filePath, "utf8")) as Partial<StatsStore> | null;
		if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object") {
			return emptyStore();
		}
		return { sessions: parsed.sessions };
	} catch {
		return emptyStore();
	}
}

async function writeRecords(filePath: string, records: RuntimeRecord[]): Promise<void> {
	const store = await readStore(filePath);
	for (const record of records) {
		store.sessions[record.sessionId] = toStoreRecord(record);
	}
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function persist(records: RuntimeRecord[]): Promise<void> {
	const byPath = new Map<string, RuntimeRecord[]>();
	for (const record of records) {
		for (const filePath of [record.projectStorePath, record.globalStorePath]) {
			const group = byPath.get(filePath);
			if (group) {
				group.push(record);
			} else {
				byPath.set(filePath, [record]);
			}
		}
	}
	await Promise.all(Array.from(byPath, ([filePath, group]) => writeRecords(filePath, group)));
}

function schedulePersist(): void {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = undefined;
		const keys = Array.from(dirtyKeys);
		dirtyKeys.clear();
		const dirtyRecords = keys.flatMap(key => {
			const record = recordsByKey.get(key);
			return record ? [record] : [];
		});
		persist(dirtyRecords).catch(() => {});
	}, DEBOUNCE_MS);
}

function sessionInfo(ctx: StatsContext): Pick<SessionRecord, "sessionId" | "project" | "label"> {
	const sessionManager = ctx.sessionManager;
	const sessionId = String(sessionManager?.getSessionId?.() ?? "unknown");
	const project = String(sessionManager?.getCwd?.() ?? process.cwd());
	const name = sessionManager?.getSessionName?.();
	return {
		sessionId,
		project,
		label: typeof name === "string" && name.length > 0 ? name : project,
	};
}

function copyToolStats(tools: Record<string, ToolStats> | undefined): Record<string, ToolStats> | undefined {
	if (!tools) return undefined;
	const entries = Object.entries(tools);
	if (entries.length === 0) return undefined;
	const copy: Record<string, ToolStats> = {};
	for (const [toolName, stats] of entries) {
		copy[toolName] = {
			candidates: stats.candidates,
			hits: stats.hits,
			savedBytes: stats.savedBytes,
		};
	}
	return copy;
}

function mergeToolStats(records: SessionRecord[]): Record<string, ToolStats> {
	const tools: Record<string, ToolStats> = {};
	for (const record of records) {
		if (!record.tools) continue;
		for (const [toolName, stats] of Object.entries(record.tools)) {
			const tool = tools[toolName] ?? { candidates: 0, hits: 0, savedBytes: 0 };
			tool.candidates += stats.candidates;
			tool.hits += stats.hits;
			tool.savedBytes += stats.savedBytes;
			tools[toolName] = tool;
		}
	}
	return tools;
}

function recordFor(ctx: StatsContext, now: number): { key: string; record: RuntimeRecord } {
	const info = sessionInfo(ctx);
	const projectStorePath = projectStatsPath(info.project);
	const globalStorePathValue = globalStatsPath();
	const key = recordKey(info.sessionId, projectStorePath, globalStorePathValue);
	const existing = recordsByKey.get(key);
	const record = existing ?? {
		...info,
		savedBytes: 0,
		hits: 0,
		firstTs: now,
		lastTs: now,
		projectStorePath,
		globalStorePath: globalStorePathValue,
	};
	record.project = info.project;
	record.label = info.label;
	recordsByKey.set(key, record);
	return { key, record };
}

function toolStatsFor(record: RuntimeRecord, toolName: string): ToolStats {
	record.tools ??= {};
	const stats = record.tools[toolName] ?? { candidates: 0, hits: 0, savedBytes: 0 };
	record.tools[toolName] = stats;
	return stats;
}

function recordKey(sessionId: string, projectStorePath: string, globalStorePath: string): string {
	return `${globalStorePath}\n${projectStorePath}\n${sessionId}`;
}

function totalsFor(records: SessionRecord[]): Totals {
	const savedBytes = records.reduce((sum, record) => sum + record.savedBytes, 0);
	const hits = records.reduce((sum, record) => sum + record.hits, 0);
	const originalBytes = records.reduce((sum, record) => sum + (record.originalBytes ?? 0), 0);
	const replacementBytes = records.reduce((sum, record) => sum + (record.replacementBytes ?? 0), 0);
	const knownSavedBytes = records.reduce(
		(sum, record) => (record.originalBytes === undefined ? sum : sum + record.savedBytes),
		0,
	);
	const reductionPercent = originalBytes > 0 ? (knownSavedBytes / originalBytes) * 100 : null;
	return {
		savedBytes,
		hits,
		estTokens: Math.round(savedBytes / 4),
		sessions: records.length,
		originalBytes,
		replacementBytes,
		reductionPercent,
		knownSavedBytes,
		tools: mergeToolStats(records),
	};
}

function withMemoryRecords(store: StatsStore, predicate: (record: RuntimeRecord) => boolean): StatsStore {
	const sessions = { ...store.sessions };
	for (const record of recordsByKey.values()) {
		if (predicate(record)) sessions[record.sessionId] = toStoreRecord(record);
	}
	return { sessions };
}

export function recordCandidate(ctx: StatsContext, toolName: string): void {
	try {
		const now = Date.now();
		const { key, record } = recordFor(ctx, now);
		const tool = toolStatsFor(record, toolName);
		tool.candidates += 1;
		record.lastTs = now;
		dirtyKeys.add(key);
		schedulePersist();
	} catch {}
}

export function recordHit(
	ctx: StatsContext,
	toolName: string,
	savedBytes: number,
	originalBytes?: number,
	replacementBytes?: number,
): void {
	try {
		const now = Date.now();
		const { key, record } = recordFor(ctx, now);
		const tool = toolStatsFor(record, toolName);
		record.savedBytes += savedBytes;
		record.hits += 1;
		tool.savedBytes += savedBytes;
		tool.hits += 1;
		if (originalBytes !== undefined) record.originalBytes = (record.originalBytes ?? 0) + originalBytes;
		if (replacementBytes !== undefined) {
			record.replacementBytes = (record.replacementBytes ?? 0) + replacementBytes;
		}
		record.lastTs = now;
		dirtyKeys.add(key);
		schedulePersist();
	} catch {}
}

export async function flush(): Promise<void> {
	if (persistTimer) {
		clearTimeout(persistTimer);
		persistTimer = undefined;
	}
	const keys = Array.from(dirtyKeys);
	dirtyKeys.clear();
	const dirtyRecords = keys.flatMap(key => {
		const record = recordsByKey.get(key);
		return record ? [record] : [];
	});
	await persist(dirtyRecords);
}

export function aggregate(ctx: StatsContext): AggregateStats {
	const info = sessionInfo(ctx);
	const currentProjectPath = projectStatsPath(info.project);
	const currentGlobalPath = globalStatsPath();
	const projectStore = withMemoryRecords(
		readStoreSync(currentProjectPath),
		record => record.projectStorePath === currentProjectPath,
	);
	const globalStore = withMemoryRecords(
		readStoreSync(currentGlobalPath),
		record => record.globalStorePath === currentGlobalPath,
	);
	const sessions = Object.values(globalStore.sessions).sort((a, b) => b.lastTs - a.lastTs);
	return {
		project: totalsFor(Object.values(projectStore.sessions)),
		global: totalsFor(Object.values(globalStore.sessions)),
		sessions,
	};
}

export function resetStatsForTests(): void {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = undefined;
	recordsByKey.clear();
	dirtyKeys.clear();
}
