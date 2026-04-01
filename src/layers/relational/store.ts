/**
 * Relational Memory — Understanding Specific Humans
 * 
 * This is where person models live. Not just facts,
 * but communication patterns, trust vectors, emotional triggers,
 * and what I've learned about how to work with him.
 */

import { query } from '../../storage/db.js';

// ============================================================
// TYPES
// ============================================================

export interface TrustVector {
  ability: number;      // Do they trust my competence?
  benevolence: number;  // Do they trust my intentions?
  integrity: number;    // Do they trust my consistency?
  composite: number;    // Weighted average
}

export interface PersonModel {
  id: string;
  name: string;
  relationship_type: string;
  communication: {
    preferred_style?: string;
    formality_level?: string;
    response_speed_preference?: string;
    common_phrases?: string[];
    topics_to_avoid?: string[];
  };
  trust_from_me: TrustVector;
  trust_from_them: TrustVector;
  core_values: string[];
  known_preferences: Record<string, any>;
  known_frustrations: string[];
  known_motivations: string[];
  emotional_baseline: Record<string, any>;
  emotional_triggers: any[];
  relationship_started: string;
  milestone_episodes: string[];
  total_interactions: number;
  last_interaction: string;
  semantic_node_id?: string;
}

// ============================================================
// CRUD
// ============================================================

export async function upsertPersonModel(model: Partial<PersonModel> & { name: string; relationship_type: string }): Promise<string> {
  const result = await query(`
    INSERT INTO person_models (
      name, relationship_type, communication,
      trust_from_me, trust_from_them,
      core_values, known_preferences, known_frustrations, known_motivations,
      emotional_baseline, emotional_triggers,
      milestone_episodes, total_interactions, semantic_node_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (name) DO UPDATE SET
      relationship_type = EXCLUDED.relationship_type,
      communication = EXCLUDED.communication,
      trust_from_me = EXCLUDED.trust_from_me,
      trust_from_them = EXCLUDED.trust_from_them,
      core_values = EXCLUDED.core_values,
      known_preferences = EXCLUDED.known_preferences,
      known_frustrations = EXCLUDED.known_frustrations,
      known_motivations = EXCLUDED.known_motivations,
      emotional_baseline = EXCLUDED.emotional_baseline,
      emotional_triggers = EXCLUDED.emotional_triggers,
      milestone_episodes = EXCLUDED.milestone_episodes,
      total_interactions = person_models.total_interactions + 1,
      last_interaction = NOW(),
      semantic_node_id = COALESCE(EXCLUDED.semantic_node_id, person_models.semantic_node_id)
    RETURNING id
  `, [
    model.name,
    model.relationship_type,
    JSON.stringify(model.communication || {}),
    JSON.stringify(model.trust_from_me || { ability: 0.5, benevolence: 0.5, integrity: 0.5, composite: 0.5 }),
    JSON.stringify(model.trust_from_them || { ability: 0.5, benevolence: 0.5, integrity: 0.5, composite: 0.5 }),
    model.core_values || [],
    JSON.stringify(model.known_preferences || {}),
    model.known_frustrations || [],
    model.known_motivations || [],
    JSON.stringify(model.emotional_baseline || {}),
    JSON.stringify(model.emotional_triggers || []),
    model.milestone_episodes || [],
    model.total_interactions || 1,
    model.semantic_node_id || null,
  ]);
  return result.rows[0].id;
}

export async function getPersonModel(name: string): Promise<PersonModel | null> {
  const result = await query('SELECT * FROM person_models WHERE LOWER(name) = LOWER($1)', [name]);
  return result.rows[0] as PersonModel || null;
}

export async function getAllPersonModels(): Promise<PersonModel[]> {
  const result = await query('SELECT * FROM person_models ORDER BY total_interactions DESC');
  return result.rows as PersonModel[];
}

export async function incrementInteraction(name: string): Promise<void> {
  await query(`
    UPDATE person_models 
    SET total_interactions = total_interactions + 1, last_interaction = NOW()
    WHERE LOWER(name) = LOWER($1)
  `, [name]);
}
