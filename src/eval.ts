import { readFileSync } from "node:fs";
import type { DB } from "./db.ts";
import type { Embedder, Reranker } from "./models.ts";
import { search, toFtsQuery, type Mode } from "./retrieval/search.ts";

// Retrieval evaluation at document level: for each golden question, did the documents that answer it
// come back near the top? Negative questions (no expected documents) test whether the system says
// "not covered" instead of returning confident noise.

export interface GoldenItem {
  id: string;
  category: string;
  q: string;
  /** "source:path" of every document that answers the question; empty for a negative question. */
  expect: string[];
}

export type EvalMode = "grep" | Mode | `${Mode}+rerank` | `${Mode}+guard`;

export interface QuestionResult {
  id: string;
  category: string;
  docs: string[];
  rank: number | null;
  confidence: number | null;
  lowConfidence: boolean;
  ms: number;
}

export function loadGolden(path: string): GoldenItem[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("//"))
    .map((l) => JSON.parse(l) as GoldenItem);
}

const terms = (q: string) =>
  (toFtsQuery(q) ?? "")
    .split(" OR ")
    .map((t) => t.replace(/"/g, "").toLowerCase())
    .filter((t) => t.length > 2);

/**
 * The "plain grep" baseline: rank documents by how many distinct query terms they contain, then by
 * total occurrences, as a person or agent grepping the text would.
 */
export function grepBaseline(db: DB) {
  const docs = (
    db
      .prepare(
        `SELECT d.source || ':' || d.path AS key, lower(group_concat(c.text, char(10))) AS body
           FROM documents d JOIN chunks c ON c.doc_id = d.id GROUP BY d.id`,
      )
      .all() as { key: string; body: string }[]
  ).map((d) => ({ key: d.key, body: d.body }));
  return (q: string, k: number): string[] => {
    const ts = terms(q);
    return docs
      .map((d) => {
        let distinct = 0;
        let total = 0;
        for (const t of ts) {
          const n = d.body.split(t).length - 1;
          if (n) distinct++;
          total += n;
        }
        return { key: d.key, score: distinct * 1000 + total };
      })
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((d) => d.key);
  };
}

export async function runEval(
  db: DB,
  golden: GoldenItem[],
  modes: EvalMode[],
  models: { embedder: () => Promise<Embedder>; reranker: () => Promise<Reranker>; rerankCandidates: number },
  k = 8,
) {
  const results: Record<string, QuestionResult[]> = {};
  const grep = modes.includes("grep") ? grepBaseline(db) : null;
  for (const mode of modes) {
    // Load models before timing so the first question does not pay for it.
    if (mode !== "grep" && mode !== "bm25") await models.embedder();
    if (mode.includes("+")) await models.reranker();
    results[mode] = [];
    for (const item of golden) {
      const started = performance.now();
      let docs: string[];
      let confidence: number | null = null;
      let lowConfidence = false;
      if (mode === "grep") docs = grep!(item.q, k);
      else {
        const [base, use] = mode.split("+") as [Mode, "rerank" | "guard" | undefined];
        const r = await search(db, item.q, {
          k: 30,
          mode: base,
          embedder: models.embedder,
          reranker: use ? models.reranker : undefined,
          rerankUse: use === "guard" ? "guard" : "rank",
          rerankCandidates: models.rerankCandidates,
        });
        const keys = r.hits.map((h) => `${h.source}:${h.path}`);
        docs = [...new Set(keys)].slice(0, k);
        confidence = r.confidence;
        lowConfidence = r.lowConfidence;
      }
      const idx = docs.findIndex((d) => item.expect.includes(d));
      results[mode]!.push({
        id: item.id,
        category: item.category,
        docs,
        rank: idx === -1 ? null : idx + 1,
        confidence,
        lowConfidence,
        ms: performance.now() - started,
      });
    }
  }
  return results;
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};

export function summarize(golden: GoldenItem[], results: Record<string, QuestionResult[]>) {
  const negative = new Set(golden.filter((g) => !g.expect.length).map((g) => g.id));
  const rows = Object.entries(results).map(([mode, rs]) => {
    const pos = rs.filter((r) => !negative.has(r.id));
    const neg = rs.filter((r) => negative.has(r.id));
    const hit = (n: number) => pos.filter((r) => r.rank !== null && r.rank <= n).length;
    return {
      mode,
      "hit@1": pct(hit(1), pos.length),
      "hit@3": pct(hit(3), pos.length),
      "hit@8": pct(hit(8), pos.length),
      MRR: (pos.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / (pos.length || 1)).toFixed(2),
      "negatives flagged": `${neg.filter((r) => r.lowConfidence).length}/${neg.length}`,
      "positives wrongly flagged": `${pos.filter((r) => r.lowConfidence).length}/${pos.length}`,
      "p50 ms": Math.round(quantile(rs.map((r) => r.ms), 0.5)),
      "p95 ms": Math.round(quantile(rs.map((r) => r.ms), 0.95)),
    };
  });
  const categories = [...new Set(golden.filter((g) => g.expect.length).map((g) => g.category))];
  const byCategory = categories.map((cat) => {
    const row: Record<string, string> = { category: `${cat} (${golden.filter((g) => g.category === cat).length})` };
    for (const [mode, rs] of Object.entries(results)) {
      const inCat = rs.filter((r) => r.category === cat);
      row[mode] = pct(inCat.filter((r) => r.rank !== null && r.rank <= 3).length, inCat.length);
    }
    return row;
  });
  return { rows, byCategory };
}

/** Best low-confidence threshold for a mode: the cut that separates negatives from positives most accurately. */
export function calibrate(golden: GoldenItem[], rs: QuestionResult[]) {
  const negative = new Set(golden.filter((g) => !g.expect.length).map((g) => g.id));
  // Questions answered by an exact id lookup report confidence 1 and are never flagged; leave them out.
  const scored = rs.filter((r) => r.confidence !== null && r.confidence < 1);
  const positives = scored.filter((r) => !negative.has(r.id)).length;
  const candidates = [...new Set(scored.map((r) => r.confidence!))].sort((a, b) => a - b);
  let best = { threshold: 0, accuracy: 0, negativesFlagged: 0, positivesFlagged: 0 };
  for (const c of candidates) {
    const t = c + 1e-6;
    const negFlagged = scored.filter((r) => negative.has(r.id) && r.confidence! < t).length;
    const posFlagged = scored.filter((r) => !negative.has(r.id) && r.confidence! < t).length;
    const accuracy = (negFlagged + (positives - posFlagged)) / scored.length;
    if (accuracy > best.accuracy) best = { threshold: Number(t.toFixed(3)), accuracy, negativesFlagged: negFlagged, positivesFlagged: posFlagged };
  }
  return best;
}
