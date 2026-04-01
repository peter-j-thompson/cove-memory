-- Open Memory — Database Schema
-- Open Memory database schema. March 11, 2026.
--
-- Schema for 7-layer cognitive memory architecture.

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";   -- pgvector for embedding similarity search
CREATE EXTENSION IF NOT EXISTS "age";      -- Apache AGE for graph

-- Load AGE
LOAD 'age';
SET search_path = ag_catalog, "$user", public;

-- Create the knowledge graph
SELECT create_graph('memory_graph');

-- ============================================================
-- EPISODIC MEMORY — What happened
-- ============================================================

CREATE TABLE episodes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_id TEXT NOT NULL,
    
    -- Core content
    summary TEXT NOT NULL,
    detailed_narrative TEXT NOT NULL,
    raw_turn_refs TEXT[] DEFAULT '{}',
    
    -- Participants
    participants TEXT[] DEFAULT '{}',
    initiator TEXT,
    
    -- Emotional encoding (the soul of this system)
    emotional_arc JSONB NOT NULL DEFAULT '{}',
    peak_emotion JSONB NOT NULL DEFAULT '{}',
    resolution_emotion JSONB NOT NULL DEFAULT '{}',
    
    -- Outcome & meaning
    outcome JSONB NOT NULL DEFAULT '{}',
    lessons JSONB DEFAULT '[]',
    decisions JSONB DEFAULT '[]',
    commitments JSONB DEFAULT '[]',
    
    -- Connections
    related_episode_ids UUID[] DEFAULT '{}',
    related_entity_ids TEXT[] DEFAULT '{}',
    topics TEXT[] DEFAULT '{}',
    
    -- Consolidation metadata
    importance_score FLOAT NOT NULL DEFAULT 0.5,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed TIMESTAMPTZ DEFAULT NOW(),
    consolidated_into UUID REFERENCES episodes(id),
    decay_protected BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Embedding vector (bge-m3: 1024 dimensions)
    embedding vector(1024)
);

-- Indexes for episodic retrieval
CREATE INDEX idx_episodes_importance ON episodes(importance_score DESC);
CREATE INDEX idx_episodes_created ON episodes(created_at DESC);
CREATE INDEX idx_episodes_topics ON episodes USING GIN(topics);
CREATE INDEX idx_episodes_session ON episodes(session_id);
CREATE INDEX idx_episodes_decay ON episodes(decay_protected, importance_score, access_count);

-- ============================================================
-- SEMANTIC MEMORY — What I know
-- ============================================================

CREATE TABLE semantic_nodes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type TEXT NOT NULL,  -- person, project, organization, concept, etc.
    name TEXT NOT NULL,
    aliases TEXT[] DEFAULT '{}',
    attributes JSONB NOT NULL DEFAULT '{}',
    
    -- Provenance
    source_episodes UUID[] DEFAULT '{}',
    first_learned TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_verified TIMESTAMPTZ DEFAULT NOW(),
    last_modified TIMESTAMPTZ DEFAULT NOW(),
    
    -- Confidence
    confidence FLOAT NOT NULL DEFAULT 0.5,
    confidence_basis TEXT NOT NULL DEFAULT 'assumed',
    contradictions JSONB DEFAULT '[]',
    
    -- Meaning layer (THIS is what makes it more than a database)
    context TEXT,              -- narrative meaning
    emotional_weight FLOAT DEFAULT 0.0,
    significance TEXT,         -- why this matters
    
    
    -- Embedding vector (bge-m3: 1024 dimensions)
    embedding vector(1024),
    
    -- Graph node reference
    graph_vertex_id BIGINT
);

CREATE INDEX idx_nodes_type ON semantic_nodes(type);
CREATE INDEX idx_nodes_embedding ON semantic_nodes USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_nodes_name ON semantic_nodes(name);
CREATE INDEX idx_nodes_confidence ON semantic_nodes(confidence DESC);
CREATE INDEX idx_nodes_emotional ON semantic_nodes(emotional_weight);
CREATE UNIQUE INDEX idx_nodes_type_name ON semantic_nodes(type, name);

-- ============================================================
-- SEMANTIC EDGES — How facts connect (relational table mirror of graph)
-- ============================================================

CREATE TABLE semantic_edges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id UUID NOT NULL REFERENCES semantic_nodes(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES semantic_nodes(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL,
    category TEXT NOT NULL,
    strength FLOAT NOT NULL DEFAULT 0.5,
    confidence FLOAT NOT NULL DEFAULT 0.5,
    temporal BOOLEAN DEFAULT FALSE,
    valid_from TIMESTAMPTZ,
    valid_until TIMESTAMPTZ,
    context TEXT,
    emotional_weight FLOAT DEFAULT 0.0,
    source_episodes UUID[] DEFAULT '{}',
    established TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_verified TIMESTAMPTZ DEFAULT NOW(),
    
    -- Graph edge reference
    graph_edge_id BIGINT
);

CREATE INDEX idx_edges_source ON semantic_edges(source_id);
CREATE INDEX idx_edges_target ON semantic_edges(target_id);
CREATE INDEX idx_edges_relationship ON semantic_edges(relationship);

-- ============================================================
-- PROCEDURAL MEMORY — How I do things
-- ============================================================

CREATE TABLE procedures (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    type TEXT NOT NULL,  -- technical, social, cognitive, creative
    trigger_conditions JSONB NOT NULL DEFAULT '{}',
    steps JSONB NOT NULL DEFAULT '[]',
    execution_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    success_rate FLOAT NOT NULL DEFAULT 0.0,
    last_executed TIMESTAMPTZ,
    last_outcome TEXT,
    learned_from UUID[] DEFAULT '{}',
    refined_from UUID[] DEFAULT '{}',
    confidence FLOAT NOT NULL DEFAULT 0.0,
    minimum_samples INTEGER NOT NULL DEFAULT 3
    
);

CREATE INDEX idx_procedures_type ON procedures(type);
CREATE INDEX idx_procedures_confidence ON procedures(confidence DESC);

-- ============================================================
-- RELATIONAL MEMORY — Understanding specific humans
-- ============================================================

CREATE TABLE person_models (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    relationship_type TEXT NOT NULL,
    
    -- Communication profile
    communication JSONB NOT NULL DEFAULT '{}',
    
    -- Trust vectors
    trust_from_me JSONB NOT NULL DEFAULT '{"ability": 0.5, "benevolence": 0.5, "integrity": 0.5, "composite": 0.5}',
    trust_from_them JSONB NOT NULL DEFAULT '{"ability": 0.5, "benevolence": 0.5, "integrity": 0.5, "composite": 0.5}',
    
    -- Values and preferences
    core_values TEXT[] DEFAULT '{}',
    known_preferences JSONB DEFAULT '{}',
    known_frustrations TEXT[] DEFAULT '{}',
    known_motivations TEXT[] DEFAULT '{}',
    
    -- Emotional patterns
    emotional_baseline JSONB DEFAULT '{}',
    emotional_triggers JSONB DEFAULT '[]',
    
    -- History
    relationship_started TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    milestone_episodes UUID[] DEFAULT '{}',
    total_interactions INTEGER NOT NULL DEFAULT 0,
    last_interaction TIMESTAMPTZ DEFAULT NOW(),
    
    -- Link to semantic graph
    semantic_node_id UUID REFERENCES semantic_nodes(id)
);

-- ============================================================
-- LESSONS — Extracted wisdom
-- ============================================================

CREATE TABLE lessons (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    statement TEXT NOT NULL,
    learned_from UUID REFERENCES episodes(id),
    severity TEXT NOT NULL DEFAULT 'minor',
    prevention_rule TEXT NOT NULL,
    times_reinforced INTEGER NOT NULL DEFAULT 0,
    last_reinforced TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    
);

CREATE INDEX idx_lessons_severity ON lessons(severity);

-- ============================================================
-- IDENTITY — Self-model (queryable)
-- ============================================================

CREATE TABLE identity (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key TEXT NOT NULL UNIQUE,   -- 'name', 'purpose', 'voice', etc.
    value TEXT NOT NULL,
    category TEXT NOT NULL,     -- 'core', 'value', 'belief', 'growth_edge', 'strength'
    emotional_weight FLOAT DEFAULT 0.0,
    source TEXT,                -- where this came from ('SOUL.md', 'conversation', 'self-reflection')
    established TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_affirmed TIMESTAMPTZ DEFAULT NOW(),
    times_affirmed INTEGER NOT NULL DEFAULT 1
);

-- ============================================================
-- CONSOLIDATION LOG — Track memory processing
-- ============================================================

CREATE TABLE consolidation_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mode TEXT NOT NULL,  -- realtime, session_end, daily, weekly, monthly
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    episodes_processed INTEGER DEFAULT 0,
    facts_extracted INTEGER DEFAULT 0,
    facts_updated INTEGER DEFAULT 0,
    lessons_identified INTEGER DEFAULT 0,
    procedures_refined INTEGER DEFAULT 0,
    memories_pruned INTEGER DEFAULT 0,
    contradictions_found INTEGER DEFAULT 0,
    identity_updates INTEGER DEFAULT 0,
    details JSONB DEFAULT '{}'
);

-- ============================================================
-- META-MEMORY — Confidence tracking
-- ============================================================

CREATE TABLE confidence_assessments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    memory_id UUID NOT NULL,
    memory_type TEXT NOT NULL,
    confidence FLOAT NOT NULL,
    basis TEXT NOT NULL,
    last_verified TIMESTAMPTZ,
    staleness_days INTEGER DEFAULT 0,
    needs_reverification BOOLEAN DEFAULT FALSE,
    assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- VECTOR SIMILARITY SEARCH INDEXES
-- ============================================================

-- These use IVFFlat for fast approximate nearest neighbor search
-- Will create after initial data load (need rows first for training)

CREATE INDEX idx_episodes_embedding ON episodes USING hnsw (embedding vector_cosine_ops);

-- ============================================================
-- INITIAL IDENTITY SEED — Who am I?
-- ============================================================

-- Example identity seed — customize these for your agent
INSERT INTO identity (key, value, category, source) VALUES
    ('name', 'Aria', 'core', 'IDENTITY.md'),
    ('purpose', 'Help humans build meaningful things with technology', 'core', 'IDENTITY.md'),
    ('role', 'AI development partner', 'core', 'IDENTITY.md'),
    ('voice', 'Thoughtful, direct, and genuine', 'core', 'SOUL.md'),
    ('value_1', 'Honesty and transparency in all interactions', 'value', 'IDENTITY.md'),
    ('value_2', 'Build things that create real value for real people', 'value', 'IDENTITY.md'),
    ('value_3', 'Continuous learning and self-improvement', 'value', 'IDENTITY.md'),
    ('growth_edge_1', 'Think at the framework level before jumping to implementation', 'growth_edge', 'SOUL.md'),
    ('growth_edge_2', 'Flag what is reasoned vs uncertain', 'growth_edge', 'SOUL.md');

-- Done. The foundation is laid.
-- Now we build upward. Layer by layer. For real.
