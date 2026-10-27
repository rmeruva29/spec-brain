import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

// Fetches wiki content through the Atlassian MCP server that the user's Claude Code is already
// authorised against, so spec-brain never handles an Atlassian token. A small headless Claude Code
// session makes the tool calls; the raw tool results are read from its `stream-json` output, so page
// content is never retyped by a model.

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: string | null;
  isError: boolean;
}

export interface RelayResult {
  calls: ToolCall[];
  ok: boolean;
  costUsd: number | null;
  error: string | null;
}

type Block = { type: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean; text?: string };

const blockText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b: { text?: string }) => b.text ?? "").join("\n")
      : "";

/** Results too large for the context window are saved to a file by Claude Code; read them back from there. */
function resolveSaved(output: string): string {
  const m = /saved to (\/\S+?\.(?:txt|json))\b/.exec(output);
  if (!m) return output;
  const saved = readFileSync(m[1]!, "utf8");
  try {
    return blockText(JSON.parse(saved));
  } catch {
    return saved;
  }
}

export function parseStream(lines: string[], opts: { readSaved?: boolean } = {}): RelayResult {
  const calls = new Map<string, ToolCall>();
  let ok = false;
  let costUsd: number | null = null;
  let error: string | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: { type?: string; subtype?: string; message?: { content?: Block[] }; total_cost_usd?: number; is_error?: boolean; result?: string };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const block of event.message?.content ?? []) {
      if (event.type === "assistant" && block.type === "tool_use" && block.id) {
        calls.set(block.id, { id: block.id, name: block.name ?? "", input: block.input ?? {}, output: null, isError: false });
      } else if (event.type === "user" && block.type === "tool_result" && block.tool_use_id) {
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        const raw = blockText(block.content);
        call.output = opts.readSaved === false ? raw : resolveSaved(raw);
        call.isError = block.is_error === true;
      }
    }
    if (event.type === "result") {
      ok = event.subtype === "success" && !event.is_error;
      costUsd = event.total_cost_usd ?? null;
      if (!ok) error = event.result ?? event.subtype ?? "unknown error";
    }
  }
  return { calls: [...calls.values()], ok, costUsd, error };
}

/** The JSON object in a tool result, skipping any notice text the MCP server prepends or appends. */
export function extractJson<T = Record<string, unknown>>(text: string): T | null {
  const end = text.lastIndexOf("}");
  for (let i = text.indexOf("{"), tries = 0; i !== -1 && i < end && tries < 50; i = text.indexOf("{", i + 1), tries++) {
    try {
      return JSON.parse(text.slice(i, end + 1)) as T;
    } catch {
      // keep scanning
    }
  }
  return null;
}

export async function runRelay(prompt: string, allowedTools: string[], opts: { model?: string; timeoutMs?: number } = {}): Promise<RelayResult> {
  if (process.env.CLAUDECODE) {
    throw new Error("sync-confluence starts a headless Claude Code session; run it from a normal terminal, not from inside Claude Code.");
  }
  const args = ["-p", "--model", opts.model ?? "haiku", "--output-format", "stream-json", "--verbose", "--allowedTools", allowedTools.join(","), prompt];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 15 * 60_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not start \`claude\`: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = parseStream(stdout.split("\n"));
      if (code !== 0 && !result.error) result.error = stderr.trim().slice(0, 500) || `claude exited with ${code}`;
      resolve(result);
    });
  });
}
