import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { adaptSchemaForStrict } from "@oh-my-pi/pi-ai/utils/schema";
import {
	collectBuiltinAndHiddenToolSchemas,
	collectCheckedInExtensionEntryPaths,
	collectCompatibilityFailures,
	collectExtensionToolSchemas,
} from "../tool-schema-test-utils";

describe("tool schemas provider compatibility", () => {
	it("keeps task and todo strict-compatible for OpenAI-style providers", async () => {
		const toolSchemas = await collectBuiltinAndHiddenToolSchemas();
		for (const toolName of ["task", "todo"]) {
			const entry = toolSchemas.find(tool => tool.name === toolName);
			expect(entry).toBeDefined();
			if (!entry) {
				continue;
			}
			const strictResult = adaptSchemaForStrict(entry.schema, true);
			expect(strictResult.strict).toBe(true);
		}
	});

	it("keeps all builtin and hidden tool schemas valid after provider enforcement", async () => {
		const toolSchemas = await collectBuiltinAndHiddenToolSchemas();
		const failures = collectCompatibilityFailures(toolSchemas);
		if (failures.length > 0) {
			throw new Error(`Provider compatibility failures:\n\n${failures.join("\n\n")}`);
		}
		expect(failures).toEqual([]);
	});

	it("keeps checked-in local extension tool schemas valid after provider enforcement", async () => {
		const repoRoot = path.resolve(import.meta.dir, "../../../..");
		const extensionPaths = await collectCheckedInExtensionEntryPaths(path.join(repoRoot, ".omp/extensions"));
		const toolSchemas = await collectExtensionToolSchemas(extensionPaths, repoRoot);
		const failures = collectCompatibilityFailures(toolSchemas);
		if (failures.length > 0) {
			throw new Error(`Provider compatibility failures:\n\n${failures.join("\n\n")}`);
		}
		expect(failures).toEqual([]);
	});
});
