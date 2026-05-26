export interface TemplateManifestEntry {
	source: string;
	target: string;
}

export interface TemplateManifest {
	name: string;
	version: string;
	description: string;
	files: TemplateManifestEntry[];
}

const SOFTWARE_FACTORY_MANIFEST: TemplateManifest = {
	name: "software-factory",
	version: "0.1.0",
	description: "Project-scoped verifier, safety, workflow, and learning scaffolds for lex/OMP.",
	files: [
		{ source: ".omp/settings.json", target: ".omp/settings.json" },
		{ source: ".omp/extensions/software-factory/package.json", target: ".omp/extensions/software-factory/package.json" },
		{ source: ".omp/extensions/software-factory/index.ts", target: ".omp/extensions/software-factory/index.ts" },
		{ source: ".omp/extensions/software-factory/config.ts", target: ".omp/extensions/software-factory/config.ts" },
		{ source: ".omp/extensions/software-factory/paths.ts", target: ".omp/extensions/software-factory/paths.ts" },
		{ source: ".omp/extensions/software-factory/safety.ts", target: ".omp/extensions/software-factory/safety.ts" },
		{ source: ".omp/extensions/software-factory/verifier.ts", target: ".omp/extensions/software-factory/verifier.ts" },
		{ source: ".omp/extensions/software-factory/workflow.ts", target: ".omp/extensions/software-factory/workflow.ts" },
		{ source: ".omp/extensions/software-factory/ipc.ts", target: ".omp/extensions/software-factory/ipc.ts" },
		{ source: ".omp/factory/factory.json", target: ".omp/factory/factory.json" },
		{ source: ".omp/factory/safety.rules.json", target: ".omp/factory/safety.rules.json" },
		{ source: ".omp/factory/workflows/piter.json", target: ".omp/factory/workflows/piter.json" },
		{ source: ".omp/factory/workflows/verifier.json", target: ".omp/factory/workflows/verifier.json" },
		{ source: ".omp/factory/prompts/meta-prompt.md", target: ".omp/factory/prompts/meta-prompt.md" },
		{ source: ".omp/factory/prompts/verify-on-stop.md", target: ".omp/factory/prompts/verify-on-stop.md" },
		{ source: ".omp/factory/prompts/builder-error.md", target: ".omp/factory/prompts/builder-error.md" },
		{ source: ".omp/factory/prompts/workflow-step.md", target: ".omp/factory/prompts/workflow-step.md" },
		{ source: ".omp/factory/scripts/verify.sh", target: ".omp/factory/scripts/verify.sh" },
		{ source: ".omp/factory/memory/learning-policy.md", target: ".omp/factory/memory/learning-policy.md" },
		{ source: ".omp/factory/memory/retention-rules.md", target: ".omp/factory/memory/retention-rules.md" },
		{ source: ".omp/agents/factory-verifier.md", target: ".omp/agents/factory-verifier.md" },
		{ source: ".omp/agents/factory-reviewer.md", target: ".omp/agents/factory-reviewer.md" },
		{ source: ".omp/agents/factory-planner.md", target: ".omp/agents/factory-planner.md" },
		{ source: ".omp/agents/factory-implementer.md", target: ".omp/agents/factory-implementer.md" },
		{ source: ".omp/prompts/factory-meta-prompt.md", target: ".omp/prompts/factory-meta-prompt.md" },
		{ source: ".omp/rules/factory-software-factory.md", target: ".omp/rules/factory-software-factory.md" },
		{ source: ".omp/skills/factory-software-factory/SKILL.md", target: ".omp/skills/factory-software-factory/SKILL.md" },
	],
};

const TEMPLATE_RELATIVE_PATHS = new Map<string, string>([
	[".omp/settings.json", "./templates/software-factory/.omp/settings.json"],
	[".omp/extensions/software-factory/package.json", "./templates/software-factory/.omp/extensions/software-factory/package.json"],
	[".omp/extensions/software-factory/index.ts", "./templates/software-factory/.omp/extensions/software-factory/index.ts"],
	[".omp/extensions/software-factory/config.ts", "./templates/software-factory/.omp/extensions/software-factory/config.ts"],
	[".omp/extensions/software-factory/paths.ts", "./templates/software-factory/.omp/extensions/software-factory/paths.ts"],
	[".omp/extensions/software-factory/safety.ts", "./templates/software-factory/.omp/extensions/software-factory/safety.ts"],
	[".omp/extensions/software-factory/verifier.ts", "./templates/software-factory/.omp/extensions/software-factory/verifier.ts"],
	[".omp/extensions/software-factory/workflow.ts", "./templates/software-factory/.omp/extensions/software-factory/workflow.ts"],
	[".omp/extensions/software-factory/ipc.ts", "./templates/software-factory/.omp/extensions/software-factory/ipc.ts"],
	[".omp/factory/factory.json", "./templates/software-factory/.omp/factory/factory.json"],
	[".omp/factory/safety.rules.json", "./templates/software-factory/.omp/factory/safety.rules.json"],
	[".omp/factory/workflows/piter.json", "./templates/software-factory/.omp/factory/workflows/piter.json"],
	[".omp/factory/workflows/verifier.json", "./templates/software-factory/.omp/factory/workflows/verifier.json"],
	[".omp/factory/prompts/meta-prompt.md", "./templates/software-factory/.omp/factory/prompts/meta-prompt.md"],
	[".omp/factory/prompts/verify-on-stop.md", "./templates/software-factory/.omp/factory/prompts/verify-on-stop.md"],
	[".omp/factory/prompts/builder-error.md", "./templates/software-factory/.omp/factory/prompts/builder-error.md"],
	[".omp/factory/prompts/workflow-step.md", "./templates/software-factory/.omp/factory/prompts/workflow-step.md"],
	[".omp/factory/scripts/verify.sh", "./templates/software-factory/.omp/factory/scripts/verify.sh"],
	[".omp/factory/memory/learning-policy.md", "./templates/software-factory/.omp/factory/memory/learning-policy.md"],
	[".omp/factory/memory/retention-rules.md", "./templates/software-factory/.omp/factory/memory/retention-rules.md"],
	[".omp/agents/factory-verifier.md", "./templates/software-factory/.omp/agents/factory-verifier.md"],
	[".omp/agents/factory-reviewer.md", "./templates/software-factory/.omp/agents/factory-reviewer.md"],
	[".omp/agents/factory-planner.md", "./templates/software-factory/.omp/agents/factory-planner.md"],
	[".omp/agents/factory-implementer.md", "./templates/software-factory/.omp/agents/factory-implementer.md"],
	[".omp/prompts/factory-meta-prompt.md", "./templates/software-factory/.omp/prompts/factory-meta-prompt.md"],
	[".omp/rules/factory-software-factory.md", "./templates/software-factory/.omp/rules/factory-software-factory.md"],
	[".omp/skills/factory-software-factory/SKILL.md", "./templates/software-factory/.omp/skills/factory-software-factory/SKILL.md"],
]);

export function getSoftwareFactoryManifest(): TemplateManifest {
	return SOFTWARE_FACTORY_MANIFEST;
}

export async function getSoftwareFactoryTemplateFile(source: string): Promise<string> {
	const relativePath = TEMPLATE_RELATIVE_PATHS.get(source);
	if (!relativePath) {
		throw new Error(`Unknown software-factory template file: ${source}`);
	}
	return await Bun.file(new URL(relativePath, import.meta.url)).text();
}
