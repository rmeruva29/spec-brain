# spec-brain

Hybrid retrieval over spec-driven-development (SDD) repositories and architecture documents, served to coding agents over MCP.

Specs written for SDD are full of stable identifiers (`WDG-CCH-001`, `AC-WDG-CCH-003`), traceability links (requirement → acceptance criterion → plan task → Jira → test) and prose decisions. No single retrieval method covers all three, so spec-brain combines:

| Layer | Answers | Implementation |
|---|---|---|
| Exact ids | "What does WDG-CCH-001 say?" | id router → entity table |
| Keyword (BM25) | Identifiers, code names, exact phrases | SQLite FTS5 |
| Vectors *(next)* | Questions phrased differently from the spec | local embeddings + sqlite-vec, fused with RRF |
| Graph | Impact analysis, coverage, drift | `entities` / `edges` tables, BFS |

Everything runs locally in one Node process with one SQLite file: no server, no hosted vector store, no LLM API key. The calling agent (e.g. Claude Code) writes the answer from the cited chunks.

## Quick start

```sh
pnpm install
cp spec-brain.config.example.json spec-brain.config.json   # point "root" at an SDD repo
pnpm ingest                                                  # incremental; --force to rebuild
pnpm cli get WDG-CCH-001
pnpm cli trace AC-WDG-CCH-001 --depth 2
pnpm cli search "what happens when the config service is down"
pnpm cli stats
```

### Use from Claude Code

```sh
claude mcp add spec-brain -- /absolute/path/to/spec-brain/bin/spec-brain-mcp
```

Tools: `search_specs`, `get_requirement`, `trace`. All are read-only and every result leads with a `path#anchor` citation and the document's status.

## What gets indexed

For an `sdd-repo` source (see `spec-brain.config.example.json`):

- `specs/<domain>/<capability>/{spec,plan,decisions}.md`: requirement rows, AC rows (with their `Verifies` ranges expanded) and plan-task rows each become their own chunk and graph entity; other sections are chunked by heading (~800 tokens max) with a contextual prefix (project · type · domain · capability · section · status).
- `docs/**`, agent and skill definitions, `CLAUDE.md` / `AGENTS.md`: chunked by heading.
- Test files under `testRoots` that cite AC ids become `tested_by` edges.
- Jira keys for the configured projects become `tracked_by` / `references` edges.

Re-ingest is incremental by content hash; each file's chunks, entities and edges are replaced as a unit.

## Data safety

This repository holds **code only**. `data/`, `corpus/`, `reports/`, `eval/golden*`, `*.db` and `spec-brain.config.json` are gitignored, and `.githooks/pre-commit` (enabled by `pnpm install`) refuses to commit them. Organisation-specific markers can be listed one regex per line in the untracked `.githooks/deny-patterns.local`; staged lines matching them are rejected. `gitleaks` runs too when installed. Test fixtures are synthetic.

## Roadmap

1. ✅ SDD ingest, entity graph, id lookup, trace, BM25 search, MCP server
2. Wiki/Confluence source: pages exported to local markdown by an agent skill, section taxonomy for architecture documents
3. Local embeddings + sqlite-vec, RRF fusion, optional cross-encoder rerank; evaluation harness with ablations against plain grep
4. `get_standards`, `find_precedent`, drift report (undefined references, ACs without tests, status vs delivery), decision ledger
