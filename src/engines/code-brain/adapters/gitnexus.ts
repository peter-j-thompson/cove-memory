/**
 * GitNexus Adapter — Reads code intelligence data from GitNexus CLI
 * 
 * This adapter calls `gitnexus` CLI commands and parses their JSON output.
 * It's the ONLY file that knows about GitNexus. If we swap to our own parser,
 * we write a new adapter that implements CodeIntelAdapter — nothing else changes.
 * 
 * All queries use `gitnexus cypher` against GitNexus's KuzuDB graph.
 */

import { execSync, spawnSync } from 'node:child_process';
import type {
  CodeIntelAdapter,
  RepoStats,
  CodeCommunity,
  CommunityRelation,
  CriticalSymbol,
  ExecutionFlow,
} from '../types.js';

const GITNEXUS_TIMEOUT = 30_000; // 30 seconds max per command
const GITNEXUS_BIN = process.env.GITNEXUS_BIN || 'gitnexus';

/**
 * Execute a gitnexus CLI command and return stdout as string.
 * Uses spawnSync with args array to avoid all shell quoting issues.
 */
function execGitNexus(args: string[], cwd?: string): string {
  const raw = spawnSync(GITNEXUS_BIN, args, {
    cwd,
    timeout: GITNEXUS_TIMEOUT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (raw.error) throw new Error(`gitnexus spawn error: ${raw.error.message}`);
  // Most commands write to stdout; return whichever has content
  return raw.stdout?.trim() || raw.stderr?.trim() || '';
}

/**
 * Run a Cypher query against the GitNexus graph for a specific repo.
 * Uses spawnSync with args array to avoid shell quoting issues.
 */
function cypherQuery<T>(repoName: string, cypherStr: string, _cwd?: string): T {
  const raw = spawnSync(GITNEXUS_BIN, ['cypher', '--repo', repoName, cypherStr], {
    timeout: GITNEXUS_TIMEOUT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (raw.error) {
    throw new Error(`gitnexus spawn error: ${raw.error.message}`);
  }
  if (raw.status !== 0) {
    throw new Error(`gitnexus cypher failed (exit ${raw.status}): stderr=${raw.stderr?.slice(0, 200)} stdout=${raw.stdout?.slice(0, 200)}`);
  }
  // GitNexus cypher writes JSON to stderr (by design — stdout is reserved for pipe-safe output)
  const output = (raw.stderr?.trim() || raw.stdout?.trim()) || '';
  if (!output) {
    throw new Error(`gitnexus cypher returned empty output for query: ${cypherStr.slice(0, 100)}`);
  }
  try {
    return JSON.parse(output);
  } catch (e) {
    throw new Error(`gitnexus cypher JSON parse failed. Output (first 300 chars): ${output.slice(0, 300)}`);
  }
}

/**
 * Parse the markdown table format that some Cypher responses return.
 * GitNexus returns { markdown: "| col | col |...", row_count: N }
 * We need to parse the markdown table into objects.
 */
function parseMarkdownTable(response: { markdown: string; row_count: number } | { error: string }): Record<string, unknown>[] {
  if ('error' in response || !response.markdown) return [];
  const lines = response.markdown.split('\n').filter(l => l.trim().startsWith('|'));
  if (lines.length < 2) return [];

  const headers = lines[0].split('|').map(h => h.trim()).filter(Boolean);
  // Skip separator line (line[1] is | --- | --- |)
  const rows = lines.slice(2);

  return rows.map(row => {
    const cells = row.split('|').map(c => c.trim()).filter(Boolean);
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      const val = cells[i];
      // Try to parse numbers
      if (val && !isNaN(Number(val))) {
        obj[h] = Number(val);
      } else {
        obj[h] = val;
      }
    });
    return obj;
  });
}

export class GitNexusAdapter implements CodeIntelAdapter {
  readonly name = 'gitnexus';

  async isAvailable(): Promise<boolean> {
    try {
      execGitNexus(['--version']);
      return true;
    } catch {
      return false;
    }
  }

  async isIndexed(repoPath: string): Promise<{ indexed: boolean; stale: boolean; commit?: string }> {
    try {
      const output = execGitNexus(['status'], repoPath);
      const indexed = output.includes('up-to-date') || output.includes('Indexed');
      const stale = output.includes('stale') || output.includes('out-of-date');
      const commitMatch = output.match(/Indexed commit:\s*([a-f0-9]+)/);
      return { indexed, stale, commit: commitMatch?.[1] };
    } catch {
      return { indexed: false, stale: false };
    }
  }

  async analyze(repoPath: string, options?: { force?: boolean }): Promise<RepoStats> {
    const args = ['analyze'];
    if (options?.force) args.push('--force');
    const output = execGitNexus(args, repoPath);

    // Parse the analyze output for stats
    const nodeMatch = output.match(/([\d,]+)\s*nodes/);
    const edgeMatch = output.match(/([\d,]+)\s*edges/);
    const clusterMatch = output.match(/([\d,]+)\s*clusters/);
    const flowMatch = output.match(/([\d,]+)\s*flows/);
    const repoName = this.repoName(repoPath);

    // Get the commit hash from git
    let commitHash = 'unknown';
    try {
      commitHash = execSync('git rev-parse --short HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();
    } catch { /* ignore */ }

    return {
      name: repoName,
      path: repoPath,
      commitHash,
      indexedAt: new Date().toISOString(),
      totalFiles: 0, // Will be filled by getCommunities sum
      totalSymbols: parseInt((nodeMatch?.[1] || '0').replace(/,/g, '')),
      totalEdges: parseInt((edgeMatch?.[1] || '0').replace(/,/g, '')),
      totalCommunities: parseInt((clusterMatch?.[1] || '0').replace(/,/g, '')),
      totalFlows: parseInt((flowMatch?.[1] || '0').replace(/,/g, '')),
      languages: [], // Will be enriched later
    };
  }

  private repoName(repoPath: string): string {
    return repoPath.split('/').pop() || repoPath;
  }

  async getRepoStats(repoPath: string): Promise<RepoStats> {
    const repoName = this.repoName(repoPath);

    // Get node counts by type
    const nodeCountResp = cypherQuery<{ markdown: string; row_count: number }>(
      repoName,
      "MATCH (n) RETURN labels(n) AS label, COUNT(*) AS cnt ORDER BY cnt DESC"
    );
    const nodeCounts = parseMarkdownTable(nodeCountResp);

    // Get total edges
    const edgeCountResp = cypherQuery<{ markdown: string; row_count: number }>(
      repoName,
      "MATCH ()-[r:CodeRelation]->() RETURN COUNT(*) AS total"
    );
    const edgeCounts = parseMarkdownTable(edgeCountResp);

    // Get community count
    const commCountResp = cypherQuery<{ markdown: string; row_count: number }>(
      repoName,
      "MATCH (c:Community) RETURN COUNT(*) AS total"
    );
    const commCounts = parseMarkdownTable(commCountResp);

    // Get flow count
    const flowCountResp = cypherQuery<{ markdown: string; row_count: number }>(
      repoName,
      "MATCH (p:Process) RETURN COUNT(*) AS total"
    );
    const flowCounts = parseMarkdownTable(flowCountResp);

    const totalSymbols = nodeCounts.reduce((sum, r) => {
      const label = String(r.label || '');
      if (label !== 'Community' && label !== 'Process' && label !== 'Folder') {
        return sum + (Number(r.cnt) || 0);
      }
      return sum;
    }, 0);

    let commitHash = 'unknown';
    try {
      commitHash = execSync('git rev-parse --short HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();
    } catch { /* ignore */ }

    return {
      name: repoName,
      path: repoPath,
      commitHash,
      indexedAt: new Date().toISOString(),
      totalFiles: Number(nodeCounts.find(r => String(r.label) === 'File')?.cnt ?? 0),
      totalSymbols,
      totalEdges: Number(edgeCounts[0]?.total ?? 0),
      totalCommunities: Number(commCounts[0]?.total ?? 0),
      totalFlows: Number(flowCounts[0]?.total ?? 0),
      languages: [],
    };
  }

  async getCommunities(repoPath: string): Promise<CodeCommunity[]> {
    const repoName = this.repoName(repoPath);

    const resp = cypherQuery<{ markdown: string; row_count: number }>(
      repoName,
      "MATCH (c:Community) RETURN c.id AS id, c.label AS label, c.symbolCount AS symbolCount, c.cohesion AS cohesion ORDER BY c.symbolCount DESC LIMIT 50"
    );
    const rows = parseMarkdownTable(resp);

    return rows.map(r => ({
      id: String(r.id),
      label: String(r.label),
      symbolCount: Number(r.symbolCount) || 0,
      cohesion: Number(r.cohesion) || 0,
      keySymbols: [],
      languages: [],
    }));
  }

  async getCrossCommunityCalls(repoPath: string): Promise<CommunityRelation[]> {
    const repoName = this.repoName(repoPath);

    // Find CALLS edges that cross community boundaries
    // This Cypher query finds cross-community call patterns via Processes
    const resp = cypherQuery<{ markdown: string; row_count: number }>(
      repoName,
      `MATCH (p:Process) WHERE p.processType = 'cross_community' RETURN p.communities AS communities, COUNT(*) AS flowCount ORDER BY flowCount DESC LIMIT 30`
    );
    const rows = parseMarkdownTable(resp);

    // Aggregate community pairs
    const pairMap = new Map<string, CommunityRelation>();

    for (const row of rows) {
      const commStr = String(row.communities || '[]');
      // Parse the communities array (comes as string like "['comm_65','comm_103']")
      const comms = commStr.match(/'([^']+)'/g)?.map(s => s.replace(/'/g, '')) || [];
      if (comms.length < 2) continue;

      const key = `${comms[0]}→${comms[comms.length - 1]}`;
      const existing = pairMap.get(key);
      const flowCount = Number(row.flowCount) || 1;

      if (existing) {
        existing.callCount += flowCount;
      } else {
        pairMap.set(key, {
          sourceCommunity: comms[0],
          targetCommunity: comms[comms.length - 1],
          callCount: flowCount,
          strength: 0, // will be normalized later
        });
      }
    }

    // Normalize strength
    const relations = Array.from(pairMap.values());
    const maxCalls = Math.max(...relations.map(r => r.callCount), 1);
    for (const rel of relations) {
      rel.strength = rel.callCount / maxCalls;
    }

    return relations;
  }

  async getCriticalSymbols(repoPath: string, options?: { minCalls?: number }): Promise<CriticalSymbol[]> {
    const repoName = this.repoName(repoPath);
    const minCalls = options?.minCalls ?? 5;

    // Query high fan-in symbols (many callers) — KuzuDB compatible single-hop query
    const inResp = cypherQuery<{ markdown: string; row_count: number; error?: string }>(
      repoName,
      `MATCH (caller)-[r:CodeRelation]->(target) WHERE r.type = 'CALLS' RETURN target.name AS name, target.filePath AS filePath, target.startLine AS startLine, labels(target) AS kind, COUNT(*) AS inCalls ORDER BY inCalls DESC LIMIT 25`
    );

    if ('error' in inResp) return [];
    const rows = parseMarkdownTable(inResp as { markdown: string; row_count: number });

    return rows
      .filter(r => Number(r.inCalls) >= minCalls)
      .map(r => {
        const inCalls = Number(r.inCalls) || 0;
        let riskLevel: CriticalSymbol['riskLevel'] = 'low';
        if (inCalls >= 50) riskLevel = 'critical';
        else if (inCalls >= 20) riskLevel = 'high';
        else if (inCalls >= 5) riskLevel = 'medium';

        const kindRaw = String(r.kind || 'Function');
        const kind = kindRaw.toLowerCase().includes('method') ? 'method'
          : kindRaw.toLowerCase().includes('class') ? 'class'
          : kindRaw.toLowerCase().includes('interface') ? 'interface'
          : 'function';

        return {
          name: String(r.name || ''),
          kind: kind as CriticalSymbol['kind'],
          filePath: String(r.filePath || ''),
          startLine: Number(r.startLine) || 0,
          community: '',
          incomingCalls: inCalls,
          outgoingCalls: 0,
          processCount: 0,
          riskLevel,
        };
      });
  }

  async getFlows(repoPath: string): Promise<ExecutionFlow[]> {
    const repoName = this.repoName(repoPath);

    const resp = cypherQuery<{ markdown: string; row_count: number }>(
      repoName,
      "MATCH (p:Process) RETURN p.id AS id, p.label AS summary, p.processType AS type, p.stepCount AS steps, p.communities AS communities, p.entryPointId AS entry, p.terminalId AS terminal ORDER BY p.stepCount DESC LIMIT 50"
    );
    const rows = parseMarkdownTable(resp);

    return rows.map(r => ({
      id: String(r.id),
      summary: String(r.summary),
      type: (String(r.type) as ExecutionFlow['type']) || 'cross_community',
      stepCount: Number(r.steps) || 0,
      communities: String(r.communities || '[]').match(/'([^']+)'/g)?.map(s => s.replace(/'/g, '')) || [],
      entryPoint: String(r.entry || '').split(':').pop() || '',
      terminal: String(r.terminal || '').split(':').pop() || '',
    }));
  }
}
