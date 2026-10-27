import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Config, SddRepoConfig } from "../config.ts";
import type { DB } from "../db.ts";
import { findAcIds, findRequirementIds, testId } from "../ids.ts";
import { parseSddFile, sha256, type ParsedDoc } from "./sdd.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage", "out", ".gradle", "target"]);
const TEST_FILE_RE = /(\.(test|spec)\.[cm]?[jt]sx?|(Test|Tests|IT)\.(java|kt))$/;

export interface IngestStats {
  source: string;
  docsSeen: number;
  docsChanged: number;
  docsRemoved: number;
  chunks: number;
  testFilesSeen: number;
  testFilesChanged: number;
}

function* walk(root: string, dir: string, accept: (rel: string) => boolean): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) yield* walk(root, full, accept);
    else {
      const rel = relative(root, full).split(sep).join("/");
      if (accept(rel)) yield rel;
    }
  }
}

function listMarkdown(source: SddRepoConfig): string[] {
  const files = new Set<string>();
  for (const inc of source.include) {
    const full = join(source.root, inc);
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isFile()) files.add(inc);
    else for (const rel of walk(source.root, full, (r) => r.endsWith(".md"))) files.add(rel);
  }
  return [...files].sort();
}

/** Replaces everything one origin (document or test file) contributed to the index. */
function clearOrigin(db: DB, origin: string) {
  db.prepare("DELETE FROM edges WHERE origin = ?").run(origin);
  db.prepare("DELETE FROM entities WHERE origin = ?").run(origin);
}

export function storeDoc(db: DB, parsed: ParsedDoc) {
  const { doc } = parsed;
  clearOrigin(db, doc.id);
  db.prepare("DELETE FROM documents WHERE id = ?").run(doc.id);
  db.prepare(
    `INSERT INTO documents (id, source, project, path, title, doc_type, domain, capability, status, content_hash)
     VALUES (@id, @source, @project, @path, @title, @docType, @domain, @capability, @status, @contentHash)`,
  ).run(doc);
  const insertChunk = db.prepare(
    `INSERT INTO chunks (doc_id, ord, section, anchor, entity_id, context, text, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const chunkIds = parsed.chunks.map((c, i) =>
    Number(insertChunk.run(doc.id, i, c.section, c.anchor, c.entityId, c.context, c.text, sha256(`${c.context}\n${c.text}`)).lastInsertRowid),
  );
  // An id defined in two documents keeps the first definition; the duplicate is still searchable as a chunk.
  const insertEntity = db.prepare(`INSERT OR IGNORE INTO entities (id, kind, title, status, chunk_id, origin) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const e of parsed.entities) {
    insertEntity.run(e.id, e.kind, e.title, e.status, e.chunkIndex === null ? null : chunkIds[e.chunkIndex], doc.id);
  }
  const insertEdge = db.prepare(`INSERT OR IGNORE INTO edges (src, dst, kind, origin) VALUES (?, ?, ?, ?)`);
  for (const e of parsed.edges) insertEdge.run(e.src, e.dst, e.kind, doc.id);
}

function removeDoc(db: DB, id: string) {
  clearOrigin(db, id);
  db.prepare("DELETE FROM documents WHERE id = ?").run(id);
}

/** Links acceptance criteria (and requirements) to the test files whose names or bodies cite them. */
function scanTests(db: DB, source: SddRepoConfig, force: boolean) {
  const seen = new Set<string>();
  let changed = 0;
  const known = new Map(
    (db.prepare("SELECT id, content_hash FROM scanned_files WHERE id LIKE ?").all(`TEST:${source.name}:%`) as { id: string; content_hash: string }[]).map(
      (r) => [r.id, r.content_hash],
    ),
  );
  for (const root of source.testRoots) {
    for (const rel of walk(source.root, join(source.root, root), (r) => TEST_FILE_RE.test(r))) {
      const id = testId(source.name, rel);
      seen.add(id);
      const content = readFileSync(join(source.root, rel), "utf8");
      const hash = sha256(content);
      if (!force && known.get(id) === hash) continue;
      changed++;
      clearOrigin(db, id);
      const acs = findAcIds(content);
      const reqs = findRequirementIds(content);
      if (acs.length || reqs.length) {
        db.prepare(`INSERT OR REPLACE INTO entities (id, kind, title, status, chunk_id, origin) VALUES (?, 'test', ?, NULL, NULL, ?)`).run(id, rel, id);
        const insertEdge = db.prepare(`INSERT OR IGNORE INTO edges (src, dst, kind, origin) VALUES (?, ?, 'tested_by', ?)`);
        for (const ref of [...acs, ...reqs]) insertEdge.run(ref, id, id);
      }
      db.prepare("INSERT OR REPLACE INTO scanned_files (id, content_hash) VALUES (?, ?)").run(id, hash);
    }
  }
  for (const id of known.keys()) {
    if (seen.has(id)) continue;
    clearOrigin(db, id);
    db.prepare("DELETE FROM scanned_files WHERE id = ?").run(id);
  }
  return { seen: seen.size, changed };
}

export function ingestSource(db: DB, source: SddRepoConfig, opts: { force?: boolean } = {}): IngestStats {
  const force = opts.force ?? false;
  const stats: IngestStats = { source: source.name, docsSeen: 0, docsChanged: 0, docsRemoved: 0, chunks: 0, testFilesSeen: 0, testFilesChanged: 0 };
  const known = new Map(
    (db.prepare("SELECT id, path, content_hash FROM documents WHERE source = ?").all(source.name) as { id: string; path: string; content_hash: string }[]).map(
      (r) => [r.path, r],
    ),
  );
  db.transaction(() => {
    const seen = new Set<string>();
    for (const rel of listMarkdown(source)) {
      seen.add(rel);
      stats.docsSeen++;
      const content = readFileSync(join(source.root, rel), "utf8");
      if (!force && known.get(rel)?.content_hash === sha256(content)) continue;
      storeDoc(db, parseSddFile(source, rel, content));
      stats.docsChanged++;
    }
    for (const [rel, row] of known) {
      if (seen.has(rel)) continue;
      removeDoc(db, row.id);
      stats.docsRemoved++;
    }
    const t = scanTests(db, source, force);
    stats.testFilesSeen = t.seen;
    stats.testFilesChanged = t.changed;
  })();
  stats.chunks = (db.prepare("SELECT count(*) n FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE d.source = ?").get(source.name) as { n: number }).n;
  return stats;
}

export function ingestAll(db: DB, config: Config, opts: { force?: boolean } = {}): IngestStats[] {
  return config.sources.map((s) => ingestSource(db, s, opts));
}
