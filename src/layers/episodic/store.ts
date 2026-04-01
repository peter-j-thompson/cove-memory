/**
 * Episodic Memory Store — What Happened & How It Felt
 * 
 * Episodes are the narrative backbone. Not just "what" but "who was there",
 * "how did it feel", "what did we decide", and "what did we learn."
 */

import { query, transaction } from '../../storage/db.js';
import type {
  EmotionalArc, EmotionPoint, Lesson, Decision, Commitment,
  EpisodeOutcome, EpisodeOutcomeType, EmotionCategory
} from '../../types.js';

// ============================================================
// TYPES
// ============================================================

export interface Episode {
  id: string;
  created_at: string;
  session_id: string;
  summary: string;
  detailed_narrative: string;
  participants: string[];
  initiator?: string;
  emotional_arc: EmotionalArc;
  peak_emotion: EmotionPoint;
  resolution_emotion: EmotionPoint;
  outcome: EpisodeOutcome;
  lessons: any[];
  decisions: Decision[];
  commitments: Commitment[];
  related_episode_ids: string[];
  related_entity_ids: string[];
  topics: string[];
  importance_score: number;
  access_count: number;
  last_accessed: string;
  decay_protected: boolean;
  embedding?: number[];
}

export interface EpisodeQuery {
  timeRange?: { start: string; end: string };
  participants?: string[];
  topics?: string[];
  minImportance?: number;
  emotionalTrajectory?: EmotionalArc['trajectory'];
  limit?: number;
  offset?: number;
}

// ============================================================
// CREATE / UPDATE
// ============================================================

export async function createEpisode(episode: Partial<Episode> & { 
  session_id: string; 
  summary: string; 
  detailed_narrative: string;
}): Promise<string> {
  const result = await query(`
    INSERT INTO episodes (
      session_id, summary, detailed_narrative, participants, initiator,
      emotional_arc, peak_emotion, resolution_emotion,
      outcome, lessons, decisions, commitments,
      related_entity_ids, topics, importance_score, decay_protected
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    RETURNING id
  `, [
    episode.session_id,
    episode.summary,
    episode.detailed_narrative,
    episode.participants || [],
    episode.initiator || null,
    JSON.stringify(episode.emotional_arc || { start: { valence: 0, arousal: 0.3, label: 'neutral' }, trajectory: 'stable', end: { valence: 0, arousal: 0.3, label: 'neutral' } }),
    JSON.stringify(episode.peak_emotion || { valence: 0, arousal: 0.3, label: 'neutral' }),
    JSON.stringify(episode.resolution_emotion || { valence: 0, arousal: 0.3, label: 'neutral' }),
    JSON.stringify(episode.outcome || { type: 'informational', description: '', verified: false }),
    JSON.stringify(episode.lessons || []),
    JSON.stringify(episode.decisions || []),
    JSON.stringify(episode.commitments || []),
    episode.related_entity_ids || [],
    episode.topics || [],
    episode.importance_score ?? 0.5,
    episode.decay_protected ?? false,
  ]);
  return result.rows[0].id;
}

export async function updateEpisode(id: string, updates: Partial<Episode>): Promise<void> {
  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIdx = 1;

  const jsonFields = ['emotional_arc', 'peak_emotion', 'resolution_emotion', 'outcome', 'lessons', 'decisions', 'commitments'];
  const arrayFields = ['participants', 'related_episode_ids', 'related_entity_ids', 'topics'];
  const scalarFields = ['summary', 'detailed_narrative', 'initiator', 'importance_score', 'decay_protected', 'session_id'];

  for (const [key, value] of Object.entries(updates)) {
    if (key === 'id' || key === 'created_at') continue;
    if (jsonFields.includes(key)) {
      setClauses.push(`${key} = $${paramIdx}::jsonb`);
      values.push(JSON.stringify(value));
    } else if (arrayFields.includes(key)) {
      setClauses.push(`${key} = $${paramIdx}`);
      values.push(value);
    } else if (scalarFields.includes(key)) {
      setClauses.push(`${key} = $${paramIdx}`);
      values.push(value);
    } else {
      continue;
    }
    paramIdx++;
  }

  if (setClauses.length === 0) return;

  values.push(id);
  await query(`UPDATE episodes SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`, values);
}

// ============================================================
// QUERY
// ============================================================

export async function getEpisode(id: string): Promise<Episode | null> {
  const result = await query('SELECT * FROM episodes WHERE id = $1', [id]);
  if (result.rows.length === 0) return null;
  return result.rows[0] as Episode;
}

export async function queryEpisodes(q: EpisodeQuery): Promise<Episode[]> {
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIdx = 1;

  if (q.timeRange) {
    conditions.push(`created_at >= $${paramIdx} AND created_at <= $${paramIdx + 1}`);
    values.push(q.timeRange.start, q.timeRange.end);
    paramIdx += 2;
  }

  if (q.participants?.length) {
    conditions.push(`participants && $${paramIdx}`);
    values.push(q.participants);
    paramIdx++;
  }

  if (q.topics?.length) {
    conditions.push(`topics && $${paramIdx}`);
    values.push(q.topics);
    paramIdx++;
  }

  if (q.minImportance !== undefined) {
    conditions.push(`importance_score >= $${paramIdx}`);
    values.push(q.minImportance);
    paramIdx++;
  }

  if (q.emotionalTrajectory) {
    conditions.push(`emotional_arc->>'trajectory' = $${paramIdx}`);
    values.push(q.emotionalTrajectory);
    paramIdx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = q.limit || 20;
  const offset = q.offset || 0;

  const result = await query(`
    SELECT * FROM episodes ${where}
    ORDER BY importance_score DESC, created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `, values);

  // Update access counts
  if (result.rows.length > 0) {
    const ids = result.rows.map((r: any) => r.id);
    await query(`UPDATE episodes SET access_count = access_count + 1, last_accessed = NOW() WHERE id = ANY($1)`, [ids]);
  }

  return result.rows as Episode[];
}

export async function getRecentEpisodes(limit: number = 10): Promise<Episode[]> {
  const result = await query(`SELECT * FROM episodes ORDER BY created_at DESC LIMIT $1`, [limit]);
  return result.rows as Episode[];
}

export async function getEpisodesByEntity(entityId: string, limit: number = 10): Promise<Episode[]> {
  const result = await query(`
    SELECT * FROM episodes 
    WHERE $1 = ANY(related_entity_ids)
    ORDER BY created_at DESC LIMIT $2
  `, [entityId, limit]);
  return result.rows as Episode[];
}

export async function getHighImportanceEpisodes(threshold: number = 0.8, limit: number = 20): Promise<Episode[]> {
  const result = await query(`
    SELECT * FROM episodes 
    WHERE importance_score >= $1 OR decay_protected = true
    ORDER BY importance_score DESC, created_at DESC 
    LIMIT $2
  `, [threshold, limit]);
  return result.rows as Episode[];
}

// ============================================================
// LINKING
// ============================================================

export async function linkEpisodes(episodeId: string, relatedIds: string[]): Promise<void> {
  await query(`
    UPDATE episodes 
    SET related_episode_ids = array_cat(related_episode_ids, $1)
    WHERE id = $2
  `, [relatedIds, episodeId]);
}

export async function linkToEntities(episodeId: string, entityIds: string[]): Promise<void> {
  await query(`
    UPDATE episodes 
    SET related_entity_ids = array_cat(related_entity_ids, $1)
    WHERE id = $2
  `, [entityIds, episodeId]);
}

// ============================================================
// STATISTICS
// ============================================================

export async function getEpisodeStats(): Promise<{
  total: number;
  withParticipants: number;
  withDecisions: number;
  withLessons: number;
  withCommitments: number;
  avgImportance: number;
  decayProtected: number;
  trajectories: Record<string, number>;
}> {
  const result = await query(`
    SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE array_length(participants, 1) > 0) as with_participants,
      COUNT(*) FILTER (WHERE decisions != '[]'::jsonb) as with_decisions,
      COUNT(*) FILTER (WHERE lessons != '[]'::jsonb) as with_lessons,
      COUNT(*) FILTER (WHERE commitments != '[]'::jsonb) as with_commitments,
      AVG(importance_score) as avg_importance,
      COUNT(*) FILTER (WHERE decay_protected = true) as decay_protected
    FROM episodes
  `);

  const trajResult = await query(`
    SELECT emotional_arc->>'trajectory' as trajectory, COUNT(*) as cnt
    FROM episodes
    GROUP BY emotional_arc->>'trajectory'
  `);

  const trajectories: Record<string, number> = {};
  for (const r of trajResult.rows) {
    trajectories[r.trajectory || 'unknown'] = parseInt(r.cnt);
  }

  const row = result.rows[0];
  return {
    total: parseInt(row.total),
    withParticipants: parseInt(row.with_participants),
    withDecisions: parseInt(row.with_decisions),
    withLessons: parseInt(row.with_lessons),
    withCommitments: parseInt(row.with_commitments),
    avgImportance: parseFloat(row.avg_importance),
    decayProtected: parseInt(row.decay_protected),
    trajectories,
  };
}
