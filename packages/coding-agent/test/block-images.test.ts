import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processFileArguments } from "@oh-my-pi/pi-coding-agent/cli/file-processor";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

// 1x1 red PNG image as base64 (smallest valid PNG)
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
function createMinimalPdfBuffer(text: string): Buffer {
	const escapedText = text.replace(/([\\()])/g, "\\$1");
	const streamContent = `BT /F1 24 Tf 72 120 Td (${escapedText}) Tj ET\n`;
	const objects = [
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
		"4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
		`5 0 obj\n<< /Length ${Buffer.byteLength(streamContent, "ascii")} >>\nstream\n${streamContent}endstream\nendobj\n`,
	];
	const header = "%PDF-1.4\n";
	let offset = Buffer.byteLength(header, "ascii");
	const offsets = [0];
	for (const object of objects) {
		offsets.push(offset);
		offset += Buffer.byteLength(object, "ascii");
	}
	const xref = [
		"xref\n",
		`0 ${objects.length + 1}\n`,
		"0000000000 65535 f \n",
		...offsets.slice(1).map(objectOffset => `${objectOffset.toString().padStart(10, "0")} 00000 n \n`),
		`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`,
		`startxref\n${offset}\n%%EOF\n`,
	].join("");
	return Buffer.from([header, ...objects, xref].join(""), "ascii");
}

function createTestToolSession(cwd: string, settings: Settings = Settings.isolated()): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

describe("blockImages setting", () => {
	describe("Read tool", () => {
		let testDir: string;

		beforeEach(() => {
			testDir = path.join(os.tmpdir(), `block-images-test-${Date.now()}-${Math.random()}`);
			fs.mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			fs.rmSync(testDir, { recursive: true, force: true });
		});

		it("should include image blocks when inspect_image is disabled", async () => {
			// Create test image
			const imagePath = path.join(testDir, "test.png");
			fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const tool = new ReadTool(
				createTestToolSession(testDir, Settings.isolated({ "inspect_image.enabled": false })),
			);
			const result = await tool.execute("test-1", { path: imagePath });

			// Should have text note + image content
			expect(result.content.length).toBeGreaterThanOrEqual(1);
			const hasImage = result.content.some(c => c.type === "image");
			expect(hasImage).toBe(true);
		});

		it("should read text files normally", async () => {
			// Create test text file
			const textPath = path.join(testDir, "test.txt");
			fs.writeFileSync(textPath, "Hello, world!");

			const tool = new ReadTool(createTestToolSession(testDir));
			const result = await tool.execute("test-2", { path: textPath });

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			const textContent = result.content[0] as { type: "text"; text: string };
			expect(textContent.text).toContain("Hello, world!");
		});
	});

	describe("processFileArguments", () => {
		let testDir: string;

		beforeEach(() => {
			testDir = path.join(os.tmpdir(), `block-images-process-test-${Date.now()}-${Math.random()}`);
			fs.mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			fs.rmSync(testDir, { recursive: true, force: true });
		});

		it("should always process images (filtering happens at convertToLlm layer)", async () => {
			// Create test image
			const imagePath = path.join(testDir, "test.png");
			fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const result = await processFileArguments([imagePath]);

			expect(result.images).toHaveLength(1);
			expect(result.images[0].type).toBe("image");
		});

		it("should process text files normally", async () => {
			// Create test text file
			const textPath = path.join(testDir, "test.txt");
			fs.writeFileSync(textPath, "Hello, world!");

			const result = await processFileArguments([textPath]);

			expect(result.images).toHaveLength(0);
			expect(result.text).toContain("Hello, world!");
		});
		it("should convert supported documents via markit", async () => {
			const pdfPath = path.join(testDir, "test.pdf");
			fs.writeFileSync(pdfPath, createMinimalPdfBuffer("Hello PDF"));

			const result = await processFileArguments([pdfPath]);

			expect(result.images).toHaveLength(0);
			expect(result.text).toContain("Hello PDF");
			expect(result.text).not.toContain("%PDF");
			expect(result.text).not.toContain("stream");
		});
	});
});
