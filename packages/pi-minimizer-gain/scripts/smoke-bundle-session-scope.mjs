import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildMinimizerGainDiagnostic } from "../dist/gaing.bundle.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-minimizer-gain-smoke-"));
const agentDir = path.join(tempRoot, "agent");
const sessionCwdRaw = path.join(tempRoot, "project");
const commandCwdRaw = path.join(tempRoot, "sibling");
await fs.mkdir(sessionCwdRaw, { recursive: true });
await fs.mkdir(agentDir, { recursive: true });
await fs.mkdir(commandCwdRaw, { recursive: true });
const sessionCwd = await fs.realpath(sessionCwdRaw);
const commandCwd = await fs.realpath(commandCwdRaw);

const record = {
	schemaVersion: 2,
	timestamp: new Date().toISOString(),
	cwd: commandCwd,
	sessionCwd,
	command: "printf smoke",
	filter: "smoke",
	inputBytes: 100,
	outputBytes: 25,
	savedBytes: 75,
	savedTokens: 19,
	exitCode: 0,
};
await fs.writeFile(path.join(agentDir, "minimizer-gain.jsonl"), `${JSON.stringify(record)}\n`);

try {
	const diag = await buildMinimizerGainDiagnostic({ cwd: sessionCwd, agentDir });
	const failures = [];
	if (diag.recordCountInScope !== 1) failures.push(`recordCountInScope=${diag.recordCountInScope}`);
	if (diag.commandCwdRecordCountInScope !== 0) failures.push(`commandCwdRecordCountInScope=${diag.commandCwdRecordCountInScope}`);
	if (diag.sessionCwdRecordCountInScope !== 1) failures.push(`sessionCwdRecordCountInScope=${diag.sessionCwdRecordCountInScope}`);
	if (diag.recordsWithSessionCwd !== 1) failures.push(`recordsWithSessionCwd=${diag.recordsWithSessionCwd}`);
	if (diag.recordsWithoutSessionCwd !== 0) failures.push(`recordsWithoutSessionCwd=${diag.recordsWithoutSessionCwd}`);
	if (diag.savedCount !== 1) failures.push(`savedCount=${diag.savedCount}`);
	if (diag.schemaVersion !== 2) failures.push(`schemaVersion=${diag.schemaVersion}`);
	if (!diag.extensionBundlePath.endsWith("gaing.bundle.js")) failures.push(`extensionBundlePath=${diag.extensionBundlePath}`);
	if (failures.length > 0) {
		throw new Error(`bundle scope smoke failed: ${failures.join(", ")}`);
	}
	console.log("bundle scope smoke OK");
} finally {
	await fs.rm(tempRoot, { recursive: true, force: true });
}
