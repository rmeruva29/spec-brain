import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { syncConfluence } from "./confluence/sync.ts";
import { calibrate, loadGolden, runEval, summarize, type EvalMode } from "./eval.ts";
import { deleteDb, openDb } from "./db.ts";
import { formatRequirement, formatResult, formatTrace } from "./format.ts";
import { ingestAll } from "./ingest/index.ts";
import { createEmbedder, createReranker, lazy } from "./models.ts";
import { getRequirement, trace } from "./retrieval/lookup.ts";
import { search, type Mode } from "./retrieval/search.ts";
import { EmbeddingCache, embedPending } from "./vectors.ts";

const USAGE = `spec-brain <command>

  sync-confluence [--source name] [--limit n] [--batch n] [--force] [--dry-run]
                                   pull wiki pages to local markdown via Claude Code's Atlassian MCP
                                   (run from a normal terminal, not inside Claude Code)
  ingest [--force] [--rebuild] [--no-embed]
                                   index every configured source (incremental), then embed new chunks
  embed                            embed chunks that have no vector yet (cached by content hash)
  search <query> [--k n] [--type t] [--mode bm25|vector|hybrid] [--guard | --rerank]
                                   ids first, then keyword / vector / fused search; --guard adds the
                                   reranker's relevance check, --rerank reorders by it
  eval [--golden file] [--modes grep,bm25,vector,hybrid,hybrid+guard,hybrid+rerank]
                                   score retrieval on a golden question set (report in reports/)
  get <id>                         requirement / AC / task / capability with its traceability
  trace <id> [--depth n] [--refs]  walk the traceability graph
  stats                            index counts`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    force: { type: "boolean", default: false },
    rebuild: { type: "boolean", default: false },
    source: { type: "string" },
    limit: { type: "string" },
    batch: { type: "string", default: "8" },
    "dry-run": { type: "boolean", default: false },
    "no-embed": { type: "boolean", default: false },
    mode: { type: "string", default: "hybrid" },
    rerank: { type: "boolean", default: false },
    guard: { type: "boolean", default: false },
    golden: { type: "string", default: "eval/golden.jsonl" },
    modes: { type: "string", default: "grep,bm25,vector,hybrid,hybrid+guard,hybrid+rerank" },
    k: { type: "string", default: "8" },
    type: { type: "string", multiple: true },
    depth: { type: "string", default: "2" },
    refs: { type: "boolean", default: false },
  },
});
const [command, ...rest] = positionals;
const arg = rest.join(" ");
const config = loadConfig();
const embedder = lazy(() => createEmbedder(config));
const reranker = lazy(() => createReranker(config));

async function embed(db: ReturnType<typeof openDb>) {
  const cache = new EmbeddingCache(config.embeddingCachePath);
  try {
    const e = await embedPending(db, await embedder(), cache, { log: console.log });
    console.log(`embeddings: ${e.pending} pending, ${e.fromCache} from cache, ${e.embedded} computed in ${e.seconds.toFixed(0)}s`);
  } finally {
    cache.close();
  }
}

switch (command) {
  case "sync-confluence": {
    const sources = config.sources.filter((s) => s.kind === "confluence-export" && (!values.source || s.name === values.source));
    if (!sources.length) throw new Error("No confluence-export source configured (or --source did not match).");
    for (const source of sources) {
      if (source.kind !== "confluence-export") continue;
      const r = await syncConfluence(source, {
        limit: values.limit ? Number(values.limit) : undefined,
        batch: Number(values.batch),
        force: values.force,
        dryRun: values["dry-run"],
      });
      console.log(`${source.name}: ${r.fetched} written, ${r.deleted} deleted, ${r.failed.length} failed, ~$${r.costUsd.toFixed(3)} relay cost`);
      if (r.failed.length) console.log(`  failed page ids (re-run to retry): ${r.failed.join(", ")}`);
    }
    console.log("Next: pnpm ingest");
    break;
  }
  case "ingest": {
    if (values.rebuild) deleteDb(config.dbPath);
    const db = openDb(config.dbPath);
    const started = Date.now();
    for (const s of ingestAll(db, config, { force: values.force || values.rebuild })) {
      console.log(
        `${s.source}: ${s.docsSeen} docs (${s.docsChanged} changed, ${s.docsRemoved} removed), ${s.chunks} chunks, ` +
          `${s.testFilesSeen} test files (${s.testFilesChanged} changed)`,
      );
    }
    console.log(`indexed in ${((Date.now() - started) / 1000).toFixed(1)}s → ${config.dbPath}`);
    if (!values["no-embed"]) await embed(db);
    break;
  }
  case "embed": {
    await embed(openDb(config.dbPath));
    break;
  }
  case "search": {
    const result = await search(openDb(config.dbPath, { readonly: true }), arg, {
      k: Number(values.k),
      filters: { docTypes: values.type },
      mode: values.mode as Mode,
      embedder,
      reranker: values.rerank || values.guard ? reranker : undefined,
      rerankUse: values.rerank ? "rank" : "guard",
      rerankCandidates: config.reranker.candidates,
    });
    console.log(`mode: ${result.mode}${result.confidence !== null ? ` · confidence ${result.confidence.toFixed(2)}` : ""}\n`);
    console.log(formatResult(result));
    break;
  }
  case "get": {
    const r = getRequirement(openDb(config.dbPath, { readonly: true }), arg);
    console.log(r ? formatRequirement(r) : `${arg}: not in the index.`);
    break;
  }
  case "trace": {
    const t = trace(openDb(config.dbPath, { readonly: true }), arg, { depth: Number(values.depth), includeReferences: values.refs });
    console.log(t ? formatTrace(t) : `${arg}: not in the index.`);
    break;
  }
  case "eval": {
    const db = openDb(config.dbPath, { readonly: true });
    const golden = loadGolden(values.golden);
    const modes = values.modes.split(",") as EvalMode[];
    console.log(`${golden.length} questions (${golden.filter((g) => !g.expect.length).length} negative) × ${modes.join(", ")}\n`);
    const results = await runEval(db, golden, modes, { embedder, reranker, rerankCandidates: config.reranker.candidates });
    const { rows, byCategory } = summarize(golden, results);
    console.table(rows);
    console.log("hit@3 by category");
    console.table(byCategory);
    for (const mode of modes.filter((m) => m !== "grep" && m !== "bm25")) {
      const c = calibrate(golden, results[mode]!);
      console.log(`${mode}: best low-confidence threshold ${c.threshold} → ${c.negativesFlagged} negatives / ${c.positivesFlagged} positives flagged (${Math.round(c.accuracy * 100)}% accurate)`);
    }
    const misses = golden.filter((g) => g.expect.length && results[modes.at(-1)!]!.find((r) => r.id === g.id)!.rank === null);
    if (misses.length) console.log(`\nmissed by ${modes.at(-1)}: ${misses.map((g) => g.id).join(", ")}`);
    mkdirSync("reports", { recursive: true });
    const file = `reports/eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify({ config: { embedding: config.embedding, reranker: config.reranker }, rows, byCategory, results }, null, 2));
    console.log(`\nfull results → ${file}`);
    break;
  }
  case "stats": {
    const db = openDb(config.dbPath, { readonly: true });
    const q = (sql: string) => db.prepare(sql).all();
    console.table(q("SELECT source, doc_type, count(*) docs FROM documents GROUP BY 1, 2 ORDER BY 1, 3 DESC"));
    console.table(q("SELECT d.source, c.section_kind, count(*) chunks FROM chunks c JOIN documents d ON d.id = c.doc_id GROUP BY 1, 2 ORDER BY 1, 3 DESC"));
    console.table(q("SELECT kind, count(*) n FROM entities GROUP BY 1 ORDER BY 2 DESC"));
    console.table(q("SELECT kind, count(*) n FROM edges GROUP BY 1 ORDER BY 2 DESC"));
    console.log(q("SELECT count(*) chunks, round(avg(length(text))) avg_chars, max(length(text)) max_chars FROM chunks"));
    break;
  }
  default:
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
}
