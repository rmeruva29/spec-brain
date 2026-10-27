import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { syncConfluence } from "./confluence/sync.ts";
import { deleteDb, openDb } from "./db.ts";
import { formatHits, formatRequirement, formatTrace } from "./format.ts";
import { ingestAll } from "./ingest/index.ts";
import { getRequirement, trace } from "./retrieval/lookup.ts";
import { search } from "./retrieval/search.ts";

const USAGE = `spec-brain <command>

  sync-confluence [--source name] [--limit n] [--batch n] [--force] [--dry-run]
                                   pull wiki pages to local markdown via Claude Code's Atlassian MCP
                                   (run from a normal terminal, not inside Claude Code)
  ingest [--force] [--rebuild]     index every configured source (incremental by content hash)
  search <query> [--k n] [--type t]  hybrid search (ids first, then keyword)
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
    k: { type: "string", default: "8" },
    type: { type: "string", multiple: true },
    depth: { type: "string", default: "2" },
    refs: { type: "boolean", default: false },
  },
});
const [command, ...rest] = positionals;
const arg = rest.join(" ");
const config = loadConfig();

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
    console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s → ${config.dbPath}`);
    break;
  }
  case "search": {
    const hits = search(openDb(config.dbPath, { readonly: true }), arg, { k: Number(values.k), filters: { docTypes: values.type } });
    console.log(formatHits(hits));
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
