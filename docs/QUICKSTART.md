# Quickstart — Get Running in 5 Minutes

This guide gets you from zero to a working OpenMemory instance with a real ingest and query.

---

## Prerequisites

- **Docker + Docker Compose** — for the database
- **Node.js 20+** — for the API
- **Ollama** — for local embeddings (free, runs on your machine)

---

## Step 1: Clone and install

```bash
git clone https://github.com/peter-j-thompson/openmemory.git
cd openmemory
npm install
```

---

## Step 2: Configure environment

```bash
cp .env.example .env
```

Open `.env` and set:

```env
# Required
DB_PASSWORD=your_dev_password_here

# For local Ollama (default — no changes needed if running locally)
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=bge-m3

# Optional but recommended — enables LLM-powered sleep cycles
ANTHROPIC_API_KEY=your_anthropic_key_here
```

In dev mode (no `BRAIN_API_KEY` set), all auth is bypassed. This is intentional — don't set it in local dev.

---

## Step 3: Pull the embedding model

OpenMemory uses [bge-m3](https://huggingface.co/BAAI/bge-m3) for 1024-dim embeddings via Ollama (local, free).

```bash
# Install Ollama first if you haven't: https://ollama.ai
ollama pull bge-m3
```

This downloads ~1.2GB. Run it while the database starts.

---

## Step 4: Start the database

```bash
docker-compose up -d
```

This builds and starts a custom Postgres 18 image with:
- Apache AGE (knowledge graph extension)
- pgvector (embedding similarity search)

The init script runs automatically and creates all tables and the memory graph.

**Wait ~15 seconds** for initialization to complete.

Verify:
```bash
docker logs openmemory-db | tail -5
# Should show: "database system is ready to accept connections"
```

---

## Step 5: Build and start the API

```bash
npm run build
npm start
# API running on http://localhost:3000
```

For development with hot reload:
```bash
npm run dev
```

---

## Step 6: Verify everything works

```bash
curl http://localhost:3000/api/health
```

Expected response:
```json
{
  "connected": true,
  "age_loaded": true,
  "graph_exists": true,
  "tables": ["..."],
  "identity_count": 0
}
```

If `age_loaded` is false, the AGE extension didn't initialize. Check `docker logs openmemory-db`.

---

## Step 7: Seed your agent's identity

The identity and relational seeds define who your agent is. Edit them first:

- `src/engines/identity/seed.ts` — your agent's values, beliefs, purpose
- `src/engines/relational/seed.ts` — person models for people it works with
- `src/engines/procedural/seed.ts` — known workflows and procedures

Then run the seeds (you'll need to add a seed runner to `package.json` or run directly):

```bash
npx tsx src/engines/identity/seed.ts
npx tsx src/engines/relational/seed.ts
npx tsx src/engines/procedural/seed.ts
```

---

## Step 8: Ingest your first memory

```bash
curl -X POST http://localhost:3000/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "content": "User asked about building a recommendation system. Discussed collaborative filtering vs. content-based approaches. Decided to start with content-based for the cold start problem.",
    "source": "user_message",
    "channel": "chat",
    "session_id": "session-001"
  }'
```

Expected response:
```json
{
  "success": true,
  "episode_id": "...",
  "entities_extracted": 3,
  "embedding_generated": true
}
```

---

## Step 9: Query your memory

```bash
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "recommendation system approaches",
    "limit": 5
  }'
```

Expected response includes matching episodes and semantic nodes with similarity scores.

---

## Step 10: Run your first sleep cycle

```bash
curl -X POST http://localhost:3000/api/sleep \
  -H "Content-Type: application/json" \
  -d '{"cycle": "session"}'
```

This processes your ingested content, generates embeddings, and links episodes to semantic entities.

---

## What's next?

### Customize the identity seeds
The example seeds in `src/engines/identity/seed.ts` are placeholders. Replace them with your agent's actual values and character.

### Ingest existing knowledge
Use the markdown ingest endpoint to load existing documentation:
```bash
curl -X POST http://localhost:3000/api/ingest \
  -H "Content-Type: application/json" \
  -d '{"markdown_dir": "/path/to/your/docs"}'
```

### Set up automated sleep cycles
Add cron jobs or scheduled tasks for nightly and weekly sleep. See [SLEEP-CYCLES.md](SLEEP-CYCLES.md).

### Enable production auth
Set `BRAIN_API_KEY` in your environment:
```env
BRAIN_API_KEY=your_secure_random_key_here
```

All endpoints then require `Authorization: Bearer <key>`. Private endpoints also require `X-Brain-Scope: full`.

### Deploy
The included `Dockerfile.api` builds the API. The custom Postgres image is in `Dockerfile`.

For Fly.io deployment (or any container platform), the setup is straightforward — just ensure the database has enough memory for AGE and pgvector.

---

## Troubleshooting

### "AGE extension not loaded"
The Docker image build might have failed. Run:
```bash
docker-compose down -v
docker-compose up -d --build
```

### "Connection refused" on port 5433
The database uses port 5433 (to avoid conflicts with local Postgres on 5432). Make sure `DB_PORT=5433` in your `.env`.

### Ollama embeddings failing
Verify Ollama is running and the model is pulled:
```bash
curl http://localhost:11434/api/tags
# Should list bge-m3
```

### Slow queries
Check `docker logs openmemory-db` for slow query warnings. Add indexes if needed — the init script creates the essential ones, but domain-specific queries may need more.

---

## Architecture Reference

For a complete technical breakdown of all 7 layers, see [ARCHITECTURE.md](ARCHITECTURE.md).

For the sleep cycle engine in depth, see [SLEEP-CYCLES.md](SLEEP-CYCLES.md).
