import { createHash } from "node:crypto";
import { basename, posix } from "node:path";
import type { SddRepoConfig } from "../config.ts";
import {
  AC_RE,
  REQ_RE,
  capId,
  docId,
  domainId,
  expandVerifies,
  findAcIds,
  findAllRefs,
  findJiraKeys,
  jiraRegex,
  taskId,
  type EntityKind,
} from "../ids.ts";
import { chunkSections, extractTables, parseMarkdown, splitByParagraph, type Table } from "./markdown.ts";
import { sectionKind } from "./sections.ts";

/** About 800 tokens. Larger sections are split by sub-heading, then by paragraph. */
const MAX_CHUNK_CHARS = 3200;

export interface ChunkRec {
  section: string | null;
  sectionKind: string | null;
  anchor: string | null;
  entityId: string | null;
  context: string;
  text: string;
}

export interface EntityRec {
  id: string;
  kind: EntityKind;
  title: string | null;
  status: string | null;
  /** Index into `chunks` of the chunk that defines this entity. */
  chunkIndex: number | null;
}

export interface EdgeRec {
  src: string;
  dst: string;
  kind: string;
}

export interface DocRec {
  id: string;
  source: string;
  project: string;
  path: string;
  url: string | null;
  title: string;
  docType: string;
  domain: string | null;
  capability: string | null;
  status: string | null;
  contentHash: string;
}

export interface ParsedDoc {
  doc: DocRec;
  chunks: ChunkRec[];
  entities: EntityRec[];
  edges: EdgeRec[];
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const DOCS_TYPES: Record<string, string> = {
  arch: "arch-doc",
  epics: "epic-report",
  plans: "plan-doc",
  features: "feature-doc",
  ops: "runbook",
  dev: "dev-guide",
  domain: "domain-doc",
  archive: "archive",
};

export function classify(rel: string): { docType: string; domain: string | null; capability: string | null } {
  let m = /^specs\/([^/]+)\/([^/]+)\/(spec|plan|decisions)\.md$/.exec(rel);
  if (m) return { docType: m[3] === "decisions" ? "decision" : m[3]!, domain: m[1]!, capability: m[2]! };
  if ((m = /^specs\/([^/]+)\/([^/]+)\/.+\.md$/.exec(rel))) return { docType: "spec-note", domain: m[1]!, capability: m[2]! };
  if ((m = /^specs\/([^/]+)\/README\.md$/.exec(rel))) return { docType: "domain-readme", domain: m[1]!, capability: null };
  if (rel === "specs/README.md") return { docType: "spec-guide", domain: null, capability: null };
  if ((m = /^docs\/([^/]+)\//.exec(rel))) return { docType: DOCS_TYPES[m[1]!] ?? "doc", domain: null, capability: null };
  if (rel.startsWith(".claude/agents/")) return { docType: "agent", domain: null, capability: null };
  if (rel.startsWith(".claude/skills/")) return { docType: "skill", domain: null, capability: null };
  if (/^(CLAUDE|AGENTS)\.md$/.test(rel)) return { docType: "convention", domain: null, capability: null };
  return { docType: "doc", domain: null, capability: null };
}

/** A row whose text opens "Superseded by X." or "Withdrawn (date):" keeps its id but no longer applies. */
function rowStatus(summary: string, docStatus: string | null): string | null {
  if (/^\s*superseded\b/i.test(summary)) return "superseded";
  if (/^\s*withdrawn\b/i.test(summary)) return "withdrawn";
  return docStatus;
}

/** First word(s) of a status line: "Implemented — Epic PROJ-1 delivered" → "implemented". */
export function normalizeStatus(line: string | undefined): string | null {
  if (!line) return null;
  const m = /^[*_\s]*([A-Za-z][A-Za-z ]{0,24}?)[*_]*\s*(?:—|–|-\s|:|\.|\(|,|;|$)/.exec(line.trim());
  return m ? m[1]!.trim().toLowerCase() : null;
}

function statusOf(md: ReturnType<typeof parseMarkdown>): string | null {
  if (md.frontmatter.status) return normalizeStatus(md.frontmatter.status);
  const section = md.sections.find((s) => /^status$/i.test(s.heading));
  if (section) return normalizeStatus(section.body.split("\n").find((l) => l.trim()));
  const inline = /^\**Status\**:\s*(.+)$/im.exec(md.preamble);
  return inline ? normalizeStatus(inline[1]) : null;
}

const isId = (re: RegExp, s: string | undefined) => !!s && new RegExp(`^${re.source}$`).test(s.replace(/[*`]/g, "").trim());
const cleanId = (s: string) => s.replace(/[*`]/g, "").trim();

type TableKind = "requirement" | "ac" | "task" | null;

function tableKind(t: Table): TableKind {
  const h0 = t.header[0]?.toLowerCase().trim();
  const first = t.rows[0]?.[0];
  if (h0 === "id" && isId(AC_RE, first)) return "ac";
  if (h0 === "id" && isId(REQ_RE, first)) return "requirement";
  if ((h0 === "#" || h0 === "task #") && t.header.some((h) => /task/i.test(h)) && /^\d+(\.\d+)*$/.test(first ?? "")) return "task";
  return null;
}

function rowText(id: string, t: Table, row: string[]): string {
  const fields = t.header.slice(1).map((h, i) => `${h}: ${row[i + 1] ?? ""}`);
  return `${id}\n${fields.join("\n")}`;
}

const DEPENDS_RE = /depends(?:\s+on)?\s+(?:([a-z0-9-]+)\/([a-z0-9-]+)#)?(\d+(?:\.\d+)*)/g;

const MD_LINK_RE = /\[[^\]]*\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g;

/** Turns one markdown file of a spec-driven repo into chunks, graph entities and edges. */
export function parseSddFile(source: SddRepoConfig, rel: string, content: string): ParsedDoc {
  const md = parseMarkdown(content);
  const { docType, domain, capability } = classify(rel);
  const id = docId(source.name, rel);
  const status = statusOf(md);
  const title = md.title ?? basename(rel, ".md");
  const cap = domain && capability ? capId(domain, capability) : null;
  const jiraRe = jiraRegex(source.jiraProjects);

  const chunks: ChunkRec[] = [];
  const entities: EntityRec[] = [{ id, kind: "document", title, status, chunkIndex: null }];
  const edges: EdgeRec[] = [];
  const linked = new Map<string, Set<string>>(); // src -> dsts already linked structurally
  const edge = (src: string, dst: string, kind: string) => {
    if (src === dst) return;
    edges.push({ src, dst, kind });
    if (!linked.has(src)) linked.set(src, new Set());
    linked.get(src)!.add(dst);
  };

  const context = (section: string | null) =>
    [
      `Project: ${source.project}`,
      `Type: ${docType}`,
      domain && `Domain: ${domain}`,
      capability && `Capability: ${capability}`,
      `Document: ${title}`,
      section && `Section: ${section}`,
      status && `Status: ${status}`,
    ]
      .filter(Boolean)
      .join(" · ");

  const addChunk = (section: string | null, anchor: string | null, text: string, entityId: string | null = null) => {
    chunks.push({ section, sectionKind: sectionKind(section), anchor, entityId, context: context(section), text });
    return chunks.length - 1;
  };

  if (cap) {
    edge(id, cap, "part_of");
    if (docType === "spec") {
      entities.push({ id: cap, kind: "capability", title, status, chunkIndex: null });
      edge(cap, domainId(domain!), "part_of");
    }
  }
  if (docType === "domain-readme") entities.push({ id: domainId(domain!), kind: "domain", title, status, chunkIndex: null });

  // The epic key sits in the plan's first preamble paragraph ("Jira epic code: WDG-CCH. [PROJ-10]");
  // later paragraphs mention other capabilities' issues and are left as plain references.
  if (cap && docType === "plan") {
    for (const key of findJiraKeys(md.preamble.split(/\n{2,}/)[0] ?? "", jiraRe)) edge(cap, key, "tracked_by");
  }

  const consumeEntityTable = (t: Table, sectionName: string, anchor: string): boolean => {
    // Only capability documents define requirements, ACs and tasks; tables elsewhere that list ids stay prose.
    const kind = tableKind(t);
    if (!kind || !cap) return false;
    for (const row of t.rows) {
      const raw = row[0] ?? "";
      if (kind === "task") {
        if (!/^\d+(\.\d+)*$/.test(raw.trim())) continue;
        const tid = taskId(domain!, capability!, raw.trim());
        const text = rowText(`Plan task ${raw.trim()}`, t, row);
        const ci = addChunk(sectionName, anchor, text, tid);
        entities.push({ id: tid, kind: "task", title: (row[1] ?? "").slice(0, 160), status: null, chunkIndex: ci });
        edge(tid, cap!, "part_of");
        for (const ac of findAcIds(row.join(" "))) edge(tid, ac, "covers");
        for (const key of findJiraKeys(row.join(" "), jiraRe)) edge(tid, key, "tracked_by");
        for (const m of row.join(" ").matchAll(DEPENDS_RE)) {
          edge(tid, taskId(m[1] ?? domain!, m[2] ?? capability!, m[3]!), "depends_on");
        }
        continue;
      }
      const eid = cleanId(raw);
      if (!isId(kind === "ac" ? AC_RE : REQ_RE, eid)) continue;
      const ci = addChunk(sectionName, anchor, rowText(eid, t, row), eid);
      const summary = row[row.length - 1] ?? "";
      entities.push({ id: eid, kind, title: summary.slice(0, 160), status: rowStatus(summary, status), chunkIndex: ci });
      if (cap) edge(eid, cap, "part_of");
      if (kind === "ac") {
        const vi = t.header.findIndex((h) => /verif/i.test(h));
        if (vi > 0) for (const req of expandVerifies(row[vi] ?? "", eid.slice(3, 10))) edge(eid, req, "verifies");
      }
    }
    return true;
  };

  if (md.preamble) for (const piece of splitByParagraph(md.preamble, MAX_CHUNK_CHARS)) addChunk(null, null, piece);

  chunkSections(
    md.sections,
    MAX_CHUNK_CHARS,
    (sec, name) => {
      let text = sec.body;
      for (const t of extractTables(sec.body).tables) if (consumeEntityTable(t, name, sec.anchor)) text = text.replace(t.raw, "");
      return text;
    },
    (name, anchor, text) => addChunk(name, anchor, text),
  );

  // Free-text references: from the defining entity when the chunk defines one, else from the document.
  for (const c of chunks) {
    const src = c.entityId ?? id;
    for (const ref of findAllRefs(c.text, jiraRe)) {
      if (ref === src || ref === cap || linked.get(src)?.has(ref)) continue;
      edge(src, ref, "references");
    }
  }
  for (const m of content.matchAll(MD_LINK_RE)) {
    const target = m[1]!;
    if (/^[a-z]+:/i.test(target)) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(rel), target));
    if (!resolved.startsWith("..")) edge(id, docId(source.name, resolved), "links_to");
  }

  const dedupedEdges = [...new Map(edges.map((e) => [`${e.src}|${e.dst}|${e.kind}`, e])).values()];
  const dedupedEntities = [...new Map(entities.map((e) => [e.id, e])).values()];
  return {
    doc: { id, source: source.name, project: source.project, path: rel, url: null, title, docType, domain, capability, status, contentHash: sha256(content) },
    chunks,
    entities: dedupedEntities,
    edges: dedupedEdges,
  };
}
