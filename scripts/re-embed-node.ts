import { query } from '../src/storage/db.js';
import { embed } from '../src/storage/embeddings/ollama.js';

const name = process.argv[2] || 'Memory Consolidation';

async function main() {
  const node = (await query("SELECT id, name, type, context, significance FROM semantic_nodes WHERE name = $1", [name])).rows[0];
  if (!node) { console.log('Node not found:', name); process.exit(1); }
  
  const text = `${node.type}: ${node.name}. ${node.context} ${node.significance}`.substring(0, 500);
  const result = await embed(text);
  await query('UPDATE semantic_nodes SET embedding = $1 WHERE id = $2', ['[' + result.embedding.join(',') + ']', node.id]);
  console.log(`Re-embedded "${node.name}" (${result.duration_ms}ms)`);
  process.exit(0);
}

main();
