/**
 * Contradiction Detection Engine
 * 
 * Phase 1.3: Detect when new facts conflict with existing knowledge.
 * 
 * Strategy:
 * - When upserting attributes, compare new values to existing ones
 * - If conflict detected, store in contradictions JSONB array
 * - Resolution strategies: prefer higher confidence, prefer more recent, flag for human review
 */

import { query } from '../../storage/db.js';

interface Contradiction {
  field: string;
  old_value: unknown;
  new_value: unknown;
  old_source: string;
  new_source: string;
  detected_at: string;
  resolved: boolean;
  resolution?: 'accepted_new' | 'kept_old' | 'flagged_human';
}

interface ContradictionScanResult {
  nodesScanned: number;
  contradictionsFound: number;
  contradictionsResolved: number;
  details: Array<{ nodeName: string; field: string; old: string; new: string }>;
  duration_ms: number;
}

/**
 * Check for contradictions when updating a node's attributes.
 * Returns any contradictions found.
 */
export async function checkContradictions(
  nodeId: string,
  newAttributes: Record<string, unknown>,
  source: string = 'ingestion'
): Promise<Contradiction[]> {
  const existing = await query(
    'SELECT name, attributes, contradictions FROM semantic_nodes WHERE id = $1',
    [nodeId]
  );

  if (!existing.rows.length) return [];

  const node = existing.rows[0];
  const oldAttrs = node.attributes || {};
  const contradictions: Contradiction[] = [];

  for (const [key, newVal] of Object.entries(newAttributes)) {
    const oldVal = oldAttrs[key];
    
    // No old value = no contradiction, just new info
    if (oldVal === undefined || oldVal === null) continue;
    
    // Same value = no contradiction
    if (JSON.stringify(oldVal) === JSON.stringify(newVal)) continue;
    
    // Different value = potential contradiction
    contradictions.push({
      field: key,
      old_value: oldVal,
      new_value: newVal,
      old_source: 'existing',
      new_source: source,
      detected_at: new Date().toISOString(),
      resolved: false,
    });
  }

  if (contradictions.length > 0) {
    // Append to node's contradictions array
    const existingContradictions = node.contradictions || [];
    const allContradictions = [...existingContradictions, ...contradictions];
    
    await query(
      'UPDATE semantic_nodes SET contradictions = $1 WHERE id = $2',
      [JSON.stringify(allContradictions), nodeId]
    );

    console.log(`[CONTRADICTION] Found ${contradictions.length} contradiction(s) for "${node.name}": ${contradictions.map(c => c.field).join(', ')}`);
  }

  return contradictions;
}

/**
 * Resolve a contradiction on a node.
 */
export async function resolveContradiction(
  nodeId: string,
  field: string,
  resolution: 'accepted_new' | 'kept_old' | 'flagged_human',
  newValue?: unknown
): Promise<void> {
  const node = await query(
    'SELECT contradictions, attributes FROM semantic_nodes WHERE id = $1',
    [nodeId]
  );

  if (!node.rows.length) return;

  const contradictions: Contradiction[] = node.rows[0].contradictions || [];
  const attrs = node.rows[0].attributes || {};

  for (const c of contradictions) {
    if (c.field === field && !c.resolved) {
      c.resolved = true;
      c.resolution = resolution;

      if (resolution === 'accepted_new' && newValue !== undefined) {
        attrs[field] = newValue;
      }
    }
  }

  await query(
    'UPDATE semantic_nodes SET contradictions = $1, attributes = $2 WHERE id = $3',
    [JSON.stringify(contradictions), JSON.stringify(attrs), nodeId]
  );
}

/**
 * Scan all nodes for unresolved contradictions.
 */
export async function scanContradictions(): Promise<ContradictionScanResult> {
  const start = Date.now();
  const result: ContradictionScanResult = {
    nodesScanned: 0,
    contradictionsFound: 0,
    contradictionsResolved: 0,
    details: [],
    duration_ms: 0,
  };

  const nodes = await query(
    "SELECT id, name, contradictions FROM semantic_nodes WHERE contradictions IS NOT NULL AND contradictions != '[]'::jsonb"
  );

  result.nodesScanned = nodes.rows.length;

  for (const node of nodes.rows) {
    const contradictions: Contradiction[] = node.contradictions || [];
    for (const c of contradictions) {
      if (c.resolved) {
        result.contradictionsResolved++;
      } else {
        result.contradictionsFound++;
        result.details.push({
          nodeName: node.name,
          field: c.field,
          old: String(c.old_value),
          new: String(c.new_value),
        });
      }
    }
  }

  result.duration_ms = Date.now() - start;
  return result;
}
