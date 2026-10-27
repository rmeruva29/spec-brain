import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

const SCHEMA_VERSION = 1;

// `origin` on entities and edges is the document id (or test-file id) that produced them,
// so re-ingesting one file replaces exactly what that file contributed to the graph.
const SCHEMA = `
CREATE TABLE documents (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  project       TEXT NOT NULL,
  path          TEXT NOT NULL,
  title         TEXT,
  doc_type      TEXT NOT NULL,
  domain        TEXT,
  capability    TEXT,
  status        TEXT,
  content_hash  TEXT NOT NULL
);

CREATE TABLE chunks (
  id            INTEGER PRIMARY KEY,
  doc_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,
  section       TEXT,
  anchor        TEXT,
  entity_id     TEXT,
  context       TEXT NOT NULL,
  text          TEXT NOT NULL,
  content_hash  TEXT NOT NULL
);
CREATE INDEX chunks_doc ON chunks(doc_id);
CREATE INDEX chunks_entity ON chunks(entity_id);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  context, text, content='chunks', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, context, text) VALUES (new.id, new.context, new.text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, context, text) VALUES ('delete', old.id, old.context, old.text);
END;

CREATE TABLE entities (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,
  title     TEXT,
  status    TEXT,
  chunk_id  INTEGER,
  origin    TEXT NOT NULL
);
CREATE INDEX entities_origin ON entities(origin);

CREATE TABLE edges (
  src     TEXT NOT NULL,
  dst     TEXT NOT NULL,
  kind    TEXT NOT NULL,
  origin  TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind, origin)
);
CREATE INDEX edges_dst ON edges(dst);
CREATE INDEX edges_origin ON edges(origin);

CREATE TABLE scanned_files (
  id            TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL
);
`;

export function openDb(path: string, opts: { readonly?: boolean } = {}): DB {
  if (path !== ":memory:" && !opts.readonly) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { readonly: opts.readonly ?? false, fileMustExist: opts.readonly ?? false });
  db.pragma("foreign_keys = ON");
  if (opts.readonly) return db;
  db.pragma("journal_mode = WAL");
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version === 0) {
    db.exec(SCHEMA);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  } else if (version !== SCHEMA_VERSION) {
    throw new Error(`Index schema v${version} != v${SCHEMA_VERSION}; delete ${path} and re-run ingest.`);
  }
  return db;
}
