export interface FactoryVerifierEnvelope {
	type: "factory-verifier-report";
	status: "verified" | "failed" | "unsure";
	confidence: "PERFECT" | "VERIFIED" | "PARTIAL" | "FEEDBACK" | "FAILED";
	claims: string[];
	gaps: string[];
	correction: string[];
	notes: string[];
	raw: string;
}

export function toVerifierEnvelope(report: FactoryVerifierEnvelope): string {
	return JSON.stringify(report);
}
