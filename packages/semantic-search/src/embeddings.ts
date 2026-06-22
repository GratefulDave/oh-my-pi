import type { EmbeddingProviderConfig } from "./types";

interface OllamaEmbeddingResponse {
	embedding?: number[];
}

interface OpenAIEmbeddingDatum {
	embedding?: number[];
	index?: number;
}

interface OpenAIEmbeddingResponse {
	data?: OpenAIEmbeddingDatum[];
}

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:18790";
const DEFAULT_OLLAMA_MODEL = "snowflake-arctic-embed-l-v2.0-bf16";

export function resolveEmbeddingConfig(model?: string, baseUrl?: string): EmbeddingProviderConfig {
	return {
		model: model ?? Bun.env.OMP_SEMANTIC_SEARCH_EMBEDDING_MODEL ?? DEFAULT_OLLAMA_MODEL,
		baseUrl: stripTrailingSlash(baseUrl ?? Bun.env.OMP_SEMANTIC_SEARCH_EMBEDDING_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL),
	};
}

export async function embedText(
	text: string,
	model?: string,
	baseUrl?: string,
	signal?: AbortSignal,
): Promise<{ config: EmbeddingProviderConfig; vector: number[] }> {
	const { config, vectors } = await embedTexts([text], model, baseUrl, signal);
	const vector = vectors[0];
	if (!vector) {
		throw new Error(`Embedding provider returned no vector for ${config.baseUrl}`);
	}
	return { config, vector };
}

export async function embedTexts(
	texts: string[],
	model?: string,
	baseUrl?: string,
	signal?: AbortSignal,
): Promise<{ config: EmbeddingProviderConfig; vectors: number[][] }> {
	const config = resolveEmbeddingConfig(model, baseUrl);
	if (texts.length === 0) {
		return { config, vectors: [] };
	}
	const openAiResult = await requestOpenAICompatibleEmbeddings(config, texts, signal);
	if (openAiResult.ok) {
		return { config, vectors: openAiResult.vectors };
	}
	if (texts.length === 1) {
		const ollamaResult = await requestOllamaEmbedding(config, texts[0]!, signal);
		if (ollamaResult.ok) {
			return { config, vectors: [ollamaResult.vector] };
		}
		throw new Error(
			[
				`Embedding request failed for ${config.baseUrl}`,
				`openai-compatible: ${openAiResult.error}`,
				`ollama: ${ollamaResult.error}`,
			].join("; "),
		);
	}
	throw new Error(
		[
			`Embedding batch request failed for ${config.baseUrl}`,
			`openai-compatible: ${openAiResult.error}`,
			"ollama fallback unavailable for batch inputs",
		].join("; "),
	);
}

export function cosineSimilarity(left: number[], right: number[]): number {
	if (left.length === 0 || left.length !== right.length) {
		return 0;
	}
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index += 1) {
		const leftValue = left[index] ?? 0;
		const rightValue = right[index] ?? 0;
		dot += leftValue * rightValue;
		leftNorm += leftValue * leftValue;
		rightNorm += rightValue * rightValue;
	}
	if (leftNorm === 0 || rightNorm === 0) {
		return 0;
	}
	return dot / Math.sqrt(leftNorm * rightNorm);
}

async function requestOpenAICompatibleEmbeddings(
	config: EmbeddingProviderConfig,
	texts: string[],
	signal?: AbortSignal,
): Promise<{ ok: true; vectors: number[][] } | { ok: false; error: string }> {
	try {
		const response = await fetch(getOpenAIEmbeddingsUrl(config.baseUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: config.model,
				input: texts.length === 1 ? texts[0] : texts,
				encoding_format: "float",
			}),
			signal,
		});
		if (!response.ok) {
			return { ok: false, error: `${response.status} ${response.statusText}` };
		}
		const payload = (await response.json()) as OpenAIEmbeddingResponse;
		const vectors = (payload.data ?? [])
			.map(item => item.embedding)
			.filter((vector): vector is number[] => Array.isArray(vector) && vector.length > 0);
		if (vectors.length !== texts.length) {
			return { ok: false, error: `expected ${texts.length} vectors, got ${vectors.length}` };
		}
		return { ok: true, vectors };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function requestOllamaEmbedding(
	config: EmbeddingProviderConfig,
	text: string,
	signal?: AbortSignal,
): Promise<{ ok: true; vector: number[] } | { ok: false; error: string }> {
	try {
		const response = await fetch(`${config.baseUrl}/api/embeddings`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: config.model, prompt: text }),
			signal,
		});
		if (!response.ok) {
			return { ok: false, error: `${response.status} ${response.statusText}` };
		}
		const payload = (await response.json()) as OllamaEmbeddingResponse;
		if (!Array.isArray(payload.embedding) || payload.embedding.length === 0) {
			return { ok: false, error: "no vector in Ollama response" };
		}
		return { ok: true, vector: payload.embedding };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function getOpenAIEmbeddingsUrl(baseUrl: string): string {
	if (baseUrl.endsWith("/v1")) {
		return `${baseUrl}/embeddings`;
	}
	return `${baseUrl}/v1/embeddings`;
}

function stripTrailingSlash(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}