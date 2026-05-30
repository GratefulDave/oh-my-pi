/**
 * Regression: observer overlay must not render SILENT_ABORT_MARKER verbatim.
 *
 * Codex review flagged that `session-observer-overlay.ts` renders `errorMessage`
 * without filtering the silent-abort sentinel. This test exercises the full
 * `#buildTranscriptLines` path through a real JSONL session file and mock registry.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionObserverOverlayComponent } from "../src/modes/components/session-observer-overlay";
import type { ObservableSession, SessionObserverRegistry } from "../src/modes/session-observer-registry";
import { initTheme } from "../src/modes/theme/theme";
import { SILENT_ABORT_MARKER } from "../src/session/messages";

const SESSION_ID = "test-session-1";

function makeJsonlSessionFile(dirPath: string, entries: object[]): string {
	const filePath = path.join(dirPath, "session.jsonl");
	const lines = entries.map(e => JSON.stringify(e));
	fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
	return filePath;
}

function makeSubagentRegistry(sessions: ObservableSession[]): SessionObserverRegistry {
	return {
		getSessions: () => sessions,
		onChange: () => () => {},
		setMainSession: () => {},
		getActiveSubagentCount: () => sessions.filter(s => s.status === "active").length,
		getObserverRows: () => {
			const subagents = sessions.filter(s => s.kind !== "main");
			const active = subagents.filter(s => s.status === "active").sort((a, b) => b.lastUpdate - a.lastUpdate);
			const inactive = subagents.filter(s => s.status !== "active").sort((a, b) => b.lastUpdate - a.lastUpdate);
			return [...active, ...inactive].map(s => ({
				id: s.id,
				agent: s.agent ?? s.runMetadata?.agent ?? s.source?.jobType ?? "agent",
				task: s.description ?? s.progress?.description ?? s.asyncJob?.label ?? s.label,
				status: (s.asyncJob?.status === "cancelled"
					? "cancelled"
					: s.status === "active"
						? "running"
						: s.status === "aborted"
							? "cancelled"
							: s.status) as "running" | "queued" | "completed" | "failed" | "cancelled",
				message: s.progress?.lastIntent ?? (s.status === "active" ? "thinking…" : ""),
				session: s,
			}));
		},
	} as unknown as SessionObserverRegistry;
}

describe("Observer overlay silent-abort regression", () => {
	let tmpDir: string;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-overlay-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("does not render ✗ Error: for silent-abort assistant messages with empty content", () => {
		const sessionFile = makeJsonlSessionFile(tmpDir, [
			{ type: "session", version: 3, id: SESSION_ID, timestamp: new Date().toISOString() },
			{
				type: "message",
				id: "msg-user-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "msg-assistant-1",
				parentId: "msg-user-1",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "aborted",
					errorMessage: SILENT_ABORT_MARKER,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			},
		]);

		const registry = makeSubagentRegistry([
			{
				id: SESSION_ID,
				kind: "subagent",
				label: "Test Subagent",
				status: "active",
				sessionFile,
				lastUpdate: Date.now(),
			},
		]);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, ["ctrl+s"]);

		// Render with a reasonable width — the overlay reads the session file
		// and calls #buildTranscriptLines internally.
		const rendered = overlay.render(120);
		const renderedText = rendered.join("\n");

		// The sentinel MUST NOT appear verbatim in any rendered line
		expect(renderedText).not.toContain(SILENT_ABORT_MARKER);
		// The error prefix MUST NOT appear for a silent-abort message
		expect(renderedText).not.toContain("✗ Error:");
	});

	it("renders normal error messages with ✗ Error: prefix", () => {
		const sessionFile = makeJsonlSessionFile(tmpDir, [
			{ type: "session", version: 3, id: SESSION_ID, timestamp: new Date().toISOString() },
			{
				type: "message",
				id: "msg-user-2",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "msg-assistant-2",
				parentId: "msg-user-2",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "error",
					errorMessage: "Connection timed out",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			},
		]);

		const registry = makeSubagentRegistry([
			{
				id: SESSION_ID,
				kind: "subagent",
				label: "Test Subagent",
				status: "failed",
				sessionFile,
				lastUpdate: Date.now(),
			},
		]);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, ["ctrl+s"]);

		// Navigate from overview to detail view first
		overlay.handleInput("\r");
		const rendered = overlay.render(120);
		const renderedText = rendered.join("\n");

		// A real error message SHOULD be rendered with the ✗ Error: prefix
		expect(renderedText).toContain("✗ Error:");
		expect(renderedText).toContain("Connection timed out");
	});

	it("renders metadata card for observable runs without leaking home-prefixed paths", () => {
		const homeDir = os.homedir();
		const cwd = path.join(homeDir, "repo", "project");
		const worktree = path.join(homeDir, "repo", "project-worktree");
		const artifactPath = path.join(homeDir, "repo", "build.log");
		const registry = makeSubagentRegistry([
			{
				id: "job:bg_1",
				kind: "subagent",
				label: "Background build",
				agent: "bash",
				description: "compiled 42 files",
				status: "active",
				lastUpdate: Date.now(),
				runMetadata: {
					runId: "bg_1",
					taskId: "bg_1",
					agent: "bash",
					cwd,
					worktree,
					status: "running",
					presentation: { mode: "embedded", backend: "core" },
					artifacts: [{ kind: "raw", path: artifactPath }],
				},
				source: {
					kind: "async-job",
					name: "AsyncJobManager",
					eventChannel: "async:job:update",
					jobType: "bash",
				},
			},
		]);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, ["ctrl+s"]);

		// Navigate from overview to detail view — session has source.kind="async-job" so the
		// component renders #buildAsyncJobLines, not the generic observable-metadata card.
		overlay.handleInput("\r");
		const renderedText = overlay.render(120).join("\n");
		// Async-job detail renders the job kind and the session label
		expect(renderedText).toContain("Bash job");
		expect(renderedText).toContain("Background build");
		// Progress description is rendered as a sub-line under the job title
		expect(renderedText).toContain("compiled 42 files");
		// The old observable-metadata fallback strings are NOT present in the async-job path
		expect(renderedText).not.toContain("Captured transcript unavailable");
		expect(renderedText).not.toContain("Observable run");
		// No raw home-prefixed path should leak (async-job path emits no cwd/worktree/artifact paths)
		expect(renderedText).not.toContain(homeDir);
	});

	it("renders pane and window metadata when supplied by the run producer", () => {
		const registry = makeSubagentRegistry([
			{
				id: "plugin-cmux",
				kind: "subagent",
				label: "Visible agent",
				agent: "coder",
				status: "active",
				lastUpdate: Date.now(),
				runMetadata: {
					runId: "plugin-cmux",
					agent: "coder",
					cwd: tmpDir,
					status: "running",
					presentation: {
						mode: "window",
						backend: "cmux",
						session: "session-1",
						paneId: "pane-1",
						windowId: "window-1",
					},
					artifacts: [],
				},
			},
		]);

		const overlay260 = new SessionObserverOverlayComponent(registry, () => {}, ["ctrl+s"]);
		// Navigate from overview to detail view first
		overlay260.handleInput("\r");
		const renderedText260 = overlay260.render(180).join("\n");
		expect(renderedText260).toContain("window");
		expect(renderedText260).toContain("backend=cmux");
		expect(renderedText260).toContain("session=session-1");
		expect(renderedText260).toContain("paneId=pane-1");
		expect(renderedText260).toContain("windowId=wind");
	});

	it("expands transcript entries with Enter and mouse click", () => {
		const hiddenTail = "VISIBLE_AFTER_EXPANSION";
		const longText = `${"x".repeat(260)} ${hiddenTail}`;
		const sessionFile = makeJsonlSessionFile(tmpDir, [
			{ type: "session", version: 3, id: SESSION_ID, timestamp: new Date().toISOString() },
			{
				type: "message",
				id: "msg-user-long",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: longText, timestamp: Date.now() },
			},
		]);
		const registry = makeSubagentRegistry([
			{
				id: SESSION_ID,
				kind: "subagent",
				label: "Expandable Subagent",
				status: "active",
				sessionFile,
				lastUpdate: Date.now(),
			},
		]);
		const overlay = new SessionObserverOverlayComponent(registry, () => {}, ["ctrl+s"]);

		// In overview mode, hidden text is not present
		expect(overlay.render(120).join("\n")).not.toContain(hiddenTail);
		// Navigate from overview to detail view
		overlay.handleInput("\r");
		// Now in detail mode — entry is collapsed, tail not visible
		expect(overlay.render(120).join("\n")).not.toContain(hiddenTail);
		// Expand the entry
		overlay.handleInput("\r");
		expect(overlay.render(120).join("\n")).toContain(hiddenTail);
		// Collapse again
		overlay.handleInput("\r");
		expect(overlay.render(120).join("\n")).not.toContain(hiddenTail);
		overlay.handleMouse({ button: 0, x: 2, y: 6, localX: 2, localY: 6, released: false });
		expect(overlay.render(120).join("\n")).toContain(hiddenTail);
	});
});
