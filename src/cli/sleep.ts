#!/usr/bin/env npx tsx
/**
 * CLI for running sleep cycles
 * 
 * Usage:
 *   npx tsx src/cli/sleep.ts session   — Quick post-session consolidation
 *   npx tsx src/cli/sleep.ts nightly   — Deep nightly processing (LLM-powered)
 *   npx tsx src/cli/sleep.ts weekly    — Full maintenance cycle
 */

import 'dotenv/config';
import { sessionSleep, nightlySleep, weeklySleep } from '../engines/consolidation/sleep-cycle.js';

const cycle = process.argv[2] || 'session';

async function main() {
  console.log(`\n🧠 OpenMemory — Sleep Cycle: ${cycle}\n`);

  let result;
  switch (cycle) {
    case 'nightly':
      result = await nightlySleep();
      break;
    case 'weekly':
      result = await weeklySleep();
      break;
    case 'session':
      result = await sessionSleep();
      break;
    default:
      console.error(`Unknown cycle: ${cycle}. Use: session, nightly, or weekly`);
      process.exit(1);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Sleep Cycle: ${result.cycle}`);
  console.log(`  Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
  console.log(`  Episodes processed: ${result.episodes_processed}`);
  console.log(`  Insights extracted: ${result.insights_extracted}`);
  console.log(`  Lessons: +${result.lessons_learned} new, ${result.lessons_reinforced} reinforced`);
  console.log(`  Person model updates: ${result.person_model_updates}`);
  console.log(`  Identity affirmations: ${result.identity_affirmations}`);
  console.log(`  New relationships: ${result.new_relationships}`);
  console.log(`  Embeddings generated: ${result.embeddings_generated}`);
  console.log(`  Memories consolidated: ${result.memories_consolidated}`);
  console.log(`  Contradictions found: ${result.contradictions_found}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  process.exit(0);
}

main().catch(err => {
  console.error('Sleep cycle failed:', err);
  process.exit(1);
});
