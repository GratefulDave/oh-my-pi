/**
 * Read-only hashline diff preview helpers used by the streaming edit
 * renderer. Reads the target file, parses + applies the section's edits in
 * memory (no FS write, no LSP writethrough), then hands the before/after
 * pair to {@link generateDiffString} so the renderer can show the diff
 * while the tool call is still streaming.
 *
 * Validation is intentionally light: no snapshot-tag verification (the
 * preview path has no SnapshotStore — tags are opaque store pointers that
 * the apply path verifies via Recovery), no plan-mode guards, and no
 * auto-generated-file refusal — those belong on the write path.
 *
 * Migrated to the upstream v15.5.9 hashline API: `applyEdits(text, edits)`
 * with no options object; `PatchSection.parse()` to lazily access edits.
 */
import {
	applyEdits,
	Patch as HashlinePatch,
	normalizeToLF,
	type Patch,
	type PatchSection,
	stripBom,
} from "@oh-my-pi/hashline";
import { resolveToCwd } from "../../tools/path-utils";
import { generateDiffString } from "../diff";
import { readEditFileText } from "../read-file";

/**
 * Preview-path options. Upstream v15.5.9 dropped `autoDropPureInsertDuplicates`
 * from `applyEdits`; the field is kept here so call sites in `streaming.ts`
 * remain source-compatible during the consumer-migration window.
 */
export interface HashlineDiffOptions {
	/** @deprecated Removed upstream in v15.5.9; ignored by the preview path. */
	autoDropPureInsertDuplicates?: boolean;
}

async function readSectionText(absolutePath: string, sectionPath: string): Promise<string> {
	try {
		return await readEditFileText(absolutePath, sectionPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(message || `Unable to read ${sectionPath}`);
	}
}
export async function computeHashlineSectionDiff(
	section: PatchSection,
	cwd: string,
	_options: HashlineDiffOptions = {},
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	try {
		const absolutePath = resolveToCwd(section.path, cwd);
		const rawContent = await readSectionText(absolutePath, section.path);
		const { text: content } = stripBom(rawContent);
		const normalized = normalizeToLF(content);
		const { edits, warnings } = section.parse();
		if (warnings.length > 0) return { error: warnings.join("\n") };
		const result = applyEdits(normalized, [...edits]);
		if (normalized === result.text) return { error: `No changes would be made to ${section.path}.` };
		return generateDiffString(normalized, result.text);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export async function computeHashlineDiff(
	input: { input: string; path?: string },
	cwd: string,
	options: HashlineDiffOptions = {},
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	let patch: Patch;
	try {
		patch = HashlinePatch.parse(input.input, { cwd, path: input.path });
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
	if (patch.sections.length !== 1) {
		return { error: "Streaming diff preview supports exactly one hashline section." };
	}
	return computeHashlineSectionDiff(patch.sections[0], cwd, options);
}
