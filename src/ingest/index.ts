import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Config, SddRepoConfig, SourceConfig } from "../config.ts";
import type { DB } from "../db.ts";
import { findAcIds, findRequirementIds, testId } from "../ids.ts";
import { parseConfluenceFile } from "./confluence.ts";
import { parseSddFile, sha256, type ParsedDoc } from "./sdd.ts";

/**
 * Part of every document's change hash: bump it whenever parsing or chunking changes, so the next
 * ingest re-processes files whose content did not change.
 */
export const INGEST_VERSION = "8";
const docHash = (content: string) => sha256(`${INGEST_VERSION}\n${content}`);

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
  /** Set when the source was left as it is, e.g. a wiki source that has not been synced yet. */
  skipped?: string;
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

function listMarkdown(source: SourceConfig): string[] {
  if (source.kind === "confluence-export") {
    return [...walk(source.root, source.root, (r) => /^\d+\.md$/.test(r))];
  }
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
    `INSERT INTO documents (id, source, project, path, url, title, doc_type, domain, capability, status, content_hash)
     VALUES (@id, @source, @project, @path, @url, @title, @docType, @domain, @capability, @status, @contentHash)`,
  ).run(doc);
  const insertChunk = db.prepare(
    `INSERT INTO chunks (doc_id, ord, section, section_kind, anchor, entity_id, context, text, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const chunkIds = parsed.chunks.map((c, i) =>
    Number(
      insertChunk.run(doc.id, i, c.section, c.sectionKind, c.anchor, c.entityId, c.context, c.text, sha256(`${c.context}\n${c.text}`))
        .lastInsertRowid,
    ),
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

const parse = (source: SourceConfig, rel: string, content: string): ParsedDoc =>
  source.kind === "confluence-export" ? parseConfluenceFile(source, rel, content) : parseSddFile(source, rel, content);

export function ingestSource(db: DB, source: SourceConfig, opts: { force?: boolean } = {}): IngestStats {
  const force = opts.force ?? false;
  const stats: IngestStats = { source: source.name, docsSeen: 0, docsChanged: 0, docsRemoved: 0, chunks: 0, testFilesSeen: 0, testFilesChanged: 0 };
  if (source.kind === "confluence-export" && !existsSync(source.root)) {
    stats.skipped = `not synced yet (no ${source.root}); run sync-confluence --source ${source.name}`;
    return stats;
  }
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
      const hash = docHash(content);
      if (!force && known.get(rel)?.content_hash === hash) continue;
      const parsed = parse(source, rel, content);
      storeDoc(db, { ...parsed, doc: { ...parsed.doc, contentHash: hash } });
      stats.docsChanged++;
    }
    for (const [rel, row] of known) {
      if (seen.has(rel)) continue;
      removeDoc(db, row.id);
      stats.docsRemoved++;
    }
    if (source.kind === "sdd-repo") {
      const t = scanTests(db, source, force);
      stats.testFilesSeen = t.seen;
      stats.testFilesChanged = t.changed;
    }
  })();
  stats.chunks = (db.prepare("SELECT count(*) n FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE d.source = ?").get(source.name) as { n: number }).n;
  return stats;
}

export function ingestAll(db: DB, config: Config, opts: { force?: boolean } = {}): IngestStats[] {
  const stats = config.sources.map((s) => ingestSource(db, s, opts));
  resolveWikiLinks(db, config.sources.filter((s) => s.kind === "confluence-export").map((s) => s.name));
  return stats;
}

/**
 * A wiki page links to other pages by id, and the ingester records the target under its own source.
 * When the target was synced by another wiki source (another space or subtree of the same site), point
 * the edge at that document instead, so links across spaces are followed rather than reported missing.
 */
export function resolveWikiLinks(db: DB, wikiSources: string[]): number {
  if (wikiSources.length < 2) return 0;
  const pageDoc = new Map<string, string>();
  const pattern = /^DOC:([^:]+):(\d+)\.md$/;
  for (const { id } of db.prepare("SELECT id FROM entities WHERE kind = 'document' AND id GLOB 'DOC:*:[0-9]*.md'").all() as { id: string }[]) {
    const m = pattern.exec(id);
    if (m && wikiSources.includes(m[1]!)) pageDoc.set(m[2]!, id);
  }
  const dangling = db
    .prepare("SELECT e.src, e.dst, e.kind, e.origin FROM edges e LEFT JOIN entities n ON n.id = e.dst WHERE n.id IS NULL AND e.dst GLOB 'DOC:*:[0-9]*.md'")
    .all() as { src: string; dst: string; kind: string; origin: string }[];
  const insert = db.prepare("INSERT OR IGNORE INTO edges (src, dst, kind, origin) VALUES (?, ?, ?, ?)");
  const remove = db.prepare("DELETE FROM edges WHERE src = ? AND dst = ? AND kind = ? AND origin = ?");
  let moved = 0;
  db.transaction(() => {
    for (const e of dangling) {
      const m = pattern.exec(e.dst);
      const target = m && wikiSources.includes(m[1]!) ? pageDoc.get(m[2]!) : undefined;
      if (!target || target === e.dst) continue;
      insert.run(e.src, target, e.kind, e.origin);
      remove.run(e.src, e.dst, e.kind, e.origin);
      moved++;
    }
  })();
  return moved;
}
