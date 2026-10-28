import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { syncConfluence } from "./confluence/sync.ts";
import { calibrate, loadGolden, runEval, summarize, type EvalMode } from "./eval.ts";
import { deleteDb, openDb } from "./db.ts";
import { formatDrift, formatPrecedent, formatRequirement, formatResult, formatStandards, formatTrace } from "./format.ts";
import { ingestAll } from "./ingest/index.ts";
import { createEmbedder, createReranker, lazy } from "./models.ts";
import { driftReport } from "./retrieval/drift.ts";
import { getRequirement, trace } from "./retrieval/lookup.ts";
import { search, type Mode } from "./retrieval/search.ts";
import { findPrecedent, getStandards, standardsPages } from "./retrieval/standards.ts";
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
  standards <topic> [--system s]   standards and guardrails on a topic, then how designs applied them
  precedent <question>             earlier decision records (AADs, ADRs) on the question, per document
  drift                            undefined ids, unverified requirements, untested criteria, empty
                                   standards pages, linked wiki pages missing from the corpus
  distill [topic,topic,...]        evidence pack per standards topic (reports/standards/) for drafting
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
    system: { type: "string" },
  },
});
const [command, ...rest] = positionals;
const arg = rest.join(" ");
const config = loadConfig();
const embedder = lazy(() => createEmbedder(config));
const reranker = lazy(() => createReranker(config));
const guarded = { embedder, reranker, rerankUse: "guard" as const, rerankCandidates: config.reranker.candidates };

const DISTILL_TOPICS = [
  "logging standard and required log fields",
  "monitoring and Dynatrace alerting for services",
  "REST API design, versioning and contracts",
  "application security, vulnerabilities, secrets management and authentication",
  "error handling, retries and dead-letter queues",
  "testing, test automation and quality gates",
  "deployment, release and rollback",
  "database and data migration",
];

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
      if (s.skipped) {
        console.log(`${s.source}: skipped, ${s.skipped}`);
        continue;
      }
      console.log(
        `${s.source}: ${s.docsSeen} docs (${s.docsChanged} changed, ${s.docsRemoved} removed` +
          `${s.docsExcluded ? `, ${s.docsExcluded} excluded by title` : ""}), ${s.chunks} chunks, ` +
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
  case "standards": {
    console.log(formatStandards(await getStandards(openDb(config.dbPath, { readonly: true }), arg, { ...guarded, system: values.system })));
    break;
  }
  case "precedent": {
    console.log(formatPrecedent(await findPrecedent(openDb(config.dbPath, { readonly: true }), arg, guarded)));
    break;
  }
  case "drift": {
    console.log(formatDrift(driftReport(openDb(config.dbPath, { readonly: true }))));
    break;
  }
  case "distill": {
    // Evidence for drafting STD-* statements by hand or with an agent; stays in the gitignored reports/.
    const db = openDb(config.dbPath, { readonly: true });
    const topics = arg ? arg.split(",").map((t) => t.trim()) : DISTILL_TOPICS;
    mkdirSync("reports/standards", { recursive: true });
    for (const topic of topics) {
      const file = `reports/standards/${topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`;
      const found = await getStandards(db, topic, { ...guarded, k: 8 });
      const precedent = formatPrecedent(await findPrecedent(db, topic, { ...guarded, docs: 8 }));
      // Up to three excerpts per page means k=8 can name as few as three pages; search deeper to pick the full-text pages.
      const pages = standardsPages(db, await getStandards(db, topic, { ...guarded, k: 16 }))
        .map((p) => `## ${p.title ?? p.path} · ${p.status ? `status: ${p.status}` : "approval not recorded"} · ${p.url ?? p.path}\n\n${p.text}`)
        .join("\n\n");
      writeFileSync(
        file,
        `# Evidence: ${topic}\n\n${formatStandards(found)}\n\n== Decision records ==\n${precedent}\n` +
          (pages ? `\n== Full text of the primary standards pages ==\n\n${pages}\n` : ""),
      );
      console.log(`${topic} → ${file}`);
    }
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
