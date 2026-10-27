import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfluenceExportConfig } from "../config.ts";
import { extractJson, runRelay, type RelayResult } from "./relay.ts";

export interface ListedPage {
  id: string;
  title: string;
  parentId: string | null;
  type: string;
  lastModified: string;
}

export interface Manifest {
  syncedAt: string | null;
  pages: Record<string, { title: string; lastModified: string; version: number | null }>;
}

export interface SyncRoot {
  id: string;
  title: string;
  listing: ListedPage[];
}

export interface SyncPlan {
  wanted: Map<string, { root: string; title: string; ancestors: string[]; lastModified: string; parentId: string | null }>;
  toFetch: string[];
  toDelete: string[];
  excluded: number;
}

interface PageJson {
  id: string;
  title: string;
  body?: string;
  parentId?: string | null;
  spaceId?: string;
  version?: { number?: number; createdAt?: string };
}

const MCP_SERVER = "atlassian";
const tool = (name: string) => `mcp__${MCP_SERVER}__${name}`;

/**
 * Decides what to fetch: every root and every page under it that is not excluded by title, whose
 * lastModified differs from the manifest. Pages that left all the trees are deleted.
 */
export function planSync(roots: SyncRoot[], manifest: Manifest, excludeTitles: string[], force = false): SyncPlan {
  const exclude = excludeTitles.map((p) => new RegExp(p, "i"));
  const rootIds = new Set(roots.map((r) => r.id));
  // Roots come first so their real titles are known before any page beneath them is written.
  const wanted: SyncPlan["wanted"] = new Map(
    roots.map((r) => [r.id, { root: r.id, title: r.title, ancestors: [], lastModified: manifest.pages[r.id]?.lastModified ?? "", parentId: null }]),
  );
  let excluded = 0;
  for (const root of roots) {
    const byId = new Map(root.listing.map((p) => [p.id, p]));
    const ancestorsOf = (p: ListedPage): string[] => {
      const out: string[] = [];
      for (let parent = p.parentId, guard = 0; parent && guard < 20; guard++) {
        if (parent === root.id) {
          out.unshift(root.title);
          break;
        }
        const node = byId.get(parent);
        if (!node) break;
        out.unshift(node.title);
        parent = node.parentId;
      }
      return out;
    };
    for (const p of root.listing) {
      if (p.type !== "page" || wanted.has(p.id)) continue;
      const ancestors = ancestorsOf(p);
      if ([p.title, ...ancestors].some((t) => exclude.some((re) => re.test(t)))) {
        excluded++;
        continue;
      }
      wanted.set(p.id, { root: root.id, title: p.title, ancestors, lastModified: p.lastModified, parentId: p.parentId });
    }
  }
  const toFetch = [...wanted.entries()]
    .filter(([id, w]) => force || !manifest.pages[id] || manifest.pages[id]!.lastModified !== w.lastModified || (rootIds.has(id) && !w.lastModified))
    .map(([id]) => id);
  const toDelete = Object.keys(manifest.pages).filter((id) => !wanted.has(id));
  return { wanted, toFetch, toDelete, excluded };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function renderPage(source: ConfluenceExportConfig, page: PageJson, meta: { ancestors: string[]; lastModified: string }): string {
  const fm: Record<string, string | number | null | undefined> = {
    id: page.id,
    title: oneLine(page.title),
    url: `https://${source.site}/wiki/pages/viewpage.action?pageId=${page.id}`,
    space_id: page.spaceId,
    parent_id: page.parentId ?? null,
    ancestors: meta.ancestors.map(oneLine).join(" › "),
    last_modified: meta.lastModified || page.version?.createdAt,
    version: page.version?.number,
  };
  const lines = Object.entries(fm)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${(page.body ?? "").trim()}\n`;
}

function readManifest(dir: string): Manifest {
  const file = join(dir, "manifest.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Manifest) : { syncedAt: null, pages: {} };
}

function relayFailure(what: string, r: RelayResult): Error {
  return new Error(`${what} failed: ${r.error ?? "no tool result"}`);
}

async function listDescendants(source: ConfluenceExportConfig, rootId: string, model: string): Promise<ListedPage[]> {
  const pages: ListedPage[] = [];
  let cursor: string | null = null;
  for (let round = 0; round < 20; round++) {
    const args = `cloudId "${source.site}", pageId "${rootId}", depth 10, limit 250${cursor ? `, cursor "${cursor}"` : ""}`;
    const r = await runRelay(
      `You are a fetch relay for a script that reads your tool results directly. Call ${tool("getConfluencePageDescendants")} exactly once with ${args}. ` +
        "Do not summarise or repeat the result. Then reply with exactly: DONE",
      [tool("getConfluencePageDescendants")],
      { model },
    );
    const call = r.calls.find((c) => c.name === tool("getConfluencePageDescendants") && !c.isError && c.output);
    const json = call ? extractJson<{ results?: Record<string, unknown>[]; _links?: { next?: string } }>(call.output!) : null;
    if (!json?.results) throw relayFailure("listing descendants", r);
    for (const p of json.results) {
      pages.push({
        id: String(p.id),
        title: String(p.title ?? ""),
        parentId: p.parentId ? String(p.parentId) : null,
        type: String(p.type ?? "page"),
        lastModified: String(p.lastModified ?? ""),
      });
    }
    cursor = json._links?.next ? new URL(json._links.next, "https://x").searchParams.get("cursor") : null;
    if (!cursor) break;
  }
  return pages;
}

async function fetchPages(source: ConfluenceExportConfig, ids: string[], model: string): Promise<{ pages: Map<string, PageJson>; costUsd: number }> {
  const r = await runRelay(
    `You are a fetch relay for a script that reads your tool results directly. Call ${tool("getConfluencePage")} once for EACH of these page ids, ` +
      `with cloudId "${source.site}" and contentFormat "markdown", issuing the calls in parallel: ${ids.join(", ")}. ` +
      "Do not read, summarise or repeat the results. When every call has returned, reply with exactly: DONE",
    [tool("getConfluencePage")],
    { model },
  );
  const pages = new Map<string, PageJson>();
  for (const c of r.calls) {
    if (c.name !== tool("getConfluencePage") || c.isError || !c.output) continue;
    const page = extractJson<PageJson>(c.output);
    if (page?.id && ids.includes(String(page.id))) pages.set(String(page.id), { ...page, id: String(page.id) });
  }
  return { pages, costUsd: r.costUsd ?? 0 };
}

export interface SyncOptions {
  limit?: number;
  batch?: number;
  force?: boolean;
  dryRun?: boolean;
  model?: string;
  log?: (msg: string) => void;
}

export async function syncConfluence(source: ConfluenceExportConfig, opts: SyncOptions = {}) {
  const log = opts.log ?? console.log;
  const model = opts.model ?? "haiku";
  const dir = source.root;
  mkdirSync(dir, { recursive: true });
  const manifest = readManifest(dir);

  // Until a root page has been fetched once, its title is a placeholder; roots are first in the fetch
  // order, so every page written after them gets the real title in its ancestors.
  const rootTitles = new Map(source.rootPageIds.map((id) => [id, manifest.pages[id]?.title ?? source.project]));
  const roots: SyncRoot[] = [];
  for (const id of source.rootPageIds) {
    log(`Listing pages under ${id} …`);
    roots.push({ id, title: rootTitles.get(id)!, listing: await listDescendants(source, id, model) });
  }
  const plan = planSync(roots, manifest, source.excludeTitles, opts.force);
  const toFetch = opts.limit ? plan.toFetch.slice(0, opts.limit) : plan.toFetch;
  const listed = roots.reduce((n, r) => n + r.listing.length, 0);
  log(`${listed} listed, ${plan.wanted.size} wanted, ${plan.excluded} excluded, ${plan.toFetch.length} new or changed, ${plan.toDelete.length} to delete`);
  if (opts.dryRun) return { fetched: 0, failed: [] as string[], deleted: 0, costUsd: 0 };

  const batch = opts.batch ?? 8;
  const failed: string[] = [];
  let fetched = 0;
  let costUsd = 0;
  const save = () => writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ ...manifest, syncedAt: new Date().toISOString() }, null, 2)}\n`);

  for (let i = 0; i < toFetch.length; i += batch) {
    let ids = toFetch.slice(i, i + batch);
    // One retry, page by page, for anything the relay skipped.
    for (let attempt = 0; attempt < 2 && ids.length; attempt++) {
      const missing: string[] = [];
      const groups = attempt === 0 ? [ids] : ids.map((id) => [id]);
      for (const group of groups) {
        const { pages, costUsd: c } = await fetchPages(source, group, model);
        costUsd += c;
        for (const id of group) {
          const page = pages.get(id);
          if (!page) {
            missing.push(id);
            continue;
          }
          const w = plan.wanted.get(id)!;
          if (rootTitles.has(id)) rootTitles.set(id, page.title);
          const ancestors = w.ancestors.length ? [rootTitles.get(w.root)!, ...w.ancestors.slice(1)] : [];
          writeFileSync(join(dir, `${id}.md`), renderPage(source, page, { ...w, ancestors }));
          manifest.pages[id] = { title: page.title, lastModified: w.lastModified || page.version?.createdAt || "", version: page.version?.number ?? null };
          fetched++;
        }
      }
      ids = missing;
    }
    failed.push(...ids);
    save();
    log(`  ${Math.min(i + batch, toFetch.length)}/${toFetch.length} processed (${fetched} written, ${failed.length} failed)`);
  }

  for (const id of plan.toDelete) {
    rmSync(join(dir, `${id}.md`), { force: true });
    delete manifest.pages[id];
  }
  save();
  return { fetched, failed, deleted: plan.toDelete.length, costUsd };
}
