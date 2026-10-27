import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfluenceExportConfig, SddRepoConfig } from "../src/config.ts";
import { openDb, type DB } from "../src/db.ts";
import { ingestSource, resolveWikiLinks } from "../src/ingest/index.ts";
import { driftReport } from "../src/retrieval/drift.ts";
import { getEntity, neighbors } from "../src/retrieval/lookup.ts";
import { search } from "../src/retrieval/search.ts";
import { findPrecedent, getStandards, sectionKindsFor, standardsPages } from "../src/retrieval/standards.ts";

const repo: SddRepoConfig = {
  kind: "sdd-repo",
  name: "acme",
  project: "Acme",
  root: join(import.meta.dirname, "fixtures/sdd-repo"),
  include: ["specs", "docs"],
  testRoots: ["app"],
  jiraProjects: ["ACME"],
};
const wiki: ConfluenceExportConfig = {
  kind: "confluence-export",
  name: "wiki",
  project: "Example Wiki",
  root: join(import.meta.dirname, "fixtures/wiki"),
  site: "example.atlassian.net",
  rootPageIds: ["1001"],
  excludeTitles: [],
  jiraProjects: ["ACME"],
};

const page = (id: string, title: string, body: string) =>
  `---\nid: ${id}\ntitle: ${title}\nurl: https://example.atlassian.net/wiki/pages/viewpage.action?pageId=${id}\nparent_id: 2000\nancestors: Platform\n---\n\n${body}\n`;

let db: DB;
let ops: string;
let opsWiki: ConfluenceExportConfig;
beforeEach(() => {
  db = openDb(":memory:");
  ops = mkdtempSync(join(tmpdir(), "spec-brain-ops-"));
  writeFileSync(
    join(ops, "2001.md"),
    page("2001", "Logging Best Practices and Standardization", "# Log Data Model\n\nEvery log line is JSON with `trace.id`, `level` and `service.name`. Personal data is never logged.\n\n" +
      "# Log Levels\n\nTRACE and DEBUG are off in production. INFO records key entry and exit points, WARN records conditions that need attention " +
      "in volume, and ERROR records failures with the function name and enough context to find the cause.\n\n" +
      "# Configuration\n\nEvery application accepts a LOGGING_LEVEL environment variable with the values TRACE, DEBUG, INFO, WARN or ERROR, " +
      "set to INFO in every deployed environment. Application logs are kept 90 days for queries and 12 months for audit."),
  );
  writeFileSync(join(ops, "2002.md"), page("2002", "API Guardrails", "# Contents\n\n"));
  opsWiki = { ...wiki, name: "ops-wiki", project: "Ops", root: ops, rootPageIds: ["2000"] };
  ingestSource(db, repo);
  ingestSource(db, wiki);
  ingestSource(db, opsWiki);
});
afterEach(() => {
  db.close();
  rmSync(ops, { recursive: true, force: true });
});

describe("superseded requirements", () => {
  it("keep their id but drop out of default search", async () => {
    expect(getEntity(db, "WDG-CCH-004")!.status).toBe("superseded");
    const ids = (await search(db, "cached entries never expire", { k: 20 })).hits.map((h) => h.entityId);
    expect(ids).not.toContain("WDG-CCH-004");
    const all = await search(db, "cached entries never expire", { k: 20, filters: { includeArchived: true } });
    expect(all.hits.map((h) => h.entityId)).toContain("WDG-CCH-004");
  });
});

describe("standards and precedent", () => {
  it("maps topics to the design sections they are written up under", () => {
    expect(sectionKindsFor("required log fields")).toEqual(["logging"]);
    expect(sectionKindsFor("Dynatrace alerting")).toEqual(["monitoring", "logging"]);
    expect(sectionKindsFor("pricing")).toEqual([]);
  });

  it("returns standards pages first and design sections that apply them second", async () => {
    const r = await getStandards(db, "JSON logging personal data");
    expect(r.standards.hits[0]!.title).toBe("Logging Best Practices and Standardization");
    expect(r.standards.hits.every((h) => h.docType === "standard")).toBe(true);
    expect(r.practice.hits.some((h) => h.title === "Architecture Approach - Widget Relay" && h.sectionKind === "logging")).toBe(true);
  });

  it("hands over the whole standards page, not just the sections that matched", async () => {
    const r = await getStandards(db, "JSON logging personal data");
    const [page] = standardsPages(db, r);
    expect(page!.title).toBe("Logging Best Practices and Standardization");
    expect(page!.text).toContain("LOGGING_LEVEL");
    expect(page!.text.indexOf("Log Data Model")).toBeLessThan(page!.text.indexOf("Configuration"));
  });

  it("groups decision records by document with their approval status", async () => {
    const r = await findPrecedent(db, "mutual TLS relay secrets vault");
    expect(r.precedents[0]).toMatchObject({ title: "Architecture Approach - Widget Relay", docType: "aad", status: "approved" });
    expect(new Set(r.precedents.map((p) => p.path)).size).toBe(r.precedents.length);
  });
});

describe("drift report", () => {
  it("lists ids cited but undefined, unverified requirements and untested criteria", () => {
    const d = driftReport(db);
    expect(d.undefinedIds.map((u) => u.id)).toContain("WDG-OTH-001");
    expect(d.untestedCriteria.map((i) => i.id)).toEqual(["AC-WDG-CCH-002"]);
    expect(d.unverifiedRequirements.map((i) => i.id)).not.toContain("WDG-CCH-004");
  });

  it("flags empty standards pages and wiki pages linked but not synced, resolving links across wiki sources", () => {
    writeFileSync(join(ops, "2003.md"), page("2003", "Relay runbook", "See [the relay design](https://example.atlassian.net/wiki/spaces/EX/pages/1002/Widget+Relay) and [alerts](https://example.atlassian.net/wiki/spaces/OPS/pages/2999/Alert+Routing)."));
    ingestSource(db, opsWiki);
    let d = driftReport(db);
    expect(d.emptyStandards.map((s) => s.title)).toEqual(["API Guardrails"]);
    expect(d.missingPages.map((m) => [m.pageId, m.title])).toContainEqual(["2999", "Alert Routing"]);
    expect(d.missingPages.map((m) => m.pageId)).toContain("1002");

    expect(resolveWikiLinks(db, ["wiki", "ops-wiki"])).toBe(1);
    d = driftReport(db);
    expect(d.missingPages.map((m) => m.pageId)).not.toContain("1002");
    expect(neighbors(db, "DOC:ops-wiki:2003.md", ["links_to"]).map((n) => n.id)).toContain("DOC:wiki:1002.md");
  });
});
