/**
 * Automatic Ingestion Engine — Builds the brain from markdown files.
 * 
 * NO hardcoded entities. NO hardcoded relationships.
 * 
 * The pipeline:
 * 1. Read all markdown files (MEMORY.md, USER.md, SOUL.md, IDENTITY.md, etc.)
 * Customize MARKDOWN_MEMORY_DIR in .env to point to your agent's memory directory.
 * 2. Prioritize high-value files (soul, identity, user, memory) for entity extraction
 * 3. Use LLM to extract entities + context from each section
 * 4. Use LLM to extract relationships between discovered entities
 * 5. Process daily files for episodes
 * 6. Process lessons.md for lesson entries
 * 7. Generate embeddings for all nodes
 * 8. Run edge weight differentiation
 * 
 * REPRODUCIBILITY TEST: Drop the DB, run this, brain rebuilds from markdown alone.
 */

import { readAllFiles, parseIntoSections, type MarkdownFile, type MemorySection } from '../../integrations/markdown-reader.js';
import { upsertNode, createEdge, findNode } from '../../layers/semantic/store.js';
import { embed, embedBatch } from '../../storage/embeddings/ollama.js';
import { query } from '../../storage/db.js';
import { updateEdgeWeights } from '../maintenance/edge-weights.js';
import {
  extractEntitiesFromText,
  extractRelationshipsFromText,
  deduplicateEntities,
  deduplicateRelationships,
  type ExtractedEntity,
  type ExtractedRelationship,
} from './llm-extract.js';
import type { EntityType } from '../../types.js';

interface AutoIngestResult {
  filesProcessed: number;
  sectionsProcessed: number;
  nodesCreated: number;
  edgesCreated: number;
  episodesCreated: number;
  lessonsCreated: number;
  embeddingsGenerated: number;
  llmCalls: number;
  errors: string[];
  duration_ms: number;
}

// Files processed in priority order — highest signal first
const FILE_PRIORITY: Record<string, number> = {
  soul: 1,
  identity: 2,
  user: 3,
  memory: 4,
  lesson: 5,
  tool: 6,
  daily: 7,
  research: 8,
  heartbeat: 9,
  other: 10,
};

/**
 * Full automatic ingestion — reads markdown, extracts knowledge via LLM, populates DB.
 */
export async function autoIngest(options: {
  embeddings?: boolean;
  maxLLMCalls?: number;  // Budget cap for LLM calls
  skipTypes?: string[];  // Skip certain file types
} = {}): Promise<AutoIngestResult> {
  const start = Date.now();
  const maxCalls = options.maxLLMCalls || 200;
  
  const result: AutoIngestResult = {
    filesProcessed: 0,
    sectionsProcessed: 0,
    nodesCreated: 0,
    edgesCreated: 0,
    episodesCreated: 0,
    lessonsCreated: 0,
    embeddingsGenerated: 0,
    llmCalls: 0,
    errors: [],
    duration_ms: 0,
  };

  // Read all files
  const allFiles = readAllFiles();
  console.log(`[AUTO-INGEST] Found ${allFiles.length} markdown files`);

  // Sort by priority — high-signal files first
  allFiles.sort((a, b) => (FILE_PRIORITY[a.type] || 10) - (FILE_PRIORITY[b.type] || 10));

  // Filter out skipped types
  const files = options.skipTypes
    ? allFiles.filter(f => !options.skipTypes!.includes(f.type))
    : allFiles;

  // ============================================================
  // PHASE 1: Entity Extraction (LLM-powered)
  // ============================================================
  console.log(`[AUTO-INGEST] Phase 1: Extracting entities from ${files.length} files...`);
  
  let allEntities: ExtractedEntity[] = [];
  
  // Process high-priority files first (soul, identity, user, memory)
  const priorityFiles = files.filter(f => ['soul', 'identity', 'user', 'memory'].includes(f.type));
  const otherFiles = files.filter(f => !['soul', 'identity', 'user', 'memory'].includes(f.type));

  for (const file of priorityFiles) {
    if (result.llmCalls >= maxCalls) {
      console.log(`[AUTO-INGEST] LLM call budget reached (${maxCalls}). Stopping entity extraction.`);
      break;
    }

    const sections = parseIntoSections(file);
    
    // For large files (MEMORY.md), process each ## section separately
    for (const section of sections) {
      if (section.content.length < 50) continue; // Skip tiny sections
      if (result.llmCalls >= maxCalls) break;

      try {
        const entities = await extractEntitiesFromText(
          section.content,
          `${file.filename}:${section.heading}`
        );
        allEntities.push(...entities);
        result.llmCalls++;
        result.sectionsProcessed++;
        
        if (entities.length > 0) {
          console.log(`  [${file.filename}:${section.heading.substring(0, 40)}] → ${entities.length} entities`);
        }
      } catch (err) {
        result.errors.push(`[entities:${file.filename}:${section.heading}] ${(err as Error).message}`);
      }
    }
    
    result.filesProcessed++;
  }

  // Process daily files — combine multiple sections per LLM call to save budget
  for (const file of otherFiles) {
    if (result.llmCalls >= maxCalls) break;
    
    const sections = parseIntoSections(file);
    const significantSections = sections.filter(s => s.content.length > 200);
    
    if (significantSections.length === 0) {
      result.filesProcessed++;
      continue;
    }

    // Batch small sections together (up to 2500 chars total)
    let batch = '';
    let batchSections: string[] = [];
    
    for (const section of significantSections) {
      if (batch.length + section.content.length > 2500 || batchSections.length >= 3) {
        // Process current batch
        if (batch.length > 100 && result.llmCalls < maxCalls) {
          try {
            const entities = await extractEntitiesFromText(batch, `${file.filename}:${batchSections.join('+')}`);
            allEntities.push(...entities);
            result.llmCalls++;
            result.sectionsProcessed += batchSections.length;
          } catch (err) {
            result.errors.push(`[entities:${file.filename}:batch] ${(err as Error).message}`);
          }
        }
        batch = '';
        batchSections = [];
      }
      batch += `\n\n## ${section.heading}\n${section.content}`;
      batchSections.push(section.heading.substring(0, 20));
    }
    
    // Process remaining batch
    if (batch.length > 100 && result.llmCalls < maxCalls) {
      try {
        const entities = await extractEntitiesFromText(batch, `${file.filename}:${batchSections.join('+')}`);
        allEntities.push(...entities);
        result.llmCalls++;
        result.sectionsProcessed += batchSections.length;
      } catch (err) {
        result.errors.push(`[entities:${file.filename}:final-batch] ${(err as Error).message}`);
      }
    }
    
    result.filesProcessed++;
  }

  // Deduplicate entities
  const entities = deduplicateEntities(allEntities);
  console.log(`[AUTO-INGEST] Phase 1 complete: ${allEntities.length} raw → ${entities.length} unique entities (${result.llmCalls} LLM calls)`);

  // ============================================================
  // PHASE 2: Store Entities in DB
  // ============================================================
  console.log(`[AUTO-INGEST] Phase 2: Storing ${entities.length} entities...`);
  
  const nodeIdMap = new Map<string, string>(); // name → DB id

  for (const entity of entities) {
    try {
      const id = await upsertNode({
        type: entity.type,
        name: entity.name,
        aliases: entity.aliases,
        context: entity.context,
        confidence: 0.9, // LLM-extracted = slightly less confident than manually verified
        confidence_basis: 'llm-extracted',
        emotional_weight: entity.emotional_weight || 0.3,
      });
      nodeIdMap.set(entity.name, id);
      // Also map aliases
      for (const alias of entity.aliases) {
        nodeIdMap.set(alias, id);
      }
      result.nodesCreated++;
    } catch (err) {
      result.errors.push(`[node:${entity.name}] ${(err as Error).message}`);
    }
  }
  console.log(`[AUTO-INGEST] Phase 2 complete: ${result.nodesCreated} nodes stored`);

  // ============================================================
  // PHASE 3: Relationship Extraction (LLM-powered)
  // ============================================================
  console.log(`[AUTO-INGEST] Phase 3: Extracting relationships...`);
  
  let allRelationships: ExtractedRelationship[] = [];
  const entityNames = entities.map(e => e.name);

  // Only extract relationships from high-priority files (these contain the most relationship info)
  const relFiles = files.filter(f => ['soul', 'identity', 'user', 'memory'].includes(f.type));
  
  for (const file of relFiles) {
    if (result.llmCalls >= maxCalls) break;

    const sections = parseIntoSections(file);
    
    for (const section of sections) {
      if (section.content.length < 100) continue;
      if (result.llmCalls >= maxCalls) break;

      // Only extract relationships if the section mentions at least 2 known entities
      const sectionLower = section.content.toLowerCase();
      const mentionedEntities = entityNames.filter(name => 
        sectionLower.includes(name.toLowerCase())
      );
      if (mentionedEntities.length < 2) continue;

      try {
        const rels = await extractRelationshipsFromText(
          section.content,
          entityNames,
          `${file.filename}:${section.heading}`
        );
        allRelationships.push(...rels);
        result.llmCalls++;
        
        if (rels.length > 0) {
          console.log(`  [${file.filename}:${section.heading.substring(0, 40)}] → ${rels.length} relationships`);
        }
      } catch (err) {
        result.errors.push(`[rels:${file.filename}:${section.heading}] ${(err as Error).message}`);
      }
    }
  }

  const relationships = deduplicateRelationships(allRelationships);
  console.log(`[AUTO-INGEST] Phase 3 complete: ${allRelationships.length} raw → ${relationships.length} unique relationships (${result.llmCalls} total LLM calls)`);

  // ============================================================
  // PHASE 4: Store Relationships in DB
  // ============================================================
  console.log(`[AUTO-INGEST] Phase 4: Storing ${relationships.length} relationships...`);

  for (const rel of relationships) {
    try {
      const sourceId = nodeIdMap.get(rel.source) || await findNodeByNameOrAlias(rel.source);
      const targetId = nodeIdMap.get(rel.target) || await findNodeByNameOrAlias(rel.target);
      
      if (!sourceId || !targetId) {
        result.errors.push(`[edge] Missing node: ${rel.source} → ${rel.target}`);
        continue;
      }

      await createEdge({
        source_id: sourceId,
        target_id: targetId,
        relationship: rel.relationship,
        category: rel.category,
        strength: rel.strength,
        confidence: 0.85,
        context: rel.context,
      });
      result.edgesCreated++;
    } catch (err) {
      result.errors.push(`[edge:${rel.source}→${rel.target}] ${(err as Error).message}`);
    }
  }
  console.log(`[AUTO-INGEST] Phase 4 complete: ${result.edgesCreated} edges stored`);

  // ============================================================
  // PHASE 5: Episodes from Daily Files
  // ============================================================
  console.log(`[AUTO-INGEST] Phase 5: Creating episodes from daily files...`);

  const dailyFiles = allFiles.filter(f => f.type === 'daily');
  for (const file of dailyFiles) {
    const sections = parseIntoSections(file);
    for (const section of sections) {
      if (section.content.length > 100 && /[✅🚨🔥💰🧠📊⚔️💎🦅🪨🏗️🛡️🐦]/.test(section.heading + section.content.substring(0, 50))) {
        const dateMatch = file.filename.match(/(\d{4}-\d{2}-\d{2})/);
        try {
          await query(
            `INSERT INTO episodes (session_id, summary, detailed_narrative, topics, importance_score, emotional_arc, outcome)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT DO NOTHING`,
            [
              `daily-${dateMatch?.[1] || 'unknown'}`,
              section.heading.substring(0, 500),
              section.content.substring(0, 4000),
              extractTopicsGeneric(section.content),
              computeImportanceGeneric(section),
              JSON.stringify({ start: { valence: 0, arousal: 0.3 }, trajectory: 'stable', end_state: { valence: 0.3, arousal: 0.3 } }),
              JSON.stringify({ type: 'informational', description: 'Logged in daily file', verified: true }),
            ]
          );
          result.episodesCreated++;
        } catch { /* duplicate or constraint */ }
      }
    }
  }
  console.log(`[AUTO-INGEST] Phase 5 complete: ${result.episodesCreated} episodes`);

  // ============================================================
  // PHASE 6: Lessons from lessons.md
  // ============================================================
  console.log(`[AUTO-INGEST] Phase 6: Processing lessons...`);

  const lessonFiles = allFiles.filter(f => f.type === 'lesson');
  for (const file of lessonFiles) {
    const sections = parseIntoSections(file);
    for (const section of sections) {
      if (section.content.length < 50) continue;
      const severity = section.heading.includes('CRITICAL') || section.content.includes('CRITICAL')
        ? 'critical'
        : section.heading.includes('RECURRING')
          ? 'important'
          : 'minor';
      try {
        await query(
          `INSERT INTO lessons (statement, severity, prevention_rule, times_reinforced)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [
            `${section.heading}: ${section.content.substring(0, 200)}`,
            severity,
            'See full lesson for prevention steps.',
            1,
          ]
        );
        result.lessonsCreated++;
      } catch { /* duplicate */ }
    }
  }
  console.log(`[AUTO-INGEST] Phase 6 complete: ${result.lessonsCreated} lessons`);

  // ============================================================
  // PHASE 7: Generate Embeddings
  // ============================================================
  if (options.embeddings !== false) {
    console.log(`[AUTO-INGEST] Phase 7: Generating embeddings...`);
    
    const nodesWithout = await query(
      'SELECT id, name, type, context, significance, aliases, attributes FROM semantic_nodes WHERE embedding IS NULL'
    );
    
    for (const node of nodesWithout.rows) {
      try {
        const text = [
          `${node.type}: ${node.name}`,
          node.aliases?.length ? `Also known as: ${node.aliases.join(', ')}` : '',
          node.context || '',
          node.significance || '',
        ].filter(Boolean).join('. ');
        
        const embResult = await embed(text);
        await query('UPDATE semantic_nodes SET embedding = $1 WHERE id = $2', [
          '[' + embResult.embedding.join(',') + ']', node.id
        ]);
        result.embeddingsGenerated++;
      } catch (err) {
        result.errors.push(`[embedding:${node.name}] ${(err as Error).message}`);
      }
    }
    
    // Also embed episodes without embeddings
    const epsWithout = await query(
      "SELECT id, summary, detailed_narrative FROM episodes WHERE embedding IS NULL"
    );
    for (const ep of epsWithout.rows) {
      try {
        const text = `${ep.summary}. ${(ep.detailed_narrative || '').substring(0, 500)}`;
        const embResult = await embed(text);
        await query('UPDATE episodes SET embedding = $1 WHERE id = $2', [
          '[' + embResult.embedding.join(',') + ']', ep.id
        ]);
        result.embeddingsGenerated++;
      } catch (err) {
        result.errors.push(`[embedding:episode] ${(err as Error).message}`);
      }
    }
    
    console.log(`[AUTO-INGEST] Phase 7 complete: ${result.embeddingsGenerated} embeddings`);
  }

  // ============================================================
  // PHASE 8: Edge Weight Differentiation
  // ============================================================
  console.log(`[AUTO-INGEST] Phase 8: Computing edge weights...`);
  try {
    await updateEdgeWeights();
  } catch (err) {
    result.errors.push(`[edge-weights] ${(err as Error).message}`);
  }

  result.duration_ms = Date.now() - start;
  
  console.log(`\n[AUTO-INGEST] ✅ COMPLETE`);
  console.log(`  Files: ${result.filesProcessed}`);
  console.log(`  Sections: ${result.sectionsProcessed}`);
  console.log(`  Nodes: ${result.nodesCreated}`);
  console.log(`  Edges: ${result.edgesCreated}`);
  console.log(`  Episodes: ${result.episodesCreated}`);
  console.log(`  Lessons: ${result.lessonsCreated}`);
  console.log(`  Embeddings: ${result.embeddingsGenerated}`);
  console.log(`  LLM calls: ${result.llmCalls}`);
  console.log(`  Errors: ${result.errors.length}`);
  console.log(`  Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
  
  return result;
}

// ============================================================
// HELPERS (data-driven, no hardcoded values)
// ============================================================

async function findNodeByNameOrAlias(nameOrAlias: string): Promise<string | null> {
  const res = await query(
    `SELECT id FROM semantic_nodes 
     WHERE LOWER(name) = LOWER($1) 
        OR LOWER($1) = ANY(SELECT LOWER(unnest(aliases)))
     LIMIT 1`,
    [nameOrAlias]
  );
  return res.rows[0]?.id || null;
}

/**
 * Extract topics from content — data-driven, uses entity names from DB.
 */
function extractTopicsGeneric(content: string): string[] {
  const topics: string[] = [];
  const lower = content.toLowerCase();
  
  // Generic topic detection from content structure
  const topicPatterns = [
    { pattern: /deploy|ship|release|launch/i, topic: 'deployment' },
    { pattern: /bug|fix|error|broken/i, topic: 'bugfix' },
    { pattern: /security|credential|auth|encrypt/i, topic: 'security' },
    { pattern: /revenue|money|income|pay|cost/i, topic: 'financial' },
    { pattern: /test|benchmark|qa|verify/i, topic: 'testing' },
    { pattern: /architect|design|decision/i, topic: 'architecture' },
    { pattern: /memory|brain|cognitive/i, topic: 'memory-system' },
    { pattern: /agent|sub-agent|spawn/i, topic: 'agents' },
    { pattern: /client|customer|onboard/i, topic: 'client-work' },
    { pattern: /research|investigate|explore/i, topic: 'research' },
  ];
  
  for (const { pattern, topic } of topicPatterns) {
    if (pattern.test(content)) topics.push(topic);
  }
  
  return topics;
}

/**
 * Compute importance from content signals — no entity-specific logic.
 */
function computeImportanceGeneric(section: MemorySection): number {
  let score = 0.5;
  
  // Emoji signals
  if (/[🚨💰💎🪨]/.test(section.heading)) score += 0.2;
  if (/[✅🔥🧠]/.test(section.heading)) score += 0.1;
  
  // Keyword signals
  const content = section.content.toLowerCase();
  if (content.includes('critical') || content.includes('decision')) score += 0.1;
  if (content.includes('deployed') || content.includes('live')) score += 0.1;
  if (content.includes('breakthrough') || content.includes('milestone')) score += 0.15;
  if (content.includes('covenant') || content.includes('partnership')) score += 0.15;
  
  // Length (more detail = likely more important)
  if (section.content.length > 2000) score += 0.1;
  if (section.content.length > 5000) score += 0.1;
  
  return Math.min(1.0, score);
}
