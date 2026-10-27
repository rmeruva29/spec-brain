import type { DB } from "../db.ts";
import { inferKind, type EntityKind } from "../ids.ts";

export interface Citation {
  path: string;
  url: string | null;
  anchor: string | null;
  docType: string;
  status: string | null;
}

export interface EntityView {
  id: string;
  kind: EntityKind;
  title: string | null;
  status: string | null;
  text: string | null;
  citation: Citation | null;
}

export interface Neighbor {
  id: string;
  kind: EntityKind;
  title: string | null;
  edge: string;
  direction: "out" | "in";
}

interface EntityRow {
  id: string;
  kind: EntityKind;
  title: string | null;
  status: string | null;
  text: string | null;
  path: string | null;
  url: string | null;
  anchor: string | null;
  doc_type: string | null;
  doc_status: string | null;
  origin: string;
}

/** Canonicalises user input: case-insensitive ids, bare capability paths and `specs/` paths. */
export function normalizeId(raw: string): string {
  const s = raw.trim();
  if (/^(CAP|DOM|TASK|DOC|TEST):/i.test(s)) return s.replace(/^[a-z]+/i, (p) => p.toUpperCase());
  const cap = /^(?:specs\/)?([a-z0-9-]+)\/([a-z0-9-]+)\/?$/.exec(s);
  if (cap) return `CAP:${cap[1]}/${cap[2]}`;
  return s.toUpperCase();
}

export function getEntity(db: DB, rawId: string): EntityView | null {
  const id = normalizeId(rawId);
  const row = db
    .prepare(
      `SELECT e.id, e.kind, e.title, e.status, e.origin, c.text, c.anchor,
              d.path, d.url, d.doc_type, d.status AS doc_status
         FROM entities e
         LEFT JOIN chunks c ON c.id = e.chunk_id
         LEFT JOIN documents d ON d.id = COALESCE(c.doc_id, e.origin)
        WHERE e.id = ?`,
    )
    .get(id) as EntityRow | undefined;
  if (!row) {
    const referenced = db.prepare("SELECT 1 FROM edges WHERE src = ? OR dst = ? LIMIT 1").get(id, id);
    return referenced ? { id, kind: inferKind(id), title: null, status: null, text: null, citation: null } : null;
  }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    text: row.text,
    citation: row.path ? { path: row.path, url: row.url, anchor: row.anchor, docType: row.doc_type!, status: row.doc_status } : null,
  };
}

export function neighbors(db: DB, id: string, kinds?: string[]): Neighbor[] {
  const filter = kinds?.length ? `AND ed.kind IN (${kinds.map(() => "?").join(",")})` : "";
  const args = kinds ?? [];
  const rows = db
    .prepare(
      `SELECT ed.dst AS id, ed.kind AS edge, 'out' AS direction, en.kind, en.title
         FROM edges ed LEFT JOIN entities en ON en.id = ed.dst WHERE ed.src = ? ${filter}
       UNION
       SELECT ed.src AS id, ed.kind AS edge, 'in' AS direction, en.kind, en.title
         FROM edges ed LEFT JOIN entities en ON en.id = ed.src WHERE ed.dst = ? ${filter}`,
    )
    .all(id, ...args, id, ...args) as { id: string; edge: string; direction: "out" | "in"; kind: EntityKind | null; title: string | null }[];
  return rows.map((r) => ({ ...r, kind: r.kind ?? inferKind(r.id) }));
}

export interface RequirementView extends EntityView {
  capability: EntityView | null;
  verifies: EntityView[];
  verifiedBy: EntityView[];
  tests: string[];
  tasks: EntityView[];
  /** Issues tracking the plan tasks that deliver this item. */
  jira: string[];
  /** Epic(s) tracking the whole capability. */
  epics: string[];
  referencedBy: Neighbor[];
}

/**
 * The traceability view of a requirement, AC, task or capability: what it is, where it is written,
 * what verifies it, which tests cite it, which plan tasks deliver it and which Jira issues track those.
 */
export function getRequirement(db: DB, rawId: string): RequirementView | null {
  const base = getEntity(db, rawId);
  if (!base) return null;
  const all = neighbors(db, base.id);
  const view = (ids: string[]) => [...new Set(ids)].map((i) => getEntity(db, i)).filter((e): e is EntityView => e !== null);

  const capId = all.find((n) => n.edge === "part_of" && n.direction === "out" && n.kind === "capability")?.id;
  const verifies = view(all.filter((n) => n.edge === "verifies" && n.direction === "out").map((n) => n.id));
  const verifiedBy = view(all.filter((n) => n.edge === "verifies" && n.direction === "in").map((n) => n.id));

  // Tests and tasks attach to ACs, so a requirement inherits them through the ACs that verify it.
  const acIds = base.kind === "ac" ? [base.id] : verifiedBy.map((a) => a.id);
  const viaAcs = acIds.flatMap((a) => neighbors(db, a, ["tested_by", "covers"]));
  const tests = [...new Set([...all, ...viaAcs].filter((n) => n.edge === "tested_by" && n.direction === "out").map((n) => n.id))];
  const taskIds = [
    ...all.filter((n) => n.kind === "task" && (n.edge === "covers" || n.edge === "part_of")).map((n) => n.id),
    ...viaAcs.filter((n) => n.edge === "covers" && n.direction === "in").map((n) => n.id),
  ];
  const tasks = base.kind === "task" ? [] : view(taskIds);
  const trackedBy = (ids: string[]) => [
    ...new Set(ids.flatMap((i) => neighbors(db, i, ["tracked_by"]).filter((n) => n.direction === "out").map((n) => n.id))),
  ];
  const jira = trackedBy([base.id, ...tasks.map((t) => t.id)]);
  const epics = capId ? trackedBy([capId]) : [];
  return {
    ...base,
    capability: capId ? getEntity(db, capId) : null,
    verifies,
    verifiedBy,
    tests,
    tasks,
    jira,
    epics,
    referencedBy: all.filter((n) => n.edge === "references" && n.direction === "in"),
  };
}

export interface TraceResult {
  root: string;
  nodes: { id: string; kind: EntityKind; title: string | null; depth: number }[];
  edges: { src: string; dst: string; kind: string }[];
  truncated: boolean;
}

const STRUCTURAL = ["part_of", "verifies", "covers", "tested_by", "tracked_by", "depends_on"];
const HUB_KINDS = new Set<EntityKind>(["capability", "domain", "document", "jira"]);

/**
 * Breadth-first walk of the traceability graph. Hubs (capabilities, documents, Jira issues) are
 * reached but not expanded unless they are the root, so one requirement does not pull in its whole domain.
 */
export function trace(db: DB, rawId: string, opts: { depth?: number; includeReferences?: boolean; maxNodes?: number } = {}): TraceResult | null {
  const root = normalizeId(rawId);
  const start = getEntity(db, root);
  if (!start) return null;
  const depth = Math.min(opts.depth ?? 2, 4);
  const maxNodes = opts.maxNodes ?? 150;
  const kinds = opts.includeReferences ? [...STRUCTURAL, "references", "links_to"] : STRUCTURAL;

  const nodes = new Map<string, { id: string; kind: EntityKind; title: string | null; depth: number }>([
    [root, { id: root, kind: start.kind, title: start.title, depth: 0 }],
  ]);
  const edges = new Map<string, { src: string; dst: string; kind: string }>();
  let frontier = [root];
  let truncated = false;
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const node = nodes.get(id)!;
      if (id !== root && HUB_KINDS.has(node.kind)) continue;
      for (const n of neighbors(db, id, kinds)) {
        const e = n.direction === "out" ? { src: id, dst: n.id, kind: n.edge } : { src: n.id, dst: id, kind: n.edge };
        if (!nodes.has(n.id)) {
          if (nodes.size >= maxNodes) {
            truncated = true;
            continue;
          }
          nodes.set(n.id, { id: n.id, kind: n.kind, title: n.title, depth: d });
          next.push(n.id);
        }
        edges.set(`${e.src}|${e.dst}|${e.kind}`, e);
      }
    }
    frontier = next;
  }
  return { root, nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}
