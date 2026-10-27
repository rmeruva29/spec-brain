import type { ConfluenceExportConfig } from "../config.ts";
import { docId, findAllRefs, jiraRegex } from "../ids.ts";
import { chunkSections, extractTables, parseMarkdown, splitByParagraph } from "./markdown.ts";
import type { ChunkRec, EdgeRec, ParsedDoc } from "./sdd.ts";
import { sha256 } from "./sdd.ts";
import { sectionKind } from "./sections.ts";

const MAX_CHUNK_CHARS = 3200;

/** Confluence heading anchors keep case and join words with "-". */
export function confluenceAnchor(heading: string): string {
  return heading
    .replace(/[*_`]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

export function classifyPage(title: string, ancestors: string[]): string {
  const path = ancestors.join(" › ");
  if (/template/i.test(title) || /\btemplates\b/i.test(path)) return "template";
  if (/^\s*(\[draft\]\s*)?architect(ure|ural) approach\b/i.test(title)) return "aad";
  if (/guard ?rails?|guidelines|policies|standards?\b|sops?\b|specification|checklist|contracts/i.test(title) || /guardrails|guidelines/i.test(path)) {
    return "standard";
  }
  if (/strategy/i.test(path)) return "strategy";
  if (/assessment|risk/i.test(path) || /assessment|evaluation|heatmap/i.test(title)) return "assessment";
  if (/diagram/i.test(path)) return "diagram";
  return "wiki";
}

const clean = (cell: string) => cell.replace(/[*_`]/g, "").trim().toUpperCase();

/** Status from the title ([DRAFT], (Moved)), the tree (Pending Review) and the "Document Acceptance" approval table. */
export function pageStatus(title: string, ancestors: string[], approvalBody: string | null): string | null {
  if (/\[draft\]|\(not ready/i.test(title)) return "draft";
  if (/\(moved\)/i.test(title)) return "superseded";
  if (ancestors.some((a) => /pending review/i.test(a))) return "in review";
  if (!approvalBody) return null;
  const cells = extractTables(approvalBody).tables.flatMap((t) => t.rows.flat().map(clean));
  if (cells.includes("NOT APPROVED")) return "not approved";
  if (cells.includes("CONDITIONAL")) return "conditional";
  if (cells.includes("APPROVED")) return "approved";
  return "unapproved";
}

/** True when a chunk has content beyond headings and empty table scaffolding (unfilled template sections). */
function meaningful(text: string): boolean {
  const residue = text
    .split("\n")
    .filter((l) => !/^\s*#{1,6}\s/.test(l) && !/^\s*\|?[\s|:-]*\|?\s*$/.test(l))
    .join(" ")
    .replace(/[|*_`>\s]+/g, " ")
    .trim();
  return residue.length >= 40;
}

const PAGE_LINK_RE = /(?:\/pages\/|pageId=)(\d+)/g;

/** Turns one synced Confluence page (`<pageId>.md` with frontmatter) into chunks and graph edges. */
export function parseConfluenceFile(source: ConfluenceExportConfig, rel: string, content: string): ParsedDoc {
  const md = parseMarkdown(content);
  const fm = md.frontmatter;
  const title = fm.title ?? rel;
  const ancestors = (fm.ancestors ?? "").split(" › ").filter(Boolean);
  const docType = classifyPage(title, ancestors);
  const approval = md.sections.find((s) => /document acceptance|approval/i.test(s.heading));
  const status = pageStatus(title, ancestors, approval?.body ?? null);
  const updated = (fm.last_modified ?? "").slice(0, 7);
  const id = docId(source.name, rel);
  const jiraRe = jiraRegex(source.jiraProjects);
  const amendment = /amendment/i.test(title);

  const context = (section: string | null) =>
    [
      `Project: ${source.project}`,
      `Type: ${docType}${amendment ? " (ARB amendment)" : ""}`,
      `Page: ${title}`,
      ancestors.length && `Path: ${ancestors.slice(-2).join(" › ")}`,
      section && `Section: ${section}`,
      status && `Status: ${status}`,
      updated && `Updated: ${updated}`,
    ]
      .filter(Boolean)
      .join(" · ");

  const chunks: ChunkRec[] = [];
  const add = (section: string | null, anchor: string | null, text: string) => {
    const kind = sectionKind(section);
    if (kind === "revision" || !meaningful(text)) return;
    chunks.push({ section, sectionKind: kind, anchor, entityId: null, context: context(section), text });
  };
  if (md.preamble) for (const piece of splitByParagraph(md.preamble, MAX_CHUNK_CHARS)) add(null, null, piece);
  if (md.sections.length) {
    // Wiki chapters are broad, so groups start one level down: "Monitoring and Observability › Logging"
    // is its own chunk, while the many small headings under "Security › Penetration Testing Plan" merge.
    chunkSections(md.sections, MAX_CHUNK_CHARS, (s) => s.body, (name, _anchor, text, s) => add(name, confluenceAnchor(s.heading), text), {
      groupDepth: 1,
    });
  }

  const edges: EdgeRec[] = [];
  if (fm.parent_id) edges.push({ src: id, dst: docId(source.name, `${fm.parent_id}.md`), kind: "part_of" });
  for (const m of content.matchAll(PAGE_LINK_RE)) {
    if (m[1] !== fm.id) edges.push({ src: id, dst: docId(source.name, `${m[1]}.md`), kind: "links_to" });
  }
  for (const ref of findAllRefs(content, jiraRe)) edges.push({ src: id, dst: ref, kind: "references" });

  return {
    doc: {
      id,
      source: source.name,
      project: source.project,
      path: rel,
      url: fm.url ?? null,
      title,
      docType,
      domain: null,
      capability: null,
      status,
      contentHash: sha256(content),
    },
    chunks,
    entities: [{ id, kind: "document", title, status, chunkIndex: null }],
    edges: [...new Map(edges.map((e) => [`${e.src}|${e.dst}|${e.kind}`, e])).values()],
  };
}
