/**
 * Local embeddings via Ollama (bge-m3 model).
 * 
 * Zero cost, runs locally. No API key required.
 * bge-m3 produces 1024-dim embeddings — matches our DB schema.
 */

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.EMBEDDING_MODEL || 'bge-m3';

// LRU cache for query embeddings — avoids re-embedding the same text
const CACHE_MAX = 200;
const embeddingCache = new Map<string, { embedding: number[]; ts: number }>();

function getCached(text: string): number[] | null {
  const entry = embeddingCache.get(text);
  if (entry && Date.now() - entry.ts < 3600000) return entry.embedding; // 1hr TTL
  return null;
}

function setCache(text: string, embedding: number[]): void {
  if (embeddingCache.size >= CACHE_MAX) {
    // Evict oldest
    const oldest = [...embeddingCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) embeddingCache.delete(oldest[0]);
  }
  embeddingCache.set(text, { embedding, ts: Date.now() });
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  duration_ms: number;
}

let _warmedUp = false;

/**
 * Warmup the embedding model — call once on startup to avoid cold-start latency.
 */
export async function warmup(): Promise<void> {
  if (_warmedUp) return;
  try {
    await embed('warmup');
    _warmedUp = true;
  } catch { /* model not available */ }
}

/**
 * Generate an embedding for a single text.
 */
export async function embed(text: string): Promise<EmbeddingResult> {
  // Check cache first
  const cached = getCached(text);
  if (cached) return { embedding: cached, model: MODEL, duration_ms: 0 };
  const start = Date.now();
  
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      input: text,
    }),
  });
  
  if (!response.ok) {
    throw new Error(`Ollama embed failed: ${response.status} ${await response.text()}`);
  }
  
  const data = await response.json() as { embeddings: number[][] };
  const duration_ms = Date.now() - start;
  
  const embedding = data.embeddings[0];
  setCache(text, embedding);
  
  return {
    embedding,
    model: MODEL,
    duration_ms,
  };
}

/**
 * Generate embeddings for multiple texts (batched).
 */
export async function embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
  const start = Date.now();
  
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      input: texts,
    }),
  });
  
  if (!response.ok) {
    throw new Error(`Ollama embed batch failed: ${response.status} ${await response.text()}`);
  }
  
  const data = await response.json() as { embeddings: number[][] };
  const duration_ms = Date.now() - start;
  
  return data.embeddings.map((emb) => ({
    embedding: emb,
    model: MODEL,
    duration_ms,
  }));
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Vector dimension mismatch');
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Health check — verify Ollama is running and model is available.
 */
export async function embeddingHealthCheck(): Promise<{
  available: boolean;
  model: string;
  test_dim?: number;
  error?: string;
}> {
  try {
    const result = await embed('test');
    return {
      available: true,
      model: MODEL,
      test_dim: result.embedding.length,
    };
  } catch (err) {
    return {
      available: false,
      model: MODEL,
      error: (err as Error).message,
    };
  }
}
