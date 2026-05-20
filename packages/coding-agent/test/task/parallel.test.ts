import { describe, expect, it } from "bun:test";
import { mapWithConcurrencyLimit, Semaphore } from "../../src/task/parallel";

describe("mapWithConcurrencyLimit", () => {
	it("treats zero concurrency as unlimited", async () => {
		const items = [1, 2, 3, 4];
		const gate = Promise.withResolvers<void>();
		const allStarted = Promise.withResolvers<void>();
		let active = 0;
		let maxActive = 0;
		let started = 0;

		const resultPromise = mapWithConcurrencyLimit(items, 0, async item => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			started += 1;
			if (started === items.length) allStarted.resolve();
			await gate.promise;
			active -= 1;
			return item * 2;
		});

		await allStarted.promise;
		expect(maxActive).toBe(items.length);
		gate.resolve();

		const result = await resultPromise;
		expect(result).toEqual({ results: [2, 4, 6, 8], aborted: false });
	});
});

describe("Semaphore", () => {
	it("treats zero permits as unlimited", async () => {
		const semaphore = new Semaphore(0);
		const gate = Promise.withResolvers<void>();
		const allStarted = Promise.withResolvers<void>();
		const items = [1, 2, 3, 4];
		let active = 0;
		let maxActive = 0;
		let started = 0;

		const tasks = items.map(async () => {
			await semaphore.acquire();
			active += 1;
			maxActive = Math.max(maxActive, active);
			started += 1;
			if (started === items.length) allStarted.resolve();
			try {
				await gate.promise;
			} finally {
				active -= 1;
				semaphore.release();
			}
		});

		await allStarted.promise;
		expect(maxActive).toBe(items.length);
		gate.resolve();
		await Promise.all(tasks);
	});

	it("limits positive permit counts", async () => {
		const semaphore = new Semaphore(2);
		const gate = Promise.withResolvers<void>();
		const items = [1, 2, 3, 4];
		let active = 0;
		let maxActive = 0;

		const tasks = items.map(async () => {
			await semaphore.acquire();
			active += 1;
			maxActive = Math.max(maxActive, active);
			try {
				await gate.promise;
			} finally {
				active -= 1;
				semaphore.release();
			}
		});

		await Bun.sleep(10);
		expect(maxActive).toBe(2);
		gate.resolve();
		await Promise.all(tasks);
	});
});
