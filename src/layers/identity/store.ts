/**
 * Identity Layer — Who I Am
 * 
 * Not just facts about myself, but values, beliefs, growth edges,
 * and how they change over time through affirmation and reflection.
 */

import { query } from '../../storage/db.js';

// ============================================================
// TYPES
// ============================================================

export type IdentityCategory = 'core' | 'value' | 'belief' | 'growth_edge' | 'strength' | 'relationship' | 'purpose';

export interface IdentityEntry {
  id: string;
  key: string;
  value: string;
  category: IdentityCategory;
  emotional_weight: number;
  source: string;
  established: string;
  last_affirmed: string;
  times_affirmed: number;
}

// ============================================================
// CRUD
// ============================================================

export async function setIdentity(key: string, value: string, category: IdentityCategory, source: string, emotionalWeight?: number): Promise<string> {
  const result = await query(`
    INSERT INTO identity (key, value, category, source, emotional_weight)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      last_affirmed = NOW(),
      times_affirmed = identity.times_affirmed + 1,
      emotional_weight = GREATEST(identity.emotional_weight, EXCLUDED.emotional_weight)
    RETURNING id
  `, [key, value, category, source, emotionalWeight ?? 0.5]);
  return result.rows[0].id;
}

export async function getIdentity(key: string): Promise<IdentityEntry | null> {
  const result = await query('SELECT * FROM identity WHERE key = $1', [key]);
  return result.rows[0] as IdentityEntry || null;
}

export async function getIdentityByCategory(category: IdentityCategory): Promise<IdentityEntry[]> {
  const result = await query('SELECT * FROM identity WHERE category = $1 ORDER BY emotional_weight DESC', [category]);
  return result.rows as IdentityEntry[];
}

export async function getAllIdentity(): Promise<IdentityEntry[]> {
  const result = await query('SELECT * FROM identity ORDER BY category, emotional_weight DESC');
  return result.rows as IdentityEntry[];
}

export async function affirmIdentity(key: string): Promise<void> {
  await query(`
    UPDATE identity SET last_affirmed = NOW(), times_affirmed = times_affirmed + 1
    WHERE key = $1
  `, [key]);
}

// ============================================================
// STATS
// ============================================================

export async function getIdentityStats(): Promise<{
  total: number;
  byCategory: Record<string, number>;
  avgEmotionalWeight: number;
  mostAffirmed: { key: string; times: number } | null;
}> {
  const total = await query('SELECT COUNT(*) as cnt FROM identity');
  const cats = await query('SELECT category, COUNT(*) as cnt FROM identity GROUP BY category');
  const avgW = await query('SELECT AVG(emotional_weight) as avg FROM identity');
  const top = await query('SELECT key, times_affirmed FROM identity ORDER BY times_affirmed DESC LIMIT 1');
  
  const byCategory: Record<string, number> = {};
  for (const r of cats.rows) byCategory[r.category] = parseInt(r.cnt);
  
  return {
    total: parseInt(total.rows[0].cnt),
    byCategory,
    avgEmotionalWeight: parseFloat(avgW.rows[0].avg) || 0,
    mostAffirmed: top.rows[0] ? { key: top.rows[0].key, times: top.rows[0].times_affirmed } : null,
  };
}
