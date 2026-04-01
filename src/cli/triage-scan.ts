/**
 * Triage Scanner — Light scan of markdown files to classify for ingestion priority.
 * 
 * Uses Sonnet to read headers + first 500 chars of each file, then classifies:
 *   🟢 INGEST  — High-value: decisions, relationships, identity, emotional moments, lessons
 *   🟡 SKIM    — Medium: extract entity names + top relationships only  
 *   🔴 SKIP    — Low: raw reference data, technical specs, logs, redundant research output
 * 
 * Output: JSON manifest at src/engines/ingestion/triage-manifest.json
 */

import * as fs from 'fs';
import * as path from 'path';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SONNET_MODEL = 'claude-sonnet-4-6';
const CLAWD_DIR = process.env.MEMORY_DIR || (process.env.HOME + '/memory');
const MEMORY_DIR = path.join(CLAWD_DIR, 'memory');

// Files already ingested (from the Opus run)
const ALREADY_INGESTED = new Set([
  'USER.md', 'IDENTITY.md', 'SOUL.md', 'MEMORY.md', 'TOOLS.md', // Customize for your agent's file layout
  'lessons.md', 'ai-certifications-research-2026-03-01.md',
  'ai-landscape-research-2026-02-23.md', 'ai-money-research.md',
]);

// Daily files already ingested
for (let m = 1; m <= 3; m++) {
  for (let d = 26; d <= 31; d++) {
    ALREADY_INGESTED.add(`2026-01-${String(d).padStart(2,'0')}.md`);
  }
  for (let d = 1; d <= 28; d++) {
    ALREADY_INGESTED.add(`2026-02-${String(d).padStart(2,'0')}.md`);
  }
  for (let d = 1; d <= 13; d++) {
    ALREADY_INGESTED.add(`2026-03-${String(d).padStart(2,'0')}.md`);
  }
}
ALREADY_INGESTED.add('2025-01-29.md');

interface TriageResult {
  file: string;
  relativePath: string;
  sizeBytes: number;
  priority: 'INGEST' | 'SKIM' | 'SKIP';
  reason: string;
  estimatedEntities: number;
  category: string;
}

interface TriageManifest {
  timestamp: string;
  totalFiles: number;
  alreadyIngested: number;
  scanned: number;
  results: {
    INGEST: TriageResult[];
    SKIM: TriageResult[];
    SKIP: TriageResult[];
  };
  estimatedCost: {
    opusIngestOnly: string;
    sonnetSkimOnly: string;
    totalEstimate: string;
  };
}

async function callSonnet(prompt: string): Promise<string> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Sonnet API error ${resp.status}: ${err}`);
  }

  const data = await resp.json() as any;
  return data.content?.[0]?.text || '';
}

function getFilePreview(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  
  // Extract headers (## lines)
  const headers = content.split('\n')
    .filter(l => l.startsWith('#'))
    .slice(0, 15)
    .join('\n');
  
  // First 500 chars of actual content
  const preview = content.slice(0, 500);
  
  return `HEADERS:\n${headers}\n\nPREVIEW:\n${preview}`;
}

function getAllMarkdownFiles(): { file: string; fullPath: string; relativePath: string; size: number }[] {
  const results: { file: string; fullPath: string; relativePath: string; size: number }[] = [];
  
  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const relativePath = path.relative(CLAWD_DIR, fullPath);
        const stat = fs.statSync(fullPath);
        results.push({ 
          file: entry.name, 
          fullPath, 
          relativePath,
          size: stat.size 
        });
      }
    }
  }
  
  // Scan memory/ directory and top-level config files
  walk(MEMORY_DIR);
  
  return results;
}

async function triageBatch(files: { file: string; fullPath: string; relativePath: string; size: number }[]): Promise<TriageResult[]> {
  // Build a single prompt with up to 10 files
  const fileDescriptions = files.map((f, i) => {
    const preview = getFilePreview(f.fullPath);
    return `--- FILE ${i + 1}: ${f.relativePath} (${f.size} bytes) ---\n${preview}\n`;
  }).join('\n');

  const prompt = `You are triaging markdown files for an AI cognitive memory system. The brain stores knowledge about people, relationships, decisions, lessons, emotions, and identity.

Classify each file into ONE of:
- INGEST: Contains decisions, relationship info, emotional moments, lessons learned, identity-relevant content, strategic thinking, personal interactions, or project milestones worth remembering.
- SKIM: Contains some useful entity names or relationships but is mostly reference/technical. Extract just names and top connections.
- SKIP: Raw technical specs, code logs, fleet logs, redundant multi-agent research output (if synthesis exists), raw data dumps, or content that doesn't help understand WHO we are or WHAT we decided.

For each file respond with EXACTLY this JSON format (no markdown, no explanation):
[
  {"idx": 1, "priority": "INGEST|SKIM|SKIP", "reason": "brief reason", "entities": <estimated count>, "category": "category label"}
]

FILES TO CLASSIFY:
${fileDescriptions}`;

  const response = await callSonnet(prompt);
  
  // Parse JSON from response — strip markdown code fences if present
  let cleaned = response.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error(`  [WARN] Could not parse response for batch, defaulting to SKIM`);
    console.error(`  [DEBUG] Raw response: ${response.slice(0, 200)}`);
    return files.map(f => ({
      file: f.file,
      relativePath: f.relativePath,
      sizeBytes: f.size,
      priority: 'SKIM' as const,
      reason: 'Parse error - defaulting to SKIM',
      estimatedEntities: 5,
      category: 'unknown',
    }));
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as any[];
    return parsed.map((p: any, i: number) => ({
      file: files[i].file,
      relativePath: files[i].relativePath,
      sizeBytes: files[i].size,
      priority: (['INGEST', 'SKIM', 'SKIP'].includes(p.priority) ? p.priority : 'SKIM') as 'INGEST' | 'SKIM' | 'SKIP',
      reason: p.reason || 'No reason given',
      estimatedEntities: p.entities || 0,
      category: p.category || 'uncategorized',
    }));
  } catch (e) {
    console.error(`  [WARN] JSON parse error, defaulting to SKIM`);
    return files.map(f => ({
      file: f.file,
      relativePath: f.relativePath,
      sizeBytes: f.size,
      priority: 'SKIM' as const,
      reason: 'Parse error',
      estimatedEntities: 5,
      category: 'unknown',
    }));
  }
}

async function main() {
  console.log('[TRIAGE] Starting light scan of remaining markdown files...');
  console.log(`[TRIAGE] Using ${SONNET_MODEL} for classification\n`);

  // Get all files, filter out already ingested
  const allFiles = getAllMarkdownFiles();
  const remaining = allFiles.filter(f => !ALREADY_INGESTED.has(f.file));

  console.log(`[TRIAGE] Total markdown files in memory/: ${allFiles.length}`);
  console.log(`[TRIAGE] Already ingested: ${allFiles.length - remaining.length}`);
  console.log(`[TRIAGE] Remaining to scan: ${remaining.length}\n`);

  const results: TriageResult[] = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
    const batch = remaining.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(remaining.length / BATCH_SIZE);
    
    console.log(`[TRIAGE] Batch ${batchNum}/${totalBatches} — scanning ${batch.map(f => f.file).join(', ')}`);
    
    try {
      const batchResults = await triageBatch(batch);
      results.push(...batchResults);
      
      // Print inline results
      for (const r of batchResults) {
        const icon = r.priority === 'INGEST' ? '🟢' : r.priority === 'SKIM' ? '🟡' : '🔴';
        console.log(`  ${icon} ${r.priority}: ${r.relativePath} — ${r.reason}`);
      }
    } catch (e: any) {
      console.error(`  [ERROR] Batch ${batchNum} failed: ${e.message}`);
      // Default unscanned files to SKIM
      for (const f of batch) {
        results.push({
          file: f.file,
          relativePath: f.relativePath,
          sizeBytes: f.size,
          priority: 'SKIM',
          reason: 'Scan failed',
          estimatedEntities: 5,
          category: 'unknown',
        });
      }
    }
    
    // Small delay between batches to be respectful
    await new Promise(r => setTimeout(r, 500));
  }

  // Build manifest
  const manifest: TriageManifest = {
    timestamp: new Date().toISOString(),
    totalFiles: allFiles.length,
    alreadyIngested: allFiles.length - remaining.length,
    scanned: results.length,
    results: {
      INGEST: results.filter(r => r.priority === 'INGEST'),
      SKIM: results.filter(r => r.priority === 'SKIM'),
      SKIP: results.filter(r => r.priority === 'SKIP'),
    },
    estimatedCost: { opusIngestOnly: '', sonnetSkimOnly: '', totalEstimate: '' },
  };

  // Estimate costs
  const ingestSections = manifest.results.INGEST.reduce((sum, r) => sum + Math.ceil(r.sizeBytes / 2000), 0);
  const skimSections = manifest.results.SKIM.reduce((sum, r) => sum + Math.ceil(r.sizeBytes / 4000), 0);
  
  const opusCost = (ingestSections * 2200 / 1_000_000) * 15 + (ingestSections * 200 / 1_000_000) * 75;
  const sonnetCost = (skimSections * 1500 / 1_000_000) * 3 + (skimSections * 150 / 1_000_000) * 15;
  
  manifest.estimatedCost = {
    opusIngestOnly: `$${opusCost.toFixed(2)}`,
    sonnetSkimOnly: `$${sonnetCost.toFixed(2)}`,
    totalEstimate: `$${(opusCost + sonnetCost).toFixed(2)}`,
  };

  // Save manifest
  const outPath = path.join(__dirname, '..', 'engines', 'ingestion', 'triage-manifest.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('[TRIAGE] SCAN COMPLETE');
  console.log('='.repeat(60));
  console.log(`🟢 INGEST (Opus):  ${manifest.results.INGEST.length} files`);
  console.log(`🟡 SKIM (Sonnet):  ${manifest.results.SKIM.length} files`);
  console.log(`🔴 SKIP:           ${manifest.results.SKIP.length} files`);
  console.log(`\nEstimated cost:`);
  console.log(`  Opus (INGEST):  ${manifest.estimatedCost.opusIngestOnly}`);
  console.log(`  Sonnet (SKIM):  ${manifest.estimatedCost.sonnetSkimOnly}`);
  console.log(`  TOTAL:          ${manifest.estimatedCost.totalEstimate}`);
  console.log(`\nManifest saved to: ${outPath}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
