export type SemanticLanguage =
	| "typescript"
	| "javascript"
	| "python"
	| "rust"
	| "go"
	| "java"
	| "kotlin"
	| "swift"
	| "markdown"
	| "text";

export type ChunkKind = "function" | "class" | "method" | "module" | "window" | "section";

export interface ChunkRecord {
	chunkId: string;
	path: string;
	language: SemanticLanguage;
	kind: ChunkKind;
	symbol: string | null;
	startLine: number;
	endLine: number;
	content: string;
	contentHash: string;
	fileHash: string;
}

export interface FileRecord {
	path: string;
	fileHash: string;
	mtimeMs: number;
	sizeBytes: number;
	chunks: ChunkRecord[];
}
export interface FileFingerprint {
	path: string;
	fileHash: string;
	mtimeMs: number;
	sizeBytes: number;
}

export interface BuildProgress {
	stage: "discover" | "chunk" | "persist" | "embed" | "done";
	filesDiscovered?: number;
	filesProcessed?: number;
	filesIndexed?: number;
	filesSkipped?: number;
	chunksUpserted?: number;
	embeddingsUpdated?: number;
	embeddingsTotal?: number;
	currentPath?: string;
	message: string;
}

export interface IndexBuildOptions {
	rebuild?: boolean;
	concurrency?: number;
	computeEmbeddings?: boolean;
	embeddingModel?: string;
	embeddingBaseUrl?: string;
	onProgress?: (progress: BuildProgress) => void;
}

export interface IndexBuildStats {
	cwd: string;
	dbPath: string;
	filesDiscovered: number;
	filesIndexed: number;
	filesSkipped: number;
	filesRemoved: number;
	chunksUpserted: number;
	embeddingsUpdated: number;
}

export interface SearchOptions {
	limit: number;
	decompose: boolean;
	rerank: boolean;
	embeddingModel?: string;
	embeddingBaseUrl?: string;
}

export interface SearchResult {
	chunkId: string;
	path: string;
	language: SemanticLanguage;
	kind: ChunkKind;
	symbol: string | null;
	startLine: number;
	endLine: number;
	content: string;
	ftsScore: number;
	heuristicScore: number;
	embeddingScore: number | null;
	finalScore: number;
	matchedQuery: string;
}

export interface SearchResponse {
	query: string;
	queries: string[];
	reranked: boolean;
	rerankInfo?: EmbeddingProviderConfig;
	results: SearchResult[];
}

export interface IndexStatus {
	cwd: string;
	dbPath: string;
	files: number;
	chunks: number;
	embeddings: number;
	lastIndexedAt: number | null;
}

export interface EmbeddingProviderConfig {
	baseUrl: string;
	model: string;
}
