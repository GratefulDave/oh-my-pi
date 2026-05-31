import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	__resetAutoQaDbForTests,
	__resetAutoQaFlushStateForTests,
	createReportToolIssueTool,
	flushGrievances,
	getAutoQaDbPath,
	openAutoQaDb,
} from "@oh-my-pi/pi-coding-agent/tools/report-tool-issue";
import * as piUtils from "@oh-my-pi/pi-utils";
import { hookFetch } from "@oh-my-pi/pi-utils";

function openTempDb(): Database {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE IF NOT EXISTS grievances (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			model TEXT NOT NULL,
			version TEXT NOT NULL,
			tool TEXT NOT NULL,
			report TEXT NOT NULL,
			pushed INTEGER NOT NULL DEFAULT 0
		);
	`);
	return db;
}

function insertGrievance(db: Database, tool: string, report: string): number {
	const info = db
		.prepare("INSERT INTO grievances (model, version, tool, report) VALUES (?, ?, ?, ?)")
		.run("test-model", "test-version", tool, report);
	return Number(info.lastInsertRowid);
}

/** All rows, regardless of pushed state. */
function selectIds(db: Database): number[] {
	return (db.prepare("SELECT id FROM grievances ORDER BY id ASC").all() as Array<{ id: number }>).map(r => r.id);
}

/** Just unpushed rows — what the next flush would pick up. */
function selectUnpushedIds(db: Database): number[] {
	return (db.prepare("SELECT id FROM grievances WHERE pushed = 0 ORDER BY id ASC").all() as Array<{ id: number }>).map(
		r => r.id,
	);
}

/** Just pushed rows — what's already been shipped. */
function selectPushedIds(db: Database): number[] {
	return (db.prepare("SELECT id FROM grievances WHERE pushed = 1 ORDER BY id ASC").all() as Array<{ id: number }>).map(
		r => r.id,
	);
}

function pushSettings(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({
		"dev.autoqa": true,
		"dev.autoqaPush.endpoint": "https://qa.example.com/grievances",
		...overrides,
	});
}

function manualPush(): { bypassConsent: true } {
	return { bypassConsent: true };
}

function makeSession(settings: Settings): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getActiveModelString: () => "test-model",
	} as ToolSession;
}

describe("flushGrievances", () => {
	let db: Database;

	beforeEach(() => {
		__resetAutoQaFlushStateForTests();
		vi.spyOn(piUtils, "getInstallId").mockReturnValue("11111111-2222-3333-4444-555555555555");
		db = openTempDb();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		__resetAutoQaFlushStateForTests();
		db.close();
	});

	it("skips network without explicit manual push and leaves rows intact", async () => {
		insertGrievance(db, "find", "weird ordering");
		const fetchSpy = vi.fn(() => new Response("unexpected", { status: 200 }));
		using _hook = hookFetch(fetchSpy);

		const result = await flushGrievances(db, pushSettings());

		expect(result).toEqual({ pushed: 0, ok: false, skipped: true });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(selectIds(db)).toEqual([1]);
	});

	it("skips network when endpoint is missing", async () => {
		insertGrievance(db, "find", "weird ordering");
		const fetchSpy = vi.fn(() => new Response("unexpected", { status: 200 }));
		using _hook = hookFetch(fetchSpy);

		const result = await flushGrievances(db, pushSettings({ "dev.autoqaPush.endpoint": "" }), manualPush());

		expect(result).toEqual({ pushed: 0, ok: false, skipped: true });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(selectIds(db)).toEqual([1]);
	});

	it("returns ok without fetching when there is nothing to push", async () => {
		const fetchSpy = vi.fn(() => new Response("unexpected", { status: 200 }));
		using _hook = hookFetch(fetchSpy);

		const result = await flushGrievances(db, pushSettings(), manualPush());

		expect(result).toEqual({ pushed: 0, ok: true });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("posts pending rows with bearer header and marks them pushed=1 on 200", async () => {
		insertGrievance(db, "find", "weird ordering");
		insertGrievance(db, "read", "selector ignored");

		let capturedInput: string | URL | Request | undefined;
		let capturedInit: RequestInit | undefined;
		const fetchSpy = vi.fn((input: string | URL | Request, init: RequestInit | undefined) => {
			capturedInput = input;
			capturedInit = init;
			return new Response("", { status: 200 });
		});
		using _hook = hookFetch(fetchSpy);

		const result = await flushGrievances(db, pushSettings({ "dev.autoqaPush.token": "secret-token" }), manualPush());

		expect(result).toEqual({ pushed: 2, ok: true });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(capturedInput)).toBe("https://qa.example.com/grievances");
		expect(capturedInit?.method).toBe("POST");

		const headers = capturedInit?.headers as Record<string, string> | undefined;
		expect(headers?.["content-type"]).toBe("application/json");
		expect(headers?.authorization).toBe("Bearer secret-token");

		const body = JSON.parse(String(capturedInit?.body));
		expect(body.agent?.name).toBe("omp");
		expect(typeof body.agent?.version).toBe("string");
		expect(body.host).toBeUndefined();
		expect(typeof body.platform).toBe("string");
		expect(typeof body.arch).toBe("string");
		expect(body.installId).toBe("11111111-2222-3333-4444-555555555555");
		expect(body.entries).toEqual([
			{ id: 1, model: "test-model", version: "test-version", tool: "find", report: "weird ordering" },
			{ id: 2, model: "test-model", version: "test-version", tool: "read", report: "selector ignored" },
		]);

		// Rows are retained for inspection — `pushed=1` flips, but the data
		// stays so users can browse what they've shipped via `omp grievances`.
		expect(selectIds(db)).toEqual([1, 2]);
		expect(selectPushedIds(db)).toEqual([1, 2]);
		expect(selectUnpushedIds(db)).toEqual([]);
	});

	it("omits the Authorization header when no token is configured", async () => {
		insertGrievance(db, "find", "no token here");
		let capturedInit: RequestInit | undefined;
		const fetchSpy = vi.fn((_input: string | URL | Request, init: RequestInit | undefined) => {
			capturedInit = init;
			return new Response("", { status: 204 });
		});
		using _hook = hookFetch(fetchSpy);

		const result = await flushGrievances(db, pushSettings(), manualPush());

		expect(result).toEqual({ pushed: 1, ok: true });
		const headers = capturedInit?.headers as Record<string, string> | undefined;
		expect(headers?.authorization).toBeUndefined();
		expect(selectUnpushedIds(db)).toEqual([]);
		expect(selectPushedIds(db)).toEqual([1]);
	});

	it("leaves rows unpushed on 5xx and reports failure", async () => {
		insertGrievance(db, "find", "boom");
		const fetchSpy = vi.fn(() => new Response("nope", { status: 500 }));
		using _hook = hookFetch(fetchSpy);

		const result = await flushGrievances(db, pushSettings(), manualPush());

		expect(result).toEqual({ pushed: 0, ok: false });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(selectUnpushedIds(db)).toEqual([1]);
		expect(selectPushedIds(db)).toEqual([]);
	});

	it("drains mid-flight inserts in a follow-up batch within the same loop", async () => {
		insertGrievance(db, "find", "first");

		const fetchEntered = Promise.withResolvers<void>();
		const releaseFirstFetch = Promise.withResolvers<Response>();
		let fetchCount = 0;
		const fetchSpy = vi.fn(() => {
			fetchCount += 1;
			if (fetchCount === 1) {
				fetchEntered.resolve();
				return releaseFirstFetch.promise;
			}
			// Subsequent loop iterations resolve immediately so the worker
			// finishes draining without manual coordination per batch.
			return Promise.resolve(new Response("", { status: 200 }));
		});
		using _hook = hookFetch(fetchSpy);

		const flushPromise = flushGrievances(db, pushSettings(), manualPush());
		await fetchEntered.promise;

		// New grievance written by a concurrent tool call while the push is in flight.
		insertGrievance(db, "read", "second");

		releaseFirstFetch.resolve(new Response("", { status: 200 }));
		const result = await flushPromise;

		// Both rows shipped — the worker looped, the second batch picked up
		// the row that landed mid-flight.
		expect(result).toEqual({ pushed: 2, ok: true });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(selectUnpushedIds(db)).toEqual([]);
		expect(selectPushedIds(db)).toEqual([1, 2]);
	});

	it("collapses concurrent callers onto a single in-flight push", async () => {
		insertGrievance(db, "find", "single-flight");

		const releaseFetch = Promise.withResolvers<Response>();
		const fetchSpy = vi.fn(() => releaseFetch.promise);
		using _hook = hookFetch(fetchSpy);

		const settings = pushSettings();
		const first = flushGrievances(db, settings, manualPush());
		const second = flushGrievances(db, settings, manualPush());

		releaseFetch.resolve(new Response("", { status: 200 }));
		const [a, b] = await Promise.all([first, second]);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(a).toEqual({ pushed: 1, ok: true });
		expect(b).toBe(a);
		expect(selectUnpushedIds(db)).toEqual([]);
		expect(selectPushedIds(db)).toEqual([1]);
	});

	it("does not cooldown explicit manual retry after a failure", async () => {
		insertGrievance(db, "find", "first");
		const fetchSpy = vi.fn(() => new Response("nope", { status: 500 }));
		using _hook = hookFetch(fetchSpy);

		const settings = pushSettings();
		const firstResult = await flushGrievances(db, settings, manualPush());
		const secondResult = await flushGrievances(db, settings, manualPush());

		expect(firstResult).toEqual({ pushed: 0, ok: false });
		expect(secondResult).toEqual({ pushed: 0, ok: false });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(selectUnpushedIds(db)).toEqual([1]);
	});

	it("drains a backlog larger than the batch size in multiple POSTs", async () => {
		// Seed >1 batch worth (FLUSH_BATCH_SIZE = 50) so the worker has to loop.
		// 127 chosen to land on a non-multiple boundary (2 full batches + a
		// partial final one), exercising both the LIMIT semantics and the
		// "remainder smaller than batch" tail.
		const total = 127;
		for (let i = 0; i < total; i++) insertGrievance(db, "find", `report-${i}`);

		const seenBatchSizes: number[] = [];
		const fetchSpy = vi.fn((_input: string | URL | Request, init: RequestInit | undefined) => {
			const body = JSON.parse(String(init?.body)) as { entries: unknown[] };
			seenBatchSizes.push(body.entries.length);
			return new Response("", { status: 200 });
		});
		using _hook = hookFetch(fetchSpy);

		const result = await flushGrievances(db, pushSettings(), manualPush());

		expect(result).toEqual({ pushed: total, ok: true });
		// Three batches: 50 + 50 + 27.
		expect(seenBatchSizes).toEqual([50, 50, 27]);
		expect(fetchSpy).toHaveBeenCalledTimes(3);
		expect(selectUnpushedIds(db)).toEqual([]);
		expect(selectPushedIds(db).length).toBe(total);
	});

	it("stops the loop on a mid-batch failure and preserves unpushed rows", async () => {
		// Two batches' worth — first batch ships, second batch errors. The
		// pushed-so-far count surfaces in the result and only the unsent
		// rows stay flagged unpushed.
		const firstBatch = 50;
		const secondBatch = 10;
		for (let i = 0; i < firstBatch + secondBatch; i++) insertGrievance(db, "find", `r-${i}`);

		let call = 0;
		const fetchSpy = vi.fn(() => {
			call += 1;
			return new Response("", { status: call === 1 ? 200 : 500 });
		});
		using _hook = hookFetch(fetchSpy);

		const result = await flushGrievances(db, pushSettings(), manualPush());

		expect(result).toEqual({ pushed: firstBatch, ok: false });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(selectPushedIds(db).length).toBe(firstBatch);
		expect(selectUnpushedIds(db).length).toBe(secondBatch);
	});
});

describe("report_tool_issue local storage", () => {
	let homeDir = "";

	beforeEach(async () => {
		__resetAutoQaDbForTests();
		homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-autoqa-home-"));
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
	});

	afterEach(async () => {
		__resetAutoQaDbForTests();
		vi.restoreAllMocks();
		await fs.rm(homeDir, { recursive: true, force: true });
	});

	it("targets the OMP namespace, not the Lex namespace", () => {
		expect(getAutoQaDbPath()).toBe(path.join(homeDir, ".omp", "agent", "autoqa.db"));
	});

	it("imports rows once from the accidental legacy Lex database without deleting it", async () => {
		const legacyDir = path.join(homeDir, ".lex", "agent");
		await fs.mkdir(legacyDir, { recursive: true });
		const legacyPath = path.join(legacyDir, "autoqa.db");
		const legacy = new Database(legacyPath);
		legacy.run(`
			CREATE TABLE grievances (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				model TEXT NOT NULL,
				version TEXT NOT NULL,
				tool TEXT NOT NULL,
				report TEXT NOT NULL,
				pushed INTEGER NOT NULL DEFAULT 0
			);
		`);
		legacy
			.prepare("INSERT INTO grievances (model, version, tool, report, pushed) VALUES (?, ?, ?, ?, ?)")
			.run("model-a", "version-a", "read", "legacy report", 1);
		legacy.close();

		const db = openAutoQaDb();
		expect(db).not.toBeNull();
		const rows = db
			?.prepare("SELECT model, version, tool, report, pushed FROM grievances ORDER BY id ASC")
			.all() as Array<{ model: string; version: string; tool: string; report: string; pushed: number }>;

		expect(rows).toEqual([
			{ model: "model-a", version: "version-a", tool: "read", report: "legacy report", pushed: 1 },
		]);
		expect(await Bun.file(legacyPath).exists()).toBe(true);

		__resetAutoQaDbForTests();
		const reopened = openAutoQaDb();
		const count = reopened?.prepare("SELECT COUNT(*) AS n FROM grievances").get() as { n: number };
		expect(count.n).toBe(1);
	});

	it("records a local row and never fetches even with old auto-QA consent settings enabled", async () => {
		const fetchSpy = vi.fn(() => new Response("unexpected", { status: 200 }));
		using _hook = hookFetch(fetchSpy);
		const settings = Settings.isolated({
			"dev.autoqa": true,
			"dev.autoqa.consent": "granted",
			"dev.autoqaPush.endpoint": "https://qa.example.com/grievances",
		} as Parameters<typeof Settings.isolated>[0]);
		const tool = createReportToolIssueTool(makeSession(settings), ["read"]);

		await tool.execute("call-1", { tool: "read", report: "local report" });

		expect(fetchSpy).not.toHaveBeenCalled();
		const db = openAutoQaDb();
		const row = db?.prepare("SELECT model, tool, report, pushed FROM grievances").get() as {
			model: string;
			tool: string;
			report: string;
			pushed: number;
		};
		expect(row).toEqual({ model: "test-model", tool: "read", report: "local report", pushed: 0 });
	});
});
