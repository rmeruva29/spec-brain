import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

const SddRepoSource = z.object({
  kind: z.literal("sdd-repo"),
  /** Stable source id; part of every document id. */
  name: z.string().regex(/^[a-z0-9-]+$/),
  /** Display name used in contextual prefixes. */
  project: z.string(),
  root: z.string(),
  /** Directories or files (relative to root) whose markdown is indexed. */
  include: z.array(z.string()).default(["specs", "docs", ".claude/agents", ".claude/skills", "CLAUDE.md", "AGENTS.md"]),
  /** Directories (relative to root) scanned for tests that cite acceptance-criteria ids. */
  testRoots: z.array(z.string()).default([]),
  /** Jira project keys recognised as issue references, e.g. ["PROJ"]. */
  jiraProjects: z.array(z.string()).default([]),
});

const ConfluenceExportSource = z.object({
  kind: z.literal("confluence-export"),
  name: z.string().regex(/^[a-z0-9-]+$/),
  project: z.string(),
  /** Local directory the sync writes `<pageId>.md` files and `manifest.json` into. */
  root: z.string(),
  /** Atlassian site host, e.g. "example.atlassian.net". */
  site: z.string(),
  rootPageId: z.string().regex(/^\d+$/),
  /** Pages whose own or ancestor title matches one of these regexes are not synced. */
  excludeTitles: z.array(z.string()).default([]),
  jiraProjects: z.array(z.string()).default([]),
});

const Source = z.discriminatedUnion("kind", [SddRepoSource, ConfluenceExportSource]);

const ConfigSchema = z.object({
  dbPath: z.string().default("data/spec-brain.db"),
  /** Embeddings survive index rebuilds here, keyed by chunk content hash and model. */
  embeddingCachePath: z.string().default("data/embedding-cache.db"),
  modelCacheDir: z.string().default(".cache/models"),
  embedding: z
    .object({
      model: z.string().default("Xenova/bge-base-en-v1.5"),
      dtype: z.string().default("q8"),
      /** bge-v1.5 instruction for short queries against passages. */
      queryPrefix: z.string().default("Represent this sentence for searching relevant passages: "),
    })
    .prefault({}),
  reranker: z
    .object({
      model: z.string().default("Xenova/bge-reranker-base"),
      dtype: z.string().default("q8"),
      /** Fused candidates scored by the cross-encoder. */
      candidates: z.number().int().min(5).max(100).default(30),
    })
    .prefault({}),
  sources: z.array(Source).min(1),
});

export type SddRepoConfig = z.infer<typeof SddRepoSource>;
export type ConfluenceExportConfig = z.infer<typeof ConfluenceExportSource>;
export type SourceConfig = z.infer<typeof Source>;
export type Config = z.infer<typeof ConfigSchema>;

function expand(path: string, base: string): string {
  const p = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  return isAbsolute(p) ? p : resolve(base, p);
}

/** Loads `SPEC_BRAIN_CONFIG` or `./spec-brain.config.json`; relative paths resolve against the config file. */
export function loadConfig(path = process.env.SPEC_BRAIN_CONFIG ?? "spec-brain.config.json"): Config {
  const file = resolve(path);
  if (!existsSync(file)) {
    throw new Error(`No config at ${file}. Copy spec-brain.config.example.json to spec-brain.config.json and edit it.`);
  }
  const base = dirname(file);
  const config = ConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  return {
    ...config,
    dbPath: expand(config.dbPath, base),
    embeddingCachePath: expand(config.embeddingCachePath, base),
    modelCacheDir: expand(config.modelCacheDir, base),
    sources: config.sources.map((s) => ({ ...s, root: expand(s.root, base) })),
  };
}
