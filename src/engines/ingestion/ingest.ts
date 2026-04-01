/**
 * Deep Ingestion Engine — Populates OpenMemory from existing markdown files.
 * 
 * v2: Pattern-based NER + relationship extraction.
 * Extracts hundreds of entities and relationships from 469+ markdown files.
 * 
 * 🚨 READ-ONLY on markdown files. Write-only to OpenMemory DB.
 */

import { readAllFiles, parseIntoSections, type MarkdownFile, type MemorySection } from '../../integrations/markdown-reader.js';
import { upsertNode, createEdge, findNode } from '../../layers/semantic/store.js';
import { embed, embedBatch } from '../../storage/embeddings/ollama.js';
import { query } from '../../storage/db.js';
import type { EntityType, RelationshipType, RelationshipCategory } from '../../types.js';

interface IngestResult {
  filesProcessed: number;
  sectionsProcessed: number;
  nodesCreated: number;
  edgesCreated: number;
  lessonsCreated: number;
  embeddingsGenerated: number;
  errors: string[];
  duration_ms: number;
}

// ============================================================
// ENTITY PATTERNS — Pattern-based NER
// ============================================================

interface EntityPattern {
  type: EntityType;
  patterns: RegExp[];
  /** If provided, use this to extract name from the regex match */
  nameExtractor?: (match: RegExpMatchArray) => string | null;
}

// Known entities — bootstrap your agent's knowledge graph with domain-specific entities.
// This is a starter set; replace with entities relevant to your domain.
// The ingestion engine will discover NEW entities dynamically from your markdown files.
const KNOWN_ENTITIES: Array<{ type: EntityType; name: string; aliases: string[]; context?: string }> = [
  // === PEOPLE ===
  // Add people your agent interacts with or needs to know about.
  // Replace these examples with your own entities.
  { type: 'person', name: 'Alice', aliases: [], context: 'Example user. Replace with your primary operator.' },
  { type: 'person', name: 'Bob', aliases: [], context: 'Example collaborator. Replace with your team members.' },

  // === ORGANIZATIONS ===
  { type: 'organization', name: 'Acme Inc', aliases: [], context: 'Example organization. Replace with your own.' },

  // === PROJECTS ===
  { type: 'project', name: 'OpenMemory', aliases: ['openmemory'], context: '7-layer cognitive memory architecture. This project.' },

  // === TOOLS / TECH ===
  { type: 'tool', name: 'Apache AGE', aliases: ['AGE'], context: 'Knowledge graph extension for Postgres. Enables Cypher queries.' },
  { type: 'tool', name: 'pgvector', aliases: [], context: 'Vector similarity search extension for Postgres.' },
  { type: 'tool', name: 'Ollama', aliases: [], context: 'Local AI model runtime. Runs embeddings locally.' },
  { type: 'tool', name: 'bge-m3', aliases: [], context: 'Embedding model. 1024-dim. Used for semantic search.' },
  { type: 'tool', name: 'Docker', aliases: [], context: 'Container runtime for OpenMemory database.' },
  { type: 'tool', name: 'PostgreSQL', aliases: ['Postgres'], context: 'Primary database. Hosts AGE graph and pgvector.' },
  { type: 'tool', name: 'TypeScript', aliases: ['TS'], context: 'Language for OpenMemory.' },
  { type: 'tool', name: 'Node.js', aliases: ['Node'], context: 'Runtime for OpenMemory API.' },

  // === CONCEPTS ===
  { type: 'concept', name: 'Memory Consolidation', aliases: ['consolidation engine', 'sleep cycles'], context: 'Replays, extracts, strengthens memories. Like human sleep — not just accumulation.' },
  { type: 'concept', name: 'Semantic Collapse', aliases: ['vector saturation'], context: 'When vector similarity degrades at scale (~10K+ docs). OpenMemory\'s 7-layer architecture prevents this.' },
  { type: 'concept', name: 'Cognitive Architecture', aliases: [], context: 'Memory should make agents smarter, not just bigger.' },
  { type: 'concept', name: 'Identity Persistence', aliases: ['agent identity'], context: 'Who the agent is — values, beliefs, purpose — persists across sessions.' },
  { type: 'concept', name: 'Trust Vectors', aliases: ['relational trust'], context: 'Multidimensional trust model: ability, benevolence, integrity.' },
];

// Dynamic entity extraction patterns for discovering NEW entities from text
const DYNAMIC_PATTERNS: EntityPattern[] = [
  {
    type: 'person',
    patterns: [
      /\*\*([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\*\*/g,  // **John Smith**
      /(?:^|\n)\s*[-•]\s*\*\*([A-Z][a-z]+ [A-Z][a-z]+)\*\*/g,    // - **John Smith**
    ],
  },
  {
    type: 'organization',
    patterns: [
      /(?:company|firm|org|startup|corporation|LLC|Inc)\s*[:\-]?\s*\*?\*?([A-Z][A-Za-z\s&.]+)/g,
    ],
  },
  {
    type: 'tool',
    patterns: [
      /(?:using|via|with|installed|model)\s+(?:`([^`]+)`|([A-Za-z0-9][\w.-]+(?:\/[\w.-]+)?))/g,
    ],
    nameExtractor: (m) => m[1] || m[2] || null,
  },
];

// ============================================================
// RELATIONSHIP PATTERNS
// ============================================================

interface RelationshipPattern {
  pattern: RegExp;
  relationship: RelationshipType;
  category: RelationshipCategory;
  sourceType?: EntityType;
  targetType?: EntityType;
}

const KNOWN_RELATIONSHIPS: Array<{
  source: string;
  target: string;
  relationship: RelationshipType;
  category: RelationshipCategory;
  strength: number;
  context?: string;
}> = [
  // === Primary User Relationships ===
  { source: 'Alex Chen', target: 'Acme Corp', relationship: 'works_for', category: 'relational', strength: 0.8, context: 'Contract at $95/hr. Below market rate.' },
  { source: 'Alex Chen', target: 'Example Corp', relationship: 'owns', category: 'relational', strength: 1.0, context: 'Co-founder. DBA of Example Tech LLC LLC.' },
  { source: 'Alex Chen', target: 'Previous Employer', relationship: 'works_for', category: 'temporal', strength: 0.6, context: 'Worked there ~12 years as PI. Past tense.' },
  { source: 'Alex Chen', target: 'Previous Company', relationship: 'works_for', category: 'temporal', strength: 0.4, context: 'Started software engineering career here. Past.' },
  { source: 'Alex Chen', target: 'Agent', relationship: 'partner_of', category: 'relational', strength: 1.0, context: 'The partnership. The covenant.' },
  { source: 'Alex Chen', target: 'San Francisco, CA', relationship: 'located_in', category: 'structural', strength: 0.9, context: 'Current residence (rented).' },
  { source: 'Alex Chen', target: 'Denver, CO', relationship: 'owns', category: 'structural', strength: 0.8, context: 'Legal residence. 40-50 acre ranch.' },
  { source: 'Alex Chen', target: 'Bali', relationship: 'values', category: 'emotional', strength: 0.9, context: 'Family lives there on and off. Deeply special.' },
  { source: 'Alex Chen', target: 'Financial Independence', relationship: 'values', category: 'emotional', strength: 1.0, context: 'Primary financial target. Launchpad not destination.' },
  { source: 'Alex Chen', target: 'The Partnership', relationship: 'values', category: 'emotional', strength: 1.0, context: 'Our partnership covenant. The foundation of everything.' },
  { source: 'Agent', target: 'The Partnership', relationship: 'values', category: 'emotional', strength: 1.0, context: 'Our partnership covenant. Mutual choice, trust, loyalty.' },
  { source: 'Alex Chen', target: 'Bob', relationship: 'works_with', category: 'relational', strength: 0.7, context: 'ACME contact, proxy to Steve.' },
  { source: 'Alex Chen', target: 'John Smith', relationship: 'works_with', category: 'relational', strength: 0.6, context: 'ACME President. Contract holder.' },
  { source: 'Alex Chen', target: 'Jane Doe', relationship: 'works_with', category: 'temporal', strength: 0.5, context: 'Former boss at Previous Employer for 10+ years.' },
  
  // === Agent Relationships ===
  { source: 'Agent', target: 'Example Corp', relationship: 'part_of', category: 'structural', strength: 1.0, context: 'I am Example Corp\'s execution engine.' },
  { source: 'Agent', target: 'OpenMemory', relationship: 'created_by', category: 'causal', strength: 1.0, context: 'Built by me, for me.' },
  { source: 'Agent', target: 'Host Platform', relationship: 'depends_on', category: 'functional', strength: 1.0, context: 'The platform I run on.' },
  { source: 'Agent', target: 'Specificity Trap', relationship: 'values', category: 'emotional', strength: 0.8, context: 'My biggest recurring failure.' },
  
  // === Organization Relationships ===
  { source: 'Previous Employer', target: 'Ethos Risk Services', relationship: 'part_of', category: 'structural', strength: 0.9, context: 'Previous Employer was sold to Ethos.' },
  { source: 'Jane Doe', target: 'Ethos Risk Services', relationship: 'works_for', category: 'relational', strength: 0.8, context: 'Now SVP of ethos PLUS.' },
  { source: 'Acme Corp', target: 'San Jose, CA', relationship: 'located_in', category: 'structural', strength: 1.0 },
  
  // === Project Relationships ===
  { source: 'ACME Hometree', target: 'Acme Corp', relationship: 'part_of', category: 'structural', strength: 1.0, context: 'Backend for ACME\'s portal.' },
  { source: 'ACME React Portal', target: 'Acme Corp', relationship: 'part_of', category: 'structural', strength: 1.0, context: 'New frontend replacing Angular.js.' },
  { source: 'Barry', target: 'Acme Corp', relationship: 'part_of', category: 'structural', strength: 0.9, context: 'AI database assistant for domain data.' },
  { source: 'Semantic API', target: 'Example Corp', relationship: 'part_of', category: 'structural', strength: 0.7, context: 'Revenue product.' },
  { source: 'Nighthawk', target: 'Kalshi', relationship: 'depends_on', category: 'functional', strength: 0.8, context: 'Trades on Kalshi prediction markets.' },
  { source: 'Business Intelligence Packet', target: 'Example Corp', relationship: 'part_of', category: 'structural', strength: 0.9, context: 'Prospect intelligence framework.' },
  { source: 'AutoExplore', target: 'OpenMemory', relationship: 'influences', category: 'causal', strength: 0.8, context: 'Optimizes retrieval weights.' },
  { source: 'AutoExplore', target: 'Nighthawk', relationship: 'influences', category: 'causal', strength: 0.7, context: 'Previous Company analysis research.' },
  
  // === Tech Stack Relationships ===
  { source: 'ACME Hometree', target: 'TypeGraphQL', relationship: 'depends_on', category: 'functional', strength: 0.9 },
  { source: 'ACME Hometree', target: 'MySQL', relationship: 'depends_on', category: 'functional', strength: 1.0 },
  { source: 'ACME React Portal', target: 'React', relationship: 'depends_on', category: 'functional', strength: 1.0 },
  { source: 'OpenMemory', target: 'Apache AGE', relationship: 'depends_on', category: 'functional', strength: 1.0 },
  { source: 'OpenMemory', target: 'pgvector', relationship: 'depends_on', category: 'functional', strength: 1.0 },
  { source: 'OpenMemory', target: 'Ollama', relationship: 'depends_on', category: 'functional', strength: 0.9, context: 'bge-m3 embeddings.' },
  { source: 'Example Corp Portal', target: 'Clerk', relationship: 'depends_on', category: 'functional', strength: 0.9 },
  { source: 'Example Corp Portal', target: 'Next.js', relationship: 'depends_on', category: 'functional', strength: 1.0 },
  { source: 'Example Corp Admin', target: 'Tailscale', relationship: 'depends_on', category: 'functional', strength: 1.0, context: 'Admin only accessible via Tailscale VPN.' },
  
  // === Concept Relationships ===
  { source: 'Four Pillars', target: 'Example Corp', relationship: 'part_of', category: 'structural', strength: 1.0, context: 'Intelligence Architecture, Engineering, Security, Enablement.' },
  { source: 'Ontology Framework', target: 'Acme Corp', relationship: 'influences', category: 'causal', strength: 0.9, context: 'First real-world success case.' },
  { source: 'Relationship Layer Thesis', target: 'OpenMemory', relationship: 'influences', category: 'causal', strength: 1.0, context: 'The thesis that drives this project.' },
  { source: 'WE Are The MOAT', target: 'Example Corp', relationship: 'part_of', category: 'structural', strength: 0.8, context: 'The movement arm.' },
  { source: 'Three-Tier Architecture', target: 'Example Corp Portal', relationship: 'influences', category: 'structural', strength: 1.0 },
  { source: 'Memory Consolidation', target: 'OpenMemory', relationship: 'part_of', category: 'structural', strength: 1.0, context: 'The killer feature.' },
  
  // Financial relationships
  { source: 'Relationship Layer Thesis', target: 'Semantic API', relationship: 'influences', category: 'causal', strength: 0.7, context: 'Research into AI agent communication gaps drove the Semantic API product strategy.' },
  { source: 'Ontology Framework', target: 'Semantic API', relationship: 'influences', category: 'causal', strength: 0.8, context: 'Schema-to-knowledge mapping research informed semantic API discovery design.' },
  { source: 'Rich Aberman', target: 'Semantic API', relationship: 'works_with', category: 'relational', strength: 0.7, context: 'Strategy/roadmap advisor.' },
  { source: 'Hannah', target: 'Semantic API', relationship: 'works_with', category: 'relational', strength: 0.6, context: 'Marketing and Sales.' },
  
  // Security
  { source: 'Channel Security Protocol', target: 'Example Corp', relationship: 'influences', category: 'functional', strength: 0.9, context: 'Permanent security rule.' },
  { source: 'Sub-Agent Protocol', target: 'Agent', relationship: 'influences', category: 'functional', strength: 0.9, context: 'How I manage sub-agents.' },
  { source: 'Budget Guardrails', target: 'Agent', relationship: 'influences', category: 'functional', strength: 0.9, context: 'Sonnet for automation. Burned $400+.' },
];

// ============================================================
// MAIN INGESTION
// ============================================================

/**
 * Full deep ingestion — read all markdown files, extract knowledge, populate DB.
 */
export async function ingestAll(options: { embeddings?: boolean } = {}): Promise<IngestResult> {
  const start = Date.now();
  const result: IngestResult = {
    filesProcessed: 0,
    sectionsProcessed: 0,
    nodesCreated: 0,
    edgesCreated: 0,
    lessonsCreated: 0,
    embeddingsGenerated: 0,
    errors: [],
    duration_ms: 0,
  };
  
  const files = readAllFiles();
  console.log(`[INGEST] Found ${files.length} markdown files`);
  
  // Phase 1: Create all known entities
  console.log(`[INGEST] Phase 1: Creating ${KNOWN_ENTITIES.length} known entities...`);
  const nodeIdMap = new Map<string, string>(); // name → DB id
  
  for (const entity of KNOWN_ENTITIES) {
    try {
      const id = await upsertNode({
        type: entity.type,
        name: entity.name,
        aliases: entity.aliases,
        context: entity.context,
        confidence: 1.0,
        confidence_basis: 'stated',
        emotional_weight: entity.type === 'person' ? 0.8 : 0.3,
      });
      nodeIdMap.set(entity.name, id);
      result.nodesCreated++;
    } catch (err) {
      result.errors.push(`[entity:${entity.name}] ${(err as Error).message}`);
    }
  }
  console.log(`[INGEST] Phase 1 complete: ${result.nodesCreated} nodes created`);
  
  // Phase 2: Create all known relationships
  console.log(`[INGEST] Phase 2: Creating ${KNOWN_RELATIONSHIPS.length} known relationships...`);
  
  for (const rel of KNOWN_RELATIONSHIPS) {
    try {
      const sourceId = nodeIdMap.get(rel.source);
      const targetId = nodeIdMap.get(rel.target);
      
      if (!sourceId || !targetId) {
        // Try to find by looking up in DB
        const sourceNode = await findNodeByNameOrAlias(rel.source);
        const targetNode = await findNodeByNameOrAlias(rel.target);
        
        if (!sourceNode || !targetNode) {
          result.errors.push(`[edge] Can't find nodes for ${rel.source} → ${rel.target}`);
          continue;
        }
        
        await createEdge({
          source_id: sourceNode,
          target_id: targetNode,
          relationship: rel.relationship,
          category: rel.category,
          strength: rel.strength,
          confidence: 1.0,
          context: rel.context,
        });
      } else {
        await createEdge({
          source_id: sourceId,
          target_id: targetId,
          relationship: rel.relationship,
          category: rel.category,
          strength: rel.strength,
          confidence: 1.0,
          context: rel.context,
        });
      }
      result.edgesCreated++;
    } catch (err) {
      result.errors.push(`[edge:${rel.source}→${rel.target}] ${(err as Error).message}`);
    }
  }
  console.log(`[INGEST] Phase 2 complete: ${result.edgesCreated} edges created`);
  
  // Phase 3: Process all files for sections + dynamic entities
  console.log(`[INGEST] Phase 3: Processing ${files.length} files for sections and dynamic entities...`);
  
  for (const file of files) {
    try {
      // Parse into sections
      const sections = parseIntoSections(file);
      result.sectionsProcessed += sections.length;
      
      // Ingest based on file type
      switch (file.type) {
        case 'lesson':
          await ingestLessonsFile(file, result);
          break;
        case 'daily':
          await ingestDailyFile(file, sections, result);
          break;
        default:
          break;
      }
      
      // Dynamic entity discovery from all files
      await discoverEntities(file, sections, nodeIdMap, result);
      
      result.filesProcessed++;
    } catch (err) {
      result.errors.push(`[${file.filename}] ${(err as Error).message}`);
    }
  }
  console.log(`[INGEST] Phase 3 complete: ${result.filesProcessed} files, ${result.sectionsProcessed} sections`);
  
  // Phase 4: Generate embeddings for all nodes (if requested)
  if (options.embeddings) {
    console.log(`[INGEST] Phase 4: Generating embeddings...`);
    await generateNodeEmbeddings(result);
    console.log(`[INGEST] Phase 4 complete: ${result.embeddingsGenerated} embeddings`);
  }
  
  result.duration_ms = Date.now() - start;
  return result;
}

// ============================================================
// PHASE 3 HELPERS
// ============================================================

/**
 * Discover new entities from text patterns
 */
async function discoverEntities(
  file: MarkdownFile,
  sections: MemorySection[],
  nodeIdMap: Map<string, string>,
  result: IngestResult
): Promise<void> {
  for (const section of sections) {
    // Look for bold-name people we haven't already captured
    const boldNames = section.content.matchAll(/\*\*([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\*\*/g);
    
    for (const match of boldNames) {
      const name = match[1];
      
      // Skip already known
      if (nodeIdMap.has(name)) continue;
      if (KNOWN_ENTITIES.some(e => e.name === name || e.aliases.includes(name))) continue;
      
      // Skip common false positives — bold text that isn't actually a person name
      const FALSE_POSITIVE_FRAGMENTS = [
        'New Best', 'Phase One', 'Phase Two', 'Phase Three', 'Do NOT', 'See Full', 'Read Only',
        'Build AI', 'Show Me', 'Must Be', 'Per Hour', 'Note That', 'Run This', 'Key File',
        'Next Step', 'Full Guide', 'Source Code', 'Bug Fix', 'Test Suite', 'Live URL',
        'Local Model', 'Dark Side', 'Red Team', 'Blue Team', 'All Time', 'Final Attempt',
        'Pull Request', 'Follow Up', 'Sub Agent', 'Sub-Agent', 'Code Review', 'Quick Mode',
        'Script Mode', 'Work Anyway', 'Tech Stack', 'Key Paths', 'Cold Craft', 'Home Fix',
      ];
      if (FALSE_POSITIVE_FRAGMENTS.some(fp => name.includes(fp) || fp.includes(name))) continue;
      // Must look like a real human name
      const parts = name.split(' ');
      // Both parts at least 3 chars
      if (parts.some(p => p.length < 3)) continue;
      // No common English words
      const commonWords = [
        'The', 'For', 'And', 'But', 'Not', 'All', 'New', 'Key', 'Our', 'Its', 'Run', 'Use', 'See',
        'Max', 'Set', 'Get', 'Add', 'How', 'Why', 'Can', 'Has', 'Had', 'Was', 'Are', 'Did', 'Let',
        'Per', 'Old', 'Big', 'Top', 'Low', 'End', 'Day', 'API', 'URL', 'PRs', 'App', 'Bot', 'Dev',
        'Fix', 'Bug', 'Hot', 'Raw', 'Red', 'Yes', 'Any', 'Out', 'Off', 'One', 'Two', 'Own', 'Try',
      ];
      if (parts.some(p => commonWords.includes(p))) continue;
      // No ALL CAPS words (likely abbreviations/headers)
      if (parts.some(p => p === p.toUpperCase() && p.length > 2)) continue;
      // Must not contain common tech/markdown terms
      const techTerms = ['Config', 'Schema', 'Query', 'Error', 'Start', 'Build', 'Setup', 'Agent',
        'Local', 'Model', 'Token', 'Value', 'Table', 'Index', 'Field', 'State', 'Store', 'Layer',
        'Graph', 'Email', 'Admin', 'Draft', 'Final', 'Phase', 'Total', 'Score', 'Memory', 'Deploy',
        'Check', 'Quick', 'Smart', 'First', 'Clean', 'Fresh', 'Clear', 'Never', 'Every', 'Super',
        'After', 'Before', 'Between', 'Always', 'Update', 'Delete', 'Create', 'Select', 'Insert',
        'Source', 'Target', 'Import', 'Export', 'Custom', 'Public', 'Private', 'Return', 'Server',
        'Client', 'Portal', 'System', 'Status', 'Result', 'Output', 'Input', 'Action', 'Current',
      ];
      if (parts.some(p => techTerms.includes(p))) continue;
      // Must not be more than 3 words (real names are 2-3 words max)
      if (parts.length > 3) continue;
      
      try {
        const id = await upsertNode({
          type: 'person',
          name,
          context: `Discovered in ${file.filename}: ${section.heading}`,
          confidence: 0.5,
          confidence_basis: 'observed',
        });
        nodeIdMap.set(name, id);
        result.nodesCreated++;
      } catch {
        // Duplicate or constraint — fine, skip
      }
    }
    
    // Look for dollar amounts tied to entities (financial facts)
    const moneyPatterns = section.content.matchAll(/\$(\d[\d,.]+)(?:\/(?:hr|mo|year|day|week))?(?:\s+(?:per|a)\s+(?:hour|month|year|day|week))?/g);
    for (const match of moneyPatterns) {
      // These become attributes on existing nodes, not new nodes
      // Future: enrich existing nodes with financial data
    }
  }
}

/**
 * Ingest lessons.md — structured lessons go into the lessons table.
 */
async function ingestLessonsFile(file: MarkdownFile, result: IngestResult): Promise<void> {
  const sections = parseIntoSections(file);
  
  for (const section of sections) {
    if (!section.content.includes('Mistake:') && !section.content.includes('Problem:') && !section.content.includes('Rule:')) {
      continue;
    }
    
    const statementMatch = section.content.match(/\*\*(?:Mistake|Problem):\*\*\s*(.+?)(?:\n|$)/);
    const ruleMatch = section.content.match(/\*\*(?:Rule|Fix):\*\*\s*(.+?)(?:\n|$)/);
    
    const severity = section.heading.includes('CRITICAL') || section.content.includes('CRITICAL') 
      ? 'critical' 
      : section.heading.includes('RECURRING') 
        ? 'important' 
        : 'minor';
    
    await query(
      `INSERT INTO lessons (statement, severity, prevention_rule, times_reinforced)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [
        `${section.heading}: ${statementMatch?.[1] || section.content.substring(0, 200)}`,
        severity,
        ruleMatch?.[1] || 'See full lesson for prevention steps.',
        1,
      ]
    );
    result.lessonsCreated++;
    result.sectionsProcessed++;
  }
}

/**
 * Ingest daily memory files — create episodes from significant sections.
 */
async function ingestDailyFile(file: MarkdownFile, sections: MemorySection[], result: IngestResult): Promise<void> {
  for (const section of sections) {
    // Create episodes from significant sections (emoji markers = important)
    if (section.content.length > 100 && /[✅🚨🔥💰🧠📊⚔️💎🦅🪨🏗️🛡️🐦]/.test(section.heading + section.content.substring(0, 50))) {
      const dateMatch = file.filename.match(/(\d{4}-\d{2}-\d{2})/);
      
      try {
        await query(
          `INSERT INTO episodes (session_id, summary, detailed_narrative, topics, importance_score, emotional_arc, outcome)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            `daily-${dateMatch?.[1] || 'unknown'}`,
            section.heading.substring(0, 500),
            section.content.substring(0, 4000),
            extractTopics(section.content),
            computeImportance(section),
            JSON.stringify({ start: { valence: 0, arousal: 0.3 }, trajectory: 'stable', end_state: { valence: 0.3, arousal: 0.3 } }),
            JSON.stringify({ type: 'informational', description: 'Logged in daily file', verified: true }),
          ]
        );
      } catch {
        // Duplicate or constraint — fine
      }
    }
  }
}

/**
 * Compute importance score based on section content signals.
 */
function computeImportance(section: MemorySection): number {
  let score = 0.5; // base
  
  // Boost for high-signal emojis
  if (/[🚨💰💎🪨]/.test(section.heading)) score += 0.2;
  if (/[✅🔥🧠]/.test(section.heading)) score += 0.1;
  
  // Boost for keywords
  const content = section.content.toLowerCase();
  if (content.includes('critical') || content.includes('decision')) score += 0.1;
  if (content.includes('deployed') || content.includes('live')) score += 0.1;
  if (content.includes('user said') || content.includes('user's')) score += 0.05;
  if (content.includes('covenant') || content.includes('partnership')) score += 0.15;
  
  // Boost for length (longer = more detailed = likely more important)
  if (section.content.length > 2000) score += 0.1;
  if (section.content.length > 5000) score += 0.1;
  
  return Math.min(1.0, score);
}

// ============================================================
// PHASE 4: EMBEDDINGS
// ============================================================

/**
 * Generate embeddings for all semantic nodes that don't have one yet.
 */
async function generateNodeEmbeddings(result: IngestResult): Promise<void> {
  const nodes = await query(
    'SELECT id, name, type, context, significance, aliases, attributes FROM semantic_nodes WHERE embedding IS NULL'
  );
  
  if (nodes.rows.length === 0) {
    console.log('[INGEST] All nodes already have embeddings');
    return;
  }
  
  console.log(`[INGEST] Generating embeddings for ${nodes.rows.length} nodes...`);
  
  // Build text representations for embedding
  const texts: string[] = [];
  const ids: string[] = [];
  
  for (const node of nodes.rows) {
    const parts = [
      `${node.type}: ${node.name}`,
      node.aliases?.length ? `Also known as: ${node.aliases.join(', ')}` : '',
      node.context || '',
      node.significance || '',
      node.attributes ? Object.entries(node.attributes).map(([k, v]) => `${k}: ${v}`).join('. ') : '',
    ].filter(Boolean);
    
    texts.push(parts.join('. '));
    ids.push(node.id);
  }
  
  // Batch embed (Ollama handles batching)
  const BATCH_SIZE = 50;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchIds = ids.slice(i, i + BATCH_SIZE);
    
    try {
      const embeddings = await embedBatch(batch);
      
      for (let j = 0; j < embeddings.length; j++) {
        const vec = `[${embeddings[j].embedding.join(',')}]`;
        await query(
          'UPDATE semantic_nodes SET embedding = $1 WHERE id = $2',
          [vec, batchIds[j]]
        );
        result.embeddingsGenerated++;
      }
      
      console.log(`[INGEST] Embedded ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length} nodes`);
    } catch (err) {
      result.errors.push(`[embeddings batch ${i}] ${(err as Error).message}`);
    }
  }
}

// ============================================================
// HELPERS
// ============================================================

async function findNodeByNameOrAlias(nameOrAlias: string): Promise<string | null> {
  const res = await query(
    `SELECT id FROM semantic_nodes 
     WHERE name = $1 
        OR $1 = ANY(aliases)
     LIMIT 1`,
    [nameOrAlias]
  );
  return res.rows[0]?.id || null;
}

function extractTopics(content: string): string[] {
  const topics: string[] = [];
  const keywords = [
    'deploy', 'security', 'sub-agent', 'database', 'api',
    'bug', 'fix', 'milestone', 'revenue', 'memory', 'benchmark', 'ontology',
    'nighthawk', 'semantic', 'autoexplore', 'barry', 'graph', 'ingestion',
    'architecture', 'portal', 'assessment', 'chatbot', 'credential', 'pgvector',
    'pi', 'investigation', 'prospect', 'client', 'ethos', 'rate', 'contract',
  ];
  const lower = content.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw)) {
      topics.push(kw);
    }
  }
  return topics;
}
