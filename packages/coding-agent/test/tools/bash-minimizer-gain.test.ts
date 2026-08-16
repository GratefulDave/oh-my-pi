import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeMinimizedSaveHandler } from "@oh-my-pi/pi-coding-agent/tools/bash";
import {
	appendBashMinimizerGainRecord,
	getBashMinimizerGainPath,
	hasBashMinimizerFilter,
	inferBashMinimizerMissedFilter,
	isBashCommandMinimizerEligible,
	isBashMinimizerGainTelemetryEnabled,
	resolveBashMinimizerEligibilityConfig,
} from "@oh-my-pi/pi-coding-agent/tools/bash-minimizer-gain";

describe("isBashMinimizerGainTelemetryEnabled", () => {
	test("defaults off when settings are missing or the key cannot be read", () => {
		expect(isBashMinimizerGainTelemetryEnabled(undefined)).toBe(false);
		expect(
			isBashMinimizerGainTelemetryEnabled({
				get: () => {
					throw new Error("not a SettingPath");
				},
			}),
		).toBe(false);
		expect(isBashMinimizerGainTelemetryEnabled({ get: () => undefined })).toBe(false);
	});

	test("honors an explicit true only when capture is explicitly enabled", () => {
		expect(isBashMinimizerGainTelemetryEnabled({ get: () => false })).toBe(false);
		expect(isBashMinimizerGainTelemetryEnabled({ get: () => true })).toBe(true);
	});
});

describe("bash minimizer gain writer", () => {
	let tempDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-gain-writer-"));
		cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd);
		fs.mkdirSync(path.join(tempDir, "session"));
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
	});

	test("appends saved minimizer records to the agent JSONL file", async () => {
		await appendBashMinimizerGainRecord({
			agentDir: path.join(tempDir, "agent"),
			command: "bun test noisy.test.ts",
			cwd,
			sessionCwd: path.join(tempDir, "session"),
			filter: "bun-test",
			inputBytes: 4000,
			outputBytes: 1000,
			exitCode: 1,
			sessionId: "session-test-id",
		});

		const file = getBashMinimizerGainPath(path.join(tempDir, "agent"));
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]!) as {
			command: string;
			cwd: string;
			sessionCwd: string;
			sessionId: string;
			filter: string;
			inputBytes: number;
			outputBytes: number;
			savedBytes: number;
			savedTokens: number;
			exitCode: number | null;
			kind: string;
		};
		expect(record.command).toBe("bun test noisy.test.ts");
		expect(record.cwd).toBe(fs.realpathSync(cwd));
		expect(record.sessionCwd).toBe(fs.realpathSync(path.join(tempDir, "session")));
		expect(record.sessionId).toBe("session-test-id");
		expect(record.inputBytes).toBe(4000);
		expect(record.outputBytes).toBe(1000);
		expect(record.savedBytes).toBe(3000);
		expect(record.savedTokens).toBe(750);
		expect(record.exitCode).toBe(1);
		expect(record.kind).toBe("saved");
	});

	test("skips saved records that do not save bytes", async () => {
		const agentDir = path.join(tempDir, "agent");
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "echo short",
			cwd,
			filter: "noop",
			inputBytes: 10,
			outputBytes: 10,
			exitCode: 0,
		});

		expect(fs.existsSync(getBashMinimizerGainPath(agentDir))).toBe(false);
	});

	test("appends missed records for unminimized command output", async () => {
		const agentDir = path.join(tempDir, "agent");
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "git status",
			cwd,
			filter: inferBashMinimizerMissedFilter("git status"),
			inputBytes: 200,
			outputBytes: 200,
			exitCode: 0,
			kind: "missed",
		});

		const [line] = fs.readFileSync(getBashMinimizerGainPath(agentDir), "utf8").trim().split("\n");
		const record = JSON.parse(line!) as {
			filter: string;
			inputBytes: number;
			outputBytes: number;
			savedBytes: number;
			savedTokens?: number;
			kind: string;
		};
		expect(record.filter).toBe("git");
		expect(record.inputBytes).toBe(200);
		expect(record.outputBytes).toBe(200);
		expect(record.savedBytes).toBe(0);
		expect(record.savedTokens).toBeUndefined();
		expect(record.kind).toBe("missed");
	});

	test("skips missed records when the command produced no output", async () => {
		const agentDir = path.join(tempDir, "agent");
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "true",
			cwd,
			filter: inferBashMinimizerMissedFilter("true"),
			inputBytes: 0,
			outputBytes: 0,
			exitCode: 0,
			kind: "missed",
		});

		expect(fs.existsSync(getBashMinimizerGainPath(agentDir))).toBe(false);
	});

	test("classifies compound missed commands separately", () => {
		expect(inferBashMinimizerMissedFilter("git status && git log")).toBe("git");
		expect(inferBashMinimizerMissedFilter("/usr/bin/git status")).toBe("git");
		expect(inferBashMinimizerMissedFilter("CI=1 npm test")).toBe("npm");
		expect(inferBashMinimizerMissedFilter("TOKEN=abc123 pnpm run lint")).toBe("pnpm");
		expect(inferBashMinimizerMissedFilter("FOO=1 BAR=2 node script.js")).toBe("node");
	});

	test("returns missed for unknown sudo flags (mirrors Rust minimizer returning None)", () => {
		// -D, -A, -N, -P, -B, -R are not recognized by skip_sudo_options in Rust → None
		expect(inferBashMinimizerMissedFilter("sudo -D /tmp git status")).toBe("missed");
		expect(inferBashMinimizerMissedFilter("sudo -A git status")).toBe("missed");
	});

	test("returns missed for unsupported exec flags", () => {
		expect(inferBashMinimizerMissedFilter("exec -z git status")).toBe("missed");
		expect(inferBashMinimizerMissedFilter("exec -cl git status")).toBe("missed");
		expect(inferBashMinimizerMissedFilter("exec -a git-alias git status")).toBe("git");
		expect(inferBashMinimizerMissedFilter("exec -- git status")).toBe("git");
	});

	test("handles quoted env values containing whitespace", () => {
		expect(
			inferBashMinimizerMissedFilter("NODE_OPTIONS='--max-old-space-size=4096 --trace-warnings' pnpm test"),
		).toBe("pnpm");
		expect(inferBashMinimizerMissedFilter('NODE_OPTIONS="--max-old-space-size=4096 --trace-warnings" bun test')).toBe(
			"bun",
		);
		expect(inferBashMinimizerMissedFilter("CI=1 NODE_OPTIONS='--max-old-space-size=512' uv run pytest")).toBe("uv");
		expect(
			inferBashMinimizerMissedFilter("NODE_OPTIONS='--require ./setup.js --max-old-space-size=4096' npm run build"),
		).toBe("npm");
	});

	test("handles env wrapper commands", () => {
		expect(inferBashMinimizerMissedFilter("env CI=1 pnpm test")).toBe("pnpm");
		expect(inferBashMinimizerMissedFilter("env -u FOO bun test")).toBe("bun");
		expect(inferBashMinimizerMissedFilter("env FOO=bar BAR=baz node index.js")).toBe("node");
	});

	test("handles time long-option operands", () => {
		expect(inferBashMinimizerMissedFilter("time --format '%E' git status")).toBe("git");
		expect(inferBashMinimizerMissedFilter("time --output t git status")).toBe("git");
		expect(inferBashMinimizerMissedFilter("time --format='%E' git status")).toBe("git");
		expect(inferBashMinimizerMissedFilter("time --unknown git status")).toBe("missed");
	});

	test("treats quoted shell operators as word characters, not compound", () => {
		expect(inferBashMinimizerMissedFilter("rg 'foo|bar'")).toBe("rg");
		expect(inferBashMinimizerMissedFilter('grep "a;b" file.txt')).toBe("grep");
		expect(inferBashMinimizerMissedFilter("git log --oneline | head -10")).toBe("git");
		expect(inferBashMinimizerMissedFilter("git status && git log")).toBe("git");
	});

	test("handles backslash-escaped spaces in env assignments", () => {
		expect(inferBashMinimizerMissedFilter("NODE_OPTIONS=--require\\ ./setup.js pnpm test")).toBe("pnpm");
	});

	test("treats newlines as command separators (compound)", () => {
		expect(inferBashMinimizerMissedFilter("git status\nnpm test")).toBe("git");
		expect(inferBashMinimizerMissedFilter("cd /tmp\nls -la")).toBe("cd");
	});

	test("handles env -i (exact match) correctly", () => {
		// -i is an exact match in Rust skip_env_options, so the next token is the command
		expect(inferBashMinimizerMissedFilter("env -i pnpm test")).toBe("pnpm");
	});

	test("unknown env short options break (mirrors Rust _ => break)", () => {
		// -v is NOT a recognized env option in Rust's skip_env_options (only -S, -i, -, -u, -C).
		// The token breaks and becomes the "program" — it fails supports() so no miss is recorded.
		expect(inferBashMinimizerMissedFilter("env -v bun test")).toBe("-v");
	});

	test("attached env -C/-u operands break (mirrors Rust exact-token matching)", () => {
		// Rust skip_env_options matches -C/-u only as exact tokens, not attached values.
		// -C/tmp, -uFOO, -iC/tmp all break → the raw token becomes the "program".
		// normalizeProgramName takes the last path segment: -C/tmp → "tmp", -iC/tmp → "tmp".
		// -uFOO has no path separator, so it stays as "-ufoo" (lowercased).
		expect(inferBashMinimizerMissedFilter("env -C/tmp bun test")).toBe("tmp");
		expect(inferBashMinimizerMissedFilter("env -uFOO git status")).toBe("-ufoo");
		expect(inferBashMinimizerMissedFilter("env -iC/tmp node server.js")).toBe("tmp");
	});

	test("returns missed for env -S/--split-string (mirrors Rust skip_env_options returning None)", () => {
		// Native minimizer detect() returns None for env -S, so telemetry must also be ineligible.
		expect(inferBashMinimizerMissedFilter("env -S 'git status'")).toBe("missed");
		expect(inferBashMinimizerMissedFilter("env --split-string 'bun test'")).toBe("missed");
		expect(inferBashMinimizerMissedFilter("env --split-string='CI=1 npm test'")).toBe("missed");
		// Clustered -iS is NOT exact -S → breaks → program is "-is" (ineligible, no miss recorded)
		expect(inferBashMinimizerMissedFilter("env -iS 'git log'")).toBe("-is");
	});
});

describe("fd-dup redirect handling", () => {
	test("2>&1 is not classified as compound", () => {
		expect(inferBashMinimizerMissedFilter("bun test 2>&1")).toBe("bun");
	});
	test(">&2 is not classified as compound", () => {
		expect(inferBashMinimizerMissedFilter("echo hello >&2")).toBe("echo");
	});
	test("cmd >file 2>&1 is not classified as compound", () => {
		expect(inferBashMinimizerMissedFilter("npm install >out.log 2>&1")).toBe("npm");
	});
	test("&>file is not classified as compound", () => {
		expect(inferBashMinimizerMissedFilter("git diff &>diff.txt")).toBe("git");
	});
	test("bare & (background) is still classified as compound", () => {
		expect(inferBashMinimizerMissedFilter("sleep 10 &")).toBe("sleep");
	});
	test("pipe is still classified as compound", () => {
		expect(inferBashMinimizerMissedFilter("ls | grep foo")).toBe("ls");
	});
});

describe("isBashCommandMinimizerEligible", () => {
	test("eligible when only and except are empty", () => {
		expect(isBashCommandMinimizerEligible("bun test", [], [])).toBe(true);
	});
	test("ineligible when only is set and basename not in it", () => {
		expect(isBashCommandMinimizerEligible("bun test", ["git"], [])).toBe(false);
	});
	test("eligible when only is set and basename is in it", () => {
		expect(isBashCommandMinimizerEligible("git status", ["git"], [])).toBe(true);
	});
	test("eligible with exact lowercase matching (mirrors native is_program_enabled)", () => {
		expect(isBashCommandMinimizerEligible("GIT status", ["git"], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("bun test", ["BUN"], [])).toBe(true);
	});
	test("ineligible when except excludes the basename", () => {
		expect(isBashCommandMinimizerEligible("git status", [], ["git"])).toBe(false);
	});
	test("eligible when only matches and except does not", () => {
		expect(isBashCommandMinimizerEligible("git status", ["git"], ["bun"])).toBe(true);
	});
	test("single piped commands are ineligible", () => {
		expect(isBashCommandMinimizerEligible("ls | grep foo", [], [])).toBe(false);
	});
	test("newline chains inspect every segment", () => {
		expect(isBashCommandMinimizerEligible("echo prep\ngit status", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("git status\nexec >out", [], [])).toBe(false);
	});
	test("unquoted shell comments terminate chain scanning", () => {
		expect(isBashCommandMinimizerEligible("echo ok # ; git status", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("git status # && exec >out", [], [])).toBe(true);
	});
	test("piped segments do not suppress later eligible chain segments", () => {
		expect(isBashCommandMinimizerEligible("ls | head -5 && git status", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("git status && ls | head -5", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("ls | head -5 && echo done", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("git status | cat && unknown-tool", [], [])).toBe(true);
	});
	test("chain utilities use raw segment program names", () => {
		expect(isBashCommandMinimizerEligible("/bin/echo ok && /bin/printf done", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("command echo ok && command printf done", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("echo ok && printf done", [], [])).toBe(true);
	});
	test("shell state mutators make chains ineligible", () => {
		expect(isBashCommandMinimizerEligible("exec >out ; git status", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("alias git=hub ; git status", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("command exec >out ; git status", [], [])).toBe(false);
	});
	test("literal grouping syntax inside chain arguments stays eligible", () => {
		expect(isBashCommandMinimizerEligible("echo '(prep)' && git status", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("rg 'foo(bar)' ; git status", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("echo '{prep}' && git status", [], [])).toBe(true);
	});
	test("native-opaque chain segments are ineligible", () => {
		expect(isBashCommandMinimizerEligible("time git status && echo done", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("(cd sub && make) ; git status", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("(echo) ; git status", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("if true; then echo ok; fi ; git status", [], [])).toBe(false);
	});
	test("unsafe chain segments are ineligible", () => {
		expect(isBashCommandMinimizerEligible("echo $(pwd) ; git status", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("cat <<EOF ; git status", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("cat <<<ok ; git status", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("echo 'literal << text' ; git status", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("cat <<<$(pwd) ; git status", [], [])).toBe(false);
	});
	test("background commands are always ineligible (mirrors native MinimizerMode::None)", () => {
		expect(isBashCommandMinimizerEligible("git status &", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("npm test &", ["npm"], [])).toBe(false);
	});
	test("safe && chains are eligible (mirrors native SegmentedChain)", () => {
		// The native minimizer routes && chains through SegmentedChain, capturing each
		// segment independently. Both segments have supported (program, subcommand) pairs.
		expect(isBashCommandMinimizerEligible("git status && git diff", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("bun test && bun run build", [], [])).toBe(true);
	});
	test("safe ; chains are eligible (mirrors native SegmentedChain)", () => {
		expect(isBashCommandMinimizerEligible("git status; echo done", [], [])).toBe(true);
	});
	test("any-segment eligibility: ineligible first + eligible later segment", () => {
		// echo is unsupported, but git status is eligible → chain is eligible
		expect(isBashCommandMinimizerEligible("echo prep && git status", [], [])).toBe(true);
		// git status is eligible, echo is not → still eligible (first segment)
		expect(isBashCommandMinimizerEligible("git status && echo done", [], [])).toBe(true);
		// only=["bun"]: git is excluded, bun test is eligible → chain is eligible
		expect(isBashCommandMinimizerEligible("git status && bun test", ["bun"], [])).toBe(true);
		// common chain utilities also route through native SegmentedChain
		expect(isBashCommandMinimizerEligible("echo a && echo b", [], [])).toBe(true);
	});
	test("legacy filters disable segmented chain eligibility", () => {
		expect(isBashCommandMinimizerEligible("git status && git diff", [], [], { legacyFilters: true })).toBe(false);
		expect(isBashCommandMinimizerEligible("git status", [], [], { legacyFilters: true })).toBe(true);
	});
	test("TOML-defined programs are eligible (make, ansible, apt, etc.)", () => {
		expect(isBashCommandMinimizerEligible("make", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("make -j4", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("ansible-playbook deploy.yml", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("apt install -y nginx", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("gcc -o main main.c", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("just test", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("terraform plan", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("tofu apply", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("ollama pull llama3", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("swift build", [], [])).toBe(true);
		// TOML subcommand-gated: unsupported subcommands
		expect(isBashCommandMinimizerEligible("terraform version", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("ollama version", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("rails db:migrate", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("rake routes", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("helm repo update", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("helm search repo bitnami", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("helm history release-name", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("shellcheck script.sh", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("markdownlint README.md", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("hadolint Dockerfile", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("yamllint .", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("ping6 example.com", [], [])).toBe(true);
	});
	test("yadm falls back to TOML pipeline eligibility when built-in allowlist has no match", () => {
		expect(isBashCommandMinimizerEligible("yadm config --list", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("yadm", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("git", [], [])).toBe(false);
	});
	test("package manager subcommands mirror native package supports", () => {
		expect(isBashCommandMinimizerEligible("npm install", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("brew install jq", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("composer require symfony/console", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("npm --version", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("pnpm nx build", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("yarn nx build", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("brew", [], [])).toBe(false);
	});
	test("npx fallback captures unknown-tool and no-subcommand invocations", () => {
		expect(isBashCommandMinimizerEligible("npx cowsay hello", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("npx eslint .", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("npx", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("npx --version", [], [])).toBe(true);
	});
	test("settings file overrides only/except/max capture and user pipelines", async () => {
		const settingsPath = path.join(os.tmpdir(), `omp-minimizer-settings-${Date.now()}-${Math.random()}.toml`);
		fs.writeFileSync(
			settingsPath,
			[
				"schema_version = 1",
				'only = ["git"]',
				'except = ["docker"]',
				"max_capture_bytes = 2048",
				"legacy_filters = true",
				"enabled = false",
				"[filters.custom]",
				'match_command = "^custom-tool$"',
				'match_subcommand = "^summarize$"',
			].join("\n"),
		);
		try {
			const config = await resolveBashMinimizerEligibilityConfig({
				settingsPath,
				only: ["bun"],
				except: [],
				maxCaptureBytes: 4096,
				legacyFilters: undefined,
				enabled: true,
			});
			expect(config.only).toEqual(["git"]);
			expect(config.except).toEqual(["docker"]);
			expect(config.maxCaptureBytes).toBe(2048);
			expect(config.legacyFilters).toBe(true);
			expect(config.enabled).toBe(false);
			expect(isBashCommandMinimizerEligible("bun test", config.only, config.except, config)).toBe(false);
			expect(isBashCommandMinimizerEligible("git status", config.only, config.except, config)).toBe(false);
			expect(isBashCommandMinimizerEligible("custom-tool summarize", [], [], config)).toBe(false);
			expect(isBashCommandMinimizerEligible("custom-tool other", [], [], config)).toBe(false);
		} finally {
			fs.rmSync(settingsPath, { force: true });
		}
	});

	test("an explicit disabled setting overrides an enabled settings file", async () => {
		const settingsPath = path.join(os.tmpdir(), `omp-minimizer-disabled-${Date.now()}-${Math.random()}.toml`);
		fs.writeFileSync(settingsPath, "enabled = true");
		try {
			const config = await resolveBashMinimizerEligibilityConfig({
				settingsPath,
				only: [],
				except: [],
				maxCaptureBytes: 4096,
				legacyFilters: undefined,
				enabled: false,
			});
			expect(config.enabled).toBe(false);
			expect(isBashCommandMinimizerEligible("git status", config.only, config.except, config)).toBe(false);
		} finally {
			fs.rmSync(settingsPath, { force: true });
		}
	});
	test("invalid user pipeline regex disables all user pipeline eligibility", async () => {
		const settingsPath = path.join(os.tmpdir(), `omp-minimizer-invalid-settings-${Date.now()}-${Math.random()}.toml`);
		fs.writeFileSync(
			settingsPath,
			[
				"schema_version = 1",
				"[filters.custom]",
				'match_command = "^custom-tool$"',
				"[filters.bad]",
				'match_command = "["',
			].join("\n"),
		);
		try {
			const config = await resolveBashMinimizerEligibilityConfig({
				settingsPath,
				only: [],
				except: [],
				maxCaptureBytes: 4096,
				legacyFilters: false,
				enabled: true,
			});
			expect(isBashCommandMinimizerEligible("custom-tool summarize", [], [], config)).toBe(false);
		} finally {
			fs.rmSync(settingsPath, { force: true });
		}
	});
	test("legacy filter env fallback disables chain eligibility", async () => {
		const previous = Bun.env.OMP_MINIMIZER_LEGACY_FILTERS;
		Bun.env.OMP_MINIMIZER_LEGACY_FILTERS = "yes";
		try {
			const config = await resolveBashMinimizerEligibilityConfig({
				settingsPath: undefined,
				only: [],
				except: [],
				maxCaptureBytes: 4096,
				legacyFilters: undefined,
				enabled: true,
			});
			expect(config.legacyFilters).toBe(true);
			expect(isBashCommandMinimizerEligible("git status && git diff", config.only, config.except, config)).toBe(
				false,
			);
		} finally {
			if (previous === undefined) {
				delete Bun.env.OMP_MINIMIZER_LEGACY_FILTERS;
			} else {
				Bun.env.OMP_MINIMIZER_LEGACY_FILTERS = previous;
			}
		}
	});
	test("empty command is always ineligible", () => {
		expect(isBashCommandMinimizerEligible("", [], [])).toBe(false);
	});
});

describe("makeMinimizedSaveHandler + didSave gate contract", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-gain-gate-"));
		agentDir = path.join(tempDir, "agent");
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
	});

	function mockSession(gainTelemetry: boolean, dir: string, prefix?: string) {
		return {
			cwd: tempDir,
			hasUI: false,
			getSessionId: () => "test-session",
			getSessionFile: () => null,
			settings: {
				get: (key: string) => {
					if (key === "shellMinimizer.gainTelemetry") return gainTelemetry;
					return undefined;
				},
				getAgentDir: () => dir,
				getShellConfig: () => ({ prefix }),
			},
		};
	}

	test("minimized run emits exactly one saved record and no missed record", async () => {
		const session = mockSession(true, agentDir) as Parameters<typeof makeMinimizedSaveHandler>[0];

		const handler = makeMinimizedSaveHandler(session, "bun test noisy.test.ts", tempDir);
		await handler.onMinimizedSave("original output text here", {
			filter: "bun-test",
			inputBytes: 4000,
			outputBytes: 1000,
		});
		await handler.flushSaved(1); // simulate exitCode:1 from executeBash

		expect(handler.didSave()).toBe(true);

		const lines = fs.readFileSync(getBashMinimizerGainPath(agentDir), "utf8").trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]!) as { kind: string; filter: string; exitCode: number | null };
		expect(record.kind).toBe("saved");
		expect(record.filter).toBe("bun-test");
		expect(record.exitCode).toBe(1);
	});

	test("unminimized run emits exactly one missed record when caller uses guard", async () => {
		const session = mockSession(true, agentDir) as Parameters<typeof makeMinimizedSaveHandler>[0];

		const handler = makeMinimizedSaveHandler(session, "git log --oneline", tempDir);
		// onMinimizedSave NOT called — no minimization
		expect(handler.didSave()).toBe(false);

		// Caller writes missed only when !didSave()
		if (!handler.didSave()) {
			await appendBashMinimizerGainRecord({
				command: "git log --oneline",
				cwd: tempDir,
				sessionId: "test-session",
				filter: inferBashMinimizerMissedFilter("git log --oneline"),
				inputBytes: 500,
				outputBytes: 500,
				exitCode: 0,
				kind: "missed",
				agentDir,
			});
		}

		const lines = fs.readFileSync(getBashMinimizerGainPath(agentDir), "utf8").trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]!) as { kind: string; filter: string };
		expect(record.kind).toBe("missed");
		expect(record.filter).toBe("git");
	});

	test("didSave guard prevents spurious missed record on minimized run", async () => {
		const session = mockSession(true, agentDir) as Parameters<typeof makeMinimizedSaveHandler>[0];

		const handler = makeMinimizedSaveHandler(session, "cargo build", tempDir);
		await handler.onMinimizedSave("build output...", { filter: "cargo", inputBytes: 8000, outputBytes: 500 });
		await handler.flushSaved(0); // writes the saved record

		// Guard: caller skips the missed write when didSave() is true
		if (!handler.didSave()) {
			await appendBashMinimizerGainRecord({
				command: "cargo build",
				agentDir,
				filter: "cargo",
				inputBytes: 8000,
				outputBytes: 8000,
				exitCode: 0,
				kind: "missed",
			});
		}

		const lines = fs.readFileSync(getBashMinimizerGainPath(agentDir), "utf8").trim().split("\n").filter(Boolean);
		// Only the saved record — no spurious missed
		expect(lines).toHaveLength(1);
		expect((JSON.parse(lines[0]!) as { kind: string }).kind).toBe("saved");
	});

	test("telemetry suppressed when shellMinimizer.gainTelemetry is explicitly false", async () => {
		const session = mockSession(false, agentDir) as Parameters<typeof makeMinimizedSaveHandler>[0];

		const handler = makeMinimizedSaveHandler(session, "npm install", tempDir);
		await handler.onMinimizedSave("install output", { filter: "npm", inputBytes: 2000, outputBytes: 500 });
		await handler.flushSaved(0);

		expect(fs.existsSync(getBashMinimizerGainPath(agentDir))).toBe(false);
	});

	test("telemetry stays off when the gainTelemetry setting is missing", async () => {
		const session = {
			cwd: tempDir,
			hasUI: false,
			getSessionId: () => "test-session",
			getSessionFile: () => null,
			settings: {
				get: () => {
					throw new Error("shellMinimizer.gainTelemetry is not a SettingPath");
				},
				getAgentDir: () => agentDir,
				getShellConfig: () => ({}),
			},
		} as unknown as Parameters<typeof makeMinimizedSaveHandler>[0];

		const handler = makeMinimizedSaveHandler(session, "git status", tempDir);
		await handler.onMinimizedSave("status output", { filter: "git", inputBytes: 2000, outputBytes: 500 });
		await handler.flushSaved(0);

		expect(fs.existsSync(getBashMinimizerGainPath(agentDir))).toBe(false);
	});
});

describe("hasBashMinimizerFilter", () => {
	test("returns true for known (program, subcommand) pairs", () => {
		// Programs whose supports() requires a subcommand now need one:
		expect(hasBashMinimizerFilter("git", "status")).toBe(true);
		expect(hasBashMinimizerFilter("bun", "test")).toBe(true);
		expect(hasBashMinimizerFilter("cargo", "build")).toBe(true);
		expect(hasBashMinimizerFilter("uv", "run")).toBe(true);
		expect(hasBashMinimizerFilter("gh", "pr")).toBe(true);
		expect(hasBashMinimizerFilter("docker", "ps")).toBe(true);
		expect(hasBashMinimizerFilter("npm", "install")).toBe(true);
		// Programs whose supports() is program-only still return true with no subcommand:
		expect(hasBashMinimizerFilter("pytest")).toBe(true);
		expect(hasBashMinimizerFilter("rg")).toBe(true);
		expect(hasBashMinimizerFilter("env")).toBe(true);
	});

	test("returns false for unsupported subcommands of known programs", () => {
		// git rev-parse / bun --version / docker --version produce output but the
		// native minimizer has no filter for them, so they must not be recorded as misses.
		expect(hasBashMinimizerFilter("git", "rev-parse")).toBe(false);
		expect(hasBashMinimizerFilter("git")).toBe(false); // git with no subcommand
		expect(hasBashMinimizerFilter("bun", "--version")).toBe(false);
		expect(hasBashMinimizerFilter("docker", "--version")).toBe(false);
		expect(hasBashMinimizerFilter("cargo", "init")).toBe(false);
	});

	test("returns false for unknown programs", () => {
		expect(hasBashMinimizerFilter("my-custom-tool")).toBe(false);
		expect(hasBashMinimizerFilter("fzf")).toBe(false);
		expect(hasBashMinimizerFilter("tmux")).toBe(false);
	});

	test("returns false for sentinel values", () => {
		expect(hasBashMinimizerFilter("missed")).toBe(false);
		expect(hasBashMinimizerFilter("compound")).toBe(false);
		expect(hasBashMinimizerFilter("")).toBe(false);
	});

	test("returns true for gtest binary name patterns", () => {
		expect(hasBashMinimizerFilter("my_module_test")).toBe(true);
		expect(hasBashMinimizerFilter("foo_tests")).toBe(true);
		expect(hasBashMinimizerFilter("integration-test")).toBe(true);
		expect(hasBashMinimizerFilter("suite-tests")).toBe(true);
		expect(hasBashMinimizerFilter("foo.test")).toBe(true);
	});

	test("only records missed for supported (program, subcommand) pairs", () => {
		// isBashCommandMinimizerEligible is the single eligibility gate at the
		// call sites; it folds the supports() check. Verify the full path here.
		expect(isBashCommandMinimizerEligible("my-custom-tool run", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("bun test", [], [])).toBe(true);
		expect(isBashCommandMinimizerEligible("git rev-parse --show-toplevel", [], [])).toBe(false);
		expect(isBashCommandMinimizerEligible("git status", [], [])).toBe(true);
	});
});

describe("skipEnvOptionsAndAssignments edge cases", () => {
	test("bare - treated as -i (no-arg, no split-string)", () => {
		// env - git status → bare - is ignore-environment (no arg), program is git
		expect(inferBashMinimizerMissedFilter("env - git status")).toBe("git");
	});

	test("unknown long option breaks (mirrors Rust _ => break)", () => {
		// env --unknown-opt git status → unknown opt breaks, becomes the "program"
		expect(inferBashMinimizerMissedFilter("env --unknown-opt git status")).toBe("--unknown-opt");
	});

	test("bare -- terminates option parsing, next token is program", () => {
		// env -- git status → -- ends env opts, git is the program
		expect(inferBashMinimizerMissedFilter("env -- git status")).toBe("git");
	});

	test("known --ignore-environment does not return missed", () => {
		expect(inferBashMinimizerMissedFilter("env --ignore-environment git status")).toBe("git");
	});

	test("--null breaks (not a recognized env option in Rust)", () => {
		// Rust skip_env_options does not recognize --null → breaks → program is "--null"
		expect(inferBashMinimizerMissedFilter("env --null git status")).toBe("--null");
	});

	test("--debug breaks (not a recognized env option in Rust)", () => {
		// Rust skip_env_options does not recognize --debug → breaks → program is "--debug"
		expect(inferBashMinimizerMissedFilter("env --debug git status")).toBe("--debug");
	});

	test("known --unset consumes next token", () => {
		expect(inferBashMinimizerMissedFilter("env --unset FOO git status")).toBe("git");
	});

	test("known --chdir consumes next token", () => {
		expect(inferBashMinimizerMissedFilter("env --chdir /tmp git status")).toBe("git");
	});
});
