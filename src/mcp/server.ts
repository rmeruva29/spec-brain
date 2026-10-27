import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config.ts";
import { openDb } from "../db.ts";
import { formatRequirement, formatResult, formatTrace } from "../format.ts";
import { createEmbedder, createReranker, lazy } from "../models.ts";
import { getRequirement, trace } from "../retrieval/lookup.ts";
import { search } from "../retrieval/search.ts";

// stdout carries the MCP protocol; nothing else may print to it.
const config = loadConfig();
const db = openDb(config.dbPath, { readonly: true });
// Models load on the first search, not at startup, so the server answers its handshake immediately.
const embedder = lazy(() => createEmbedder(config));
const reranker = lazy(() => createReranker(config));
// "guard" (default): fused ranking, reranker only scores the top hits for the low-confidence signal
// (~0.75 s). "rank": rerank 30 candidates (~3.7 s, no better ranking on the golden set). "0": no reranker.
const RERANK = (process.env.SPEC_BRAIN_RERANK ?? "guard") as "guard" | "rank" | "0";

const server = new McpServer({ name: "spec-brain", version: "0.1.0" });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const readOnly = { readOnlyHint: true, openWorldHint: false };

server.registerTool(
  "search_specs",
  {
    title: "Search specs",
    description:
      "Search the indexed specifications, plans, decisions, architecture approach documents (wiki), standards/guardrails, " +
        "agent and skill definitions. " +
      "Requirement and acceptance-criteria ids in the query (e.g. WDG-CCH-001, AC-WDG-CCH-003) are resolved exactly first. " +
      "Every result starts with a citation (path#anchor) and the document status; cite those when you use a result, " +
      "and when the result is marked low confidence, say the indexed material does not cover the question rather than guessing.",
    inputSchema: {
      query: z.string().min(2).describe("Natural-language question, keywords, or requirement/AC ids"),
      k: z.number().int().min(1).max(25).optional().describe("Number of results (default 8)"),
      doc_types: z
        .array(z.string())
        .optional()
        .describe(
          "Restrict to document types. Repo: spec, plan, decision, spec-note, domain-readme, arch-doc, epic-report, plan-doc, runbook, dev-guide, agent, skill, convention. Wiki: aad, standard, assessment, strategy, diagram, wiki",
        ),
      domain: z.string().optional().describe("Restrict to one spec domain, e.g. widgets"),
      section_kinds: z
        .array(z.string())
        .optional()
        .describe(
          "Restrict to section kinds: overview, requirements, nfr, assumptions, decision, design, data, logging, monitoring, security, errors, testing, deployment, compliance, impact, approval, out-of-scope, references",
        ),
      include_archived: z.boolean().optional().describe("Include archived docs and withdrawn requirements"),
    },
    annotations: readOnly,
  },
  async ({ query, k, doc_types, domain, section_kinds, include_archived }) =>
    text(
      formatResult(
        await search(db, query, {
          k,
          filters: { docTypes: doc_types, domain, sectionKinds: section_kinds, includeArchived: include_archived },
          embedder,
          reranker: RERANK === "0" ? undefined : reranker,
          rerankUse: RERANK === "rank" ? "rank" : "guard",
          rerankCandidates: config.reranker.candidates,
        }),
      ),
    ),
);

server.registerTool(
  "get_requirement",
  {
    title: "Get requirement",
    description:
      "Look up one requirement, acceptance criterion, plan task or capability by id and return its text, source, status, " +
      "the ACs that verify it, the plan tasks and Jira issues that deliver it, and the test files that cite it. " +
      "Accepts WDG-CCH-001, AC-WDG-CCH-002, TASK:widgets/widget-cache#1.1, or a capability path like widgets/widget-cache.",
    inputSchema: { id: z.string().min(3) },
    annotations: readOnly,
  },
  async ({ id }) => {
    const r = getRequirement(db, id);
    return text(r ? formatRequirement(r) : `${id} is not in the index. Use search_specs to find the right id.`);
  },
);

server.registerTool(
  "trace",
  {
    title: "Trace",
    description:
      "Walk the traceability graph from an id (requirement, AC, task, capability, Jira key) for impact analysis: " +
      "requirement → ACs → plan tasks → Jira → tests, plus task dependencies across capabilities.",
    inputSchema: {
      id: z.string().min(3),
      depth: z.number().int().min(1).max(4).optional().describe("Hops to follow (default 2)"),
      include_references: z.boolean().optional().describe("Also follow free-text mentions and document links (noisier)"),
    },
    annotations: readOnly,
  },
  async ({ id, depth, include_references }) => {
    const t = trace(db, id, { depth, includeReferences: include_references });
    return text(t ? formatTrace(t) : `${id} is not in the index.`);
  },
);

await server.connect(new StdioServerTransport());
