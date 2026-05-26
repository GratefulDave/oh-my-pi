import type { FactoryWorkflowDefinition } from "./config";

export interface FactoryWorkflowLaunch {
	workflow: FactoryWorkflowDefinition;
	message: string;
}

export function validateWorkflowDefinition(workflow: FactoryWorkflowDefinition): string[] {
	const errors: string[] = [];
	if (!workflow.name.trim()) errors.push("Workflow name is required.");
	if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
		errors.push(`Workflow ${workflow.name || "(unnamed)"} must declare at least one step.`);
		return errors;
	}
	const stepIds = new Set<string>();
	for (const step of workflow.steps) {
		if (!step.id.trim()) errors.push(`Workflow ${workflow.name} has step with empty id.`);
		if (stepIds.has(step.id)) errors.push(`Workflow ${workflow.name} has duplicate step id: ${step.id}`);
		stepIds.add(step.id);
		if (!step.agent.trim()) errors.push(`Workflow ${workflow.name} step ${step.id} is missing agent.`);
		if (!step.prompt.trim()) errors.push(`Workflow ${workflow.name} step ${step.id} is missing prompt.`);
	}
	return errors;
}

export function buildWorkflowLaunchMessage(workflow: FactoryWorkflowDefinition, originalRequest: string): string {
	const header = `Start workflow ${workflow.name}: ${workflow.description}`;
	const steps = workflow.steps.map((step, index) => `${index + 1}. ${step.id} via ${step.agent} using ${step.prompt}`).join("\n");
	return `${header}\n\nOriginal request:\n${originalRequest}\n\nSteps:\n${steps}`;
}

export function createWorkflowLaunch(workflow: FactoryWorkflowDefinition, originalRequest: string): FactoryWorkflowLaunch {
	return {
		workflow,
		message: buildWorkflowLaunchMessage(workflow, originalRequest),
	};
}
