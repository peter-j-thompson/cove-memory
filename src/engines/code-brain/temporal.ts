/**
 * Code Brain Temporal Layer — Architecture Evolution Tracking
 * 
 * This is what makes Code Brain unique. GitNexus snapshots the present.
 * We track how architecture EVOLVES over time.
 * 
 * "The code isn't just what it IS — it's what it's BECOMING."
 */

import { query } from '../../storage/db.js';
import type { ArchitectureSnapshot, ArchitectureDiff, CodeCommunity, CommunityRelation, ExecutionFlow } from './types.js';

// ============================================================
// SCHEMA (create table if not exists)
// ============================================================

export async function ensureTemporalSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS code_brain_snapshots (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      repo_name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      commit_hash TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      stats JSONB NOT NULL,
      communities JSONB NOT NULL,
      cross_community_relations JSONB NOT NULL,
      critical_symbols JSONB NOT NULL,
      flows JSONB NOT NULL,
      diff_from_previous JSONB,
      UNIQUE(repo_name, commit_hash)
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_code_brain_snapshots_repo 
    ON code_brain_snapshots(repo_name, timestamp DESC)
  `);
}

// ============================================================
// SNAPSHOT STORAGE
// ============================================================

/**
 * Store a snapshot and return its ID.
 */
export async function storeSnapshot(snapshot: ArchitectureSnapshot, diff: ArchitectureDiff | null): Promise<string> {
  const result = await query(
    `INSERT INTO code_brain_snapshots (id, repo_name, repo_path, commit_hash, timestamp, stats, communities, cross_community_relations, critical_symbols, flows, diff_from_previous)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (repo_name, commit_hash) DO UPDATE SET
       timestamp = $5,
       stats = $6,
       communities = $7,
       cross_community_relations = $8,
       critical_symbols = $9,
       flows = $10,
       diff_from_previous = $11
     RETURNING id`,
    [
      snapshot.id,
      snapshot.repoName,
      snapshot.repoPath,
      snapshot.commitHash,
      snapshot.timestamp,
      JSON.stringify(snapshot.stats),
      JSON.stringify(snapshot.communities),
      JSON.stringify(snapshot.crossCommunityRelations),
      JSON.stringify(snapshot.criticalSymbols),
      JSON.stringify(snapshot.flows),
      diff ? JSON.stringify(diff) : null,
    ]
  );
  return result.rows[0].id;
}

/**
 * Get the most recent snapshot for a repo.
 */
export async function getLatestSnapshot(repoName: string): Promise<ArchitectureSnapshot | null> {
  const result = await query(
    `SELECT * FROM code_brain_snapshots WHERE repo_name = $1 ORDER BY timestamp DESC LIMIT 1`,
    [repoName]
  );
  if (result.rows.length === 0) return null;
  return rowToSnapshot(result.rows[0]);
}

/**
 * Get snapshot history for a repo (most recent first).
 */
export async function getSnapshotHistory(repoName: string, limit = 20): Promise<ArchitectureSnapshot[]> {
  const result = await query(
    `SELECT * FROM code_brain_snapshots WHERE repo_name = $1 ORDER BY timestamp DESC LIMIT $2`,
    [repoName, limit]
  );
  return result.rows.map(rowToSnapshot);
}

function rowToSnapshot(row: Record<string, unknown>): ArchitectureSnapshot {
  return {
    id: row.id as string,
    repoName: row.repo_name as string,
    repoPath: row.repo_path as string,
    commitHash: row.commit_hash as string,
    timestamp: (row.timestamp as Date).toISOString(),
    stats: row.stats as ArchitectureSnapshot['stats'],
    communities: row.communities as CodeCommunity[],
    crossCommunityRelations: row.cross_community_relations as CommunityRelation[],
    criticalSymbols: row.critical_symbols as ArchitectureSnapshot['criticalSymbols'],
    flows: row.flows as ExecutionFlow[],
  };
}

// ============================================================
// DIFF ENGINE — Compare two snapshots
// ============================================================

/**
 * Compare a new snapshot against the previous one for the same repo.
 * Returns null if there's no previous snapshot (first sync).
 */
export function diffSnapshots(previous: ArchitectureSnapshot, current: ArchitectureSnapshot): ArchitectureDiff {
  const prev = previous;
  const curr = current;

  // Symbol changes
  const symbolsDelta = curr.stats.totalSymbols - prev.stats.totalSymbols;

  // Community changes
  const prevCommunities = new Set(prev.communities.map(c => c.label));
  const currCommunities = new Set(curr.communities.map(c => c.label));
  const communitiesAdded = [...currCommunities].filter(c => !prevCommunities.has(c));
  const communitiesRemoved = [...prevCommunities].filter(c => !currCommunities.has(c));

  // Communities that grew or shrunk
  const communitiesGrown: ArchitectureDiff['communitiesGrown'] = [];
  const communitiesShrunk: ArchitectureDiff['communitiesShrunk'] = [];
  for (const currComm of curr.communities) {
    const prevComm = prev.communities.find(c => c.label === currComm.label);
    if (!prevComm) continue;
    if (currComm.symbolCount > prevComm.symbolCount) {
      communitiesGrown.push({ name: currComm.label, oldSize: prevComm.symbolCount, newSize: currComm.symbolCount });
    } else if (currComm.symbolCount < prevComm.symbolCount) {
      communitiesShrunk.push({ name: currComm.label, oldSize: prevComm.symbolCount, newSize: currComm.symbolCount });
    }
  }

  // Coupling changes
  const prevRelKey = (r: CommunityRelation) => `${r.sourceCommunity}→${r.targetCommunity}`;
  const prevRelMap = new Map(prev.crossCommunityRelations.map(r => [prevRelKey(r), r]));
  const currRelMap = new Map(curr.crossCommunityRelations.map(r => [prevRelKey(r), r]));

  const newDependencies = curr.crossCommunityRelations.filter(r => !prevRelMap.has(prevRelKey(r)));
  const couplingIncreased = curr.crossCommunityRelations.filter(r => {
    const prevRel = prevRelMap.get(prevRelKey(r));
    return prevRel && r.callCount > prevRel.callCount;
  });
  const couplingDecreased = curr.crossCommunityRelations.filter(r => {
    const prevRel = prevRelMap.get(prevRelKey(r));
    return prevRel && r.callCount < prevRel.callCount;
  });

  // Flow changes
  const prevFlowSummaries = new Set(prev.flows.map(f => f.summary));
  const currFlowSummaries = new Set(curr.flows.map(f => f.summary));
  const newFlows = curr.flows.filter(f => !prevFlowSummaries.has(f.summary));
  const removedFlows = [...prevFlowSummaries].filter(s => !currFlowSummaries.has(s));

  // Overall drift assessment
  let overallDrift: ArchitectureDiff['overallDrift'] = 'stable';
  if (communitiesAdded.length > 2 || communitiesRemoved.length > 2) {
    overallDrift = 'restructuring';
  } else if (symbolsDelta > prev.stats.totalSymbols * 0.1) {
    overallDrift = 'growing';
  } else if (symbolsDelta < -prev.stats.totalSymbols * 0.05) {
    overallDrift = 'shrinking';
  }

  // Risk flags
  const riskFlags: string[] = [];
  if (couplingIncreased.length > 3) {
    riskFlags.push(`Cross-community coupling increasing in ${couplingIncreased.length} relationships — watch for spaghetti`);
  }
  for (const grown of communitiesGrown) {
    if (grown.newSize > grown.oldSize * 1.3) {
      riskFlags.push(`${grown.name} grew ${((grown.newSize / grown.oldSize - 1) * 100).toFixed(0)}% — may need decomposition`);
    }
  }
  if (newDependencies.length > 2) {
    riskFlags.push(`${newDependencies.length} new cross-community dependencies introduced`);
  }
  if (removedFlows.length > 5) {
    riskFlags.push(`${removedFlows.length} execution flows disappeared — potential broken paths`);
  }

  return {
    repoName: curr.repoName,
    fromCommit: prev.commitHash,
    toCommit: curr.commitHash,
    fromTimestamp: prev.timestamp,
    toTimestamp: curr.timestamp,
    symbolsAdded: Math.max(0, symbolsDelta),
    symbolsRemoved: Math.abs(Math.min(0, symbolsDelta)),
    symbolsDelta,
    communitiesAdded,
    communitiesRemoved,
    communitiesGrown,
    communitiesShrunk,
    couplingIncreased,
    couplingDecreased,
    newDependencies,
    newFlows,
    removedFlows,
    overallDrift,
    riskFlags,
  };
}
