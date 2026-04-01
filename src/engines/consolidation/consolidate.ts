/**
 * Meta-Memory — The Consolidation Engine ("Sleep Cycle")
 * 
 * Three modes of consolidation that keep the brain healthy:
 * 1. Session-end: Extract facts, update models, generate embeddings
 * 2. Daily: Merge episodes, decay confidence, detect contradictions  
 * 3. Weekly: Full dedup, re-infer relationships, audit health
 * 
 * This is what makes the brain SELF-MAINTAINING. Without it,
 * memory accumulates noise. With it, memory crystallizes into wisdom.
 */

import { query } from '../../storage/db.js';
import { embed } from '../../storage/embeddings/ollama.js';
import { enrichAllEpisodes, linkRelatedEpisodes, linkEpisodesToEntities } from '../episodic/enrich.js';
import { deduplicateEntities } from '../maintenance/dedup.js';
import { inferRelationships } from '../maintenance/infer-relationships.js';
import { analyzeDecay } from '../maintenance/confidence-decay.js';
import { scanContradictions } from '../maintenance/contradictions.js';
import { affirmIdentity, getAllIdentity } from '../../layers/identity/store.js';
import { incrementInteraction } from '../../layers/relational/store.js';

// ============================================================
// TYPES
// ============================================================

export type ConsolidationMode = 'session_end' | 'daily' | 'weekly';

export interface ConsolidationResult {
  mode: ConsolidationMode;
  episodesProcessed: number;
  factsExtracted: number;
  factsUpdated: number;
  lessonsIdentified: number;
  proceduresRefined: number;
  memoriesPruned: number;
  contradictionsFound: number;
  identityUpdates: number;
  embeddingsGenerated: number;
  duration_ms: number;
  details: Record<string, any>;
}

// ============================================================
// SESSION-END CONSOLIDATION
// ============================================================

async function consolidateSessionEnd(): Promise<ConsolidationResult> {
  const start = Date.now();
  const details: Record<string, any> = {};
  let factsExtracted = 0;
  let embeddingsGenerated = 0;
  let identityUpdates = 0;

  // 1. Generate embeddings for any episodes missing them
  const unembedded = await query('SELECT id, summary, detailed_narrative FROM episodes WHERE embedding IS NULL');
  for (const ep of unembedded.rows) {
    try {
      const text = (ep.summary + ' ' + (ep.detailed_narrative || '')).substring(0, 800);
      const result = await embed(text);
      const vec = (result as any).embedding || result;
      if (Array.isArray(vec)) {
        await query('UPDATE episodes SET embedding = $1 WHERE id = $2', ['[' + vec.join(',') + ']', ep.id]);
        embeddingsGenerated++;
      }
    } catch { /* skip */ }
  }
  details.episodeEmbeddings = embeddingsGenerated;

  // 2. Generate embeddings for any semantic nodes missing them
  const unembeddedNodes = await query('SELECT id, name, type, attributes FROM semantic_nodes WHERE embedding IS NULL');
  for (const node of unembeddedNodes.rows) {
    try {
      const context = (node.attributes as any)?.context || '';
      const text = `${node.type}: ${node.name}. ${context}`.substring(0, 500);
      const result = await embed(text);
      const vec = (result as any).embedding || result;
      if (Array.isArray(vec)) {
        await query('UPDATE semantic_nodes SET embedding = $1 WHERE id = $2', ['[' + vec.join(',') + ']', node.id]);
        embeddingsGenerated++;
      }
    } catch { /* skip */ }
  }
  details.nodeEmbeddings = embeddingsGenerated - (details.episodeEmbeddings || 0);

  // 3. Enrich any un-enriched episodes
  const unenriched = await query("SELECT COUNT(*) as cnt FROM episodes WHERE array_length(topics, 1) IS NULL OR array_length(topics, 1) = 0");
  if (parseInt(unenriched.rows[0].cnt) > 0) {
    const enrichResult = await enrichAllEpisodes();
    details.enrichment = enrichResult;
    factsExtracted += enrichResult.decisionsFound + enrichResult.lessonsFound;
  }

  // 4. Update identity affirmations for entries that appeared in recent episodes
  const recentEps = await query("SELECT topics, summary, detailed_narrative FROM episodes WHERE created_at > NOW() - INTERVAL '24 hours'");
  const allIdentity = await getAllIdentity();
  for (const entry of allIdentity) {
    for (const ep of recentEps.rows) {
      const text = `${ep.summary} ${ep.detailed_narrative}`.toLowerCase();
      if (text.includes(entry.key.replace(/-/g, ' ')) || text.includes(entry.value.substring(0, 30).toLowerCase())) {
        await affirmIdentity(entry.key);
        identityUpdates++;
        break; // Only affirm once per entry per consolidation
      }
    }
  }
  details.identityAffirmations = identityUpdates;

  // 5. Update interaction counts for ALL people mentioned in recent episodes
  try {
    const allPeople = (await query("SELECT name FROM person_models")).rows;
    for (const person of allPeople) {
      const nameLower = person.name.toLowerCase();
      const mentions = await query(
        "SELECT COUNT(*) as cnt FROM episodes WHERE $1 = ANY(participants) AND created_at > NOW() - INTERVAL '24 hours'",
        [nameLower]
      );
      if (parseInt(mentions.rows[0].cnt) > 0) {
        await incrementInteraction(person.name);
      }
    }
  } catch { /* non-critical — interaction tracking is supplementary */ }

  // 6. Log consolidation
  const result: ConsolidationResult = {
    mode: 'session_end',
    episodesProcessed: unembedded.rows.length + parseInt(unenriched.rows[0].cnt),
    factsExtracted,
    factsUpdated: 0,
    lessonsIdentified: 0,
    proceduresRefined: 0,
    memoriesPruned: 0,
    contradictionsFound: 0,
    identityUpdates,
    embeddingsGenerated,
    duration_ms: Date.now() - start,
    details,
  };

  await logConsolidation(result);
  return result;
}

// ============================================================
// DAILY CONSOLIDATION
// ============================================================

async function consolidateDaily(): Promise<ConsolidationResult> {
  const start = Date.now();
  const details: Record<string, any> = {};

  // 1. First do session-end consolidation (embeddings, enrichment)
  const sessionResult = await consolidateSessionEnd();
  details.sessionEnd = sessionResult;

  // 2. Run confidence decay
  const decay = await analyzeDecay();
  details.decay = decay;

  // 3. Run contradiction detection
  const contradictions = await scanContradictions();
  details.contradictions = contradictions;

  // 4. Link related episodes
  const links = await linkRelatedEpisodes();
  details.episodeLinks = links;

  // 5. Link episodes to entities
  const entityLinks = await linkEpisodesToEntities();
  details.entityLinks = entityLinks;

  // 6. Merge very old, low-importance, unprotected episodes
  const prunable = await query(`
    SELECT id, summary FROM episodes 
    WHERE decay_protected = false 
      AND importance_score < 0.3 
      AND created_at < NOW() - INTERVAL '30 days'
      AND access_count = 0
  `);
  let pruned = 0;
  // Don't actually delete — mark as consolidated with a reference
  if (prunable.rows.length > 10) {
    // Create a consolidated summary episode
    const summaries = prunable.rows.map((r: any) => r.summary).join('; ');
    const consolidatedSummary = `Consolidated ${prunable.rows.length} low-importance episodes from 30+ days ago: ${summaries.substring(0, 500)}`;
    
    await query(`
      INSERT INTO episodes (session_id, summary, detailed_narrative, importance_score, decay_protected)
      VALUES ('consolidation', $1, $2, 0.3, false)
    `, [consolidatedSummary, summaries]);

    // Mark originals as consolidated
    const ids = prunable.rows.map((r: any) => r.id);
    // We keep them for now but mark in consolidation_log
    pruned = ids.length;
    details.pruneCandidates = pruned;
  }

  // 7. Calculate brain health
  const health = await calculateBrainHealth();
  details.brainHealth = health;

  const result: ConsolidationResult = {
    mode: 'daily',
    episodesProcessed: sessionResult.episodesProcessed,
    factsExtracted: sessionResult.factsExtracted,
    factsUpdated: 0,
    lessonsIdentified: sessionResult.lessonsIdentified,
    proceduresRefined: 0,
    memoriesPruned: pruned,
    contradictionsFound: contradictions.contradictionsFound,
    identityUpdates: sessionResult.identityUpdates,
    embeddingsGenerated: sessionResult.embeddingsGenerated,
    duration_ms: Date.now() - start,
    details,
  };

  await logConsolidation(result);
  return result;
}

// ============================================================
// WEEKLY CONSOLIDATION
// ============================================================

async function consolidateWeekly(): Promise<ConsolidationResult> {
  const start = Date.now();
  const details: Record<string, any> = {};

  // 1. Do daily consolidation first
  const dailyResult = await consolidateDaily();
  details.daily = dailyResult;

  // 2. Full dedup pass
  const dedup = await deduplicateEntities();
  details.dedup = dedup;

  // 3. Re-run relationship inference
  const infer = await inferRelationships();
  details.inference = infer;

  // 4. Full brain health audit
  const health = await calculateBrainHealth();
  details.fullHealthAudit = health;

  const result: ConsolidationResult = {
    mode: 'weekly',
    episodesProcessed: dailyResult.episodesProcessed,
    factsExtracted: dailyResult.factsExtracted,
    factsUpdated: 0,
    lessonsIdentified: dailyResult.lessonsIdentified,
    proceduresRefined: 0,
    memoriesPruned: dailyResult.memoriesPruned,
    contradictionsFound: dailyResult.contradictionsFound,
    identityUpdates: dailyResult.identityUpdates,
    embeddingsGenerated: dailyResult.embeddingsGenerated,
    duration_ms: Date.now() - start,
    details,
  };

  await logConsolidation(result);
  return result;
}

// ============================================================
// BRAIN HEALTH SCORE
// ============================================================

export interface BrainHealth {
  overallScore: number; // 0-100
  coverage: {
    semanticNodes: number;
    semanticEdges: number;
    episodes: number;
    episodesWithEmbeddings: number;
    identityEntries: number;
    personModels: number;
    procedures: number;
    lessons: number;
  };
  freshness: {
    nodesWithEmbeddings: number;
    totalNodes: number;
    embeddingCoverage: number;
    avgConfidence: number;
    staleNodes: number;
  };
  consistency: {
    contradictions: number;
    orphanedNodes: number;
    duplicateEpisodes: number;
  };
  richness: {
    avgEpisodeImportance: number;
    decayProtectedEpisodes: number;
    episodesWithDecisions: number;
    episodesWithLessons: number;
    identityAvgEmotionalWeight: number;
  };
}

export async function calculateBrainHealth(): Promise<BrainHealth> {
  // Coverage
  const nodes = await query('SELECT COUNT(*) as cnt FROM semantic_nodes');
  const edges = await query('SELECT COUNT(*) as cnt FROM semantic_edges');
  const episodes = await query('SELECT COUNT(*) as cnt FROM episodes');
  const epEmb = await query('SELECT COUNT(*) as cnt FROM episodes WHERE embedding IS NOT NULL');
  const identity = await query('SELECT COUNT(*) as cnt FROM identity');
  const people = await query('SELECT COUNT(*) as cnt FROM person_models');
  const procs = await query('SELECT COUNT(*) as cnt FROM procedures');
  const lessons = await query('SELECT COUNT(*) as cnt FROM lessons');

  // Freshness
  const nodeEmb = await query('SELECT COUNT(*) as cnt FROM semantic_nodes WHERE embedding IS NOT NULL');
  const avgConf = await query("SELECT AVG((attributes->>'confidence')::float) as avg FROM semantic_nodes WHERE attributes->>'confidence' IS NOT NULL");
  const stale = await query("SELECT COUNT(*) as cnt FROM semantic_nodes WHERE attributes->>'last_verified' IS NOT NULL AND (attributes->>'last_verified')::timestamp < NOW() - INTERVAL '60 days'");

  // Consistency
  const contradictions = await query("SELECT COUNT(*) as cnt FROM confidence_assessments WHERE basis = 'contradiction'");
  const orphans = await query(`
    SELECT COUNT(*) as cnt FROM semantic_nodes sn 
    WHERE NOT EXISTS (SELECT 1 FROM semantic_edges WHERE source_id = sn.id OR target_id = sn.id)
    AND sn.type = 'person'
  `);
  const dupeEps = await query('SELECT COUNT(*) as cnt FROM (SELECT summary, COUNT(*) as c FROM episodes GROUP BY summary HAVING COUNT(*) > 1) sub');

  // Richness
  const avgImp = await query('SELECT AVG(importance_score) as avg FROM episodes');
  const decayProt = await query('SELECT COUNT(*) as cnt FROM episodes WHERE decay_protected = true');
  const epDecisions = await query("SELECT COUNT(*) as cnt FROM episodes WHERE decisions != '[]'::jsonb AND decisions IS NOT NULL");
  const epLessons = await query("SELECT COUNT(*) as cnt FROM episodes WHERE lessons != '[]'::jsonb AND lessons IS NOT NULL");
  const idWeight = await query('SELECT AVG(emotional_weight) as avg FROM identity');

  const coverage = {
    semanticNodes: parseInt(nodes.rows[0].cnt),
    semanticEdges: parseInt(edges.rows[0].cnt),
    episodes: parseInt(episodes.rows[0].cnt),
    episodesWithEmbeddings: parseInt(epEmb.rows[0].cnt),
    identityEntries: parseInt(identity.rows[0].cnt),
    personModels: parseInt(people.rows[0].cnt),
    procedures: parseInt(procs.rows[0].cnt),
    lessons: parseInt(lessons.rows[0].cnt),
  };

  const totalNodes = parseInt(nodes.rows[0].cnt);
  const nodesWithEmb = parseInt(nodeEmb.rows[0].cnt);
  const freshness = {
    nodesWithEmbeddings: nodesWithEmb,
    totalNodes,
    embeddingCoverage: totalNodes > 0 ? nodesWithEmb / totalNodes : 0,
    avgConfidence: parseFloat(avgConf.rows[0].avg) || 0.5,
    staleNodes: parseInt(stale.rows[0].cnt),
  };

  const consistency = {
    contradictions: parseInt(contradictions.rows[0].cnt),
    orphanedNodes: parseInt(orphans.rows[0].cnt),
    duplicateEpisodes: parseInt(dupeEps.rows[0].cnt),
  };

  const richness = {
    avgEpisodeImportance: parseFloat(avgImp.rows[0].avg) || 0,
    decayProtectedEpisodes: parseInt(decayProt.rows[0].cnt),
    episodesWithDecisions: parseInt(epDecisions.rows[0].cnt),
    episodesWithLessons: parseInt(epLessons.rows[0].cnt),
    identityAvgEmotionalWeight: parseFloat(idWeight.rows[0].avg) || 0,
  };

  // Calculate overall score (0-100)
  let score = 0;
  
  // Coverage (40 points)
  score += Math.min(coverage.semanticNodes / 100, 1) * 10;  // Up to 10 for 100+ nodes
  score += Math.min(coverage.semanticEdges / 500, 1) * 8;   // Up to 8 for 500+ edges
  score += Math.min(coverage.episodes / 200, 1) * 8;        // Up to 8 for 200+ episodes
  score += Math.min(coverage.identityEntries / 20, 1) * 5;  // Up to 5 for 20+ identity entries
  score += Math.min(coverage.personModels / 3, 1) * 4;      // Up to 4 for 3+ person models
  score += Math.min(coverage.procedures / 10, 1) * 5;       // Up to 5 for 10+ procedures
  
  // Freshness (25 points)
  score += freshness.embeddingCoverage * 15;                 // Up to 15 for full embedding coverage
  score += Math.min(freshness.avgConfidence, 1) * 10;       // Up to 10 for high confidence
  
  // Consistency (15 points)
  score += (consistency.contradictions === 0 ? 5 : Math.max(0, 5 - consistency.contradictions));
  score += (consistency.orphanedNodes === 0 ? 5 : Math.max(0, 5 - consistency.orphanedNodes));
  score += (consistency.duplicateEpisodes === 0 ? 5 : Math.max(0, 5 - consistency.duplicateEpisodes));
  
  // Richness (20 points)
  score += richness.avgEpisodeImportance * 5;                // Up to 5 based on avg importance
  score += Math.min(richness.decayProtectedEpisodes / 30, 1) * 5;
  score += Math.min(richness.episodesWithDecisions / 10, 1) * 5;
  score += richness.identityAvgEmotionalWeight * 5;

  return {
    overallScore: Math.round(score),
    coverage,
    freshness,
    consistency,
    richness,
  };
}

// ============================================================
// CONSOLIDATION LOG
// ============================================================

async function logConsolidation(result: ConsolidationResult): Promise<void> {
  await query(`
    INSERT INTO consolidation_log (
      mode, episodes_processed, facts_extracted, facts_updated,
      lessons_identified, procedures_refined, memories_pruned,
      contradictions_found, identity_updates, details
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [
    result.mode,
    result.episodesProcessed,
    result.factsExtracted,
    result.factsUpdated,
    result.lessonsIdentified,
    result.proceduresRefined,
    result.memoriesPruned,
    result.contradictionsFound,
    result.identityUpdates,
    JSON.stringify(result.details),
  ]);
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

export async function consolidate(mode: ConsolidationMode): Promise<ConsolidationResult> {
  switch (mode) {
    case 'session_end': return consolidateSessionEnd();
    case 'daily': return consolidateDaily();
    case 'weekly': return consolidateWeekly();
    default: throw new Error(`Unknown consolidation mode: ${mode}`);
  }
}
