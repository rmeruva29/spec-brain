import type { DB } from "../db.ts";
import { AC_RE, REQ_RE } from "../ids.ts";
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
  via: "id" | "keyword";
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

const HIT_COLUMNS = `c.id AS chunkId, c.entity_id AS entityId, d.path, d.url, d.title, c.anchor, c.section,
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

/**
 * Query router: exact id lookups first, then BM25 keyword hits. Vector search and fusion slot in
 * here once embeddings exist.
 */
export function search(db: DB, query: string, opts: { k?: number; filters?: SearchFilters } = {}): Hit[] {
  const k = opts.k ?? 8;
  const exact = idHits(db, query);
  const seen = new Set(exact.map((h) => h.chunkId));
  const keyword = keywordSearch(db, query, { k: k * 3, filters: opts.filters }).filter((h) => !seen.has(h.chunkId));
  return [...exact, ...keyword].slice(0, k);
}
