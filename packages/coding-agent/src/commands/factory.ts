import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";

import { type FactoryAction, type FactoryCommandArgs, printFactoryHelp, runFactoryCommand } from "../cli/factory-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: FactoryAction[] = ["init", "status", "doctor"];
const PRESETS = ["minimal", "standard", "software-factory"] as const;

export default class Factory extends Command {
	static description = "Scaffold project-scoped software-factory workflows (guide: docs/software-factory.md)";

	static examples = [
		"# Preview scaffold without writing files\n  lex factory init --dry-run",
		"# Scaffold fuller repo-local workflow assets\n  lex factory init --preset software-factory --existing",
		"# Validate current repo scaffold\n  lex factory doctor",
		"# Full guide\n  docs/software-factory.md",
	];

	static args = {
		action: Args.string({
			description: "Factory action",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		preset: Flags.string({ description: "Template preset for init", options: [...PRESETS] }),
		json: Flags.boolean({ description: "Output JSON" }),
		"dry-run": Flags.boolean({ description: "Preview scaffold without writing files" }),
		yes: Flags.boolean({ char: "y", description: "Apply init without interactive confirmation" }),
		existing: Flags.boolean({ description: "Conservatively import existing .omp / legacy config roots" }),
		force: Flags.boolean({ description: "Overwrite existing factory-managed files" }),
		"enable-memory": Flags.boolean({ description: "Write project .omp/settings.json with memory.backend=icm" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Factory);
		if (!args.action) {
			printFactoryHelp();
			renderCommandHelp("lex", "factory", Factory);
			return;
		}
		const cmd: FactoryCommandArgs = {
			action: args.action as FactoryAction,
			flags: {
				preset: flags.preset as FactoryCommandArgs["flags"]["preset"],
				json: flags.json,
				dryRun: flags["dry-run"],
				yes: flags.yes,
				existing: flags.existing,
				force: flags.force,
				enableMemory: flags["enable-memory"],
			},
		};
		await initTheme();
		await runFactoryCommand(cmd);
	}
}
