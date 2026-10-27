import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SddRepoConfig } from "../src/config.ts";
import { openDb, type DB } from "../src/db.ts";
import { ingestSource } from "../src/ingest/index.ts";
import type { Embedder, Reranker } from "../src/models.ts";
import { rrf, search, type Hit } from "../src/retrieval/search.ts";
import { EmbeddingCache, embedPending, vectorModel } from "../src/vectors.ts";

// Deterministic stand-ins for the ONNX models: hashed bag-of-words vectors and word-overlap scores.
const DIM = 64;
const words = (s: string) => s.toLowerCase().match(/[a-z]{3,}/g) ?? [];
function fakeEmbedder(model = "fake"): Embedder & { calls: number } {
  const e = {
    model,
    dim: DIM,
    calls: 0,
    async embed(texts: string[]) {
      e.calls += texts.length;
      return texts.map((t) => {
        const v = new Float32Array(DIM);
        for (const w of words(t)) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % DIM, 7)]! += 1;
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
  return e;
}
const fakeReranker = (score: (q: string, p: string) => number): Reranker => ({
  model: "fake-rerank",
  async score(q, passages) {
    return passages.map((p) => score(q, p));
  },
});

const source: SddRepoConfig = {
  kind: "sdd-repo",
  name: "acme",
  project: "Acme",
  root: join(import.meta.dirname, "fixtures/sdd-repo"),
  include: ["specs", "docs"],
  testRoots: [],
  jiraProjects: ["ACME"],
};

let db: DB;
let cache: EmbeddingCache;
beforeEach(() => {
  db = openDb(":memory:");
  cache = new EmbeddingCache(":memory:");
  ingestSource(db, source);
});
afterEach(() => {
  db.close();
  cache.close();
});

const chunkCount = () => (db.prepare("SELECT count(*) n FROM chunks").get() as { n: number }).n;
const vecCount = () => (db.prepare("SELECT count(*) n FROM chunk_vec").get() as { n: number }).n;

describe("embedding", () => {
  it("embeds every chunk once, then only what is missing", async () => {
    const e = fakeEmbedder();
    const first = await embedPending(db, e, cache);
    expect(first).toMatchObject({ pending: chunkCount(), embedded: chunkCount(), fromCache: 0 });
    expect(vecCount()).toBe(chunkCount());
    expect((await embedPending(db, e, cache)).pending).toBe(0);
  });

  it("reuses cached vectors after the index is rebuilt", async () => {
    await embedPending(db, fakeEmbedder(), cache);
    const rebuilt = openDb(":memory:");
    ingestSource(rebuilt, source);
    const e = fakeEmbedder();
    const stats = await embedPending(rebuilt, e, cache);
    expect(stats.fromCache).toBe(stats.pending);
    expect(e.calls).toBe(0);
    rebuilt.close();
  });

  it("drops a chunk's vector with the chunk and starts over when the model changes", async () => {
    await embedPending(db, fakeEmbedder(), cache);
    db.prepare("DELETE FROM chunks WHERE id = (SELECT min(id) FROM chunks)").run();
    expect(vecCount()).toBe(chunkCount());

    await embedPending(db, fakeEmbedder("other-model"), cache);
    expect(vectorModel(db)).toBe("other-model");
    expect(vecCount()).toBe(chunkCount());
  });
});

describe("hybrid search", () => {
  it("fuses ranked lists so items found by both retrievers rise", () => {
    const h = (id: number) => ({ chunkId: id }) as Hit;
    expect(rrf([[h(1), h(2), h(3)], [h(3), h(4), h(1)]]).map((x) => x.chunkId)).toEqual([1, 3, 2, 4]);
  });

  it("finds chunks through vectors and reports confidence", async () => {
    await embedPending(db, fakeEmbedder(), cache);
    const embedder = async () => fakeEmbedder();
    const r = await search(db, "cached widgets during configuration outage", { mode: "vector", embedder });
    expect(r.mode).toBe("vector");
    expect(r.hits.slice(0, 2).map((h) => h.text).join(" ")).toMatch(/configuration (service|outage)/);
    expect(r.confidence).toBeGreaterThan(0);
  });

  it("falls back to keyword search when no vectors exist", async () => {
    const r = await search(db, "cache misses logged", { mode: "hybrid", embedder: async () => fakeEmbedder() });
    expect(r).toMatchObject({ mode: "bm25", confidence: null, lowConfidence: false });
  });

  it("re-scores with the reranker and flags questions nothing matches", async () => {
    await embedPending(db, fakeEmbedder(), cache);
    const embedder = async () => fakeEmbedder();
    const relevant = await search(db, "cache expiry seconds", { embedder, reranker: async () => fakeReranker((_q, p) => (/300 seconds/.test(p) ? 0.9 : 0.05)) });
    expect(relevant).toMatchObject({ mode: "hybrid+rerank", lowConfidence: false });
    expect(relevant.hits[0]!.text).toMatch(/300 seconds/);

    const offTopic = await search(db, "payroll tax withholding", { embedder, reranker: async () => fakeReranker(() => 0.01) });
    expect(offTopic.lowConfidence).toBe(true);
  });

  it("in guard mode keeps the fused order and only uses the reranker for confidence", async () => {
    await embedPending(db, fakeEmbedder(), cache);
    const embedder = async () => fakeEmbedder();
    const plain = await search(db, "cache expiry seconds", { embedder });
    const guarded = await search(db, "cache expiry seconds", { embedder, reranker: async () => fakeReranker(() => 0.5), rerankUse: "guard" });
    expect(guarded.hits.map((h) => h.chunkId)).toEqual(plain.hits.map((h) => h.chunkId));
    expect(guarded).toMatchObject({ mode: "hybrid+guard", confidence: 0.5, lowConfidence: false });

    const offTopic = await search(db, "payroll tax withholding", { embedder, reranker: async () => fakeReranker(() => 0.001), rerankUse: "guard" });
    expect(offTopic.lowConfidence).toBe(true);
  });

  it("never flags low confidence when the query names an indexed id", async () => {
    await embedPending(db, fakeEmbedder(), cache);
    const r = await search(db, "WDG-CCH-002", { embedder: async () => fakeEmbedder(), reranker: async () => fakeReranker(() => 0.01) });
    expect(r).toMatchObject({ lowConfidence: false, confidence: 1 });
    expect(r.hits[0]!.entityId).toBe("WDG-CCH-002");
  });
});
