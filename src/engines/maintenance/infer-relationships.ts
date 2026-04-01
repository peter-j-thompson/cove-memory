/**
 * Automatic Relationship Inference Engine
 * 
 * Phase 1.2: Infer relationships from co-occurrence in markdown sections.
 * 
 * Strategy:
 * - If two entities appear in the same markdown section 3+ times, infer a relationship
 * - Relationship type heuristics based on entity types
 * - Dedup: don't create edges that already exist
 * 
 * GUARDRAILS (added 2026-03-19 — brain tumor surgery):
 * - Max 2,000 inferred edges per run (was unlimited → caused 211K edge explosion)
 * - Min co-occurrence threshold: 3 (was 2 → too many false positives)
 * - Max 20 inferred edges per node (prevents hub nodes from creating combinatorial explosions)
 * - Skip concept↔concept and tool↔tool pairs (the bulk of the spam)
 */

import { readAllFiles, parseIntoSections } from '../../integrations/markdown-reader.js';
import { query } from '../../storage/db.js';
import type { RelationshipType, RelationshipCategory } from '../../types.js';

interface InferResult {
  sectionsScanned: number;
  coOccurrences: number;
  edgesCreated: number;
  edgesSkippedDuplicate: number;
  edgesBefore: number;
  edgesAfter: number;
  errors: string[];
  duration_ms: number;
}

/**
 * Infer relationship type based on entity type pair.
 */
function inferRelationshipType(
  sourceType: string,
  targetType: string
): { relationship: RelationshipType; category: RelationshipCategory } {
  const pair = `${sourceType}:${targetType}`;
  
  switch (pair) {
    case 'person:organization':
      return { relationship: 'works_for', category: 'relational' };
    case 'organization:person':
      return { relationship: 'works_for', category: 'relational' };
    case 'person:person':
      return { relationship: 'works_with', category: 'relational' };
    case 'person:project':
      return { relationship: 'works_with', category: 'relational' };
    case 'project:person':
      return { relationship: 'works_with', category: 'relational' };
    case 'project:tool':
      return { relationship: 'depends_on', category: 'functional' };
    case 'tool:project':
      return { relationship: 'depends_on', category: 'functional' };
    case 'project:organization':
      return { relationship: 'part_of', category: 'structural' };
    case 'organization:project':
      return { relationship: 'part_of', category: 'structural' };
    case 'concept:project':
      return { relationship: 'influences', category: 'causal' };
    case 'project:concept':
      return { relationship: 'influences', category: 'causal' };
    case 'concept:organization':
      return { relationship: 'influences', category: 'causal' };
    case 'person:place':
      return { relationship: 'located_in', category: 'structural' };
    case 'person:concept':
      return { relationship: 'values', category: 'emotional' };
    case 'tool:tool':
      return { relationship: 'works_with', category: 'functional' };
    default:
      return { relationship: 'works_with', category: 'relational' };
  }
}

/**
 * Run relationship inference from co-occurrence analysis.
 */
const MAX_INFERRED_EDGES_PER_RUN = 2000;
const MAX_INFERRED_EDGES_PER_NODE = 20;
const SKIP_TYPE_PAIRS = new Set(['concept:concept', 'tool:tool']); // These create combinatorial explosions

export async function inferRelationships(minCoOccurrences: number = 3): Promise<InferResult> {
  const start = Date.now();
  const result: InferResult = {
    sectionsScanned: 0,
    coOccurrences: 0,
    edgesCreated: 0,
    edgesSkippedDuplicate: 0,
    edgesBefore: 0,
    edgesAfter: 0,
    errors: [],
    duration_ms: 0,
  };

  // Get edge count before
  const beforeCount = await query('SELECT COUNT(*) as count FROM semantic_edges');
  result.edgesBefore = parseInt(beforeCount.rows[0].count);

  // Load all entities from DB
  const allNodes = await query('SELECT id, type, name, aliases FROM semantic_nodes');
  const nodeMap = new Map<string, { id: string; type: string; name: string }>();
  
  for (const node of allNodes.rows) {
    // Map by canonical name
    nodeMap.set(node.name.toLowerCase(), { id: node.id, type: node.type, name: node.name });
    // Also map by aliases
    if (node.aliases) {
      for (const alias of node.aliases) {
        if (alias.length > 2) {
          nodeMap.set(alias.toLowerCase(), { id: node.id, type: node.type, name: node.name });
        }
      }
    }
  }

  // Track co-occurrences: Map<"nodeId1:nodeId2", count>
  const coOccurrenceCount = new Map<string, { source: typeof nodeMap extends Map<any, infer V> ? V : never; target: typeof nodeMap extends Map<any, infer V> ? V : never; count: number }>();

  // Scan all markdown sections
  const files = readAllFiles();
  for (const file of files) {
    const sections = parseIntoSections(file);
    for (const section of sections) {
      result.sectionsScanned++;
      const contentLower = section.content.toLowerCase();
      
      // Find all entities mentioned in this section
      const foundInSection: Array<{ id: string; type: string; name: string }> = [];
      
      for (const [searchTerm, node] of nodeMap) {
        // Skip very short terms (< 4 chars) to avoid false matches
        if (searchTerm.length < 4) continue;
        
        if (contentLower.includes(searchTerm)) {
          // Avoid duplicate entries for same node (via alias)
          if (!foundInSection.some(f => f.id === node.id)) {
            foundInSection.push(node);
          }
        }
      }

      // Record co-occurrences (all pairs in this section)
      for (let i = 0; i < foundInSection.length; i++) {
        for (let j = i + 1; j < foundInSection.length; j++) {
          const a = foundInSection[i];
          const b = foundInSection[j];
          
          // Skip self-references
          if (a.id === b.id) continue;
          
          // Canonical key (sorted by ID to avoid A:B and B:A being different)
          const key = [a.id, b.id].sort().join(':');
          
          const existing = coOccurrenceCount.get(key);
          if (existing) {
            existing.count++;
          } else {
            coOccurrenceCount.set(key, { source: a, target: b, count: 1 });
          }
        }
      }
    }
  }

  console.log(`[INFER] Scanned ${result.sectionsScanned} sections, found ${coOccurrenceCount.size} entity pairs`);

  // Track per-node inferred edge counts to prevent hub explosions
  const nodeInferredCount = new Map<string, number>();

  // Sort by co-occurrence count descending — prioritize strongest signals
  const sortedPairs = [...coOccurrenceCount.entries()]
    .filter(([_, data]) => data.count >= minCoOccurrences)
    .sort((a, b) => b[1].count - a[1].count);

  // Create edges for pairs that co-occur enough times
  for (const [key, data] of sortedPairs) {
    // GUARDRAIL: Stop if we've hit the per-run cap
    if (result.edgesCreated >= MAX_INFERRED_EDGES_PER_RUN) {
      console.log(`[INFER] Hit per-run cap of ${MAX_INFERRED_EDGES_PER_RUN} edges — stopping`);
      break;
    }

    result.coOccurrences++;

    // GUARDRAIL: Skip low-signal type pairs (concept↔concept, tool↔tool)
    const typePair = `${data.source.type}:${data.target.type}`;
    const typePairReverse = `${data.target.type}:${data.source.type}`;
    if (SKIP_TYPE_PAIRS.has(typePair) || SKIP_TYPE_PAIRS.has(typePairReverse)) {
      continue;
    }

    // GUARDRAIL: Per-node cap
    const sourceCount = nodeInferredCount.get(data.source.id) || 0;
    const targetCount = nodeInferredCount.get(data.target.id) || 0;
    if (sourceCount >= MAX_INFERRED_EDGES_PER_NODE || targetCount >= MAX_INFERRED_EDGES_PER_NODE) {
      continue;
    }

    // Check if edge already exists (in either direction)
    const existingEdge = await query(
      `SELECT id FROM semantic_edges 
       WHERE (source_id = $1 AND target_id = $2) OR (source_id = $2 AND target_id = $1)
       LIMIT 1`,
      [data.source.id, data.target.id]
    );

    if (existingEdge.rows.length > 0) {
      result.edgesSkippedDuplicate++;
      continue;
    }

    // Infer relationship type
    const { relationship, category } = inferRelationshipType(data.source.type, data.target.type);

    try {
      await query(
        `INSERT INTO semantic_edges (source_id, target_id, relationship, category, strength, confidence, confidence_basis, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          data.source.id,
          data.target.id,
          relationship,
          category,
          Math.min(1.0, 0.3 + (data.count * 0.05)), // strength scales with co-occurrence
          0.5, // inferred = lower confidence than explicit
          'inferred',
          `Co-occurred in ${data.count} sections`,
        ]
      );
      result.edgesCreated++;
      nodeInferredCount.set(data.source.id, sourceCount + 1);
      nodeInferredCount.set(data.target.id, targetCount + 1);
    } catch (err) {
      result.errors.push(`[edge:${data.source.name}→${data.target.name}] ${(err as Error).message}`);
    }
  }

  // Get edge count after
  const afterCount = await query('SELECT COUNT(*) as count FROM semantic_edges');
  result.edgesAfter = parseInt(afterCount.rows[0].count);
  result.duration_ms = Date.now() - start;

  console.log(`[INFER] Created ${result.edgesCreated} inferred edges (${result.edgesSkippedDuplicate} skipped as duplicates)`);
  console.log(`[INFER] Edges: ${result.edgesBefore} → ${result.edgesAfter}`);

  return result;
}
