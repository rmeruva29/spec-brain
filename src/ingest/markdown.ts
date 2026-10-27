export interface Section {
  level: number;
  heading: string;
  anchor: string;
  body: string;
}

export interface ParsedMarkdown {
  frontmatter: Record<string, string>;
  title: string | null;
  preamble: string;
  sections: Section[];
}

export interface Table {
  header: string[];
  rows: string[][];
  /** The table's source lines, so callers can drop a consumed table from the prose. */
  raw: string;
}

/** GitHub-style heading anchor. */
export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function parseFrontmatter(md: string): { frontmatter: Record<string, string>; rest: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { frontmatter: {}, rest: md };
  const frontmatter: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) frontmatter[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return { frontmatter, rest: md.slice(m[0].length) };
}

/** Splits markdown into a flat list of level ≥ 2 sections; the first h1 becomes the title. Headings inside code fences are ignored. */
export function parseMarkdown(md: string): ParsedMarkdown {
  const { frontmatter, rest } = parseFrontmatter(md);
  let title: string | null = null;
  const preamble: string[] = [];
  const sections: Section[] = [];
  let current: { level: number; heading: string; lines: string[] } | null = null;
  let fence: string | null = null;

  const flush = () => {
    if (current) {
      sections.push({ level: current.level, heading: current.heading, anchor: slugify(current.heading), body: current.lines.join("\n").trim() });
    }
  };

  for (const line of rest.split(/\r?\n/)) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch) fence = fence === null ? fenceMatch[1]! : fence === fenceMatch[1] ? null : fence;
    const h = fence === null && !fenceMatch ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) {
      const level = h[1]!.length;
      if (level === 1 && title === null && sections.length === 0 && current === null) {
        title = h[2]!;
        continue;
      }
      flush();
      current = { level: Math.max(level, 2), heading: h[2]!, lines: [] };
      continue;
    }
    (current ? current.lines : preamble).push(line);
  }
  flush();
  return { frontmatter, title: title ?? frontmatter.name ?? null, preamble: preamble.join("\n").trim(), sections };
}

function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/);
  return cells.map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Extracts pipe tables from a section body and returns the remaining prose separately. */
export function extractTables(body: string): { tables: Table[]; prose: string } {
  const lines = body.split("\n");
  const tables: Table[] = [];
  const prose: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (line.trim().startsWith("|") && next !== undefined && /^\s*\|?\s*:?-{3,}/.test(next)) {
      const start = i;
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(splitRow(lines[i++]!));
      tables.push({ header, rows, raw: lines.slice(start, i).join("\n") });
      i--;
    } else {
      prose.push(line);
    }
  }
  return { tables, prose: prose.join("\n").trim() };
}

/** Splits text on blank lines into pieces no longer than `max` characters (a single oversize paragraph stays whole). */
export function splitByParagraph(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let buf = "";
  for (const para of text.split(/\n{2,}/)) {
    if (buf && buf.length + para.length + 2 > max) {
      out.push(buf);
      buf = "";
    }
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  if (buf) out.push(buf);
  return out;
}
