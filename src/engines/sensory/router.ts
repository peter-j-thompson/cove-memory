/**
 * Sensory Router — The Bridge Between Sensation and Memory
 * 
 * Takes processed messages from SensoryProcessor and routes them
 * to the correct memory layers. This is the liveUpsert path —
 * real-time knowledge graph updates from conversation flow.
 * 
 * Routes:
 * - semantic: Entity/fact upserts (nodes + edges + embeddings)
 * - episodic: Conversation episodes (what happened, when)
 * - identity: Self-knowledge updates (feedback, emotional markers)
 * - relational: Relationship dynamics (Human ↔ Agent bond)
 * - procedural: Behavioral rules and directives
 */

import type { ProcessedMessage, ExtractedEntity } from './processor.js';
import type { EntityType, RelationshipType } from '../../types.js';
import { upsertNode, createEdge, findNode } from '../../layers/semantic/store.js';
import { query } from '../../storage/db.js';

// ============================================================
// TYPES
// ============================================================

export interface RouteResult {
  route: string;
  success: boolean;
  nodeIds?: string[];
  edgeIds?: string[];
  episodeId?: string;
  error?: string;
}

export interface RouterStats {
  messagesRouted: number;
  nodesUpserted: number;
  edgesCreated: number;
  episodesCreated: number;
  errors: number;
  avgRoutingTime_ms: number;
}

// ============================================================
// RELATIONSHIP INFERENCE FROM CONTEXT
// ============================================================

/**
 * Infer the most likely relationship type between two co-mentioned entities.
 * Uses context clues from the surrounding text.
 */
function inferRelationshipType(
  entity1: ExtractedEntity,
  entity2: ExtractedEntity,
  text: string
): RelationshipType {
  const textLower = text.toLowerCase();
  
  // Person + Organization → works_for
  if (
    (entity1.type === 'person' && entity2.type === 'organization') ||
    (entity1.type === 'organization' && entity2.type === 'person')
  ) {
    if (textLower.includes('founder') || textLower.includes('founded')) return 'created_by';
    if (textLower.includes('work') || textLower.includes('contract')) return 'works_for';
    return 'works_for';
  }

  // Person + Project → created_by / responsible_for
  if (
    (entity1.type === 'person' && entity2.type === 'project') ||
    (entity1.type === 'project' && entity2.type === 'person')
  ) {
    if (textLower.includes('built') || textLower.includes('created') || textLower.includes('building')) return 'created_by';
    return 'responsible_for';
  }

  // Project + Tool → depends_on
  if (
    (entity1.type === 'project' && entity2.type === 'tool') ||
    (entity1.type === 'tool' && entity2.type === 'project')
  ) {
    return 'depends_on';
  }

  // Person + Person
  if (entity1.type === 'person' && entity2.type === 'person') {
    if (textLower.includes('partner') || textLower.includes('work with') || textLower.includes('together')) return 'works_with';
    if (textLower.includes('mentor') || textLower.includes('teach')) return 'learned_from';
    return 'works_with';
  }

  // Project + Organization → owns
  if (
    (entity1.type === 'project' && entity2.type === 'organization') ||
    (entity1.type === 'organization' && entity2.type === 'project')
  ) {
    return 'owns';
  }

  // Default
  return 'part_of';
}

// ============================================================
// EMBEDDING GENERATION
// ============================================================

async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    const res = await fetch(`${ollamaUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'bge-m3', prompt: text }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { embedding?: number[] };
    return data.embedding || null;
  } catch {
    return null;
  }
}

async function upsertEmbedding(nodeId: string, text: string): Promise<boolean> {
  const embedding = await generateEmbedding(text);
  if (!embedding) return false;
  
  const embeddingStr = `[${embedding.join(',')}]`;
  await query(
    `UPDATE semantic_nodes SET embedding = $1::vector WHERE id = $2`,
    [embeddingStr, nodeId]
  );
  return true;
}

// ============================================================
// ROUTE HANDLERS
// ============================================================

/**
 * Route to Semantic layer — upsert entities and relationships.
 */
async function routeToSemantic(msg: ProcessedMessage): Promise<RouteResult> {
  const nodeIds: string[] = [];
  const edgeIds: string[] = [];

  try {
    // 1. Upsert all known entities as nodes
    for (const entity of msg.entities) {
      if (!entity.isKnown && entity.confidence < 0.6) continue; // Skip low-confidence unknowns
      
      const nodeId = await upsertNode({
        type: entity.type,
        name: entity.name,
        context: entity.context,
        confidence: entity.confidence,
        confidence_basis: entity.isKnown ? 'stated' : 'inferred',
        source_episodes: [], // Will be linked when episode is created
      });
      
      nodeIds.push(nodeId);
      
      // Generate embedding for new/updated node
      const embeddingText = `${entity.type}: ${entity.name}. ${entity.context}`;
      await upsertEmbedding(nodeId, embeddingText);
    }

    // 2. Create edges between co-mentioned entities (max 3 pairs per message to avoid noise)
    const knownEntities = msg.entities.filter(e => e.isKnown || e.confidence >= 0.6);
    const maxPairs = 3; // Quality gate: limit edge creation per message
    let pairsCreated = 0;
    for (let i = 0; i < knownEntities.length && pairsCreated < maxPairs; i++) {
      for (let j = i + 1; j < knownEntities.length && pairsCreated < maxPairs; j++) {
        const e1 = knownEntities[i];
        const e2 = knownEntities[j];
        
        // Find the node IDs
        const node1 = await findNode(e1.type, e1.name);
        const node2 = await findNode(e2.type, e2.name);
        if (!node1 || !node2) continue;

        const relType = inferRelationshipType(e1, e2, msg.rawText);
        
        // Infer category from relationship type
        const categoryMap: Record<string, import('../../types.js').RelationshipCategory> = {
          is_a: 'structural', instance_of: 'structural', part_of: 'structural', contains: 'structural',
          version_of: 'structural', located_in: 'structural',
          partner_of: 'relational', works_for: 'relational', works_with: 'relational',
          created_by: 'relational', owns: 'relational', trusts: 'relational',
          caused_by: 'causal', influenced_by: 'causal', influences: 'causal', led_to: 'causal',
          enabled_by: 'causal', blocked_by: 'causal', resolved_by: 'causal',
          preceded_by: 'temporal', followed_by: 'temporal', concurrent_with: 'temporal',
          evolved_into: 'temporal', superseded_by: 'temporal',
          feels_about: 'emotional', values: 'emotional', struggles_with: 'emotional',
          inspired_by: 'emotional', frustrated_by: 'emotional', grateful_for: 'emotional',
          used_for: 'functional', skilled_at: 'functional', responsible_for: 'functional',
          deployed_to: 'functional', depends_on: 'functional',
          learned_from: 'epistemic', contradicts: 'epistemic', supports: 'epistemic',
          inferred_from: 'epistemic', uncertain_about: 'epistemic',
        };
        const category = categoryMap[relType] || 'relational';

        try {
          const edgeResult = await createEdge({
            source_id: node1.id,
            target_id: node2.id,
            relationship: relType,
            category,
            context: msg.rawText.substring(0, 200),
            confidence: Math.min(e1.confidence, e2.confidence),
          });
          if (edgeResult) {
            edgeIds.push(edgeResult);
            pairsCreated++;
          }
        } catch {
          // Edge may already exist (conflict) — that's fine
        }
      }
    }

    // 3. Store factual claims as node attributes
    if (msg.factualClaims.length > 0) {
      for (const entity of msg.entities) {
        if (!entity.isKnown) continue;
        const node = await findNode(entity.type, entity.name);
        if (!node) continue;
        
        // Add factual claims to node attributes
        const existingAttrs = (node.attributes || {}) as Record<string, unknown>;
        const claims = (existingAttrs.factual_claims as string[] | undefined) || [];
        claims.push(...msg.factualClaims);
        // Deduplicate and keep last 20
        const uniqueClaims = [...new Set(claims)].slice(-20);
        
        await query(
          `UPDATE semantic_nodes SET attributes = attributes || $1, last_modified = NOW() WHERE id = $2`,
          [JSON.stringify({ factual_claims: uniqueClaims }), node.id]
        );
      }
    }

    return { route: 'semantic', success: true, nodeIds, edgeIds };
  } catch (err) {
    return { route: 'semantic', success: false, error: (err as Error).message };
  }
}

/**
 * Route to Episodic layer — record what happened.
 */
async function routeToEpisodic(msg: ProcessedMessage): Promise<RouteResult> {
  try {
    const summary = msg.rawText.length > 300 
      ? msg.rawText.substring(0, 297) + '...'
      : msg.rawText;

    const entityNames = msg.entities.map(e => e.name);
    
    const emotionalArc = {
      start: { emotion: msg.sentiment.dominantEmotion, valence: msg.sentiment.valence },
      peak: { emotion: msg.sentiment.dominantEmotion, valence: msg.sentiment.valence, arousal: msg.sentiment.arousal },
      end: { emotion: msg.sentiment.dominantEmotion, valence: msg.sentiment.valence },
    };

    const outcome = {
      intent: msg.intent,
      urgency: msg.urgency,
      factualClaims: msg.factualClaims,
      entityNames,
    };

    const result = await query(
      `INSERT INTO episodes (session_id, summary, detailed_narrative, participants, emotional_arc, peak_emotion, resolution_emotion, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        msg.sessionId || 'live-ingest',
        `${msg.sender}: ${summary}`,
        msg.rawText,
        [msg.sender],
        JSON.stringify(emotionalArc),
        JSON.stringify(emotionalArc.peak),
        JSON.stringify(emotionalArc.end),
        JSON.stringify(outcome),
      ]
    );

    const episodeId = result.rows[0].id;

    // Generate embedding for the episode
    const embedding = await generateEmbedding(summary);
    if (embedding) {
      const embeddingStr = `[${embedding.join(',')}]`;
      await query(
        `UPDATE episodes SET embedding = $1::vector WHERE id = $2`,
        [embeddingStr, episodeId]
      );
    }

    return { route: 'episodic', success: true, episodeId };
  } catch (err) {
    return { route: 'episodic', success: false, error: (err as Error).message };
  }
}

/**
 * Route to Identity layer — self-knowledge from feedback.
 */
async function routeToIdentity(msg: ProcessedMessage): Promise<RouteResult> {
  try {
    // Only store significant identity moments
    if (msg.sentiment.valence === 0 && msg.intent !== 'feedback') {
      return { route: 'identity', success: true }; // Skip neutral non-feedback
    }

    const category = msg.intent === 'feedback' ? 'capability' : 'emotional';
    const source = msg.sender === 'alex' ? 'Human feedback' : 'self-reflection';
    
    await query(
      `INSERT INTO identity (category, key, value, confidence, source, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (category, key) DO UPDATE SET
         value = $3,
         confidence = GREATEST(identity.confidence, $4),
         source = $5,
         last_modified = NOW()`,
      [
        category,
        `${msg.intent}_${msg.timestamp.toISOString().split('T')[0]}`,
        JSON.stringify({
          text: msg.rawText.substring(0, 500),
          sentiment: msg.sentiment,
          emotions: msg.sentiment.emotions,
        }),
        msg.sentiment.arousal > 0.5 ? 0.9 : 0.6,
        source,
        JSON.stringify({ sessionId: msg.sessionId }),
      ]
    );

    return { route: 'identity', success: true };
  } catch (err) {
    return { route: 'identity', success: false, error: (err as Error).message };
  }
}

/**
 * Route to Procedural layer — behavioral rules from directives.
 */
async function routeToProcedural(msg: ProcessedMessage): Promise<RouteResult> {
  try {
    await query(
      `INSERT INTO procedures (trigger_pattern, action, context, confidence, source, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        msg.rawText.substring(0, 200),
        msg.intent === 'directive' ? 'follow_directive' : 'store_procedure',
        msg.rawText,
        0.8,
        msg.sender,
        JSON.stringify({
          entities: msg.entities.map(e => e.name),
          sessionId: msg.sessionId,
        }),
      ]
    );

    return { route: 'procedural', success: true };
  } catch (err) {
    return { route: 'procedural', success: false, error: (err as Error).message };
  }
}

// ============================================================
// MAIN ROUTER
// ============================================================

export class SensoryRouter {
  private stats: RouterStats = {
    messagesRouted: 0,
    nodesUpserted: 0,
    edgesCreated: 0,
    episodesCreated: 0,
    errors: 0,
    avgRoutingTime_ms: 0,
  };

  /**
   * Route a processed message to all target layers.
   * Quality gates: skip trivial messages, limit noisy routes.
   */
  async route(msg: ProcessedMessage): Promise<RouteResult[]> {
    const start = Date.now();
    const results: RouteResult[] = [];

    // Quality gate: skip very short or entity-free messages for semantic routing
    if (msg.rawText.length < 20 && msg.entities.length === 0) {
      return [{ route: 'skipped', success: true }];
    }

    // Route to each target layer
    for (const target of msg.routes) {
      let result: RouteResult;
      
      switch (target) {
        case 'semantic':
          result = await routeToSemantic(msg);
          if (result.nodeIds) this.stats.nodesUpserted += result.nodeIds.length;
          if (result.edgeIds) this.stats.edgesCreated += result.edgeIds.length;
          break;
        case 'episodic':
          result = await routeToEpisodic(msg);
          if (result.episodeId) this.stats.episodesCreated++;
          break;
        case 'identity':
          result = await routeToIdentity(msg);
          break;
        case 'procedural':
          result = await routeToProcedural(msg);
          break;
        case 'relational':
          // Relational layer is Phase 5 — for now, route to episodic as fallback
          result = await routeToEpisodic(msg);
          result.route = 'relational→episodic';
          break;
        default:
          result = { route: target, success: false, error: `Unknown route: ${target}` };
      }

      if (!result.success) this.stats.errors++;
      results.push(result);
    }

    // Update stats
    this.stats.messagesRouted++;
    const elapsed = Date.now() - start;
    this.stats.avgRoutingTime_ms = 
      (this.stats.avgRoutingTime_ms * (this.stats.messagesRouted - 1) + elapsed) / this.stats.messagesRouted;

    return results;
  }

  /**
   * Process and route a raw message in one call.
   * Convenience method that combines SensoryProcessor + Router.
   */
  async processAndRoute(
    rawText: string,
    sender: string,
    processor: import('./processor.js').SensoryProcessor,
    sessionId?: string
  ): Promise<{ processed: ProcessedMessage; results: RouteResult[] }> {
    const processed = processor.process(rawText, sender, sessionId);
    const results = await this.route(processed);
    return { processed, results };
  }

  getStats(): RouterStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      messagesRouted: 0,
      nodesUpserted: 0,
      edgesCreated: 0,
      episodesCreated: 0,
      errors: 0,
      avgRoutingTime_ms: 0,
    };
  }
}

// ============================================================
// SINGLETON
// ============================================================

let _router: SensoryRouter | null = null;

export function getRouter(): SensoryRouter {
  if (!_router) {
    _router = new SensoryRouter();
  }
  return _router;
}
