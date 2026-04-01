/**
 * Code Brain Transformer — Normalize adapter output into brain entities
 * 
 * This is where raw code intelligence becomes UNDERSTANDING.
 * We don't store every function — we store architectural knowledge
 * that helps the brain reason about codebases.
 */

import type {
  RepoStats,
  CodeCommunity,
  CommunityRelation,
  CriticalSymbol,
  ExecutionFlow,
  ArchitectureSnapshot,
} from './types.js';

// ============================================================
// SEMANTIC NODE GENERATION
// ============================================================

interface BrainNode {
  type: 'project' | 'concept';
  name: string;
  aliases: string[];
  attributes: Record<string, unknown>;
  context: string;
  significance: string;
  confidence: number;
}

interface BrainEdge {
  sourceName: string;
  sourceType: string;
  targetName: string;
  targetType: string;
  relationship: string;
  category: string;
  strength: number;
  confidence: number;
  context: string;
}

interface EpisodicEntry {
  summary: string;
  context: string;
  emotionalValence: number;
  importance: number;
  topics: string[];
}

export interface TransformedOutput {
  nodes: BrainNode[];
  edges: BrainEdge[];
  episodes: EpisodicEntry[];
}

/**
 * Transform a full architecture snapshot into brain entities.
 */
export function transformSnapshot(snapshot: ArchitectureSnapshot): TransformedOutput {
  const nodes: BrainNode[] = [];
  const edges: BrainEdge[] = [];
  const episodes: EpisodicEntry[] = [];

  // 1. Repo-level node
  nodes.push(transformRepo(snapshot.stats));

  // 2. Top communities as concept nodes (only significant ones)
  const significantCommunities = snapshot.communities
    .filter(c => c.symbolCount >= 10)
    .slice(0, 20);

  for (const comm of significantCommunities) {
    nodes.push(transformCommunity(snapshot.repoName, comm));
    
    // Edge: community is part_of repo
    edges.push({
      sourceName: `${snapshot.repoName}:${comm.label}`,
      sourceType: 'concept',
      targetName: snapshot.repoName,
      targetType: 'project',
      relationship: 'part_of',
      category: 'structural',
      strength: comm.symbolCount / snapshot.stats.totalSymbols,
      confidence: 0.95,
      context: `Code community with ${comm.symbolCount} symbols (cohesion: ${comm.cohesion.toFixed(2)})`,
    });
  }

  // 3. Cross-community relationships → dependency edges
  for (const rel of snapshot.crossCommunityRelations) {
    edges.push(transformCommunityRelation(snapshot.repoName, rel, significantCommunities));
  }

  // 4. Critical symbols as concept nodes
  for (const sym of snapshot.criticalSymbols.filter(s => s.riskLevel !== 'low').slice(0, 15)) {
    nodes.push(transformCriticalSymbol(snapshot.repoName, sym));

    // Edge: symbol is part_of community (if known)
    if (sym.community) {
      edges.push({
        sourceName: `${snapshot.repoName}:${sym.name}`,
        sourceType: 'concept',
        targetName: `${snapshot.repoName}:${sym.community}`,
        targetType: 'concept',
        relationship: 'part_of',
        category: 'structural',
        strength: 0.8,
        confidence: 0.9,
        context: `${sym.riskLevel} risk symbol in ${sym.community}`,
      });
    }
  }

  // 5. Episodic entry for this snapshot
  episodes.push({
    summary: `Code Brain indexed ${snapshot.repoName}: ${snapshot.stats.totalSymbols} symbols, ${snapshot.stats.totalEdges} edges, ${snapshot.stats.totalCommunities} communities, ${snapshot.stats.totalFlows} execution flows at commit ${snapshot.commitHash}`,
    context: `Architecture snapshot of ${snapshot.repoName}. Top communities: ${significantCommunities.slice(0, 5).map(c => `${c.label} (${c.symbolCount})`).join(', ')}. Critical symbols: ${snapshot.criticalSymbols.filter(s => s.riskLevel !== 'low').length} found.`,
    emotionalValence: 0.2,  // neutral-positive (productive work)
    importance: 0.6,
    topics: ['code-brain', 'architecture', snapshot.repoName],
  });

  return { nodes, edges, episodes };
}

/**
 * Transform repo stats into a brain node.
 */
function transformRepo(stats: RepoStats): BrainNode {
  return {
    type: 'project',
    name: stats.name,
    aliases: [],
    attributes: {
      repo_path: stats.path,
      total_symbols: stats.totalSymbols,
      total_edges: stats.totalEdges,
      total_communities: stats.totalCommunities,
      total_flows: stats.totalFlows,
      total_files: stats.totalFiles,
      last_commit: stats.commitHash,
      last_indexed: stats.indexedAt,
      languages: stats.languages,
    },
    context: `Codebase with ${stats.totalSymbols} symbols across ${stats.totalCommunities} communities and ${stats.totalFlows} execution flows`,
    significance: 'active_project',
    confidence: 1.0,
  };
}

/**
 * Transform a code community into a brain concept node.
 */
function transformCommunity(repoName: string, comm: CodeCommunity): BrainNode {
  let significance = 'minor_module';
  if (comm.symbolCount >= 100) significance = 'major_module';
  else if (comm.symbolCount >= 50) significance = 'significant_module';

  return {
    type: 'concept',
    name: `${repoName}:${comm.label}`,
    aliases: [comm.label, `${repoName} ${comm.label}`],
    attributes: {
      community_id: comm.id,
      symbol_count: comm.symbolCount,
      cohesion: comm.cohesion,
      key_symbols: comm.keySymbols,
      repo: repoName,
    },
    context: `Code community in ${repoName} with ${comm.symbolCount} symbols and ${(comm.cohesion * 100).toFixed(0)}% internal cohesion`,
    significance,
    confidence: 0.9,
  };
}

/**
 * Transform a cross-community relationship into a brain edge.
 */
function transformCommunityRelation(
  repoName: string,
  rel: CommunityRelation,
  communities: CodeCommunity[]
): BrainEdge {
  // Resolve community IDs to labels
  const sourceComm = communities.find(c => c.id === rel.sourceCommunity);
  const targetComm = communities.find(c => c.id === rel.targetCommunity);
  const sourceLabel = sourceComm?.label || rel.sourceCommunity;
  const targetLabel = targetComm?.label || rel.targetCommunity;

  return {
    sourceName: `${repoName}:${sourceLabel}`,
    sourceType: 'concept',
    targetName: `${repoName}:${targetLabel}`,
    targetType: 'concept',
    relationship: 'depends_on',
    category: 'functional',
    strength: rel.strength,
    confidence: 0.85,
    context: `${rel.callCount} cross-community call chains from ${sourceLabel} to ${targetLabel}`,
  };
}

/**
 * Transform a critical symbol into a brain concept node.
 */
function transformCriticalSymbol(repoName: string, sym: CriticalSymbol): BrainNode {
  return {
    type: 'concept',
    name: `${repoName}:${sym.name}`,
    aliases: [sym.name],
    attributes: {
      kind: sym.kind,
      file_path: sym.filePath,
      start_line: sym.startLine,
      incoming_calls: sym.incomingCalls,
      outgoing_calls: sym.outgoingCalls,
      process_count: sym.processCount,
      risk_level: sym.riskLevel,
      repo: repoName,
    },
    context: `${sym.riskLevel} risk ${sym.kind} in ${repoName} at ${sym.filePath}:${sym.startLine} — ${sym.incomingCalls} callers, ${sym.outgoingCalls} callees`,
    significance: sym.riskLevel === 'critical' ? 'critical_symbol' : 'important_symbol',
    confidence: 0.9,
  };
}
