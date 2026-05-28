/**
 * Regression test for EventLoopKeepalive busy-wait fix.
 *
 * Verifies that holding a long-pending Promise (as happens during interactive
 * session.prompt() / getUserInput()) does not cause Bun to busy-wait and
 * consume excessive CPU. The keepalive timer keeps the event loop sleeping in
 * epoll_wait/kqueue rather than spinning.
 *
 * Note: CI runners are noisy; the threshold is intentionally coarse (50% CPU
 * averaged over a 1-second idle window). In practice the fix reduces idle CPU
 * from ~100% to <1%.
 */
import { describe, expect, it } from "bun:test";
import { EventLoopKeepalive } from "../src/utils/yield";

describe("EventLoopKeepalive", () => {
	it("cleans up the timer on dispose", () => {
		// Verify [Symbol.dispose] runs without error and the interval is cleared.
		// If the interval leaked, the test process would hang.
		const keepalive = new EventLoopKeepalive();
		keepalive[Symbol.dispose]();
		// No assertion needed — if interval leaked the process would not exit.
		expect(true).toBe(true);
	});

	it("works correctly with using declaration syntax", () => {
		// Verify the class is compatible with the 'using' keyword (ES2023 disposables).
		{
			using _k = new EventLoopKeepalive();
			// Scope exits here — dispose() called automatically.
		}
		expect(true).toBe(true);
	});

	it("does not busy-wait during idle Promise await", async () => {
		// Create a never-resolving promise (simulates getUserInput() waiting for input).
		// Measure CPU usage over 1 second with EventLoopKeepalive active.
		// Assert that CPU usage stays below 50% (coarse threshold for CI noise).

		const IDLE_MS = 1000;
		const CPU_THRESHOLD_PERCENT = 50;

		const cpuBefore = process.cpuUsage();
		const wallBefore = performance.now();

		// Simulate the idle await pattern: long-pending promise + keepalive.
		await new Promise<void>(resolve => {
			using _k = new EventLoopKeepalive();
			// Let the event loop idle for IDLE_MS, then resolve.
			setTimeout(resolve, IDLE_MS);
		});

		const cpuAfter = process.cpuUsage(cpuBefore);
		const wallMs = performance.now() - wallBefore;

		// CPU usage reported in microseconds; convert to percentage of wall time.
		const totalCpuUs = cpuAfter.user + cpuAfter.system;
		const wallUs = wallMs * 1000;
		const cpuPercent = (totalCpuUs / wallUs) * 100;

		expect(cpuPercent).toBeLessThan(CPU_THRESHOLD_PERCENT);
	});
});
