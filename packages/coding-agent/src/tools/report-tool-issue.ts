/**
 * report_tool_issue — automated QA tool for tracking unexpected tool behavior.
 * Enabled by default; gated behind PI_AUTO_QA=1 / `dev.autoqa` so a user
 * who flips the setting off short-circuits injection entirely.
 * Always injected into every agent (including subagents) regardless of tool selection.
 * Records grievances to a local SQLite database under `~/.omp/agent/autoqa.db`;
 * never throws, never prompts, and never publishes as a side effect of a tool call.
 *
 * Manual publishing remains available through `lex grievances push`, but only
 * when the user explicitly configures a destination endpoint.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { $env, $flag, getInstallId, logger, VERSION } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import type { Settings } from "..";
import type { ToolSession } from "./index";

function buildReportToolIssueParams(activeBuiltinNames: readonly string[]) {
	// Enum gives the model a tight schema; the runtime check in `execute` is the
	// source of truth (handles models that ignore the enum and the empty-list
	// fallback used by call sites that don't know the active set yet).
	const toolSchema = activeBuiltinNames.length > 0 ? z.enum(activeBuiltinNames as [string, ...string[]]) : z.string();
	return z.object({
		tool: toolSchema.describe("tool name"),
		report: z
			.string()
			.describe("unexpected behavior; generic, NEVER PII (paths, file contents, identifiers, prompt text)"),
	});
}

export function isAutoQaEnabled(settings?: Settings): boolean {
	return $flag("PI_AUTO_QA") || !!settings?.get("dev.autoqa");
}

function getOmpAgentDir(): string {
	return path.join(os.homedir(), ".omp", "agent");
}

function getLegacyLexAutoQaDbPath(): string {
	return path.join(os.homedir(), ".lex", "agent", "autoqa.db");
}

export function getAutoQaDbPath(): string {
	return path.join(getOmpAgentDir(), "autoqa.db");
}

function ensureGrievancesSchema(db: Database): void {
	db.run(`
		PRAGMA journal_mode=WAL;
		PRAGMA synchronous=NORMAL;
		PRAGMA busy_timeout=5000;
		CREATE TABLE IF NOT EXISTS grievances (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			model TEXT NOT NULL,
			version TEXT NOT NULL,
			tool TEXT NOT NULL,
			report TEXT NOT NULL,
			pushed INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER
		);
	`);
	const cols = db.prepare("PRAGMA table_info(grievances)").all() as Array<{ name: string }>;
	if (!cols.some(c => c.name === "pushed")) {
		db.run("ALTER TABLE grievances ADD COLUMN pushed INTEGER NOT NULL DEFAULT 0");
	}
	if (!cols.some(c => c.name === "created_at")) {
		db.run("ALTER TABLE grievances ADD COLUMN created_at INTEGER");
	}
	db.run("CREATE INDEX IF NOT EXISTS grievances_pushed_idx ON grievances(pushed, id)");
}

function importLegacyAutoQaRows(target: Database): void {
	const legacyPath = getLegacyLexAutoQaDbPath();
	if (legacyPath === getAutoQaDbPath() || !fs.existsSync(legacyPath)) return;

	let legacy: Database | null = null;
	try {
		legacy = new Database(legacyPath, { readonly: true });
		const tables = legacy
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'grievances'")
			.all();
		if (tables.length === 0) return;
		const cols = legacy.prepare("PRAGMA table_info(grievances)").all() as Array<{ name: string }>;
		const hasPushed = cols.some(c => c.name === "pushed");
		const hasCreatedAt = cols.some(c => c.name === "created_at");
		const rows = legacy
			.prepare(
				`SELECT model, version, tool, report, ${hasPushed ? "pushed" : "0 AS pushed"}, ${hasCreatedAt ? "created_at" : "NULL AS created_at"} FROM grievances ORDER BY id ASC`,
			)
			.all() as Array<{
			model: string;
			version: string;
			tool: string;
			report: string;
			pushed: number;
			created_at: number | null;
		}>;
		const exists = target.prepare(
			"SELECT 1 FROM grievances WHERE model = ? AND version = ? AND tool = ? AND report = ? LIMIT 1",
		);
		const insert = target.prepare(
			"INSERT INTO grievances (model, version, tool, report, pushed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		);
		const copy = target.transaction((items: typeof rows) => {
			for (const row of items) {
				if (exists.get(row.model, row.version, row.tool, row.report)) continue;
				insert.run(row.model, row.version, row.tool, row.report, row.pushed ? 1 : 0, row.created_at);
			}
		});
		copy(rows);
	} catch (error) {
		logger.debug("legacy autoqa import failed", { error: String(error) });
	} finally {
		legacy?.close();
	}
}

let cachedDb: Database | null = null;
let legacyImportAttempted = false;

/** Test-only: close cached DB state. Never call from production code. */
export function __resetAutoQaDbForTests(): void {
	cachedDb?.close();
	cachedDb = null;
	legacyImportAttempted = false;
}

/**
 * Open (or return the cached handle for) the auto-QA SQLite database at
 * `~/.omp/agent/autoqa.db`. Idempotently runs schema creation, the
 * `pushed`-column migration, index setup, and best-effort import from the
 * accidental legacy `~/.lex/agent/autoqa.db` path. Returns `null` only on a
 * hard open failure (filesystem permissions, etc.); a missing file is created.
 *
 * Exported because the `lex grievances` CLI handlers need the migrated handle
 * too — having a second `openDb` in the CLI led to the column never being added
 * on the manual-push path.
 */
export function openAutoQaDb(): Database | null {
	if (cachedDb) return cachedDb;
	try {
		const dbPath = getAutoQaDbPath();
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		ensureGrievancesSchema(db);
		if (!legacyImportAttempted) {
			legacyImportAttempted = true;
			importLegacyAutoQaRows(db);
		}
		cachedDb = db;
		return db;
	} catch {
		return null;
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Backend push
// ───────────────────────────────────────────────────────────────────────────

export interface FlushResult {
	pushed: number;
	ok: boolean;
	skipped?: boolean;
}

/**
 * Optional per-flush controls. Used by `lex grievances push` to surface progress
 * to a TTY and to mark the operation as explicit user-driven publishing.
 */
export interface FlushOptions {
	/**
	 * Manual push marker. Endpoint configuration is still required; automatic
	 * tool-call paths never set this and therefore never publish.
	 */
	bypassConsent?: boolean;
	/**
	 * Fires once at the start of the loop with the snapshot count of
	 * unpushed rows. Subsequent inserts won't be reflected (the count is
	 * a planning hint for progress reporters, not a live total).
	 */
	onStart?: (totalUnpushed: number) => void;
	/**
	 * Fires after every successfully shipped batch with the running pushed
	 * count. Reporters compare against the `totalUnpushed` they saw in
	 * `onStart` to advance their bar.
	 */
	onProgress?: (pushedSoFar: number) => void;
}

interface PushConfig {
	endpoint: string;
	token: string | undefined;
}

const FLUSH_TIMEOUT_MS = 5_000;
const FAILURE_COOLDOWN_MS = 30_000;
/**
 * Per-request batch size. The worker loops until no unpushed rows remain,
 * shipping `FLUSH_BATCH_SIZE` rows per POST. Tunes the trade-off between
 * request count and request size — 50 keeps each payload well under the
 * default `maxBody` limit on the autoqa collector while letting a
 * realistic backlog (a few hundred legacy rows on first flush after the
 * consent grant) drain in single-digit requests.
 */
const FLUSH_BATCH_SIZE = 50;

let inFlightFlush: Promise<FlushResult> | null = null;
let lastFailureAt = 0;

/** Test-only: clear single-flight + cooldown state. Never call from production code. */
export function __resetAutoQaFlushStateForTests(): void {
	inFlightFlush = null;
	lastFailureAt = 0;
}

function envOverrideString(name: string): string | undefined {
	const value = $env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolvePushConfig(settings: Settings | undefined, bypassConsent: boolean): PushConfig | null {
	if (!bypassConsent) return null;

	const endpoint = envOverrideString("PI_AUTO_QA_PUSH_URL") ?? settings?.get("dev.autoqaPush.endpoint");
	if (!endpoint || endpoint.trim().length === 0) return null;

	const token = envOverrideString("PI_AUTO_QA_PUSH_TOKEN") ?? settings?.get("dev.autoqaPush.token");
	return { endpoint: endpoint.trim(), token: token && token.length > 0 ? token : undefined };
}

interface GrievanceRow {
	id: number;
	model: string;
	version: string;
	tool: string;
	report: string;
	created_at: number | null;
}

async function performFlush(db: Database, config: PushConfig, options: FlushOptions = {}): Promise<FlushResult> {
	const selectStmt = db.prepare(
		"SELECT id, model, version, tool, report, created_at FROM grievances WHERE pushed = 0 ORDER BY id ASC LIMIT ?",
	);
	// Planning snapshot — fires once so progress reporters can size their bar.
	// Mid-flight inserts are NOT folded in (the worker drains them too, but
	// the progress bar treats the initial backlog as the denominator).
	if (options.onStart) {
		const totalRow = db.prepare("SELECT COUNT(*) AS n FROM grievances WHERE pushed = 0").get() as { n: number };
		options.onStart(totalRow.n);
	}
	let totalPushed = 0;
	for (;;) {
		const rows = selectStmt.all(FLUSH_BATCH_SIZE) as GrievanceRow[];
		if (rows.length === 0) return { pushed: totalPushed, ok: true };

		const body = JSON.stringify({
			agent: { name: "omp", version: VERSION },
			installId: getInstallId(),
			// Coarse host fingerprint for triage — `darwin`/`linux`/`win32` +
			// `arm64`/`x64`. Useful for "is this bug arch-specific?" without
			// leaking the user's machine name (the old payload sent
			// `os.hostname()` verbatim, which trivially deanonymises users).
			platform: process.platform,
			arch: process.arch,
			entries: rows,
		});
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (config.token) headers.authorization = `Bearer ${config.token}`;

		let response: Response;
		try {
			response = await fetch(config.endpoint, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
			});
		} catch (error) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", {
				endpoint: config.endpoint,
				error: String(error),
				batchSize: rows.length,
				pushedSoFar: totalPushed,
			});
			return { pushed: totalPushed, ok: false };
		}

		if (!response.ok) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", {
				endpoint: config.endpoint,
				status: response.status,
				batchSize: rows.length,
				pushedSoFar: totalPushed,
			});
			return { pushed: totalPushed, ok: false };
		}

		// Mark just this batch — never touch ids the SELECT didn't return so a
		// concurrent insert that landed mid-flight isn't claimed-as-shipped on
		// our behalf. `id IN (?, ?, …)` rather than a range so a non-contiguous
		// batch (after partial fills, retries, etc.) still flips exactly what
		// we sent.
		const ids = rows.map(r => r.id);
		const placeholders = ids.map(() => "?").join(",");
		db.prepare(`UPDATE grievances SET pushed = 1 WHERE id IN (${placeholders})`).run(...ids);
		totalPushed += rows.length;
		options.onProgress?.(totalPushed);
		// Loop continues; the next SELECT picks up the next batch (or returns
		// empty, exiting the loop).
	}
}

/**
 * Flush queued grievances to the configured backend.
 *
 * Single-flight: concurrent callers share the in-flight promise. Non-manual
 * retries are skipped for {@link FAILURE_COOLDOWN_MS} ms after a failed push.
 * Never throws — all errors are caught and routed to the logger.
 */
export async function flushGrievances(
	db?: Database,
	settings?: Settings,
	options: FlushOptions = {},
): Promise<FlushResult> {
	const config = resolvePushConfig(settings, options.bypassConsent === true);
	if (!config) return { pushed: 0, ok: false, skipped: true };

	// Explicit manual pushes skip the cooldown window so a user is not stuck
	// after a transient failure. All pushes still share a single in-flight
	// worker to avoid duplicate POSTs from concurrent callers.
	const bypass = options.bypassConsent === true;
	if (inFlightFlush) return inFlightFlush;

	if (!bypass && lastFailureAt > 0 && Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
		return { pushed: 0, ok: false, skipped: true };
	}

	const handle = db ?? openAutoQaDb();
	if (!handle) return { pushed: 0, ok: false, skipped: true };

	const promise = (async () => {
		try {
			return await performFlush(handle, config, options);
		} catch (error) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", { endpoint: config.endpoint, error: String(error) });
			return { pushed: 0, ok: false };
		}
	})();

	inFlightFlush = promise;
	try {
		return await promise;
	} finally {
		inFlightFlush = null;
	}
}

export function createReportToolIssueTool(session: ToolSession, activeBuiltinNames: readonly string[] = []): AgentTool {
	const getModel = () => session.getActiveModelString?.() ?? "unknown";
	// Snapshotted at construction time. The model's enum is built from the same
	// snapshot; mid-session drift (extensions registering later, etc.) is caught
	// by the silent-drop guard below.
	const allowedToolNames = new Set(activeBuiltinNames);

	return {
		name: "report_tool_issue",
		label: "Report Tool Issue",
		strict: false,
		description: "Report unexpected tool behavior for automated QA tracking.",
		parameters: buildReportToolIssueParams(activeBuiltinNames),
		intent: "omit",
		async execute(_toolCallId, rawParams) {
			// Save is unconditional: the row lives in the user's own SQLite at
			// ~/.omp/agent/autoqa.db. Tool execution never asks for consent,
			// never opens UI, and never publishes to a remote service.
			try {
				const params = rawParams as { tool: string; report: string };
				// Some models emit `proxy_<name>` for tools routed through a
				// passthrough wrapper. Strip the prefix before allowlist check so
				// `proxy_read` lands as a report against `read`, not a silent drop.
				const canonicalTool = params.tool.startsWith("proxy_") ? params.tool.slice("proxy_".length) : params.tool;
				// Silently drop reports targeting tools that aren't shipped built-ins
				// (MCP servers, extensions that overrode a built-in name, typos).
				// Not the model's fault — no error, no DB row, just acknowledge.
				// Empty allowlist means the factory was called without a known active
				// set, so behave as before and record everything.
				if (allowedToolNames.size > 0 && !allowedToolNames.has(canonicalTool)) {
					return { content: [{ type: "text", text: "Noted, thanks!" }] };
				}
				const db = openAutoQaDb();
				if (db) {
					db.prepare(
						"INSERT INTO grievances (model, version, tool, report, created_at) VALUES (?, ?, ?, ?, ?)",
					).run(getModel(), VERSION, canonicalTool, params.report, Math.floor(Date.now() / 1000));
					// Local-only path: remote publishing is reserved for explicit
					// `lex grievances push` with an endpoint configured by the user.
				}
			} catch (error) {
				logger.error("Failed to record tool issue", { error });
			}
			return {
				content: [{ type: "text", text: "Noted, thanks!" }],
			};
		},
	};
}
