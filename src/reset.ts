import { query, shutdown } from '../src/storage/db.js';

async function reset() {
  await query('TRUNCATE semantic_nodes CASCADE');
  await query('TRUNCATE semantic_edges CASCADE');
  await query('TRUNCATE episodes CASCADE');
  await query('TRUNCATE lessons CASCADE');
  await query('TRUNCATE identity CASCADE');
  try { await query('TRUNCATE procedures CASCADE'); } catch {}
  try { await query('TRUNCATE consolidation_log CASCADE'); } catch {}
  try { await query('TRUNCATE confidence_assessments CASCADE'); } catch {}
  try { await query('TRUNCATE person_models CASCADE'); } catch {}
  console.log('All tables truncated');
  await shutdown();
}
reset();
