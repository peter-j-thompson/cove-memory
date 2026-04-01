#!/usr/bin/env npx tsx
/**
 * CLI for LLM-powered ingestion.
 * 
 * Usage:
 *   npx tsx src/cli/ingest-llm.ts                    # Full ingestion (all files)
 *   npx tsx src/cli/ingest-llm.ts --priority-only     # Only USER, IDENTITY, SOUL, MEMORY, TOOLS
 *   npx tsx src/cli/ingest-llm.ts --max-sections 10   # Limit sections (for testing)
 *   npx tsx src/cli/ingest-llm.ts --embeddings         # Also generate embeddings
 *   npx tsx src/cli/ingest-llm.ts --test               # Quick test: 5 sections, priority files
 */

import 'dotenv/config';
import { ingestAllLLM } from '../engines/ingestion/ingest-llm.js';

async function main() {
  const args = process.argv.slice(2);
  
  const isTest = args.includes('--test');
  const triageMode = args.includes('--triage');
  const priorityOnly = (args.includes('--priority-only') || isTest) && !triageMode;
  const embeddings = args.includes('--embeddings');
  const maxSectionsArg = args.find(a => a.startsWith('--max-sections'));
  const maxSections = isTest ? 5 : (maxSectionsArg ? parseInt(args[args.indexOf(maxSectionsArg) + 1]) : undefined);

  const mode = isTest ? 'TEST (5 sections, priority files)' 
    : triageMode ? 'TRIAGE (INGEST + SKIM files from manifest)' 
    : priorityOnly ? 'Priority files only' 
    : 'Full ingestion';

  console.log('🧠 OpenMemory — LLM-Powered Ingestion\n');
  console.log(`  Mode: ${mode}`);
  console.log(`  Embeddings: ${embeddings ? 'yes' : 'no'}`);
  if (maxSections) console.log(`  Max sections: ${maxSections}`);
  console.log();

  const result = await ingestAllLLM({
    embeddings,
    maxSections,
    priorityFilesOnly: priorityOnly,
    triageMode,
  });

  // Print errors if any
  if (result.errors.length > 0) {
    console.log(`\n⚠️  ${result.errors.length} errors:`);
    for (const err of result.errors.slice(0, 10)) {
      console.log(`  - ${err}`);
    }
    if (result.errors.length > 10) {
      console.log(`  ... and ${result.errors.length - 10} more`);
    }
  }

  console.log(`\n✅ Done in ${(result.duration_ms / 1000).toFixed(1)}s`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
