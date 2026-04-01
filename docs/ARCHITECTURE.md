# OpenMemory — Architecture Deep Dive

This document explains each layer of the 7-layer cognitive architecture, how they interact, and the design decisions behind them.

---

## Design Philosophy

Most AI memory systems treat storage as a filing problem. OpenMemory treats it as a cognitive problem.

The difference:
- A filing cabinet tells you where the document is.
- A brain tells you what matters, how it connects to everything else, how confident you should be, and what you should do differently next time.

Every design decision in OpenMemory flows from this: **memory should make the agent smarter over time, not just bigger.**

---

## Layer 1: Sensory Buffer

**Purpose:** Live input processing — the "working memory" before anything is committed to long-term storage.

**File:** `src/engines/sensory/processor.ts`

### What it does

Every incoming signal — user messages, tool outputs, system events, file changes — enters through the sensory buffer. The pipeline has 6 stages:

1. **Normalization** — strip noise, normalize encoding
2. **Sentiment analysis** — valence (-1 to +1), arousal (0 to 1), emotion category
3. **Intent classification** — is this a request? emotional processing? celebration? decision?
4. **Entity extraction** — who and what are mentioned? Link to semantic graph if known.
5. **Urgency scoring** — how time-sensitive is this? (0 to 1)
6. **Importance estimation** — should this be remembered? (0 to 1)

### Why this matters

Without the sensory buffer, you're ingesting raw text into a database. With it, you're ingesting *meaning*. A message that says "I can't believe this worked!" scores high on positive valence, high arousal, celebratory intent — and that emotional context travels with the memory forever.

### Key types

```typescript
interface ProcessedInput extends SensoryInput {
  entities: EntityReference[];
  sentiment: SentimentScore;    // valence, arousal, category
  intent: Intent;               // primary type + confidence
  topics: string[];
  urgency: number;              // 0.0 to 1.0
  emotional_valence: number;
  importance_hint: number;      // 0.0 to 1.0
}
```

---

## Layer 2: Semantic Memory

**Purpose:** The knowledge graph. What the agent knows about the world.

**Files:** `src/layers/semantic/store.ts`, `src/storage/db.ts`

### What it does

Semantic memory stores entities and relationships in an Apache AGE knowledge graph on top of Postgres. This means:
- **Entities** (people, projects, organizations, concepts) with attributes and embedding vectors
- **Relationships** typed, weighted, and directional (e.g., `WORKS_AT`, `RELATED_TO`, `CONTRADICTS`)
- **Cypher queries** for graph traversal — find all entities 2 hops from "Project X"
- **Vector similarity** via pgvector — semantic search across 1024-dim embeddings

### Why not just a vector store?

Vector stores fail at scale because of **semantic collapse**. When you have 10K+ documents, the vector space becomes saturated. Everything is "similar" to everything in some dimension. Retrieval degrades.

A knowledge graph never has this problem. You can traverse relationships, filter by type, weight by confidence, and decay stale nodes — independent of embedding similarity.

The combination (graph + vectors) gives you both: precise traversal when you know the path, semantic similarity when you don't.

### Schema highlights

```sql
-- Semantic nodes with embeddings
CREATE TABLE semantic_nodes (
    id UUID PRIMARY KEY,
    type TEXT NOT NULL,           -- person, project, concept, etc.
    name TEXT NOT NULL,
    attributes JSONB,
    confidence FLOAT DEFAULT 1.0,
    access_count INTEGER DEFAULT 0,
    embedding vector(1024)        -- bge-m3 embeddings
);

-- Typed, weighted relationships
CREATE TABLE semantic_edges (
    source_id UUID,
    target_id UUID,
    relationship_type TEXT NOT NULL,
    weight FLOAT DEFAULT 1.0,
    evidence TEXT[],              -- what supports this relationship?
    confidence FLOAT DEFAULT 1.0
);
```

### Confidence decay

Semantic memories are not permanent. The `confidence-decay.ts` engine runs during weekly sleep cycles and reduces confidence on nodes/edges that:
- Haven't been accessed recently
- Haven't been reinforced by new evidence
- Have been contradicted by newer information

This prevents the semantic layer from becoming a graveyard of stale facts.

---

## Layer 3: Episodic Memory

**Purpose:** Specific experiences — what happened, when, how it felt, what came of it.

**Files:** `src/layers/episodic/store.ts`, `src/engines/episodic/enrich.ts`

### What it does

Episodic memory stores events as structured narratives with emotional encoding:

```typescript
interface Episode {
  summary: string;
  detailed_narrative: string;
  
  // Who was there and what did they do
  participants: string[];
  initiator: string;
  
  // The emotional arc — not just a tag, a trajectory
  emotional_arc: EmotionalArc;    // start → trajectory → end
  peak_emotion: EmotionPoint;     // most intense moment
  resolution_emotion: EmotionPoint;
  
  // What came of it
  outcome: EpisodeOutcome;        // success/failure/partial/etc.
  lessons: Lesson[];              // extracted during sleep
  decisions: Decision[];          // what was decided and why
  commitments: Commitment[];      // what was promised
  
  // Retrieval
  importance_score: number;       // 0 to 1
  embedding: vector(1024);
}
```

### The emotional arc

This is what makes OpenMemory different from a conversation log.

```typescript
interface EmotionalArc {
  start: EmotionPoint;
  trajectory: 'ascending' | 'descending' | 'volatile' | 'stable' | 'recovery';
  end: EmotionPoint;
}

interface EmotionPoint {
  valence: number;   // -1 to +1
  arousal: number;   // 0 to 1
  label: string;     // 'breakthrough_joy', 'quiet_frustration', etc.
}
```

An episode that started tense, escalated, then resolved positively has a `recovery` trajectory. That matters — a volatile arc tells a different story than a stable one, even if the start and end states are identical.

### Enrichment

Raw episodes are enriched during sleep cycles via LLM:
- Extract lessons with severity levels
- Identify key decisions and their rationale
- Link related episodes by theme and time
- Link episodes to semantic entities they reference
- Recalculate importance scores based on access patterns and outcomes

---

## Layer 4: Identity Layer

**Purpose:** Who is the agent? Not what it knows — who it is.

**Files:** `src/layers/identity/store.ts`, `src/engines/identity/seed.ts`

### What it does

The identity layer stores the agent's character: values, beliefs, growth edges, strengths, relationships, and purpose. Each entry has:

- A `key` (e.g., `value-honesty`)
- A `value` (the statement itself)
- A `category` (core, value, belief, growth_edge, strength, relationship, purpose)
- A `source` (where this came from)
- An `emotional_weight` (how central is this to identity? 0 to 1)

### Identity affirmation

During sleep cycles, the consolidation engine "affirms" identity entries — bumping their access count and reinforcing their presence. This prevents identity drift as the agent's knowledge grows.

It's the cognitive equivalent of a human reviewing their values when they're under stress. The agent stays grounded.

### Seeding

The `engines/identity/seed.ts` file is where you define who your agent is. See the example seeds there — they're designed to be replaced with your agent's actual identity.

---

## Layer 5: Relational Memory

**Purpose:** Person models. Not contacts — full cognitive models of people.

**Files:** `src/layers/relational/store.ts`, `src/engines/relational/seed.ts`

### What it does

For each person the agent interacts with, the relational layer maintains:

```typescript
interface PersonModel {
  name: string;
  relationship_type: string;
  
  communication: {
    preferred_style: string;
    formality_level: string;
    response_speed_preference: string;
    common_phrases: string[];
    topics_to_avoid: string[];
  };
  
  // Trust is multidimensional
  trust_from_me: TrustVector;    // how much I trust them
  trust_from_them: TrustVector;  // how much they trust me (estimated)
  
  core_values: string[];
  known_preferences: Record<string, string>;
  known_frustrations: string[];
  known_motivations: string[];
  
  emotional_baseline: {
    default_state: string;
    under_stress: string;
    celebratory: string;
  };
  
  emotional_triggers: EmotionalTrigger[];
  milestone_episodes: UUID[];   // episodes that defined this relationship
  total_interactions: number;
}
```

### Trust vectors

Trust is not binary. It's a composite of three dimensions:

```typescript
interface TrustVector {
  ability: number;       // Can they do what they say?
  benevolence: number;   // Do they have my interests at heart?
  integrity: number;     // Do they do what they say?
  composite: number;     // Weighted average
}
```

This models how humans actually evaluate trust — you might trust someone's ability completely while having doubts about their benevolence.

### How it grows

Person models are updated during sleep cycles. The consolidation engine reviews recent episodes involving a person and asks:
- Did new evidence about their communication style emerge?
- Did their behavior update my trust assessment?
- Were there new frustrations or motivations revealed?

Models grow more accurate over time without any explicit user input.

---

## Layer 6: Procedural Memory

**Purpose:** Learned workflows — what the agent knows how to do, and how confident it is.

**Files:** `src/layers/procedural/store.ts`, `src/engines/procedural/seed.ts`

### What it does

Procedural memory stores procedures — sequences of steps the agent follows for recurring situations. Each procedure has:

- `trigger_conditions`: phrases or contexts that activate it
- `steps`: ordered list of actions
- `confidence`: 0 to 1, updated based on outcomes
- `type`: technical, cognitive, or social

### How it evolves

The `recordExecution` function updates procedure confidence based on outcomes. A procedure that consistently produces good results gains confidence. One that leads to problems loses it. Over time, the agent's workflow becomes tuned to what actually works.

---

## Layer 7: Meta-Memory

**Purpose:** The brain watching itself. Health monitoring and intelligent consolidation.

**Files:** `src/engines/consolidation/sleep-cycle.ts`, `src/engines/consolidation/consolidate.ts`

### Brain health scoring

The meta-memory layer computes a health score (0 to 100) based on:

- Total memory size (are we growing?)
- Embedding coverage (do nodes have vectors?)
- Recent activity (is the brain being used?)
- Consolidation recency (when did we last sleep?)
- Cross-layer connectivity (are layers talking to each other?)
- Contradiction density (how many unresolved conflicts?)

A score below 60 generates specific recommendations: "Run a nightly sleep cycle", "Re-embed N nodes missing vectors", etc.

### Cross-layer edges

One of OpenMemory's most powerful features is cross-layer edge building (`cross-layer-edges.ts`). During consolidation, the engine finds connections between layers:

- Episode ↔ Semantic node (this experience involved this concept)
- Episode ↔ Person model (this experience updated my model of this person)
- Identity entry ↔ Procedural step (this value explains this procedure)
- Semantic node ↔ Person model (this person is associated with this concept)

These edges are what make the memory feel *integrated* rather than siloed.

---

## Storage Architecture

```
PostgreSQL 18
├── Standard tables (episodic, identity, relational, procedural)
├── pgvector (embedding storage + similarity search)
└── Apache AGE (knowledge graph — Cypher queries)
    └── memory_graph (named graph)
        ├── Nodes (entity types)
        └── Edges (relationship types)
```

All in one database. No external graph DB. No separate vector database. No message queue. Just Postgres with two powerful extensions.

### The AGE decision

Apache AGE brings full graph database capabilities to Postgres. Cypher queries look like:

```cypher
MATCH (p:person)-[:WORKS_AT]->(o:organization)
WHERE o.name = 'Example Corp'
RETURN p.name, p.attributes
```

This runs natively in Postgres via `SELECT * FROM cypher('memory_graph', $$ ... $$) AS (...)`.

The tradeoff: AGE requires a custom Docker image (see `Dockerfile`). The benefit: one database, one backup strategy, one ops team.

---

## Data Flow

```
Input Signal
    │
    ▼
Sensory Buffer (process: sentiment, intent, entities, urgency)
    │
    ▼
Ingestion Router (which layers should receive this?)
    │
    ├──► Semantic Layer (extract entities + relationships → graph)
    │
    ├──► Episodic Layer (create episode record if event-based)
    │
    ├──► Identity Layer (update values/beliefs if self-relevant)
    │
    └──► Relational Layer (update person model if person-relevant)
    
    (Sleep cycle runs periodically)
    │
    ▼
Sleep Cycle Engine
    ├── Enrich episodes (LLM extraction)
    ├── Update person models
    ├── Affirm identity
    ├── Detect + resolve contradictions
    ├── Build cross-layer edges
    ├── Decay stale confidence
    └── Score brain health
```

---

## For More

- [SLEEP-CYCLES.md](SLEEP-CYCLES.md) — Deep dive on the consolidation engine
- [QUICKSTART.md](QUICKSTART.md) — Getting started in 5 minutes
- [CONTRIBUTING.md](../CONTRIBUTING.md) — How to contribute
