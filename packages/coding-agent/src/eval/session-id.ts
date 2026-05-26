export interface EvalSessionIdentitySource {
	cwd: string;
	sessionFile?: string | null;
}

export function defaultEvalSessionId(source: EvalSessionIdentitySource): string {
	return source.sessionFile ? `session:${source.sessionFile}:cwd:${source.cwd}` : `cwd:${source.cwd}`;
}
