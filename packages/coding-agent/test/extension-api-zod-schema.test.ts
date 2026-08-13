import { describe, expectTypeOf, it } from "bun:test";
import type { Static, ZodV3Schema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { z } from "zod";
import { z as z3 } from "zod/v3";

describe("ExtensionAPI Zod v3 schema contract", () => {
	it("accepts an external Zod v3 schema and infers tool arguments", () => {
		const parameters = z3.object({ message: z3.string() });
		const accepted: ZodV3Schema = parameters;
		expectTypeOf(accepted).toMatchTypeOf<ZodV3Schema>();
		expectTypeOf<Static<typeof parameters>>().toEqualTypeOf<{ message: string }>();

		const tool = {
			name: "zod_v3_schema_contract",
			label: "Zod v3 schema contract",
			parameters,
			description: "Validates external Zod v3 typing",
			async execute(_toolCallId, params) {
				expectTypeOf(params).toEqualTypeOf<{ message: string }>();
				return { content: [{ type: "text", text: params.message }] };
			},
		} satisfies ToolDefinition<typeof parameters>;

		const register = (api: Pick<ExtensionAPI, "registerTool">): void => api.registerTool(tool);
		expectTypeOf(register).toBeFunction();
	});
});

describe("ExtensionAPI Zod v4 schema contract", () => {
	// Regression guard for the P3 finding on PR #7681: the first pass at this fix
	// only widened `ExtensionToolParameters` to `TSchema | zod.ZodLikeSchema<unknown>`
	// (the omptype-backed Zod facade), which was already assignable to `TSchema` and
	// so never actually accepted a real, externally-authored Zod schema object. A
	// real Zod v4 schema — the package's canonical authoring form per `TSchema`'s
	// own doc comment — must type-check here without widening to `any`/`unknown`.
	it("accepts a real external Zod v4 schema and infers tool arguments", () => {
		const parameters = z.object({ message: z.string() });
		expectTypeOf<Static<typeof parameters>>().toEqualTypeOf<{ message: string }>();

		const tool = {
			name: "zod_v4_schema_contract",
			label: "Zod v4 schema contract",
			parameters,
			description: "Validates external Zod v4 typing",
			async execute(_toolCallId, params) {
				expectTypeOf(params).toEqualTypeOf<{ message: string }>();
				return { content: [{ type: "text", text: params.message }] };
			},
		} satisfies ToolDefinition<typeof parameters>;

		const register = (api: Pick<ExtensionAPI, "registerTool">): void => api.registerTool(tool);
		expectTypeOf(register).toBeFunction();
	});
});
