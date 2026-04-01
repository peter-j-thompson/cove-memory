/**
 * Code Brain Writer — Write transformed code intelligence into the brain
 * 
 * Uses the existing semantic and episodic layer stores.
 * We're not creating new layers — we're enriching existing ones
 * with architectural knowledge.
 */

import { upsertNode, createEdge, findNode } from '../../layers/semantic/store.js';
import { query } from '../../storage/db.js';
import { embed } from '../../storage/embeddings/ollama.js';
import type { TransformedOutput } from './transformer.js';
import type { EntityType, RelationshipType, RelationshipCategory } from '../../types.js';

export interface WriteResult {
  semanticNodes: number;
  semanticEdges: number;
  episodicEntries: number;
  errors: string[];
}

/**
 * Write transformed code intelligence into the brain's semantic + episodic layers.
 */
export async function writeToBrain(output: TransformedOutput): Promise<WriteResult> {
  const result: WriteResult = {
    semanticNodes: 0,
    semanticEdges: 0,
    episodicEntries: 0,
    errors: [],
  };

  // 1. Write semantic nodes
  for (const node of output.nodes) {
    try {
      await upsertNode({
        type: node.type as EntityType,
        name: node.name,
        aliases: node.aliases,
        attributes: node.attributes,
        context: node.context,
        significance: node.significance,
        confidence: node.confidence,
        confidence_basis: 'code_brain_analysis',
        source_episodes: [],
      });
      result.semanticNodes++;
    } catch (err) {
      result.errors.push(`Node ${node.name}: ${(err as Error).message}`);
    }
  }

  // 2. Write semantic edges
  for (const edge of output.edges) {
    try {
      // Find source and target node IDs
      const sourceNode = await findNode(edge.sourceType as EntityType, edge.sourceName);
      const targetNode = await findNode(edge.targetType as EntityType, edge.targetName);

      if (sourceNode && targetNode) {
        await createEdge({
          source_id: sourceNode.id,
          target_id: targetNode.id,
          relationship: edge.relationship as RelationshipType,
          category: edge.category as RelationshipCategory,
          strength: edge.strength,
          confidence: edge.confidence,
          context: edge.context,
          emotional_weight: 0,
          source_episodes: [],
        });
        result.semanticEdges++;
      }
    } catch (err) {
      const msg = (err as Error).message;
      // Skip duplicate edge errors silently
      if (!msg.includes('duplicate') && !msg.includes('already exists')) {
        result.errors.push(`Edge ${edge.sourceName}→${edge.targetName}: ${msg}`);
      }
    }
  }

  // 3. Write episodic entries
  for (const episode of output.episodes) {
    try {
      // Generate embedding for the episode summary
      let embedding: number[] | null = null;
      try {
        const result = await embed(episode.summary);
        embedding = result.embedding;
      } catch { /* embeddings optional */ }

      await query(
        `INSERT INTO episodes (
          session_id, summary, detailed_narrative, participants, initiator,
          emotional_arc, peak_emotion, resolution_emotion, outcome,
          topics, importance_score, embedding
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          'code-brain-sync',
          episode.summary,
          episode.context,
          ['Agent'],
          'Agent',
          JSON.stringify({ start: { valence: episode.emotionalValence, arousal: 0.3, label: 'productive' }, trajectory: 'stable', end: { valence: episode.emotionalValence, arousal: 0.3, label: 'productive' } }),
          JSON.stringify({ valence: episode.emotionalValence, arousal: 0.3, label: 'analytical' }),
          JSON.stringify({ valence: episode.emotionalValence, arousal: 0.2, label: 'satisfied' }),
          JSON.stringify({ status: 'completed', description: 'Architecture sync' }),
          episode.topics,
          episode.importance,
          embedding ? `[${embedding.join(',')}]` : null,
        ]
      );
      result.episodicEntries++;
    } catch (err) {
      result.errors.push(`Episode: ${(err as Error).message}`);
    }
  }

  return result;
}
