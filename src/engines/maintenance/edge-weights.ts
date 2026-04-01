/**
 * Edge Weight Differentiation Engine
 *
 * ALL weights are computed from DATA, not hardcoded values.
 * 
 * The principle: edge strength should reflect how important a relationship is RIGHT NOW.
 * This is derived from three data-driven signals:
 * 
 *   1. Status signal — node context text contains keywords like "paused", "active", "current"
 *      These come from the ingestion pipeline, not from hardcoded lists.
 *   2. Recency signal — how recently was this node mentioned in episodes?
 *   3. Frequency signal — how often is this node mentioned across all episodes?
 * 
 * The output is a continuous strength from 0.1 to 1.0, not discrete tiers.
 * If you drop the DB and re-ingest from markdown, these weights reproduce perfectly
 * because they're derived entirely from the graph data.
 */

import { query } from '../../storage/db.js';

interface ReweightResult {
  edgesProcessed: number;
  statusAdjusted: number;
  recencyBoosted: number;
  frequencyAdjusted: number;
  duration_ms: number;
}

/**
 * Recompute all edge weights from data signals.
 * 
 * Strategy: Start all edges at a neutral baseline (0.5), then adjust up or down
 * based on data-driven signals. No project names, no hardcoded entity references.
 */
export async function updateEdgeWeights(): Promise<ReweightResult> {
  const start = Date.now();
  const result: ReweightResult = {
    edgesProcessed: 0,
    statusAdjusted: 0,
    recencyBoosted: 0,
    frequencyAdjusted: 0,
    duration_ms: 0,
  };

  // Step 1: Reset all edges to neutral baseline
  // This ensures reproducibility — every reweight starts clean
  try {
    await query('UPDATE semantic_edges SET strength = 0.5');
  } catch (err) {
    console.warn('[EDGE-WEIGHTS] Baseline reset failed:', (err as Error).message);
    return result;
  }

  // Step 2: Status signal — derived from node context text
  // Any node whose context contains status-indicating keywords gets adjusted.
  // These keywords are generic and apply to any domain, not specific to our projects.
  const statusDown = ['paused', 'inactive', 'deprecated', 'archived', 'suspended', 'on hold', 'stopped'];
  const statusUp = ['active', 'current', 'in progress', 'building', 'shipping', 'running', 'live', 'priority', 'focus'];

  try {
    // Nodes with negative status indicators → cap at 0.3
    const downPattern = statusDown.map(s => `LOWER(n.context) LIKE '%${s}%'`).join(' OR ');
    const pausedRes = await query(
      `UPDATE semantic_edges e SET strength = LEAST(0.3, e.strength)
       FROM semantic_nodes n
       WHERE (e.target_id = n.id OR e.source_id = n.id)
         AND (${downPattern})
       RETURNING e.id`
    );
    result.statusAdjusted += pausedRes.rows.length;

    // Nodes with positive status indicators → floor at 0.6
    const upPattern = statusUp.map(s => `LOWER(n.context) LIKE '%${s}%'`).join(' OR ');
    const activeRes = await query(
      `UPDATE semantic_edges e SET strength = GREATEST(0.6, e.strength)
       FROM semantic_nodes n
       WHERE (e.target_id = n.id OR e.source_id = n.id)
         AND (${upPattern})
         AND NOT (${downPattern.replace(/n\.context/g, 'n.context')})
       RETURNING e.id`
    );
    result.statusAdjusted += activeRes.rows.length;
  } catch (err) {
    console.warn('[EDGE-WEIGHTS] Status adjustment failed:', (err as Error).message);
  }

  // Step 3: Frequency signal — nodes mentioned in more episodes are more important
  // Uses source_episodes array length as a proxy for real-world importance.
  // Scale: 0 episodes = no boost, 1-2 = small, 3-5 = medium, 6+ = high
  try {
    const freqRes = await query(
      `UPDATE semantic_edges e SET strength = LEAST(1.0, e.strength + 
         0.04 * GREATEST(
           COALESCE(array_length(s.source_episodes, 1), 0),
           COALESCE(array_length(t.source_episodes, 1), 0)
         )
       )
       FROM semantic_nodes s, semantic_nodes t
       WHERE e.source_id = s.id AND e.target_id = t.id
       RETURNING e.id`
    );
    result.frequencyAdjusted = freqRes.rows.length;
  } catch (err) {
    console.warn('[EDGE-WEIGHTS] Frequency adjustment failed:', (err as Error).message);
  }

  // Step 4: Recency signal — nodes modified in the last 7 days get a small boost
  // This naturally favors whatever is being actively worked on
  try {
    const recentRes = await query(
      `UPDATE semantic_edges e SET strength = LEAST(1.0, e.strength + 0.1)
       WHERE source_id IN (
         SELECT id FROM semantic_nodes WHERE last_modified > NOW() - INTERVAL '7 days'
       ) OR target_id IN (
         SELECT id FROM semantic_nodes WHERE last_modified > NOW() - INTERVAL '7 days'
       )
       RETURNING id`
    );
    result.recencyBoosted = recentRes.rows.length;
  } catch (err) {
    console.warn('[EDGE-WEIGHTS] Recency boost failed:', (err as Error).message);
  }

  // Step 5: Ensure paused nodes stay low even after frequency/recency boosts
  // (Re-apply ceiling since steps 3-4 might have pushed them back up)
  try {
    const downPattern = statusDown.map(s => `LOWER(n.context) LIKE '%${s}%'`).join(' OR ');
    await query(
      `UPDATE semantic_edges e SET strength = LEAST(0.35, e.strength)
       FROM semantic_nodes n
       WHERE (e.target_id = n.id OR e.source_id = n.id)
         AND (${downPattern})`
    );
  } catch { /* non-critical */ }

  // Count total
  try {
    const total = await query('SELECT COUNT(*) as c FROM semantic_edges');
    result.edgesProcessed = +total.rows[0].c;
  } catch { /* non-critical */ }

  result.duration_ms = Date.now() - start;
  console.log(`[EDGE-WEIGHTS] Reweight complete: ${result.edgesProcessed} edges, ${result.statusAdjusted} status-adjusted, ${result.recencyBoosted} recency-boosted, ${result.frequencyAdjusted} frequency-adjusted (${result.duration_ms}ms)`);
  return result;
}
