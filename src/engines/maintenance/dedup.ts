/**
 * Entity Deduplication Engine
 * 
 * Phase 1.1: Reduce false-positive person nodes and merge duplicates.
 * Target: < 100 person nodes (from 683), zero real entities lost.
 * 
 * Strategy:
 * 1. Remove person nodes that only appear once (single mention = likely false positive)
 * 2. Embedding-based similarity to find potential duplicates
 * 3. Alias merging (e.g., "Chris" near "Jane Doe" → merge)
 */

import { query } from '../../storage/db.js';
import { cosineSimilarity } from '../../storage/embeddings/ollama.js';

interface DedupResult {
  personNodesBefore: number;
  personNodesAfter: number;
  nodesRemoved: number;
  nodesMerged: number;
  potentialDuplicates: Array<{ name1: string; name2: string; similarity: number }>;
  errors: string[];
  duration_ms: number;
}

// Protected names are loaded from DB — any entity with a person_model is protected
// This is data-driven, not hardcoded. If you add a person model, they're auto-protected.
let PROTECTED_NAMES = new Set<string>();

async function loadProtectedNames(): Promise<Set<string>> {
  try {
    const { query: dbQuery } = await import('../../storage/db.js');
    const people = (await dbQuery('SELECT name FROM person_models')).rows;
    return new Set(people.map((p: { name: string }) => p.name));
  } catch {
    return new Set();
  }
}

/**
 * Run full deduplication pipeline.
 */
export async function deduplicateEntities(): Promise<DedupResult> {
  // Load protected names from DB (data-driven, not hardcoded)
  PROTECTED_NAMES = await loadProtectedNames();
  
  const start = Date.now();
  const result: DedupResult = {
    personNodesBefore: 0,
    personNodesAfter: 0,
    nodesRemoved: 0,
    nodesMerged: 0,
    potentialDuplicates: [],
    errors: [],
    duration_ms: 0,
  };

  // Count before
  const beforeCount = await query("SELECT COUNT(*) as count FROM semantic_nodes WHERE type = 'person'");
  result.personNodesBefore = parseInt(beforeCount.rows[0].count);
  console.log(`[DEDUP] Starting with ${result.personNodesBefore} person nodes`);

  // Step 1: Remove single-mention false positives
  // Person nodes that were dynamically discovered (confidence < 1.0) and only mentioned in one file
  console.log('[DEDUP] Step 1: Removing low-confidence single-mention persons...');
  const lowConfidence = await query(
    `SELECT id, name, context FROM semantic_nodes 
     WHERE type = 'person' AND confidence < 1.0`
  );

  for (const node of lowConfidence.rows) {
    if (PROTECTED_NAMES.has(node.name)) continue;

    // Check if this name appears in the context of other nodes or in edges
    const edgeCount = await query(
      'SELECT COUNT(*) as count FROM semantic_edges WHERE source_id = $1 OR target_id = $1',
      [node.id]
    );

    if (parseInt(edgeCount.rows[0].count) === 0) {
      // No relationships — likely a false positive
      try {
        await query('DELETE FROM semantic_nodes WHERE id = $1', [node.id]);
        result.nodesRemoved++;
      } catch (err) {
        result.errors.push(`[remove:${node.name}] ${(err as Error).message}`);
      }
    }
  }
  console.log(`[DEDUP] Step 1 complete: removed ${result.nodesRemoved} orphaned person nodes`);

  // Step 2: Find potential duplicates via embedding similarity
  console.log('[DEDUP] Step 2: Finding embedding-similar person nodes...');
  const remaining = await query(
    `SELECT id, name, embedding FROM semantic_nodes 
     WHERE type = 'person' AND embedding IS NOT NULL
     ORDER BY name`
  );

  const personNodes = remaining.rows;
  for (let i = 0; i < personNodes.length; i++) {
    for (let j = i + 1; j < personNodes.length; j++) {
      const a = personNodes[i];
      const b = personNodes[j];

      if (!a.embedding || !b.embedding) continue;

      // Parse pgvector format to arrays
      const embA = parseVector(a.embedding);
      const embB = parseVector(b.embedding);

      if (!embA || !embB) continue;

      const sim = cosineSimilarity(embA, embB);
      if (sim > 0.92) {
        result.potentialDuplicates.push({
          name1: a.name,
          name2: b.name,
          similarity: sim,
        });
      }
    }
  }
  console.log(`[DEDUP] Step 2 complete: found ${result.potentialDuplicates.length} potential duplicates`);

  // Step 3: Alias merging — if a short name is a substring of a longer name, merge
  console.log('[DEDUP] Step 3: Alias merging...');
  const allPersons = await query(
    `SELECT id, name, aliases FROM semantic_nodes WHERE type = 'person' ORDER BY length(name) DESC`
  );

  const nameMap = new Map<string, { id: string; name: string; aliases: string[] }>();
  for (const p of allPersons.rows) {
    nameMap.set(p.name, { id: p.id, name: p.name, aliases: p.aliases || [] });
  }

  for (const [shortName, shortNode] of nameMap) {
    if (PROTECTED_NAMES.has(shortName)) continue;
    if (shortName.split(' ').length > 1) continue; // Only merge single-word names into full names

    for (const [fullName, fullNode] of nameMap) {
      if (shortName === fullName) continue;
      if (fullName.split(' ').length < 2) continue; // Target must be a full name

      // Check if short name is a first or last name of the full name
      const parts = fullName.split(' ');
      if (parts.includes(shortName) && !PROTECTED_NAMES.has(shortName)) {
        // Merge: add short name as alias of full name, delete short name node
        try {
          // Add alias
          if (!fullNode.aliases.includes(shortName)) {
            await query(
              `UPDATE semantic_nodes SET aliases = array_append(aliases, $1) WHERE id = $2`,
              [shortName, fullNode.id]
            );
          }

          // Move any edges from short node to full node
          await query(
            'UPDATE semantic_edges SET source_id = $1 WHERE source_id = $2',
            [fullNode.id, shortNode.id]
          );
          await query(
            'UPDATE semantic_edges SET target_id = $1 WHERE target_id = $2',
            [fullNode.id, shortNode.id]
          );

          // Delete the short-name node
          await query('DELETE FROM semantic_nodes WHERE id = $1', [shortNode.id]);
          result.nodesMerged++;
          nameMap.delete(shortName);
          break; // Move to next short name
        } catch (err) {
          result.errors.push(`[merge:${shortName}→${fullName}] ${(err as Error).message}`);
        }
      }
    }
  }
  console.log(`[DEDUP] Step 3 complete: merged ${result.nodesMerged} alias nodes`);

  // Count after
  const afterCount = await query("SELECT COUNT(*) as count FROM semantic_nodes WHERE type = 'person'");
  result.personNodesAfter = parseInt(afterCount.rows[0].count);
  result.duration_ms = Date.now() - start;

  console.log(`[DEDUP] Final: ${result.personNodesBefore} → ${result.personNodesAfter} person nodes (${result.nodesRemoved} removed, ${result.nodesMerged} merged)`);

  return result;
}

/**
 * Parse pgvector's text representation back to a number array.
 * pgvector stores as "[0.1,0.2,...]"
 */
function parseVector(vec: string | number[]): number[] | null {
  if (Array.isArray(vec)) return vec;
  if (typeof vec !== 'string') return null;
  try {
    const cleaned = vec.replace(/^\[/, '').replace(/\]$/, '');
    return cleaned.split(',').map(Number);
  } catch {
    return null;
  }
}
