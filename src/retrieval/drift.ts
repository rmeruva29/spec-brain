import type { DB } from "../db.ts";
import { inferKind } from "../ids.ts";

// Where the written record and the system disagree, or the record has holes: ids cited but never
// defined, requirements nothing verifies, built acceptance criteria no test cites, standards pages
// that are only placeholders, and wiki pages the indexed pages rely on but the corpus does not hold.

export interface DriftItem {
  id: string;
  title: string | null;
  status: string | null;
  path: string | null;
}

export interface DriftReport {
  undefinedIds: { id: string; kind: string; mentionedIn: string[] }[];
  unverifiedRequirements: DriftItem[];
  untestedCriteria: DriftItem[];
  emptyStandards: { title: string | null; url: string | null; path: string; chars: number }[];
  missingPages: { pageId: string; title: string | null; linkedFrom: string[] }[];
  statusByType: { source: string; docType: string; status: string; docs: number }[];
}

/** Requirement and AC statuses that claim the work is agreed or done, so a gap is a real gap. */
const COMMITTED = ["approved", "implementing", "implemented"];
const BUILT = ["implementing", "implemented"];
/** A standards page with less text than this states no rule. */
const EMPTY_STANDARD_CHARS = 400;

const placeholders = (n: number) => Array(n).fill("?").join(",");

function entityGaps(db: DB, kind: "requirement" | "ac", statuses: string[], edgeMissing: string): DriftItem[] {
  return db
    .prepare(
      `SELECT n.id, n.title, n.status, d.path FROM entities n
         LEFT JOIN chunks c ON c.id = n.chunk_id LEFT JOIN documents d ON d.id = c.doc_id
        WHERE n.kind = ? AND n.status IN (${placeholders(statuses.length)}) AND ${edgeMissing}
        ORDER BY n.id`,
    )
    .all(kind, ...statuses) as DriftItem[];
}

export function driftReport(db: DB): DriftReport {
  const titleOf = new Map((db.prepare("SELECT id, title FROM documents").all() as { id: string; title: string | null }[]).map((d) => [d.id, d.title]));
  const dangling = db
    .prepare("SELECT DISTINCT e.dst, e.kind, e.origin FROM edges e LEFT JOIN entities n ON n.id = e.dst WHERE n.id IS NULL")
    .all() as { dst: string; kind: string; origin: string }[];

  // Only ids in a domain the specs define count: a wiki page numbering its own items (AAD-BDR-001) is not drift.
  const namespaces = new Set(
    (db.prepare("SELECT id, kind FROM entities WHERE kind IN ('requirement', 'capability')").all() as { id: string; kind: string }[]).map((e) =>
      e.kind === "requirement" ? e.id.slice(0, 3) : e.id.split("/")[0]!,
    ),
  );
  const namespaceOf = (id: string, kind: string) => (kind === "ac" ? id.slice(3, 6) : kind === "requirement" ? id.slice(0, 3) : id.split("/")[0]!);
  const undefinedIds = new Map<string, { id: string; kind: string; mentionedIn: string[] }>();
  const missing = new Map<string, { pageId: string; title: string | null; linkedFrom: string[] }>();
  for (const { dst, kind: edge, origin } of dangling) {
    const page = /^DOC:[^:]+:(\d+)\.md$/.exec(dst);
    // A synced subtree's root has a parent outside it; only pages the text links to count as missing.
    if (page && edge !== "links_to") continue;
    if (page) {
      const m = missing.get(page[1]!) ?? { pageId: page[1]!, title: null, linkedFrom: [] };
      m.linkedFrom.push(titleOf.get(origin) ?? origin);
      missing.set(page[1]!, m);
      continue;
    }
    const kind = inferKind(dst);
    if ((kind !== "requirement" && kind !== "ac" && kind !== "capability") || !namespaces.has(namespaceOf(dst, kind))) continue;
    const u = undefinedIds.get(dst) ?? { id: dst, kind, mentionedIn: [] };
    u.mentionedIn.push(titleOf.get(origin) ?? origin);
    undefinedIds.set(dst, u);
  }

  // Missing pages have no document to take a title from; Confluence links usually carry it as a URL slug.
  if (missing.size) {
    const slug = /\/pages\/(\d+)\/([^\s)\]?#"']+)/g;
    for (const { text } of db.prepare("SELECT c.text FROM chunks c WHERE c.text LIKE '%/pages/%'").iterate() as Iterable<{ text: string }>) {
      for (const m of text.matchAll(slug)) {
        const page = missing.get(m[1]!);
        if (page && !page.title) page.title = decodeURIComponent(m[2]!.replace(/\+/g, " "));
      }
    }
  }

  const emptyStandards = db
    .prepare(
      `SELECT d.title, d.url, d.path, COALESCE(sum(length(c.text)), 0) AS chars
         FROM documents d LEFT JOIN chunks c ON c.doc_id = d.id
        WHERE d.doc_type = 'standard' GROUP BY d.id HAVING chars < ? ORDER BY chars, d.title`,
    )
    .all(EMPTY_STANDARD_CHARS) as DriftReport["emptyStandards"];

  const statusByType = db
    .prepare(
      `SELECT source, doc_type AS docType, COALESCE(status, 'none') AS status, count(*) AS docs
         FROM documents WHERE doc_type IN ('aad', 'standard', 'decision', 'spec') GROUP BY 1, 2, 3 ORDER BY 1, 2, 4 DESC`,
    )
    .all() as DriftReport["statusByType"];

  const byLinks = <T extends { linkedFrom?: string[]; mentionedIn?: string[] }>(a: T, b: T) =>
    (b.linkedFrom ?? b.mentionedIn ?? []).length - (a.linkedFrom ?? a.mentionedIn ?? []).length;
  return {
    undefinedIds: [...undefinedIds.values()].sort(byLinks),
    unverifiedRequirements: entityGaps(db, "requirement", COMMITTED, "NOT EXISTS (SELECT 1 FROM edges e WHERE e.kind = 'verifies' AND e.dst = n.id)"),
    untestedCriteria: entityGaps(db, "ac", BUILT, "NOT EXISTS (SELECT 1 FROM edges e WHERE e.kind = 'tested_by' AND e.src = n.id)"),
    emptyStandards,
    missingPages: [...missing.values()].map((m) => ({ ...m, linkedFrom: [...new Set(m.linkedFrom)] })).sort(byLinks),
    statusByType,
  };
}
