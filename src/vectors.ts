import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DB } from "./db.ts";
import type { Embedder } from "./models.ts";

const meta = (db: DB, key: string) => (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
const setMeta = (db: DB, key: string, value: string) => db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);

export const hasVectors = (db: DB) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunk_vec'").get();
export const vectorModel = (db: DB) => meta(db, "vec_model") ?? null;

/** Creates (or, when the model changed, recreates) the vector table and its delete trigger. */
export function ensureVectorTable(db: DB, model: string, dim: number) {
  if (hasVectors(db) && meta(db, "vec_model") === model && meta(db, "vec_dim") === String(dim)) return;
  db.exec(`
    DROP TRIGGER IF EXISTS chunks_vec_ad;
    DROP TABLE IF EXISTS chunk_vec;
    CREATE VIRTUAL TABLE chunk_vec USING vec0(embedding float[${dim}] distance_metric=cosine);
    CREATE TRIGGER chunks_vec_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM chunk_vec WHERE rowid = old.id;
    END;
  `);
  setMeta(db, "vec_model", model);
  setMeta(db, "vec_dim", String(dim));
}

/** Embeddings keyed by (chunk content hash, model), kept outside the index so rebuilds are cheap. */
export class EmbeddingCache {
  private db: Database.Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS embeddings (content_hash TEXT NOT NULL, model TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (content_hash, model))");
  }
  get(hash: string, model: string): Float32Array | null {
    const row = this.db.prepare("SELECT vector FROM embeddings WHERE content_hash = ? AND model = ?").get(hash, model) as { vector: Buffer } | undefined;
    return row ? new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength)) : null;
  }
  put(hash: string, model: string, vector: Float32Array) {
    this.db.prepare("INSERT OR REPLACE INTO embeddings (content_hash, model, vector) VALUES (?, ?, ?)").run(hash, model, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
  }
  close() {
    this.db.close();
  }
}

export interface EmbedStats {
  pending: number;
  fromCache: number;
  embedded: number;
  seconds: number;
}

/** Fills chunk_vec for every chunk without a vector, from the cache when possible. */
export async function embedPending(db: DB, embedder: Embedder, cache: EmbeddingCache, opts: { batch?: number; log?: (m: string) => void } = {}): Promise<EmbedStats> {
  const started = Date.now();
  ensureVectorTable(db, embedder.model, embedder.dim);
  const pending = db
    .prepare(
      `SELECT c.id, c.content_hash AS hash, c.context || char(10) || c.text AS input
         FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM chunk_vec v WHERE v.rowid = c.id)`,
    )
    .all() as { id: number; hash: string; input: string }[];
  const insert = db.prepare("INSERT INTO chunk_vec (rowid, embedding) VALUES (?, ?)");
  let fromCache = 0;
  const todo: typeof pending = [];
  db.transaction(() => {
    for (const p of pending) {
      const v = cache.get(p.hash, embedder.model);
      if (v) {
        insert.run(BigInt(p.id), v);
        fromCache++;
      } else todo.push(p);
    }
  })();

  // Similar lengths per batch keep padding, and so wasted compute, low.
  todo.sort((a, b) => a.input.length - b.input.length);
  const batch = opts.batch ?? 16;
  let lastLog = Date.now();
  for (let i = 0; i < todo.length; i += batch) {
    const slice = todo.slice(i, i + batch);
    const vectors = await embedder.embed(
      slice.map((p) => p.input),
      "passage",
    );
    db.transaction(() => {
      slice.forEach((p, j) => {
        insert.run(BigInt(p.id), vectors[j]!);
        cache.put(p.hash, embedder.model, vectors[j]!);
      });
    })();
    if (opts.log && Date.now() - lastLog > 15_000) {
      lastLog = Date.now();
      opts.log(`  embedded ${Math.min(i + batch, todo.length)}/${todo.length}`);
    }
  }
  return { pending: pending.length, fromCache, embedded: todo.length, seconds: (Date.now() - started) / 1000 };
}
