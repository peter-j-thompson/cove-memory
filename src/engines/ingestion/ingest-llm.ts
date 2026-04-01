/**
 * LLM-Powered Deep Ingestion Engine
 * 
 * Replaces the hardcoded KNOWN_ENTITIES/KNOWN_RELATIONSHIPS approach.
 * Reads markdown files, sends sections to an LLM for extraction,
 * and builds the knowledge graph entirely from data.
 * 
 * Supports: Anthropic Opus 4.6 (preferred) or Ollama qwen2.5-coder:32b (fallback).
 * 
 * The reproducibility test: drop the DB, run this, brain rebuilds itself.
 * 
 * 🚨 READ-ONLY on markdown files. Write-only to OpenMemory DB.
 */

import * as fs from 'fs';
import { readAllFiles, parseIntoSections, type MarkdownFile, type MemorySection } from '../../integrations/markdown-reader.js';
import { upsertNode, createEdge, findNode } from '../../layers/semantic/store.js';
import { embed, embedBatch } from '../../storage/embeddings/ollama.js';
import { query } from '../../storage/db.js';
import type { EntityType, RelationshipType, RelationshipCategory } from '../../types.js';
import {
  extractEntitiesFromText,
  extractRelationshipsFromText,
  deduplicateEntities,
  deduplicateRelationships,
  type ExtractedEntity,
  type ExtractedRelationship,
} from './llm-extract.js';

interface IngestResult {
  filesProcessed: number;
  sectionsProcessed: number;
  sectionsExtracted: number;
  nodesCreated: number;
  nodesSkipped: number;
  edgesCreated: number;
  edgesSkipped: number;
  lessonsCreated: number;
  episodesCreated: number;
  embeddingsGenerated: number;
  errors: string[];
  duration_ms: number;
}

// ============================================================
// FILE PRIORITY — Process high-value files first
// ============================================================

// These files contain the densest entity/relationship information
// Process them first so the entity list is rich before processing daily files
const FILE_PRIORITY: Record<string, number> = {
  'user': 1,       // USER.md — who the primary user is
  'identity': 2,   // IDENTITY.md — who the agent is
  'soul': 3,       // SOUL.md — values, purpose, beliefs
  'memory': 4,     // MEMORY.md — long-term curated knowledge (richest file)
  'tool': 5,       // TOOLS.md — accounts, tools, deployments
  'lesson': 6,     // lessons.md — learned mistakes
  'daily': 7,      // daily files — raw session logs
  'research': 8,   // research files — deep dives
  'other': 9,      // everything else
};

// ============================================================
// MAIN INGESTION
// ============================================================

/**
 * Full LLM-powered ingestion — read all markdown files, extract entities
 * and relationships using the local LLM, and populate the knowledge graph.
 * 
 * No hardcoded entities. No hardcoded relationships. Pure data-driven extraction.
 */
export async function ingestAllLLM(options: {
  embeddings?: boolean;
  maxSections?: number;    // Limit sections to process (for testing)
  priorityFilesOnly?: boolean;  // Only process USER, IDENTITY, SOUL, MEMORY, TOOLS
  triageMode?: boolean;    // Use triage manifest to process INGEST + SKIM files
} = {}): Promise<IngestResult> {
  const start = Date.now();
  const result: IngestResult = {
    filesProcessed: 0,
    sectionsProcessed: 0,
    sectionsExtracted: 0,
    nodesCreated: 0,
    nodesSkipped: 0,
    edgesCreated: 0,
    edgesSkipped: 0,
    lessonsCreated: 0,
    episodesCreated: 0,
    embeddingsGenerated: 0,
    errors: [],
    duration_ms: 0,
  };

  // Step 1: Read all markdown files, sorted by priority
  const files = readAllFiles().sort((a, b) => {
    const pa = FILE_PRIORITY[a.type] || 9;
    const pb = FILE_PRIORITY[b.type] || 9;
    return pa - pb;
  });

  if (options.triageMode) {
    // Use triage manifest to filter files — only process INGEST and SKIM priority files
    const manifestPath = require('path').join(__dirname, 'triage-manifest.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const ingestFiles = new Set(manifest.results.INGEST.map((f: any) => f.file));
      const skimFiles = new Set(manifest.results.SKIM.map((f: any) => f.file));
      const allTriageFiles = new Set([...ingestFiles, ...skimFiles]);
      
      const filtered = files.filter(f => {
        const fullPath = f.path || f.filename;
        // Match by filename since manifest uses full paths
        return Array.from(allTriageFiles).some((tf: any) => fullPath.endsWith(tf.split('/').pop()) || tf.endsWith(f.filename));
      });
      
      console.log(`[LLM-INGEST] Triage mode: ${ingestFiles.size} INGEST + ${skimFiles.size} SKIM = ${filtered.length} files matched (of ${files.length} total)`);
      files.length = 0;
      files.push(...filtered);
    } catch (err) {
      console.log(`[LLM-INGEST] ⚠️ Triage manifest not found at ${manifestPath}, falling back to all files`);
    }
  } else if (options.priorityFilesOnly) {
    const priorityTypes = new Set(['user', 'identity', 'soul', 'memory', 'tool']);
    const filtered = files.filter(f => priorityTypes.has(f.type));
    console.log(`[LLM-INGEST] Priority-only mode: ${filtered.length} files (of ${files.length} total)`);
    files.length = 0;
    files.push(...filtered);
  }

  console.log(`[LLM-INGEST] Processing ${files.length} markdown files...`);

  // Step 2: Extract entities from ALL sections across all files
  // We collect everything first, then deduplicate, then write to DB
  let allEntities: ExtractedEntity[] = [];
  let allRelationships: ExtractedRelationship[] = [];
  let sectionsProcessed = 0;

  for (const file of files) {
    const sections = parseIntoSections(file);
    console.log(`[LLM-INGEST] ${file.filename}: ${sections.length} sections`);

    for (const section of sections) {
      // Skip very short sections (headers, separators)
      if (section.content.length < 50) continue;
      
      // Skip heartbeat/system sections that don't contain knowledge
      if (section.heading.toLowerCase().includes('heartbeat') && file.type !== 'heartbeat') continue;

      // Rate limit: small delay between LLM calls to avoid overwhelming Ollama
      if (sectionsProcessed > 0 && sectionsProcessed % 5 === 0) {
        await new Promise(r => setTimeout(r, 500));
      }

      // Respect max sections limit
      if (options.maxSections && sectionsProcessed >= options.maxSections) {
        console.log(`[LLM-INGEST] Reached max sections limit (${options.maxSections})`);
        break;
      }

      try {
        // Extract entities
        const sectionLabel = `${file.filename}:${section.heading}`;
        console.log(`[LLM-INGEST]   Extracting: ${sectionLabel.substring(0, 60)}...`);
        
        const entities = await extractEntitiesFromText(section.content, sectionLabel);
        allEntities.push(...entities);
        
        result.sectionsExtracted++;
        sectionsProcessed++;
        
        if (entities.length > 0) {
          console.log(`[LLM-INGEST]     Found ${entities.length} entities: ${entities.map(e => e.name).join(', ').substring(0, 80)}`);
        }
      } catch (err) {
        result.errors.push(`[extract:${file.filename}:${section.heading}] ${(err as Error).message}`);
      }

      result.sectionsProcessed++;
    }

    // Check max sections across files too
    if (options.maxSections && sectionsProcessed >= options.maxSections) break;
    
    result.filesProcessed++;
  }

  // Step 3: Deduplicate entities
  console.log(`[LLM-INGEST] Raw entities: ${allEntities.length}. Deduplicating...`);
  allEntities = deduplicateEntities(allEntities);
  console.log(`[LLM-INGEST] After dedup: ${allEntities.length} unique entities`);

  // Step 4: Write entities to DB
  console.log(`[LLM-INGEST] Phase: Creating ${allEntities.length} entities in DB...`);
  const nodeIdMap = new Map<string, string>(); // name → DB id

  for (const entity of allEntities) {
    try {
      const id = await upsertNode({
        type: entity.type,
        name: entity.name,
        aliases: entity.aliases,
        context: entity.context,
        confidence: 1.0,
        confidence_basis: 'extracted',
        emotional_weight: entity.emotional_weight || 0.3,
      });
      nodeIdMap.set(entity.name, id);
      // Also map aliases → id
      for (const alias of entity.aliases) {
        nodeIdMap.set(alias, id);
      }
      result.nodesCreated++;
    } catch (err) {
      result.nodesSkipped++;
      // Might be duplicate — try to find existing
      try {
        const existing = await findNodeByName(entity.name);
        if (existing) nodeIdMap.set(entity.name, existing);
      } catch { /* skip */ }
    }
  }
  console.log(`[LLM-INGEST] Nodes: ${result.nodesCreated} created, ${result.nodesSkipped} skipped`);

  // Step 5: Extract relationships (now that we know all entity names)
  console.log(`[LLM-INGEST] Phase: Extracting relationships...`);
  const entityNames = [...nodeIdMap.keys()].filter(k => 
    allEntities.some(e => e.name === k) // Only canonical names, not aliases
  );

  // Process priority files for relationships
  for (const file of files) {
    const sections = parseIntoSections(file);
    
    for (const section of sections) {
      if (section.content.length < 100) continue;
      
      // Only extract relationships from sections that mention at least 2 known entities
      const sectionLower = section.content.toLowerCase();
      const mentionedEntities = entityNames.filter(name => 
        sectionLower.includes(name.toLowerCase())
      );
      
      if (mentionedEntities.length < 2) continue;

      try {
        const rels = await extractRelationshipsFromText(
          section.content,
          mentionedEntities.slice(0, 30), // Don't overwhelm prompt with too many entities
          `${file.filename}:${section.heading}`
        );
        allRelationships.push(...rels);
        
        if (rels.length > 0) {
          console.log(`[LLM-INGEST]   ${file.filename}:${section.heading.substring(0, 30)}: ${rels.length} relationships`);
        }
      } catch (err) {
        result.errors.push(`[rels:${file.filename}:${section.heading}] ${(err as Error).message}`);
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Step 6: Deduplicate and write relationships
  console.log(`[LLM-INGEST] Raw relationships: ${allRelationships.length}. Deduplicating...`);
  allRelationships = deduplicateRelationships(allRelationships);
  console.log(`[LLM-INGEST] After dedup: ${allRelationships.length} unique relationships`);

  for (const rel of allRelationships) {
    try {
      const sourceId = nodeIdMap.get(rel.source) || await findNodeByName(rel.source);
      const targetId = nodeIdMap.get(rel.target) || await findNodeByName(rel.target);
      
      if (!sourceId || !targetId) {
        result.edgesSkipped++;
        continue;
      }

      await createEdge({
        source_id: sourceId,
        target_id: targetId,
        relationship: rel.relationship,
        category: rel.category,
        strength: rel.strength,
        confidence: 1.0,
        context: rel.context,
      });
      result.edgesCreated++;
    } catch (err) {
      result.edgesSkipped++;
    }
  }
  console.log(`[LLM-INGEST] Edges: ${result.edgesCreated} created, ${result.edgesSkipped} skipped`);

  // Step 7: Process daily files for episodes
  console.log(`[LLM-INGEST] Phase: Creating episodes from daily files...`);
  for (const file of files.filter(f => f.type === 'daily')) {
    const sections = parseIntoSections(file);
    for (const section of sections) {
      if (section.content.length > 100 && /[✅🚨🔥💰🧠📊⚔️💎🦅🪨🏗️🛡️🐦🔄📖💓⚠️🚫📱🕐🎬🔧]/.test(section.heading + section.content.substring(0, 50))) {
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
              extractTopics(section.content, allEntities),
              computeImportance(section),
              JSON.stringify({ start: { valence: 0, arousal: 0.3 }, trajectory: 'stable', end_state: { valence: 0.3, arousal: 0.3 } }),
              JSON.stringify({ type: 'informational', description: 'Logged in daily file', verified: true }),
            ]
          );
          result.episodesCreated++;
        } catch { /* duplicate or constraint */ }
      }
    }
  }
  console.log(`[LLM-INGEST] Episodes: ${result.episodesCreated} created`);

  // Step 8: Process lessons.md
  console.log(`[LLM-INGEST] Phase: Processing lessons...`);
  for (const file of files.filter(f => f.type === 'lesson')) {
    await ingestLessonsFile(file, result);
  }

  // Step 9: Generate embeddings (if requested)
  if (options.embeddings) {
    console.log(`[LLM-INGEST] Phase: Generating embeddings...`);
    await generateNodeEmbeddings(result);
    console.log(`[LLM-INGEST] Embeddings: ${result.embeddingsGenerated} generated`);
  }

  result.duration_ms = Date.now() - start;
  
  console.log(`\n[LLM-INGEST] === COMPLETE ===`);
  console.log(`  Files: ${result.filesProcessed}`);
  console.log(`  Sections: ${result.sectionsProcessed} (${result.sectionsExtracted} extracted)`);
  console.log(`  Nodes: ${result.nodesCreated} created, ${result.nodesSkipped} skipped`);
  console.log(`  Edges: ${result.edgesCreated} created, ${result.edgesSkipped} skipped`);
  console.log(`  Episodes: ${result.episodesCreated}`);
  console.log(`  Lessons: ${result.lessonsCreated}`);
  console.log(`  Embeddings: ${result.embeddingsGenerated}`);
  console.log(`  Errors: ${result.errors.length}`);
  console.log(`  Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
  
  return result;
}

// ============================================================
// HELPERS
// ============================================================

async function findNodeByName(nameOrAlias: string): Promise<string | null> {
  const res = await query(
    `SELECT id FROM semantic_nodes 
     WHERE name = $1 OR $1 = ANY(aliases)
     LIMIT 1`,
    [nameOrAlias]
  );
  return res.rows[0]?.id || null;
}

/**
 * Extract topics using known entity names (data-driven, not hardcoded keywords).
 */
function extractTopics(content: string, entities: ExtractedEntity[]): string[] {
  const topics: string[] = [];
  const lower = content.toLowerCase();
  
  for (const entity of entities) {
    if (lower.includes(entity.name.toLowerCase())) {
      topics.push(entity.name);
    }
    for (const alias of entity.aliases) {
      if (alias.length >= 3 && lower.includes(alias.toLowerCase())) {
        topics.push(entity.name);
        break;
      }
    }
  }
  
  return [...new Set(topics)].slice(0, 20); // Dedupe, cap at 20
}

function computeImportance(section: MemorySection): number {
  let score = 0.5;
  if (/[🚨💰💎🪨]/.test(section.heading)) score += 0.2;
  if (/[✅🔥🧠]/.test(section.heading)) score += 0.1;
  const content = section.content.toLowerCase();
  if (content.includes('critical') || content.includes('decision')) score += 0.1;
  if (content.includes('deployed') || content.includes('live')) score += 0.1;
  if (content.includes('covenant') || content.includes('partnership')) score += 0.15;
  if (section.content.length > 2000) score += 0.1;
  if (section.content.length > 5000) score += 0.1;
  return Math.min(1.0, score);
}

async function ingestLessonsFile(file: MarkdownFile, result: IngestResult): Promise<void> {
  const sections = parseIntoSections(file);
  
  for (const section of sections) {
    // More flexible lesson detection — look for numbered items, severity markers, or date patterns
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

async function generateNodeEmbeddings(result: IngestResult): Promise<void> {
  const nodes = await query(
    'SELECT id, name, type, context, significance, aliases, attributes FROM semantic_nodes WHERE embedding IS NULL'
  );

  if (nodes.rows.length === 0) {
    console.log('[LLM-INGEST] All nodes already have embeddings');
    return;
  }

  console.log(`[LLM-INGEST] Generating embeddings for ${nodes.rows.length} nodes...`);

  const texts: string[] = [];
  const ids: string[] = [];

  for (const node of nodes.rows) {
    const parts = [
      `${node.type}: ${node.name}`,
      node.aliases?.length ? `Also known as: ${node.aliases.join(', ')}` : '',
      node.context || '',
      node.significance || '',
    ].filter(Boolean);
    texts.push(parts.join('. '));
    ids.push(node.id);
  }

  const BATCH_SIZE = 50;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchIds = ids.slice(i, i + BATCH_SIZE);

    try {
      const embeddings = await embedBatch(batch);
      for (let j = 0; j < embeddings.length; j++) {
        const vec = `[${embeddings[j].embedding.join(',')}]`;
        await query('UPDATE semantic_nodes SET embedding = $1 WHERE id = $2', [vec, batchIds[j]]);
        result.embeddingsGenerated++;
      }
      console.log(`[LLM-INGEST] Embedded ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length} nodes`);
    } catch (err) {
      result.errors.push(`[embeddings batch ${i}] ${(err as Error).message}`);
    }
  }
}
