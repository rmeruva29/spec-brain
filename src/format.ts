import type { Citation, EntityView, RequirementView, TraceResult } from "./retrieval/lookup.ts";
import type { Hit } from "./retrieval/search.ts";

// Plain-text renderings shared by the CLI and the MCP server. Every block leads with a citation
// so an agent can quote where a fact came from.

export const cite = (c: Pick<Citation, "path" | "anchor">) => (c.anchor ? `${c.path}#${c.anchor}` : c.path);

export function formatHits(hits: Hit[]): string {
  if (!hits.length) return "No matches in the indexed specs.";
  return hits
    .map((h, i) => {
      const head = [`[${i + 1}] ${cite(h)}`, h.entityId, h.docType, h.status && `status: ${h.status}`].filter(Boolean).join(" · ");
      return `${head}\n${h.section ? `Section: ${h.section}\n` : ""}${h.text}`;
    })
    .join("\n\n---\n\n");
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
