import type { DriftReport } from "./retrieval/drift.ts";
import type { Citation, EntityView, RequirementView, TraceResult } from "./retrieval/lookup.ts";
import type { Hit, SearchResult } from "./retrieval/search.ts";
import type { PrecedentResult, StandardsResult } from "./retrieval/standards.ts";

// Plain-text renderings shared by the CLI and the MCP server. Every block leads with a citation
// so an agent can quote where a fact came from.

/** Wiki pages cite their URL (with the heading anchor); repository files cite path#anchor. */
export const cite = (c: Pick<Citation, "path" | "url" | "anchor">) => {
  const base = c.url ?? c.path;
  return c.anchor ? `${base}#${c.anchor}` : base;
};

export function formatHits(hits: Hit[]): string {
  if (!hits.length) return "No matches in the indexed specs.";
  return hits
    .map((h, i) => {
      const head = [`[${i + 1}] ${cite(h)}`, h.url && h.title, h.entityId, h.docType, h.status && `status: ${h.status}`]
        .filter(Boolean)
        .join(" · ");
      return `${head}\n${h.section ? `Section: ${h.section}\n` : ""}${h.text}`;
    })
    .join("\n\n---\n\n");
}

const lowNote = (r: Pick<SearchResult, "confidence">) =>
  `Low confidence (best match ${r.confidence?.toFixed(2)}): nothing in the index closely matches this question. ` +
  "Say the indexed specs and docs do not cover it rather than answering from these results.";

export function formatResult(r: SearchResult): string {
  return (r.lowConfidence ? `${lowNote(r)}\n\n` : "") + formatHits(r.hits);
}

export function formatStandards(r: StandardsResult): string {
  const out = [`Standards for "${r.topic}"${r.sectionKinds.length ? ` (design sections: ${r.sectionKinds.join(", ")})` : ""}`, "", "== Standards, guardrails and conventions =="];
  if (r.standards.lowConfidence || !r.standards.hits.length) {
    out.push(
      `No standards page covers this topic${r.standards.confidence !== null ? ` (best match ${r.standards.confidence.toFixed(2)})` : ""}. ` +
        "What follows is how past designs handled it: precedent, not an agreed standard. Say so when you use it.",
    );
  } else out.push(formatHits(r.standards.hits));
  out.push("", "== How designs and specs apply it ==");
  out.push(r.practice.lowConfidence || !r.practice.hits.length ? "Nothing in the design documents closely matches." : formatHits(r.practice.hits));
  return out.join("\n");
}

export function formatPrecedent(r: PrecedentResult): string {
  if (r.lowConfidence || !r.precedents.length) {
    return `No earlier decision record addresses this${r.confidence !== null ? ` (best match ${r.confidence.toFixed(2)})` : ""}. Say no precedent was found rather than inferring one.`;
  }
  return r.precedents
    .map((p, i) => {
      const head = [`[${i + 1}] ${p.title ?? p.path}`, p.docType, p.status ? `status: ${p.status}` : "approval not recorded", p.url ?? p.path].join(" · ");
      const sections = p.hits.map((h) => `Section: ${h.section ?? "(intro)"}${h.anchor ? ` (${cite(h)})` : ""}\n${h.text.length > 1200 ? `${h.text.slice(0, 1200)} …` : h.text}`);
      return [head, ...sections].join("\n");
    })
    .join("\n\n---\n\n");
}

export function formatDrift(r: DriftReport, limit = 25): string {
  const out: string[] = [];
  const section = <T>(title: string, items: T[], render: (item: T) => string, empty: string) => {
    out.push("", `== ${title} (${items.length}) ==`);
    if (!items.length) out.push(empty);
    out.push(...items.slice(0, limit).map(render));
    if (items.length > limit) out.push(`… ${items.length - limit} more`);
  };
  const from = (titles: (string | null)[]) => titles.slice(0, 3).join("; ") + (titles.length > 3 ? ` (+${titles.length - 3})` : "");
  const item = (i: { id: string; title: string | null; status: string | null; path: string | null }) =>
    `- ${i.id} [${i.status}] ${i.title ?? ""}${i.path ? ` (${i.path})` : ""}`;
  section("Ids cited but never defined", r.undefinedIds, (u) => `- ${u.id} [${u.kind}] cited in ${from(u.mentionedIn)}`, "None.");
  section("Approved or built requirements no acceptance criterion verifies", r.unverifiedRequirements, item, "None.");
  section("Built acceptance criteria no test cites", r.untestedCriteria, item, "None.");
  section("Standards pages with no rules in them", r.emptyStandards, (s) => `- ${s.title ?? s.path} (${s.chars} chars) ${s.url ?? s.path}`, "None.");
  section("Wiki pages linked from indexed pages but not in the corpus", r.missingPages, (m) => `- ${m.pageId} ${m.title ?? "(title unknown)"}: linked from ${m.linkedFrom.length} page(s): ${from(m.linkedFrom)}`, "None.");
  out.push("", "== Document status mix ==", ...r.statusByType.map((s) => `- ${s.source} ${s.docType} · ${s.status}: ${s.docs}`));
  return out.join("\n").trimStart();
}

const line = (e: EntityView) => `- ${e.id}${e.title ? `: ${e.title}` : ""}${e.citation ? ` (${cite(e.citation)})` : ""}`;

export function formatRequirement(r: RequirementView): string {
  const out = [`${r.id} [${r.kind}]${r.status ? ` · status: ${r.status}` : ""}`];
  if (r.citation) out.push(`Source: ${cite(r.citation)}`);
  if (r.capability) {
    const epic = r.epics.length ? ` · epic ${r.epics.join(", ")}` : "";
    out.push(`Capability: ${r.capability.id}${r.capability.status ? ` (${r.capability.status})` : ""}${epic}`);
  }
  if (r.text) out.push("", r.text);
  const list = (title: string, items: string[]) => {
    if (items.length) out.push("", `${title}:`, ...items);
  };
  list("Verifies", r.verifies.map(line));
  list("Verified by", r.verifiedBy.map(line));
  list("Plan tasks", r.tasks.map(line));
  list("Tests citing it", r.tests.map((t) => `- ${t}`));
  list("Jira (via plan tasks)", r.jira.map((j) => `- ${j}`));
  list("Referenced by", r.referencedBy.slice(0, 15).map((n) => `- ${n.id}${n.title ? `: ${n.title}` : ""}`));
  if (!r.verifiedBy.length && r.kind === "requirement") out.push("", "No acceptance criterion verifies this requirement.");
  if (!r.tests.length && (r.kind === "requirement" || r.kind === "ac")) out.push("", "No test in the scanned repos cites it.");
  return out.join("\n");
}

export function formatTrace(t: TraceResult): string {
  const byDepth = [...t.nodes].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  const nodes = byDepth.map((n) => `${"  ".repeat(n.depth)}${n.id} [${n.kind}]${n.title ? ` ${n.title.slice(0, 100)}` : ""}`);
  const edges = t.edges.map((e) => `${e.src} --${e.kind}--> ${e.dst}`);
  return [`Trace from ${t.root} (${t.nodes.length} nodes${t.truncated ? ", truncated" : ""})`, "", ...nodes, "", "Edges:", ...edges].join("\n");
}
