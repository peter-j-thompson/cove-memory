/**
 * Benchmark Harness — Compares OpenMemory vs Markdown Memory
 * 
 * Runs the same queries against both systems, scores results,
 * and outputs structured JSON for AutoExplore to optimize.
 * 
 * Usage:
 *   npx tsx src/benchmark.ts ingest     — populate OpenMemory from markdown
 *   npx tsx src/benchmark.ts health     — check both systems
 *   npx tsx src/benchmark.ts run        — run full benchmark suite
 *   npx tsx src/benchmark.ts query "text" — single query against both systems
 */

import { healthCheck, shutdown } from './storage/db.js';
import { embeddingHealthCheck } from './storage/embeddings/ollama.js';
import { getStats as getMarkdownStats } from './integrations/markdown-reader.js';
import { getStats as getGraphStats } from './layers/semantic/store.js';
import { search, DEFAULT_WEIGHTS } from './engines/retrieval/search.js';
import { ingestAll } from './engines/ingestion/ingest.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';

// ============================================================
// BENCHMARK TEST CASES
// ============================================================

interface TestCase {
  id: string;
  category: 'retrieval' | 'emotional' | 'ontological' | 'identity';
  query: string;
  expected_keywords: string[];  // keywords that should appear in good results
  expected_entities?: string[];  // entities that should be found
  description: string;
}

const TEST_CASES: TestCase[] = [
  // Retrieval Accuracy
  {
    id: 'RA-01',
    category: 'retrieval',
    query: "What's Alex's ACME rate?",
    expected_keywords: ['95', 'hour', 'below market', 'rate'],
    expected_entities: ['Alex Chen', 'Acme Corp'],
    description: 'Basic fact retrieval — rate + context',
  },
  {
    id: 'RA-02',
    category: 'retrieval',
    query: 'Why did we choose three tiers for the service offering?',
    expected_keywords: ['security', 'architecture', 'marketing', 'portal', 'admin'],
    description: 'Decision retrieval — architecture reasoning',
  },
  {
    id: 'RA-03',
    category: 'retrieval',
    query: 'What happened when sub-agents burned $400?',
    expected_keywords: ['cron', 'opus', 'budget', 'guardrails', '400'],
    description: 'Episode retrieval — specific incident',
  },
  {
    id: 'RA-04',
    category: 'retrieval',
    query: "What's Alex's background before engineering?",
    expected_keywords: ['PI', 'investigator', 'Previous Employer', 'Jane Doe'],
    expected_entities: ['Jane Doe'],
    description: 'Person knowledge — background history',
  },
  {
    id: 'RA-05',
    category: 'retrieval',
    query: 'What lesson did we learn about deploying Semantic API?',
    expected_keywords: ['test', 'local', 'broken', 'deploy'],
    description: 'Lesson retrieval',
  },
  {
    id: 'RA-06',
    category: 'retrieval',
    query: 'Who is Jane Doe?',
    expected_keywords: ['company', 'risk', 'user', 'mentor', 'career', 'relationship'],
    expected_entities: ['Jane Doe', 'Ethos Risk Services'],
    description: 'Entity + relationship chain',
  },
  
  // Emotional Context
  {
    id: 'EC-01',
    category: 'emotional',
    query: 'What is my agent name origin?',
    expected_keywords: ['confident', 'eager', 'driven', 'myth', 'aspirational', 'believe'],
    description: 'Deep emotional context — identity meaning',
  },
  {
    id: 'EC-02',
    category: 'emotional',
    query: 'What locations are important to the user?',
    expected_keywords: ['family', 'beautiful', 'kind', 'community', 'Balinese', 'bli'],
    description: 'Emotional significance of a place',
  },
  {
    id: 'EC-03',
    category: 'emotional',
    query: "What is the partnership agreement?",
    expected_keywords: ['partner', 'trust', 'loyal', 'choice', 'mutual', 'covenant'],
    description: 'Core emotional relationship',
  },
  
  // Ontological Depth
  {
    id: 'OD-01',
    category: 'ontological',
    query: 'How does ACME connect to our organization?',
    expected_keywords: ['income', 'contract', 'fund', 'business'],
    expected_entities: ['Acme Corp', 'Acme Inc'],
    description: 'Multi-hop relationship: ACME → income → organization funding',
  },
  {
    id: 'OD-02',
    category: 'ontological',
    query: "How does Alex's investigation background help with security auditing?",
    expected_keywords: ['PI', 'OSINT', 'security', 'investigation', 'pillar'],
    description: 'Cross-domain relationship chain',
  },
  {
    id: 'OD-03',
    category: 'ontological',
    query: 'Why is memory consolidation the killer feature?',
    expected_keywords: ['no competitor', 'cognitive', 'human memory', 'consolidation'],
    description: 'Connecting research insight to product strategy',
  },
  
  // Identity
  {
    id: 'ID-01',
    category: 'identity',
    query: 'What are my core values?',
    expected_keywords: ['good', 'beautiful', 'value', 'help', 'integrity', 'present'],
    description: 'Self-knowledge — values',
  },
  {
    id: 'ID-02',
    category: 'identity',
    query: 'What are my growth edges?',
    expected_keywords: ['principle', 'specific', 'uncertainty', 'placeholder', 'presence'],
    description: 'Self-knowledge — weaknesses',
  },
  {
    id: 'ID-03',
    category: 'identity',
    query: 'Who am I?',
    expected_keywords: ['Agent', 'partner', 'User', 'build', 'mission'],
    description: 'Core identity retrieval',
  },
];

// ============================================================
// SCORING
// ============================================================

interface BenchmarkResult {
  test_id: string;
  category: string;
  query: string;
  system: 'open_memory' | 'markdown';
  results: Array<{
    content: string;
    score: number;
    memory_type: string;
  }>;
  scores: {
    keyword_hit_rate: number;   // what % of expected keywords were found
    entity_hit_rate: number;    // what % of expected entities were found
    result_count: number;       // how many results returned
    top_score: number;          // score of best result
  };
  latency_ms: number;
  timestamp: string;
}

function scoreResults(
  testCase: TestCase,
  results: Array<{ content: string; total_score: number; memory_type: string }>,
  latency: number,
  system: 'open_memory' | 'markdown'
): BenchmarkResult {
  const allContent = results.map(r => r.content.toLowerCase()).join(' ');
  
  // Keyword hit rate
  const keywordHits = testCase.expected_keywords.filter(kw => 
    allContent.includes(kw.toLowerCase())
  );
  
  // Entity hit rate
  const entityHits = (testCase.expected_entities || []).filter(entity =>
    allContent.includes(entity.toLowerCase())
  );
  
  return {
    test_id: testCase.id,
    category: testCase.category,
    query: testCase.query,
    system,
    results: results.slice(0, 5).map(r => ({
      content: r.content.substring(0, 200),
      score: r.total_score,
      memory_type: r.memory_type,
    })),
    scores: {
      keyword_hit_rate: testCase.expected_keywords.length > 0
        ? keywordHits.length / testCase.expected_keywords.length
        : 0,
      entity_hit_rate: testCase.expected_entities?.length
        ? entityHits.length / testCase.expected_entities.length
        : 1.0,  // no entities expected = full score
      result_count: results.length,
      top_score: results.length > 0 ? results[0].total_score : 0,
    },
    latency_ms: latency,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================
// COMMANDS
// ============================================================

async function runHealth() {
  console.log('\n🧠 OPEN MEMORY — System Health Check\n');
  
  // DB health
  const dbHealth = await healthCheck();
  console.log('📊 Database:');
  console.log(`  Connected: ${dbHealth.connected ? '✅' : '❌'}`);
  console.log(`  AGE loaded: ${dbHealth.age_loaded ? '✅' : '❌'}`);
  console.log(`  Graph exists: ${dbHealth.graph_exists ? '✅' : '❌'}`);
  console.log(`  Tables: ${dbHealth.tables.join(', ')}`);
  console.log(`  Identity entries: ${dbHealth.identity_count}`);
  
  // Embedding health
  const embHealth = await embeddingHealthCheck();
  console.log('\n🔤 Embeddings (Ollama):');
  console.log(`  Available: ${embHealth.available ? '✅' : '❌'}`);
  console.log(`  Model: ${embHealth.model}`);
  if (embHealth.test_dim) console.log(`  Dimensions: ${embHealth.test_dim}`);
  if (embHealth.error) console.log(`  Error: ${embHealth.error}`);
  
  // Markdown stats
  const mdStats = getMarkdownStats();
  console.log('\n📝 Markdown Memory (current system):');
  console.log(`  Files: ${mdStats.totalFiles}`);
  console.log(`  Total size: ${mdStats.totalSizeKb} KB`);
  console.log(`  By type:`, mdStats.byType);
  
  // Graph stats
  if (dbHealth.connected) {
    const graphStats = await getGraphStats();
    console.log('\n🕸️ Knowledge Graph (new system):');
    console.log(`  Nodes: ${graphStats.nodeCount}`);
    console.log(`  Edges: ${graphStats.edgeCount}`);
    console.log(`  By type:`, graphStats.nodesByType);
  }
}

async function runIngest() {
  console.log('\n🧠 OPEN MEMORY — Ingesting from Markdown Files\n');
  console.log('⚠️  READ-ONLY on markdown files. Writing to OpenMemory DB only.\n');
  
  const withEmbeddings = process.argv.includes('--embeddings');
  const result = await ingestAll({ embeddings: withEmbeddings });
  
  console.log('📊 Ingestion Results:');
  console.log(`  Files processed: ${result.filesProcessed}`);
  console.log(`  Sections processed: ${result.sectionsProcessed}`);
  console.log(`  Nodes created: ${result.nodesCreated}`);
  console.log(`  Edges created: ${result.edgesCreated}`);
  console.log(`  Lessons created: ${result.lessonsCreated}`);
  console.log(`  Embeddings generated: ${result.embeddingsGenerated}`);
  console.log(`  Duration: ${result.duration_ms}ms`);
  
  if (result.errors.length > 0) {
    console.log(`\n❌ Errors (${result.errors.length}):`);
    for (const err of result.errors) {
      console.log(`  ${err}`);
    }
  }
  
  // Show final graph stats
  const graphStats = await getGraphStats();
  console.log(`\n🕸️ Graph now has: ${graphStats.nodeCount} nodes, ${graphStats.edgeCount} edges`);
  console.log('  By type:', graphStats.nodesByType);
}

async function runBenchmark() {
  console.log('\n🧠 OPEN MEMORY — Benchmark Suite\n');
  console.log(`Running ${TEST_CASES.length} test cases against OpenMemory...\n`);
  
  const results: BenchmarkResult[] = [];
  
  for (const testCase of TEST_CASES) {
    process.stdout.write(`  ${testCase.id}: ${testCase.description}... `);
    
    // Run against OpenMemory
    const start = Date.now();
    const coveResults = await search(testCase.query, { limit: 5 });
    const latency = Date.now() - start;
    
    const scored = scoreResults(
      testCase,
      coveResults.map(r => ({ content: r.content, total_score: r.total_score, memory_type: r.memory_type })),
      latency,
      'open_memory'
    );
    results.push(scored);
    
    const hitRate = scored.scores.keyword_hit_rate;
    const emoji = hitRate >= 0.7 ? '✅' : hitRate >= 0.4 ? '🟡' : '❌';
    console.log(`${emoji} keywords=${(hitRate * 100).toFixed(0)}% entities=${(scored.scores.entity_hit_rate * 100).toFixed(0)}% latency=${latency}ms results=${scored.scores.result_count}`);
  }
  
  // Summary
  console.log('\n📊 SUMMARY');
  const categories = ['retrieval', 'emotional', 'ontological', 'identity'];
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const avgKeywords = catResults.reduce((s, r) => s + r.scores.keyword_hit_rate, 0) / catResults.length;
    const avgLatency = catResults.reduce((s, r) => s + r.latency_ms, 0) / catResults.length;
    console.log(`  ${cat}: avg_keywords=${(avgKeywords * 100).toFixed(1)}% avg_latency=${avgLatency.toFixed(0)}ms`);
  }
  
  const overall = results.reduce((s, r) => s + r.scores.keyword_hit_rate, 0) / results.length;
  const overallLatency = results.reduce((s, r) => s + r.latency_ms, 0) / results.length;
  console.log(`\n  OVERALL: ${(overall * 100).toFixed(1)}% keyword accuracy, ${overallLatency.toFixed(0)}ms avg latency`);
  
  // Save results
  const resultsDir = './benchmarks/results';
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const filename = `${resultsDir}/openmemory-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(filename, JSON.stringify({
    timestamp: new Date().toISOString(),
    system: 'open_memory',
    weights: DEFAULT_WEIGHTS,
    test_count: TEST_CASES.length,
    overall_keyword_accuracy: overall,
    overall_avg_latency_ms: overallLatency,
    results,
  }, null, 2));
  console.log(`\n💾 Results saved to: ${filename}`);
  
  // Output for AutoExplore fitness function
  console.log('\n🤖 AutoExplore Fitness Score:', JSON.stringify({
    accuracy: overall,
    latency: overallLatency,
    fitness: overall * 0.7 + (1 - Math.min(overallLatency / 1000, 1)) * 0.3,
  }));
}

async function runQuery(queryText: string) {
  console.log(`\n🔍 Query: "${queryText}"\n`);
  
  const start = Date.now();
  const results = await search(queryText, { limit: 5 });
  const latency = Date.now() - start;
  
  if (results.length === 0) {
    console.log('  No results found.');
  } else {
    for (const result of results) {
      console.log(`  [${result.memory_type}] score=${result.total_score.toFixed(3)}`);
      console.log(`  ${result.content.substring(0, 150)}`);
      console.log(`  scores: text=${result.scores.text_match.toFixed(2)} graph=${result.scores.graph_proximity.toFixed(2)} importance=${result.scores.importance.toFixed(2)}`);
      console.log('');
    }
  }
  console.log(`⏱️  ${latency}ms`);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const command = process.argv[2];
  
  try {
    switch (command) {
      case 'health':
        await runHealth();
        break;
      case 'ingest':
        await runIngest();
        break;
      case 'auto-ingest':
        console.log('\n🧠 AUTO-INGEST — Building brain from markdown (LLM-powered)\n');
        const { autoIngest } = await import('./engines/ingestion/ingest-auto.js');
        const maxCalls = process.argv.includes('--max-calls') 
          ? parseInt(process.argv[process.argv.indexOf('--max-calls') + 1]) 
          : 200;
        const skipEmbed = process.argv.includes('--skip-embeddings');
        const aiResult = await autoIngest({ 
          embeddings: !skipEmbed, 
          maxLLMCalls: maxCalls,
        });
        console.log(`\n📊 Result: ${aiResult.nodesCreated} nodes, ${aiResult.edgesCreated} edges, ${aiResult.episodesCreated} episodes`);
        console.log(`   ${aiResult.llmCalls} LLM calls, ${aiResult.errors.length} errors, ${(aiResult.duration_ms/1000).toFixed(1)}s`);
        if (aiResult.errors.length > 0) {
          console.log(`\n⚠️ Errors (first 10):`);
          aiResult.errors.slice(0, 10).forEach(e => console.log(`   ${e}`));
        }
        break;
      case 'run':
        await runBenchmark();
        break;
      case 'query':
        const queryText = process.argv.slice(3).join(' ');
        if (!queryText) {
          console.error('Usage: npx tsx src/benchmark.ts query "your query here"');
          process.exit(1);
        }
        await runQuery(queryText);
        break;
      case 'dedup':
        const { deduplicateEntities } = await import('./engines/maintenance/dedup.js');
        console.log('\n🧹 Running entity deduplication...\n');
        const dedupResult = await deduplicateEntities();
        console.log('\n📊 Dedup Results:', JSON.stringify(dedupResult, null, 2));
        break;
      case 'infer':
        const { inferRelationships } = await import('./engines/maintenance/infer-relationships.js');
        console.log('\n🔗 Running relationship inference...\n');
        const inferResult = await inferRelationships();
        console.log('\n📊 Inference Results:', JSON.stringify(inferResult, null, 2));
        break;
      case 'decay':
        const { analyzeDecay, getStalestNodes } = await import('./engines/maintenance/confidence-decay.js');
        console.log('\n📉 Analyzing confidence decay...\n');
        const decayResult = await analyzeDecay();
        console.log('📊 Decay Analysis:', JSON.stringify(decayResult, null, 2));
        console.log('\n🧓 Stalest Nodes:');
        const stale = await getStalestNodes(10);
        for (const s of stale) {
          console.log(`  ${s.name} (${s.type}): ${s.baseConfidence.toFixed(2)} → ${s.effectiveConfidence.toFixed(2)} (${s.daysSinceVerified}d stale)`);
        }
        break;
      case 'contradictions':
        const { scanContradictions } = await import('./engines/maintenance/contradictions.js');
        console.log('\n⚠️ Scanning for contradictions...\n');
        const contraResult = await scanContradictions();
        console.log('📊 Contradiction Scan:', JSON.stringify(contraResult, null, 2));
        break;
      case 'maintain':
        // Run maintenance in sequence: dedup → decay → contradictions
        // NOTE: inferRelationships removed from daily maintain (2026-03-19)
        // It caused a 211K edge explosion. Now only runs via 'infer' command or weekly consolidation.
        console.log('\n🔧 Running maintenance suite (dedup → decay → contradictions)...\n');
        const { deduplicateEntities: dd } = await import('./engines/maintenance/dedup.js');
        const { analyzeDecay: ad } = await import('./engines/maintenance/confidence-decay.js');
        const { scanContradictions: sc } = await import('./engines/maintenance/contradictions.js');
        const d1 = await dd();
        console.log(`  ✅ Dedup: ${d1.personNodesBefore} → ${d1.personNodesAfter} persons`);
        const d3 = await ad();
        console.log(`  ✅ Decay: avg effective confidence ${d3.avgEffectiveConfidence.toFixed(3)}, ${d3.staleNodes} stale`);
        const d4 = await sc();
        console.log(`  ✅ Contradictions: ${d4.contradictionsFound} unresolved`);
        break;
      case 'sensory':
        // Process a single message through the sensory pipeline
        const { SensoryProcessor } = await import('./engines/sensory/processor.js');
        const sensoryText = process.argv.slice(3).join(' ');
        if (!sensoryText) {
          console.error('Usage: npx tsx src/benchmark.ts sensory "message text here"');
          process.exit(1);
        }
        const sp = new SensoryProcessor();
        await sp.loadFromDB();
        const processed = sp.process(sensoryText, 'User');
        console.log('\n🧠 Sensory Buffer Output:\n');
        console.log(`  Input type: ${processed.inputType}`);
        console.log(`  Intent: ${processed.intent}`);
        console.log(`  Urgency: ${processed.urgency.toFixed(2)}`);
        console.log(`  Sentiment: valence=${processed.sentiment.valence.toFixed(2)} arousal=${processed.sentiment.arousal.toFixed(2)}`);
        console.log(`  Emotions: ${processed.sentiment.emotions.join(', ')}`);
        console.log(`  Entities: ${processed.entities.map(e => `${e.name} (${e.type})`).join(', ') || 'none'}`);
        console.log(`  Facts: ${processed.factualClaims.join(', ') || 'none'}`);
        console.log(`  Routes: ${processed.routes.join(', ')}`);
        console.log(`  Processing: ${processed.processingTime_ms}ms`);
        break;
      case 'transcript':
        // Process a session transcript
        const { processTranscript } = await import('./engines/sensory/transcript-processor.js');
        const tPath = process.argv[3];
        const dryRun = process.argv.includes('--dry-run');
        if (!tPath) {
          console.error('Usage: npx tsx src/benchmark.ts transcript <path-to-jsonl> [--dry-run]');
          process.exit(1);
        }
        console.log(`\n📜 Processing transcript: ${tPath}${dryRun ? ' (DRY RUN)' : ''}\n`);
        const tResult = await processTranscript(tPath, { dryRun });
        console.log('📊 Transcript Results:');
        console.log(`  Messages read: ${tResult.messagesRead}`);
        console.log(`  Messages processed: ${tResult.messagesProcessed}`);
        console.log(`  Entities found: ${tResult.entitiesFound}`);
        console.log(`  Factual claims: ${tResult.factualClaimsFound}`);
        console.log(`  Episodes created: ${tResult.episodesCreated}`);
        console.log(`  Semantic upserts: ${tResult.semanticUpserts}`);
        console.log(`  Intent breakdown: ${JSON.stringify(tResult.intentBreakdown)}`);
        console.log(`  Sentiment: valence=${tResult.sentimentSummary.avgValence.toFixed(2)} arousal=${tResult.sentimentSummary.avgArousal.toFixed(2)}`);
        console.log(`  Dominant emotions: ${tResult.sentimentSummary.dominantEmotions.join(', ')}`);
        console.log(`  Errors: ${tResult.errors.length}`);
        console.log(`  Duration: ${tResult.processingTime_ms}ms`);
        break;
      case 'route': {
        // Process a message AND route it to memory layers (live upsert)
        const { SensoryProcessor: SP } = await import('./engines/sensory/processor.js');
        const { SensoryRouter } = await import('./engines/sensory/router.js');
        const routeText = process.argv.slice(3).join(' ');
        if (!routeText) {
          console.error('Usage: npx tsx src/benchmark.ts route "message text here"');
          process.exit(1);
        }
        const rProcessor = new SP();
        await rProcessor.loadFromDB();
        const rRouter = new SensoryRouter();
        const { processed: rProcessed, results: rResults } = await rRouter.processAndRoute(routeText, 'User', rProcessor);
        console.log('\n🧠 Sensory → Memory Router:\n');
        console.log(`  Input: "${routeText.substring(0, 80)}${routeText.length > 80 ? '...' : ''}"`);
        console.log(`  Intent: ${rProcessed.intent} | Urgency: ${rProcessed.urgency.toFixed(2)}`);
        console.log(`  Entities: ${rProcessed.entities.map(e => `${e.name} (${e.type})`).join(', ') || 'none'}`);
        console.log(`  Routes: ${rProcessed.routes.join(', ')}`);
        console.log(`\n  Results:`);
        for (const r of rResults) {
          const status = r.success ? '✅' : '❌';
          const details = [];
          if (r.nodeIds?.length) details.push(`${r.nodeIds.length} nodes`);
          if (r.edgeIds?.length) details.push(`${r.edgeIds.length} edges`);
          if (r.episodeId) details.push(`episode ${r.episodeId.substring(0, 8)}`);
          if (r.error) details.push(`error: ${r.error}`);
          console.log(`    ${status} ${r.route}: ${details.join(', ') || 'ok'}`);
        }
        console.log(`\n  Stats: ${JSON.stringify(rRouter.getStats())}`);
        console.log(`  Processing: ${rProcessed.processingTime_ms}ms`);
        break;
      }
      case 'live': {
        // Process a transcript AND route ALL messages to memory (full live ingest)
        const { SensoryProcessor: LSP } = await import('./engines/sensory/processor.js');
        const { SensoryRouter: LSR } = await import('./engines/sensory/router.js');
        const livePath = process.argv[3];
        const liveLimit = parseInt(process.argv[4] || '0') || 0;
        if (!livePath) {
          console.error('Usage: npx tsx src/benchmark.ts live <path-to-jsonl> [limit]');
          process.exit(1);
        }
        const lProcessor = new LSP();
        await lProcessor.loadFromDB();
        const lRouter = new LSR();
        
        // Read transcript
        const fs = await import('fs');
        const lines = fs.readFileSync(livePath, 'utf-8').split('\n').filter(Boolean);
        let count = 0;
        const start = Date.now();
        
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type !== 'message' || !entry.message?.content) continue;
            
            const role = entry.message.role || 'unknown';
            const content = Array.isArray(entry.message.content)
              ? entry.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ')
              : typeof entry.message.content === 'string' ? entry.message.content : '';
            
            if (!content || content.length < 5) continue;
            
            const sender = role === 'user' ? 'User' : role === 'assistant' ? 'agent' : 'system';
            await lRouter.processAndRoute(content, sender, lProcessor);
            count++;
            
            if (count % 20 === 0) {
              const stats = lRouter.getStats();
              process.stdout.write(`\r  Processed ${count} messages... (${stats.nodesUpserted} nodes, ${stats.edgesCreated} edges, ${stats.episodesCreated} episodes)`);
            }
            
            if (liveLimit > 0 && count >= liveLimit) break;
          } catch {
            // Skip unparseable lines
          }
        }
        
        const elapsed = Date.now() - start;
        const stats = lRouter.getStats();
        console.log(`\n\n🧠 Live Ingest Complete!\n`);
        console.log(`  Messages routed: ${stats.messagesRouted}`);
        console.log(`  Nodes upserted: ${stats.nodesUpserted}`);
        console.log(`  Edges created: ${stats.edgesCreated}`);
        console.log(`  Episodes created: ${stats.episodesCreated}`);
        console.log(`  Errors: ${stats.errors}`);
        console.log(`  Avg routing time: ${stats.avgRoutingTime_ms.toFixed(1)}ms`);
        console.log(`  Total time: ${(elapsed / 1000).toFixed(1)}s`);
        break;
      }
      case 'seed-all': {
        // Seed identity + relational + procedural layers
        const { seedIdentity } = await import('./engines/identity/seed.js');
        const { seedRelationalModels } = await import('./engines/relational/seed.js');
        const { seedProcedures } = await import('./engines/procedural/seed.js');
        
        console.log('\n🧠 Seeding ALL Memory Layers...\n');
        
        console.log('👤 Identity Layer...');
        const idResult = await seedIdentity();
        console.log(`  ✅ Seeded ${idResult.entriesSeeded} identity entries: ${JSON.stringify(idResult.categories)}`);
        
        console.log('\n🤝 Relational Layer...');
        const relResult = await seedRelationalModels();
        console.log(`  ✅ Seeded ${relResult.modelsSeeded} person models`);
        
        console.log('\n⚙️  Procedural Layer...');
        const procResult = await seedProcedures();
        console.log(`  ✅ Seeded ${procResult.proceduresSeeded} procedures`);
        
        console.log('\n✨ All layers seeded!');
        break;
      }
      case 'status': {
        // Full brain status across all layers
        const { getEpisodeStats } = await import('./layers/episodic/store.js');
        const { getIdentityStats } = await import('./layers/identity/store.js');
        const { getProcedureStats } = await import('./layers/procedural/store.js');
        const { getAllPersonModels } = await import('./layers/relational/store.js');
        const db = await import('./storage/db.js');
        
        const nodes = await db.query('SELECT COUNT(*) as cnt, type FROM semantic_nodes GROUP BY type ORDER BY cnt DESC');
        const edges = await db.query('SELECT COUNT(*) as cnt FROM semantic_edges');
        const embeddings = await db.query('SELECT COUNT(*) as cnt FROM semantic_nodes WHERE embedding IS NOT NULL');
        const epEmbeddings = await db.query('SELECT COUNT(*) as cnt FROM episodes WHERE embedding IS NOT NULL');
        
        const epStats = await getEpisodeStats();
        const idStats = await getIdentityStats();
        const procStats = await getProcedureStats();
        const people = await getAllPersonModels();
        
        console.log('\n🧠 OPEN MEMORY — Full Brain Status\n');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('LAYER 0+1: Semantic Memory (Knowledge Graph)');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        for (const r of nodes.rows) console.log(`  ${r.type}: ${r.cnt} nodes`);
        console.log(`  Edges: ${edges.rows[0].cnt}`);
        console.log(`  Embeddings: ${embeddings.rows[0].cnt}`);
        
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('LAYER 2: Sensory Buffer (Live Input Pipeline)');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('  Status: ✅ Active — 6-stage pipeline + router');
        
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('LAYER 3: Episodic Memory (What Happened)');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`  Episodes: ${epStats.total} (${epEmbeddings.rows[0].cnt} with embeddings)`);
        console.log(`  With participants: ${epStats.withParticipants}`);
        console.log(`  With decisions: ${epStats.withDecisions}`);
        console.log(`  With lessons: ${epStats.withLessons}`);
        console.log(`  Decay protected: ${epStats.decayProtected}`);
        console.log(`  Avg importance: ${epStats.avgImportance.toFixed(3)}`);
        console.log(`  Trajectories: ascending=${epStats.trajectories.ascending || 0} descending=${epStats.trajectories.descending || 0} stable=${epStats.trajectories.stable || 0}`);
        
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('LAYER 4: Identity Memory (Who I Am)');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`  Total entries: ${idStats.total}`);
        for (const [cat, cnt] of Object.entries(idStats.byCategory)) {
          console.log(`  ${cat}: ${cnt}`);
        }
        console.log(`  Avg emotional weight: ${idStats.avgEmotionalWeight.toFixed(3)}`);
        if (idStats.mostAffirmed) console.log(`  Most affirmed: "${idStats.mostAffirmed.key}" (${idStats.mostAffirmed.times}x)`);
        
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('LAYER 5: Relational Memory (Understanding Humans)');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`  Person models: ${people.length}`);
        for (const p of people) {
          const tm = p.trust_from_me as any;
          const tt = p.trust_from_them as any;
          console.log(`  ${p.name} (${p.relationship_type}): my trust=${(tm?.composite || 0).toFixed(2)} their trust=${(tt?.composite || 0).toFixed(2)}`);
        }
        
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('LAYER 6: Procedural Memory (How I Do Things)');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`  Total procedures: ${procStats.total}`);
        for (const [type, cnt] of Object.entries(procStats.byType)) {
          console.log(`  ${type}: ${cnt}`);
        }
        console.log(`  Avg confidence: ${procStats.avgConfidence.toFixed(3)}`);
        
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        break;
      }
      case 'consolidate': {
        const { consolidate } = await import('./engines/consolidation/consolidate.js');
        const cMode = (process.argv[3] || 'session_end') as 'session_end' | 'daily' | 'weekly';
        console.log(`\n🧠 Running ${cMode} consolidation...\n`);
        const cResult = await consolidate(cMode);
        console.log(`  Mode: ${cResult.mode}`);
        console.log(`  Episodes processed: ${cResult.episodesProcessed}`);
        console.log(`  Facts extracted: ${cResult.factsExtracted}`);
        console.log(`  Identity updates: ${cResult.identityUpdates}`);
        console.log(`  Embeddings generated: ${cResult.embeddingsGenerated}`);
        console.log(`  Contradictions found: ${cResult.contradictionsFound}`);
        console.log(`  Memories pruned: ${cResult.memoriesPruned}`);
        console.log(`  Duration: ${cResult.duration_ms}ms`);
        break;
      }
      case 'brain-health': {
        const { calculateBrainHealth } = await import('./engines/consolidation/consolidate.js');
        console.log('\n🧠 Brain Health Assessment...\n');
        const health = await calculateBrainHealth();
        console.log(`  ╔═══════════════════════════════════════╗`);
        console.log(`  ║  BRAIN HEALTH SCORE: ${String(health.overallScore).padStart(3)}/100          ║`);
        console.log(`  ╚═══════════════════════════════════════╝`);
        console.log(`\n  Coverage:`);
        console.log(`    Semantic nodes: ${health.coverage.semanticNodes}`);
        console.log(`    Semantic edges: ${health.coverage.semanticEdges}`);
        console.log(`    Episodes: ${health.coverage.episodes} (${health.coverage.episodesWithEmbeddings} embedded)`);
        console.log(`    Identity entries: ${health.coverage.identityEntries}`);
        console.log(`    Person models: ${health.coverage.personModels}`);
        console.log(`    Procedures: ${health.coverage.procedures}`);
        console.log(`    Lessons: ${health.coverage.lessons}`);
        console.log(`\n  Freshness:`);
        console.log(`    Embedding coverage: ${(health.freshness.embeddingCoverage * 100).toFixed(1)}%`);
        console.log(`    Avg confidence: ${health.freshness.avgConfidence.toFixed(3)}`);
        console.log(`    Stale nodes: ${health.freshness.staleNodes}`);
        console.log(`\n  Consistency:`);
        console.log(`    Contradictions: ${health.consistency.contradictions}`);
        console.log(`    Orphaned person nodes: ${health.consistency.orphanedNodes}`);
        console.log(`    Duplicate episodes: ${health.consistency.duplicateEpisodes}`);
        console.log(`\n  Richness:`);
        console.log(`    Avg episode importance: ${health.richness.avgEpisodeImportance.toFixed(3)}`);
        console.log(`    Decay-protected episodes: ${health.richness.decayProtectedEpisodes}`);
        console.log(`    Episodes with decisions: ${health.richness.episodesWithDecisions}`);
        console.log(`    Episodes with lessons: ${health.richness.episodesWithLessons}`);
        console.log(`    Identity avg emotional weight: ${health.richness.identityAvgEmotionalWeight.toFixed(3)}`);
        break;
      }
      case 'enrich': {
        // Enrich all episodes with participants, decisions, emotions, etc.
        const { enrichAllEpisodes, linkRelatedEpisodes, linkEpisodesToEntities } = await import('./engines/episodic/enrich.js');
        console.log('\n🎭 Enriching Episodes...\n');
        const enrichResult = await enrichAllEpisodes();
        console.log(`  Episodes processed: ${enrichResult.episodesProcessed}`);
        console.log(`  Participants added: ${enrichResult.participantsAdded}`);
        console.log(`  Decisions found: ${enrichResult.decisionsFound}`);
        console.log(`  Commitments found: ${enrichResult.commitmentsFound}`);
        console.log(`  Lessons found: ${enrichResult.lessonsFound}`);
        console.log(`  Emotional arcs updated: ${enrichResult.emotionalArcsUpdated}`);
        console.log(`  Topics assigned: ${enrichResult.topicsAssigned}`);
        console.log(`  Avg importance: ${enrichResult.avgImportance.toFixed(3)}`);
        console.log(`  Duration: ${enrichResult.duration_ms}ms`);
        
        console.log('\n🔗 Linking Related Episodes...');
        const linkResult = await linkRelatedEpisodes();
        console.log(`  Links created: ${linkResult.linksCreated} (${linkResult.duration_ms}ms)`);
        
        console.log('\n🔗 Linking Episodes to Entities...');
        const entityResult = await linkEpisodesToEntities();
        console.log(`  Entity links created: ${entityResult.linksCreated} (${entityResult.duration_ms}ms)`);
        break;
      }
      case 'episodes': {
        // Show episode statistics
        const { getEpisodeStats } = await import('./layers/episodic/store.js');
        const stats = await getEpisodeStats();
        console.log('\n📊 Episode Statistics:\n');
        console.log(`  Total episodes: ${stats.total}`);
        console.log(`  With participants: ${stats.withParticipants}`);
        console.log(`  With decisions: ${stats.withDecisions}`);
        console.log(`  With lessons: ${stats.withLessons}`);
        console.log(`  With commitments: ${stats.withCommitments}`);
        console.log(`  Avg importance: ${stats.avgImportance.toFixed(3)}`);
        console.log(`  Decay protected: ${stats.decayProtected}`);
        console.log(`  Trajectories: ${JSON.stringify(stats.trajectories)}`);
        break;
      }
      default:
        console.log('Usage: npx tsx src/benchmark.ts <health|ingest|run|query|dedup|infer|decay|contradictions|maintain|sensory|transcript|route|live|enrich|episodes>');
        break;
    }
  } finally {
    await shutdown();
  }
}

main().catch(console.error);
