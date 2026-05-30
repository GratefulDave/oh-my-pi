/**
 * Classify an install spec as a marketplace plugin reference or a plain npm package.
 *
 *  1. Starts with `npm:` -> npm package with the prefix stripped.
 *  2. Starts with `@` (scoped npm) -> always npm.
 *  3. Contains `@` after the first character -> split on the LAST `@`.
 *     If the right-hand side is a known marketplace name, it's a marketplace ref.
 *     Otherwise it's an npm spec (e.g. `pkg@1.2.3`).
 *  4. No `@` -> npm.
 */
// Common npm dist-tags that should never be interpreted as marketplace names
const NPM_DIST_TAGS = new Set([
	"latest",
	"next",
	"beta",
	"alpha",
	"canary",
	"rc",
	"dev",
	"stable",
	"nightly",
	"experimental",
]);

// Semver-like: starts with digit, or contains version range prefixes
const LOOKS_LIKE_VERSION = /^[\d~^>=<]/;

export function classifyInstallTarget(
	spec: string,
	knownMarketplaces: Set<string>,
): { type: "marketplace"; name: string; marketplace: string } | { type: "npm"; spec: string } {
	// Rule 1: explicit npm URI accepted for compatibility with `pi install npm:<pkg>`.
	if (spec.startsWith("npm:")) return { type: "npm", spec: spec.slice("npm:".length) };
	// Rule 2: scoped npm package — @ at position 0 is never a marketplace separator.
	if (spec.startsWith("@")) return { type: "npm", spec };
	// Rule 3: @ somewhere after the first character.
	const atIdx = spec.lastIndexOf("@");
	if (atIdx > 0) {
		const rhs = spec.slice(atIdx + 1);
		// Dist-tags and version specifiers are never marketplace names.
		if (NPM_DIST_TAGS.has(rhs) || LOOKS_LIKE_VERSION.test(rhs)) {
			return { type: "npm", spec };
		}
		if (knownMarketplaces.has(rhs)) {
			return { type: "marketplace", name: spec.slice(0, atIdx), marketplace: rhs };
		}
		// Not a known marketplace — treat as npm version specifier.
		return { type: "npm", spec };
	}
	// Rule 4: no @ at all.
	return { type: "npm", spec };
}
