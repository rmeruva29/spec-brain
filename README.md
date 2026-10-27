# spec-brain

Hybrid retrieval over spec-driven-development (SDD) repositories and architecture documents, served to coding agents over MCP.

Specs written for SDD are full of stable identifiers (`WDG-CCH-001`, `AC-WDG-CCH-003`), traceability links (requirement → acceptance criterion → plan task → Jira → test) and prose decisions. No single retrieval method covers all three, so spec-brain combines:

| Layer | Answers | Implementation |
|---|---|---|
| Exact ids | "What does WDG-CCH-001 say?" | id router → entity table |
| Keyword (BM25) | Identifiers, code names, exact phrases | SQLite FTS5 |
| Vectors | Questions phrased differently from the spec | local `bge-base-en-v1.5` embeddings in sqlite-vec, fused with BM25 by RRF, optional `bge-reranker-base` cross-encoder |
| Graph | Impact analysis, coverage, drift | `entities` / `edges` tables, BFS |

Everything runs locally in one Node process with one SQLite file: no server, no hosted vector store, no LLM API key. Embedding and reranking models are ONNX weights downloaded once into `.cache/models` and run on the CPU, so indexed text never leaves the machine. The calling agent (e.g. Claude Code) writes the answer from the cited chunks; when nothing scores above the calibrated threshold, results are marked low confidence so the agent says "not covered" instead of guessing.

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

Tools: `search_specs`, `get_requirement`, `trace`. All are read-only and every result leads with a `path#anchor` citation and the document's status. `search_specs` reranks by default; set `SPEC_BRAIN_RERANK=0` for faster, unreranked results.

## What gets indexed

Two source kinds (see `spec-brain.config.example.json`).

### `sdd-repo`

- `specs/<domain>/<capability>/{spec,plan,decisions}.md`: requirement rows, AC rows (with their `Verifies` ranges expanded) and plan-task rows each become their own chunk and graph entity; other sections are chunked by heading (~800 tokens max) with a contextual prefix (project · type · domain · capability · section · status).
- `docs/**`, agent and skill definitions, `CLAUDE.md` / `AGENTS.md`: chunked by heading.
- Test files under `testRoots` that cite AC ids become `tested_by` edges.
- Jira keys for the configured projects become `tracked_by` / `references` edges.

### `confluence-export`

A wiki page tree, synced to local markdown (`<pageId>.md` with frontmatter: title, URL, ancestors, last modified):

```sh
pnpm cli sync-confluence --dry-run     # list the tree and show what would change
pnpm cli sync-confluence --limit 10    # try a few pages first
pnpm cli sync-confluence               # everything new or changed since the last sync
pnpm ingest
```

The sync never handles an Atlassian token. It starts a headless Claude Code session (`claude -p`, Haiku) that calls the Atlassian MCP server you have already authorised, and reads the raw tool results from its `stream-json` output, so page text is never retyped by a model. It is incremental by each page's last-modified time, removes pages that left the tree, and skips subtrees whose title matches `excludeTitles`. Run it from a normal terminal: Claude Code refuses to start a nested session.

Pages are typed (`aad` architecture approach documents, `standard` guardrails/guidelines/policies, `template`, `assessment`, `strategy`, `diagram`, `wiki`) and given a status from the title (`[DRAFT]`, `(Moved)`), the tree ("Pending Review") and the document-acceptance table (approved / conditional / not approved). Sections are chunked below the chapter level, empty template headings and revision tables are dropped, and every chunk carries a section kind from a taxonomy shared with specs (`logging`, `monitoring`, `security`, `nfr`, `decision`, `design`, …) so `search_specs` can filter on it. Citations are the page URL plus the Confluence heading anchor.

Re-ingest is incremental by content hash; each file's chunks, entities and edges are replaced as a unit. `ingest --rebuild` recreates the index after a schema change.

## Evaluation

```sh
pnpm cli eval --golden eval/golden.jsonl --modes grep,bm25,vector,hybrid,hybrid+rerank
```

A golden set is one JSON question per line with the documents that answer it (`eval/golden.example.jsonl` shows the format; real sets stay local). The report gives hit@1/3/8 and MRR at document level per retrieval mode and per question category, how many negative questions were flagged low confidence (and how many answerable ones were wrongly flagged), latency, and the best low-confidence threshold for each mode. `grep` is the baseline: documents ranked by how many query terms they contain. Full per-question results go to `reports/`.

## Data safety

This repository holds **code only**. `data/`, `corpus/`, `reports/`, `eval/golden*`, `*.db` and `spec-brain.config.json` are gitignored, and `.githooks/pre-commit` (enabled by `pnpm install`) refuses to commit them. Organisation-specific markers can be listed one regex per line in the untracked `.githooks/deny-patterns.local`; staged lines matching them are rejected. `gitleaks` runs too when installed. Test fixtures are synthetic.

## Roadmap

1. ✅ SDD ingest, entity graph, id lookup, trace, BM25 search, MCP server
2. ✅ Confluence source: MCP-relayed sync to local markdown, page typing and approval status, shared section taxonomy
3. ✅ Local embeddings + sqlite-vec, RRF fusion, optional cross-encoder rerank, low-confidence signal; evaluation harness with ablations against plain grep
4. `get_standards`, `find_precedent`, drift report (undefined references, ACs without tests, status vs delivery), decision ledger
