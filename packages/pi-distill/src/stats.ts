import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Totals {
	savedBytes: number;
	hits: number;
	estTokens: number;
	sessions: number;
}

export interface SessionRecord {
	sessionId: string;
	project: string;
	label: string;
	savedBytes: number;
	hits: number;
	firstTs: number;
	lastTs: number;
}

interface Store {
	sessions: Record<string, SessionRecord>;
}

interface PendingRecord extends SessionRecord {
	projectStorePath: string;
	globalStorePath: string;
}

const DEBOUNCE_MS = 250;
const recordsByKey = new Map<string, PendingRecord>();
const dirtyKeys = new Set<string>();
let persistTimer: NodeJS.Timeout | undefined;

function emptyStore(): Store {
	return { sessions: {} };
}

function projectStatsPath(project: string): string {
	return path.join(project, ".omp", "pi-distill-stats.json");
}

function globalStatsPath(): string {
	// Deliberately NOT under .omp/agent/extensions/ — that dir is scanned by the
	// extension loader; a stats dir there would be probed as a (broken) extension.
	return path.join(process.env.HOME ?? os.homedir(), ".omp", "agent", "pi-distill", "stats.json");
}

function toStoreRecord(record: PendingRecord): SessionRecord {
	return {
		sessionId: record.sessionId,
		project: record.project,
		label: record.label,
		savedBytes: record.savedBytes,
		hits: record.hits,
		firstTs: record.firstTs,
		lastTs: record.lastTs,
	};
}

function readStoreSync(filePath: string): Store {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Store;
		if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object") {
			return emptyStore();
		}
		return { sessions: parsed.sessions };
	} catch {
		return emptyStore();
	}
}

async function readStore(filePath: string): Promise<Store> {
	try {
		const parsed = JSON.parse(await fs.promises.readFile(filePath, "utf8")) as Store;
		if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object") {
			return emptyStore();
		}
		return { sessions: parsed.sessions };
	} catch {
		return emptyStore();
	}
}

async function writeRecords(filePath: string, records: PendingRecord[]): Promise<void> {
	const store = await readStore(filePath);
	for (const record of records) {
		store.sessions[record.sessionId] = toStoreRecord(record);
	}
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function persist(records: PendingRecord[]): Promise<void> {
	const byPath = new Map<string, PendingRecord[]>();
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

function getSessionInfo(ctx: any): { sessionId: string; project: string; label: string } {
	const sessionManager = ctx.sessionManager;
	const sessionId = String(sessionManager.getSessionId());
	const project = String(sessionManager.getCwd());
	const name = sessionManager.getSessionName?.();
	return {
		sessionId,
		project,
		label: typeof name === "string" && name.length > 0 ? name : project,
	};
}

function recordKey(sessionId: string, projectStorePath: string, globalStorePath: string): string {
	return `${globalStorePath}\n${projectStorePath}\n${sessionId}`;
}

function totalsFor(records: SessionRecord[]): Totals {
	const savedBytes = records.reduce((sum, record) => sum + record.savedBytes, 0);
	const hits = records.reduce((sum, record) => sum + record.hits, 0);
	return {
		savedBytes,
		hits,
		estTokens: Math.round(savedBytes / 4),
		sessions: records.length,
	};
}

function withMemoryRecords(store: Store, predicate: (record: PendingRecord) => boolean): Store {
	const sessions = { ...store.sessions };
	for (const record of recordsByKey.values()) {
		if (predicate(record)) sessions[record.sessionId] = toStoreRecord(record);
	}
	return { sessions };
}

export function recordHit(ctx: any, savedBytes: number): void {
	try {
		const info = getSessionInfo(ctx);
		const now = Date.now();
		const projectStorePath = projectStatsPath(info.project);
		const globalStorePath = globalStatsPath();
		const key = recordKey(info.sessionId, projectStorePath, globalStorePath);
		const existing = recordsByKey.get(key);
		const base: PendingRecord = existing ?? {
			...info,
			savedBytes: 0,
			hits: 0,
			firstTs: now,
			lastTs: now,
			projectStorePath,
			globalStorePath,
		};

		base.project = info.project;
		base.label = info.label;
		base.savedBytes += savedBytes;
		base.hits += 1;
		base.lastTs = now;
		recordsByKey.set(key, base);
		dirtyKeys.add(key);
		schedulePersist();
	} catch {
		// Stats are best-effort and must never affect tool-result handling.
	}
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

export function aggregate(ctx: any): { project: Totals; global: Totals; sessions: SessionRecord[] } {
	const info = getSessionInfo(ctx);
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
