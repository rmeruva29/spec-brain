import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SddRepoConfig } from "../src/config.ts";
import { openDb, type DB } from "../src/db.ts";
import { expandVerifies, findAcIds, findRequirementIds } from "../src/ids.ts";
import { ingestSource } from "../src/ingest/index.ts";
import { getEntity, getRequirement, trace } from "../src/retrieval/lookup.ts";
import { search, toFtsQuery } from "../src/retrieval/search.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/sdd-repo");

let root: string;
let db: DB;
let source: SddRepoConfig;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spec-brain-"));
  cpSync(FIXTURE, root, { recursive: true });
  source = {
    kind: "sdd-repo",
    name: "acme",
    project: "Acme",
    root,
    include: ["specs", "docs"],
    testRoots: ["app"],
    jiraProjects: ["ACME"],
  };
  db = openDb(":memory:");
  ingestSource(db, source);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("ids", () => {
  it("expands short and ranged Verifies cells against the AC's prefix", () => {
    expect(expandVerifies("001–003, 007", "WDG-ABC")).toEqual(["WDG-ABC-001", "WDG-ABC-002", "WDG-ABC-003", "WDG-ABC-007"]);
    expect(expandVerifies("003, WDG-OTH-001", "WDG-CCH")).toEqual(["WDG-OTH-001", "WDG-CCH-003"]);
  });

  it("does not read the requirement part of an AC id as a requirement", () => {
    expect(findRequirementIds("AC-WDG-ABC-001 covers WDG-ABC-002")).toEqual(["WDG-ABC-002"]);
    expect(findAcIds("test ac_x AC_WDG_ABC_004 and AC-WDG-ABC-001")).toEqual(["AC-WDG-ABC-001", "AC-WDG-ABC-004"]);
  });
});

describe("ingest", () => {
  it("defines requirements, ACs, tasks and the capability from the spec and plan tables", () => {
    const kinds = Object.fromEntries(
      (db.prepare("SELECT kind, count(*) n FROM entities GROUP BY kind").all() as { kind: string; n: number }[]).map((r) => [r.kind, r.n]),
    );
    expect(kinds).toMatchObject({ requirement: 3, ac: 2, task: 2, capability: 1, domain: 1, test: 1 });
  });

  it("keeps the spec as the definition when another document tabulates the same id", () => {
    expect(getEntity(db, "AC-WDG-CCH-001")?.citation?.path).toBe("specs/widgets/widget-cache/spec.md");
  });

  it("is incremental: unchanged files are skipped, edits and deletions are applied", () => {
    expect(ingestSource(db, source).docsChanged).toBe(0);

    const spec = join(root, "specs/widgets/widget-cache/spec.md");
    writeFileSync(spec, "# Widget Cache\n\n## Status\nWithdrawn\n");
    const edited = ingestSource(db, source);
    expect(edited.docsChanged).toBe(1);
    // Nothing defines them any more, but specs/README.md still mentions WDG-CCH-001 and plan task 1.2 still
    // covers AC-WDG-CCH-002: they survive only as undefined references (what a drift report should flag).
    const defined = db.prepare("SELECT count(*) n FROM entities WHERE kind IN ('requirement', 'ac')").get() as { n: number };
    expect(defined.n).toBe(0);
    expect(getEntity(db, "WDG-CCH-001")).toMatchObject({ citation: null, text: null });
    expect(getEntity(db, "AC-WDG-CCH-002")).toMatchObject({ citation: null, text: null });

    rmSync(join(root, "docs/epics/ACME-10.md"));
    expect(ingestSource(db, source).docsRemoved).toBe(1);
  });
});

describe("traceability", () => {
  it("links a requirement to its ACs, tasks, Jira issues, epic and tests", () => {
    const r = getRequirement(db, "wdg-cch-001")!;
    expect(r.citation).toMatchObject({ path: "specs/widgets/widget-cache/spec.md", anchor: "functional-requirements" });
    expect(r.status).toBe("implemented");
    expect(r.verifiedBy.map((a) => a.id)).toEqual(["AC-WDG-CCH-001"]);
    expect(r.tasks.map((t) => t.id)).toEqual(["TASK:widgets/widget-cache#1.1"]);
    expect(r.jira).toEqual(["ACME-11"]);
    expect(r.epics).toEqual(["ACME-10"]); // ACME-99 is only mentioned in a later paragraph
    expect(r.tests).toEqual(["TEST:acme:app/widget-cache.test.ts"]);
  });

  it("records cross-capability verifies and task dependencies", () => {
    expect(getRequirement(db, "AC-WDG-CCH-002")!.verifies.map((v) => v.id).sort()).toEqual(["WDG-CCH-003", "WDG-OTH-001"]);
    const t = trace(db, "TASK:widgets/widget-cache#1.2", { depth: 1 })!;
    expect(t.edges).toContainEqual({ src: "TASK:widgets/widget-cache#1.2", dst: "TASK:widgets/widget-other#2.1", kind: "depends_on" });
  });

  it("does not expand through a capability hub", () => {
    const t = trace(db, "WDG-CCH-002", { depth: 3 })!;
    expect(t.nodes.map((n) => n.id)).not.toContain("WDG-CCH-003");
  });
});

describe("search", () => {
  it("returns the defining chunk first for an id in the query", async () => {
    const [first] = (await search(db, "what does WDG-CCH-002 require?")).hits;
    expect(first).toMatchObject({ entityId: "WDG-CCH-002", via: "id" });
  });

  it("finds prose by keyword with a citation", async () => {
    const { hits } = await search(db, "viewer identifiers in logs");
    expect(hits.some((h) => h.anchor === "security-requirements")).toBe(true);
  });

  it("quotes every term so user input cannot inject FTS syntax", async () => {
    expect(toFtsQuery('cache* OR "x" NEAR(a b)')).toBe('"cache" OR "NEAR"');
    expect((await search(db, '") OR *')).hits).toEqual([]);
  });
});
