import type { DB } from "../db.ts";
import { AC_RE, REQ_RE } from "../ids.ts";
import type { Embedder, Reranker } from "../models.ts";
import { hasVectors } from "../vectors.ts";
import { getEntity, normalizeId } from "./lookup.ts";

export interface SearchFilters {
  project?: string;
  docTypes?: string[];
  domain?: string;
  /** Restrict to section kinds from the shared taxonomy, e.g. ["logging", "monitoring"]. */
  sectionKinds?: string[];
  /** Archived documents, templates, and withdrawn or superseded material are excluded unless this is set. */
  includeArchived?: boolean;
}

export interface Hit {
  chunkId: number;
  entityId: string | null;
  source: string;
  path: string;
  url: string | null;
  title: string | null;
  anchor: string | null;
  section: string | null;
  sectionKind: string | null;
  docType: string;
  status: string | null;
  context: string;
  text: string;
  score: number;
  via: "id" | "keyword" | "vector" | "hybrid";
}

const STOPWORDS = new Set(
  "a an and are as at be by do does for from has have how i if in is it its of on or our should that the their then there these this to was we what when where which who why will with".split(
    " ",
  ),
);

/** Builds an FTS5 OR-query of quoted terms, so ids like WDG-CCH-001 match as phrases and user input can't inject FTS syntax. */
export function toFtsQuery(query: string): string | null {
  const terms = (query.match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? [])
    .map((t) => t.replace(/[.-]+$/, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t.toLowerCase()));
  if (!terms.length) return null;
  return [...new Set(terms)].map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

const HIT_COLUMNS = `c.id AS chunkId, c.entity_id AS entityId, d.source, d.path, d.url, d.title, c.anchor, c.section,
  c.section_kind AS sectionKind, d.doc_type AS docType, d.status, c.context, c.text`;

function filterSql(f: SearchFilters): { sql: string; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (f.project) {
    clauses.push("d.project = ?");
    args.push(f.project);
  }
  if (f.domain) {
    clauses.push("d.domain = ?");
    args.push(f.domain);
  }
  if (f.docTypes?.length) {
    clauses.push(`d.doc_type IN (${f.docTypes.map(() => "?").join(",")})`);
    args.push(...f.docTypes);
  }
  if (f.sectionKinds?.length) {
    clauses.push(`c.section_kind IN (${f.sectionKinds.map(() => "?").join(",")})`);
    args.push(...f.sectionKinds);
  }
  if (!f.includeArchived) clauses.push("d.doc_type NOT IN ('archive', 'template') AND COALESCE(d.status, '') NOT IN ('withdrawn', 'superseded')");
  return { sql: clauses.length ? `AND ${clauses.join(" AND ")}` : "", args };
}

export function keywordSearch(db: DB, query: string, opts: { k?: number; filters?: SearchFilters } = {}): Hit[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const { sql, args } = filterSql(opts.filters ?? {});
  // bm25() is lower-is-better; the contextual prefix counts less than the chunk body.
  const rows = db
    .prepare(
      `SELECT ${HIT_COLUMNS}, -bm25(chunks_fts, 0.3, 1.0) AS score
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN documents d ON d.id = c.doc_id
        WHERE chunks_fts MATCH ? ${sql}
        ORDER BY score DESC LIMIT ?`,
    )
    .all(fts, ...args, opts.k ?? 30) as Omit<Hit, "via">[];
  return rows.map((r) => ({ ...r, via: "keyword" as const }));
}

/** Chunks that define the requirement / AC / task ids named in the query, in the order they appear. */
export function idHits(db: DB, query: string): Hit[] {
  const ids = [...new Set([...(query.match(AC_RE) ?? []), ...(query.match(REQ_RE) ?? []), ...(query.match(/\bTASK:\S+/g) ?? [])])];
  const hits: Hit[] = [];
  for (const raw of ids) {
    const e = getEntity(db, normalizeId(raw));
    if (!e?.citation) continue;
    const row = db.prepare(`SELECT ${HIT_COLUMNS} FROM entities en JOIN chunks c ON c.id = en.chunk_id JOIN documents d ON d.id = c.doc_id WHERE en.id = ?`).get(e.id) as
      | Omit<Hit, "via" | "score">
      | undefined;
    if (row) hits.push({ ...row, score: Number.POSITIVE_INFINITY, via: "id" });
  }
  return hits;
}

export type Mode = "bm25" | "vector" | "hybrid";

export interface SearchOptions {
  k?: number;
  filters?: SearchFilters;
  mode?: Mode;
  embedder?: () => Promise<Embedder>;
  /** When given, fused candidates are re-scored by a cross-encoder. */
  reranker?: () => Promise<Reranker>;
  /**
   * "rank" (default) reorders the fused candidates by reranker score. "guard" keeps the fused order and
   * only scores the top few hits, as a cheap relevance check for the low-confidence signal.
   */
  rerankUse?: "rank" | "guard";
  rerankCandidates?: number;
  /** At most this many chunks per document, so one long page cannot fill every slot. */
  maxPerDoc?: number;
}

export interface SearchResult {
  hits: Hit[];
  mode: string;
  /** Top relevance score (reranker probability or cosine similarity); null for keyword-only search. */
  confidence: number | null;
  /** Nothing in the index matches the question closely; callers should say so rather than guess. */
  lowConfidence: boolean;
}

// Below these, the best match is not about the question. Calibrated with `spec-brain eval` on the
// 2026-10-27 golden set (46 questions, 7 negative): guard sits midway between the highest negative
// (0.027) and the lowest answerable question (0.035), a thin margin to re-check as the set grows.
export const LOW_CONFIDENCE = { rerank: 0.085, guard: 0.03, cosine: 0.572 };
const GUARD_CANDIDATES = 5;

export function vectorSearch(db: DB, queryVector: Float32Array, opts: { k?: number; filters?: SearchFilters } = {}): Hit[] {
  if (!hasVectors(db)) return [];
  const k = opts.k ?? 30;
  const f = opts.filters ?? {};
  const { sql, args } = filterSql(f);
  // vec0 finds neighbours before metadata filters apply, so filtered searches look further.
  const knn = f.docTypes?.length || f.sectionKinds?.length || f.domain || f.project ? 2000 : Math.max(200, k * 4);
  const rows = db
    .prepare(
      `WITH knn AS (SELECT rowid, distance FROM chunk_vec WHERE embedding MATCH ? AND k = ?)
       SELECT ${HIT_COLUMNS}, 1 - knn.distance AS score
         FROM knn JOIN chunks c ON c.id = knn.rowid JOIN documents d ON d.id = c.doc_id
        WHERE 1 = 1 ${sql}
        ORDER BY knn.distance LIMIT ?`,
    )
    .all(queryVector, knn, ...args, k) as Omit<Hit, "via">[];
  return rows.map((r) => ({ ...r, via: "vector" as const }));
}

/** Reciprocal rank fusion: rank positions matter, raw scores of different retrievers are not comparable. */
export function rrf(lists: Hit[][], k = 60): Hit[] {
  const fused = new Map<number, { hit: Hit; score: number }>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const entry = fused.get(hit.chunkId) ?? { hit: { ...hit, via: "hybrid" as const }, score: 0 };
      entry.score += 1 / (k + rank + 1);
      fused.set(hit.chunkId, entry);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).map((e) => ({ ...e.hit, score: e.score }));
}

function capPerDoc(hits: Hit[], max: number): Hit[] {
  const counts = new Map<string, number>();
  return hits.filter((h) => {
    const key = h.url ?? h.path;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    return n < max;
  });
}

/**
 * Query router: ids named in the query resolve exactly and come first; the rest is BM25, vectors, or
 * both fused with RRF, optionally re-scored by a cross-encoder.
 */
export async function search(db: DB, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const k = opts.k ?? 8;
  const wanted = opts.mode ?? "hybrid";
  const mode: Mode = wanted !== "bm25" && (!opts.embedder || !hasVectors(db)) ? "bm25" : wanted;
  const exact = idHits(db, query);
  const pool = Math.max(50, k * 5);

  const lists: Hit[][] = [];
  if (mode !== "vector") lists.push(keywordSearch(db, query, { k: pool, filters: opts.filters }));
  if (mode !== "bm25") {
    const [qv] = await (await opts.embedder!()).embed([query], "query");
    lists.push(vectorSearch(db, qv!, { k: pool, filters: opts.filters }));
  }
  let ranked = lists.length === 1 ? lists[0]! : rrf(lists);
  let confidence: number | null = mode === "bm25" ? null : (lists.at(-1)![0]?.score ?? 0);
  let label: string = mode;

  const guard = opts.rerankUse === "guard";
  if (opts.reranker && ranked.length) {
    const reranker = await opts.reranker();
    const candidates = capPerDoc(ranked, opts.maxPerDoc ?? 3).slice(0, guard ? GUARD_CANDIDATES : (opts.rerankCandidates ?? 30));
    const scores = await reranker.score(
      query,
      candidates.map((h) => `${h.context}\n${h.text}`.slice(0, 2000)),
    );
    if (guard) confidence = Math.max(...scores);
    else {
      ranked = candidates.map((h, i) => ({ ...h, score: scores[i]! })).sort((a, b) => b.score - a.score);
      confidence = ranked[0]?.score ?? 0;
    }
    label = `${mode}+${guard ? "guard" : "rerank"}`;
  }

  const seen = new Set(exact.map((h) => h.chunkId));
  const hits = [...exact, ...capPerDoc(ranked, opts.maxPerDoc ?? 3).filter((h) => !seen.has(h.chunkId))].slice(0, k);
  const threshold = !opts.reranker ? LOW_CONFIDENCE.cosine : guard ? LOW_CONFIDENCE.guard : LOW_CONFIDENCE.rerank;
  const lowConfidence = !exact.length && confidence !== null && confidence < threshold;
  return { hits, mode: label, confidence: exact.length ? 1 : confidence, lowConfidence };
}
