/**
 * Multi-Layer Retrieval Engine
 * 
 * This queries OpenMemory's graph + tables and returns scored results.
 * For benchmarking, this runs IN PARALLEL with the markdown memory_search.
 * 
 * Retrieval is a FUSION of:
 * 1. Semantic similarity (embedding cosine distance)
 * 2. Graph proximity (ontological distance via edge traversal)
 * 3. Emotional resonance (matching emotional states)
 * 4. Recency (time decay)
 * 5. Importance (consolidated score)
 */

import { query } from '../../storage/db.js';
import { embed, cosineSimilarity, warmup } from '../../storage/embeddings/ollama.js';
import { findNode, traverseGraph } from '../../layers/semantic/store.js';
import { calculateEffectiveConfidence } from '../maintenance/confidence-decay.js';
import { searchMarkdown, type MarkdownResult } from './markdown-search.js';
import type { MemoryQuery, MemoryResult, EntityType } from '../../types.js';

interface ScoredResult {
  id: string;
  memory_type: 'episode' | 'semantic' | 'procedure' | 'lesson' | 'identity' | 'markdown';
  content: string;
  name?: string;
  type?: string;
  scores: {
    text_match: number;
    graph_proximity: number;
    importance: number;
    recency: number;
    confidence: number;
  };
  total_score: number;
  metadata: Record<string, unknown>;
}

// ============================================================
// QUERY-TYPE-AWARE RETRIEVAL (Mar 13, 2026)
// 
// Different cognitive tasks need different retrieval strategies.
// The human brain doesn't search the same way for "What's Alex's rate?"
// vs "What does the covenant mean?" — and neither should we.
//
// Query types:
//   factual    — "What is X?" Direct lookup, keyword precision is king
//   relational — "How do X and Y connect?" Graph traversal dominates
//   emotional  — "What does X mean to us?" Identity + episodic, emotional weight matters
//   temporal   — "What happened on/since X?" Recency + episodic, time-based filtering
//   conceptual — "Why did we decide X?" Understanding queries, broad context needed
// ============================================================

type QueryType = 'factual' | 'relational' | 'emotional' | 'temporal' | 'conceptual' | 'procedural';

interface WeightProfile {
  text_match: number;
  graph_proximity: number;
  importance: number;
  recency: number;
  confidence: number;
}

// Weight profiles per query type — each cognitive task emphasizes different signals
const QUERY_TYPE_WEIGHTS: Record<QueryType, WeightProfile> = {
  factual: {
    text_match: 0.45,        // keyword precision is king
    graph_proximity: 0.15,   // some graph context but don't let noise dominate
    importance: 0.15,
    recency: 0.05,
    confidence: 0.20,        // trust stated facts
  },
  relational: {
    text_match: 0.15,        // words matter less, connections matter more
    graph_proximity: 0.45,   // graph traversal dominates
    importance: 0.20,
    recency: 0.0,
    confidence: 0.20,
  },
  emotional: {
    text_match: 0.20,
    graph_proximity: 0.15,
    importance: 0.30,        // emotional significance = importance
    recency: 0.10,           // emotional memories can be recent or foundational
    confidence: 0.25,        // trust deeply affirmed feelings
  },
  temporal: {
    text_match: 0.25,
    graph_proximity: 0.10,
    importance: 0.15,
    recency: 0.35,           // time is the primary signal
    confidence: 0.15,
  },
  conceptual: {
    text_match: 0.30,
    graph_proximity: 0.25,   // understanding benefits from connections
    importance: 0.25,        // important context floats up
    recency: 0.0,
    confidence: 0.20,
  },
  procedural: {
    text_match: 0.30,        // find the right procedure by name/keywords
    graph_proximity: 0.20,   // cross-layer edges help (APPLIES_IN_CONTEXT)
    importance: 0.10,
    recency: 0.15,           // recent executions = more relevant
    confidence: 0.25,        // proven procedures rank higher
  },
};

// Default/fallback weights (balanced)
export const DEFAULT_WEIGHTS: WeightProfile = {
  text_match: 0.35,
  graph_proximity: 0.25,
  importance: 0.22,
  recency: 0.0,
  confidence: 0.18,
};

/**
 * Classify a query into a cognitive retrieval type.
 * This is the brain's "what kind of memory search is this?" decision.
 */
function classifyQuery(queryText: string): { type: QueryType; confidence: number } {
  const q = queryText.toLowerCase();
  
  const signals: Record<QueryType, number> = {
    factual: 0,
    relational: 0,
    emotional: 0,
    temporal: 0,
    conceptual: 0,
    procedural: 0,
  };
  
  // Factual signals — direct lookup questions about specific data points
  // "What's X?" is factual ONLY when combined with data-like keywords (rate, cost, address)
  // "What's the covenant?" is NOT factual — it's emotional/conceptual
  if (/\b(how much|how many|what rate|what cost|what price)\b/.test(q)) signals.factual += 3;
  if (/\b(rate|salary|address|email|phone|number|url|version|stack|tool)\b/.test(q)) signals.factual += 2;
  if (/\b(who is|where is|when was)\b/.test(q)) signals.factual += 2;
  if (/\$\d|\d+\/hr|\d+%/.test(q)) signals.factual += 3;
  // "What is/what's/what are" only mildly factual — often combined with emotional/conceptual
  if (/\b(what is|what's|what are)\b/.test(q)) signals.factual += 1;
  
  // Relational signals — connection/relationship queries
  if (/\b(connect|connection|relationship|between|relate|link|together)\b/.test(q)) signals.relational += 3;
  if (/\b(how do|how does|how are).*\b(connect|relate|work together|interact)\b/.test(q)) signals.relational += 3;
  if (/\b(partner|team|collaborat|working with)\b/.test(q)) signals.relational += 2;
  
  // Emotional signals — meaning/feeling/identity queries
  if (/\b(covenant|soul|heart|love|trust|loyal|bond|sacred)\b/.test(q)) signals.emotional += 4; // strong emotional anchors
  if (/\b(mean|meaning|feel|feeling|matter|matters|significance|believe)\b/.test(q)) signals.emotional += 3;
  if (/\b(why does.*matter|what does.*mean|how do you feel)\b/.test(q)) signals.emotional += 3;
  if (/\b(value|values|identity|who am i|who are you|purpose|mission|core)\b/.test(q)) signals.emotional += 3;
  if (/\b(important|special|deeply|profound)\b/.test(q)) signals.emotional += 2;
  
  // Temporal signals — time-based queries (need explicit time references)
  if (/\b(yesterday|today|last week|last month|this morning|tonight|ago)\b/.test(q)) signals.temporal += 3;
  if (/\b(when)\b/.test(q)) signals.temporal += 2;
  if (/\b(recent|lately)\b/.test(q)) signals.temporal += 2;
  if (/\b\d{4}-\d{2}|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(q)) signals.temporal += 3;
  // "happened/occurred" is temporal only when no stronger signal exists
  if (/\b(happened|occurred|was there|timeline)\b/.test(q)) signals.temporal += 1;
  
  // Procedural signals — "how do I do X?" action/process queries
  if (/\b(how (do|should|can|to)|steps to|process for|procedure for|workflow)\b/.test(q)) signals.procedural += 3;
  if (/\b(deploy|build|test|debug|fix|install|setup|configure|run|execute|ship)\b/.test(q)) signals.procedural += 3;
  if (/\b(step by step|walkthrough|guide|instructions|checklist)\b/.test(q)) signals.procedural += 3;
  if (/\b(best practice|standard|protocol|rule|convention)\b/.test(q)) signals.procedural += 2;
  if (/\b(done before|handled|last time we|usual|normally)\b/.test(q)) signals.procedural += 2;
  
  // Conceptual signals — understanding/reasoning queries
  if (/\b(why|how come|reason|decision|chose|choose|architecture|strategy|approach|principle|philosophy)\b/.test(q)) signals.conceptual += 3;
  if (/\b(explain|understand|insight|thinking|thought process)\b/.test(q)) signals.conceptual += 2;
  if (/\b(trade-?off|versus|compared|alternative)\b/.test(q)) signals.conceptual += 2;
  if (/\b(lesson|learned|takeaway|mistake)\b/.test(q)) signals.conceptual += 2;
  
  // Find the winner
  let maxType: QueryType = 'conceptual'; // default fallback
  let maxScore = 0;
  let totalScore = 0;
  for (const [type, score] of Object.entries(signals)) {
    totalScore += score;
    if (score > maxScore) {
      maxScore = score;
      maxType = type as QueryType;
    }
  }
  
  // Confidence: how clearly one type dominates
  const confidence = totalScore > 0 ? maxScore / totalScore : 0.2;
  
  return { type: maxType, confidence };
}

/**
 * Get retrieval weights based on query classification.
 * Blends the classified type's weights with default weights based on confidence.
 */
function getWeightsForQuery(queryText: string): { weights: WeightProfile; queryType: QueryType; typeConfidence: number } {
  const { type, confidence } = classifyQuery(queryText);
  const typeWeights = QUERY_TYPE_WEIGHTS[type];
  
  // Blend: high confidence = use type-specific weights; low confidence = fall back to default
  const blendFactor = Math.min(1.0, confidence * 1.5); // scale up confidence for blending
  const weights: WeightProfile = {
    text_match: typeWeights.text_match * blendFactor + DEFAULT_WEIGHTS.text_match * (1 - blendFactor),
    graph_proximity: typeWeights.graph_proximity * blendFactor + DEFAULT_WEIGHTS.graph_proximity * (1 - blendFactor),
    importance: typeWeights.importance * blendFactor + DEFAULT_WEIGHTS.importance * (1 - blendFactor),
    recency: typeWeights.recency * blendFactor + DEFAULT_WEIGHTS.recency * (1 - blendFactor),
    confidence: typeWeights.confidence * blendFactor + DEFAULT_WEIGHTS.confidence * (1 - blendFactor),
  };
  
  return { weights, queryType: type, typeConfidence: confidence };
}

/**
 * Search across all memory layers.
 * Returns scored, ranked results from the OpenMemory system.
 */
export async function search(
  queryText: string,
  options: {
    limit?: number;
    weights?: typeof DEFAULT_WEIGHTS;
    memoryTypes?: string[];
    minScore?: number;
  } = {}
): Promise<ScoredResult[]> {
  const limit = options.limit || 10;
  const minScore = options.minScore || 0.1;
  const results: ScoredResult[] = [];
  
  // Query-type-aware weight selection
  const { weights: autoWeights, queryType, typeConfidence } = getWeightsForQuery(queryText);
  const weights = options.weights || autoWeights;
  console.log(`[SEARCH] Query type: ${queryType} (confidence: ${typeConfidence.toFixed(2)}) → weights: tm=${weights.text_match.toFixed(2)} gp=${weights.graph_proximity.toFixed(2)} imp=${weights.importance.toFixed(2)} rec=${weights.recency.toFixed(2)} conf=${weights.confidence.toFixed(2)}`);
  
  // Ensure embedding model is warm
  await warmup();

  const queryLower = queryText.toLowerCase();

  // Phase 0: Semantic Query Routing — detect relationship queries and do targeted graph traversal
  // If query mentions a known person/org + a type concept, boost connected nodes BEFORE embedding search
  const graphBoosts = new Map<string, number>(); // nodeId -> boost score
  if (!options.memoryTypes || options.memoryTypes.includes('semantic')) {
    try {
      const typeKeywords: Record<string, string[]> = {
        project: ['project', 'projects', 'working on', 'building', 'shipping'],
        tool: ['tool', 'tools', 'using', 'tech', 'technology', 'stack'],
        concept: ['concept', 'idea', 'ideas', 'thinking about', 'believes'],
        person: ['person', 'people', 'team', 'who', 'partner', 'working with', 'collaborat'],
        organization: ['company', 'org', 'organization', 'client', 'business'],
        skill: ['skill', 'skills', 'good at', 'capable', 'ability'],
        value: ['value', 'values', 'care about', 'important', 'matters', 'priority', 'priorities'],
      };

      // Find known entities mentioned in the query (quick scan)
      const allNodes = await query(
        'SELECT id, name, type, aliases FROM semantic_nodes ORDER BY confidence DESC'
      );
      const mentionedNodes: { id: string; name: string; type: string }[] = [];
      for (const node of allNodes.rows) {
        const nameLower = node.name.toLowerCase();
        if (nameLower.length >= 3 && queryLower.includes(nameLower)) {
          mentionedNodes.push({ id: node.id, name: node.name, type: node.type });
          continue;
        }
        for (const alias of (node.aliases || [])) {
          if (alias.length >= 3 && queryLower.includes(alias.toLowerCase())) {
            mentionedNodes.push({ id: node.id, name: node.name, type: node.type });
            break;
          }
        }
      }

      // Detect implied types from query (collect all matches, prefer entity-type keywords over abstract ones)
      const impliedTypes: string[] = [];
      for (const [type, keywords] of Object.entries(typeKeywords)) {
        if (keywords.some(kw => queryLower.includes(kw))) {
          impliedTypes.push(type);
        }
      }
      // If multiple types matched, filter out types that match the mentioned entities themselves
      // e.g., if User (person) is mentioned and query says "projects", prefer "project" over "person"
      const mentionedTypes = new Set(mentionedNodes.map(n => n.type));
      const filteredTypes = impliedTypes.filter(t => !mentionedTypes.has(t));
      const impliedType = filteredTypes.length > 0 ? filteredTypes[0] : (impliedTypes.length > 0 ? impliedTypes[0] : null);

      // Always boost explicitly mentioned entities (they should ALWAYS appear in results)
      for (const node of mentionedNodes) {
        graphBoosts.set(node.id, Math.max(graphBoosts.get(node.id) || 0, 1.0));
      }

      // If we have a person/org + an implied type, do targeted graph traversal
      if (mentionedNodes.length > 0 && impliedType) {
        for (const node of mentionedNodes) {
          if (node.type === 'person' || node.type === 'organization') {
            // Get all edges FROM this person to nodes of the implied type (both directions)
            const connected = await query(
              `SELECT t.id, t.name, t.type, e.strength FROM semantic_edges e
               JOIN semantic_nodes t ON e.target_id = t.id
               WHERE e.source_id = $1 AND t.type = $2
               UNION
               SELECT s.id, s.name, s.type, e.strength FROM semantic_edges e
               JOIN semantic_nodes s ON e.source_id = s.id
               WHERE e.target_id = $1 AND s.type = $2`,
              [node.id, impliedType]
            );
            for (const conn of connected.rows) {
              const boost = parseFloat(conn.strength) || 0.5;
              graphBoosts.set(conn.id, Math.max(graphBoosts.get(conn.id) || 0, boost));
            }
          }
        }
      }
    } catch (err) {
      console.warn('[SEARCH] Query routing failed:', (err as Error).message);
    }
  }

  // Generate query embedding once, reuse across layers
  let vec: string | null = null;
  try {
    const queryEmbedding = await embed(queryText);
    vec = `[${queryEmbedding.embedding.join(',')}]`;
  } catch { /* embedding unavailable */ }

  // Layer 0: Embedding similarity search (pgvector)
  let embeddingResults: string[] = []; // IDs of embedding-matched nodes
  if (vec && (!options.memoryTypes || options.memoryTypes.includes('semantic'))) {
    try {
      const embRes = await query(
        `SELECT id, name, type, context, significance, aliases, attributes,
                emotional_weight, confidence, confidence_basis, last_modified,
                1 - (embedding <=> $1::vector) AS similarity
         FROM semantic_nodes
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [vec, limit * 2]
      );
      
      for (const row of embRes.rows) {
        const sim = parseFloat(row.similarity) || 0;
        if (sim < 0.2) continue; // skip very low similarity
        
        const effectiveConf = calculateEffectiveConfidence(
          row.confidence,
          new Date(row.last_modified)
        );
        
        embeddingResults.push(row.id);
        results.push({
          id: row.id,
          memory_type: 'semantic',
          content: formatNodeContent(row),
          name: row.name,
          type: row.type,
          scores: {
            text_match: sim, // use embedding similarity as text_match for now
            graph_proximity: 0,
            importance: effectiveConf,
            recency: computeRecencyScore(new Date(row.last_modified)),
            confidence: effectiveConf,
          },
          total_score: 0,
          metadata: {
            emotional_weight: row.emotional_weight,
            node_type: row.type,
            attributes: row.attributes,
            embedding_similarity: sim,
            confidence_basis: row.confidence_basis,
          },
        });
      }
    } catch (err) {
      // Embedding search is supplementary — fall through to text search
      console.warn('[SEARCH] Embedding search failed:', (err as Error).message);
    }
  }
  
  // Layer 1: Text search across semantic nodes (supplement embedding results)
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
  
  if (!options.memoryTypes || options.memoryTypes.includes('semantic')) {
    // Build word-level OR conditions for broader matching
    const wordConditions = queryWords.map((_, i) => `(
      LOWER(name) LIKE $${i + 2}
      OR LOWER(context) LIKE $${i + 2}
      OR LOWER(significance) LIKE $${i + 2}
      OR EXISTS (SELECT 1 FROM unnest(aliases) alias WHERE LOWER(alias) LIKE $${i + 2})
      OR attributes::text ILIKE $${i + 2}
    )`).join(' OR ');
    
    const wordParams = queryWords.map(w => `%${w}%`);
    
    const nodeResults = await query(
      `SELECT id, type, name, aliases, attributes, context, significance,
              emotional_weight, confidence, last_modified
       FROM semantic_nodes
       WHERE ${wordConditions || 'FALSE'}
       ORDER BY confidence DESC
       LIMIT $1`,
      [limit * 3, ...wordParams]
    );
    
    for (const row of nodeResults.rows) {
      // Skip if already found by embedding search
      if (embeddingResults.includes(row.id)) {
        // Boost the existing result's text_match score
        const existing = results.find(r => r.id === row.id);
        if (existing) {
          const textScore = computeTextMatchScore(queryLower, row);
          existing.scores.text_match = Math.max(existing.scores.text_match, textScore);
        }
        continue;
      }
      
      const textScore = computeTextMatchScore(queryLower, row);
      const recencyScore = computeRecencyScore(new Date(row.last_modified));
      
      results.push({
        id: row.id,
        memory_type: 'semantic',
        content: formatNodeContent(row),
        name: row.name,
        type: row.type,
        scores: {
          text_match: textScore,
          graph_proximity: 0,  // computed in phase 2
          importance: row.confidence,
          recency: recencyScore,
          confidence: row.confidence,
        },
        total_score: 0,  // computed after all scores
        metadata: {
          emotional_weight: row.emotional_weight,
          node_type: row.type,
          attributes: row.attributes,
        },
      });
    }
  }
  
  // Layer 2: Search episodes (embedding similarity + keyword fallback)
  if (!options.memoryTypes || options.memoryTypes.includes('episode')) {
    const episodeIds = new Set<string>();
    
    // 2a: Embedding-based episode search (primary — much better than keyword)
    if (vec) {
      const epEmbRes = await query(
        `SELECT id, summary, detailed_narrative, topics, participants,
                importance_score, emotional_arc, outcome, created_at, access_count,
                1 - (embedding <=> $1::vector) as similarity
         FROM episodes
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [vec, limit * 2]
      );
      
      for (const row of epEmbRes.rows) {
        const sim = parseFloat(row.similarity) || 0;
        if (sim < 0.25) continue;
        episodeIds.add(row.id);
        const recencyScore = computeRecencyScore(new Date(row.created_at));
        
        results.push({
          id: row.id,
          memory_type: 'episode',
          content: `[Episode] ${row.summary}\n${row.detailed_narrative?.substring(0, 200) || ''}`,
          scores: {
            text_match: sim,
            graph_proximity: 0,
            importance: row.importance_score,
            recency: recencyScore,
            confidence: row.importance_score,
          },
          total_score: 0,
          metadata: {
            topics: row.topics,
            participants: row.participants,
            emotional_arc: row.emotional_arc,
            outcome: row.outcome,
          },
        });
      }
    }
    
    // 2b: Keyword fallback for episodes without embeddings
    const epWordConditions = queryWords.map((_, i) => `(
      LOWER(summary) LIKE $${i + 2}
      OR LOWER(detailed_narrative) LIKE $${i + 2}
      OR $${i + 2} = ANY(SELECT LOWER(t) FROM unnest(topics) t)
    )`).join(' OR ');
    const epWordParams = queryWords.map(w => `%${w}%`);
    
    if (epWordConditions) {
      const episodeResults = await query(
        `SELECT id, summary, detailed_narrative, topics, participants,
                importance_score, emotional_arc, outcome, created_at, access_count
         FROM episodes
         WHERE (${epWordConditions})
         ORDER BY importance_score DESC
         LIMIT $1`,
        [limit * 2, ...epWordParams]
      );
      
      for (const row of episodeResults.rows) {
        if (episodeIds.has(row.id)) continue; // Already found by embedding
        const textScore = computeTextMatchScore(queryLower, {
          name: row.summary,
          context: row.detailed_narrative,
        });
        const recencyScore = computeRecencyScore(new Date(row.created_at));
        
        results.push({
          id: row.id,
          memory_type: 'episode',
          content: `[Episode] ${row.summary}\n${row.detailed_narrative?.substring(0, 200) || ''}`,
          scores: {
            text_match: textScore,
            graph_proximity: 0,
            importance: row.importance_score,
            recency: recencyScore,
            confidence: row.importance_score,
          },
          total_score: 0,
          metadata: {
            topics: row.topics,
            participants: row.participants,
            emotional_arc: row.emotional_arc,
            outcome: row.outcome,
          },
        });
      }
    }
  }
  
  // Layer 3: Search lessons
  if (!options.memoryTypes || options.memoryTypes.includes('lesson')) {
    const lessonWordConditions = queryWords.map((_, i) => `(
      LOWER(statement) LIKE $${i + 2}
      OR LOWER(prevention_rule) LIKE $${i + 2}
    )`).join(' OR ');
    const lessonWordParams = queryWords.map(w => `%${w}%`);
    
    const lessonResults = await query(
      `SELECT id, statement, prevention_rule, severity, times_reinforced, created_at
       FROM lessons
       WHERE ${lessonWordConditions || 'FALSE'}
       ORDER BY 
         CASE severity WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
         times_reinforced DESC
       LIMIT $1`,
      [limit, ...lessonWordParams]
    );
    
    for (const row of lessonResults.rows) {
      const severityScore = row.severity === 'critical' ? 1.0 : row.severity === 'important' ? 0.7 : 0.4;
      
      results.push({
        id: row.id,
        memory_type: 'lesson',
        content: `[Lesson - ${row.severity}] ${row.statement}\nPrevention: ${row.prevention_rule}`,
        scores: {
          text_match: computeTextMatchScore(queryLower, { name: row.statement, context: row.prevention_rule }),
          graph_proximity: 0,
          importance: severityScore,
          recency: computeRecencyScore(new Date(row.created_at)),
          confidence: Math.min(1.0, 0.3 + (row.times_reinforced * 0.1)),
        },
        total_score: 0,
        metadata: {
          severity: row.severity,
          times_reinforced: row.times_reinforced,
        },
      });
    }
  }
  
  // Layer 4: Search identity
  if (!options.memoryTypes || options.memoryTypes.includes('identity')) {
    const idWordConditions = queryWords.map((_, i) => `(
      LOWER(key) LIKE $${i + 1} OR LOWER(value) LIKE $${i + 1} OR LOWER(category) LIKE $${i + 1}
    )`).join(' OR ');
    const idWordParams = queryWords.map(w => `%${w}%`);
    
    const identityResults = await query(
      `SELECT id, key, value, category, emotional_weight, times_affirmed
       FROM identity
       WHERE ${idWordConditions || 'FALSE'}`,
      [...idWordParams]
    );
    
    for (const row of identityResults.rows) {
      results.push({
        id: row.id,
        memory_type: 'identity',
        content: `[Identity - ${row.category}] ${row.key}: ${row.value}`,
        scores: {
          text_match: computeTextMatchScore(queryLower, { name: row.key, context: row.value }),
          graph_proximity: 0,
          importance: row.category === 'core' ? 1.0 : row.category === 'value' ? 0.9 : 0.7,
          recency: 1.0,  // identity is always current
          confidence: Math.min(1.0, 0.5 + (row.times_affirmed * 0.05)),
        },
        total_score: 0,
        metadata: {
          category: row.category,
          emotional_weight: row.emotional_weight,
        },
      });
    }
  }
  
  // Layer 5: Search procedures
  if (!options.memoryTypes || options.memoryTypes.includes('procedure')) {
    const procWordConditions = queryWords.map((_, i) => `(
      LOWER(name) LIKE $${i + 2}
      OR steps::text ILIKE $${i + 2}
      OR trigger_conditions::text ILIKE $${i + 2}
    )`).join(' OR ');
    const procWordParams = queryWords.map(w => `%${w}%`);
    
    const procResults = await query(
      `SELECT id, name, type, steps, trigger_conditions, confidence,
              execution_count, success_count, last_executed
       FROM procedures
       WHERE ${procWordConditions || 'FALSE'}
       ORDER BY confidence DESC
       LIMIT $1`,
      [limit, ...procWordParams]
    );
    
    for (const row of procResults.rows) {
      const stepsText = Array.isArray(row.steps) 
        ? row.steps.map((s: any) => s.action || s).join('. ') 
        : JSON.stringify(row.steps);
      
      results.push({
        id: row.id,
        memory_type: 'procedure',
        content: `[Procedure - ${row.type}] ${row.name}\nSteps: ${stepsText.substring(0, 300)}`,
        name: row.name,
        type: row.type,
        scores: {
          text_match: computeTextMatchScore(queryLower, { name: row.name, context: stepsText }),
          graph_proximity: 0,
          importance: row.confidence,
          recency: row.last_executed ? computeRecencyScore(new Date(row.last_executed)) : 0.3,
          confidence: row.confidence,
        },
        total_score: 0,
        metadata: {
          execution_count: row.execution_count,
          success_count: row.success_count,
          success_rate: row.execution_count > 0 ? row.success_count / row.execution_count : 0,
          trigger_conditions: row.trigger_conditions,
        },
      });
    }
  }

  // Layer 6: Search markdown files (the "books I've written")
  if (!options.memoryTypes || options.memoryTypes.includes('markdown')) {
    try {
      const mdResults = await searchMarkdown(queryText, { 
        limit: limit * 2,
        minScore: 0.15,
      });
      
      for (const md of mdResults) {
        results.push({
          id: md.id,
          memory_type: 'markdown',
          content: `[${md.source_file}] ${md.section_header}\n${md.content}`,
          name: md.section_header,
          type: md.source_file,
          scores: {
            text_match: md.scores.text_match,
            graph_proximity: 0,  // markdown doesn't participate in graph
            importance: md.scores.file_priority,
            recency: md.scores.recency,
            confidence: md.scores.file_priority, // file priority as proxy for confidence
          },
          total_score: 0,  // recomputed in Phase 3
          metadata: {
            source_file: md.source_file,
            section_header: md.section_header,
            line_start: md.line_start,
            line_end: md.line_end,
          },
        });
      }
    } catch (err) {
      console.warn('[SEARCH] Markdown search failed:', (err as Error).message);
    }
  }

  // Phase 1.5: Apply query routing graph boosts
  // Nodes identified by semantic query routing get BOTH graph_proximity AND text_match boosted
  // This ensures they outrank generically-connected nodes that also get gp=1.0 from Phase 2 traversal
  if (graphBoosts.size > 0) {
    for (const result of results) {
      const boost = graphBoosts.get(result.id);
      if (boost !== undefined) {
        result.scores.graph_proximity = Math.max(result.scores.graph_proximity, boost);
        // Query-routed nodes get a relevance boost to text_match (they're semantically relevant even if words don't match)
        result.scores.text_match = Math.max(result.scores.text_match, 0.7 * boost);
        (result.metadata as any).query_routed = true;
      }
    }
    // Also inject any boosted nodes that weren't found by text/embedding search
    for (const [nodeId, boost] of graphBoosts) {
      if (!results.find(r => r.id === nodeId)) {
        try {
          const nodeRes = await query(
            'SELECT id, name, type, context, significance, aliases, attributes, emotional_weight, confidence, last_modified FROM semantic_nodes WHERE id = $1',
            [nodeId]
          );
          if (nodeRes.rows.length > 0) {
            const row = nodeRes.rows[0];
            const effectiveConf = calculateEffectiveConfidence(row.confidence, new Date(row.last_modified));
            results.push({
              id: row.id,
              memory_type: 'semantic',
              content: formatNodeContent(row),
              name: row.name,
              type: row.type,
              scores: {
                text_match: 0,
                graph_proximity: boost,
                importance: effectiveConf,
                recency: computeRecencyScore(new Date(row.last_modified)),
                confidence: effectiveConf,
              },
              total_score: 0,
              metadata: {
                emotional_weight: row.emotional_weight,
                node_type: row.type,
                attributes: row.attributes,
                injected_by: 'query_routing',
              },
            });
          }
        } catch { /* supplementary */ }
      }
    }
  }

  // Phase 2: Compute graph proximity for top results
  // (Only for semantic nodes that we found — traverse from them to boost connected results)
  const semanticResults = results.filter(r => r.memory_type === 'semantic' && r.name);
  for (const sr of semanticResults.slice(0, 5)) {
    try {
      const connected = await traverseGraph(sr.name!, sr.type as EntityType, 2);
      
      // Boost any other results that are graph-connected
      // But don't override query-routing boosts (which use edge strength for differentiation)
      for (const conn of connected) {
        const connectedResult = results.find(
          r => r.name && conn.endpoint === r.name && r.id !== sr.id
        );
        if (connectedResult) {
          const depthScore = 1.0 / conn.depth;
          // If this node was boosted by query routing, keep the edge-strength-based score
          // to preserve differentiation between active/paused projects
          if (!graphBoosts.has(connectedResult.id)) {
            connectedResult.scores.graph_proximity = Math.max(
              connectedResult.scores.graph_proximity,
              depthScore
            );
          }
        }
      }
    } catch {
      // Graph traversal is supplementary
    }
  }
  
  // Phase 3: Compute total scores using query-type-aware weights
  // 
  // Key insight (Mar 13, 2026): Different cognitive tasks need different retrieval strategies.
  // Factual queries need keyword precision. Emotional queries need identity/episodic layers.
  // Temporal queries need recency. Relational queries need graph traversal.
  //
  // Layer affinity: Each query type naturally aligns with certain memory layers.
  // Results from aligned layers get a boost; misaligned layers get no penalty (just no boost).
  const layerAffinity: Record<QueryType, Record<string, number>> = {
    factual:    { semantic: 0.9, markdown: 1.2, lesson: 1.0, episode: 0.8, identity: 0.7, procedure: 0.8 },
    relational: { semantic: 1.15, markdown: 0.9, lesson: 0.8, episode: 0.9, identity: 0.85, procedure: 0.8 },
    emotional:  { semantic: 0.9, markdown: 1.0, lesson: 0.9, episode: 1.1, identity: 1.2, procedure: 0.7 },
    temporal:   { semantic: 0.85, markdown: 1.1, lesson: 0.9, episode: 1.2, identity: 0.7, procedure: 0.8 },
    conceptual: { semantic: 1.05, markdown: 1.1, lesson: 1.1, episode: 0.9, identity: 1.0, procedure: 0.9 },
    procedural: { semantic: 0.8, markdown: 1.0, lesson: 1.15, episode: 0.9, identity: 0.8, procedure: 1.35 },
  };
  
  const affinities = layerAffinity[queryType] || {};
  
  // Markdown results use different weights since they don't have graph proximity.
  const mdWeights = {
    text_match: weights.text_match + weights.graph_proximity * 0.6,
    importance: weights.importance,
    recency: weights.recency + weights.graph_proximity * 0.4,
    confidence: weights.confidence,
  };
  
  for (const result of results) {
    if (result.memory_type === 'markdown') {
      result.total_score = 
        result.scores.text_match * mdWeights.text_match +
        result.scores.importance * mdWeights.importance +
        result.scores.recency * mdWeights.recency +
        result.scores.confidence * mdWeights.confidence;
    } else {
      result.total_score = 
        result.scores.text_match * weights.text_match +
        result.scores.graph_proximity * weights.graph_proximity +
        result.scores.importance * weights.importance +
        result.scores.recency * weights.recency +
        result.scores.confidence * weights.confidence;
      
      // Context richness penalty for thin nodes
      const contextLen = result.content?.length || 0;
      if (contextLen < 50) {
        result.total_score *= 0.6;
      } else if (contextLen < 100) {
        result.total_score *= 0.8;
      }
      // Confidence basis boost
      if ((result.metadata as any)?.confidence_basis === 'stated') {
        result.total_score *= 1.05;
      }
    }
    
    // Apply layer affinity boost based on query type
    const layerBoost = affinities[result.memory_type] || 1.0;
    result.total_score *= layerBoost;
    
    // Procedural activation: boost proven procedures for procedural queries
    if (result.memory_type === 'procedure' && queryType === 'procedural') {
      const successRate = (result.metadata as any)?.success_rate || 0;
      const execCount = (result.metadata as any)?.execution_count || 0;
      // Proven procedures get up to 1.3x boost (more executions + higher success = stronger boost)
      if (execCount > 0) {
        const experienceBoost = 1.0 + (Math.min(execCount, 10) / 10) * 0.15 * successRate;
        result.total_score *= experienceBoost;
        (result.metadata as any).experience_boost = experienceBoost;
      }
    }
    
    // Tag with query classification for debugging/tuning
    (result.metadata as any).query_type = queryType;
    (result.metadata as any).query_type_confidence = typeConfidence;
    (result.metadata as any).layer_affinity = layerBoost;
  }
  
  // Sort by total score and return top N
  const topResults = results
    .filter(r => r.total_score >= minScore)
    .sort((a, b) => b.total_score - a.total_score)
    .slice(0, limit);
  
  // Track access for returned episodes (async, non-blocking)
  const episodeIds = topResults
    .filter(r => r.memory_type === 'episode')
    .map(r => r.id);
  if (episodeIds.length > 0) {
    query(
      `UPDATE episodes SET access_count = access_count + 1, last_accessed = NOW() WHERE id = ANY($1)`,
      [episodeIds]
    ).catch(() => { /* non-critical */ });
  }
  
  return topResults;
}

// ============================================================
// SCORING HELPERS
// ============================================================

function computeTextMatchScore(queryLower: string, row: { name?: string; context?: string; significance?: string }): number {
  let score = 0;
  const fields = [row.name, row.context, row.significance].filter(Boolean);
  
  for (const field of fields) {
    const lower = (field as string).toLowerCase();
    
    // Exact phrase match
    if (lower.includes(queryLower)) {
      score = Math.max(score, 0.9);
    }
    
    // Word-level matching
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
    const matchedWords = queryWords.filter(w => lower.includes(w));
    const wordScore = queryWords.length > 0 ? matchedWords.length / queryWords.length : 0;
    score = Math.max(score, wordScore * 0.8);
  }
  
  return Math.min(1.0, score);
}

function computeRecencyScore(date: Date): number {
  const daysSince = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
  
  // Exponential decay: half-life of 30 days
  return Math.exp(-0.693 * daysSince / 30);
}

function formatNodeContent(row: any): string {
  let content = `[${row.type}] ${row.name}`;
  if (row.context) content += `\n${row.context}`;
  if (row.significance) content += `\nSignificance: ${row.significance}`;
  if (row.attributes && Object.keys(row.attributes).length > 0) {
    const attrs = Object.entries(row.attributes)
      .map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n');
    content += `\nAttributes:\n${attrs}`;
  }
  return content;
}
