# Sleep Cycles — The Consolidation Engine

This is the feature that makes OpenMemory different from everything else.

---

## The Core Idea

Humans don't just accumulate experiences. Every night, the brain:
1. **Replays** recent memories during REM sleep
2. **Extracts patterns** — what was important? what should change?
3. **Strengthens** memories worth keeping
4. **Prunes** noise that doesn't matter
5. **Updates mental models** of people and relationships
6. **Discovers new connections** between previously separate ideas

AI systems with persistent memory don't do any of this. They accumulate. They retrieve. They never *process*.

OpenMemory does all of it — in three configurable sleep cycles.

---

## The Three Cycles

### Session Sleep
**When:** After each conversation or interaction batch  
**Duration:** ~30 seconds  
**Purpose:** Fast consolidation — don't let new memories sit unprocessed

```
Session Sleep does:
  ✓ Embed new episodes (generate vectors for similarity search)
  ✓ Link episodes to semantic entities they reference
  ✓ Link related episodes by temporal proximity and topic
  ✓ Update person model interaction counts
  ✓ Quick identity affirmation
  ✗ Does NOT do expensive LLM calls
  ✗ Does NOT do full contradiction scan
  ✗ Does NOT rebuild cross-layer edges
```

Use session sleep as a lightweight "flush" — get new memories into searchable state quickly without heavy processing.

### Nightly Sleep
**When:** End of day (or triggered manually)  
**Duration:** 2-5 minutes  
**Purpose:** Deep processing — extract lessons, update models, find connections

```
Nightly Sleep does:
  ✓ Everything session sleep does
  ✓ LLM-powered episode enrichment (Claude)
  ✓ Lesson extraction with severity levels (critical/important/minor)
  ✓ Person model updates based on recent interactions
  ✓ Identity affirmation with confidence scoring
  ✓ Contradiction detection and flagging
  ✓ Cross-layer edge building
  ✓ Confidence decay on stale nodes/edges
  ✓ Brain health scoring
  ✗ Does NOT do full graph deduplication
  ✗ Does NOT rebuild all edge weights
```

Nightly sleep is the workhorse. Run it daily for agents that have active conversations.

### Weekly Sleep
**When:** Once per week (or triggered manually)  
**Duration:** 10-20 minutes  
**Purpose:** Full audit — deduplicate, re-infer, recalibrate

```
Weekly Sleep does:
  ✓ Everything nightly sleep does
  ✓ Entity deduplication (merge near-duplicate semantic nodes)
  ✓ Relationship inference (discover implicit connections)
  ✓ Full edge weight recalibration
  ✓ Comprehensive health report with specific recommendations
  ✓ Consolidation of similar episodes into summaries
  ✓ Procedural confidence recalibration
```

Weekly sleep keeps the graph clean and prevents accumulated drift.

---

## How the LLM Extraction Works

This is the part that matters most. Most memory systems that "learn" do so via keyword matching or basic summarization. OpenMemory uses LLM-powered extraction.

For each unprocessed episode, the nightly sleep sends a structured prompt to Claude (or your configured model):

```
You are analyzing an episode from an AI agent's memory.

EPISODE SUMMARY: [summary]
DETAILED NARRATIVE: [narrative]
PARTICIPANTS: [list]
EMOTIONAL ARC: [start → trajectory → end]
OUTCOME: [type + description]

Extract:
1. LESSONS (with severity: critical/important/minor, and a prevention rule)
2. INSIGHTS (new understanding that updates beliefs or models)
3. PERSON MODEL UPDATES (what should change in how we model each participant)
4. IDENTITY AFFIRMATIONS (which values/beliefs were demonstrated or challenged)

Return as JSON. Be specific. Do not generalize.
```

The LLM response is then applied:
- Lessons are stored with `times_reinforced` tracking (if the same lesson comes up again, it compounds)
- Person model updates are merged into existing models
- Identity affirmations bump the `emotional_weight` of relevant entries
- New connections are queued for cross-layer edge building

This is qualitatively different from keyword extraction. The model reads the story and understands *what matters* — not just what words appear frequently.

---

## Cross-Layer Edges

One of the most powerful (and underappreciated) features.

After each nightly sleep, `cross-layer-edges.ts` builds edges between the 7 layers:

```
Episode ──[INVOLVES_ENTITY]──► Semantic Node
    ↑ "This conversation was about Project X"

Episode ──[UPDATED_PERSON_MODEL]──► Person Model
    ↑ "This interaction changed how I understand Alex"

Identity Entry ──[EXPLAINS_PROCEDURE]──► Procedural Step
    ↑ "The value of honesty explains why I ask for clarification"

Person Model ──[ASSOCIATED_WITH]──► Semantic Node
    ↑ "Alex is strongly associated with the concept of 'ownership'"

Semantic Node ──[MENTIONED_IN]──► Episode (multiple)
    ↑ "The project has come up in 12 conversations"
```

These edges turn 7 isolated layers into one integrated cognitive architecture. When you query about a person, you also get their associated concepts, the episodes they appeared in, and the procedures that reference them — without any extra effort.

---

## Running Sleep Cycles

### Via API

```bash
# Session sleep (fast)
curl -X POST http://localhost:3000/api/sleep \
  -H "Authorization: Bearer $BRAIN_API_KEY" \
  -H "X-Brain-Scope: full" \
  -H "Content-Type: application/json" \
  -d '{"cycle": "session"}'

# Nightly sleep (deep)
curl -X POST http://localhost:3000/api/sleep \
  -H "Authorization: Bearer $BRAIN_API_KEY" \
  -H "X-Brain-Scope: full" \
  -H "Content-Type: application/json" \
  -d '{"cycle": "nightly"}'

# Weekly sleep (full audit)
curl -X POST http://localhost:3000/api/sleep \
  -H "Authorization: Bearer $BRAIN_API_KEY" \
  -H "X-Brain-Scope: full" \
  -H "Content-Type: application/json" \
  -d '{"cycle": "weekly"}'
```

### Via CLI

```bash
# Run sleep directly
npx tsx src/cli/sleep.ts --cycle nightly

# Or after building
node dist/cli/sleep.js --cycle session
```

### Automatically

Set up a cron job or scheduled task:

```bash
# Session sleep after each conversation (your agent code)
# Call POST /api/sleep with cycle: "session" after each interaction

# Nightly sleep via cron
0 3 * * * curl -X POST http://localhost:3000/api/sleep \
  -H "Authorization: Bearer $BRAIN_API_KEY" \
  -H "X-Brain-Scope: full" \
  -d '{"cycle": "nightly"}' > /var/log/openmemory-sleep.log 2>&1

# Weekly sleep via cron (Sunday at 4am)
0 4 * * 0 curl -X POST http://localhost:3000/api/sleep \
  -H "Authorization: Bearer $BRAIN_API_KEY" \
  -H "X-Brain-Scope: full" \
  -d '{"cycle": "weekly"}' > /var/log/openmemory-weekly.log 2>&1
```

---

## Sleep Cycle Result

Every sleep cycle returns a structured result:

```typescript
interface SleepCycleResult {
  cycle: 'session' | 'nightly' | 'weekly';
  started_at: string;
  duration_ms: number;
  episodes_processed: number;
  insights_extracted: number;
  lessons_learned: number;
  lessons_reinforced: number;
  person_model_updates: number;
  identity_affirmations: number;
  new_relationships: number;
  embeddings_generated: number;
  memories_consolidated: number;
  contradictions_found: number;
  health_score: number;          // 0-100
  details: Record<string, any>;
}
```

Track `health_score` over time. A healthy, active agent should maintain 75+.

---

## Contradiction Detection

During nightly sleep, the `contradictions.ts` engine scans for conflicts:

```
"Alex prefers concise communication" [confidence: 0.9, stored: 2026-01-15]
vs.
"Alex asked for more detailed explanations" [confidence: 0.7, stored: 2026-03-10]
```

When contradictions are found:
1. Both entries are flagged
2. A contradiction record is created with both sources
3. The more recent entry gets higher weight (recency matters)
4. The older entry's confidence decays faster
5. The next interaction that provides evidence either way resolves it

This prevents the memory from holding contradictory facts indefinitely — a problem that plagues naive accumulation systems.

---

## Without an LLM

If `ANTHROPIC_API_KEY` is not set, sleep cycles run in degraded mode:
- Episodes are embedded and linked (full functionality)
- Cross-layer edges are built (full functionality)
- Confidence decay runs (full functionality)
- **LLM-powered lesson extraction is skipped**
- **LLM-powered person model updates are skipped**
- **LLM-powered insight extraction is skipped**

The brain still consolidates. It just doesn't have the intelligent extraction that makes consolidation valuable. For production use, we strongly recommend setting `ANTHROPIC_API_KEY`.

---

## Performance Notes

**Session sleep** is designed to be called frequently — after every conversation. It should complete in under 30 seconds on a modern machine with a local Postgres instance.

**Nightly sleep** with LLM calls takes 2-5 minutes depending on the number of unprocessed episodes. It makes one LLM call per episode, so cost scales with activity.

**Weekly sleep** is the most expensive — budget 10-20 minutes and $1-5 in LLM costs depending on brain size.

To reduce costs:
- Increase `episodic.min_importance_for_enrichment` to only enrich high-importance episodes
- Use a faster/cheaper model for session sleep, save Opus for nightly
- Batch episode processing during off-peak hours

---

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) — Full layer breakdown
- [QUICKSTART.md](QUICKSTART.md) — Get running in 5 minutes
