import { describe, expect, it } from "bun:test";
import { finalizeSubprocessOutput } from "../../src/task/executor";
import { subprocessToolRegistry } from "../../src/task/subprocess-tool-registry";
import { parseReportFindingDetails, toReviewFinding } from "../../src/tools/review";

const baseFinding = {
	title: "Example finding",
	body: "Details",
	confidence: 0.95,
	file_path: "/tmp/example.ts",
	line_start: 10,
	line_end: 12,
} as const;

describe("report_finding subprocess extraction", () => {
	it("returns undefined for malformed finding details", () => {
		expect(parseReportFindingDetails({})).toBeUndefined();
		expect(
			parseReportFindingDetails({
				title: "[P1] Missing file path",
				body: "Body",
				priority: "P1",
				confidence: 0.8,
				line_start: 12,
				line_end: 12,
			}),
		).toBeUndefined();
	});

	it("ignores error events and extracts valid details", () => {
		const handler = subprocessToolRegistry.getHandler("report_finding");
		if (!handler?.extractData) {
			throw new Error("report_finding handler is not registered");
		}

		const validDetails = {
			title: "[P1] Example finding",
			body: "Details",
			priority: "P1" as const,
			confidence: 0.95,
			file_path: "/tmp/example.ts",
			line_start: 10,
			line_end: 12,
		};

		expect(
			handler.extractData({
				toolName: "report_finding",
				toolCallId: "call-1",
				result: {
					content: [{ type: "text", text: "Finding recorded" }],
					details: validDetails,
				},
				isError: false,
			}),
		).toEqual(validDetails);

		expect(
			handler.extractData({
				toolName: "report_finding",
				toolCallId: "call-2",
				result: {
					content: [{ type: "text", text: "Validation failed" }],
					details: {},
				},
				isError: true,
			}),
		).toBeUndefined();
	});
});

describe("toReviewFinding", () => {
	it.each([
		["P0", 0],
		["P1", 1],
		["P2", 2],
		["P3", 3],
	] as const)("maps %s to %i", (priority, expected) => {
		expect(toReviewFinding({ ...baseFinding, priority })).toEqual({
			...baseFinding,
			priority: expected,
		});
	});

	it("injects numeric report findings into successful yield output", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: '{"overall_correctness":"correct","explanation":"ok","confidence":0.9}',
			exitCode: 1,
			stderr: "should clear",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [
				{
					status: "success",
					data: { overall_correctness: "correct", explanation: "ok", confidence: 0.9 },
				},
			],
			reportFindings: [toReviewFinding({ ...baseFinding, priority: "P2" })],
			outputSchema: {
				properties: {
					overall_correctness: { enum: ["correct", "incorrect"] },
					explanation: { type: "string" },
					confidence: { type: "float64" },
				},
				optionalProperties: {
					findings: {
						elements: {
							properties: {
								title: { type: "string" },
								body: { type: "string" },
								priority: { type: "number" },
								confidence: { type: "float64" },
								file_path: { type: "string" },
								line_start: { type: "int32" },
								line_end: { type: "int32" },
							},
							required: ["title", "body", "priority", "confidence", "file_path", "line_start", "line_end"],
						},
					},
				},
				required: ["overall_correctness", "explanation", "confidence"],
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = JSON.parse(result.rawOutput) as { findings?: Array<{ priority: number }> };
		expect(parsed.findings?.[0]?.priority).toBe(2);
	});
});
