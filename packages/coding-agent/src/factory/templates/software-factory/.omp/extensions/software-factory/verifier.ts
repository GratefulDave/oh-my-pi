import process from "node:process";

import type { ExecOptions, ExecResult } from "@oh-my-pi/pi-coding-agent";

import type { FactoryConfig } from "./config";
import { renderFactoryTemplate } from "./config";
import { resolveFactoryOmpCommand } from "./paths";

interface FactoryTextBlock {
	type: string;
	text?: string;
}

export interface FactoryMessage {
	role: "user" | "assistant" | "tool";
	content: string | FactoryTextBlock[];
}
export interface FactoryTurnSnapshot {
	prompt: string;
	source: "interactive" | "rpc" | "extension" | "unknown";
	trigger: "manual" | "agent_end";
	loopCount: number;
	sessionId: string;
	sessionFile?: string;
}

export interface FactoryVerifierReport {
	status: "verified" | "failed" | "unsure";
	confidence: "PERFECT" | "VERIFIED" | "PARTIAL" | "FEEDBACK" | "FAILED";
	claims: string[];
	gaps: string[];
	correction: string[];
	notes: string[];
	raw: string;
}

export interface FactoryVerifierRunOptions {
	cwd: string;
	config: FactoryConfig;
	snapshot: FactoryTurnSnapshot;
	messages: FactoryMessage[];
	diffSummary: string;
	systemPrompt: string;
	promptTemplate: string;
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}

function extractText(message: FactoryMessage | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	const textBlocks = message.content
		.filter(
			(block: FactoryTextBlock): block is FactoryTextBlock & { text: string } =>
				block.type === "text" && typeof block.text === "string",
		)
		.map((block: FactoryTextBlock & { text: string }) => block.text);
	return textBlocks.join("\n").trim();
}

export function latestAssistantText(messages: FactoryMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") return extractText(message);
	}
	return "";
}

export function latestUserText(messages: FactoryMessage[], fallbackPrompt: string): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "user") {
			const text = extractText(message);
			if (text) return text;
		}
	}
	return fallbackPrompt;
}

export function parseVerifierReport(text: string): FactoryVerifierReport {
	const lines = text.split(/\r?\n/);
	const report: FactoryVerifierReport = {
		status: "unsure",
		confidence: "PARTIAL",
		claims: [],
		gaps: [],
		correction: [],
		notes: [],
		raw: text.trim(),
	};
	let section: "claims" | "gaps" | "correction" | "notes" | undefined;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("STATUS:")) {
			const value = trimmed.slice("STATUS:".length).trim().toLowerCase();
			if (value === "verified" || value === "failed" || value === "unsure") report.status = value;
			section = undefined;
			continue;
		}
		if (trimmed.startsWith("CONFIDENCE:")) {
			const value = trimmed.slice("CONFIDENCE:".length).trim().toUpperCase();
			if (["PERFECT", "VERIFIED", "PARTIAL", "FEEDBACK", "FAILED"].includes(value)) {
				report.confidence = value as FactoryVerifierReport["confidence"];
			}
			section = undefined;
			continue;
		}
		if (trimmed === "CLAIMS:") {
			section = "claims";
			continue;
		}
		if (trimmed === "GAPS:") {
			section = "gaps";
			continue;
		}
		if (trimmed === "CORRECTION:") {
			section = "correction";
			continue;
		}
		if (trimmed === "NOTES:") {
			section = "notes";
			continue;
		}
		if (!trimmed || !section) continue;
		if (trimmed.startsWith("- ")) {
			report[section].push(trimmed.slice(2).trim());
		}
	}
	return report;
}

export function shouldRequestFollowUp(report: FactoryVerifierReport, loopCount: number, maxLoops: number): boolean {
	if (loopCount >= maxLoops) return false;
	return report.status === "failed" || report.confidence === "FAILED" || report.confidence === "FEEDBACK";
}

export function buildVerifierFollowUp(report: FactoryVerifierReport): string {
	const correction =
		report.correction.length > 0 ? report.correction.join("\n") : "Review verifier report and fix concrete gaps.";
	const gaps = report.gaps.length > 0 ? `\nGaps:\n- ${report.gaps.join("\n- ")}` : "";
	return `Verifier requested correction.\n${correction}${gaps}`.trim();
}

export function renderVerifierPrompt(
	template: string,
	config: FactoryConfig,
	snapshot: FactoryTurnSnapshot,
	messages: AgentMessage[],
	diffSummary: string,
): string {
	const replacements = {
		FACTORY_REPO_NAME: config.repo.name,
		FACTORY_SESSION_ID: snapshot.sessionId,
		FACTORY_SESSION_FILE: snapshot.sessionFile ?? "(unknown)",
		FACTORY_VERIFY_TRIGGER: snapshot.trigger,
		FACTORY_DIFF_SUMMARY: diffSummary,
	};
	return renderFactoryTemplate(
		template
			.replace("$ORIGINAL", latestUserText(messages, snapshot.prompt) || snapshot.prompt)
			.replace("$INPUT", latestAssistantText(messages) || "(no assistant output captured)"),
		replacements,
	);
}

export async function collectDiffSummary(exec: FactoryVerifierRunOptions["exec"], cwd: string): Promise<string> {
	const result = await exec("git", ["status", "--short"], { cwd, timeout: 5_000 });
	const combined = `${result.stdout}\n${result.stderr}`.trim();
	if (result.code !== 0) return combined || "git status unavailable";
	return combined || "working tree clean or diff unavailable";
}

function resolveExecCommand(): { command: string; args: string[] } {
	const resolved = resolveFactoryOmpCommand();
	if (process.platform === "win32" && resolved.shell) {
		return { command: "cmd", args: ["/c", resolved.cmd, ...resolved.args] };
	}
	return { command: resolved.cmd, args: resolved.args };
}

export async function runFactoryVerifier(options: FactoryVerifierRunOptions): Promise<FactoryVerifierReport> {
	const renderedPrompt = renderVerifierPrompt(
		options.promptTemplate,
		options.config,
		options.snapshot,
		options.messages,
		options.diffSummary,
	);
	const invocation = resolveExecCommand();
	const result = await options.exec(
		invocation.command,
		[
			...invocation.args,
			"--print",
			"--no-extensions",
			"--tools",
			options.config.verifier.tools.join(","),
			"--system-prompt",
			options.systemPrompt,
			renderedPrompt,
		],
		{
			cwd: options.cwd,
			timeout: 60_000,
		},
	);
	const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
	const report = parseVerifierReport(
		text || "STATUS: unsure\nCONFIDENCE: PARTIAL\nGAPS:\n- verifier produced no output",
	);
	return report;
}
