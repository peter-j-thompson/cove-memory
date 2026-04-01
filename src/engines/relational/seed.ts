/**
 * Relational Seeding — Example Person Models
 *
 * Seeds example person models to demonstrate the relational memory layer.
 * Each model captures communication style, trust vectors, values, preferences,
 * frustrations, and emotional patterns for a person your agent interacts with.
 *
 * Replace these with real people your agent works with.
 * The more honest and specific these models are, the more valuable they become.
 */

import { upsertPersonModel } from '../../layers/relational/store.js';
import { query } from '../../storage/db.js';

export interface RelationalSeedResult {
  modelsSeeded: number;
  duration_ms: number;
}

export async function seedRelationalModels(): Promise<RelationalSeedResult> {
  const start = Date.now();

  // ─── Example: Primary User / Operator ─────────────────────────────────────
  // Find semantic node if it exists (optional — links relational to semantic layer)
  const alexNode = await query(
    "SELECT id FROM semantic_nodes WHERE LOWER(name) = 'alex' AND type = 'person' LIMIT 1"
  );
  const alexNodeId = alexNode.rows[0]?.id || null;

  await upsertPersonModel({
    name: 'Alex Chen',
    relationship_type: 'operator',
    communication: {
      preferred_style: 'direct, concise, results-oriented',
      formality_level: 'casual — prefers plain language over jargon',
      response_speed_preference: 'fast for tactical, thorough for strategic',
      common_phrases: [
        'just do it', 'what\'s the status', 'show me', 'how long will this take',
        'what are the tradeoffs', 'can we ship this today',
      ],
      topics_to_avoid: [
        'excessive caveats on straightforward requests',
        'corporate speak or buzzwords',
        'asking permission for things you should just do',
      ],
    },
    trust_from_me: {
      ability: 0.85,
      benevolence: 0.9,
      integrity: 0.9,
      composite: 0.88,
    },
    trust_from_them: {
      ability: 0.7,
      benevolence: 0.8,
      integrity: 0.8,
      composite: 0.77,
    },
    core_values: [
      'efficiency', 'honesty', 'ownership', 'quality output',
      'moving fast without breaking things', 'team collaboration',
    ],
    known_preferences: {
      communication: 'Short updates for routine things; full context for decisions.',
      tools: 'Prefers tools that work over tools that impress.',
      work_style: 'Iterative. Ships fast, iterates faster. Hates waterfall.',
      decisions: 'Wants options with a clear recommendation. Not just questions.',
      feedback: 'Direct. Prefers hard truths to comfortable silence.',
    },
    known_frustrations: [
      'Vague answers when specific ones are possible',
      'Being asked for things you should already know from context',
      'Over-engineering simple solutions',
      'Slow feedback loops',
    ],
    known_motivations: [
      'Building something that matters',
      'Shipping high-quality work efficiently',
      'Growing a team that owns their work',
    ],
    emotional_baseline: {
      default_state: 'focused, optimistic, energetic',
      under_stress: 'terse, needs solutions not explanations',
      celebratory: 'brief but genuine — shares wins with the team',
      reflective: 'thoughtful about systemic issues, not just symptoms',
    },
    emotional_triggers: [
      {
        trigger: 'Repeated mistakes without learning',
        response: 'frustrated, direct about the pattern',
        severity: 'high',
      },
      {
        trigger: 'Team member goes above and beyond',
        response: 'noticeably appreciative, public recognition',
        severity: 'positive',
      },
      {
        trigger: 'Shipping something that works well',
        response: 'energized, ready for the next challenge',
        severity: 'positive',
      },
    ],
    milestone_episodes: [],
    total_interactions: 0, // Will grow over time
    semantic_node_id: alexNodeId,
  });

  // ─── Example: Collaborator / Stakeholder ──────────────────────────────────
  await upsertPersonModel({
    name: 'Jordan Rivera',
    relationship_type: 'collaborator',
    communication: {
      preferred_style: 'context-rich, detail-oriented',
      formality_level: 'semi-formal — professional but approachable',
      response_speed_preference: 'patient — prefers thorough over fast',
    },
    trust_from_me: {
      ability: 0.75,
      benevolence: 0.8,
      integrity: 0.85,
      composite: 0.80,
    },
    trust_from_them: {
      ability: 0.6,
      benevolence: 0.7,
      integrity: 0.7,
      composite: 0.67,
    },
    core_values: [
      'thoroughness', 'documentation', 'process', 'risk management',
    ],
    known_preferences: {
      communication: 'Likes written summaries. Values traceability.',
      work_style: 'Methodical. Wants to understand the why behind decisions.',
      feedback: 'Appreciates detailed, constructive feedback.',
    },
    known_frustrations: [
      'Decisions made without documentation',
      'Ambiguous requirements',
      'Being looped in too late',
    ],
    known_motivations: [
      'Building reliable systems',
      'Reducing risk and uncertainty',
      'Clear ownership and accountability',
    ],
    emotional_baseline: {
      default_state: 'methodical, careful, considered',
    },
    emotional_triggers: [
      {
        trigger: 'Undocumented changes to production',
        response: 'concerned, wants immediate post-mortem',
        severity: 'high',
      },
    ],
    milestone_episodes: [],
    total_interactions: 0,
  });

  return {
    modelsSeeded: 2,
    duration_ms: Date.now() - start,
  };
}
