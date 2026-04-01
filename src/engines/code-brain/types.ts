/**
 * Code Brain Bridge — Type Definitions
 * 
 * Types for the adapter pattern that bridges code intelligence tools
 * (GitNexus, future own parser) into OpenMemory's cognitive architecture.
 * 
 * Design principle: These types describe UNDERSTANDING, not raw AST data.
 * We don't store every function — we store architectural knowledge.
 */

// ============================================================
// ADAPTER OUTPUT TYPES (what any code intel tool must provide)
// ============================================================

export interface RepoStats {
  name: string;
  path: string;
  commitHash: string;
  indexedAt: string;
  totalFiles: number;
  totalSymbols: number;
  totalEdges: number;
  totalCommunities: number;
  totalFlows: number;
  languages: string[];
}

export interface CodeCommunity {
  id: string;
  label: string;
  symbolCount: number;
  cohesion: number;          // 0.0 to 1.0 — how tightly coupled internally
  keySymbols: string[];      // top symbols by centrality
  languages: string[];
}

export interface CommunityRelation {
  sourceCommunity: string;   // community label
  targetCommunity: string;
  callCount: number;         // number of cross-community CALLS edges
  strength: number;          // normalized 0.0-1.0
}

export interface CriticalSymbol {
  name: string;
  kind: 'function' | 'method' | 'class' | 'interface';
  filePath: string;
  startLine: number;
  community: string;
  incomingCalls: number;     // fan-in (how many things call this)
  outgoingCalls: number;     // fan-out (how many things this calls)
  processCount: number;      // how many execution flows include this
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export interface ExecutionFlow {
  id: string;
  summary: string;           // e.g. "LoadTransfers → GetSourceAddr"
  type: 'cross_community' | 'intra_community';
  stepCount: number;
  communities: string[];     // which communities this flow crosses
  entryPoint: string;        // starting symbol
  terminal: string;          // ending symbol
}

// ============================================================
// ADAPTER INTERFACE (swappable — GitNexus today, own parser tomorrow)
// ============================================================

export interface CodeIntelAdapter {
  readonly name: string;

  /** Check if the adapter tool is available */
  isAvailable(): Promise<boolean>;

  /** Check if a repo is indexed and up-to-date */
  isIndexed(repoPath: string): Promise<{ indexed: boolean; stale: boolean; commit?: string }>;

  /** Index/re-index a repository */
  analyze(repoPath: string, options?: { force?: boolean }): Promise<RepoStats>;

  /** Get high-level stats */
  getRepoStats(repoPath: string): Promise<RepoStats>;

  /** Get detected code communities/clusters */
  getCommunities(repoPath: string): Promise<CodeCommunity[]>;

  /** Get cross-community dependency relationships */
  getCrossCommunityCalls(repoPath: string): Promise<CommunityRelation[]>;

  /** Get high-impact symbols (entry points, high fan-out/fan-in) */
  getCriticalSymbols(repoPath: string, options?: { minCalls?: number }): Promise<CriticalSymbol[]>;

  /** Get execution flows */
  getFlows(repoPath: string): Promise<ExecutionFlow[]>;
}

// ============================================================
// TEMPORAL TYPES (architecture evolution tracking)
// ============================================================

export interface ArchitectureSnapshot {
  id: string;
  repoName: string;
  repoPath: string;
  commitHash: string;
  timestamp: string;
  stats: RepoStats;
  communities: CodeCommunity[];
  crossCommunityRelations: CommunityRelation[];
  criticalSymbols: CriticalSymbol[];
  flows: ExecutionFlow[];
}

export interface ArchitectureDiff {
  repoName: string;
  fromCommit: string;
  toCommit: string;
  fromTimestamp: string;
  toTimestamp: string;

  // Symbol changes
  symbolsAdded: number;
  symbolsRemoved: number;
  symbolsDelta: number;

  // Community changes
  communitiesAdded: string[];
  communitiesRemoved: string[];
  communitiesGrown: { name: string; oldSize: number; newSize: number }[];
  communitiesShrunk: { name: string; oldSize: number; newSize: number }[];

  // Coupling changes
  couplingIncreased: CommunityRelation[];
  couplingDecreased: CommunityRelation[];
  newDependencies: CommunityRelation[];

  // Flow changes
  newFlows: ExecutionFlow[];
  removedFlows: string[];        // flow summaries that disappeared

  // Risk assessment
  overallDrift: 'stable' | 'growing' | 'shrinking' | 'restructuring';
  riskFlags: string[];           // human-readable architectural warnings
}

// ============================================================
// SYNC TYPES
// ============================================================

export interface SyncResult {
  repoName: string;
  success: boolean;
  snapshot: ArchitectureSnapshot;
  diff: ArchitectureDiff | null;  // null on first sync
  brainWrites: {
    semanticNodes: number;
    semanticEdges: number;
    episodicEntries: number;
    proceduralRules: number;
  };
  durationMs: number;
}
