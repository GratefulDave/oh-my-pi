import { Container, Input, Spacer, Text } from "@oh-my-pi/pi-tui";
import { DEFAULT_MODEL_PROFILE_NAME, type Settings } from "../../config/settings";
import { theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

export interface ProfileSelectorCallbacks {
	onSelect(name: string | undefined): void | Promise<void>;
	onCreate(name: string): void | Promise<void>;
	onCancel(): void;
}

export class ProfileSelectorComponent extends Container {
	#input = new Input();
	#profiles: string[];
	#callbacks: ProfileSelectorCallbacks;

	constructor(settings: Settings, callbacks: ProfileSelectorCallbacks) {
		super();
		this.#profiles = [DEFAULT_MODEL_PROFILE_NAME, ...Object.keys(settings.getModelProfiles()).sort()];
		this.#callbacks = callbacks;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Model profiles"), 0, 0));
		this.addChild(new Text("Type an existing profile name to switch, or a new name to create.", 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		for (const profile of this.#profiles) {
			this.addChild(new Text(`  ${profile}`, 0, 0));
		}
		this.addChild(new DynamicBorder());
		this.#input.onSubmit = () => {
			const value = this.#input.getValue().trim();
			if (!value) {
				this.#callbacks.onCancel();
				return;
			}
			if (value === DEFAULT_MODEL_PROFILE_NAME) {
				void this.#callbacks.onSelect(undefined);
				return;
			}
			if (this.#profiles.includes(value)) {
				void this.#callbacks.onSelect(value);
				return;
			}
			void this.#callbacks.onCreate(value);
		};
	}
}
