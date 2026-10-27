import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfluenceExportConfig } from "../src/config.ts";
import { extractJson, parseStream } from "../src/confluence/relay.ts";
import { planSync, renderPage, type ListedPage } from "../src/confluence/sync.ts";
import { openDb, type DB } from "../src/db.ts";
import { classifyPage, pageStatus } from "../src/ingest/confluence.ts";
import { ingestSource } from "../src/ingest/index.ts";
import { neighbors } from "../src/retrieval/lookup.ts";
import { search } from "../src/retrieval/search.ts";

const source: ConfluenceExportConfig = {
  kind: "confluence-export",
  name: "wiki",
  project: "Example Wiki",
  root: join(import.meta.dirname, "fixtures/wiki"),
  site: "example.atlassian.net",
  rootPageId: "1001",
  excludeTitles: ["^Trash$"],
  jiraProjects: ["ACME"],
};

describe("relay stream parsing", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const toolUse = (id: string, pageId: string) =>
    line({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__atlassian__getConfluencePage", input: { pageId } }] } });
  const toolResult = (id: string, text: string) =>
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });

  it("pairs tool calls with their raw results and reads the final status", () => {
    const r = parseStream([
      toolUse("t1", "1002"),
      toolResult("t1", '[IMPORTANT: a server notice.]{"id":"1002","title":"T","body":"# A {braces} }"}'),
      line({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 }),
    ]);
    expect(r).toMatchObject({ ok: true, costUsd: 0.01 });
    expect(extractJson(r.calls[0]!.output!)).toEqual({ id: "1002", title: "T", body: "# A {braces} }" });
  });

  it("reads results that Claude Code saved to a file because they were too large", () => {
    const dir = mkdtempSync(join(tmpdir(), "spec-brain-relay-"));
    const saved = join(dir, "result.txt");
    writeFileSync(saved, JSON.stringify([{ type: "text", text: "[IMPORTANT: notice]" }, { type: "text", text: '{"id":"9","body":"big"}' }]));
    const r = parseStream([toolUse("t1", "9"), toolResult("t1", `Error: result (99 characters) exceeds maximum allowed tokens. Output has been saved to ${saved}.`)]);
    expect(extractJson(r.calls[0]!.output!)).toEqual({ id: "9", body: "big" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("sync planning", () => {
  const page = (id: string, title: string, parentId: string, lastModified = "2026-01-01"): ListedPage => ({ id, title, parentId, type: "page", lastModified });
  const listing = [
    page("2", "Architecture Approach Documents", "1"),
    page("3", "Architecture Approach - Relay", "2", "2026-02-01"),
    page("4", "Trash", "1"),
    page("5", "Old approach", "4"),
    { ...page("6", "A whiteboard", "1"), type: "whiteboard" },
  ];

  it("fetches new and changed pages, skips excluded subtrees and non-pages, deletes pages that left the tree", () => {
    const manifest = {
      syncedAt: null,
      pages: { "1": { title: "Home", lastModified: "x", version: 1 }, "2": { title: "", lastModified: "2026-01-01", version: 1 }, "99": { title: "gone", lastModified: "", version: 1 } },
    };
    const plan = planSync({ id: "1", title: "Home" }, listing, manifest, ["^Trash$"]);
    expect(plan.toFetch).toEqual(["3"]);
    expect(plan.toDelete).toEqual(["99"]);
    expect(plan.excluded).toBe(2);
    expect(plan.wanted.get("3")!.ancestors).toEqual(["Home", "Architecture Approach Documents"]);
  });

  it("renders frontmatter the ingester reads back", () => {
    const md = renderPage(source, { id: "3", title: "A: B", body: "# X\n\nbody", parentId: "2", version: { number: 4 } }, { ancestors: ["Home", "Docs"], lastModified: "2026-02-01" });
    expect(md).toContain("title: A: B\n");
    expect(md).toContain("ancestors: Home › Docs\n");
    expect(md).toContain("url: https://example.atlassian.net/wiki/pages/viewpage.action?pageId=3\n");
  });
});

describe("page classification", () => {
  it("derives type and status from title, tree and the approval table", () => {
    expect(classifyPage("Architecture Approach - Payment Retry (ARB amendment)", [])).toBe("aad");
    expect(classifyPage("Coding Standards and Specifications | Frameworks", ["Team", "Technology Guardrails, Guidelines, Policies, and SOPs"])).toBe("standard");
    expect(classifyPage("Release Documentation(Template)", ["Team", "Templates"])).toBe("template");
    expect(classifyPage("Architecture Approach - Template", ["Team", "Templates"])).toBe("template");
    expect(pageStatus("[DRAFT] Architecture Approach - X", [], null)).toBe("draft");
    expect(pageStatus("Architecture Approach - X (Moved)", [], null)).toBe("superseded");
    expect(pageStatus("Scoping", ["Team", "Pending Review"], null)).toBe("in review");
    // The template's header lozenge text "NOT APPROVEDCONDITIONALAPPROVED" is not a status.
    expect(pageStatus("X", [], "| Dept | Status |\n|---|---|\n| EA | NOT APPROVEDCONDITIONALAPPROVED |")).toBe("unapproved");
  });
});

describe("wiki ingest", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
    ingestSource(db, source);
  });
  afterEach(() => db.close());

  const chunksOf = (path: string) =>
    db.prepare("SELECT c.section, c.section_kind AS kind, c.anchor FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE d.path = ? ORDER BY c.ord").all(path);

  it("chunks an approved architecture document by sub-section with the shared taxonomy, dropping revisions and empty template stubs", () => {
    expect(db.prepare("SELECT doc_type, status FROM documents WHERE path = '1002.md'").get()).toEqual({ doc_type: "aad", status: "approved" });
    expect(chunksOf("1002.md")).toEqual([
      { section: "Document Acceptance", kind: "approval", anchor: "Document-Acceptance" },
      { section: "Overview › Problem statement", kind: "overview", anchor: "Problem-statement" },
      { section: "Monitoring and Observability › Logging", kind: "logging", anchor: "Logging" },
      { section: "Security › Threat Model", kind: "security", anchor: "Threat-Model" },
    ]);
  });

  it("indexes nothing from an unfilled draft template", () => {
    expect(db.prepare("SELECT status FROM documents WHERE path = '1003.md'").get()).toEqual({ status: "draft" });
    expect(chunksOf("1003.md")).toEqual([]);
  });

  it("links pages to their parent, linked pages, Jira issues and spec ids", () => {
    const out = neighbors(db, "DOC:wiki:1002.md").filter((n) => n.direction === "out").map((n) => `${n.edge}:${n.id}`);
    expect(out.sort()).toEqual(["links_to:DOC:wiki:1003.md", "part_of:DOC:wiki:1001.md", "references:ACME-42", "references:WDG-CCH-001"]);
  });

  it("cites the page URL with the Confluence heading anchor and filters by section kind", () => {
    const [hit] = search(db, "correlation id logging", { filters: { sectionKinds: ["logging"] } });
    expect(hit).toMatchObject({ url: "https://example.atlassian.net/wiki/pages/viewpage.action?pageId=1002", anchor: "Logging", title: "Architecture Approach - Widget Relay" });
  });
});
