/**
 * JSON query interface — outputs structured results for AutoExplore.
 * 
 * Usage: npx tsx src/query-json.ts "query text" [weights_json]
 * Output: JSON to stdout (parseable by Python executor)
 */

import { search, DEFAULT_WEIGHTS } from './engines/retrieval/search.js';
import { shutdown } from './storage/db.js';

async function main() {
  const queryText = process.argv[2];
  const weightsJson = process.argv[3];
  
  if (!queryText) {
    console.error(JSON.stringify({ error: 'No query provided' }));
    process.exit(1);
  }
  
  let weights = DEFAULT_WEIGHTS;
  if (weightsJson) {
    try {
      weights = { ...DEFAULT_WEIGHTS, ...JSON.parse(weightsJson) };
    } catch {
      // ignore parse errors, use defaults
    }
  }
  
  const start = Date.now();
  const results = await search(queryText, { limit: 5, weights });
  const latency = Date.now() - start;
  
  const output = {
    query: queryText,
    result_count: results.length,
    latency_ms: latency,
    results: results.map(r => ({
      memory_type: r.memory_type,
      content: r.content,
      name: r.name || null,
      total_score: r.total_score,
      scores: r.scores,
    })),
  };
  
  // Output ONLY valid JSON — no dotenv tips, no warnings
  process.stdout.write(JSON.stringify(output) + '\n');
  
  await shutdown();
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
