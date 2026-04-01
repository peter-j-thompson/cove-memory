/**
 * Sensory Buffer — The Input Pipeline
 * 
 * Phase 2: Processes raw input into structured knowledge.
 * Every message, tool output, and event flows through here
 * before reaching any other memory layer.
 * 
 * Pipeline: Classify → Extract Entities → Detect Sentiment → Assess Urgency → Classify Intent → Route
 */

import type { SensoryInput, ProcessedInput, EntityType } from '../../types.js';

// ============================================================
// TYPES
// ============================================================

export type InputType = 'conversation' | 'tool_output' | 'system_event' | 'reflection';
export type Intent = 'inform' | 'request' | 'question' | 'decision' | 'feedback' | 'emotional' | 'directive';
export type SpecificEmotion = 'joy' | 'frustration' | 'gratitude' | 'concern' | 'excitement' | 'humor' | 'pride' | 'determination' | 'neutral';

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  isKnown: boolean;          // Matched an existing node
  matchedNodeId?: string;    // If known, the DB node ID
  confidence: number;
  context: string;           // Surrounding text that mentions this entity
}

export interface SentimentAnalysis {
  valence: number;           // -1.0 (negative) to 1.0 (positive)
  arousal: number;           // 0.0 (calm) to 1.0 (excited)
  emotions: SpecificEmotion[];
  dominantEmotion: SpecificEmotion;
}

export interface ProcessedMessage {
  // Raw input
  rawText: string;
  sender: string;
  timestamp: Date;
  sessionId?: string;
  
  // Stage 1: Classification
  inputType: InputType;
  
  // Stage 2: Entity extraction
  entities: ExtractedEntity[];
  factualClaims: string[];   // Dollar amounts, dates, metrics, etc.
  
  // Stage 3: Sentiment
  sentiment: SentimentAnalysis;
  
  // Stage 4: Urgency
  urgency: number;           // 0.0 to 1.0
  
  // Stage 5: Intent
  intent: Intent;
  
  // Stage 6: Routing targets
  routes: Array<'semantic' | 'episodic' | 'identity' | 'procedural' | 'relational'>;
  
  // Processing metadata
  processingTime_ms: number;
}

// ============================================================
// KNOWN ENTITY PATTERNS
// ============================================================

interface KnownEntityPattern {
  names: string[];           // Primary name + aliases
  type: EntityType;
  nodeId?: string;           // Will be populated from DB on init
}

// Core entities we always recognize (loaded from DB on init, but hardcoded as fallback)
// Example core entities — customize for your domain.
// These serve as fallback recognition when the DB hasn't been populated yet.
const CORE_ENTITIES: KnownEntityPattern[] = [
  { names: ['user', 'human'], type: 'person' },
  { names: ['agent', 'assistant', 'me'], type: 'person' },
  { names: ['open memory', 'openmemory'], type: 'project' },
  { names: ['docker'], type: 'tool' },
  { names: ['ollama'], type: 'tool' },
  { names: ['vercel'], type: 'tool' },
  { names: ['postgresql', 'postgres'], type: 'tool' },
  // Add your own entities here:
  // { names: ['my-project'], type: 'project' },
  // { names: ['my-company'], type: 'organization' },
  // { names: ['colleague-name'], type: 'person' },
];

// ============================================================
// SENTIMENT PATTERNS
// ============================================================

const POSITIVE_SIGNALS = [
  '🔥', '💪', '✅', '🎉', '💰', '❤️', '🙌', '✨', '🚀', '💎',
  'awesome', 'amazing', 'great', 'perfect', 'love', 'excited', 'beautiful',
  'incredible', 'fantastic', 'brilliant', "let's go", 'crush it', 'kick ass',
  'proud', 'grateful', 'thank', 'appreciate', 'nice', 'good job', 'well done',
];

const NEGATIVE_SIGNALS = [
  '🚨', '❌', '😤', '💀', '😡',
  'broken', 'failed', 'error', 'bug', 'wrong', 'frustrated', 'annoyed',
  'disappointed', 'worried', 'concerned', 'problem', 'issue', 'stuck',
  'burned', 'wasted', 'lost', 'crashed', 'down',
];

const EXCITEMENT_SIGNALS = [
  '!!', '🔥', '💪', '🚀', '!!!',
  "let's go", 'crush', 'kick ass', 'get after it', 'fired up', 'ready',
  'amazing', 'incredible', 'huge', 'massive', 'insane',
];

const HUMOR_SIGNALS = [
  '😂', '🤣', '😄', '😆', 'lol', 'haha', 'lmao', '💀',
];

// ============================================================
// URGENCY PATTERNS
// ============================================================

const HIGH_URGENCY = [
  'critical', 'urgent', 'emergency', 'broken', 'down', 'asap', 'immediately',
  'right now', 'production', 'outage', 'security', 'breach', '🚨',
];

const MEDIUM_URGENCY = [
  'can you', 'please', 'need', 'should', 'want', 'when', 'how',
  'could you', 'would you', 'let\'s', 'fix', 'update', 'check',
];

// ============================================================
// INTENT PATTERNS
// ============================================================

const QUESTION_PATTERNS = [
  /^(what|who|where|when|why|how|is|are|do|does|can|could|would|should|will)/i,
  /\?$/,
];

const DIRECTIVE_PATTERNS = [
  /never|always|don't|do not|must|rule|from now on|going forward/i,
  /stop|start|only|exclusively|no more/i,
];

const DECISION_PATTERNS = [
  /decided|decision|let's go with|i want to|we're going to|approved|confirmed/i,
  /choosing|picked|selected|going with/i,
];

const FEEDBACK_PATTERNS = [
  /good job|well done|great work|nice|love it|perfect|exactly/i,
  /no that's wrong|not what i|fix this|try again|redo/i,
];

const EMOTIONAL_PATTERNS = [
  /love you|proud of|grateful|thank you|means a lot|appreciate/i,
  /frustrated|worried|scared|excited|happy|sad/i,
  /friend|partner|brother|bli|bro/i,
];

// ============================================================
// MAIN PROCESSOR
// ============================================================

export class SensoryProcessor {
  private knownEntities: KnownEntityPattern[];

  constructor() {
    this.knownEntities = [...CORE_ENTITIES];
  }

  /**
   * Load known entities from the database to enrich pattern matching.
   */
  async loadFromDB(): Promise<void> {
    try {
      const { query } = await import('../../storage/db.js');
      const nodes = await query('SELECT id, name, type, aliases FROM semantic_nodes');
      
      for (const node of nodes.rows) {
        const names = [node.name.toLowerCase()];
        if (node.aliases) {
          names.push(...node.aliases.map((a: string) => a.toLowerCase()));
        }
        
        // Only add if not already in core patterns
        const exists = this.knownEntities.some(e => 
          e.names.some(n => names.includes(n.toLowerCase()))
        );
        
        if (!exists) {
          this.knownEntities.push({
            names,
            type: node.type,
            nodeId: node.id,
          });
        }
      }
    } catch {
      // DB not available — use hardcoded patterns only
    }
  }

  /**
   * Process a raw message through the full pipeline.
   */
  process(rawText: string, sender: string, sessionId?: string): ProcessedMessage {
    const start = Date.now();
    
    const inputType = this.classifyInput(rawText, sender);
    const entities = this.extractEntities(rawText);
    const factualClaims = this.extractFactualClaims(rawText);
    const sentiment = this.analyzeSentiment(rawText);
    const urgency = this.assessUrgency(rawText);
    const intent = this.classifyIntent(rawText, sender);
    const routes = this.determineRoutes(intent, entities, sentiment);

    return {
      rawText,
      sender,
      timestamp: new Date(),
      sessionId,
      inputType,
      entities,
      factualClaims,
      sentiment,
      urgency,
      intent,
      routes,
      processingTime_ms: Date.now() - start,
    };
  }

  // ============================================================
  // STAGE 1: INPUT CLASSIFICATION
  // ============================================================

  private classifyInput(text: string, sender: string): InputType {
    if (sender === 'system' || sender === 'heartbeat') return 'system_event';
    if (sender === 'tool' || text.startsWith('{') || text.startsWith('```')) return 'tool_output';
    if (sender === 'agent' || sender === 'self') return 'reflection';
    return 'conversation';
  }

  // ============================================================
  // STAGE 2: ENTITY EXTRACTION
  // ============================================================

  private extractEntities(text: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];
    const textLower = text.toLowerCase();
    const seen = new Set<string>();

    for (const pattern of this.knownEntities) {
      for (const name of pattern.names) {
        if (name.length < 3) continue; // Skip very short names
        
        if (textLower.includes(name.toLowerCase())) {
          const canonicalName = pattern.names[0];
          if (seen.has(canonicalName)) continue;
          seen.add(canonicalName);
          
          // Extract surrounding context (±50 chars)
          const idx = textLower.indexOf(name.toLowerCase());
          const contextStart = Math.max(0, idx - 50);
          const contextEnd = Math.min(text.length, idx + name.length + 50);
          const context = text.substring(contextStart, contextEnd).trim();

          entities.push({
            name: pattern.names[pattern.names.length > 1 ? 0 : 0], // Use longest/canonical name
            type: pattern.type,
            isKnown: true,
            matchedNodeId: pattern.nodeId,
            confidence: 0.9,
            context,
          });
          break; // Found one match for this pattern, move on
        }
      }
    }

    return entities;
  }

  // ============================================================
  // FACTUAL CLAIM EXTRACTION
  // ============================================================

  private extractFactualClaims(text: string): string[] {
    const claims: string[] = [];
    
    // Dollar amounts
    const moneyPattern = /\$[\d,]+(?:\.\d{2})?(?:\s*\/\s*(?:hr|hour|mo|month|year|day|week))?/g;
    for (const match of text.matchAll(moneyPattern)) {
      claims.push(match[0]);
    }

    // Percentages
    const pctPattern = /\d+(?:\.\d+)?%/g;
    for (const match of text.matchAll(pctPattern)) {
      claims.push(match[0]);
    }

    // Dates
    const datePattern = /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}(?:,?\s+\d{4})?/g;
    for (const match of text.matchAll(datePattern)) {
      claims.push(match[0]);
    }

    // Counts/metrics
    const countPattern = /\b(\d{2,})\s+(nodes?|edges?|files?|rows?|tests?|experiments?|endpoints?|users?)/gi;
    for (const match of text.matchAll(countPattern)) {
      claims.push(match[0]);
    }

    return claims;
  }

  // ============================================================
  // STAGE 3: SENTIMENT ANALYSIS
  // ============================================================

  private analyzeSentiment(text: string): SentimentAnalysis {
    const textLower = text.toLowerCase();
    
    let positiveCount = 0;
    let negativeCount = 0;
    let excitementCount = 0;
    let humorCount = 0;

    for (const signal of POSITIVE_SIGNALS) {
      if (textLower.includes(signal.toLowerCase())) positiveCount++;
    }
    for (const signal of NEGATIVE_SIGNALS) {
      if (textLower.includes(signal.toLowerCase())) negativeCount++;
    }
    for (const signal of EXCITEMENT_SIGNALS) {
      if (textLower.includes(signal.toLowerCase())) excitementCount++;
    }
    for (const signal of HUMOR_SIGNALS) {
      if (textLower.includes(signal.toLowerCase())) humorCount++;
    }

    // Calculate valence (-1 to 1)
    const total = positiveCount + negativeCount || 1;
    const valence = (positiveCount - negativeCount) / total;

    // Calculate arousal (0 to 1)
    const arousal = Math.min(1.0, (excitementCount * 0.3 + (text.match(/!/g)?.length || 0) * 0.1));

    // Determine specific emotions
    const emotions: SpecificEmotion[] = [];
    if (positiveCount > 2) emotions.push('joy');
    if (excitementCount > 1) emotions.push('excitement');
    if (negativeCount > 2) emotions.push('frustration');
    if (humorCount > 0) emotions.push('humor');
    if (textLower.includes('thank') || textLower.includes('appreciate') || textLower.includes('grateful')) emotions.push('gratitude');
    if (textLower.includes('worried') || textLower.includes('concerned')) emotions.push('concern');
    if (textLower.includes('proud') || textLower.includes('amazing work')) emotions.push('pride');
    if (excitementCount > 0 && positiveCount > 0) emotions.push('determination');
    if (emotions.length === 0) emotions.push('neutral');

    return {
      valence: Math.max(-1, Math.min(1, valence)),
      arousal: Math.max(0, Math.min(1, arousal)),
      emotions,
      dominantEmotion: emotions[0],
    };
  }

  // ============================================================
  // STAGE 4: URGENCY ASSESSMENT
  // ============================================================

  private assessUrgency(text: string): number {
    const textLower = text.toLowerCase();
    let urgency = 0.2; // baseline

    for (const signal of HIGH_URGENCY) {
      if (textLower.includes(signal)) urgency = Math.max(urgency, 0.85);
    }
    for (const signal of MEDIUM_URGENCY) {
      if (textLower.includes(signal)) urgency = Math.max(urgency, 0.5);
    }

    // Boost for all caps
    if (text.length > 10 && text === text.toUpperCase()) urgency = Math.min(1.0, urgency + 0.2);
    
    // Boost for multiple exclamation marks
    const exclamations = (text.match(/!/g) || []).length;
    if (exclamations > 2) urgency = Math.min(1.0, urgency + 0.1);

    return urgency;
  }

  // ============================================================
  // STAGE 5: INTENT CLASSIFICATION
  // ============================================================

  private classifyIntent(text: string, sender: string): Intent {
    // Check patterns in order of specificity
    if (DIRECTIVE_PATTERNS.some(p => p.test(text))) return 'directive';
    if (DECISION_PATTERNS.some(p => p.test(text))) return 'decision';
    if (FEEDBACK_PATTERNS.some(p => p.test(text))) return 'feedback';
    if (EMOTIONAL_PATTERNS.some(p => p.test(text))) return 'emotional';
    if (QUESTION_PATTERNS.some(p => p.test(text))) return 'question';
    
    // Check for request indicators
    if (/can you|could you|please|would you|do this|build|create|implement|fix|deploy|send|write|make/i.test(text)) {
      return 'request';
    }

    return 'inform';
  }

  // ============================================================
  // STAGE 6: ROUTING
  // ============================================================

  private determineRoutes(
    intent: Intent,
    entities: ExtractedEntity[],
    sentiment: SentimentAnalysis
  ): ProcessedMessage['routes'] {
    const routes: ProcessedMessage['routes'] = [];

    // Always route conversations with entities to episodic
    if (entities.length > 0) routes.push('episodic');

    switch (intent) {
      case 'inform':
        routes.push('semantic');
        break;
      case 'request':
        routes.push('episodic');
        if (!routes.includes('episodic')) routes.push('episodic');
        break;
      case 'question':
        // Questions don't store, but if they mention entities we already routed to episodic
        break;
      case 'decision':
        routes.push('semantic');
        routes.push('episodic');
        break;
      case 'feedback':
        routes.push('identity');
        routes.push('episodic');
        break;
      case 'emotional':
        routes.push('relational');
        routes.push('episodic');
        if (sentiment.emotions.includes('gratitude') || sentiment.emotions.includes('pride')) {
          routes.push('identity');
        }
        break;
      case 'directive':
        routes.push('semantic');
        routes.push('procedural');
        break;
    }

    // Deduplicate
    return [...new Set(routes)];
  }
}

// ============================================================
// CONVENIENCE EXPORT
// ============================================================

let _processor: SensoryProcessor | null = null;

export async function getSensoryProcessor(): Promise<SensoryProcessor> {
  if (!_processor) {
    _processor = new SensoryProcessor();
    await _processor.loadFromDB();
  }
  return _processor;
}
