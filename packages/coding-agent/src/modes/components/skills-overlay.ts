/**
 * Skills overlay component.
 *
 * Renders a toggle list for skill sources and individual skills.
 * Enter or Space toggles a source or skill. Esc calls onDone.
 */
import { Container, matchesKey, type SelectItem, SelectList } from "@oh-my-pi/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

export interface SkillsSourceToggle {
	id: string;
	label: string;
	enabled: boolean;
	provider?: string;
}

export interface SkillsSkillToggle {
	name: string;
	source: string;
	enabled: boolean;
}

export interface SkillsOverlayCallbacks {
	onToggleSource: (id: string) => void;
	onToggleSkill: (name: string) => void;
	onDone: () => void;
}

const SOURCE_PREFIX = "source:";
const SKILL_PREFIX = "skill:";
const DONE_VALUE = "done";
const DIVIDER_VALUE = "__divider__";

export class SkillsOverlayComponent extends Container {
	#sources: SkillsSourceToggle[];
	#skills: SkillsSkillToggle[];
	#callbacks: SkillsOverlayCallbacks;
	#selectList: SelectList | null = null;

	constructor(sources: SkillsSourceToggle[], skills: SkillsSkillToggle[], callbacks: SkillsOverlayCallbacks) {
		super();
		this.#sources = sources;
		this.#skills = skills;
		this.#callbacks = callbacks;
		this.#buildLayout();
	}

	handleInput(data: string): void {
		this.#selectList?.handleInput(matchesKey(data, "space") ? "\n" : data);
	}

	#buildLayout(): void {
		const items = this.#buildItems();
		this.clear();
		this.addChild(new DynamicBorder());
		this.#selectList = new SelectList(items, Math.min(items.length, 25), getSelectListTheme());
		this.#wireSelectList();
		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
	}

	#rebuild(): void {
		const selectedValue = this.#selectList?.getSelectedItem?.()?.value;

		const items = this.#buildItems();
		this.clear();
		this.addChild(new DynamicBorder());
		this.#selectList = new SelectList(items, Math.min(items.length, 25), getSelectListTheme());
		this.#wireSelectList();

		if (selectedValue) {
			const newIndex = items.findIndex(i => i.value === selectedValue);
			if (newIndex !== -1) {
				this.#selectList.setSelectedIndex(newIndex);
			}
		}

		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
	}

	#wireSelectList(): void {
		const list = this.#selectList;
		if (!list) return;

		list.onSelect = item => {
			if (item.value.startsWith(SOURCE_PREFIX)) {
				const id = item.value.slice(SOURCE_PREFIX.length);
				this.#callbacks.onToggleSource(id);
				const src = this.#sources.find(s => s.id === id);
				if (src) {
					src.enabled = !src.enabled;
				}
				this.#rebuild();
			} else if (item.value.startsWith(SKILL_PREFIX)) {
				const name = item.value.slice(SKILL_PREFIX.length);
				this.#callbacks.onToggleSkill(name);
				const sk = this.#skills.find(s => s.name === name);
				if (sk) {
					sk.enabled = !sk.enabled;
				}
				this.#rebuild();
			} else if (item.value === DONE_VALUE) {
				this.#callbacks.onDone();
			}
		};

		list.onCancel = () => {
			this.#callbacks.onDone();
		};
	}

	#buildItems(): SelectItem[] {
		const items: SelectItem[] = [];

		// Source toggles
		for (const src of this.#sources) {
			const check = src.enabled ? "✓" : " ";
			items.push({
				value: `${SOURCE_PREFIX}${src.id}`,
				label: `[${check}] ${src.label}`,
			});
		}

		// Divider
		if (items.length > 0) {
			items.push({ value: DIVIDER_VALUE, label: "─".repeat(30) });
		}

		// Build set of disabled provider names for dimming skills
		const disabledProviders = new Set<string>();
		for (const src of this.#sources) {
			if (src.provider && !src.enabled) {
				disabledProviders.add(src.provider);
			}
		}

		// Skill toggles
		for (const sk of this.#skills) {
			const check = sk.enabled ? "✓" : " ";
			let label = `[${check}] ${sk.name} (${sk.source})`;

			// Dim skills whose provider source is disabled
			for (const provider of disabledProviders) {
				if (label.toLowerCase().includes(provider.toLowerCase())) {
					label = theme.fg("dim", label);
					break;
				}
			}

			items.push({
				value: `${SKILL_PREFIX}${sk.name}`,
				label,
			});
		}

		// Done
		items.push({ value: DONE_VALUE, label: "[Done]" });

		return items;
	}
}
