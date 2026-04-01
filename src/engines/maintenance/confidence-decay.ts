/**
 * Confidence Decay Engine
 * 
 * Phase 1.4: Facts decay in confidence over time unless verified.
 * 
 * Formula: effective_confidence = confidence * exp(-0.02 * staleness_days)
 * Half-life: ~35 days
 * 
 * Verification (from live conversations) resets last_verified, restoring confidence.
 */

import { query } from '../../storage/db.js';

const DECAY_RATE = 0.02; // ~35 day half-life
const MIN_CONFIDENCE = 0.1; // Floor — never decay below this

interface DecayResult {
  nodesProcessed: number;
  nodesDecayed: number;
  avgEffectiveConfidence: number;
  staleNodes: number; // confidence dropped below 0.3
  duration_ms: number;
}

/**
 * Calculate effective confidence for a node based on staleness.
 */
export function calculateEffectiveConfidence(
  baseConfidence: number,
  lastVerified: Date
): number {
  const daysSince = (Date.now() - lastVerified.getTime()) / (1000 * 60 * 60 * 24);
  const decayed = baseConfidence * Math.exp(-DECAY_RATE * daysSince);
  return Math.max(MIN_CONFIDENCE, decayed);
}

/**
 * Get effective confidence for a specific node.
 */
export async function getEffectiveConfidence(nodeId: string): Promise<number> {
  const node = await query(
    'SELECT confidence, last_verified FROM semantic_nodes WHERE id = $1',
    [nodeId]
  );
  
  if (!node.rows.length) return 0;
  
  return calculateEffectiveConfidence(
    node.rows[0].confidence,
    new Date(node.rows[0].last_verified)
  );
}

/**
 * Verify a node — reset its last_verified timestamp, restoring confidence.
 * Called when a fact is confirmed in a new conversation/episode.
 */
export async function verifyNode(nodeId: string, newConfidence?: number): Promise<void> {
  if (newConfidence !== undefined) {
    await query(
      'UPDATE semantic_nodes SET last_verified = NOW(), confidence = $1 WHERE id = $2',
      [newConfidence, nodeId]
    );
  } else {
    await query(
      'UPDATE semantic_nodes SET last_verified = NOW() WHERE id = $1',
      [nodeId]
    );
  }
}

/**
 * Run decay analysis across all nodes. Returns stats (doesn't modify data —
 * effective confidence is computed at query time, not stored).
 */
export async function analyzeDecay(): Promise<DecayResult> {
  const start = Date.now();
  const result: DecayResult = {
    nodesProcessed: 0,
    nodesDecayed: 0,
    avgEffectiveConfidence: 0,
    staleNodes: 0,
    duration_ms: 0,
  };

  const nodes = await query(
    'SELECT id, confidence, last_verified FROM semantic_nodes'
  );

  let totalEffective = 0;

  for (const node of nodes.rows) {
    result.nodesProcessed++;
    
    const effective = calculateEffectiveConfidence(
      node.confidence,
      new Date(node.last_verified)
    );

    totalEffective += effective;

    if (effective < node.confidence * 0.9) {
      result.nodesDecayed++; // Meaningfully decayed (>10% loss)
    }

    if (effective < 0.3) {
      result.staleNodes++;
    }
  }

  result.avgEffectiveConfidence = result.nodesProcessed > 0 
    ? totalEffective / result.nodesProcessed 
    : 0;
  result.duration_ms = Date.now() - start;

  return result;
}

/**
 * Get the stalest nodes — useful for identifying what needs re-verification.
 */
export async function getStalestNodes(limit: number = 10): Promise<Array<{
  id: string;
  name: string;
  type: string;
  baseConfidence: number;
  effectiveConfidence: number;
  daysSinceVerified: number;
}>> {
  const nodes = await query(
    `SELECT id, name, type, confidence, last_verified 
     FROM semantic_nodes 
     ORDER BY last_verified ASC 
     LIMIT $1`,
    [limit]
  );

  return nodes.rows.map((n: any) => {
    const daysSince = (Date.now() - new Date(n.last_verified).getTime()) / (1000 * 60 * 60 * 24);
    return {
      id: n.id,
      name: n.name,
      type: n.type,
      baseConfidence: n.confidence,
      effectiveConfidence: calculateEffectiveConfidence(n.confidence, new Date(n.last_verified)),
      daysSinceVerified: Math.round(daysSince),
    };
  });
}
