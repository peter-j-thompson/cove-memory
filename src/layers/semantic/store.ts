/**
 * Semantic Memory Store — Facts and Knowledge Graph
 * 
 * This is where meaning lives — entities, relationships, and confidence.
 * but WHY that matters, HOW it connects, and WHAT it means emotionally.
 */

import { query, cypher, transaction } from '../../storage/db.js';
import type { SemanticNode, SemanticEdge, EntityType, RelationshipType, RelationshipCategory } from '../../types.js';

// ============================================================
// NODE OPERATIONS
// ============================================================

/**
 * Create or update a semantic node (entity in the knowledge graph).
 * Uses upsert — if entity with same type+name exists, updates it.
 */
export async function upsertNode(node: {
  type: EntityType;
  name: string;
  aliases?: string[];
  attributes?: Record<string, unknown>;
  context?: string;
  emotional_weight?: number;
  significance?: string;
  confidence?: number;
  confidence_basis?: string;
  source_episodes?: string[];
}): Promise<string> {
  const result = await query(
    `INSERT INTO semantic_nodes (type, name, aliases, attributes, context, emotional_weight, significance, confidence, confidence_basis, source_episodes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (type, name) DO UPDATE SET
       aliases = COALESCE(NULLIF($3, '{}'), semantic_nodes.aliases),
       attributes = semantic_nodes.attributes || $4,
       context = COALESCE($5, semantic_nodes.context),
       emotional_weight = COALESCE($6, semantic_nodes.emotional_weight),
       significance = COALESCE($7, semantic_nodes.significance),
       confidence = COALESCE($8, semantic_nodes.confidence),
       confidence_basis = COALESCE($9, semantic_nodes.confidence_basis),
       source_episodes = array_cat(semantic_nodes.source_episodes, $10),
       last_modified = NOW()
     RETURNING id`,
    [
      node.type,
      node.name,
      node.aliases || [],
      JSON.stringify(node.attributes || {}),
      node.context || null,
      node.emotional_weight ?? 0,
      node.significance || null,
      node.confidence ?? 0.5,
      node.confidence_basis || 'assumed',
      node.source_episodes || [],
    ]
  );
  
  const nodeId = result.rows[0].id;
  
  // Also create/update in AGE graph
  try {
    await cypher(
      `MERGE (n:Entity {name: '${node.name.replace(/'/g, "\\'")}', type: '${node.type}'})
       SET n.db_id = '${nodeId}', n.confidence = ${node.confidence ?? 0.5}
       RETURN n`,
      'n agtype'
    );
  } catch (err) {
    // Graph ops are supplementary — don't fail the whole operation
    console.warn(`[GRAPH] Failed to upsert vertex for ${node.name}:`, (err as Error).message);
  }
  
  return nodeId;
}

/**
 * Create a relationship between two entities.
 */
export async function createEdge(edge: {
  source_id: string;
  target_id: string;
  relationship: RelationshipType;
  category: RelationshipCategory;
  strength?: number;
  confidence?: number;
  context?: string;
  emotional_weight?: number;
  source_episodes?: string[];
}): Promise<string> {
  const result = await query(
    `INSERT INTO semantic_edges (source_id, target_id, relationship, category, strength, confidence, context, emotional_weight, source_episodes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      edge.source_id,
      edge.target_id,
      edge.relationship,
      edge.category,
      edge.strength ?? 0.5,
      edge.confidence ?? 0.5,
      edge.context || null,
      edge.emotional_weight ?? 0,
      edge.source_episodes || [],
    ]
  );
  
  // Also create in AGE graph
  try {
    // Get node names for graph edge creation
    const sourceNode = await query('SELECT name, type FROM semantic_nodes WHERE id = $1', [edge.source_id]);
    const targetNode = await query('SELECT name, type FROM semantic_nodes WHERE id = $1', [edge.target_id]);
    
    if (sourceNode.rows.length && targetNode.rows.length) {
      const sName = sourceNode.rows[0].name.replace(/'/g, "\\'");
      const tName = targetNode.rows[0].name.replace(/'/g, "\\'");
      const sType = sourceNode.rows[0].type;
      const tType = targetNode.rows[0].type;
      
      await cypher(
        `MATCH (a:Entity {name: '${sName}', type: '${sType}'}),
               (b:Entity {name: '${tName}', type: '${tType}'})
         CREATE (a)-[:${edge.relationship.toUpperCase()} {strength: ${edge.strength ?? 0.5}, confidence: ${edge.confidence ?? 0.5}}]->(b)
         RETURN a, b`,
        'a agtype, b agtype'
      );
    }
  } catch (err) {
    console.warn(`[GRAPH] Failed to create edge ${edge.relationship}:`, (err as Error).message);
  }
  
  return result.rows[0].id;
}

/**
 * Find a node by type and name.
 */
export async function findNode(type: EntityType, name: string): Promise<SemanticNode | null> {
  const result = await query(
    'SELECT * FROM semantic_nodes WHERE type = $1 AND name = $2',
    [type, name]
  );
  return result.rows[0] || null;
}

/**
 * Find nodes by type.
 */
export async function findNodesByType(type: EntityType): Promise<SemanticNode[]> {
  const result = await query(
    'SELECT * FROM semantic_nodes WHERE type = $1 ORDER BY confidence DESC',
    [type]
  );
  return result.rows;
}

/**
 * Get all edges for a node (both directions).
 */
export async function getNodeEdges(nodeId: string): Promise<SemanticEdge[]> {
  const result = await query(
    `SELECT e.*, 
            s.name as source_name, s.type as source_type,
            t.name as target_name, t.type as target_type
     FROM semantic_edges e
     JOIN semantic_nodes s ON e.source_id = s.id
     JOIN semantic_nodes t ON e.target_id = t.id
     WHERE e.source_id = $1 OR e.target_id = $1
     ORDER BY e.strength DESC`,
    [nodeId]
  );
  return result.rows;
}

/**
 * Graph traversal — find connected nodes within N hops.
 * This is what makes graph memory superior to flat text search.
 */
export async function traverseGraph(
  startName: string,
  startType: EntityType,
  maxHops: number = 2
): Promise<Array<{ path: string[]; relationship: string; endpoint: string; depth: number }>> {
  try {
    // Hop 1: direct neighbors
    const hop1 = await cypher(
      `MATCH (src:Entity {name: '${startName.replace(/'/g, "\\'")}', type: '${startType}'})-[r]-(dst:Entity)
       WHERE src <> dst
       RETURN dst.name AS endpoint, type(r) AS rel_type`,
      'endpoint agtype, rel_type agtype'
    );
    
    const hop1Results = hop1.map((r: any) => ({
      path: [startName, JSON.parse(r.endpoint)],
      relationship: JSON.parse(r.rel_type),
      endpoint: JSON.parse(r.endpoint),
      depth: 1,
    }));
    
    if (maxHops < 2) return hop1Results;
    
    // Hop 2: neighbors of neighbors
    const hop2Results: typeof hop1Results = [];
    for (const h1 of hop1Results.slice(0, 10)) {
      try {
        const h1Name = typeof h1.endpoint === 'string' ? h1.endpoint : String(h1.endpoint);
        const hop2 = await cypher(
          `MATCH (mid:Entity {name: '${h1Name.replace(/'/g, "\\'")}'})-[r]-(dst:Entity)
           WHERE dst.name <> '${startName.replace(/'/g, "\\'")}'
           RETURN dst.name AS endpoint, type(r) AS rel_type`,
          'endpoint agtype, rel_type agtype'
        );
        for (const r2 of hop2) {
          hop2Results.push({
            path: [startName, h1Name, JSON.parse(r2.endpoint)],
            relationship: `${h1.relationship} → ${JSON.parse(r2.rel_type)}`,
            endpoint: JSON.parse(r2.endpoint),
            depth: 2,
          });
        }
      } catch { /* ignore hop2 errors */ }
    }
    
    return [...hop1Results, ...hop2Results];
  } catch (err) {
    console.warn(`[GRAPH] Traversal failed:`, (err as Error).message);
    return [];
  }
}

/**
 * Get node count and edge count — for health checks and benchmarks.
 */
export async function getStats(): Promise<{
  nodeCount: number;
  edgeCount: number;
  nodesByType: Record<string, number>;
}> {
  const nodeCount = await query('SELECT COUNT(*) as count FROM semantic_nodes');
  const edgeCount = await query('SELECT COUNT(*) as count FROM semantic_edges');
  const byType = await query(
    'SELECT type, COUNT(*) as count FROM semantic_nodes GROUP BY type ORDER BY count DESC'
  );
  
  const nodesByType: Record<string, number> = {};
  for (const row of byType.rows) {
    nodesByType[row.type] = parseInt(row.count);
  }
  
  return {
    nodeCount: parseInt(nodeCount.rows[0].count),
    edgeCount: parseInt(edgeCount.rows[0].count),
    nodesByType,
  };
}
