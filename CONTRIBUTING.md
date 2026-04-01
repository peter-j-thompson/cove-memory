# Contributing to OpenMemory

Thanks for your interest in contributing. This is an open-source cognitive architecture for AI agents — a space where good ideas matter a lot.

---

## What we're looking for

### High-value contributions
- **New layer implementations** — additional memory modalities (spatial, procedural subtypes, etc.)
- **Embedding model support** — adapters for models beyond Ollama/bge-m3
- **LLM provider support** — adapters for OpenAI, Mistral, local LLMs for consolidation
- **Performance improvements** — the graph queries and vector operations are hot paths
- **Test coverage** — we need a proper test suite
- **Real-world examples** — agents built on OpenMemory showing concrete use cases
- **Bug fixes** — clear reproduction + fix

### Things to discuss first (open an issue)
- Major architectural changes to the 7-layer model
- New sleep cycle types or consolidation strategies
- Changes to the database schema
- New API endpoints

---

## Setup

```bash
git clone https://github.com/peter-j-thompson/openmemory.git
cd openmemory
npm install
cp .env.example .env
# Configure .env for local dev
docker-compose up -d
npm run dev
```

---

## Code style

- **TypeScript strict mode** — no `any` unless absolutely necessary with a comment explaining why
- **Explicit types** — don't rely on inference for function signatures
- **Comments on intent** — comment WHY, not what. The code shows what. The comment shows why.
- **No hardcoded credentials** — ever, anywhere. Use environment variables.
- **No personal data in code** — seeds should use example data, not real people

---

## Pull request process

1. **Fork** the repo and create your branch from `main`
2. **Test your changes** — at minimum, verify the TypeScript compiles and the health check passes
3. **Write meaningful commit messages** — what changed and why, not just "fix bug"
4. **Update docs** if your change affects behavior
5. **Open a PR** with a clear description of what you changed and why

---

## Reporting bugs

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce (minimal reproduction preferred)
- Your environment (Node version, OS, Docker version)
- Relevant logs from `docker logs openmemory-db` and the API

---

## Proposing features

Open an issue describing:
- The problem you're trying to solve
- Why the current approach doesn't solve it
- Your proposed solution at a high level
- Any alternatives you considered

We'll discuss before you spend time building.

---

## Questions?

Join the Discord: [discord.com/invite/clawd](https://discord.com/invite/clawd)

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
