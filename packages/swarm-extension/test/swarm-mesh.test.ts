import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendSwarmEvent, readSwarmEvents } from "../src/swarm/events";
import { claimReservation, readReservations, releaseReservation } from "../src/swarm/reservations";
import { parseSwarmYaml } from "../src/swarm/schema";
import { StateTracker } from "../src/swarm/state";
import { projectSwarmTasks } from "../src/swarm/tasks";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("swarm event feed", () => {
	it("appends to the global feed and channel feed", async () => {
		const swarmDir = tempSwarmDir();
		const event = await appendSwarmEvent(swarmDir, {
			type: "message",
			swarm: "demo",
			channel: "memory",
			from: "tester",
			to: "worker",
			message: "remember this",
		});

		expect(event.id.length).toBeGreaterThan(0);
		expect((await readSwarmEvents(swarmDir)).map(e => e.message)).toEqual(["remember this"]);
		expect((await readSwarmEvents(swarmDir, { channel: "memory" })).map(e => e.to)).toEqual(["worker"]);
	});

	it("tails events without failing on missing logs", async () => {
		const swarmDir = tempSwarmDir();
		expect(await readSwarmEvents(swarmDir)).toEqual([]);
		for (let i = 0; i < 3; i++) {
			await appendSwarmEvent(swarmDir, {
				type: "pipeline.iteration",
				swarm: "demo",
				channel: "pipeline",
				iteration: i,
			});
		}
		expect((await readSwarmEvents(swarmDir, { limit: 2 })).map(e => e.iteration)).toEqual([1, 2]);
	});
});

describe("swarm task projection", () => {
	it("maps DAG agent state to task records with dependency metadata", async () => {
		const workspace = tempDir();
		const def = parseSwarmYaml(`
swarm:
  name: demo
  workspace: .
  mode: parallel
  agents:
    writer:
      role: Writer
      task: Draft the note
    reviewer:
      role: Reviewer
      task: Review the note
      waits_for: [writer]
`);
		const tracker = new StateTracker(workspace, def.name);
		await tracker.init([...def.agents.keys()], def.targetCount, def.mode);
		await tracker.saveDefinition(def);
		await tracker.updateAgent("writer", { status: "completed", iteration: 0, wave: 0 });
		await tracker.updateAgent("reviewer", { status: "waiting", iteration: 0, wave: 1 });

		const tasks = projectSwarmTasks(tracker.state, await tracker.loadDefinition());
		expect(tasks).toMatchObject([
			{ name: "writer", status: "completed", role: "Writer", waitsFor: [] },
			{ name: "reviewer", status: "waiting", role: "Reviewer", waitsFor: ["writer"] },
		]);
	});
});

describe("swarm reservations", () => {
	it("claims, rejects conflicting holders, and releases resources", async () => {
		const swarmDir = tempSwarmDir();
		const first = await claimReservation(swarmDir, "src/file.ts", "agent-a", "editing");
		expect(first.ok).toBe(true);
		expect((await readReservations(swarmDir))["src/file.ts"]?.holder).toBe("agent-a");

		const conflict = await claimReservation(swarmDir, "src/file.ts", "agent-b", "also editing");
		expect(conflict.ok).toBe(false);
		expect(conflict.conflict?.holder).toBe("agent-a");

		expect((await releaseReservation(swarmDir, "src/file.ts"))?.holder).toBe("agent-a");
		expect(await readReservations(swarmDir)).toEqual({});
	});
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-swarm-test-"));
	tempDirs.push(dir);
	return dir;
}

function tempSwarmDir(): string {
	return path.join(tempDir(), ".swarm_demo");
}
