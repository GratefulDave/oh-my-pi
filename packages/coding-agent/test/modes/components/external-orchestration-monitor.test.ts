import { describe, expect, it } from "bun:test";
import type { ExternalAgentRequest } from "../../../src/external-agents/types";
import { ExternalOrchestrationMonitorComponent } from "../../../src/modes/components/external-orchestration-monitor";
import type { Theme, ThemeColor } from "../../../src/modes/theme/theme";

// ============================================================================
// Helpers
// ============================================================================

function fakeTheme(): Theme {
	return {
		fg(_color: ThemeColor, text: string): string {
			return text;
		},
		bold(text: string): string {
			return text;
		},
	} as unknown as Theme;
}

function makeRequest(provider: "claude" | "codex"): ExternalAgentRequest {
	return { provider, prompt: "test prompt", cwd: "/tmp" };
}

interface MonitorOpts {
	rows?: number;
	onClose?: () => void;
}

function makeMonitor(opts: MonitorOpts = {}): ExternalOrchestrationMonitorComponent {
	return new ExternalOrchestrationMonitorComponent(
		fakeTheme(),
		"acpx",
		["claude", "codex"],
		() => opts.rows ?? 24,
		() => {},
		opts.onClose,
	);
}

function renderLines(m: ExternalOrchestrationMonitorComponent, width = 80): string[] {
	return m.render(width);
}

function renderText(m: ExternalOrchestrationMonitorComponent, width = 80): string {
	return m.render(width).join("\n");
}

// ============================================================================
// Tests
// ============================================================================

describe("ExternalOrchestrationMonitorComponent", () => {
	describe("initial render", () => {
		it("shows backend and agents header with running status", () => {
			const m = makeMonitor();
			const lines = renderLines(m, 80);

			// Header line must exist and contain key labels
			const header = lines[0];
			expect(header).toContain("delegate");
			expect(header).toContain("acpx");
			expect(header).toContain("Claude");
			expect(header).toContain("Codex");
			expect(header).toContain("running");
		});

		it("shows provider group headers with no-events placeholders", () => {
			const m = makeMonitor();
			const lines = renderLines(m, 80);

			expect(lines).toContain("── Claude ──");
			expect(lines).toContain("── Codex ──");
			expect(lines).toContain("  (no events yet)");
		});
	});

	describe("event appending", () => {
		it("renders status event as labeled line", () => {
			const m = makeMonitor();
			m.append({ type: "status", message: "connecting..." }, 0, makeRequest("claude"));

			const text = renderText(m);
			expect(text).toContain("●");
			expect(text).toContain("connecting...");
		});

		it("renders text event as plain output", () => {
			const m = makeMonitor();
			m.append({ type: "text", text: "building project" }, 0, makeRequest("claude"));

			const text = renderText(m);
			expect(text).toContain("building project");
		});

		it("renders error event as labeled line", () => {
			const m = makeMonitor();
			m.append({ type: "error", message: "timeout" }, 0, makeRequest("claude"));

			const text = renderText(m);
			expect(text).toContain("✗");
			expect(text).toContain("timeout");
		});

		it("renders tool_start event with tool name", () => {
			const m = makeMonitor();
			m.append({ type: "tool_start", name: "read_file", value: {} }, 0, makeRequest("claude"));

			const text = renderText(m);
			expect(text).toContain("▶");
			expect(text).toContain("read_file");
		});

		it("renders tool_end event with tool name", () => {
			const m = makeMonitor();
			m.append({ type: "tool_end", name: "write_file", value: {} }, 0, makeRequest("codex"));

			const text = renderText(m);
			expect(text).toContain("◀");
			expect(text).toContain("write_file");
		});

		it("renders terminal event with command", () => {
			const m = makeMonitor();
			m.append({ type: "terminal", command: ["bun", "test"], message: "" }, 0, makeRequest("claude"));

			const text = renderText(m);
			expect(text).toContain("▸");
			expect(text).toContain("bun test");
		});

		it("renders json event as placeholder", () => {
			const m = makeMonitor();
			m.append({ type: "json", value: { foo: "bar" } }, 0, makeRequest("codex"));

			const text = renderText(m);
			expect(text).toContain("{json}");
		});

		it("routes events to correct provider group", () => {
			const m = makeMonitor();
			m.append({ type: "status", message: "claude event" }, 0, makeRequest("claude"));
			m.append({ type: "status", message: "codex event" }, 0, makeRequest("codex"));

			const text = renderText(m);
			const claudeIdx = text.indexOf("── Claude ──");
			const codexIdx = text.indexOf("── Codex ──");
			const claudeEvent = text.indexOf("claude event");
			const codexEvent = text.indexOf("codex event");

			expect(claudeIdx).toBeLessThan(codexIdx);
			expect(claudeEvent).toBeGreaterThan(claudeIdx);
			expect(claudeEvent).toBeLessThan(codexIdx);
			expect(codexEvent).toBeGreaterThan(codexIdx);
		});
	});

	describe("sanitization", () => {
		it("replaces tab characters in status messages", () => {
			const m = makeMonitor();
			m.append({ type: "status", message: "msg\twith\ttabs" }, 0, makeRequest("claude"));

			const lines = renderLines(m);
			for (const line of lines) {
				expect(line).not.toContain("\t");
			}
			// The message content must still appear (tabs replaced with spaces)
			const text = lines.join("\n");
			expect(text).toContain("msg");
			expect(text).toContain("with");
			expect(text).toContain("tabs");
		});

		it("replaces tab characters in text events", () => {
			const m = makeMonitor();
			m.append({ type: "text", text: "col1\tcol2\tcol3" }, 0, makeRequest("claude"));

			const lines = renderLines(m);
			for (const line of lines) {
				expect(line).not.toContain("\t");
			}
			const text = lines.join("\n");
			expect(text).toContain("col1");
			expect(text).toContain("col2");
			expect(text).toContain("col3");
		});

		it("truncates long lines to render width", () => {
			const m = makeMonitor();
			const veryLong = "x".repeat(200);
			m.append({ type: "status", message: veryLong }, 0, makeRequest("claude"));

			const lines = renderLines(m, 40);
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(40);
			}
		});

		it("replaces tab characters in terminal commands", () => {
			const m = makeMonitor();
			m.append({ type: "terminal", command: ["run", "\t"], message: "" }, 0, makeRequest("claude"));

			const lines = renderLines(m);
			for (const line of lines) {
				expect(line).not.toContain("\t");
			}
		});
	});

	describe("completion", () => {
		it("shows success count and artifact id in footer", () => {
			const m = makeMonitor();
			m.complete(2, "artifact-abc-123");

			const lines = renderLines(m, 80);
			const footer = lines[lines.length - 2]; // second-to-last line before padding

			expect(footer).toContain("2/2 succeeded");
			expect(footer).toContain("artifact: artifact-abc-123");
			expect(footer).toContain("Esc/q to close");
		});

		it("shows partial success count when not all agents succeed", () => {
			const m = makeMonitor();
			m.complete(1, undefined);

			const text = renderText(m, 80);
			expect(text).toContain("1/2 succeeded");
			expect(text).not.toContain("artifact:");
		});

		it("replaces running with done in header", () => {
			const m = makeMonitor();
			m.complete(2);

			const text = renderText(m, 80);
			expect(text).toContain("done");
			expect(text).not.toContain("running");
		});

		it("q invokes close callback after completion", () => {
			let closed = false;
			const m = makeMonitor({ onClose: () => (closed = true) });
			m.complete(2);
			m.handleInput("q");

			expect(closed).toBe(true);
		});

		it("Q invokes close callback after completion", () => {
			let closed = false;
			const m = makeMonitor({ onClose: () => (closed = true) });
			m.complete(2);
			m.handleInput("Q");

			expect(closed).toBe(true);
		});

		it("q does nothing when not complete", () => {
			let closed = false;
			const m = makeMonitor({ onClose: () => (closed = true) });
			m.handleInput("q");

			expect(closed).toBe(false);
		});
	});

	describe("scrolling", () => {
		it("scrolling down changes visible content when overflowing", () => {
			const m = makeMonitor({ rows: 6 }); // header(1) + 5 available lines

			// Add events from a single provider to simplify (fewer provider header lines)
			for (let i = 0; i < 20; i++) {
				m.append({ type: "status", message: `event-${i}` }, 0, makeRequest("claude"));
			}

			m.handleInput("home");
			const before = renderLines(m, 80);

			// Scroll down from top now changes visible content
			m.handleInput("j");
			const after = renderLines(m, 80);

			// Content must have shifted — first visible line changed
			expect(before[1]).not.toEqual(after[1]);
		});

		it("scrolling up decreases visible offset", () => {
			const m = makeMonitor({ rows: 6 });

			for (let i = 0; i < 20; i++) {
				m.append({ type: "status", message: `event-${i}` }, 0, makeRequest("claude"));
			}

			m.handleInput("home");
			const atTop = renderLines(m, 80);
			// Scroll down from top to create room for back-scroll
			m.handleInput("j");
			m.handleInput("j");
			const scrolled = renderLines(m, 80);

			// Scroll back up from a non-top offset
			m.handleInput("k");
			const backed = renderLines(m, 80);

			expect(atTop.some(line => line.includes("event-0"))).toBe(true);
			expect(scrolled.some(line => line.includes("event-2"))).toBe(true);
			expect(backed.some(line => line.includes("event-1"))).toBe(true);
		});

		it("offset does not go negative when scrolling past top", () => {
			const m = makeMonitor({ rows: 10 });

			for (let i = 0; i < 20; i++) {
				m.append({ type: "status", message: `event-${i}` }, 0, makeRequest("claude"));
			}

			// Scroll up many times
			for (let i = 0; i < 50; i++) {
				m.handleInput("k");
			}

			// Should not throw, and content should be at top
			const lines = renderLines(m, 80);
			expect(lines.some(line => line.includes("event-0"))).toBe(true);
		});

		it("renders consistently when no events present", () => {
			const m = makeMonitor({ rows: 6 });
			m.handleInput("j");
			m.handleInput("k");

			const lines = renderLines(m, 80);
			// Just verifying it doesn't throw and produces output
			expect(lines.length).toBeGreaterThan(0);
			expect(lines[0]).toContain("delegate");
		});
	});
});
