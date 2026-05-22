import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import type { ChunkRecord, FileFingerprint, IndexStatus } from "./types";

interface CandidateRow {
	chunk_id: string;
	path: string;
	language: string;
	kind: string;
	symbol: string | null;
	start_line: number;
	end_line: number;
	content: string;
	fts_score: number;
}

interface StatusRow {
	files: number;
	chunks: number;
	embeddings: number;
	last_indexed_at: number | null;
}

interface FileRow {
	path: string;
	file_hash: string;
	mtime_ms: number;
	size_bytes: number;
}

interface EmbeddingCandidateRow {
	chunk_id: string;
	path: string;
	language: string;
	kind: string;
	symbol: string | null;
	start_line: number;
	end_line: number;
	content: string;
	vector: string;
}

export class SemanticSearchDatabase {
	#db: Database;

	constructor(readonly dbPath: string) {
		this.#db = new Database(dbPath, { create: true });
		this.#db.run("PRAGMA journal_mode = WAL");
		this.#db.run("PRAGMA busy_timeout = 30000");
		this.#db.run("PRAGMA synchronous = NORMAL");
		this.#initialize();
	}

	#initialize(): void {
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS metadata (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`);
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS files (
				path TEXT PRIMARY KEY,
				file_hash TEXT NOT NULL,
				mtime_ms REAL NOT NULL,
				size_bytes INTEGER NOT NULL,
				indexed_at INTEGER NOT NULL
			)
		`);
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS chunks (
				chunk_id TEXT PRIMARY KEY,
				path TEXT NOT NULL,
				language TEXT NOT NULL,
				kind TEXT NOT NULL,
				symbol TEXT,
				start_line INTEGER NOT NULL,
				end_line INTEGER NOT NULL,
				file_hash TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				content TEXT NOT NULL
			)
		`);
		this.#db.run("CREATE INDEX IF NOT EXISTS chunks_path_idx ON chunks(path)");
		this.#db.run("CREATE INDEX IF NOT EXISTS chunks_symbol_idx ON chunks(symbol)");
		this.#db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
				chunk_id UNINDEXED,
				content,
				symbol,
				path,
				tokenize = 'unicode61 remove_diacritics 2'
			)
		`);
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS embeddings (
				chunk_id TEXT PRIMARY KEY,
				model TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				vector TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
	}

	close(): void {
		this.checkpoint();
		this.#db.close();
	}

	checkpoint(): void {
		this.#db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	}

	async hardReset(): Promise<void> {
		this.close();
		await fs.rm(this.dbPath, { force: true });
	}

	listIndexedFiles(): Map<string, FileFingerprint> {
		const rows = this.#db
			.query<FileRow, []>("SELECT path, file_hash, mtime_ms, size_bytes FROM files")
			.all();
		return new Map(
			rows.map(row => [
				row.path,
				{
					path: row.path,
					fileHash: row.file_hash,
					mtimeMs: row.mtime_ms,
					sizeBytes: row.size_bytes,
				},
			]),
		);
	}

	upsertFile(file: FileFingerprint, chunks: ChunkRecord[], indexedAt: number): number {
		const removeChunks = this.#db.prepare("DELETE FROM chunks WHERE path = ?");
		const removeFts = this.#db.prepare("DELETE FROM chunks_fts WHERE path = ?");
		const removeEmbeddings = this.#db.prepare("DELETE FROM embeddings WHERE chunk_id = ?");
		const selectChunkIds = this.#db.prepare<{ chunk_id: string }, [string]>("SELECT chunk_id FROM chunks WHERE path = ?");
		const upsertFile = this.#db.prepare(
			`INSERT OR REPLACE INTO files (path, file_hash, mtime_ms, size_bytes, indexed_at)
			 VALUES (?, ?, ?, ?, ?)`,
		);
		const insertChunk = this.#db.prepare(
			`INSERT INTO chunks (chunk_id, path, language, kind, symbol, start_line, end_line, file_hash, content_hash, content)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const insertFts = this.#db.prepare(
			"INSERT INTO chunks_fts (chunk_id, content, symbol, path) VALUES (?, ?, ?, ?)",
		);
		const run = this.#db.transaction(() => {
			const previousChunkIds = selectChunkIds.all(file.path).map(row => row.chunk_id);
			removeChunks.run(file.path);
			removeFts.run(file.path);
			for (const chunkId of previousChunkIds) {
				removeEmbeddings.run(chunkId);
			}
			for (const chunk of chunks) {
				insertChunk.run(
					chunk.chunkId,
					chunk.path,
					chunk.language,
					chunk.kind,
					chunk.symbol,
					chunk.startLine,
					chunk.endLine,
					chunk.fileHash,
					chunk.contentHash,
					chunk.content,
				);
				insertFts.run(chunk.chunkId, buildChunkSearchText(chunk), chunk.symbol, chunk.path);
			}
			upsertFile.run(file.path, file.fileHash, file.mtimeMs, file.sizeBytes, indexedAt);
		});
		run();
		return chunks.length;
	}

	removeMissingFiles(currentPaths: Set<string>): number {
		const paths = this.#db.query<{ path: string }, []>("SELECT path FROM files").all().map(row => row.path);
		const selectChunkIds = this.#db.prepare<{ chunk_id: string }, [string]>("SELECT chunk_id FROM chunks WHERE path = ?");
		const removeChunks = this.#db.prepare("DELETE FROM chunks WHERE path = ?");
		const removeFts = this.#db.prepare("DELETE FROM chunks_fts WHERE path = ?");
		const removeEmbeddings = this.#db.prepare("DELETE FROM embeddings WHERE chunk_id = ?");
		const removeFile = this.#db.prepare("DELETE FROM files WHERE path = ?");
		let removed = 0;
		const run = this.#db.transaction(() => {
			for (const storedPath of paths) {
				if (currentPaths.has(storedPath)) {
					continue;
				}
				const chunkIds = selectChunkIds.all(storedPath).map(row => row.chunk_id);
				removeChunks.run(storedPath);
				removeFts.run(storedPath);
				for (const chunkId of chunkIds) {
					removeEmbeddings.run(chunkId);
				}
				removeFile.run(storedPath);
				removed += 1;
			}
		});
		run();
		return removed;
	}

	searchCandidates(matchQuery: string, limit: number): CandidateRow[] {
		const query = this.#db.prepare<
			CandidateRow,
			[string, number]
		>(
			`SELECT
				chunks.chunk_id,
				chunks.path,
				chunks.language,
				chunks.kind,
				chunks.symbol,
				chunks.start_line,
				chunks.end_line,
				chunks.content,
				bm25(chunks_fts, 5.0, 2.5, 1.5) AS fts_score
			 FROM chunks_fts
			 JOIN chunks ON chunks.chunk_id = chunks_fts.chunk_id
			 WHERE chunks_fts MATCH ?
			 ORDER BY fts_score
			 LIMIT ?`,
		);
		return query.all(matchQuery, limit);
	}

	searchPathAndSymbolCandidates(queryText: string, limit: number): CandidateRow[] {
		const pattern = `%${queryText.toLowerCase()}%`;
		return this.#db
			.query<CandidateRow, [string, string, string, number]>(
				`SELECT
					chunk_id,
					path,
					language,
					kind,
					symbol,
					start_line,
					end_line,
					content,
					0.0 AS fts_score
				 FROM chunks
				 WHERE lower(path) LIKE ? OR lower(coalesce(symbol, '')) LIKE ?
				 ORDER BY CASE WHEN lower(coalesce(symbol, '')) LIKE ? THEN 0 ELSE 1 END, length(path)
				 LIMIT ?`,
			)
			.all(pattern, pattern, pattern, limit);
	}

	readEmbedding(chunkId: string, model: string): { vector: number[]; contentHash: string } | null {
		const row = this.#db
			.query<{ vector: string; content_hash: string }, [string, string]>(
				"SELECT vector, content_hash FROM embeddings WHERE chunk_id = ? AND model = ?",
			)
			.get(chunkId, model);
		if (!row) {
			return null;
		}
		return {
			vector: JSON.parse(row.vector) as number[],
			contentHash: row.content_hash,
		};
	}

	writeEmbedding(chunkId: string, model: string, contentHash: string, vector: number[], updatedAt: number): void {
		this.#db
			.prepare(
				`INSERT OR REPLACE INTO embeddings (chunk_id, model, content_hash, vector, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(chunkId, model, contentHash, JSON.stringify(vector), updatedAt);
	}

	listChunksNeedingEmbeddings(model: string): Array<{ chunkId: string; contentHash: string; content: string }> {
		return this.#db
			.query<{ chunk_id: string; content_hash: string; content: string }, [string]>(
				`SELECT chunks.chunk_id, chunks.content_hash, chunks.content
				 FROM chunks
				 LEFT JOIN embeddings ON embeddings.chunk_id = chunks.chunk_id AND embeddings.model = ?
				 WHERE embeddings.chunk_id IS NULL OR embeddings.content_hash != chunks.content_hash`,
			)
			.all(model)
			.map(row => ({ chunkId: row.chunk_id, contentHash: row.content_hash, content: row.content }));
	}

	getChunkContentHash(chunkId: string): string | null {
		return this.#db
			.query<{ content_hash: string }, [string]>("SELECT content_hash FROM chunks WHERE chunk_id = ?")
			.get(chunkId)?.content_hash ?? null;
	}

	listEmbeddingCandidates(model: string): Array<{
		chunkId: string;
		path: string;
		language: string;
		kind: string;
		symbol: string | null;
		startLine: number;
		endLine: number;
		content: string;
		vector: number[];
	}> {
		return this.#db
			.query<EmbeddingCandidateRow, [string]>(
				`SELECT
					chunks.chunk_id,
					chunks.path,
					chunks.language,
					chunks.kind,
					chunks.symbol,
					chunks.start_line,
					chunks.end_line,
					chunks.content,
					embeddings.vector
				 FROM embeddings
				 JOIN chunks ON chunks.chunk_id = embeddings.chunk_id
				 WHERE embeddings.model = ?`,
			)
			.all(model)
			.map(row => ({
				chunkId: row.chunk_id,
				path: row.path,
				language: row.language,
				kind: row.kind,
				symbol: row.symbol,
				startLine: row.start_line,
				endLine: row.end_line,
				content: row.content,
				vector: JSON.parse(row.vector) as number[],
			}));
	}

	readStatus(cwd: string): IndexStatus {
		const row = this.#db
			.query<StatusRow, []>(
				`SELECT
					(SELECT COUNT(*) FROM files) AS files,
					(SELECT COUNT(*) FROM chunks) AS chunks,
					(SELECT COUNT(*) FROM embeddings) AS embeddings,
					(SELECT MAX(indexed_at) FROM files) AS last_indexed_at`,
			)
			.get();
		return {
			cwd,
			dbPath: this.dbPath,
			files: row?.files ?? 0,
			chunks: row?.chunks ?? 0,
			embeddings: row?.embeddings ?? 0,
			lastIndexedAt: row?.last_indexed_at ?? null,
		};
	}
}

function buildChunkSearchText(chunk: ChunkRecord): string {
	const pieces = [
		chunk.content,
		normalizeSearchText(chunk.content),
		chunk.symbol ?? "",
		normalizeSearchText(chunk.symbol ?? ""),
		chunk.path,
		normalizeSearchText(chunk.path),
	];
	return pieces.filter(piece => piece.length > 0).join("\n");
}

function normalizeSearchText(input: string): string {
	return input
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[^a-zA-Z0-9_]+/g, " ")
		.toLowerCase()
		.trim();
}
