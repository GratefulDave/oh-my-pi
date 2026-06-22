import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chunkFile } from "./chunker";
import { cosineSimilarity, embedText, embedTexts } from "./embeddings";
import { SemanticSearchDatabase } from "./database";
import { detectLanguage, discoverSourceFiles, hashText, mapLimit, readFileFingerprint, readTextFile } from "./files";
import { ensureSemanticSearchDir, getSemanticSearchDbPath } from "./paths";
import type {
	BuildProgress,
	ChunkRecord,
	IndexBuildOptions,
	IndexBuildStats,
	IndexStatus,
	SearchOptions,
	SearchResponse,
	SearchResult,
} from "./types";

const DEFAULT_INDEX_CONCURRENCY = 8;
const DEFAULT_SEARCH_LIMIT = 10;
const FTS_CANDIDATE_LIMIT_MULTIPLIER = 6;

interface CandidateAccumulator {
	chunkId: string;
	path: string;
	language: ReturnType<typeof detectLanguage>;
	kind: ChunkRecord["kind"];
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

export class SemanticSearchService {
	async buildIndex(cwd: string, options: IndexBuildOptions = {}): Promise<IndexBuildStats> {
		await ensureSemanticSearchDir(cwd);
		const releaseBuildLock = await acquireBuildLock(cwd);
		const dbPath = getSemanticSearchDbPath(cwd);
		const tempDbPath = getBuildTempDbPath(dbPath);
		await prepareBuildDatabase(dbPath, tempDbPath, Boolean(options.rebuild));
		const db = new SemanticSearchDatabase(tempDbPath);
		const discoveredFiles = await discoverSourceFiles(cwd);
		const currentPaths = new Set(discoveredFiles);
		const existingFiles = options.rebuild ? new Map() : db.listIndexedFiles();
		const concurrency = Math.max(1, options.concurrency ?? DEFAULT_INDEX_CONCURRENCY);
		const buildStartedAt = Date.now();
		let buildSucceeded = false;
		let filesProcessed = 0;
		let filesSkipped = 0;
		let filesIndexed = 0;
		let chunksUpserted = 0;
		let embeddingsUpdated = 0;
		const reportProgress = (progress: BuildProgress): void => {
			options.onProgress?.(progress);
		};
		reportProgress({
			stage: "discover",
			filesDiscovered: discoveredFiles.length,
			message: `Discovered ${discoveredFiles.length} candidate files`,
		});
		try {
			const results = await mapLimit(discoveredFiles, concurrency, async relativePath => {
				const existing = existingFiles.get(relativePath);
				const fingerprint = await readFileFingerprint(cwd, relativePath);
				if (!fingerprint) {
					filesProcessed += 1;
					reportChunkProgress(reportProgress, discoveredFiles.length, filesProcessed, filesIndexed, filesSkipped, chunksUpserted, relativePath);
					return { relativePath, skipped: true as const, file: null, chunks: [] as ChunkRecord[] };
				}
				if (
					existing &&
					existing.fileHash === fingerprint.fileHash &&
					existing.mtimeMs === fingerprint.mtimeMs &&
					existing.sizeBytes === fingerprint.sizeBytes
				) {
					filesProcessed += 1;
					reportChunkProgress(reportProgress, discoveredFiles.length, filesProcessed, filesIndexed, filesSkipped + 1, chunksUpserted, relativePath);
					return { relativePath, skipped: true as const, file: fingerprint, chunks: [] as ChunkRecord[] };
				}
				const fileData = await readTextFile(cwd, relativePath);
				if (!fileData) {
					filesProcessed += 1;
					reportChunkProgress(reportProgress, discoveredFiles.length, filesProcessed, filesIndexed, filesSkipped, chunksUpserted, relativePath);
					return { relativePath, skipped: true as const, file: null, chunks: [] as ChunkRecord[] };
				}
				const fileHash = hashText(fileData.text);
				const file = {
					path: relativePath,
					fileHash,
					mtimeMs: fileData.mtimeMs,
					sizeBytes: fileData.sizeBytes,
				};
				const chunks = chunkFile(relativePath, fileData.text, fileHash);
				filesProcessed += 1;
				reportChunkProgress(reportProgress, discoveredFiles.length, filesProcessed, filesIndexed, filesSkipped, chunksUpserted, relativePath);
				return { relativePath, skipped: false as const, file, chunks };
			});
			reportProgress({
				stage: "persist",
				filesDiscovered: discoveredFiles.length,
				filesProcessed,
				message: `Persisting semantic chunks for ${discoveredFiles.length} files`,
			});
			for (const result of results) {
				if (result.skipped || !result.file) {
					filesSkipped += 1;
					continue;
				}
				chunksUpserted += db.upsertFile(result.file, result.chunks, buildStartedAt);
				filesIndexed += 1;
				reportProgress({
					stage: "persist",
					filesDiscovered: discoveredFiles.length,
					filesProcessed,
					filesIndexed,
					filesSkipped,
					chunksUpserted,
					currentPath: result.relativePath,
					message: `Indexed ${filesIndexed}/${discoveredFiles.length} files (${chunksUpserted} chunks)`,
				});
			}
			const filesRemoved = db.removeMissingFiles(currentPaths);
			if (options.computeEmbeddings) {
				embeddingsUpdated = await this.#updateEmbeddings(db, {
					model: options.embeddingModel,
					baseUrl: options.embeddingBaseUrl,
					concurrency,
					onProgress: progress => {
						reportProgress(progress);
					},
				});
			}
			reportProgress({
				stage: "done",
				filesDiscovered: discoveredFiles.length,
				filesProcessed,
				filesIndexed,
				filesSkipped,
				chunksUpserted,
				embeddingsUpdated,
				message: `Finished semantic index build: ${filesIndexed} indexed, ${filesSkipped} skipped, ${chunksUpserted} chunks`,
			});
			buildSucceeded = true;
			return {
				cwd,
				dbPath,
				filesDiscovered: discoveredFiles.length,
				filesIndexed,
				filesSkipped,
				filesRemoved,
				chunksUpserted,
				embeddingsUpdated,
			};
		} finally {
			db.close();
			if (buildSucceeded) {
				await replaceBuildDatabase(tempDbPath, dbPath);
			} else {
				await cleanupBuildDatabase(tempDbPath);
			}
			await releaseBuildLock();
		}
	}

	async search(cwd: string, query: string, options: Partial<SearchOptions> = {}): Promise<SearchResponse> {
		const dbPath = getSemanticSearchDbPath(cwd);
		const limit = Math.max(1, options.limit ?? DEFAULT_SEARCH_LIMIT);
		const queries = options.decompose === false ? [query.trim()] : decomposeQuery(query);
		if (!(await Bun.file(dbPath).exists())) {
			return { query, queries, reranked: false, results: [] };
		}
		const db = new SemanticSearchDatabase(dbPath);
		try {
			const accumulators = new Map<string, CandidateAccumulator>();
			for (const effectiveQuery of queries) {
				const pathCandidates = db.searchPathAndSymbolCandidates(effectiveQuery, limit);
				for (const candidate of pathCandidates) {
					mergeCandidate(accumulators, candidate, effectiveQuery);
				}
				const matchQuery = buildFtsQuery(effectiveQuery);
				if (!matchQuery) {
					continue;
				}
				const ftsCandidates = db.searchCandidates(matchQuery, limit * FTS_CANDIDATE_LIMIT_MULTIPLIER);
				for (const candidate of ftsCandidates) {
					mergeCandidate(accumulators, candidate, effectiveQuery);
				}
			}
			const ranked = [...accumulators.values()]
				.map(candidate => {
					candidate.heuristicScore = computeHeuristicScore(query, candidate);
					candidate.finalScore = candidate.ftsScore + candidate.heuristicScore;
					return candidate;
				})
				.sort((left, right) => right.finalScore - left.finalScore)
				.slice(0, limit * FTS_CANDIDATE_LIMIT_MULTIPLIER);
			let reranked = false;
			let rerankInfo: SearchResponse["rerankInfo"] | undefined;
			if (options.rerank !== false) {
				const queryEmbedding = await embedText(query, options.embeddingModel, options.embeddingBaseUrl);
				rerankInfo = queryEmbedding.config;
				const missingCandidates = ranked.filter(candidate => {
					const cached = db.readEmbedding(candidate.chunkId, queryEmbedding.config.model);
					const currentContentHash = hashText(candidate.content);
					if (cached?.vector && cached.contentHash === currentContentHash) {
						candidate.embeddingScore = cosineSimilarity(queryEmbedding.vector, cached.vector);
						candidate.finalScore = candidate.finalScore + candidate.embeddingScore * 20;
						return false;
					}
					return true;
				});
				if (missingCandidates.length > 0) {
					const embedded = await embedTexts(
						missingCandidates.map(candidate => candidate.content),
						queryEmbedding.config.model,
						queryEmbedding.config.baseUrl,
					);
					for (let index = 0; index < missingCandidates.length; index += 1) {
						const candidate = missingCandidates[index]!;
						const vector = embedded.vectors[index];
						if (!vector) {
							continue;
						}
						const currentContentHash = hashText(candidate.content);
						db.writeEmbedding(candidate.chunkId, embedded.config.model, currentContentHash, vector, Date.now());
						candidate.embeddingScore = cosineSimilarity(queryEmbedding.vector, vector);
						candidate.finalScore = candidate.finalScore + candidate.embeddingScore * 20;
					}
				}
				if (ranked.length === 0) {
					const fallbackCandidates = db
						.listEmbeddingCandidates(queryEmbedding.config.model)
						.map(candidate => {
							const embeddingScore = cosineSimilarity(queryEmbedding.vector, candidate.vector);
							const heuristicCandidate: CandidateAccumulator = {
								chunkId: candidate.chunkId,
								path: candidate.path,
								language: detectLanguage(candidate.path),
								kind: candidate.kind as ChunkRecord["kind"],
								symbol: candidate.symbol,
								startLine: candidate.startLine,
								endLine: candidate.endLine,
								content: candidate.content,
								ftsScore: 0,
								heuristicScore: 0,
								embeddingScore,
								finalScore: 0,
								matchedQuery: query,
							};
							const heuristicScore = computeHeuristicScore(query, heuristicCandidate);
							return {
								...heuristicCandidate,
								heuristicScore,
								finalScore: heuristicScore + embeddingScore * 20,
							};
						})
						.sort((left, right) => right.finalScore - left.finalScore)
						.slice(0, limit * FTS_CANDIDATE_LIMIT_MULTIPLIER);
					ranked.push(...fallbackCandidates);
				}
				reranked = true;
			}
			const results = ranked
				.sort((left, right) => right.finalScore - left.finalScore)
				.slice(0, limit)
				.map<SearchResult>(candidate => ({
					chunkId: candidate.chunkId,
					path: candidate.path,
					language: candidate.language,
					kind: candidate.kind,
					symbol: candidate.symbol,
					startLine: candidate.startLine,
					endLine: candidate.endLine,
					content: candidate.content,
					ftsScore: candidate.ftsScore,
					heuristicScore: candidate.heuristicScore,
					embeddingScore: candidate.embeddingScore,
					finalScore: candidate.finalScore,
					matchedQuery: candidate.matchedQuery,
				}));
			return { query, queries, reranked, rerankInfo, results };
		} finally {
			db.close();
		}
	}

	async readStatus(cwd: string): Promise<IndexStatus> {
		const dbPath = getSemanticSearchDbPath(cwd);
		if (!(await Bun.file(dbPath).exists())) {
			return {
				cwd,
				dbPath,
				files: 0,
				chunks: 0,
				embeddings: 0,
				lastIndexedAt: null,
			};
		}
		const db = new SemanticSearchDatabase(dbPath);
		try {
			return db.readStatus(cwd);
		} finally {
			db.close();
		}
	}

	async #updateEmbeddings(
		db: SemanticSearchDatabase,
		options: {
			model?: string;
			baseUrl?: string;
			concurrency: number;
			onProgress?: (progress: BuildProgress) => void;
		},
	): Promise<number> {
		const model = options.model ?? Bun.env.OMP_SEMANTIC_SEARCH_EMBEDDING_MODEL ?? "snowflake-arctic-embed-l-v2.0-bf16";
		const baseUrl = options.baseUrl ?? Bun.env.OMP_SEMANTIC_SEARCH_EMBEDDING_BASE_URL;
		const pending = db.listChunksNeedingEmbeddings(model);
		if (pending.length === 0) {
			return 0;
		}
		let updated = 0;
		const batchSize = 64;
		for (let start = 0; start < pending.length; start += batchSize) {
			const batch = pending.slice(start, start + batchSize);
			const embedded = await embedTexts(
				batch.map(item => item.content),
				model,
				baseUrl,
			);
			for (let index = 0; index < batch.length; index += 1) {
				const item = batch[index]!;
				const vector = embedded.vectors[index];
				if (!vector) {
					continue;
				}
				db.writeEmbedding(item.chunkId, embedded.config.model, item.contentHash, vector, Date.now());
				updated += 1;
			}
			options.onProgress?.({
				stage: "embed",
				embeddingsUpdated: updated,
				embeddingsTotal: pending.length,
				message: `Embedded ${updated}/${pending.length} semantic chunks`,
				currentPath: batch.at(-1)?.chunkId,
			});
		}
		return updated;
	}
}

function mergeCandidate(
	accumulators: Map<string, CandidateAccumulator>,
	candidate: {
		chunk_id: string;
		path: string;
		language: string;
		kind: string;
		symbol: string | null;
		start_line: number;
		end_line: number;
		content: string;
		fts_score: number;
	},
	matchedQuery: string,
): void {
	const existing = accumulators.get(candidate.chunk_id);
	const ftsScore = normalizeFtsScore(candidate.fts_score);
	if (existing) {
		if (ftsScore > existing.ftsScore) {
			existing.ftsScore = ftsScore;
			existing.matchedQuery = matchedQuery;
		}
		return;
	}
	accumulators.set(candidate.chunk_id, {
		chunkId: candidate.chunk_id,
		path: candidate.path,
		language: detectLanguage(candidate.path),
		kind: candidate.kind as ChunkRecord["kind"],
		symbol: candidate.symbol,
		startLine: candidate.start_line,
		endLine: candidate.end_line,
		content: candidate.content,
		ftsScore,
		heuristicScore: 0,
		embeddingScore: null,
		finalScore: ftsScore,
		matchedQuery,
	});
}

function normalizeFtsScore(rawScore: number): number {
	if (!Number.isFinite(rawScore)) {
		return 0;
	}
	return -rawScore;
}

function buildFtsQuery(query: string): string | null {
	const terms = tokenizeQuery(query);
	if (terms.length === 0) {
		return null;
	}
	return terms.map(term => `${term}*`).join(" ");
}

function tokenizeQuery(query: string): string[] {
	const matches = query.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
	return [...new Set(matches.filter(token => token.length >= 2).slice(0, 12))];
}

export function decomposeQuery(query: string): string[] {
	const normalized = query.trim();
	if (normalized.length === 0) {
		return [];
	}
	if (normalized.length < 70 && !/[;,\n]|\band\b|\bthen\b|\balso\b/i.test(normalized)) {
		return [normalized];
	}
	const parts = normalized
		.split(/(?:\band\b|\bthen\b|\balso\b|[;,\n])/i)
		.map(part => part.trim())
		.filter(part => part.length >= 4);
	const deduped = [...new Set(parts)];
	if (deduped.length <= 1 || deduped.length > 4) {
		return [normalized];
	}
	return [normalized, ...deduped];
}

function computeHeuristicScore(query: string, candidate: CandidateAccumulator): number {
	const loweredQuery = query.toLowerCase();
	const loweredContent = candidate.content.toLowerCase();
	const loweredPath = candidate.path.toLowerCase();
	const loweredSymbol = candidate.symbol?.toLowerCase() ?? "";
	let score = 0;
	if (loweredSymbol.includes(loweredQuery) && loweredQuery.length > 0) {
		score += 18;
	}
	if (loweredPath.includes(loweredQuery) && loweredQuery.length > 0) {
		score += 12;
	}
	if (loweredContent.includes(loweredQuery) && loweredQuery.length > 0) {
		score += 8;
	}
	for (const token of tokenizeQuery(query)) {
		if (loweredSymbol === token) {
			score += 8;
			continue;
		}
		if (loweredSymbol.includes(token)) {
			score += 4;
		}
		if (path.basename(loweredPath) === token || loweredPath.endsWith(`/${token}`)) {
			score += 4;
			continue;
		}
		if (loweredPath.includes(token)) {
			score += 2;
		}
		if (loweredContent.includes(token)) {
			score += 1;
		}
	}
	return score;
}

function reportChunkProgress(
	reportProgress: (progress: BuildProgress) => void,
	filesDiscovered: number,
	filesProcessed: number,
	filesIndexed: number,
	filesSkipped: number,
	chunksUpserted: number,
	currentPath: string,
): void {
	if (filesProcessed % 25 !== 0 && filesProcessed !== filesDiscovered) {
		return;
	}
	reportProgress({
		stage: "chunk",
		filesDiscovered,
		filesProcessed,
		filesIndexed,
		filesSkipped,
		chunksUpserted,
		currentPath,
		message: `Scanned ${filesProcessed}/${filesDiscovered} files`,
	});
}

async function acquireBuildLock(cwd: string): Promise<() => Promise<void>> {
	const lockPath = path.join(cwd, ".omp", "semantic-search", "build.lock");
	const payload = JSON.stringify({
		pid: process.pid,
		startedAt: Date.now(),
		cwd,
	});
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await fs.writeFile(lockPath, payload, { flag: "wx", mode: 0o600 });
			return async () => {
				await fs.rm(lockPath, { force: true });
			};
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code !== "EEXIST") {
				throw error;
			}
			const reclaimed = await tryReclaimStaleBuildLock(cwd, lockPath);
			if (reclaimed) {
				continue;
			}
			let detail = "";
			try {
				detail = await Bun.file(lockPath).text();
			} catch {
				// ignore
			}
			throw new Error(
				detail
					? `Semantic index build already running. Lock: ${detail}`
					: "Semantic index build already running.",
			);
		}
	}
	throw new Error("Failed to acquire semantic index build lock.");
}

function getBuildTempDbPath(dbPath: string): string {
	return getBuildTempDbPathForPid(dbPath, process.pid);
}

function getBuildTempDbPathForPid(dbPath: string, pid: number): string {
	return `${dbPath}.build-${pid}`;
}

async function tryReclaimStaleBuildLock(cwd: string, lockPath: string): Promise<boolean> {
	let detail = "";
	try {
		detail = await Bun.file(lockPath).text();
	} catch {
		return true;
	}
	const parsed = parseBuildLock(detail);
	if (!parsed) {
		await fs.rm(lockPath, { force: true });
		return true;
	}
	const processAlive = isPidAlive(parsed.pid);
	const lockAgeMs = Date.now() - parsed.startedAt;
	if (processAlive && lockAgeMs < 60 * 60 * 1000) {
		return false;
	}
	const staleTempDbPath = getBuildTempDbPathForPid(getSemanticSearchDbPath(cwd), parsed.pid);
	await cleanupBuildDatabase(staleTempDbPath);
	await fs.rm(lockPath, { force: true });
	return true;
}

function parseBuildLock(raw: string): { pid: number; startedAt: number; cwd: string } | null {
	try {
		const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown; cwd?: unknown };
		if (
			typeof parsed.pid === "number" &&
			Number.isFinite(parsed.pid) &&
			typeof parsed.startedAt === "number" &&
			Number.isFinite(parsed.startedAt) &&
			typeof parsed.cwd === "string"
		) {
			return { pid: parsed.pid, startedAt: parsed.startedAt, cwd: parsed.cwd };
		}
		return null;
	} catch {
		return null;
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ESRCH") {
			return false;
		}
		return true;
	}
}

async function prepareBuildDatabase(dbPath: string, tempDbPath: string, rebuild: boolean): Promise<void> {
	await cleanupBuildDatabase(tempDbPath);
	if (rebuild) {
		return;
	}
	if (await Bun.file(dbPath).exists()) {
		await fs.copyFile(dbPath, tempDbPath);
	}
	const walPath = `${dbPath}-wal`;
	if (await Bun.file(walPath).exists()) {
		await fs.copyFile(walPath, `${tempDbPath}-wal`);
	}
	const shmPath = `${dbPath}-shm`;
	if (await Bun.file(shmPath).exists()) {
		await fs.copyFile(shmPath, `${tempDbPath}-shm`);
	}
}

async function replaceBuildDatabase(tempDbPath: string, dbPath: string): Promise<void> {
	await fs.rename(tempDbPath, dbPath);
	await cleanupWalAndShm(dbPath);
}

async function cleanupBuildDatabase(tempDbPath: string): Promise<void> {
	await fs.rm(tempDbPath, { force: true });
	await fs.rm(`${tempDbPath}-wal`, { force: true });
	await fs.rm(`${tempDbPath}-shm`, { force: true });
}

async function cleanupWalAndShm(dbPath: string): Promise<void> {
	await fs.rm(`${dbPath}-wal`, { force: true });
	await fs.rm(`${dbPath}-shm`, { force: true });
}
