const ALWAYS_ENABLED_AGENT_NAMES: Record<string, true> = { task: true };

export function isAlwaysEnabledAgent(agentName: string): boolean {
	return ALWAYS_ENABLED_AGENT_NAMES[agentName] === true;
}

export function normalizeDisabledAgents(disabledAgents: readonly string[] | undefined): string[] {
	return (disabledAgents ?? []).filter(agentName => !isAlwaysEnabledAgent(agentName));
}
