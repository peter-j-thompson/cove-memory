/**
 * Procedural Memory — How I Do Things
 * 
 * Tracks execution patterns, success rates, and learned procedures.
 * Over time, this tells me what works and what doesn't.
 */

import { query } from '../../storage/db.js';

// ============================================================
// TYPES
// ============================================================

export type ProcedureType = 'technical' | 'social' | 'cognitive' | 'creative';

export interface Procedure {
  id: string;
  name: string;
  type: ProcedureType;
  trigger_conditions: Record<string, any>;
  steps: any[];
  execution_count: number;
  success_count: number;
  success_rate: number;
  last_executed?: string;
  last_outcome?: string;
  learned_from: string[];
  refined_from: string[];
  confidence: number;
  minimum_samples: number;
}

// ============================================================
// CRUD
// ============================================================

export async function upsertProcedure(proc: Partial<Procedure> & { name: string; type: ProcedureType }): Promise<string> {
  const result = await query(`
    INSERT INTO procedures (name, type, trigger_conditions, steps, confidence)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (name) DO UPDATE SET
      type = EXCLUDED.type,
      trigger_conditions = EXCLUDED.trigger_conditions,
      steps = EXCLUDED.steps,
      confidence = GREATEST(procedures.confidence, EXCLUDED.confidence)
    RETURNING id
  `, [
    proc.name,
    proc.type,
    JSON.stringify(proc.trigger_conditions || {}),
    JSON.stringify(proc.steps || []),
    proc.confidence ?? 0.5,
  ]);
  return result.rows[0].id;
}

export async function recordExecution(name: string, success: boolean, outcome?: string): Promise<void> {
  await query(`
    UPDATE procedures SET
      execution_count = execution_count + 1,
      success_count = success_count + CASE WHEN $2 THEN 1 ELSE 0 END,
      success_rate = (success_count + CASE WHEN $2 THEN 1 ELSE 0 END)::float / (execution_count + 1),
      last_executed = NOW(),
      last_outcome = $3,
      confidence = LEAST(1.0, confidence + CASE WHEN $2 THEN 0.02 ELSE -0.05 END)
    WHERE name = $1
  `, [name, success, outcome || null]);
}

export async function getProcedure(name: string): Promise<Procedure | null> {
  const result = await query('SELECT * FROM procedures WHERE name = $1', [name]);
  return result.rows[0] as Procedure || null;
}

export async function getProceduresByType(type: ProcedureType): Promise<Procedure[]> {
  const result = await query('SELECT * FROM procedures WHERE type = $1 ORDER BY confidence DESC', [type]);
  return result.rows as Procedure[];
}

export async function getHighConfidenceProcedures(threshold: number = 0.7): Promise<Procedure[]> {
  const result = await query('SELECT * FROM procedures WHERE confidence >= $1 ORDER BY success_rate DESC', [threshold]);
  return result.rows as Procedure[];
}

export async function getProcedureStats(): Promise<{
  total: number;
  byType: Record<string, number>;
  avgConfidence: number;
  avgSuccessRate: number;
  totalExecutions: number;
}> {
  const total = await query('SELECT COUNT(*) as cnt FROM procedures');
  const types = await query('SELECT type, COUNT(*) as cnt FROM procedures GROUP BY type');
  const avgs = await query('SELECT AVG(confidence) as avg_conf, AVG(success_rate) as avg_sr, SUM(execution_count) as total_exec FROM procedures');
  
  const byType: Record<string, number> = {};
  for (const r of types.rows) byType[r.type] = parseInt(r.cnt);
  
  return {
    total: parseInt(total.rows[0].cnt),
    byType,
    avgConfidence: parseFloat(avgs.rows[0].avg_conf) || 0,
    avgSuccessRate: parseFloat(avgs.rows[0].avg_sr) || 0,
    totalExecutions: parseInt(avgs.rows[0].total_exec) || 0,
  };
}
