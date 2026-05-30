import * as fs1 from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

// Canonical scope for in-process pi packages. Plugins published against any of
// the aliased scopes below (mariozechner's original publish, earendil-works'
// fork, or the canonical @oh-my-pi scope itself) are remapped to this scope and
// resolved against the bundled copy that ships inside the omp binary. This
// keeps plugins running against the exact runtime state of the host (single
// module registry, single tool registry, etc.) regardless of which historical
// scope name they happened to declare in their peerDependencies.
const CANONICAL_PI_SCOPE = "@oh-my-pi";

// Scopes that have historically been used to publish (or alias) internal
// pi-* packages. `@earendil-works` is included in the filter so plugin-local
// installs can be resolved by the bare fallback below, but is intentionally not
// canonicalized: several Pi plugins depend on its published runtime surface and
// should not be forced through Lex's current SDK during bundling.
const PI_SCOPE_ALIASES = ["oh-my-pi", "mariozechner", "earendil-works"] as const;
const CANONICALIZED_PI_SCOPE_ALIASES = ["oh-my-pi", "mariozechner"] as const;

// Internal pi-* package basenames bundled inside the omp binary.
const PI_PACKAGE_NAMES = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-natives", "pi-tui", "pi-utils"] as const;

const PI_SCOPE_ALTERNATION = PI_SCOPE_ALIASES.join("|");
const PI_PACKAGE_ALTERNATION = PI_PACKAGE_NAMES.join("|");

// Upstream `@mariozechner/*` packages exposed a few subpaths at the package
// root that we relocated under a different folder. Each entry rewrites
// `<pkg>/<from>` → `<pkg>/<to>` after the scope has been canonicalised, so
// plugins importing the upstream layout still resolve to a real file in our
// bundled copy. Add new entries as `pkg/from -> pkg/to` whenever a plugin
// surfaces another upstream-only subpath that breaks resolution.
const PI_SUBPATH_REMAPS: ReadonlyMap<string, string> = new Map<string, string>([
	// `@mariozechner/pi-ai/oauth` re-exported `./utils/oauth/index.js`.
	// Our pi-ai keeps the implementation under `utils/oauth` but never added a
	// root-level re-export, so map the upstream subpath onto it directly.
	["pi-ai/oauth", "pi-ai/utils/oauth"],
]);

const LEGACY_PI_SPECIFIER_FILTER = new RegExp(`^@(?:${PI_SCOPE_ALTERNATION})/(?:${PI_PACKAGE_ALTERNATION})(?:/.*)?$`);
const LEGACY_PI_IMPORT_SPECIFIER_REGEX = new RegExp(
	`((?:from\\s+|import\\s*\\(\\s*)["'])(@(?:${PI_SCOPE_ALTERNATION})/(?:${PI_PACKAGE_ALTERNATION})(?:/[^"'()\\s]+)?)(["'])`,
	"g",
);
const LEGACY_PI_FILE_PREFIX = "omp-legacy-pi-file:";
const LEGACY_PI_FILE_NAMESPACE = "omp-legacy-pi-file";
const resolvedSpecifierFallbacks = new Map<string, string>();

// Extensions that imported `@sinclair/typebox` directly used to resolve against a
// real `@sinclair/typebox` install. The runtime dep was replaced with the Zod-backed
// shim under `extensibility/typebox.ts`; plugins still importing the public name
// are redirected to that shim so existing extensions keep working without code
// changes. Submodules like `@sinclair/typebox/compiler` are intentionally not
// remapped — those expose TypeBox-only APIs the shim does not provide and plugins
// relying on them must vendor `@sinclair/typebox` directly.
const TYPEBOX_SPECIFIER = "@sinclair/typebox";
const TYPEBOX_SPECIFIER_FILTER = /^@sinclair\/typebox$/;
const TYPEBOX_SHIM_PATH = path.resolve(import.meta.dir, "../typebox.ts");
const EARENDIL_PI_CODING_AGENT_FACADE_PATH = path.resolve(import.meta.dir, "legacy-pi-facade.ts");

let isLegacyPiSpecifierShimInstalled = false;

function remapLegacyPiSpecifier(specifier: string): string | null {
	if (!LEGACY_PI_SPECIFIER_FILTER.test(specifier)) {
		return null;
	}
	const slashIdx = specifier.indexOf("/", 1);
	// Filter guarantees a slash exists, but guard anyway to keep the type narrow.
	if (slashIdx === -1) {
		return null;
	}
	const scope = specifier.slice(1, slashIdx);
	const rest = specifier.slice(slashIdx + 1);
	if (rest === "pi-coding-agent" || rest === "pi-coding-agent/extensibility/extensions") {
		return EARENDIL_PI_CODING_AGENT_FACADE_PATH;
	}
	if (!CANONICALIZED_PI_SCOPE_ALIASES.includes(scope as (typeof CANONICALIZED_PI_SCOPE_ALIASES)[number])) {
		return null;
	}
	const remappedSubpath = PI_SUBPATH_REMAPS.get(rest) ?? rest;
	return `${CANONICAL_PI_SCOPE}/${remappedSubpath}`;
}

function getResolvedSpecifier(specifier: string): string {
	const cached = resolvedSpecifierFallbacks.get(specifier);
	if (cached) {
		return cached;
	}

	const resolved = Bun.resolveSync(specifier, import.meta.dir);
	resolvedSpecifierFallbacks.set(specifier, resolved);
	return resolved;
}

function resolveRemappedLegacyPiSpecifier(specifier: string): string | null {
	const remapped = remapLegacyPiSpecifier(specifier);
	if (!remapped) return null;
	return path.isAbsolute(remapped) ? remapped : getResolvedSpecifier(remapped);
}

function toImportSpecifier(resolvedPath: string): string {
	return url.pathToFileURL(resolvedPath).href;
}

function rewriteLegacyPiImports(source: string): string {
	return source.replace(
		LEGACY_PI_IMPORT_SPECIFIER_REGEX,
		(match, prefix: string, specifier: string, suffix: string) => {
			const resolved = resolveRemappedLegacyPiSpecifier(specifier);
			if (!resolved) {
				return match;
			}

			try {
				return `${prefix}${toImportSpecifier(resolved)}${suffix}`;
			} catch {
				// Resolution from the bundled binary root failed (e.g. compiled binary
				// loading a workspace extension). Leave the specifier unchanged so
				// `rewriteBareImportsForLegacyExtension` can resolve it from the
				// extension's real directory instead.
				return match;
			}
		},
	);
}

// Match static imports plus dynamic `import("...")` / `import('...')` specifiers.
const ANY_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s*\(\s*)["'])([^"']+)(["'])/g;

/** Resolve bare imports against the extension directory before loading mirrored legacy Pi files. */
function isUrlLikeSpecifier(specifier: string): boolean {
	// Windows drive-letter paths (e.g. `C:\foo` or `C:/foo`) also match the URL
	// scheme shape `[A-Za-z][A-Za-z\d+.-]*:`. Treat them as filesystem paths so
	// `toRewrittenImportSpecifier` converts them to `file://` URLs instead of
	// emitting raw paths whose `\n`, `\U`, ... get eaten by TS string-literal
	// escapes inside the mirrored extension file.
	if (/^[a-zA-Z]:[\\/]/.test(specifier)) return false;
	return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier);
}

function shouldPreserveImportSpecifier(specifier: string): boolean {
	return specifier.startsWith(".") || path.isAbsolute(specifier) || isUrlLikeSpecifier(specifier);
}

function toRewrittenImportSpecifier(resolvedPath: string): string {
	return isUrlLikeSpecifier(resolvedPath) ? resolvedPath : toImportSpecifier(resolvedPath);
}

/** Extract an importable file path from an exports entry (string or conditions object). */
function resolveExportsEntry(entry: unknown): string | null {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object") {
		const obj = entry as Record<string, unknown>;
		// Prefer "import" over "default" over "types" (we need a runnable specifier).
		for (const key of ["import", "default", "require"]) {
			if (typeof obj[key] === "string") return obj[key] as string;
		}
	}
	return null;
}

/** Minimal package.json `exports` resolver for bare-specifier fallback in compiled binaries. */
function resolveViaExports(exports: Record<string, unknown>, subpath: string, pkgDir: string): string | null {
	// 1. Exact match  (e.g. "./providers/google")
	const exact = exports[subpath];
	if (exact !== undefined) {
		const resolved = resolveExportsEntry(exact);
		if (resolved) return path.resolve(pkgDir, resolved);
	}

	// 2. Wildcard patterns  (e.g. "./*" → "./src/*.ts")
	for (const [pattern, target] of Object.entries(exports)) {
		if (!pattern.includes("*")) continue;
		const prefix = pattern.slice(0, pattern.indexOf("*"));
		const suffix = pattern.slice(pattern.indexOf("*") + 1);
		if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
			const stem = subpath.slice(prefix.length, subpath.length - suffix.length || undefined);
			const targetStr = resolveExportsEntry(target);
			if (targetStr) {
				const replaced = targetStr.replace("*", stem);
				return path.resolve(pkgDir, replaced);
			}
		}
	}

	return null;
}

const IMPORT_FILE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"] as const;

function resolveExistingImportPath(candidate: string): string | null {
	try {
		const stat = fs1.statSync(candidate);
		if (stat.isFile()) return candidate;
		if (stat.isDirectory()) {
			for (const extension of IMPORT_FILE_EXTENSIONS) {
				const indexPath = path.join(candidate, `index${extension}`);
				try {
					if (fs1.statSync(indexPath).isFile()) return indexPath;
				} catch {}
			}
		}
	} catch {}

	for (const extension of IMPORT_FILE_EXTENSIONS) {
		const filePath = `${candidate}${extension}`;
		try {
			if (fs1.statSync(filePath).isFile()) return filePath;
		} catch {}
	}

	return null;
}

function resolveBareFallback(specifier: string, importerDir: string): string | null {
	const parts = specifier.startsWith("@") ? specifier.split("/", 2) : specifier.split("/", 1);
	const pkgName = parts.join("/");
	let dir = importerDir;
	for (;;) {
		const pkgJsonPath = path.join(dir, "node_modules", pkgName, "package.json");
		try {
			const raw = fs1.readFileSync(pkgJsonPath, "utf-8");
			const pkg = JSON.parse(raw) as { main?: string; module?: string; exports?: Record<string, unknown> };
			const subpath = specifier.slice(pkgName.length); // e.g. "/providers/google" or ""
			const pkgDir = path.dirname(pkgJsonPath);
			const exportSubpath = subpath ? `.${subpath}` : "."; // e.g. "./providers/google" or "."

			// Try exports map first.
			if (pkg.exports) {
				const resolved = resolveViaExports(pkg.exports, exportSubpath, pkgDir);
				if (resolved) return resolveExistingImportPath(resolved) ?? resolved;
			}

			// Fallback: main/module for root imports, direct path for subpaths.
			const candidate = !subpath
				? path.resolve(pkgDir, pkg.module ?? pkg.main ?? "index.js")
				: path.resolve(pkgDir, `.${subpath}`);
			return resolveExistingImportPath(candidate) ?? candidate;
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function rewriteBareImportsForLegacyExtension(source: string, importerPath: string): string {
	const importerDir = path.dirname(importerPath);
	return source.replace(ANY_IMPORT_SPECIFIER_REGEX, (match, prefix: string, specifier: string, suffix: string) => {
		// Skip relative, absolute, URL-style, and already-resolved Node specifiers.
		if (shouldPreserveImportSpecifier(specifier)) {
			return match;
		}
		if (specifier === TYPEBOX_SPECIFIER) {
			return `${prefix}${toRewrittenImportSpecifier(TYPEBOX_SHIM_PATH)}${suffix}`;
		}
		try {
			const resolved = Bun.resolveSync(specifier, importerDir);
			return `${prefix}${toRewrittenImportSpecifier(resolved)}${suffix}`;
		} catch {
			const fallback = resolveBareFallback(specifier, importerDir);
			if (fallback) return `${prefix}${toRewrittenImportSpecifier(fallback)}${suffix}`;
			return match;
		}
	});
}

export async function loadLegacyPiModule(resolvedPath: string): Promise<unknown> {
	if (resolvedPath.endsWith(".js") || resolvedPath.endsWith(".mjs") || resolvedPath.endsWith(".cjs")) {
		// In compiled binaries, Bun.plugin onResolve/onLoad hooks do not fire
		// for imports within dynamically import()-ed .js files. Check whether
		// the bundle contains bare @oh-my-pi/* imports that need resolution;
		// if not, import directly. Otherwise fall through to the Bun.build()
		// path which transitively resolves all bare specifiers via plugins.
		const raw = await Bun.file(resolvedPath).text();
		const hasBarePiImports = PI_PACKAGE_NAMES.some(pkg => raw.includes(`/${pkg}`));
		const hasTypeBox = raw.includes(TYPEBOX_SPECIFIER);
		if (!hasBarePiImports && !hasTypeBox) {
			return import(`${toImportSpecifier(resolvedPath)}?mtime=${Date.now()}`);
		}
	}

	const root = path.join(os.tmpdir(), "omp-legacy-pi-file", Bun.hash(resolvedPath).toString(36));
	await fs.rm(root, { recursive: true, force: true });
	await fs.mkdir(root, { recursive: true });

	const extensionDir = path.dirname(resolvedPath);
	const outfile = path.join(root, "bundle.mjs");
	let result: Bun.BuildOutput;
	try {
		result = await Bun.build({
			entrypoints: [resolvedPath],
			outdir: root,
			target: "bun",
			format: "esm",
			naming: "bundle.mjs",
			plugins: [
				{
					name: "omp:legacy-pi-build-shim",
					setup(build) {
						build.onResolve({ filter: LEGACY_PI_SPECIFIER_FILTER }, args => {
							const resolved = resolveRemappedLegacyPiSpecifier(args.path);
							return resolved ? { path: resolved } : undefined;
						});
						build.onResolve({ filter: TYPEBOX_SPECIFIER_FILTER }, () => ({
							path: TYPEBOX_SHIM_PATH,
						}));
						build.onResolve({ filter: /^[@a-zA-Z]/ }, args => {
							const dir = args.resolveDir || extensionDir;
							const resolved = resolveBareFallback(args.path, dir);
							if (resolved) return { path: resolved };
							return undefined;
						});
					},
				},
			],
		});
	} catch (err) {
		const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
		throw new Error(`Bundle threw: ${msg}`);
	}

	if (!result.success) {
		const msgs = result.logs.map(l => `${l.level}: ${l.message}`).join("; ");
		throw new Error(`Bundle failed: ${msgs}`);
	}

	return import(`${toImportSpecifier(outfile)}?mtime=${Date.now()}`);
}

function getLoader(path: string): "js" | "jsx" | "ts" | "tsx" {
	if (path.endsWith(".tsx")) {
		return "tsx";
	}
	if (path.endsWith(".jsx")) {
		return "jsx";
	}
	if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) {
		return "ts";
	}
	return "js";
}

function resolveLegacyPiSpecifier(args: { path: string }): { path: string } | undefined {
	const resolved = resolveRemappedLegacyPiSpecifier(args.path);
	return resolved ? { path: resolved } : undefined;
}

function resolveTypeBoxSpecifier(): { path: string } {
	return { path: TYPEBOX_SHIM_PATH };
}

export function installLegacyPiSpecifierShim(): void {
	if (isLegacyPiSpecifierShimInstalled) {
		return;
	}
	isLegacyPiSpecifierShimInstalled = true;

	Bun.plugin({
		name: "omp:legacy-pi-shim",
		setup(build) {
			build.onResolve({ filter: LEGACY_PI_SPECIFIER_FILTER, namespace: "file" }, resolveLegacyPiSpecifier);
			build.onResolve(
				{ filter: LEGACY_PI_SPECIFIER_FILTER, namespace: LEGACY_PI_FILE_NAMESPACE },
				resolveLegacyPiSpecifier,
			);

			build.onResolve({ filter: TYPEBOX_SPECIFIER_FILTER, namespace: "file" }, resolveTypeBoxSpecifier);
			build.onResolve(
				{ filter: TYPEBOX_SPECIFIER_FILTER, namespace: LEGACY_PI_FILE_NAMESPACE },
				resolveTypeBoxSpecifier,
			);

			build.onResolve({ filter: /^omp-legacy-pi-file:/, namespace: "file" }, args => ({
				path: args.path.slice(LEGACY_PI_FILE_PREFIX.length),
				namespace: LEGACY_PI_FILE_NAMESPACE,
			}));

			build.onResolve({ filter: /^(?:\.{1,2}\/|\/)/, namespace: LEGACY_PI_FILE_NAMESPACE }, args => ({
				path: args.path.startsWith("/") ? args.path : Bun.resolveSync(args.path, path.dirname(args.importer)),
				namespace: LEGACY_PI_FILE_NAMESPACE,
			}));

			build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: LEGACY_PI_FILE_NAMESPACE }, async args => {
				const raw = await Bun.file(args.path).text();
				const withLegacyRemap = rewriteLegacyPiImports(raw);
				const withBareResolved = rewriteBareImportsForLegacyExtension(withLegacyRemap, args.path);
				return {
					contents: withBareResolved,
					loader: getLoader(args.path),
				};
			});
			build.onResolve({ filter: /^[@a-zA-Z]/, namespace: "file" }, args => {
				const dir = args.resolveDir || (args.importer ? path.dirname(args.importer) : undefined);
				if (!dir) return undefined;
				const resolved = resolveBareFallback(args.path, dir);
				if (resolved) return { path: resolved };
				return undefined;
			});
		},
	});
}
