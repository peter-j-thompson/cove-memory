/**
 * Cross-Layer Edge Builder
 * 
 * Creates typed edges BETWEEN memory layers in the semantic_edges table:
 * 
 * 1. APPLIES_IN_CONTEXT: Procedure → Semantic node (skill applies in this domain)
 * 2. LEARNED_FROM: Procedure → Episode (skill was learned from this experience)  
 * 3. SHAPED_BY_IDENTITY: Identity → Procedure (values shape how skill executes)
 * 4. COMPOSED_OF: Procedure → Procedure (skill hierarchy)
 * 5. REFINED_BY_EXPERIENCE: Episode → Procedure (experience improved this skill)
 *
 * Run during sleep cycles to build and maintain cross-layer connections.
 * 
 * Schema: semantic_edges (id, source_id, target_id, relationship, category, strength, confidence, context)
 */

import { query } from '../../storage/db.js';

interface CrossLayerResult {
  appliesInContext: number;
  learnedFrom: number;
  shapedByIdentity: number;
  composedOf: number;
  refinedByExperience: number;
  errors: string[];
  duration_ms: number;
}

async function edgeExists(sourceId: string, targetId: string, relationship: string): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM ag_catalog.cross_layer_edges WHERE source_id = $1 AND target_id = $2 AND relationship = $3 LIMIT 1`,
    [sourceId, targetId, relationship]
  );
  return res.rows.length > 0;
}

async function createCrossEdge(
  sourceId: string, targetId: string, relationship: string, 
  strength: number, confidence: number, context: string,
  sourceLayer: string = 'unknown', targetLayer: string = 'unknown'
): Promise<boolean> {
  try {
    if (await edgeExists(sourceId, targetId, relationship)) return false;
    await query(
      `INSERT INTO ag_catalog.cross_layer_edges (source_id, source_layer, target_id, target_layer, relationship, strength, confidence, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source_id, target_id, relationship) DO NOTHING`,
      [sourceId, sourceLayer, targetId, targetLayer, relationship, strength, confidence, context]
    );
    return true;
  } catch (err: any) {
    console.error(`[CROSS-LAYER] Edge creation error: ${err.message}`);
    return false;
  }
}

/**
 * Build cross-layer edges between procedures, episodes, semantic nodes, and identity.
 */
export async function buildCrossLayerEdges(): Promise<CrossLayerResult> {
  const start = Date.now();
  const result: CrossLayerResult = {
    appliesInContext: 0, learnedFrom: 0, shapedByIdentity: 0,
    composedOf: 0, refinedByExperience: 0, errors: [], duration_ms: 0,
  };

  try {
    // Load all data
    const procedures = (await query(
      'SELECT id, name, type, trigger_conditions, steps, learned_from, refined_from FROM ag_catalog.procedures'
    )).rows;
    
    const semanticNodes = (await query(
      `SELECT id, name, type, context FROM ag_catalog.semantic_nodes 
       WHERE type IN ('concept', 'technology', 'tool', 'project', 'organization')`
    )).rows;
    
    const identityEntries = (await query(
      'SELECT id, category, key, value, emotional_weight FROM ag_catalog.identity'
    )).rows;

    const recentEpisodes = (await query(
      `SELECT id, summary, detailed_narrative FROM ag_catalog.episodes ORDER BY created_at DESC LIMIT 100`
    )).rows;

    const lessons = (await query(
      `SELECT l.id, l.statement, l.severity, l.learned_from, e.id as episode_id
       FROM ag_catalog.lessons l
       LEFT JOIN ag_catalog.episodes e ON l.learned_from = e.id`
    )).rows;

    // ========================================================
    // 1. APPLIES_IN_CONTEXT: Procedure → Semantic node
    // ========================================================
    for (const proc of procedures) {
      const procName = (proc.name || '').toLowerCase().replace(/[-_]/g, ' ');
      const triggerPhrases: string[] = (proc.trigger_conditions as any)?.phrases || [];
      const stepsText = JSON.stringify(proc.steps || []).toLowerCase();
      
      for (const node of semanticNodes) {
        const nodeName = (node.name || '').toLowerCase();
        const nodeContext = (node.context || '').toLowerCase();
        
        // Match: trigger phrases mention node, OR node context mentions procedure concept
        let score = 0;
        for (const phrase of triggerPhrases) {
          if (nodeContext.includes(phrase.toLowerCase())) score += 2;
          if (nodeName.includes(phrase.toLowerCase())) score += 3;
        }
        // Steps mention the node
        if (nodeName.length > 4 && stepsText.includes(nodeName)) score += 2;
        // Node context mentions procedure name words
        const procWords = procName.split(/\s+/).filter((w: string) => w.length > 3);
        for (const w of procWords) {
          if (nodeContext.includes(w)) score += 1;
        }
        
        if (score >= 3) { // Require minimum relevance
          const created = await createCrossEdge(
            proc.id, node.id, 'APPLIES_IN_CONTEXT',
            Math.min(0.5 + score * 0.05, 0.95), 0.7,
            `Procedure "${proc.name}" applies in context of "${node.name}" (score: ${score})`,
            'procedure', 'semantic'
          );
          if (created) result.appliesInContext++;
        }
      }
    }

    // ========================================================
    // 2. LEARNED_FROM: Procedure → Episode
    // ========================================================
    for (const proc of procedures) {
      // Direct links from learned_from array
      const learnedFrom = proc.learned_from || [];
      for (const epId of learnedFrom) {
        const created = await createCrossEdge(
          proc.id, epId, 'LEARNED_FROM', 0.9, 0.85,
          `Procedure "${proc.name}" was learned from this episode`,
          'procedure', 'episode'
        );
        if (created) result.learnedFrom++;
      }
      
      // Keyword-based episode linking
      const procKeywords = (proc.name || '').toLowerCase().split(/[-_\s]+/).filter((w: string) => w.length > 3);
      for (const ep of recentEpisodes) {
        const epText = `${ep.summary || ''} ${ep.detailed_narrative || ''}`.toLowerCase();
        const matchCount = procKeywords.filter((kw: string) => epText.includes(kw)).length;
        if (matchCount >= 2) {
          const created = await createCrossEdge(
            proc.id, ep.id, 'LEARNED_FROM', 0.6, 0.65,
            `Procedure "${proc.name}" referenced in episode (${matchCount} keyword matches)`,
            'procedure', 'episode'
          );
          if (created) result.learnedFrom++;
        }
      }
    }

    // ========================================================
    // 3. SHAPED_BY_IDENTITY: Identity → Procedure
    // ========================================================
    const identityProcMap: Record<string, string[]> = {
      'value': ['social', 'creative', 'cognitive'],
      'belief': ['cognitive', 'creative'],
      'growth_edge': ['cognitive', 'technical'],
      'voice': ['social', 'creative'],
      'covenant': ['social', 'cognitive'],
    };

    for (const identity of identityEntries) {
      const applicableTypes = identityProcMap[identity.category] || [];
      const identityValue = (identity.value || '').toLowerCase();
      
      for (const proc of procedures) {
        const procType = (proc.type || '').toLowerCase();
        const typeMatch = applicableTypes.includes(procType);
        const procName = (proc.name || '').toLowerCase();
        const textMatch = identityValue.includes(procName.replace(/[-_]/g, ' ')) || 
                         procName.includes(identity.key?.toLowerCase().replace(/[-_]/g, ' ') || '');
        
        if (typeMatch || textMatch) {
          const weight = (identity.emotional_weight || 0.5) * (typeMatch && textMatch ? 1.0 : 0.7);
          const created = await createCrossEdge(
            identity.id, proc.id, 'SHAPED_BY_IDENTITY',
            Math.min(weight, 0.95), 0.75,
            `Identity "${identity.key}" (${identity.category}) shapes "${proc.name}" (${proc.type})`,
            'identity', 'procedure'
          );
          if (created) result.shapedByIdentity++;
        }
      }
    }

    // ========================================================
    // 4. COMPOSED_OF: Procedure → Procedure (skill hierarchy)
    // ========================================================
    for (const proc of procedures) {
      const stepsText = JSON.stringify(proc.steps || []).toLowerCase();
      for (const otherProc of procedures) {
        if (proc.id === otherProc.id) continue;
        const otherName = (otherProc.name || '').toLowerCase().replace(/[-_]/g, ' ');
        if (otherName.length > 5 && stepsText.includes(otherName)) {
          const created = await createCrossEdge(
            proc.id, otherProc.id, 'COMPOSED_OF', 0.8, 0.7,
            `Procedure "${proc.name}" includes "${otherProc.name}" as a sub-step`,
            'procedure', 'procedure'
          );
          if (created) result.composedOf++;
        }
      }
    }

    // ========================================================
    // 5. REFINED_BY_EXPERIENCE: Episode (with lesson) → Procedure
    // ========================================================
    for (const lesson of lessons) {
      if (!lesson.episode_id) continue;
      const lessonText = (lesson.statement || '').toLowerCase();
      
      for (const proc of procedures) {
        const procName = (proc.name || '').toLowerCase();
        const procKeywords = procName.split(/[-_\s]+/).filter((w: string) => w.length > 3);
        const matchCount = procKeywords.filter((kw: string) => lessonText.includes(kw)).length;
        
        if (matchCount >= 1) {
          const created = await createCrossEdge(
            lesson.episode_id, proc.id, 'REFINED_BY_EXPERIENCE', 0.75, 0.8,
            `Lesson "${lesson.statement?.substring(0, 80)}" refined "${proc.name}"`,
            'episode', 'procedure'
          );
          if (created) result.refinedByExperience++;
        }
      }
    }

  } catch (e: any) {
    result.errors.push(`Top-level error: ${e.message}`);
  }

  result.duration_ms = Date.now() - start;
  return result;
}
