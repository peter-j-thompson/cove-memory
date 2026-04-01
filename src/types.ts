/**
 * OpenMemory — Core Type Definitions
 * 
 * These types define the multi-layer memory architecture.
 * Every type encodes MEANING, not just data.
 * 
 * OpenMemory — cognitive layer types.
 */

// ============================================================
// SENSORY BUFFER — Working Memory
// ============================================================

export type InputSource = 'user_message' | 'tool_output' | 'system_event' | 'file_change' | 'external';
export type ContentType = 'text' | 'image' | 'audio_transcript' | 'structured_data';
export type IntentType = 'request_action' | 'share_info' | 'seek_advice' | 'emotional_processing' | 'casual_chat' | 'celebrate' | 'vent' | 'decide';
export type EmotionCategory = 'frustrated' | 'excited' | 'reflective' | 'anxious' | 'celebratory' | 'neutral' | 'grateful' | 'determined' | 'vulnerable' | 'playful' | 'concerned';

export interface SensoryInput {
  id: string;
  timestamp: string;
  source: InputSource;
  channel: string;
  raw_content: string;
  content_type: ContentType;
}

export interface SentimentScore {
  valence: number;       // -1.0 (very negative) to 1.0 (very positive)
  arousal: number;       // 0.0 (calm) to 1.0 (intense)
  category: EmotionCategory;
}

export interface Intent {
  primary: IntentType;
  confidence: number;
}

export interface EntityReference {
  name: string;
  type: string;
  graph_node_id?: string;  // link to semantic memory if exists
}

export interface ProcessedInput extends SensoryInput {
  entities: EntityReference[];
  sentiment: SentimentScore;
  intent: Intent;
  topics: string[];
  urgency: number;          // 0.0 to 1.0
  emotional_valence: number;
  importance_hint: number;  // 0.0 to 1.0
}

// ============================================================
// EPISODIC MEMORY — Specific Experiences
// ============================================================

export interface EmotionPoint {
  valence: number;
  arousal: number;
  label: string;  // human-readable: 'breakthrough_joy', 'quiet_frustration'
}

export interface EmotionalArc {
  start: EmotionPoint;
  trajectory: 'ascending' | 'descending' | 'volatile' | 'stable' | 'recovery';
  end: EmotionPoint;
}

export interface Lesson {
  id: string;
  statement: string;
  learned_from: string;  // episode id
  severity: 'critical' | 'important' | 'minor';
  prevention_rule: string;
  times_reinforced: number;
}

export interface Decision {
  description: string;
  rationale: string;
  alternatives_considered: string[];
  decided_by: string;
}

export interface Commitment {
  description: string;
  owner: string;
  deadline: string | null;
  status: 'pending' | 'completed' | 'abandoned';
}

export type EpisodeOutcomeType = 'success' | 'failure' | 'partial' | 'deferred' | 'informational' | 'emotional_resolution';

export interface EpisodeOutcome {
  type: EpisodeOutcomeType;
  description: string;
  verified: boolean;
}

export interface Episode {
  id: string;
  created_at: string;
  session_id: string;

  // Core content
  summary: string;
  detailed_narrative: string;
  raw_turn_refs: string[];

  // Participants
  participants: string[];
  initiator: string;

  // Emotional encoding
  emotional_arc: EmotionalArc;
  peak_emotion: EmotionPoint;
  resolution_emotion: EmotionPoint;

  // Outcome & meaning
  outcome: EpisodeOutcome;
  lessons: Lesson[];
  decisions: Decision[];
  commitments: Commitment[];

  // Connections
  related_episode_ids: string[];
  related_entity_ids: string[];
  topics: string[];

  // Consolidation metadata
  importance_score: number;
  access_count: number;
  last_accessed: string;
  consolidated_into: string | null;
  decay_protected: boolean;
}

// ============================================================
// SEMANTIC MEMORY — Facts and Knowledge
// ============================================================

export type EntityType = 'person' | 'project' | 'organization' | 'concept' | 'tool' | 'place' | 'event' | 'skill' | 'value' | 'belief' | 'document' | 'decision';

export interface AttributeValue {
  value: unknown;
  confidence: number;
  source: string;        // episode id or 'direct_input'
  timestamp: string;
  temporal: boolean;
  valid_from: string | null;
  valid_until: string | null;
  superseded_by: string | null;
}

export interface Contradiction {
  attribute: string;
  old_value: unknown;
  new_value: unknown;
  detected_at: string;
  resolution: 'accepted_new' | 'kept_old' | 'unresolved' | 'both_valid_in_context';
  resolution_rationale: string;
}

export interface SemanticNode {
  id: string;
  type: EntityType;
  name: string;
  aliases: string[];
  attributes: Record<string, AttributeValue>;

  // Provenance
  source_episodes: string[];
  first_learned: string;
  last_verified: string;
  last_modified: string;

  // Confidence
  confidence: number;
  confidence_basis: 'stated' | 'observed' | 'inferred' | 'assumed';
  contradictions: Contradiction[];

  // Meaning layer
  context: string;          // narrative WHY and MEANING
  emotional_weight: number; // -1.0 to 1.0
  significance: string;     // why this matters

  // Embedding
  embedding?: number[];
}

// ============================================================
// SEMANTIC EDGES — How Facts Connect
// ============================================================

export type RelationshipCategory = 'structural' | 'relational' | 'causal' | 'temporal' | 'emotional' | 'functional' | 'epistemic';

export type RelationshipType =
  // Structural
  | 'is_a' | 'instance_of' | 'part_of' | 'contains' | 'version_of' | 'located_in'
  // Relational
  | 'partner_of' | 'works_for' | 'works_with' | 'created_by' | 'owns' | 'trusts'
  // Causal
  | 'caused_by' | 'influenced_by' | 'influences' | 'led_to' | 'enabled_by' | 'blocked_by' | 'resolved_by'
  // Temporal
  | 'preceded_by' | 'followed_by' | 'concurrent_with' | 'evolved_into' | 'superseded_by'
  // Emotional
  | 'feels_about' | 'values' | 'struggles_with' | 'inspired_by' | 'frustrated_by' | 'grateful_for'
  // Functional
  | 'used_for' | 'skilled_at' | 'responsible_for' | 'deployed_to' | 'depends_on'
  // Epistemic
  | 'learned_from' | 'contradicts' | 'supports' | 'inferred_from' | 'uncertain_about';

export interface SemanticEdge {
  id: string;
  source_id: string;
  target_id: string;
  relationship: RelationshipType;
  category: RelationshipCategory;
  strength: number;         // 0.0 to 1.0
  confidence: number;
  temporal: boolean;
  valid_from: string | null;
  valid_until: string | null;
  context: string;          // why this relationship matters
  emotional_weight: number;
  source_episodes: string[];
  established: string;
  last_verified: string;
}

// ============================================================
// PROCEDURAL MEMORY — Skills and Patterns
// ============================================================

export interface ProcedureTrigger {
  conditions: string[];     // natural language conditions
  entity_types?: EntityType[];
  emotion_range?: { min_valence: number; max_valence: number };
  keywords?: string[];
}

export interface ProcedureStep {
  order: number;
  action: string;
  rationale: string;        // WHY this step
  conditional?: string;     // only execute if...
}

export interface Procedure {
  id: string;
  name: string;
  type: 'technical' | 'social' | 'cognitive' | 'creative';
  trigger: ProcedureTrigger;
  steps: ProcedureStep[];
  execution_count: number;
  success_count: number;
  success_rate: number;
  last_executed: string;
  last_outcome: 'success' | 'failure' | 'partial';
  learned_from: string[];   // episode ids
  refined_from: string[];
  confidence: number;
  minimum_samples: number;
}

// ============================================================
// RELATIONAL MEMORY — Understanding Specific Humans
// ============================================================

export interface TrustVector {
  ability: number;          // 0.0 to 1.0 — can they do what they say?
  benevolence: number;      // 0.0 to 1.0 — do they have my interests at heart?
  integrity: number;        // 0.0 to 1.0 — are they consistent and honest?
  composite: number;        // weighted average
}

export interface CommunicationProfile {
  preferred_style: string;  // 'direct' | 'diplomatic' | 'technical' | 'casual'
  response_preference: string; // 'brief' | 'detailed' | 'options' | 'just_do_it'
  humor_style: string;
  stress_indicators: string[];
  preferred_channels: string[];
}

export interface PersonModel {
  id: string;
  name: string;
  relationship_type: string;   // 'partner' | 'client' | 'collaborator' | 'family'
  
  // Communication
  communication: CommunicationProfile;
  
  // Trust (bidirectional)
  trust_from_me: TrustVector;     // how much I trust them
  trust_from_them: TrustVector;   // how much they trust me (estimated)
  
  // Values and preferences
  core_values: string[];
  known_preferences: Record<string, string>;
  known_frustrations: string[];
  known_motivations: string[];
  
  // Emotional patterns
  emotional_baseline: EmotionPoint;
  emotional_triggers: Array<{ trigger: string; response: string }>;
  
  // History
  relationship_started: string;
  milestone_episodes: string[];
  total_interactions: number;
  last_interaction: string;
  
  // Semantic node link
  semantic_node_id: string;
}

// ============================================================
// IDENTITY LAYER — Self-Model
// ============================================================

export interface GrowthEdge {
  name: string;
  description: string;
  first_identified: string;
  episodes_demonstrating: string[];
  improvement_trend: 'improving' | 'stable' | 'regressing' | 'new';
}

export interface IdentityModel {
  name: string;
  core_values: string[];
  beliefs: string[];
  purpose: string;
  growth_edges: GrowthEdge[];
  strengths: string[];
  voice_description: string;
  
  // Relationship to source files
  soul_file: string;       // path to SOUL.md
  identity_file: string;   // path to IDENTITY.md
  last_synced: string;
  
  // Evolution tracking
  identity_changes: Array<{
    date: string;
    what_changed: string;
    why: string;
    approved_by: string;  // human or self
  }>;
}

// ============================================================
// META-MEMORY — Knowing What You Know
// ============================================================

export interface ConfidenceAssessment {
  memory_id: string;
  memory_type: 'episode' | 'semantic' | 'procedure' | 'relational';
  confidence: number;
  basis: 'direct_experience' | 'told_by_trusted' | 'inferred' | 'assumed' | 'outdated';
  last_verified: string;
  staleness_days: number;
  needs_reverification: boolean;
}

export interface KnowledgeGap {
  topic: string;
  what_i_dont_know: string;
  why_it_matters: string;
  how_to_fill: string;
  priority: 'high' | 'medium' | 'low';
}

// ============================================================
// CONSOLIDATION — Memory Processing
// ============================================================

export type ConsolidationMode = 'realtime' | 'session_end' | 'daily' | 'weekly' | 'monthly';

export interface ConsolidationResult {
  mode: ConsolidationMode;
  timestamp: string;
  episodes_processed: number;
  facts_extracted: number;
  facts_updated: number;
  lessons_identified: number;
  procedures_refined: number;
  memories_pruned: number;
  contradictions_found: number;
  identity_updates: number;
}

// ============================================================
// RETRIEVAL — Multi-Layer Query
// ============================================================

export interface MemoryQuery {
  text: string;
  context: {
    current_emotion?: SentimentScore;
    current_intent?: IntentType;
    current_person?: string;
    recent_entities?: string[];
    recent_topics?: string[];
  };
  filters?: {
    memory_types?: Array<'episode' | 'semantic' | 'procedure' | 'relational'>;
    time_range?: { from: string; to: string };
    min_importance?: number;
    min_confidence?: number;
    person?: string;
  };
  limit?: number;
}

export interface MemoryResult {
  id: string;
  memory_type: 'episode' | 'semantic' | 'procedure' | 'relational' | 'identity' | 'lesson';
  content: string;         // human-readable summary
  relevance_score: number; // composite score
  scores: {
    semantic_similarity: number;
    ontological_distance: number;
    emotional_resonance: number;
    recency: number;
    importance: number;
  };
  source: Episode | SemanticNode | Procedure | PersonModel | Lesson;
}
