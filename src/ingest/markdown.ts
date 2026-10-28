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

export function parseFrontmatter(md: string): { frontmatter: Record<string, string>; rest: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { frontmatter: {}, rest: md };
  const frontmatter: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) frontmatter[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return { frontmatter, rest: md.slice(m[0].length) };
}

/** Splits markdown into a flat list of sections; the first h1 becomes the title. Headings inside code fences are ignored. */
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
      // A leading h1 is the document title unless frontmatter already names it (wiki exports use h1 for sections).
      if (level === 1 && title === null && !frontmatter.title && sections.length === 0 && current === null) {
        title = h[2]!;
        continue;
      }
      flush();
      current = { level, heading: h[2]!, lines: [] };
      continue;
    }
    (current ? current.lines : preamble).push(line);
  }
  flush();
  return { frontmatter, title: title ?? frontmatter.title ?? frontmatter.name ?? null, preamble: preamble.join("\n").trim(), sections };
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

/** Splits one oversize block by lines; a table's header and separator rows are repeated in every piece. */
function splitByLine(block: string, max: number): string[] {
  const lines = block.split("\n");
  const isTable = lines[0]?.trim().startsWith("|") && /^\s*\|?\s*:?-{3,}/.test(lines[1] ?? "");
  const header = isTable ? lines.slice(0, 2).join("\n") : "";
  const out: string[] = [];
  let buf = "";
  for (const line of isTable ? lines.slice(2) : lines) {
    if (buf && buf.length + line.length + 1 > max) {
      out.push(buf);
      buf = "";
    }
    buf = buf ? `${buf}\n${line}` : header ? `${header}\n${line}` : line;
  }
  if (buf) out.push(buf);
  return out.map((piece) => (piece.length > max ? piece.slice(0, max) : piece));
}

/** Splits text on blank lines into pieces no longer than `max` characters; oversize blocks are split by line. */
export function splitByParagraph(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let buf = "";
  for (const block of text.split(/\n{2,}/)) {
    const paras = block.length > max ? splitByLine(block, max) : [block];
    for (const para of paras) {
      if (buf && buf.length + para.length + 2 > max) {
        out.push(buf);
        buf = "";
      }
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Shortens fenced code blocks longer than `max` characters, noting how much was left out. */
export function capCodeBlocks(md: string, max: number): string {
  return md.replace(/(^|\n)(```|~~~)([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/g, (whole, lead: string, fence: string, lang: string, code: string) => {
    if (code.length <= max) return whole;
    const kept = code.slice(0, code.lastIndexOf("\n", max) > 0 ? code.lastIndexOf("\n", max) : max);
    return `${lead}${fence}${lang}\n${kept}\n… [${code.length - kept.length} more characters of ${lang.trim() || "code"} omitted]\n${fence}`;
  });
}

/**
 * Emits sections as chunks named by their heading path ("Security › Threat Model › Model").
 * Each section at `groupDepth` levels below the chapter level (0 = chapters) starts a group that is
 * emitted together with its sub-sections when the whole group fits in `max` characters; otherwise
 * each section is emitted on its own, split by paragraph. `bodyOf` lets callers strip content they
 * turned into chunks of their own (e.g. requirement tables).
 */
export function chunkSections(
  sections: Section[],
  max: number,
  bodyOf: (s: Section, name: string) => string,
  emit: (name: string, anchor: string, text: string, section: Section) => void,
  opts: { groupDepth?: number } = {},
) {
  if (!sections.length) return;
  // Documents mix levels (wiki pages often put two front-matter tables at h1 and every chapter at h2).
  // The chapter level is the shallowest level used by at least three headings; shallower headings are
  // treated as chapters too, so a stray h1 does not become the parent of everything after it.
  const counts = new Map<number, number>();
  for (const s of sections) counts.set(s.level, (counts.get(s.level) ?? 0) + 1);
  const levels = [...counts.keys()].sort((a, b) => a - b);
  const top = levels.find((l) => counts.get(l)! >= 3) ?? levels[0]!;
  const level = (s: Section) => Math.max(s.level, top);
  const stack: Section[] = [];
  const named = sections.map((section) => {
    while (stack.length && level(stack[stack.length - 1]!) >= level(section)) stack.pop();
    stack.push(section);
    return { section, name: stack.map((x) => x.heading).join(" › ") };
  });
  const groups: (typeof named)[] = [];
  for (const n of named) {
    if (level(n.section) <= top + (opts.groupDepth ?? 0) || groups.length === 0) groups.push([n]);
    else groups[groups.length - 1]!.push(n);
  }
  for (const group of groups) {
    const head = group[0]!;
    const parts = group.map(({ section, name }) => {
      const body = bodyOf(section, name).trim();
      const text = section === head.section ? body : `${"#".repeat(section.level)} ${section.heading}\n${body}`;
      return { section, name, text, empty: !body };
    });
    if (parts.every((p) => p.empty)) continue;
    const joined = parts.filter((p) => !p.empty).map((p) => p.text).join("\n\n");
    if (joined.length <= max) {
      emit(head.name, head.section.anchor, joined, head.section);
      continue;
    }
    for (const p of parts) {
      if (p.empty) continue;
      for (const piece of splitByParagraph(p.text, max)) emit(p.name, p.section.anchor, piece, p.section);
    }
  }
}
