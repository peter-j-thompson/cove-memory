/**
 * The Sleep Cycle — Intelligent Consolidation Engine
 * 
 * This is what makes the brain ALIVE. Not just storing memories,
 * but learning from them. Like human sleep where the brain:
 * 1. Replays recent experiences (episode processing)
 * 2. Extracts patterns and lessons (insight extraction)
 * 3. Updates mental models of people (person model evolution)
 * 4. Strengthens important memories, weakens noise (importance reweighting)
 * 5. Discovers new connections between ideas (relationship inference)
 * 6. Refines procedures based on outcomes (procedural learning)
 * 
 * Uses LLM (Opus) for intelligent extraction — not keyword matching.
 * 
 * Three cycles:
 * - Session: After each conversation (lightweight, fast)
 * - Nightly: Deep processing of the day's episodes (heavy, thorough)
 * - Weekly: Full audit, dedup, re-inference (maintenance)
 */

import { query } from '../../storage/db.js';
import { embed } from '../../storage/embeddings/ollama.js';
import { deduplicateEntities } from '../maintenance/dedup.js';
import { enrichAllEpisodes, linkRelatedEpisodes, linkEpisodesToEntities } from '../episodic/enrich.js';
import { analyzeDecay } from '../maintenance/confidence-decay.js';
import { scanContradictions } from '../maintenance/contradictions.js';
import { updateEdgeWeights } from '../maintenance/edge-weights.js';
import { getAllPersonModels, type PersonModel } from '../../layers/relational/store.js';
import { getAllIdentity, affirmIdentity } from '../../layers/identity/store.js';
import { recordExecution } from '../../layers/procedural/store.js';
import { buildCrossLayerEdges } from './cross-layer-edges.js';

// ============================================================
// CONFIG
// ============================================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.LLM_CONSOLIDATION_MODEL || 'claude-opus-4-6';
// Use Opus for highest quality consolidation — this is the brain's most important work
// Budget guardrails don't apply to the brain (within reason)

// ============================================================
// TYPES
// ============================================================

export interface SleepCycleResult {
  cycle: 'session' | 'nightly' | 'weekly';
  started_at: string;
  duration_ms: number;
  episodes_processed: number;
  insights_extracted: number;
  lessons_learned: number;
  lessons_reinforced: number;
  person_model_updates: number;
  identity_affirmations: number;
  new_relationships: number;
  embeddings_generated: number;
  memories_consolidated: number;
  contradictions_found: number;
  health_score: number;
  details: Record<string, any>;
}

// ============================================================
// LLM CALLING (Anthropic)
// ============================================================

async function callLLM(prompt: string, timeoutMs: number = 60000): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    console.warn('[SLEEP] No ANTHROPIC_API_KEY — skipping LLM-powered consolidation');
    return '{}';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!res.ok) {
      const err = await res.text();
      console.error(`[SLEEP] Anthropic error: ${res.status} ${err}`);
      return '{}';
    }

    const data = await res.json() as any;
    return data.content?.[0]?.text || '{}';
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.warn('[SLEEP] LLM call timed out');
    } else {
      console.error('[SLEEP] LLM error:', err.message);
    }
    return '{}';
  }
}

function parseJSON(text: string): any {
  // Extract JSON from potential markdown code blocks
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) return {};
  try {
    return JSON.parse(jsonMatch[1].trim());
  } catch {
    try {
      return JSON.parse(text.trim());
    } catch {
      return {};
    }
  }
}

// ============================================================
// 1. INSIGHT EXTRACTION — Learn from episodes
// ============================================================

interface ExtractedInsight {
  type: 'lesson' | 'pattern' | 'preference' | 'decision' | 'emotional_moment';
  content: string;
  severity: 'critical' | 'important' | 'minor';
  related_entities: string[];
  confidence: number;
}

async function extractInsightsFromEpisodes(
  episodes: Array<{ id: string; summary: string; detailed_narrative: string; participants: string[]; emotional_arc: any }>
): Promise<ExtractedInsight[]> {
  if (episodes.length === 0) return [];

  const episodeText = episodes.map((ep, i) =>
    `Episode ${i + 1} (${ep.participants?.join(', ') || 'unknown'}):\n${ep.summary}\n${ep.detailed_narrative || ''}`
  ).join('\n\n---\n\n');

  const prompt = `You are analyzing memory episodes from an AI agent's brain to extract insights and lessons.

These episodes represent conversations, events, and interactions the agent experienced.

EPISODES:
${episodeText.substring(0, 6000)}

Extract ALL insights from these episodes. Look for:
1. **Lessons learned** — mistakes made, things that worked, patterns to remember
2. **Patterns** — recurring themes, behaviors, preferences revealed
3. **Preferences** — what the human likes/dislikes, communication style, work style
4. **Key decisions** — important choices made and their rationale
5. **Emotional moments** — significant emotional exchanges, trust-building, tension

Return ONLY valid JSON (no markdown, no explanation):
{
  "insights": [
    {
      "type": "lesson|pattern|preference|decision|emotional_moment",
      "content": "Clear, actionable description of the insight",
      "severity": "critical|important|minor",
      "related_entities": ["Person Name", "Project Name"],
      "confidence": 0.0-1.0
    }
  ]
}

Be specific and actionable. Skip obvious/trivial observations.`;

  const result = await callLLM(prompt);
  const parsed = parseJSON(result);
  return parsed.insights || [];
}

// ============================================================
// 2. PERSON MODEL EVOLUTION — Update understanding of people
// ============================================================

interface PersonModelUpdate {
  name: string;
  trust_delta: { ability?: number; benevolence?: number; integrity?: number };
  new_preferences: Record<string, string>;
  new_frustrations: string[];
  new_motivations: string[];
  communication_notes: string[];
  emotional_state: string;
}

async function evolvePersonModels(
  episodes: Array<{ summary: string; detailed_narrative: string; participants: string[]; emotional_arc: any }>,
  currentModels: PersonModel[]
): Promise<PersonModelUpdate[]> {
  if (episodes.length === 0 || currentModels.length === 0) return [];

  const modelSummaries = currentModels.map(m =>
    `${m.name} (${m.relationship_type}): Trust[ability=${(m.trust_from_them as any)?.ability ?? 0.5}, benevolence=${(m.trust_from_them as any)?.benevolence ?? 0.5}], ` +
    `Values: ${m.core_values?.join(', ') || 'unknown'}, Frustrations: ${m.known_frustrations?.join(', ') || 'unknown'}`
  ).join('\n');

  const episodeText = episodes.map((ep, i) =>
    `Episode ${i + 1}: ${ep.summary}\n${(ep.detailed_narrative || '').substring(0, 500)}`
  ).join('\n\n');

  const prompt = `You are updating person models for an AI agent's relational memory.

CURRENT PERSON MODELS:
${modelSummaries}

RECENT EPISODES:
${episodeText.substring(0, 5000)}

Based on the episodes, determine how each person's model should be updated.

Trust deltas should be small (-0.05 to +0.05 per cycle). Only include updates where you have evidence.

Return ONLY valid JSON:
{
  "updates": [
    {
      "name": "Person Name",
      "trust_delta": { "ability": 0.01, "benevolence": 0.02 },
      "new_preferences": { "key": "value" },
      "new_frustrations": [],
      "new_motivations": [],
      "communication_notes": ["Observed pattern"],
      "emotional_state": "current emotional state based on episodes"
    }
  ]
}

Only include people who appeared in the episodes. Skip people with no new information.`;

  const result = await callLLM(prompt);
  const parsed = parseJSON(result);
  return parsed.updates || [];
}

// ============================================================
// 3. LESSON REINFORCEMENT — Connect new experiences to known lessons
// ============================================================

async function reinforceLessons(
  insights: ExtractedInsight[],
  existingLessons: Array<{ id: string; statement: string; severity: string; times_reinforced: number }>
): Promise<{ reinforced: string[]; new_lessons: ExtractedInsight[] }> {
  const lessonInsights = insights.filter(i => i.type === 'lesson');
  if (lessonInsights.length === 0) return { reinforced: [], new_lessons: [] };

  const reinforced: string[] = [];
  const new_lessons: ExtractedInsight[] = [];

  for (const insight of lessonInsights) {
    const contentLower = insight.content.toLowerCase();
    
    // Match against existing lessons using embedding similarity + keyword overlap
    let matched = false;
    
    // Try embedding similarity first (more accurate)
    try {
      const insightVec = await embed(insight.content);
      const vec = (insightVec as any).embedding || insightVec;
      if (Array.isArray(vec)) {
        // Find lessons that are semantically similar
        // We don't have lesson embeddings in the table, so check via keyword + semantic
        for (const lesson of existingLessons) {
          const lessonVec = await embed(lesson.statement.substring(0, 300));
          const lv = (lessonVec as any).embedding || lessonVec;
          if (Array.isArray(lv)) {
            // Cosine similarity
            let dot = 0, magA = 0, magB = 0;
            for (let i = 0; i < Math.min(vec.length, lv.length); i++) {
              dot += vec[i] * lv[i];
              magA += vec[i] * vec[i];
              magB += lv[i] * lv[i];
            }
            const similarity = magA > 0 && magB > 0 ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
            
            if (similarity > 0.75) {
              await query(
                'UPDATE lessons SET times_reinforced = times_reinforced + 1, last_reinforced = NOW() WHERE id = $1',
                [lesson.id]
              );
              reinforced.push(lesson.id);
              matched = true;
              console.log(`[SLEEP] Lesson reinforced (similarity ${similarity.toFixed(3)}): ${lesson.statement.substring(0, 60)}...`);
              break;
            }
          }
        }
      }
    } catch { /* fall through to keyword matching */ }
    
    // Fallback: keyword overlap matching
    if (!matched) {
      for (const lesson of existingLessons) {
        const lessonLower = lesson.statement.toLowerCase();
        const insightWords = contentLower.split(/\s+/).filter(w => w.length > 4);
        const lessonWords = lessonLower.split(/\s+/).filter(w => w.length > 4);
        const overlap = insightWords.filter(w => lessonWords.some(lw => lw.includes(w) || w.includes(lw)));
        
        if (overlap.length >= 3 || (overlap.length >= 2 && insightWords.length <= 8)) {
          await query(
            'UPDATE lessons SET times_reinforced = times_reinforced + 1, last_reinforced = NOW() WHERE id = $1',
            [lesson.id]
          );
          reinforced.push(lesson.id);
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      new_lessons.push(insight);
    }
  }

  return { reinforced, new_lessons };
}

// ============================================================
// 4. RELATIONSHIP DISCOVERY — Find new connections
// ============================================================

async function discoverRelationships(
  insights: ExtractedInsight[]
): Promise<number> {
  let newRelationships = 0;
  
  for (const insight of insights) {
    if (insight.related_entities.length < 2) continue;

    // For each pair of related entities, check if edge exists
    for (let i = 0; i < insight.related_entities.length; i++) {
      for (let j = i + 1; j < insight.related_entities.length; j++) {
        const source = insight.related_entities[i];
        const target = insight.related_entities[j];

        // Find the nodes
        const sourceNode = await query(
          "SELECT id FROM semantic_nodes WHERE LOWER(name) = LOWER($1) OR LOWER($1) = ANY(SELECT LOWER(unnest(aliases)))",
          [source]
        );
        const targetNode = await query(
          "SELECT id FROM semantic_nodes WHERE LOWER(name) = LOWER($1) OR LOWER($1) = ANY(SELECT LOWER(unnest(aliases)))",
          [target]
        );

        if (sourceNode.rows.length === 0 || targetNode.rows.length === 0) continue;

        const sid = sourceNode.rows[0].id;
        const tid = targetNode.rows[0].id;

        // Check if edge exists
        const existing = await query(
          'SELECT id FROM semantic_edges WHERE (source_id = $1 AND target_id = $2) OR (source_id = $2 AND target_id = $1)',
          [sid, tid]
        );

        if (existing.rows.length === 0) {
          // Determine relationship type from insight
          const relType = insight.type === 'decision' ? 'influences' :
                         insight.type === 'pattern' ? 'relates_to' :
                         'works_with';

          await query(
            `INSERT INTO semantic_edges (source_id, target_id, relationship, category, strength, context)
             VALUES ($1, $2, $3, 'professional', 0.5, $4)`,
            [sid, tid, relType, insight.content.substring(0, 200)]
          );
          newRelationships++;
        }
      }
    }
  }

  return newRelationships;
}

// ============================================================
// 5. IDENTITY AFFIRMATION — Strengthen identity entries from experience
// ============================================================

async function affirmIdentityFromExperience(
  insights: ExtractedInsight[]
): Promise<number> {
  const allIdentity = await getAllIdentity();
  let affirmations = 0;

  for (const entry of allIdentity) {
    const keyWords = entry.key.replace(/-/g, ' ').toLowerCase().split(/\s+/);
    const valueWords = entry.value.toLowerCase().substring(0, 100).split(/\s+/).filter((w: string) => w.length > 4);

    for (const insight of insights) {
      const contentLower = insight.content.toLowerCase();
      const keyMatch = keyWords.some((w: string) => w.length > 3 && contentLower.includes(w));
      const valueMatch = valueWords.some((w: string) => contentLower.includes(w));

      if (keyMatch || valueMatch) {
        await affirmIdentity(entry.key);
        affirmations++;
        break;
      }
    }
  }

  return affirmations;
}

// ============================================================
// 6. EMBEDDING GENERATION — Fill gaps
// ============================================================

async function generateMissingEmbeddings(): Promise<number> {
  let generated = 0;

  // Episodes
  const unembeddedEps = await query('SELECT id, summary, detailed_narrative FROM episodes WHERE embedding IS NULL LIMIT 50');
  for (const ep of unembeddedEps.rows) {
    try {
      const text = `${ep.summary} ${(ep.detailed_narrative || '').substring(0, 600)}`.substring(0, 800);
      const result = await embed(text);
      const vec = (result as any).embedding || result;
      if (Array.isArray(vec)) {
        await query('UPDATE episodes SET embedding = $1 WHERE id = $2', [`[${vec.join(',')}]`, ep.id]);
        generated++;
      }
    } catch { /* skip */ }
  }

  // Nodes
  const unembeddedNodes = await query('SELECT id, name, type, attributes FROM semantic_nodes WHERE embedding IS NULL LIMIT 50');
  for (const node of unembeddedNodes.rows) {
    try {
      const context = (node.attributes as any)?.context || '';
      const text = `${node.type}: ${node.name}. ${context}`.substring(0, 500);
      const result = await embed(text);
      const vec = (result as any).embedding || result;
      if (Array.isArray(vec)) {
        await query('UPDATE semantic_nodes SET embedding = $1 WHERE id = $2', [`[${vec.join(',')}]`, node.id]);
        generated++;
      }
    } catch { /* skip */ }
  }

  return generated;
}

// ============================================================
// APPLY PERSON MODEL UPDATES
// ============================================================

async function applyPersonModelUpdates(updates: PersonModelUpdate[]): Promise<number> {
  let applied = 0;

  for (const update of updates) {
    const model = await query('SELECT * FROM person_models WHERE LOWER(name) = LOWER($1)', [update.name]);
    if (model.rows.length === 0) continue;

    const current = model.rows[0];
    const trustFromThem = typeof current.trust_from_them === 'string' 
      ? JSON.parse(current.trust_from_them) 
      : (current.trust_from_them || {});

    // Apply trust deltas with clamping [0, 1]
    if (update.trust_delta.ability) {
      trustFromThem.ability = Math.max(0, Math.min(1, (trustFromThem.ability || 0.5) + update.trust_delta.ability));
    }
    if (update.trust_delta.benevolence) {
      trustFromThem.benevolence = Math.max(0, Math.min(1, (trustFromThem.benevolence || 0.5) + update.trust_delta.benevolence));
    }
    if (update.trust_delta.integrity) {
      trustFromThem.integrity = Math.max(0, Math.min(1, (trustFromThem.integrity || 0.5) + update.trust_delta.integrity));
    }
    trustFromThem.composite = (
      (trustFromThem.ability || 0.5) * 0.3 +
      (trustFromThem.benevolence || 0.5) * 0.4 +
      (trustFromThem.integrity || 0.5) * 0.3
    );

    // Merge preferences
    const prefs = typeof current.known_preferences === 'string'
      ? JSON.parse(current.known_preferences)
      : (current.known_preferences || {});
    Object.assign(prefs, update.new_preferences || {});

    // Append frustrations and motivations (deduplicated)
    const frustrations: string[] = current.known_frustrations || [];
    for (const f of update.new_frustrations || []) {
      if (!frustrations.some(existing => existing.toLowerCase() === f.toLowerCase())) {
        frustrations.push(f);
      }
    }

    const motivations: string[] = current.known_motivations || [];
    for (const m of update.new_motivations || []) {
      if (!motivations.some(existing => existing.toLowerCase() === m.toLowerCase())) {
        motivations.push(m);
      }
    }

    await query(`
      UPDATE person_models SET
        trust_from_them = $1,
        known_preferences = $2,
        known_frustrations = $3,
        known_motivations = $4,
        total_interactions = total_interactions + 1,
        last_interaction = NOW()
      WHERE LOWER(name) = LOWER($5)
    `, [
      JSON.stringify(trustFromThem),
      JSON.stringify(prefs),
      frustrations,
      motivations,
      update.name,
    ]);

    applied++;
    console.log(`[SLEEP] Updated person model: ${update.name} (trust composite: ${trustFromThem.composite.toFixed(3)})`);
  }

  return applied;
}

// ============================================================
// STORE NEW LESSONS
// ============================================================

async function storeNewLessons(lessons: ExtractedInsight[]): Promise<number> {
  let stored = 0;

  for (const lesson of lessons) {
    try {
      await query(
        `INSERT INTO lessons (statement, severity, prevention_rule, times_reinforced, last_reinforced)
         VALUES ($1, $2, $3, 1, NOW())`,
        [lesson.content, lesson.severity, lesson.content.substring(0, 200)]
      );
      stored++;
      console.log(`[SLEEP] New lesson: ${lesson.content.substring(0, 80)}...`);
    } catch (err: any) {
      // Skip duplicates
      if (!err.message?.includes('duplicate')) {
        console.warn(`[SLEEP] Failed to store lesson: ${err.message}`);
      }
    }
  }

  return stored;
}

// ============================================================
// 7. PROCEDURAL EXECUTION TRACKING — Detect when procedures were executed
// ============================================================

async function trackProcedureExecutions(
  episodes: Array<{ id: string; summary: string; detailed_narrative: string }>
): Promise<number> {
  const procedures = await query('SELECT id, name, trigger_conditions, steps FROM procedures');
  let tracked = 0;

  for (const proc of procedures.rows) {
    const triggers: string[] = (proc.trigger_conditions as any)?.phrases || [];
    if (triggers.length === 0) continue;

    for (const ep of episodes) {
      const text = `${ep.summary} ${ep.detailed_narrative || ''}`.toLowerCase();
      const triggered = triggers.some(t => text.includes(t.toLowerCase()));
      
      if (triggered) {
        // Check if steps were completed (at least 2 of them mentioned)
        const steps: string[] = proc.steps || [];
        const stepWords = steps.map(s => s.toLowerCase().split(/\s+/).filter((w: string) => w.length > 4).slice(0, 3));
        let stepsMatched = 0;
        for (const words of stepWords) {
          if (words.some(w => text.includes(w))) stepsMatched++;
        }

        if (stepsMatched >= Math.min(2, steps.length)) {
          // This episode contains evidence of the procedure being executed
          const success = !text.includes('failed') && !text.includes('error') && !text.includes('broken');
          
          await query(`
            UPDATE procedures SET
              execution_count = execution_count + 1,
              success_count = success_count + CASE WHEN $1 THEN 1 ELSE 0 END,
              success_rate = CASE WHEN execution_count + 1 > 0
                THEN (success_count + CASE WHEN $1 THEN 1 ELSE 0 END)::float / (execution_count + 1)
                ELSE 0 END,
              last_executed = NOW(),
              last_outcome = $2
            WHERE id = $3
          `, [success, success ? 'success' : 'failure', proc.id]);
          
          tracked++;
          console.log(`[SLEEP] Procedure executed: ${proc.name} (${success ? 'success' : 'failure'}) — from episode: ${ep.summary.substring(0, 50)}...`);
          break; // One execution per episode
        }
      }
    }
  }

  return tracked;
}

// ============================================================
// MAIN SLEEP CYCLES
// ============================================================

/**
 * Session-end cycle — lightweight, runs after each conversation
 * Focus: embeddings, enrichment, basic lesson matching
 */
export async function sessionSleep(): Promise<SleepCycleResult> {
  const start = Date.now();
  const startTime = new Date().toISOString();
  const details: Record<string, any> = {};
  console.log('[SLEEP] 💤 Session sleep cycle starting...');

  // 1. Generate missing embeddings
  const embeddings = await generateMissingEmbeddings();
  details.embeddings = embeddings;

  // 2. Enrich un-enriched episodes
  try {
    const enrichResult = await enrichAllEpisodes();
    details.enrichment = enrichResult;
  } catch (err: any) {
    details.enrichment = { error: err.message };
  }

  // 3. Reweight edges
  try {
    await updateEdgeWeights();
    details.edgeReweight = 'done';
  } catch (err: any) {
    details.edgeReweight = { error: err.message };
  }

  const result: SleepCycleResult = {
    cycle: 'session',
    started_at: startTime,
    duration_ms: Date.now() - start,
    episodes_processed: 0,
    insights_extracted: 0,
    lessons_learned: 0,
    lessons_reinforced: 0,
    person_model_updates: 0,
    identity_affirmations: 0,
    new_relationships: 0,
    embeddings_generated: embeddings,
    memories_consolidated: 0,
    contradictions_found: 0,
    health_score: 0,
    details,
  };

  await logSleepCycle(result);
  console.log(`[SLEEP] ✅ Session sleep complete (${result.duration_ms}ms, ${embeddings} embeddings)`);
  return result;
}

/**
 * Nightly sleep cycle — the DEEP consolidation
 * This is where the brain actually learns.
 */
export async function nightlySleep(): Promise<SleepCycleResult> {
  const start = Date.now();
  const startTime = new Date().toISOString();
  const details: Record<string, any> = {};
  console.log('[SLEEP] 🌙 Nightly sleep cycle starting...');

  // 1. Session-level stuff first (embeddings, enrichment)
  const sessionResult = await sessionSleep();
  details.session = sessionResult;

  // 2. Fetch recent episodes (last 24 hours)
  const recentEpisodes = await query(`
    SELECT id, summary, detailed_narrative, participants, emotional_arc
    FROM episodes
    WHERE created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC
    LIMIT 30
  `);
  details.recentEpisodeCount = recentEpisodes.rows.length;
  console.log(`[SLEEP] Processing ${recentEpisodes.rows.length} recent episodes...`);

  // 3. LLM-powered insight extraction
  let insights: ExtractedInsight[] = [];
  if (recentEpisodes.rows.length > 0) {
    insights = await extractInsightsFromEpisodes(recentEpisodes.rows);
    details.insightsExtracted = insights.length;
    details.insightsByType = insights.reduce((acc, i) => {
      acc[i.type] = (acc[i.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log(`[SLEEP] Extracted ${insights.length} insights: ${JSON.stringify(details.insightsByType)}`);
  }

  // 4. LLM-powered person model evolution
  let personModelUpdates = 0;
  if (recentEpisodes.rows.length > 0) {
    const currentModels = await getAllPersonModels();
    const updates = await evolvePersonModels(recentEpisodes.rows, currentModels);
    personModelUpdates = await applyPersonModelUpdates(updates);
    details.personModelUpdates = updates.map(u => ({ name: u.name, trustDelta: u.trust_delta }));
    console.log(`[SLEEP] Updated ${personModelUpdates} person models`);
  }

  // 5. Lesson reinforcement + new lesson creation
  const existingLessons = (await query('SELECT id, statement, severity, times_reinforced FROM lessons')).rows;
  const { reinforced, new_lessons } = await reinforceLessons(insights, existingLessons);
  const newLessonCount = await storeNewLessons(new_lessons);
  details.lessonsReinforced = reinforced.length;
  details.newLessons = newLessonCount;
  console.log(`[SLEEP] Lessons: ${reinforced.length} reinforced, ${newLessonCount} new`);

  // 6. Identity affirmation from experience
  const identityAffirmations = await affirmIdentityFromExperience(insights);
  details.identityAffirmations = identityAffirmations;

  // 7. Relationship discovery
  const newRelationships = await discoverRelationships(insights);
  details.newRelationships = newRelationships;
  console.log(`[SLEEP] Discovered ${newRelationships} new relationships`);

  // 7b. Procedural execution tracking
  let procedureExecutions = 0;
  if (recentEpisodes.rows.length > 0) {
    procedureExecutions = await trackProcedureExecutions(recentEpisodes.rows);
    details.procedureExecutions = procedureExecutions;
    if (procedureExecutions > 0) {
      console.log(`[SLEEP] Tracked ${procedureExecutions} procedure executions`);
    }
  }

  // 7c. Cross-layer edge building
  try {
    const crossLayerResult = await buildCrossLayerEdges();
    details.crossLayerEdges = {
      appliesInContext: crossLayerResult.appliesInContext,
      learnedFrom: crossLayerResult.learnedFrom,
      shapedByIdentity: crossLayerResult.shapedByIdentity,
      composedOf: crossLayerResult.composedOf,
      refinedByExperience: crossLayerResult.refinedByExperience,
      duration_ms: crossLayerResult.duration_ms,
      errors: crossLayerResult.errors.length,
    };
    const totalNew = crossLayerResult.appliesInContext + crossLayerResult.learnedFrom + 
      crossLayerResult.shapedByIdentity + crossLayerResult.composedOf + crossLayerResult.refinedByExperience;
    if (totalNew > 0) {
      console.log(`[SLEEP] 🔗 Cross-layer edges: ${totalNew} new (${crossLayerResult.duration_ms}ms)`);
    }
  } catch (err: any) {
    details.crossLayerEdges = { error: err.message };
    console.log(`[SLEEP] ⚠️ Cross-layer edges error: ${err.message}`);
  }

  // 8. Detect procedure executions from episodes
  let proceduresTracked = 0;
  try {
    const allProcs = (await query('SELECT name, trigger_conditions FROM procedures')).rows;
    for (const ep of recentEpisodes.rows) {
      const text = `${ep.summary} ${ep.detailed_narrative || ''}`.toLowerCase();
      for (const proc of allProcs) {
        const triggers = proc.trigger_conditions as any;
        const phrases: string[] = triggers?.phrases || [];
        if (phrases.some(p => text.includes(p.toLowerCase()))) {
          // Detect success/failure from episode text
          const success = !text.includes('fail') && !text.includes('error') && !text.includes('broke') && !text.includes('broken');
          await recordExecution(proc.name, success, ep.summary.substring(0, 200));
          proceduresTracked++;
        }
      }
    }
    details.proceduresTracked = proceduresTracked;
    if (proceduresTracked > 0) console.log(`[SLEEP] Tracked ${proceduresTracked} procedure executions`);
  } catch (err: any) {
    details.proceduresTracked = { error: err.message };
  }

  // 9. Link related episodes
  try {
    const links = await linkRelatedEpisodes();
    details.episodeLinks = links;
  } catch (err: any) {
    details.episodeLinks = { error: err.message };
  }

  // 9. Confidence decay
  try {
    const decay = await analyzeDecay();
    details.decay = decay;
  } catch (err: any) {
    details.decay = { error: err.message };
  }

  // 10. Contradiction detection
  let contradictions = 0;
  try {
    const scan = await scanContradictions();
    contradictions = scan.contradictionsFound;
    details.contradictions = scan;
  } catch (err: any) {
    details.contradictions = { error: err.message };
  }

  // 11. Consolidate old low-importance episodes
  let consolidated = 0;
  const staleEps = await query(`
    SELECT id, summary FROM episodes
    WHERE decay_protected = false
      AND importance_score < 0.25
      AND created_at < NOW() - INTERVAL '30 days'
      AND access_count = 0
  `);
  if (staleEps.rows.length > 5) {
    const summaries = staleEps.rows.map((r: any) => r.summary).join('; ');
    await query(`
      INSERT INTO episodes (session_id, summary, detailed_narrative, importance_score, decay_protected)
      VALUES ('consolidation', $1, $2, 0.3, false)
    `, [
      `Consolidated ${staleEps.rows.length} low-importance memories`,
      summaries.substring(0, 2000),
    ]);
    consolidated = staleEps.rows.length;
    details.consolidated = consolidated;
  }

  const result: SleepCycleResult = {
    cycle: 'nightly',
    started_at: startTime,
    duration_ms: Date.now() - start,
    episodes_processed: recentEpisodes.rows.length,
    insights_extracted: insights.length,
    lessons_learned: newLessonCount,
    lessons_reinforced: reinforced.length,
    person_model_updates: personModelUpdates,
    identity_affirmations: identityAffirmations,
    new_relationships: newRelationships,
    embeddings_generated: sessionResult.embeddings_generated,
    memories_consolidated: consolidated,
    contradictions_found: contradictions,
    health_score: 0, // Calculated below
    details,
  };

  await logSleepCycle(result);
  console.log(`[SLEEP] 🌙✅ Nightly sleep complete (${result.duration_ms}ms)`);
  console.log(`[SLEEP]   Insights: ${insights.length}, Lessons: +${newLessonCount} (${reinforced.length} reinforced)`);
  console.log(`[SLEEP]   Person models: ${personModelUpdates} updated, Identity: ${identityAffirmations} affirmed`);
  console.log(`[SLEEP]   Relationships: +${newRelationships}, Contradictions: ${contradictions}`);
  return result;
}

/**
 * Weekly sleep cycle — full maintenance
 */
export async function weeklySleep(): Promise<SleepCycleResult> {
  const start = Date.now();
  const startTime = new Date().toISOString();
  const details: Record<string, any> = {};
  console.log('[SLEEP] 🔧 Weekly sleep cycle starting...');

  // 1. Run nightly cycle first
  const nightlyResult = await nightlySleep();
  details.nightly = nightlyResult;

  // 2. Full dedup pass
  try {
    const dedup = await deduplicateEntities();
    details.dedup = dedup;
    console.log(`[SLEEP] Dedup: ${JSON.stringify(dedup)}`);
  } catch (err: any) {
    details.dedup = { error: err.message };
  }

  // 3. Full edge reweight
  try {
    await updateEdgeWeights();
    details.edgeReweight = 'done';
  } catch (err: any) {
    details.edgeReweight = { error: err.message };
  }

  const result: SleepCycleResult = {
    ...nightlyResult,
    cycle: 'weekly',
    started_at: startTime,
    duration_ms: Date.now() - start,
    details,
  };

  await logSleepCycle(result);
  console.log(`[SLEEP] 🔧✅ Weekly sleep complete (${result.duration_ms}ms)`);
  return result;
}

// ============================================================
// BACKFILL — Historical episode insight extraction
// ============================================================

/**
 * Process historical episodes that haven't been through LLM insight extraction.
 * Runs in batches to avoid burning through API quota.
 */
export async function backfillEpisodeInsights(batchSize: number = 20): Promise<{
  episodes_processed: number;
  insights_extracted: number;
  lessons_learned: number;
  lessons_reinforced: number;
  person_model_updates: number;
  new_relationships: number;
  duration_ms: number;
}> {
  const start = Date.now();
  console.log(`[BACKFILL] Processing up to ${batchSize} historical episodes...`);

  // Get episodes not yet processed by the sleep cycle (older than 24h, with narratives)
  const episodes = await query(`
    SELECT id, summary, detailed_narrative, participants, emotional_arc, created_at
    FROM episodes
    WHERE detailed_narrative IS NOT NULL 
      AND LENGTH(detailed_narrative) > 100
      AND created_at < NOW() - INTERVAL '24 hours'
    ORDER BY importance_score DESC, created_at DESC
    LIMIT $1
  `, [batchSize]);

  if (episodes.rows.length === 0) {
    console.log('[BACKFILL] No unprocessed episodes found');
    return { episodes_processed: 0, insights_extracted: 0, lessons_learned: 0, lessons_reinforced: 0, person_model_updates: 0, new_relationships: 0, duration_ms: Date.now() - start };
  }

  console.log(`[BACKFILL] Found ${episodes.rows.length} episodes to process`);

  // Extract insights
  const insights = await extractInsightsFromEpisodes(episodes.rows);
  console.log(`[BACKFILL] Extracted ${insights.length} insights`);

  // Reinforce/create lessons
  const existingLessons = (await query('SELECT id, statement, severity, times_reinforced FROM lessons')).rows;
  const { reinforced, new_lessons } = await reinforceLessons(insights, existingLessons);
  const newLessonCount = await storeNewLessons(new_lessons);

  // Evolve person models
  const currentModels = await getAllPersonModels();
  const updates = await evolvePersonModels(episodes.rows, currentModels);
  const personUpdates = await applyPersonModelUpdates(updates);

  // Discover relationships
  const newRelationships = await discoverRelationships(insights);

  // Affirm identity
  await affirmIdentityFromExperience(insights);

  const result = {
    episodes_processed: episodes.rows.length,
    insights_extracted: insights.length,
    lessons_learned: newLessonCount,
    lessons_reinforced: reinforced.length,
    person_model_updates: personUpdates,
    new_relationships: newRelationships,
    duration_ms: Date.now() - start,
  };

  console.log(`[BACKFILL] ✅ Complete: ${insights.length} insights, +${newLessonCount} lessons, ${reinforced.length} reinforced, ${personUpdates} person updates, +${newRelationships} relationships (${result.duration_ms}ms)`);
  return result;
}

// ============================================================
// LOGGING
// ============================================================

async function logSleepCycle(result: SleepCycleResult): Promise<void> {
  try {
    await query(`
      INSERT INTO consolidation_log (
        mode, episodes_processed, facts_extracted, facts_updated,
        lessons_identified, procedures_refined, memories_pruned,
        contradictions_found, identity_updates, details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      result.cycle,
      result.episodes_processed,
      result.insights_extracted,
      result.person_model_updates,
      result.lessons_learned,
      0, // procedures_refined (future)
      result.memories_consolidated,
      result.contradictions_found,
      result.identity_affirmations,
      JSON.stringify(result.details),
    ]);
  } catch (err: any) {
    console.warn(`[SLEEP] Failed to log cycle: ${err.message}`);
  }
}
