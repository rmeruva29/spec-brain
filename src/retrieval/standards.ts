import type { DB } from "../db.ts";
import { search, type Hit, type SearchOptions, type SearchResult } from "./search.ts";

// Two questions architects ask that plain search answers poorly: "what is our standard for X?" (rules
// first, then how designs applied them) and "have we decided this before?" (decision records grouped
// by document, with their approval status).

/** Documents that state a rule: wiki standards and guardrails pages, repository conventions. */
export const STANDARD_TYPES = ["standard", "convention"];
/** Documents that record a decision: wiki architecture approach documents, repository ADRs, assessments. */
export const PRECEDENT_TYPES = ["aad", "decision", "assessment", "strategy"];
/** Where a rule shows up in practice: decision records plus specifications and architecture docs. */
const PRACTICE_TYPES = [...PRECEDENT_TYPES, "spec", "arch-doc"];

const TOPIC_KINDS: [RegExp, string[]][] = [
  [/\blog(s|ging)?\b|trace id|correlation/i, ["logging"]],
  [/monitor|observab|alert|dynatrace|\bapm\b|dashboard|metric/i, ["monitoring", "logging"]],
  [/secur|auth|secret|vulnerab|encrypt|\bpii\b|mtls|\bwaf\b|pentest/i, ["security", "compliance"]],
  [/error|retr(y|ies)|exception|dead.?letter|\bdlt\b/i, ["errors"]],
  [/\btest|\bqa\b|coverage/i, ["testing"]],
  [/deploy|release|pipeline|ci\/?cd|rollback/i, ["deployment"]],
];

/** Section kinds a topic is usually written up under in design documents; empty when none fits. */
export function sectionKindsFor(topic: string): string[] {
  return [...new Set(TOPIC_KINDS.filter(([re]) => re.test(topic)).flatMap(([, kinds]) => kinds))];
}

type Options = Omit<SearchOptions, "filters">;

export interface StandardsResult {
  topic: string;
  standards: SearchResult;
  practice: SearchResult;
  sectionKinds: string[];
}

/**
 * The reranker scores a bare topic label ("database and data migration") against standards prose poorly in
 * both directions: covered topics scored 0.04, uncovered ones up to 0.14. Scored against the question,
 * uncovered topics stayed at or below 0.045 and covered ones started at 0.104 (33 probe topics, 2026-10-28).
 * Retrieval keeps the topic itself, since the question's extra words change which pages come back. A label
 * joining several themes can still score low ("testing and quality gates": 0.015), so name what is covered.
 */
const standardsQuestion = (topic: string) => `What is our standard for ${topic}?`;
const STANDARDS_GUARD = 0.05;

export async function getStandards(db: DB, topic: string, opts: Options & { system?: string } = {}): Promise<StandardsResult> {
  const query = opts.system ? `${topic} ${opts.system}` : topic;
  const sectionKinds = sectionKindsFor(topic);
  const standards = await search(db, query, { ...opts, rerankQuery: standardsQuestion(query), k: opts.k ?? 6, filters: { docTypes: STANDARD_TYPES } });
  if (opts.reranker && opts.rerankUse === "guard" && standards.confidence !== null && standards.confidence < 1) {
    standards.lowConfidence = standards.confidence < STANDARDS_GUARD;
  }
  let practice = await search(db, query, { ...opts, k: 6, filters: { docTypes: PRACTICE_TYPES, sectionKinds: sectionKinds.length ? sectionKinds : undefined } });
  if (sectionKinds.length && !practice.hits.length) practice = await search(db, query, { ...opts, k: 6, filters: { docTypes: PRACTICE_TYPES } });
  return { topic, standards, practice, sectionKinds };
}

export interface Precedent {
  title: string | null;
  source: string;
  path: string;
  url: string | null;
  docType: string;
  status: string | null;
  hits: Hit[];
}

export interface PrecedentResult {
  question: string;
  precedents: Precedent[];
  confidence: number | null;
  lowConfidence: boolean;
}

/** Decision records that address the question, one entry per document, best first. */
export async function findPrecedent(db: DB, question: string, opts: Options & { docs?: number; includeArchived?: boolean } = {}): Promise<PrecedentResult> {
  const r = await search(db, question, { ...opts, k: 24, maxPerDoc: 2, filters: { docTypes: PRECEDENT_TYPES, includeArchived: opts.includeArchived } });
  const byDoc = new Map<string, Precedent>();
  for (const h of r.hits) {
    const key = `${h.source}:${h.path}`;
    const p = byDoc.get(key) ?? { title: h.title, source: h.source, path: h.path, url: h.url, docType: h.docType, status: h.status, hits: [] };
    p.hits.push(h);
    byDoc.set(key, p);
  }
  return { question, precedents: [...byDoc.values()].slice(0, opts.docs ?? 5), confidence: r.confidence, lowConfidence: r.lowConfidence };
}

export interface FullDocument {
  title: string | null;
  url: string | null;
  path: string;
  status: string | null;
  text: string;
}

/**
 * Whole text of the standards pages behind the top hits, in page order. Search returns a few chunks
 * per page; a reviewer drafting rules from a standard needs all of it, including the sections that
 * did not match the query (the data model, the levels, the configuration). A topic can rest on many
 * pages (testing: QA guides, the SDLC, the work-flow page, the vulnerability guidelines), and relevance
 * scores do not separate the minor ones from noise, so the cut is generous and noise comes last.
 */
export function standardsPages(db: DB, r: StandardsResult, opts: { maxDocs?: number; maxChars?: number } = {}): FullDocument[] {
  if (r.standards.lowConfidence) return [];
  const docs = [...new Map(r.standards.hits.map((h) => [`${h.source}:${h.path}`, h])).values()].slice(0, opts.maxDocs ?? 8);
  const chunks = db.prepare(
    "SELECT c.section, c.text FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE d.source = ? AND d.path = ? ORDER BY c.ord",
  );
  return docs.map((h) => {
    let text = "";
    for (const c of chunks.all(h.source, h.path) as { section: string | null; text: string }[]) text += `${c.section ? `### ${c.section}\n` : ""}${c.text}\n\n`;
    const max = opts.maxChars ?? 80_000;
    return { title: h.title, url: h.url, path: h.path, status: h.status, text: text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text.trim() };
  });
}
