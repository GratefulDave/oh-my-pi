import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { aggregate, flush, recordHit } from "../src/stats";

interface TestCtx {
	sessionManager: {
		getSessionId: () => string;
		getCwd: () => string;
		getSessionName?: () => string;
	};
}

const originalHome = process.env.HOME;

afterEach(async () => {
	await flush();
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
});

async function tempDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function setHome(home: string): void {
	process.env.HOME = home;
}

function ctx(sessionId: string, project: string, label = sessionId): TestCtx {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => project,
			getSessionName: () => label,
		},
	};
}

async function readJson(filePath: string): Promise<{ sessions: Record<string, unknown> }> {
	return JSON.parse(await fs.readFile(filePath, "utf8")) as { sessions: Record<string, unknown> };
}

test("records multiple hits for one session and persists aggregate totals", async () => {
	const home = await tempDir("pi-distill-home-");
	const project = await tempDir("pi-distill-project-");
	setHome(home);
	const current = ctx("A", project, "alpha");

	recordHit(current, 100);
	recordHit(current, 220);
	await flush();

	const stats = aggregate(current);
	expect(stats.project).toEqual({ savedBytes: 320, hits: 2, estTokens: 80, sessions: 1 });
	expect(stats.global).toEqual({ savedBytes: 320, hits: 2, estTokens: 80, sessions: 1 });
	expect(stats.sessions.map(session => session.sessionId)).toEqual(["A"]);
	expect(await readJson(path.join(project, ".omp", "pi-distill-stats.json"))).toHaveProperty("sessions.A");
	expect(await readJson(path.join(home, ".omp", "agent", "pi-distill", "stats.json"))).toHaveProperty(
		"sessions.A",
	);
});

test("keeps project totals scoped while global totals span projects", async () => {
	const home = await tempDir("pi-distill-home-");
	const projectA = await tempDir("pi-distill-project-a-");
	const projectB = await tempDir("pi-distill-project-b-");
	setHome(home);
	const ctxA = ctx("A", projectA, "alpha");
	const ctxB = ctx("B", projectB, "beta");

	recordHit(ctxA, 400);
	recordHit(ctxB, 600);
	await flush();

	expect(aggregate(ctxA).project).toEqual({ savedBytes: 400, hits: 1, estTokens: 100, sessions: 1 });
	expect(aggregate(ctxB).project).toEqual({ savedBytes: 600, hits: 1, estTokens: 150, sessions: 1 });
	expect(aggregate(ctxA).global).toEqual({ savedBytes: 1000, hits: 2, estTokens: 250, sessions: 2 });
});

test("merges this session without clobbering pre-existing sessions", async () => {
	const home = await tempDir("pi-distill-home-");
	const project = await tempDir("pi-distill-project-");
	setHome(home);
	const projectStore = path.join(project, ".omp", "pi-distill-stats.json");
	const globalStore = path.join(home, ".omp", "agent", "pi-distill", "stats.json");
	const seeded = {
		sessions: {
			B: {
				sessionId: "B",
				project,
				label: "beta",
				savedBytes: 800,
				hits: 4,
				firstTs: 1,
				lastTs: 2,
			},
		},
	};
	await fs.mkdir(path.dirname(projectStore), { recursive: true });
	await fs.mkdir(path.dirname(globalStore), { recursive: true });
	await fs.writeFile(projectStore, `${JSON.stringify(seeded)}\n`, "utf8");
	await fs.writeFile(globalStore, `${JSON.stringify(seeded)}\n`, "utf8");

	recordHit(ctx("A", project, "alpha"), 200);
	await flush();

	const projectSessions = (await readJson(projectStore)).sessions;
	const globalSessions = (await readJson(globalStore)).sessions;
	expect(Object.keys(projectSessions).sort()).toEqual(["A", "B"]);
	expect(Object.keys(globalSessions).sort()).toEqual(["A", "B"]);
	expect(aggregate(ctx("A", project, "alpha")).project).toEqual({
		savedBytes: 1000,
		hits: 5,
		estTokens: 250,
		sessions: 2,
	});
});

test("computes estimated tokens and session counts from saved bytes", async () => {
	const home = await tempDir("pi-distill-home-");
	const project = await tempDir("pi-distill-project-");
	setHome(home);

	recordHit(ctx("A", project, "alpha"), 101);
	recordHit(ctx("B", project, "beta"), 102);
	await flush();

	const stats = aggregate(ctx("A", project, "alpha"));
	expect(stats.project.savedBytes).toBe(203);
	expect(stats.project.estTokens).toBe(51);
	expect(stats.project.sessions).toBe(2);
	expect(stats.global.hits).toBe(2);
});
