/**
 * Regression: legacy `@mariozechner/pi-ai/oauth` imports must resolve through
 * `loadLegacyPiModule()` to the canonical oauth implementation.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { TempDir } from "@oh-my-pi/pi-utils";

const canonicalOauthPath = Bun.resolveSync("@oh-my-pi/pi-ai/utils/oauth", import.meta.dir);

describe("pi-* scope aliases", () => {
	let projectDir: TempDir;
	let extensionPath: string;

	beforeEach(() => {
		projectDir = TempDir.createSync("@pi-scope-aliases-");
		extensionPath = path.join(projectDir.path(), "extension.ts");
		fs.writeFileSync(
			extensionPath,
			[
				'import { refreshOAuthToken as alias0 } from "@mariozechner/pi-ai/oauth";',
				`import { refreshOAuthToken as canonical0 } from ${JSON.stringify(canonicalOauthPath)};`,
				'if (typeof alias0 !== typeof canonical0) throw new Error("legacy oauth alias changed exported shape");',
				"export default function piAliasProbe() {}",
			].join("\n"),
		);
	});

	afterEach(() => {
		projectDir.removeSync();
	});

	it("normalizes legacy oauth subpath aliases", async () => {
		const mod = await loadLegacyPiModule(extensionPath);
		expect(typeof (mod as { default?: unknown }).default).toBe("function");
	});
});
