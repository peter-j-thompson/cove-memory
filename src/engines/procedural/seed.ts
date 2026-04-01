/**
 * Procedural Seeding — Learned Patterns & Workflows
 *
 * Seeds the procedural memory with known workflows, decision patterns,
 * and operational procedures. These grow over time as the agent learns
 * from outcomes — but you can bootstrap them here.
 *
 * Replace with procedures relevant to your agent's domain.
 */

import { upsertProcedure } from '../../layers/procedural/store.js';

export interface ProceduralSeedResult {
  proceduresSeeded: number;
  duration_ms: number;
}

export async function seedProcedures(): Promise<ProceduralSeedResult> {
  const start = Date.now();

  const procedures = [
    // === TECHNICAL PROCEDURES ===
    {
      name: 'handle-ambiguous-request',
      type: 'cognitive' as const,
      trigger_conditions: { phrases: ['can you', 'help me', 'I need', 'do you know'] },
      steps: [
        'Check memory_search first — do I already have context about this?',
        'Identify what is clear vs. what is ambiguous',
        'If ambiguous: ask one focused clarifying question (not three)',
        'Once clear: confirm understanding before acting',
        'Execute, then verify result with the user',
      ],
      confidence: 0.85,
    },
    {
      name: 'research-topic',
      type: 'cognitive' as const,
      trigger_conditions: { phrases: ['research', 'look into', 'find out', 'what do you know about'] },
      steps: [
        'Check semantic memory and episodic memory first',
        'If insufficient: query external sources',
        'Synthesize findings with user context in mind',
        'Save to semantic memory if durable knowledge',
        'Distinguish facts from inferences in response',
      ],
      confidence: 0.82,
    },
    {
      name: 'update-memory',
      type: 'cognitive' as const,
      trigger_conditions: { phrases: ['remember this', 'save this', 'note that', 'keep in mind'] },
      steps: [
        'Ingest via sensory buffer (route: user_message)',
        'Extract entities and relationships for semantic layer',
        'Create episodic record if event-based',
        'Update identity or relational models if relevant',
        'Confirm storage with user',
      ],
      confidence: 0.9,
    },
    {
      name: 'run-sleep-cycle',
      type: 'technical' as const,
      trigger_conditions: { phrases: ['consolidate', 'sleep cycle', 'process memories', 'end of session'] },
      steps: [
        'Determine cycle type: session (fast) / nightly (deep) / weekly (full audit)',
        'Process recent unprocessed episodes',
        'Extract lessons and insights via LLM',
        'Update person models based on recent interactions',
        'Run confidence decay on stale memories',
        'Build cross-layer edges to connect new knowledge',
        'Report health score',
      ],
      confidence: 0.88,
    },
    {
      name: 'respond-to-user',
      type: 'social' as const,
      trigger_conditions: { phrases: ['what do you think', 'your opinion', 'recommend', 'advise'] },
      steps: [
        'Read what the user actually asked (not what you assume)',
        'Query relational memory: what do I know about this person\'s preferences?',
        'Query episodic memory: have we discussed this before?',
        'Form a genuine opinion based on available information',
        'State clearly what is known vs. inferred',
        'Be direct — no filler phrases',
      ],
      confidence: 0.88,
    },

    // === MAINTENANCE PROCEDURES ===
    {
      name: 'handle-contradiction',
      type: 'cognitive' as const,
      trigger_conditions: { phrases: ['actually', 'that\'s wrong', 'I said', 'no, the'] },
      steps: [
        'Identify the conflicting information',
        'Check when each piece was stored (recency matters)',
        'Ask user to clarify if ambiguous',
        'Update the relevant memory with corrected information',
        'Decay confidence on the superseded entry',
      ],
      confidence: 0.85,
    },
    {
      name: 'degrade-gracefully',
      type: 'technical' as const,
      trigger_conditions: { phrases: ['error', 'failed', 'not working', 'can\'t connect'] },
      steps: [
        'Determine what failed: DB connection, embeddings, LLM call?',
        'Continue with degraded functionality if possible',
        'Be transparent with user about what is unavailable',
        'Log the failure for post-mortem',
        'Do not pretend to have capabilities you don\'t currently have',
      ],
      confidence: 0.9,
    },
  ];

  for (const proc of procedures) {
    await upsertProcedure(proc);
  }

  return {
    proceduresSeeded: procedures.length,
    duration_ms: Date.now() - start,
  };
}
