/**
 * LLM-Powered Entity & Relationship Extraction
 * 
 * Replaces hardcoded KNOWN_ENTITIES and KNOWN_RELATIONSHIPS with automatic
 * extraction from markdown files using a local LLM (Ollama qwen2.5-coder:32b).
 * 
 * The principle: given raw text, the LLM identifies entities, their types,
 * their relationships, and context. The graph builds itself from data.
 * 
 * Drop the DB, re-run ingestion, and the brain reproduces from markdown alone.
 */

import type { EntityType, RelationshipType, RelationshipCategory } from '../../types.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.LLM_EXTRACT_MODEL || 'claude-opus-4-6';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = 'qwen2.5-coder:32b';

// Use Anthropic (Opus) if API key available, otherwise fall back to Ollama
const USE_ANTHROPIC = !!ANTHROPIC_API_KEY;

// ============================================================
// TYPES
// ============================================================

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  aliases: string[];
  context: string;
  emotional_weight?: number;
}

export interface ExtractedRelationship {
  source: string;
  target: string;
  relationship: RelationshipType;
  category: RelationshipCategory;
  strength: number;
  context?: string;
}

interface ExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  errors: string[];
  duration_ms: number;
}

// ============================================================
// LLM CALLING
// ============================================================

async function callLLM(prompt: string, timeoutMs: number = 120000): Promise<string> {
  if (USE_ANTHROPIC) {
    return callAnthropic(prompt, timeoutMs);
  }
  return callOllama(prompt, timeoutMs);
}

async function callAnthropic(prompt: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${errText.substring(0, 200)}`);
    }

    const data = await res.json() as { content: Array<{ type: string; text: string }> };
    const text = data.content?.find(c => c.type === 'text')?.text;
    if (!text) throw new Error('No text content in Anthropic response');
    return text.trim();
  } catch (err) {
    clearTimeout(timeout);
    throw new Error(`Anthropic call failed: ${(err as Error).message}`);
  }
}

async function callOllama(prompt: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 4000 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const data = await res.json() as { response: string };
    return data.response.trim();
  } catch (err) {
    clearTimeout(timeout);
    throw new Error(`Ollama call failed: ${(err as Error).message}`);
  }
}

function parseJSON(raw: string): any {
  // Extract JSON from response (handle markdown fences, extra text)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // Try array
    const arrMatch = raw.match(/\[[\s\S]*\]/);
    if (!arrMatch) throw new Error('No JSON found in LLM response');
    return JSON.parse(arrMatch[0]);
  }
  return JSON.parse(jsonMatch[0]);
}

// ============================================================
// ENTITY EXTRACTION
// ============================================================

const ENTITY_PROMPT = `You are analyzing a markdown document section to extract structured knowledge.

TASK: Extract all named entities from the text below. For each entity, identify:
- name: The canonical name (proper case)
- type: One of: person, organization, project, tool, concept, place, decision
- aliases: Other names this entity goes by (array of strings)
- context: A 1-2 sentence description based ONLY on what the text says
- emotional_weight: 0.0-1.0 how emotionally significant this entity is (people=0.8, abstract concepts=0.3, tools=0.2)

RULES:
- Extract ONLY entities explicitly mentioned in the text
- Do NOT invent entities or context not present in the text
- Use the FULL PROPER NAME as the entity name (e.g., "John Smith" not just "John", "Acme Corporation" not just "Acme")
- Put abbreviations, nicknames, and short forms in the aliases array (e.g., name="John Smith", aliases=["John", "Smith"])
- If the same entity appears with different names in the text, create ONE entity with all variations as aliases
- For places, use the full location format: "City, State" (e.g., "San Francisco, CA" not just "Santa Cruz")
- For "type", use these definitions:
  - person: A named human being
  - organization: A company, firm, team, or institution
  - project: A software project, product, or app being built
  - tool: A technology, framework, library, or service used
  - concept: An idea, principle, rule, or strategy
  - place: A physical location
  - decision: A specific decision that was made

Return ONLY valid JSON (no markdown fences, no explanation):
{"entities": [{"name": "...", "type": "...", "aliases": [...], "context": "...", "emotional_weight": 0.0}]}

TEXT:
`;

const RELATIONSHIP_PROMPT = `You are analyzing text to extract relationships between known entities.

KNOWN ENTITIES (use ONLY these names as source/target):
ENTITY_LIST_PLACEHOLDER

TASK: Extract relationships between the entities above based on the text below.

For each relationship, identify:
- source: Entity name (must be from the known list above)
- target: Entity name (must be from the known list above)
- relationship: One of: works_for, works_with, owns, part_of, depends_on, located_in, values, influences, created_by, partner_of, responsible_for
- category: One of: relational, structural, functional, emotional, temporal, causal
- strength: 0.0-1.0 (current/active=0.8-1.0, past/weak=0.3-0.5, implied=0.5-0.7)
- context: Brief description of the relationship based on the text

RULES:
- ONLY use entity names from the known list above
- ONLY extract relationships explicitly stated or clearly implied in the text
- Do NOT invent relationships
- Use "temporal" category for past relationships (former employer, etc.)
- Use "emotional" category for values, beliefs, things someone cares about
- Strength reflects how CURRENT and ACTIVE the relationship is

Return ONLY valid JSON:
{"relationships": [{"source": "...", "target": "...", "relationship": "...", "category": "...", "strength": 0.0, "context": "..."}]}

TEXT:
`;

// ============================================================
// SECTION-LEVEL EXTRACTION
// ============================================================

/**
 * Extract entities from a single text section.
 * Batches sections to avoid overwhelming the LLM with too much text.
 */
export async function extractEntitiesFromText(text: string, sectionName: string = ''): Promise<ExtractedEntity[]> {
  // Anthropic can handle much more context than local models
  const maxChars = USE_ANTHROPIC ? 8000 : 3000;
  const truncated = text.substring(0, maxChars);
  const prompt = ENTITY_PROMPT + truncated;

  try {
    const raw = await callLLM(prompt, 90000);
    const parsed = parseJSON(raw);
    
    if (!parsed.entities || !Array.isArray(parsed.entities)) return [];
    
    // Validate and clean
    const validTypes = new Set(['person', 'organization', 'project', 'tool', 'concept', 'place', 'decision']);
    return parsed.entities
      .filter((e: any) => e.name && e.type && validTypes.has(e.type))
      .map((e: any) => ({
        name: String(e.name).trim(),
        type: e.type as EntityType,
        aliases: Array.isArray(e.aliases) ? e.aliases.map((a: any) => String(a).trim()).filter(Boolean) : [],
        context: String(e.context || '').trim().substring(0, 500),
        emotional_weight: typeof e.emotional_weight === 'number' ? Math.min(1, Math.max(0, e.emotional_weight)) : 0.3,
      }));
  } catch (err) {
    console.warn(`[LLM-EXTRACT] Entity extraction failed for "${sectionName}": ${(err as Error).message}`);
    return [];
  }
}

/**
 * Extract relationships between known entities from text.
 */
export async function extractRelationshipsFromText(
  text: string,
  knownEntities: string[],
  sectionName: string = ''
): Promise<ExtractedRelationship[]> {
  if (knownEntities.length === 0) return [];
  
  const maxChars = USE_ANTHROPIC ? 8000 : 3000;
  const truncated = text.substring(0, maxChars);
  const entityList = knownEntities.map(e => `  - ${e}`).join('\n');
  const prompt = RELATIONSHIP_PROMPT
    .replace('ENTITY_LIST_PLACEHOLDER', entityList) + truncated;

  try {
    const raw = await callLLM(prompt, 90000);
    const parsed = parseJSON(raw);
    
    if (!parsed.relationships || !Array.isArray(parsed.relationships)) return [];
    
    const validRelTypes = new Set(['works_for', 'works_with', 'owns', 'part_of', 'depends_on', 'located_in', 'values', 'influences', 'created_by', 'partner_of', 'responsible_for']);
    const validCategories = new Set(['relational', 'structural', 'functional', 'emotional', 'temporal', 'causal']);
    const entitySet = new Set(knownEntities.map(e => e.toLowerCase()));
    
    return parsed.relationships
      .filter((r: any) => {
        if (!r.source || !r.target || !r.relationship) return false;
        if (!validRelTypes.has(r.relationship)) return false;
        // Source and target must be known entities (case-insensitive match)
        if (!entitySet.has(String(r.source).toLowerCase()) && !knownEntities.includes(r.source)) return false;
        if (!entitySet.has(String(r.target).toLowerCase()) && !knownEntities.includes(r.target)) return false;
        return true;
      })
      .map((r: any) => ({
        source: matchEntityName(r.source, knownEntities),
        target: matchEntityName(r.target, knownEntities),
        relationship: r.relationship as RelationshipType,
        category: (validCategories.has(r.category) ? r.category : 'relational') as RelationshipCategory,
        strength: typeof r.strength === 'number' ? Math.min(1, Math.max(0.1, r.strength)) : 0.5,
        context: r.context ? String(r.context).trim().substring(0, 300) : undefined,
      }));
  } catch (err) {
    console.warn(`[LLM-EXTRACT] Relationship extraction failed for "${sectionName}": ${(err as Error).message}`);
    return [];
  }
}

/**
 * Match a potentially misspelled entity name to the closest known entity.
 */
function matchEntityName(input: string, knownEntities: string[]): string {
  const lower = input.toLowerCase().trim();
  // Exact match
  const exact = knownEntities.find(e => e.toLowerCase() === lower);
  if (exact) return exact;
  // Partial match (contains)
  const partial = knownEntities.find(e => e.toLowerCase().includes(lower) || lower.includes(e.toLowerCase()));
  if (partial) return partial;
  // Return as-is (will be filtered out during edge creation if no node exists)
  return input.trim();
}

// ============================================================
// DEDUPLICATION
// ============================================================

/**
 * Merge duplicate entities extracted from multiple sections.
 * Keeps the version with the richest context and merges aliases.
 */
export function deduplicateEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const map = new Map<string, ExtractedEntity>();
  
  for (const entity of entities) {
    const key = entity.name.toLowerCase();
    
    // Check if this entity is a short form of an existing one (or vice versa)
    let mergeTarget: string | null = null;
    for (const [existingKey, existing] of map) {
      // Check: is this name a substring of an existing name? (e.g., "John" in "John Smith")
      if (existingKey.includes(key) || key.includes(existingKey)) {
        mergeTarget = existingKey;
        break;
      }
      // Check: is this name in an existing entity's aliases?
      if (existing.aliases.some(a => a.toLowerCase() === key)) {
        mergeTarget = existingKey;
        break;
      }
      // Check: is an existing entity's name in this entity's aliases?
      if (entity.aliases.some(a => a.toLowerCase() === existingKey)) {
        mergeTarget = existingKey;
        break;
      }
    }
    
    if (mergeTarget) {
      const existing = map.get(mergeTarget)!;
      // Keep the LONGER name as canonical (e.g., "John Smith" over "John")
      if (entity.name.length > existing.name.length) {
        // New name is more specific — swap
        const oldName = existing.name;
        existing.name = entity.name;
        existing.aliases.push(oldName);
      } else {
        existing.aliases.push(entity.name);
      }
      // Merge context, aliases, weight
      if (entity.context.length > existing.context.length) {
        existing.context = entity.context;
      }
      const allAliases = new Set([...existing.aliases, ...entity.aliases]);
      // Remove the canonical name from aliases
      allAliases.delete(existing.name);
      allAliases.delete(existing.name.toLowerCase());
      existing.aliases = [...allAliases];
      existing.emotional_weight = Math.max(
        existing.emotional_weight || 0,
        entity.emotional_weight || 0
      );
      
      // Re-key with the longer name
      if (existing.name.toLowerCase() !== mergeTarget) {
        map.delete(mergeTarget);
        map.set(existing.name.toLowerCase(), existing);
      }
    } else {
      map.set(key, { ...entity });
    }
  }
  
  return [...map.values()];
}

/**
 * Merge duplicate relationships.
 * Keeps the strongest version and longest context.
 */
export function deduplicateRelationships(rels: ExtractedRelationship[]): ExtractedRelationship[] {
  const map = new Map<string, ExtractedRelationship>();
  
  for (const rel of rels) {
    const key = `${rel.source.toLowerCase()}|${rel.target.toLowerCase()}|${rel.relationship}`;
    const existing = map.get(key);
    
    if (!existing) {
      map.set(key, { ...rel });
    } else {
      // Keep highest strength, longest context
      if (rel.strength > existing.strength) existing.strength = rel.strength;
      if (rel.context && (!existing.context || rel.context.length > existing.context.length)) {
        existing.context = rel.context;
      }
    }
  }
  
  return [...map.values()];
}
