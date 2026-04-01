/**
 * OpenMemory — Live Brain API
 * 
 * The bridge between conversations and memory.
 * Every message that flows through here becomes part of the brain.
 * 
 * Endpoints:
 *   POST /api/ingest   — Process a message through the sensory pipeline and write to brain
 *   POST /api/query    — Search across all memory layers
 *   GET  /api/health   — Brain health score
 *   GET  /api/stats    — Layer statistics
 * 
 * Port: 3003 (configurable via PORT env)
 *
 * Auth:
 *   Dev mode  (no BRAIN_API_KEY): No auth required
 *   Prod mode (BRAIN_API_KEY set):
 *     - Public tier:  Authorization: Bearer <key>
 *     - Private tier: Authorization: Bearer <key> + X-Brain-Scope: full
 */

import http from 'node:http';
import { query } from '../storage/db.js';
import { embed, warmup } from '../storage/embeddings/ollama.js';
import { search, DEFAULT_WEIGHTS } from '../engines/retrieval/search.js';
import { calculateBrainHealth } from '../engines/consolidation/consolidate.js';
import { sessionSleep, nightlySleep, weeklySleep, backfillEpisodeInsights } from '../engines/consolidation/sleep-cycle.js';
import { syncRepo } from '../engines/code-brain/sync.js';
import { upsertNode, createEdge, findNode } from '../layers/semantic/store.js';
import { affirmIdentity } from '../layers/identity/store.js';
import { incrementInteraction } from '../layers/relational/store.js';
import type { EntityType, RelationshipType, RelationshipCategory } from '../types.js';
import { guardIngest } from './ingest-guard.js';
import { updateEdgeWeights } from '../engines/maintenance/edge-weights.js';
import { checkAuth, resolveAllowedOrigin } from './auth.js';

const PORT = parseInt(process.env.API_PORT || '3003');

// ============================================================
// SENSORY PROCESSING (Full pipeline — not the lightweight UI mirror)
// ============================================================

interface ProcessedMessage {
  text: string;
  sender: string;
  timestamp: string;
  classification: { type: string; confidence: number };
  entities: ExtractedEntity[];
  sentiment: { valence: number; arousal: number; label: string };
  urgency: { score: number; level: string };
  intent: { intent: string; confidence: number };
  routes: string[];
  brainWrites: BrainWrite[];
  processingMs: number;
}

interface ExtractedEntity {
  name: string;
  type: string;
  matchedOn: string;
  nodeId?: string;
}

interface BrainWrite {
  layer: string;
  action: string;
  target: string;
  success: boolean;
  detail?: string;          // Human-readable description of what happened
  connectedEntities?: string[]; // Names of entities involved
  metadata?: Record<string, unknown>; // Extra context (importance, sentiment, etc.)
}

// Entity cache from DB
let entityCache: { name: string; type: string; id: string; aliases: string[] }[] = [];
let cacheTime = 0;

async function loadEntityCache() {
  if (Date.now() - cacheTime < 30000 && entityCache.length > 0) return entityCache;
  const rows = (await query('SELECT id, name, type, aliases FROM semantic_nodes ORDER BY confidence DESC')).rows;
  entityCache = rows.map((r: any) => ({ id: r.id, name: r.name, type: r.type, aliases: r.aliases || [] }));
  cacheTime = Date.now();
  return entityCache;
}

// ============================================================
// LLM-POWERED ENTITY EXTRACTION (Phase 1 — Make It Smart)
// ============================================================

async function llmExtractEntities(
  text: string,
  knownEntities: { name: string; type: string; id: string; aliases: string[] }[]
): Promise<ExtractedEntity[]> {
  const entityList = knownEntities.map(e => `  - ${e.name} (${e.type})`).join('\n');

  const prompt = `You are analyzing a user message to identify which known entities are relevant.

Known entities:
${entityList}

User message: "${text}"

Instructions:
1. Identify entities EXPLICITLY mentioned in the message (by name or alias).
2. Identify entities IMPLIED by the query — e.g., if someone asks about a person's "projects", then project-type entities connected to that person are implied.
3. For implied entities, think about what TYPE of entities the query is asking about (project, tool, concept, person, etc.) and which known entities of that type would be relevant.

Return ONLY valid JSON (no markdown, no explanation):
{
  "explicit": ["Entity Name 1"],
  "implied": ["Entity Name 2", "Entity Name 3"],
  "implied_type": "project"
}

If no entities found, return: {"explicit": [], "implied": [], "implied_type": null}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5-coder:32b',
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 300 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const data = await res.json() as { response: string };
    const raw = data.response.trim();

    // Extract JSON from response (handle markdown fences)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as {
      explicit: string[];
      implied: string[];
      implied_type: string | null;
    };

    const entities: ExtractedEntity[] = [];
    const seen = new Set<string>();

    // Map explicit entities
    for (const name of (parsed.explicit || [])) {
      const match = knownEntities.find(
        e => e.name.toLowerCase() === name.toLowerCase() ||
             e.aliases.some(a => a.toLowerCase() === name.toLowerCase())
      );
      if (match && !seen.has(match.name)) {
        seen.add(match.name);
        entities.push({ name: match.name, type: match.type, matchedOn: 'name', nodeId: match.id });
      }
    }

    // For implied entities: first try DB lookup for connected entities, then fall back to LLM suggestions
    const explicitEntities = entities.filter(e => seen.has(e.name));
    if (parsed.implied_type && explicitEntities.length > 0) {
      for (const explicit of explicitEntities) {
        try {
          const connected = await query(
            `SELECT t.name, t.type, t.id FROM semantic_edges e
             JOIN semantic_nodes s ON e.source_id = s.id
             JOIN semantic_nodes t ON e.target_id = t.id
             WHERE s.name = $1 AND t.type = $2
             UNION
             SELECT s.name, s.type, s.id FROM semantic_edges e
             JOIN semantic_nodes s ON e.source_id = s.id
             JOIN semantic_nodes t ON e.target_id = t.id
             WHERE t.name = $1 AND s.type = $2`,
            [explicit.name, parsed.implied_type]
          );
          for (const row of connected.rows) {
            if (!seen.has(row.name)) {
              seen.add(row.name);
              entities.push({ name: row.name, type: row.type, matchedOn: 'llm-inferred', nodeId: row.id });
            }
          }
        } catch { /* DB lookup is supplementary */ }
      }
    }

    // Also add any LLM-suggested implied entities that match known entities
    for (const name of (parsed.implied || [])) {
      const match = knownEntities.find(
        e => e.name.toLowerCase() === name.toLowerCase()
      );
      if (match && !seen.has(match.name)) {
        seen.add(match.name);
        entities.push({ name: match.name, type: match.type, matchedOn: 'llm-inferred', nodeId: match.id });
      }
    }

    return entities;
  } catch (err) {
    clearTimeout(timeout);
    // Timeout or LLM failure — return empty, caller will fall back to string matching
    console.warn('[LLM] Entity extraction failed/timed out:', (err as Error).message);
    return [];
  }
}

function classify(text: string) {
  const lower = text.toLowerCase();
  const isQuestion = lower.includes('?') || /^(who|what|how|where|when|why|which|can|do|does|is|are|will|would|should)\b/.test(lower);
  if (isQuestion) return { type: 'question', confidence: 0.9 };
  if (/(!|let'?s|build|create|make|do |fix|deploy|ship)/.test(lower)) return { type: 'directive', confidence: 0.85 };
  if (/\b(i think|i believe|i feel|i realize|i wonder)\b/.test(lower)) return { type: 'reflection', confidence: 0.8 };
  if (/\b(remember|don'?t forget|save|store|note)\b/.test(lower)) return { type: 'memory_request', confidence: 0.85 };
  if (/\b(decided|decision|we agreed|agreed|commitment|promise)\b/.test(lower)) return { type: 'decision', confidence: 0.85 };
  return { type: 'statement', confidence: 0.7 };
}

async function extractEntities(text: string): Promise<ExtractedEntity[]> {
  const entities: ExtractedEntity[] = [];
  const known = await loadEntityCache();
  const lower = text.toLowerCase();

  for (const entity of known) {
    const nameLower = entity.name.toLowerCase();
    if (nameLower.length < 3) continue;
    if (lower.includes(nameLower)) {
      entities.push({ name: entity.name, type: entity.type, matchedOn: 'name', nodeId: entity.id });
      continue;
    }
    for (const alias of entity.aliases) {
      if (alias.length < 3) continue;
      if (lower.includes(alias.toLowerCase())) {
        entities.push({ name: entity.name, type: entity.type, matchedOn: `alias:${alias}`, nodeId: entity.id });
        break;
      }
    }
  }

  return entities.filter((e, i, arr) => arr.findIndex(x => x.name === e.name) === i);
}

function analyzeSentiment(text: string) {
  const positive = ['great', 'awesome', 'love', 'amazing', 'beautiful', 'incredible', 'excellent', 'perfect',
    'good', 'fantastic', 'brilliant', 'cool', 'wonderful', 'excited', 'proud', 'happy', 'grateful', '🔥', '❤️', '💪'];
  const negative = ['bad', 'wrong', 'broken', 'fail', 'error', 'bug', 'hate', 'terrible', 'awful',
    'worried', 'concerned', 'frustrated', 'angry', 'disappointed', 'annoyed'];
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of positive) if (lower.includes(w)) score += 0.15;
  for (const w of negative) if (lower.includes(w)) score -= 0.15;
  const valence = Math.max(-1, Math.min(1, score));
  const arousal = Math.min(1, (text.match(/[!?🔥💪❤️]/g)?.length || 0) * 0.15 + (text.length > 200 ? 0.3 : 0.1));
  return { valence: +valence.toFixed(2), arousal: +arousal.toFixed(2), label: valence > 0.2 ? 'positive' : valence < -0.2 ? 'negative' : 'neutral' };
}

function assessUrgency(text: string, classification: { type: string }) {
  const lower = text.toLowerCase();
  let score = 0.3;
  for (const w of ['now', 'immediately', 'urgent', 'asap', 'critical', 'emergency', 'quick', 'hurry']) {
    if (lower.includes(w)) score += 0.2;
  }
  if (classification.type === 'directive') score += 0.1;
  if (text.includes('!')) score += 0.1;
  return { score: +Math.min(1, score).toFixed(2), level: score > 0.7 ? 'high' : score > 0.4 ? 'medium' : 'low' };
}

function detectIntent(text: string, classification: { type: string }) {
  const lower = text.toLowerCase();
  if (/\b(what|which).+(love|like|prefer|favorite)\b/.test(lower)) return { intent: 'preference_query', confidence: 0.9 };
  if (/\b(who|people|team|partner|working with)\b/.test(lower)) return { intent: 'relational_query', confidence: 0.9 };
  if (/\b(build|create|make|implement)\b/.test(lower)) return { intent: 'create', confidence: 0.85 };
  if (/\b(fix|debug|repair|broken)\b/.test(lower)) return { intent: 'fix', confidence: 0.85 };
  if (/\b(research|look into|find out|investigate)\b/.test(lower)) return { intent: 'research', confidence: 0.8 };
  if (/\b(deploy|ship|push|launch)\b/.test(lower)) return { intent: 'deploy', confidence: 0.85 };
  if (/\b(save|remember|store|note)\b/.test(lower)) return { intent: 'memory_write', confidence: 0.8 };
  if (/\b(decided|decision|we agreed|commit)\b/.test(lower)) return { intent: 'record_decision', confidence: 0.85 };
  if (classification.type === 'question') return { intent: 'query', confidence: 0.75 };
  if (classification.type === 'reflection') return { intent: 'reflect', confidence: 0.7 };
  return { intent: 'communicate', confidence: 0.6 };
}

function determineRoutes(intent: { intent: string }, entities: ExtractedEntity[]) {
  const routes = new Set(['semantic']);
  const types = new Set(entities.map(e => e.type));

  if (['relational_query', 'preference_query'].includes(intent.intent) || types.has('person')) routes.add('relational');
  if (['memory_write', 'reflect', 'record_decision'].includes(intent.intent)) routes.add('episodic');
  if (['create', 'fix', 'deploy'].includes(intent.intent)) routes.add('procedural');
  if (['reflect', 'preference_query'].includes(intent.intent)) routes.add('identity');
  if (types.has('project') || types.has('organization')) routes.add('episodic');

  return [...routes];
}

// ============================================================
// BRAIN WRITES — Actually persist to the brain
// ============================================================

async function writeToBrain(
  text: string,
  sender: string,
  entities: ExtractedEntity[],
  sentiment: { valence: number; arousal: number; label: string },
  intent: { intent: string },
  routes: string[],
): Promise<BrainWrite[]> {
  const writes: BrainWrite[] = [];

  // 1. Create an episode for this message
  try {
    const emotionalArc = JSON.stringify({
      start: { valence: sentiment.valence, arousal: sentiment.arousal, label: sentiment.label },
      trajectory: 'stable',
      end: { valence: sentiment.valence, arousal: sentiment.arousal, label: sentiment.label },
    });
    
    const participants = [sender.toLowerCase()];
    if (sender.toLowerCase() !== 'agent') participants.push('agent');
    
    const topics = entities.map(e => e.name).slice(0, 5);
    const importance = Math.min(1, 0.3 + 
      (intent.intent === 'record_decision' ? 0.4 : 0) +
      (intent.intent === 'memory_write' ? 0.3 : 0) +
      (Math.abs(sentiment.valence) > 0.3 ? 0.2 : 0) +
      (entities.length > 2 ? 0.1 : 0));

    const epResult = await query(`
      INSERT INTO episodes (session_id, summary, detailed_narrative, participants, topics,
        emotional_arc, importance_score, decay_protected)
      VALUES ('live', $1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [
      text.substring(0, 200),
      text,
      participants,
      topics,
      emotionalArc,
      importance,
      importance > 0.7, // protect important episodes from decay
    ]);

    const epId = epResult.rows[0].id;
    writes.push({ 
      layer: 'episodic', action: 'created_episode', target: epId, success: true,
      detail: `Stored as episode: "${text.substring(0, 80)}${text.length > 80 ? '…' : ''}"`,
      connectedEntities: entities.map(e => e.name),
      metadata: { importance: +importance.toFixed(2), topics, participants, sentiment: sentiment.label },
    });

    // 2. Generate and store episode embedding
    try {
      const embResult = await embed(text.substring(0, 500));
      await query('UPDATE episodes SET embedding = $1 WHERE id = $2', [
        '[' + embResult.embedding.join(',') + ']', epId
      ]);
      writes.push({ 
        layer: 'episodic', action: 'embedded_episode', target: epId, success: true,
        detail: `Generated 1024-dim embedding via bge-m3 for semantic search`,
        metadata: { model: 'bge-m3', dimensions: 1024 },
      });
    } catch {
      writes.push({ layer: 'episodic', action: 'embedded_episode', target: epId, success: false,
        detail: 'Failed to generate embedding — episode stored without vector search capability' });
    }

    // 3. Update relational layer — increment interactions for mentioned people
    if (routes.includes('relational')) {
      for (const entity of entities.filter(e => e.type === 'person')) {
        try {
          await incrementInteraction(entity.name);
          // Fetch updated interaction count for display
          let interactionCount = 0;
          try {
            const pm = (await query('SELECT interaction_count FROM person_models WHERE name = $1', [entity.name])).rows;
            if (pm.length > 0) interactionCount = pm[0].interaction_count;
          } catch { /* non-critical */ }
          writes.push({ 
            layer: 'relational', action: 'increment_interaction', target: entity.name, success: true,
            detail: `Updated relationship model for ${entity.name} (${interactionCount} total interactions)`,
            connectedEntities: [entity.name],
            metadata: { interactionCount, entityType: entity.type },
          });
        } catch {
          writes.push({ layer: 'relational', action: 'increment_interaction', target: entity.name, success: false,
            detail: `Failed to update relationship model for ${entity.name}` });
        }
      }
    }

    // 4. Affirm identity entries that match
    if (routes.includes('identity')) {
      try {
        const allIdentity = (await query('SELECT key, value FROM identity')).rows;
        const lower = text.toLowerCase();
        for (const entry of allIdentity) {
          if (lower.includes(entry.key.replace(/-/g, ' ').toLowerCase()) ||
              lower.includes(entry.value.substring(0, 30).toLowerCase())) {
            await affirmIdentity(entry.key);
            writes.push({ 
              layer: 'identity', action: 'affirmed', target: entry.key, success: true,
              detail: `Reinforced identity: "${entry.key}" → "${entry.value.substring(0, 60)}${entry.value.length > 60 ? '…' : ''}"`,
              metadata: { key: entry.key, valuePreview: entry.value.substring(0, 100) },
            });
          }
        }
      } catch { /* identity affirmation is supplementary */ }
    }

    // 5. Link episode to mentioned entity nodes
    for (const entity of entities) {
      if (entity.nodeId) {
        try {
          await query(`
            UPDATE semantic_nodes 
            SET source_episodes = array_append(source_episodes, $1),
                last_modified = NOW()
            WHERE id = $2
          `, [epId, entity.nodeId]);
          // Fetch connected edge count for this entity
          let edgeCount = 0;
          try {
            const ec = (await query('SELECT COUNT(*) as c FROM semantic_edges WHERE source_id = $1 OR target_id = $1', [entity.nodeId])).rows;
            edgeCount = +ec[0].c;
          } catch { /* non-critical */ }
          writes.push({ 
            layer: 'semantic', action: 'linked_to_episode', target: entity.name, success: true,
            detail: `Linked "${entity.name}" (${entity.type}) to this episode — ${edgeCount} total connections in knowledge graph`,
            connectedEntities: [entity.name],
            metadata: { entityType: entity.type, graphEdges: edgeCount, nodeId: entity.nodeId },
          });
        } catch { /* supplementary */ }
      }
    }

  } catch (err) {
    writes.push({ layer: 'episodic', action: 'created_episode', target: 'error: ' + (err as Error).message, success: false });
  }

  return writes;
}

// ============================================================
// FULL INGEST PIPELINE
// ============================================================

async function ingestMessage(text: string, sender: string): Promise<ProcessedMessage> {
  const start = Date.now();

  const classification = classify(text);

  // Try LLM extraction first, fall back to string matching
  const known = await loadEntityCache();
  let entities = await llmExtractEntities(text, known);
  let usedLlm = entities.length > 0;
  if (!usedLlm) {
    entities = await extractEntities(text);
  }

  const sentiment = analyzeSentiment(text);
  const urgency = assessUrgency(text, classification);
  const intent = detectIntent(text, classification);
  const routes = determineRoutes(intent, entities);
  const brainWrites = await writeToBrain(text, sender, entities, sentiment, intent, routes);

  // Add implied entities detail to brainWrites
  const impliedEntities = entities.filter(e => e.matchedOn === 'llm-inferred');
  if (impliedEntities.length > 0) {
    brainWrites.push({
      layer: 'semantic',
      action: 'llm_entity_inference',
      target: 'query_analysis',
      success: true,
      detail: `LLM inferred ${impliedEntities.length} implied entities: ${impliedEntities.map(e => e.name).join(', ')}`,
      connectedEntities: impliedEntities.map(e => e.name),
      metadata: { method: usedLlm ? 'llm' : 'fallback', impliedCount: impliedEntities.length },
    });
  }

  // Boost edges for mentioned entities (Phase 1 — edge weight maintenance on ingest)
  for (const entity of entities) {
    if (entity.nodeId) {
      try {
        await query(
          `UPDATE semantic_edges SET strength = LEAST(1.0, strength + 0.05)
           WHERE source_id = $1 OR target_id = $1`,
          [entity.nodeId]
        );
      } catch { /* edge boost is supplementary */ }
    }
  }

  return {
    text: text.substring(0, 500),
    sender,
    timestamp: new Date().toISOString(),
    classification,
    entities,
    sentiment,
    urgency,
    intent,
    routes,
    brainWrites,
    processingMs: Date.now() - start,
  };
}

// ============================================================
// HTTP SERVER — CORS, Auth, Rate Limiting
// ============================================================

/**
 * Set CORS headers on a response.
 * In dev mode (no BRAIN_API_KEY): allows any origin.
 * In prod mode: strict whitelist (your-domain.com, *.vercel.app, localhost:*).
 */
function setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse) {
  const allowedOrigin = resolveAllowedOrigin(req);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Brain-Scope');
}

function json(req: http.IncomingMessage, res: http.ServerResponse, data: unknown, status = 200) {
  setCorsHeaders(req, res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCorsHeaders(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Auth & Rate Limiting ───────────────────────────────────────────────────
  const auth = checkAuth(req, path);
  if (!auth.allowed) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth.retryAfter) headers['Retry-After'] = String(auth.retryAfter);
    setCorsHeaders(req, res);
    res.writeHead(auth.status ?? 401, headers);
    res.end(JSON.stringify({ error: auth.error }));
    return;
  }

  try {
    // POST /api/ingest — Live message ingestion (with safety guard)
    if (path === '/api/ingest' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.text) return json(req, res, { error: 'text is required' }, 400);
      
      // Safety guard — filters credentials, system messages, rate limits
      const guard = guardIngest(body.text, body.sender || 'unknown');
      if (!guard.allowed) {
        return json(req, res, { filtered: true, reason: guard.reason }, 200);
      }
      
      const result = await ingestMessage(guard.sanitizedText!, guard.sender!);
      return json(req, res, result);
    }

    // POST /api/query — Search the brain
    if (path === '/api/query' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.query) return json(req, res, { error: 'query is required' }, 400);
      
      const results = await search(body.query, {
        limit: body.limit || 10,
        weights: body.weights || DEFAULT_WEIGHTS,
        memoryTypes: body.memoryTypes,
        minScore: body.minScore || 0.05,
      });
      
      return json(req, res, {
        query: body.query,
        results,
        count: results.length,
        timestamp: new Date().toISOString(),
      });
    }

    // POST /api/compare — Side-by-side brain vs markdown vs unified
    if (path === '/api/compare' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.query) return json(req, res, { error: 'query is required' }, 400);
      const limit = body.limit || 5;
      
      const startAll = Date.now();
      
      // Brain-only search (exclude markdown)
      const brainResults = await search(body.query, {
        limit,
        memoryTypes: ['semantic', 'episode', 'lesson', 'identity', 'procedure'],
        minScore: 0.05,
      });
      
      // Markdown-only search (exclude brain)
      const markdownResults = await search(body.query, {
        limit,
        memoryTypes: ['markdown'],
        minScore: 0.05,
      });
      
      // Unified search (everything)
      const unifiedResults = await search(body.query, {
        limit,
        minScore: 0.05,
      });
      
      return json(req, res, {
        query: body.query,
        brain: {
          results: brainResults,
          count: brainResults.length,
          sources: [...new Set(brainResults.map(r => r.memory_type))],
        },
        markdown: {
          results: markdownResults,
          count: markdownResults.length,
          sources: [...new Set(markdownResults.map(r => (r.metadata as any)?.source_file || 'unknown'))],
        },
        unified: {
          results: unifiedResults,
          count: unifiedResults.length,
          sources: [...new Set(unifiedResults.map(r => r.memory_type))],
          brainCount: unifiedResults.filter(r => r.memory_type !== 'markdown').length,
          markdownCount: unifiedResults.filter(r => r.memory_type === 'markdown').length,
        },
        totalMs: Date.now() - startAll,
        timestamp: new Date().toISOString(),
      });
    }

    // GET /api/health — Brain health (NO auth)
    if (path === '/api/health' && req.method === 'GET') {
      try {
        const health = await calculateBrainHealth();
        return json(req, res, health);
      } catch (err) {
        // In production (Cortex-only mode), full brain tables may not exist
        return json(req, res, { status: 'ok', mode: 'cortex', message: 'Cortex API running' });
      }
    }

    // GET /api/stats — Quick stats
    if (path === '/api/stats' && req.method === 'GET') {
      try {
        const [nodes, edges, episodes, identity, people, procs, lessons] = await Promise.all([
          query('SELECT COUNT(*) as c FROM semantic_nodes'),
          query('SELECT COUNT(*) as c FROM semantic_edges'),
          query('SELECT COUNT(*) as c FROM episodes'),
          query('SELECT COUNT(*) as c FROM identity'),
          query('SELECT COUNT(*) as c FROM person_models'),
          query('SELECT COUNT(*) as c FROM procedures'),
          query('SELECT COUNT(*) as c FROM lessons'),
        ]);
        return json(req, res, {
          semantic_nodes: +nodes.rows[0].c,
          semantic_edges: +edges.rows[0].c,
          episodes: +episodes.rows[0].c,
          identity: +identity.rows[0].c,
          person_models: +people.rows[0].c,
          procedures: +procs.rows[0].c,
          lessons: +lessons.rows[0].c,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Production: brain tables may not exist — return Cortex-only stats
        try {
          const snapshots = await query('SELECT COUNT(*) as c FROM code_brain_snapshots');
          return json(req, res, { mode: 'cortex', code_brain_snapshots: +snapshots.rows[0].c, timestamp: new Date().toISOString() });
        } catch {
          return json(req, res, { mode: 'cortex', status: 'ok', timestamp: new Date().toISOString() });
        }
      }
    }

    // GET /api/maintenance/reweight — Recompute edge weights
    if (path === '/api/maintenance/reweight' && req.method === 'GET') {
      const result = await updateEdgeWeights();
      return json(req, res, result);
    }

    // POST /api/sleep — Run a sleep cycle (session|nightly|weekly)
    if (path === '/api/sleep' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const cycle = body.cycle || 'session';
      console.log(`[API] 💤 Sleep cycle requested: ${cycle}`);
      
      let result;
      switch (cycle) {
        case 'nightly':
          result = await nightlySleep();
          break;
        case 'weekly':
          result = await weeklySleep();
          break;
        default:
          result = await sessionSleep();
      }
      return json(req, res, result);
    }

    // POST /api/backfill — Run historical episode insight extraction
    if (path === '/api/backfill' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const batchSize = body.batchSize || 20;
      console.log(`[API] 📚 Backfill requested: ${batchSize} episodes`);
      const result = await backfillEpisodeInsights(batchSize);
      return json(req, res, result);
    }

    // POST /api/code-brain/sync — Sync a codebase into the brain
    if (path === '/api/code-brain/sync' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const repoPath = body.repoPath;
      if (!repoPath) {
        return json(req, res, { error: 'repoPath is required' }, 400);
      }
      console.log(`[API] 🧠 Code Brain sync requested: ${repoPath}`);
      const result = await syncRepo(repoPath, { forceReindex: body.forceReindex });
      return json(req, res, result);
    }

    // GET /api/code-brain/history?repo=name — Get architecture evolution history
    if (path === '/api/code-brain/history' && req.method === 'GET') {
      const repoName = url.searchParams.get('repo');
      if (!repoName) {
        return json(req, res, { error: 'repo query param is required' }, 400);
      }
      const { getSnapshotHistory } = await import('../engines/code-brain/temporal.js');
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const history = await getSnapshotHistory(repoName, limit);
      return json(req, res, { repo: repoName, snapshots: history.length, history });
    }

    // 404
    json(req, res, { error: 'Not found', endpoints: ['/api/ingest', '/api/query', '/api/compare', '/api/health', '/api/stats', '/api/maintenance/reweight', '/api/sleep', '/api/backfill', '/api/code-brain/sync', '/api/code-brain/history'] }, 404);
    
  } catch (err) {
    console.error('[API ERROR]', err);
    json(req, res, { error: (err as Error).message }, 500);
  }
});

// ============================================================
// STARTUP
// ============================================================

async function start() {
  const devMode = !process.env.BRAIN_API_KEY;
  console.log('🧠 OpenMemory — Live Brain API');
  if (devMode) {
    console.log('   ⚠️  Dev mode: BRAIN_API_KEY not set — auth disabled');
  } else {
    console.log('   🔒 Auth enabled — BRAIN_API_KEY is set');
  }
  // Warmup and reweight are optional — skip in production (no Ollama on Fly)
  if (!process.env.BRAIN_API_KEY) {
    console.log('   Warming up embedding model...');
    try {
      await warmup();
      console.log('   ✅ Embedding model ready');
    } catch (err) {
      console.warn('   ⚠️ Embedding warmup skipped:', (err as Error).message);
    }

    console.log('   Reweighting edges...');
    try {
      const reweight = await updateEdgeWeights();
      console.log(`   ✅ Edge weights updated (${reweight.edgesProcessed} edges, ${reweight.duration_ms}ms)`);
    } catch (err) {
      console.warn('   ⚠️ Edge reweight failed:', (err as Error).message);
    }
  } else {
    console.log('   ⚡ Production mode: skipping warmup/reweight (no local Ollama)');
  }
  
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`   🔥 API running on http://localhost:${PORT}`);
    console.log('');
    console.log('   Endpoints:');
    console.log('     POST /api/ingest              — Process & store a message        [PRIVATE]');
    console.log('     POST /api/query               — Unified search (brain + markdown) [PRIVATE]');
    console.log('     POST /api/compare             — Side-by-side brain vs markdown    [PRIVATE]');
    console.log('     GET  /api/health              — Brain health score               [NO AUTH]');
    console.log('     GET  /api/stats               — Layer statistics                 [PUBLIC]');
    console.log('     GET  /api/maintenance/reweight — Recompute edge weights           [PRIVATE]');
    console.log('     POST /api/sleep               — Run sleep cycle                  [PRIVATE]');
    console.log('     POST /api/code-brain/sync     — Sync codebase architecture       [PUBLIC]');
    console.log('     GET  /api/code-brain/history  — Architecture evolution history   [PUBLIC]');
    console.log('');
    console.log('   The brain is alive. 🪨🔥');
  });
}

process.on('uncaughtException', (err) => { console.error('[UNCAUGHT]', err); });
process.on('unhandledRejection', (err) => { console.error('[UNHANDLED]', err); });
process.on('SIGINT', () => { console.log('\n👋 Shutting down...'); server.close(); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n👋 Shutting down...'); server.close(); process.exit(0); });
start().catch(console.error);
