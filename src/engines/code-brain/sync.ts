/**
 * Code Brain Sync — Orchestrator
 * 
 * The main entry point for syncing a codebase into the brain.
 * Ties together: adapter → transformer → temporal → writer
 * 
 * Usage:
 *   import { syncRepo } from './sync.js';
 *   const result = await syncRepo('/path/to/repo');
 */

import { randomUUID } from 'node:crypto';
import { GitNexusAdapter } from './adapters/gitnexus.js';
import { transformSnapshot } from './transformer.js';
import { ensureTemporalSchema, getLatestSnapshot, storeSnapshot, diffSnapshots } from './temporal.js';
import { writeToBrain } from './writer.js';
import type { CodeIntelAdapter, ArchitectureSnapshot, SyncResult } from './types.js';

// Default adapter — swap this to change the code intel backend
let activeAdapter: CodeIntelAdapter = new GitNexusAdapter();

/**
 * Set the active code intelligence adapter.
 * Default: GitNexusAdapter
 */
export function setAdapter(adapter: CodeIntelAdapter): void {
  activeAdapter = adapter;
}

/**
 * Sync a repository's architecture into the brain.
 * 
 * 1. Check if repo is indexed (index if needed)
 * 2. Read code intelligence data via adapter
 * 3. Take architecture snapshot
 * 4. Diff against previous snapshot (temporal tracking)
 * 5. Transform into brain entities
 * 6. Write to semantic + episodic layers
 * 7. Store temporal snapshot
 */
export async function syncRepo(repoPath: string, options?: {
  forceReindex?: boolean;
  adapter?: CodeIntelAdapter;
}): Promise<SyncResult> {
  const start = Date.now();
  const adapter = options?.adapter || activeAdapter;

  console.log(`🧠 Code Brain: syncing ${repoPath} via ${adapter.name}...`);

  // Ensure temporal schema exists
  await ensureTemporalSchema();

  // 1. Check availability
  const available = await adapter.isAvailable();
  if (!available) {
    throw new Error(`Code intelligence adapter "${adapter.name}" is not available. Is it installed?`);
  }

  // 2. Check if indexed, index if needed
  const indexStatus = await adapter.isIndexed(repoPath);
  if (!indexStatus.indexed || indexStatus.stale || options?.forceReindex) {
    console.log(`  Indexing ${repoPath}...`);
    await adapter.analyze(repoPath, { force: options?.forceReindex });
  }

  // 3. Gather all intelligence data
  console.log('  Reading code intelligence...');
  const [stats, communities, crossComm, criticalSymbols, flows] = await Promise.all([
    adapter.getRepoStats(repoPath),
    adapter.getCommunities(repoPath),
    adapter.getCrossCommunityCalls(repoPath),
    adapter.getCriticalSymbols(repoPath),
    adapter.getFlows(repoPath),
  ]);

  // 4. Build snapshot
  const snapshot: ArchitectureSnapshot = {
    id: randomUUID(),
    repoName: stats.name,
    repoPath: stats.path,
    commitHash: stats.commitHash,
    timestamp: new Date().toISOString(),
    stats,
    communities,
    crossCommunityRelations: crossComm,
    criticalSymbols,
    flows,
  };

  console.log(`  Snapshot: ${stats.totalSymbols} symbols, ${communities.length} communities, ${criticalSymbols.length} critical symbols, ${flows.length} flows`);

  // 5. Diff against previous snapshot
  const previousSnapshot = await getLatestSnapshot(stats.name);
  let diff = null;
  if (previousSnapshot && previousSnapshot.commitHash !== snapshot.commitHash) {
    diff = diffSnapshots(previousSnapshot, snapshot);
    console.log(`  Diff: ${diff.symbolsDelta >= 0 ? '+' : ''}${diff.symbolsDelta} symbols, ${diff.communitiesAdded.length} new communities, ${diff.overallDrift} drift`);
    if (diff.riskFlags.length > 0) {
      console.log(`  ⚠️  Risk flags:`);
      for (const flag of diff.riskFlags) {
        console.log(`     - ${flag}`);
      }
    }
  } else if (previousSnapshot) {
    console.log('  Same commit as last sync — updating snapshot only');
  } else {
    console.log('  First sync for this repo — no diff available');
  }

  // 6. Transform into brain entities
  console.log('  Transforming to brain entities...');
  const transformed = transformSnapshot(snapshot);

  // If we have a diff, add a diff-specific episode
  if (diff) {
    const diffSummary = buildDiffSummary(diff);
    transformed.episodes.push({
      summary: diffSummary,
      context: `Architecture evolution from ${diff.fromCommit} to ${diff.toCommit}`,
      emotionalValence: diff.riskFlags.length > 0 ? -0.1 : 0.3,
      importance: diff.riskFlags.length > 0 ? 0.8 : 0.5,
      topics: ['code-brain', 'architecture-evolution', snapshot.repoName],
    });
  }

  // 7. Write to brain
  console.log(`  Writing to brain: ${transformed.nodes.length} nodes, ${transformed.edges.length} edges, ${transformed.episodes.length} episodes...`);
  const writeResult = await writeToBrain(transformed);

  // 8. Store temporal snapshot
  await storeSnapshot(snapshot, diff);

  const durationMs = Date.now() - start;
  console.log(`✅ Code Brain sync complete in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`   Brain writes: ${writeResult.semanticNodes} nodes, ${writeResult.semanticEdges} edges, ${writeResult.episodicEntries} episodes`);
  if (writeResult.errors.length > 0) {
    console.log(`   ⚠️  ${writeResult.errors.length} errors (non-fatal):`);
    for (const err of writeResult.errors.slice(0, 5)) {
      console.log(`      - ${err}`);
    }
  }

  return {
    repoName: stats.name,
    success: true,
    snapshot,
    diff,
    brainWrites: {
      semanticNodes: writeResult.semanticNodes,
      semanticEdges: writeResult.semanticEdges,
      episodicEntries: writeResult.episodicEntries,
      proceduralRules: 0, // Future: pattern detection
    },
    durationMs,
  };
}

/**
 * Build a human-readable diff summary for the episodic layer.
 */
function buildDiffSummary(diff: import('./types.js').ArchitectureDiff): string {
  const parts: string[] = [];
  parts.push(`${diff.repoName} architecture evolved (${diff.fromCommit} → ${diff.toCommit}):`);

  if (diff.symbolsDelta !== 0) {
    parts.push(`${diff.symbolsDelta >= 0 ? '+' : ''}${diff.symbolsDelta} symbols`);
  }
  if (diff.communitiesAdded.length > 0) {
    parts.push(`new communities: ${diff.communitiesAdded.join(', ')}`);
  }
  if (diff.communitiesRemoved.length > 0) {
    parts.push(`removed communities: ${diff.communitiesRemoved.join(', ')}`);
  }
  if (diff.communitiesGrown.length > 0) {
    parts.push(`growing: ${diff.communitiesGrown.map(c => `${c.name} (${c.oldSize}→${c.newSize})`).join(', ')}`);
  }
  if (diff.newFlows.length > 0) {
    parts.push(`${diff.newFlows.length} new execution flows`);
  }
  if (diff.riskFlags.length > 0) {
    parts.push(`⚠️ ${diff.riskFlags.join('; ')}`);
  }
  parts.push(`Overall drift: ${diff.overallDrift}`);

  return parts.join('. ');
}
