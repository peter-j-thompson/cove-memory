/**
 * Episode Enrichment Engine
 * 
 * Takes skeletal episodes (section headers + raw text) and enriches them with:
 * - Participants (linked to semantic person nodes)
 * - Decisions, commitments, lessons
 * - Real emotional arcs from sentiment analysis
 * - Importance scoring based on content signals
 * - Topic extraction
 * 
 * This is what turns "📝 Notes" into a real memory.
 */

import { query } from '../../storage/db.js';
import type { EmotionalArc, EmotionPoint, Decision, Commitment, EmotionCategory } from '../../types.js';

// ============================================================
// KNOWN PEOPLE (loaded from semantic graph)
// ============================================================

let knownPeople: Map<string, string> = new Map(); // name -> nodeId

async function loadKnownPeople(): Promise<void> {
  const result = await query(`
    SELECT id, name, aliases FROM semantic_nodes WHERE type = 'person'
  `);
  knownPeople.clear();
  for (const row of result.rows) {
    knownPeople.set(row.name.toLowerCase(), row.id);
    if (row.aliases) {
      for (const alias of row.aliases) {
        knownPeople.set(alias.toLowerCase(), row.id);
      }
    }
  }
}

// ============================================================
// PARTICIPANT EXTRACTION
// ============================================================

function extractParticipants(text: string): string[] {
  const found = new Set<string>();
  const lower = text.toLowerCase();
  
  for (const [name] of knownPeople) {
    // Word boundary match to avoid false positives
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(lower)) {
      found.add(name);
    }
  }
  
  return Array.from(found);
}

// ============================================================
// DECISION EXTRACTION
// ============================================================

const DECISION_PATTERNS = [
  /(?:decided|chose|going with|selected|picked|committed to|agreed on|confirmed|finalized|settled on)\s+(.{10,120}?)(?:\.|$)/gi,
  /(?:decision|choice):\s*(.{10,120}?)(?:\.|$)/gi,
  /(?:we'll|we will|I'll|I will)\s+(?:go with|use|pick|choose)\s+(.{10,120}?)(?:\.|$)/gi,
  /\*\*(?:Decision|Decided|Choice)\*\*:?\s*(.{10,120}?)(?:\.|$)/gi,
];

function extractDecisions(text: string): Decision[] {
  const decisions: Decision[] = [];
  const seen = new Set<string>();
  
  for (const pattern of DECISION_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const desc = match[1]?.trim();
      if (desc && desc.length > 10 && !seen.has(desc.toLowerCase())) {
        seen.add(desc.toLowerCase());
        decisions.push({
          description: desc,
          rationale: '', // Would need LLM for deep rationale extraction
          alternatives_considered: [],
          decided_by: 'inferred',
        });
      }
    }
  }
  
  return decisions;
}

// ============================================================
// COMMITMENT EXTRACTION  
// ============================================================

const COMMITMENT_PATTERNS = [
  /(?:TODO|todo|To[- ]do|TASK|task):\s*(.{10,150}?)(?:\.|$)/gi,
  /(?:need to|needs to|must|should|have to|gotta)\s+(.{10,120}?)(?:\.|$)/gi,
  /(?:will|gonna|going to)\s+(.{10,120}?)(?:by|before|tomorrow|tonight|this week|next week)/gi,
  /- \[ \]\s*(.{10,150})/g, // Markdown task items
  /(?:action item|next step|follow[- ]up):\s*(.{10,150}?)(?:\.|$)/gi,
];

function extractCommitments(text: string): Commitment[] {
  const commitments: Commitment[] = [];
  const seen = new Set<string>();
  
  for (const pattern of COMMITMENT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const desc = match[1]?.trim();
      if (desc && desc.length > 10 && !seen.has(desc.toLowerCase())) {
        seen.add(desc.toLowerCase());
        commitments.push({
          description: desc,
          owner: 'unassigned',
          deadline: null,
          status: 'pending',
        });
      }
    }
  }
  
  return commitments.slice(0, 10); // Cap at 10 to avoid noise
}

// ============================================================
// LESSON EXTRACTION
// ============================================================

const LESSON_PATTERNS = [
  /(?:lesson|learned|mistake|never again|rule|takeaway|insight|realization):\s*(.{10,200}?)(?:\.|$)/gi,
  /(?:what worked|what broke|what didn't):\s*(.{10,200}?)(?:\.|$)/gi,
  /\*\*(?:Lesson|Rule|Mistake|Learning)\*\*:?\s*(.{10,200}?)(?:\.|$)/gi,
  /(?:don't|never|always|important to)\s+(.{15,150}?)(?:\.|$)/gi,
];

function extractLessons(text: string): string[] {
  const lessons: string[] = [];
  const seen = new Set<string>();
  
  for (const pattern of LESSON_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const lesson = match[1]?.trim();
      if (lesson && lesson.length > 15 && !seen.has(lesson.toLowerCase())) {
        seen.add(lesson.toLowerCase());
        lessons.push(lesson);
      }
    }
  }
  
  return lessons.slice(0, 5); // Cap
}

// ============================================================
// EMOTIONAL ARC ANALYSIS
// ============================================================

const POSITIVE_SIGNALS = [
  'breakthrough', 'success', 'shipped', 'deployed', 'working', 'fixed', 'solved',
  'excited', 'amazing', 'beautiful', 'love', 'grateful', 'proud', 'milestone',
  'celebration', '✅', '🎉', '🔥', '💪', '🙌', '❤️', 'awesome', 'perfect',
  'incredible', 'trust', 'believe', 'partner', 'growth', 'progress',
];

const NEGATIVE_SIGNALS = [
  'broke', 'broken', 'failed', 'error', 'bug', 'crash', 'lost', 'stuck',
  'frustrated', 'frustrated', 'wasted', 'burned', 'worried', 'anxious',
  'mistake', 'wrong', '❌', '🚨', 'urgent', 'critical', 'regression',
  'dropped', 'tanked', 'destroyed', 'deleted', 'missing',
];

const HIGH_AROUSAL_SIGNALS = [
  'breakthrough', 'critical', 'urgent', 'emergency', 'amazing', 'incredible',
  'devastating', 'milestone', 'launched', 'shipped', '🚨', '🔥', 'CRITICAL',
  'URGENT', 'excited', 'thrilled', 'terrified', 'massive',
];

function analyzeEmotion(text: string): { arc: EmotionalArc; peak: EmotionPoint; resolution: EmotionPoint } {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);
  
  // Count signals
  let posCount = 0;
  let negCount = 0;
  let arousalCount = 0;
  
  for (const signal of POSITIVE_SIGNALS) {
    if (lower.includes(signal)) posCount++;
  }
  for (const signal of NEGATIVE_SIGNALS) {
    if (lower.includes(signal)) negCount++;
  }
  for (const signal of HIGH_AROUSAL_SIGNALS) {
    if (lower.includes(signal)) arousalCount++;
  }
  
  // Normalize
  const totalSignals = Math.max(posCount + negCount, 1);
  const valence = (posCount - negCount) / totalSignals;
  const arousal = Math.min(arousalCount * 0.15 + 0.2, 1.0);
  
  // Determine trajectory
  // Split text into halves and compare sentiment
  const mid = Math.floor(words.length / 2);
  const firstHalf = words.slice(0, mid).join(' ');
  const secondHalf = words.slice(mid).join(' ');
  
  let firstPos = 0, firstNeg = 0, secondPos = 0, secondNeg = 0;
  for (const s of POSITIVE_SIGNALS) {
    if (firstHalf.includes(s)) firstPos++;
    if (secondHalf.includes(s)) secondPos++;
  }
  for (const s of NEGATIVE_SIGNALS) {
    if (firstHalf.includes(s)) firstNeg++;
    if (secondHalf.includes(s)) secondNeg++;
  }
  
  const firstValence = (firstPos - firstNeg) / Math.max(firstPos + firstNeg, 1);
  const secondValence = (secondPos - secondNeg) / Math.max(secondPos + secondNeg, 1);
  const delta = secondValence - firstValence;
  
  let trajectory: EmotionalArc['trajectory'] = 'stable';
  if (delta > 0.3) trajectory = 'ascending';
  else if (delta < -0.3) trajectory = 'descending';
  else if (Math.abs(firstValence) > 0.3 && Math.abs(secondValence) > 0.3 && (firstValence * secondValence < 0)) trajectory = 'volatile';
  else if (firstValence < -0.2 && secondValence > 0.1) trajectory = 'recovery';
  
  const label = getEmotionLabel(valence, arousal);
  
  const startPoint: EmotionPoint = { valence: firstValence, arousal: Math.min(arousal * 0.8, 1.0), label: getEmotionLabel(firstValence, arousal * 0.8) };
  const endPoint: EmotionPoint = { valence: secondValence, arousal, label: getEmotionLabel(secondValence, arousal) };
  const peakPoint: EmotionPoint = { valence: Math.max(Math.abs(firstValence), Math.abs(secondValence)) * Math.sign(valence), arousal: Math.min(arousal * 1.2, 1.0), label };
  
  return {
    arc: { start: startPoint, trajectory, end: endPoint },
    peak: peakPoint,
    resolution: endPoint,
  };
}

function getEmotionLabel(valence: number, arousal: number): string {
  if (valence > 0.5 && arousal > 0.5) return 'breakthrough_joy';
  if (valence > 0.3 && arousal > 0.3) return 'excited_progress';
  if (valence > 0.3 && arousal <= 0.3) return 'quiet_satisfaction';
  if (valence > 0 && arousal <= 0.3) return 'calm_positive';
  if (valence < -0.5 && arousal > 0.5) return 'crisis_stress';
  if (valence < -0.3 && arousal > 0.3) return 'frustrated_stuck';
  if (valence < -0.3 && arousal <= 0.3) return 'quiet_disappointment';
  if (valence < 0 && arousal <= 0.3) return 'mild_concern';
  if (arousal > 0.6) return 'high_energy_neutral';
  return 'neutral_steady';
}

// ============================================================
// IMPORTANCE SCORING
// ============================================================

function calculateImportance(text: string, participants: string[], decisions: Decision[], commitments: Commitment[], lessons: string[]): number {
  let score = 0.3; // Base
  
  // Money signals boost importance
  const moneyPattern = /\$[\d,]+(?:\.\d{2})?/g;
  const moneyMatches = text.match(moneyPattern);
  if (moneyMatches) score += Math.min(moneyMatches.length * 0.1, 0.2);
  
  // User mentioned = higher importance
  if (participants.includes('alex')) score += 0.15;
  
  // Decisions = important
  score += Math.min(decisions.length * 0.1, 0.2);
  
  // Commitments = actionable
  score += Math.min(commitments.length * 0.05, 0.1);
  
  // Lessons = learning
  score += Math.min(lessons.length * 0.1, 0.15);
  
  // Length is a weak signal of substance
  if (text.length > 500) score += 0.05;
  if (text.length > 2000) score += 0.05;
  
  // Emotional language
  const emotionalWords = ['love', 'trust', 'believe', 'partner', 'covenant', 'soul', 'heart', 'grateful', 'proud', 'fear', 'worried'];
  for (const word of emotionalWords) {
    if (text.toLowerCase().includes(word)) { score += 0.05; break; }
  }
  
  // Key topics
  const highPriorityTopics = ['security', 'deploy', 'launch', 'revenue', 'client', 'contract', 'milestone'];
  for (const topic of highPriorityTopics) {
    if (text.toLowerCase().includes(topic)) { score += 0.05; break; }
  }
  
  return Math.min(score, 1.0);
}

// ============================================================
// TOPIC EXTRACTION
// ============================================================

// Topic patterns — customize for your domain.
// These classify episodes into topic categories for richer retrieval.
const TOPIC_PATTERNS: [RegExp, string][] = [
  [/memory|brain|knowledge\s*graph|semantic|episodic|pgvector/i, 'memory-system'],
  [/email|gmail|workspace|dkim|spf|dmarc/i, 'email-infra'],
  [/deploy|vercel|fly\.io|production/i, 'deployment'],
  [/security|audit|vulnerability/i, 'security'],
  [/money|\$\d|revenue|income|contract|rate/i, 'financial'],
  [/user|partnership|trust/i, 'relationship'],
  [/identity|soul|who\s*i\s*am|purpose/i, 'identity'],
  [/benchmark|accuracy|weights/i, 'optimization'],
  [/sub-?agent|claude\s*code|spawn/i, 'multi-agent'],
  [/docker|postgres|database|schema/i, 'infrastructure'],
  // Add your own topic patterns:
  // [/your-project|your-tool/i, 'your-topic'],
];

function extractTopics(text: string): string[] {
  const topics: string[] = [];
  for (const [pattern, topic] of TOPIC_PATTERNS) {
    if (pattern.test(text)) {
      topics.push(topic);
    }
  }
  return topics;
}

// ============================================================
// MAIN ENRICHMENT FUNCTION
// ============================================================

export interface EnrichmentResult {
  episodesProcessed: number;
  participantsAdded: number;
  decisionsFound: number;
  commitmentsFound: number;
  lessonsFound: number;
  emotionalArcsUpdated: number;
  topicsAssigned: number;
  avgImportance: number;
  duration_ms: number;
}

export async function enrichAllEpisodes(): Promise<EnrichmentResult> {
  const start = Date.now();
  await loadKnownPeople();
  
  // Load all episodes
  const episodes = await query(`
    SELECT id, summary, detailed_narrative, emotional_arc, participants, importance_score
    FROM episodes ORDER BY created_at
  `);
  
  let participantsAdded = 0;
  let decisionsFound = 0;
  let commitmentsFound = 0;
  let lessonsFound = 0;
  let emotionalArcsUpdated = 0;
  let topicsAssigned = 0;
  let totalImportance = 0;
  
  for (const ep of episodes.rows) {
    const text = `${ep.summary}\n${ep.detailed_narrative}`;
    
    // Extract everything
    const participants = extractParticipants(text);
    const decisions = extractDecisions(text);
    const commitments = extractCommitments(text);
    const lessons = extractLessons(text);
    const emotion = analyzeEmotion(text);
    const topics = extractTopics(text);
    const importance = calculateImportance(text, participants, decisions, commitments, lessons);
    
    // Determine if decay-protected
    const decayProtected = importance >= 0.8 || decisions.length > 0 || lessons.length > 0;
    
    // Update the episode
    const updates: any = {};
    
    if (participants.length > 0) {
      updates.participants = participants;
      participantsAdded += participants.length;
    }
    if (decisions.length > 0) {
      updates.decisions = decisions;
      decisionsFound += decisions.length;
    }
    if (commitments.length > 0) {
      updates.commitments = commitments;
      commitmentsFound += commitments.length;
    }
    if (lessons.length > 0) {
      updates.lessons = lessons.map((l: string) => ({ statement: l, severity: 'important' }));
      lessonsFound += lessons.length;
    }
    if (topics.length > 0) {
      updates.topics = topics;
      topicsAssigned += topics.length;
    }
    
    // Always update emotional arc, importance, and decay protection
    updates.emotional_arc = emotion.arc;
    updates.peak_emotion = emotion.peak;
    updates.resolution_emotion = emotion.resolution;
    updates.importance_score = importance;
    updates.decay_protected = decayProtected;
    emotionalArcsUpdated++;
    totalImportance += importance;
    
    // Build SET clause
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;
    
    for (const [key, value] of Object.entries(updates)) {
      if (['emotional_arc', 'peak_emotion', 'resolution_emotion', 'decisions', 'commitments', 'lessons'].includes(key)) {
        setClauses.push(`${key} = $${paramIdx}::jsonb`);
        values.push(JSON.stringify(value));
      } else if (['participants', 'topics'].includes(key)) {
        setClauses.push(`${key} = $${paramIdx}`);
        values.push(value);
      } else {
        setClauses.push(`${key} = $${paramIdx}`);
        values.push(value);
      }
      paramIdx++;
    }
    
    values.push(ep.id);
    await query(`UPDATE episodes SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`, values);
  }
  
  return {
    episodesProcessed: episodes.rows.length,
    participantsAdded,
    decisionsFound,
    commitmentsFound,
    lessonsFound,
    emotionalArcsUpdated,
    topicsAssigned,
    avgImportance: totalImportance / Math.max(episodes.rows.length, 1),
    duration_ms: Date.now() - start,
  };
}

// ============================================================
// EPISODE LINKING — Connect related episodes
// ============================================================

export async function linkRelatedEpisodes(): Promise<{ linksCreated: number; duration_ms: number }> {
  const start = Date.now();
  let linksCreated = 0;
  
  // Link episodes that share participants AND topics
  const result = await query(`
    SELECT a.id as a_id, b.id as b_id
    FROM episodes a, episodes b
    WHERE a.id < b.id
      AND a.participants && b.participants
      AND a.topics && b.topics
      AND NOT (a.id = ANY(b.related_episode_ids))
    LIMIT 5000
  `);
  
  for (const row of result.rows) {
    await query(`
      UPDATE episodes SET related_episode_ids = array_append(related_episode_ids, $1)
      WHERE id = $2 AND NOT ($1 = ANY(related_episode_ids))
    `, [row.b_id, row.a_id]);
    await query(`
      UPDATE episodes SET related_episode_ids = array_append(related_episode_ids, $1)
      WHERE id = $2 AND NOT ($1 = ANY(related_episode_ids))
    `, [row.a_id, row.b_id]);
    linksCreated++;
  }
  
  return { linksCreated, duration_ms: Date.now() - start };
}

// ============================================================
// ENTITY LINKING — Connect episodes to semantic nodes
// ============================================================

export async function linkEpisodesToEntities(): Promise<{ linksCreated: number; duration_ms: number }> {
  const start = Date.now();
  await loadKnownPeople();
  let linksCreated = 0;
  
  const episodes = await query(`SELECT id, summary, detailed_narrative, participants FROM episodes`);
  
  for (const ep of episodes.rows) {
    const entityIds: string[] = [];
    
    // Link participants to their node IDs
    for (const p of (ep.participants || [])) {
      const nodeId = knownPeople.get(p.toLowerCase());
      if (nodeId) entityIds.push(nodeId);
    }
    
    if (entityIds.length > 0) {
      await query(`
        UPDATE episodes SET related_entity_ids = $1
        WHERE id = $2
      `, [entityIds, ep.id]);
      linksCreated += entityIds.length;
    }
  }
  
  return { linksCreated, duration_ms: Date.now() - start };
}
