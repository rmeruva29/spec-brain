// Identifier conventions of a spec-driven repo:
//   requirement  <DOM>-<CAP>-<nnn>        e.g. WDG-CCH-001
//   acceptance   AC-<DOM>-<CAP>-<nnn>     e.g. AC-WDG-CCH-003
//   capability   CAP:<domain>/<capability>
//   plan task    TASK:<domain>/<capability>#<n.n>
//   document     DOC:<source>:<path>
//   test file    TEST:<source>:<path>
//   jira issue   <KEY>-<n> (keys come from config)

export const REQ_RE = /(?<![A-Z]-)\b[A-Z]{3}-[A-Z]{3}-\d{3}\b/g;
export const AC_RE = /\bAC-[A-Z]{3}-[A-Z]{3}-\d{3}\b/g;
const AC_UNDERSCORE_RE = /\bAC_([A-Z]{3})_([A-Z]{3})_(\d{3})\b/g;
const CAP_PATH_RE = /\bspecs\/([a-z0-9-]+)\/([a-z0-9-]+)\b/g;

export type EntityKind = "requirement" | "ac" | "capability" | "domain" | "task" | "document" | "test" | "jira";

export const capId = (domain: string, capability: string) => `CAP:${domain}/${capability}`;
export const domainId = (domain: string) => `DOM:${domain}`;
export const taskId = (domain: string, capability: string, n: string) => `TASK:${domain}/${capability}#${n}`;
export const docId = (source: string, path: string) => `DOC:${source}:${path}`;
export const testId = (source: string, path: string) => `TEST:${source}:${path}`;

export function jiraRegex(projects: string[]): RegExp | null {
  return projects.length ? new RegExp(`\\b(?:${projects.join("|")})-\\d+\\b`, "g") : null;
}

const uniq = (xs: Iterable<string>) => [...new Set(xs)];

export function findRequirementIds(text: string): string[] {
  return uniq(text.match(REQ_RE) ?? []);
}

export function findAcIds(text: string): string[] {
  const underscored = [...text.matchAll(AC_UNDERSCORE_RE)].map((m) => `AC-${m[1]}-${m[2]}-${m[3]}`);
  return uniq([...(text.match(AC_RE) ?? []), ...underscored]);
}

export function findJiraKeys(text: string, re: RegExp | null): string[] {
  return re ? uniq(text.match(re) ?? []) : [];
}

export function findCapabilityPaths(text: string): string[] {
  return uniq([...text.matchAll(CAP_PATH_RE)].map((m) => capId(m[1]!, m[2]!)));
}

export function inferKind(id: string): EntityKind {
  if (id.startsWith("CAP:")) return "capability";
  if (id.startsWith("DOM:")) return "domain";
  if (id.startsWith("TASK:")) return "task";
  if (id.startsWith("DOC:")) return "document";
  if (id.startsWith("TEST:")) return "test";
  if (/^AC-[A-Z]{3}-[A-Z]{3}-\d{3}$/.test(id)) return "ac";
  if (/^[A-Z]{3}-[A-Z]{3}-\d{3}$/.test(id)) return "requirement";
  return "jira";
}

/**
 * Expands an acceptance criterion's "Verifies" cell into requirement ids.
 * Accepts full ids and short forms relative to the AC's own prefix: "001–005, 007", "WDG-OTH-002".
 */
export function expandVerifies(cell: string, prefix: string): string[] {
  const out: string[] = findRequirementIds(cell);
  const stripped = cell.replace(REQ_RE, "");
  for (const m of stripped.matchAll(/\b(\d{3})(?:\s*[–—-]\s*(\d{3}))?\b/g)) {
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    for (let n = from; n <= to && n - from < 100; n++) out.push(`${prefix}-${String(n).padStart(3, "0")}`);
  }
  return uniq(out);
}

/** Pulls every recognised identifier out of free text. */
export function findAllRefs(text: string, jira: RegExp | null): string[] {
  return uniq([...findAcIds(text), ...findRequirementIds(text), ...findJiraKeys(text, jira), ...findCapabilityPaths(text)]);
}
