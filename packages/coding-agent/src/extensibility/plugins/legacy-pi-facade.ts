import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface ToolResultEvent {
	toolName: string;
}

interface ToolCallEvent {
	toolName: string;
}

export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

interface LegacySessionEntry {
	type: string;
	id: string;
	parentId?: string | null;
	timestamp?: string;
	[key: string]: unknown;
}

interface LegacySessionHeader extends LegacySessionEntry {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

function createId(): string {
	return crypto.randomUUID();
}

function createSessionFile(sessionDir: string, sessionId: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(sessionDir, `${timestamp}_${sessionId}.jsonl`);
}

function defaultSessionDir(): string {
	return path.join(os.homedir(), process.env.PI_CONFIG_DIR || ".lex", "agent", "sessions");
}

function readEntries(filePath: string): LegacySessionEntry[] {
	try {
		return fs
			.readFileSync(filePath, "utf8")
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean)
			.map(line => JSON.parse(line) as LegacySessionEntry);
	} catch {
		return [];
	}
}

function writeEntries(filePath: string, entries: readonly LegacySessionEntry[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

export class SessionManager {
	#cwd: string;
	#sessionDir: string;
	#sessionFile: string;
	#entries: LegacySessionEntry[];
	#leafId: string | null;

	constructor(cwd: string, sessionDir: string, sessionFile: string, entries: LegacySessionEntry[]) {
		this.#cwd = cwd;
		this.#sessionDir = sessionDir;
		this.#sessionFile = sessionFile;
		this.#entries = entries;
		this.#leafId = entries.length > 0 ? (entries[entries.length - 1]?.id ?? null) : null;
	}

	static create(cwd: string, sessionDir: string = defaultSessionDir()): SessionManager {
		const sessionId = createId();
		const sessionFile = createSessionFile(sessionDir, sessionId);
		const header: LegacySessionHeader = {
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: new Date().toISOString(),
			cwd,
		};
		writeEntries(sessionFile, [header]);
		return new SessionManager(cwd, sessionDir, sessionFile, [header]);
	}

	static open(filePath: string, sessionDir: string = path.dirname(filePath)): SessionManager {
		const entries = readEntries(filePath);
		const header = entries.find((entry): entry is LegacySessionHeader => entry.type === "session") as
			| LegacySessionHeader
			| undefined;
		return new SessionManager(header?.cwd ?? process.cwd(), sessionDir, filePath, entries);
	}

	getSessionDir(): string {
		return this.#sessionDir;
	}

	getSessionFile(): string {
		return this.#sessionFile;
	}

	appendMessage(message: unknown): string {
		const entry: LegacySessionEntry = {
			type: "message",
			id: createId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this.#entries.push(entry);
		this.#leafId = entry.id;
		fs.appendFileSync(this.#sessionFile, `${JSON.stringify(entry)}\n`);
		return entry.id;
	}

	createBranchedSession(leafId: string): string | undefined {
		const byId = new Map(this.#entries.map(entry => [entry.id, entry]));
		const branch: LegacySessionEntry[] = [];
		let current = byId.get(leafId);
		while (current) {
			branch.unshift(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		if (branch.length === 0) return undefined;

		const sessionId = createId();
		const sessionFile = createSessionFile(this.#sessionDir, sessionId);
		const header: LegacySessionHeader = {
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: new Date().toISOString(),
			cwd: this.#cwd,
			parentSession: this.#sessionFile,
		};
		const entries = [header, ...branch.filter(entry => entry.type !== "session" && entry.type !== "label")];
		writeEntries(sessionFile, entries);
		this.#sessionFile = sessionFile;
		this.#entries = entries;
		this.#leafId = entries[entries.length - 1]?.id ?? header.id;
		return sessionFile;
	}
}

function isToolResult(toolName: string, event: ToolResultEvent): boolean {
	return event.toolName === toolName;
}

export function isBashToolResult(event: ToolResultEvent): boolean {
	return isToolResult("bash", event);
}

export function isReadToolResult(event: ToolResultEvent): boolean {
	return isToolResult("read", event);
}

export function isEditToolResult(event: ToolResultEvent): boolean {
	return isToolResult("edit", event);
}

export function isWriteToolResult(event: ToolResultEvent): boolean {
	return isToolResult("write", event);
}

export function isFindToolResult(event: ToolResultEvent): boolean {
	return isToolResult("find", event);
}

export function isGrepToolResult(event: ToolResultEvent): boolean {
	return isToolResult("grep", event) || isToolResult("search", event);
}
