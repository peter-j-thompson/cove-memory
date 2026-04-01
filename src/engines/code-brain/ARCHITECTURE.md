# Code Brain Bridge — Architecture

## Principle
GitNexus is a black-box code intelligence tool. The Code Brain Bridge reads its output
and transforms it into cognitive entities that fit OpenMemory's existing 7-layer architecture.
If we ever swap GitNexus for our own parser, only the adapter changes.

## Design: Adapter Pattern + Temporal Snapshots

```
┌─────────────────────────────────────────────────────────┐
│                     Code Brain Bridge                    │
│                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────┐ │
│  │   Adapter     │───▶│  Transformer  │───▶│  Writer   │ │
│  │ (GitNexus CLI)│    │ (Normalize)   │    │ (Brain DB)│ │
│  └──────────────┘    └──────────────┘    └───────────┘ │
│         │                    │                    │      │
│         ▼                    ▼                    ▼      │
│  Read KuzuDB /       Map to Brain         Write to:     │
│  CLI output          entity types      - Semantic nodes  │
│                                        - Semantic edges  │
│                                        - Episodic entries│
│                                        - Temporal snaps  │
│                                        - Procedural rules│
└─────────────────────────────────────────────────────────┘
```

## What Goes Into the Brain (NOT raw data)

We do NOT dump 6,051 nodes into the brain. That's data, not understanding.

### Semantic Layer (Knowledge Graph)
New EntityType: 'codebase' (added to union type)

**Repo-level nodes:**
- Type: 'project', Name: 'my-app'
- Attributes: { total_symbols, total_edges, communities, flows, indexed_at, commit }

**Community-level nodes:**
- Type: 'concept', Name: 'my-app:Resolvers' (or 'my-app:Services', 'my-app:Models')
- Attributes: { symbol_count, cohesion, key_symbols[], languages[] }

**Key architectural relationships:**
- 'my-app:Resolvers' --depends_on--> 'my-app:Models'
- 'my-app:Resolvers' --depends_on--> 'my-app:Helpers'
- These come from cross-community CALLS edges in GitNexus

**Critical symbol nodes (entry points, high fan-out):**
- Type: 'concept', Name: 'my-app:UserResolver'
- Attributes: { file_path, callers_count, callees_count, risk_level }
- Only symbols with high blast radius — not every function

### Episodic Layer (What Changed)
Each sync creates an episodic entry:
- "my-app architecture snapshot: 6,051 symbols, 532 communities"
- On subsequent syncs: "my-app changed: +15 symbols, -2 communities, Resolvers grew by 8%"
- These become temporal breadcrumbs

### Temporal Layer (NEW — Architecture Evolution)
New table: `code_brain_snapshots`
- repo_name, commit_hash, timestamp
- summary_json: { nodes, edges, communities, flows, top_communities[], cross_community_calls }
- diff_from_previous: { added_symbols, removed_symbols, changed_communities, new_flows, broken_flows }

This is what GitNexus CAN'T do — track HOW architecture evolves over time.

### Procedural Layer
After multiple snapshots, detect patterns:
- "Resolvers community has grown 15% per week — may need decomposition"
- "CW Helpers haven't changed in 30 days despite active development — potential dead code"
- "Cross-community coupling between Models and Resolvers increasing — watch for tight coupling"

## Adapter Interface (Swappable)

```typescript
interface CodeIntelAdapter {
  name: string;
  
  // Get high-level stats for a repo
  getRepoStats(repoPath: string): Promise<RepoStats>;
  
  // Get communities/clusters
  getCommunities(repoPath: string): Promise<CodeCommunity[]>;
  
  // Get cross-community relationships
  getCrossCommunityCalls(repoPath: string): Promise<CommunityRelation[]>;
  
  // Get high-impact symbols (entry points, high fan-out)
  getCriticalSymbols(repoPath: string): Promise<CriticalSymbol[]>;
  
  // Get execution flows
  getFlows(repoPath: string): Promise<ExecutionFlow[]>;
}
```

GitNexusAdapter implements this by calling `gitnexus cypher` CLI commands.
Future: OwnParserAdapter implements this from our own Tree-sitter pipeline.

## Sync Flow

1. `code-brain sync <repo-path>` (CLI or API call)
2. Adapter reads GitNexus graph data
3. Transformer normalizes into brain entities
4. Snapshot taken and diffed against previous
5. Writer upserts semantic nodes/edges
6. Episodic entry created for the sync event
7. If enough snapshots exist, procedural patterns evaluated

## File Structure

```
src/engines/code-brain/
  ├── ARCHITECTURE.md          (this file)
  ├── types.ts                 (Code Brain specific types)
  ├── adapters/
  │   └── gitnexus.ts          (GitNexus CLI adapter)
  ├── transformer.ts           (Normalize adapter output → brain entities)
  ├── temporal.ts              (Snapshot storage + diff engine)
  ├── writer.ts                (Write to brain's semantic/episodic layers)
  ├── patterns.ts              (Procedural pattern detection)
  └── sync.ts                  (Orchestrator — ties it all together)
```
