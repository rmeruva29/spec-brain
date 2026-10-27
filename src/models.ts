import os from "node:os";
import type { Config } from "./config.ts";

// Local ONNX models via transformers.js: weights are downloaded once into the model cache and all
// inference runs in-process on the CPU, so no indexed text leaves the machine.

export interface Embedder {
  model: string;
  dim: number;
  /** Unit-length vectors. Queries and passages are encoded differently by retrieval models. */
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
}

export interface Reranker {
  model: string;
  /** Relevance of each passage to the query, in [0, 1]. */
  score(query: string, passages: string[]): Promise<number[]>;
}

const sessionOptions = () => ({ intraOpNumThreads: os.cpus().length, interOpNumThreads: 1 });

async function transformers(cacheDir: string) {
  const t = await import("@huggingface/transformers");
  t.env.cacheDir = cacheDir;
  return t;
}

export async function createEmbedder(config: Config): Promise<Embedder> {
  const { model, dtype, queryPrefix } = config.embedding;
  const t = await transformers(config.modelCacheDir);
  const extract = await t.pipeline("feature-extraction", model, {
    dtype: dtype as "q8",
    device: "cpu",
    session_options: sessionOptions(),
  });
  const probe = await extract(["probe"], { pooling: "cls", normalize: true });
  const dim = probe.dims.at(-1)!;
  return {
    model: `${model}@${dtype}`,
    dim,
    async embed(texts, kind) {
      if (!texts.length) return [];
      const input = kind === "query" ? texts.map((q) => `${queryPrefix}${q}`) : texts;
      const out = await extract(input, { pooling: "cls", normalize: true });
      const data = out.data as Float32Array;
      return texts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
    },
  };
}

export async function createReranker(config: Config): Promise<Reranker> {
  const { model, dtype } = config.reranker;
  const t = await transformers(config.modelCacheDir);
  const tokenizer = await t.AutoTokenizer.from_pretrained(model);
  const classifier = await t.AutoModelForSequenceClassification.from_pretrained(model, {
    dtype: dtype as "q8",
    device: "cpu",
    session_options: sessionOptions(),
  });
  return {
    model: `${model}@${dtype}`,
    async score(query, passages) {
      if (!passages.length) return [];
      const inputs = tokenizer(new Array(passages.length).fill(query), { text_pair: passages, padding: true, truncation: true, max_length: 512 });
      const { logits } = await classifier(inputs);
      return Array.from(logits.data as Float32Array, (x) => 1 / (1 + Math.exp(-x)));
    },
  };
}

/** One model instance per process; the MCP server and eval runs reuse it across queries. */
export function lazy<T>(make: () => Promise<T>): () => Promise<T> {
  let instance: Promise<T> | null = null;
  return () => (instance ??= make());
}
