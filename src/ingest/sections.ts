// Coarse section taxonomy shared by specs and architecture documents, so "what is our logging
// standard?" can be answered from the logging sections of every source regardless of template.
// Order matters: the first match wins.
const KINDS: [string, RegExp][] = [
  ["revision", /document revision|change ?log|revision history/i],
  ["approval", /document acceptance|approval|sign-?off/i],
  ["status", /^status$/i],
  ["out-of-scope", /out[- ]of[- ]scope|non-goals/i],
  ["decision", /decision|rationale|alternatives|options considered|trade-?offs/i],
  ["assumptions", /assumption|prerequisite|constraint|dependenc/i],
  ["logging", /logging|\blogs?\b/i],
  ["monitoring", /monitoring|observability|alert|metric|traceability|tracing|dashboards?\b/i],
  ["security", /security|threat|penetration|hardening|\bsast\b|\bdast\b|vulnerab|authenticat|authoriz|secrets?\b/i],
  ["errors", /error|failure|fallback|retr(y|ies)|resilien/i],
  ["testing", /\btest/i],
  ["deployment", /deploy|delivery|rollout|release|migration|ci\/cd|pipeline|branching/i],
  ["nfr", /non[- ]functional|performance|reliability|scalab|availability|\bsla\b/i],
  ["compliance", /compliance|privacy|\bpii\b|gdpr|retention/i],
  ["impact", /impact|cost|revenue|risk/i],
  ["ownership", /maintainers?|owners?\b|ownership|roles|responsibilit|raci|contacts?\b/i],
  ["requirements", /requirement|acceptance criteria|business rules|goals/i],
  ["design", /design|architecture|logical view|process view|topology|sequence|data ?flow|interfaces?|contracts?|\bapi\b|flows?\b/i],
  ["data", /\bdata\b/i],
  ["overview", /overview|summary|scope|problem|audience|context|purpose|introduction|background/i],
  ["references", /references?|links|appendix/i],
];

// Generic words ("scope", "data", "links") only decide when no heading on the path says more.
const WEAK = new Set(["overview", "references", "data"]);

/**
 * Classifies a section by its most specific heading first ("Monitoring and Observability › Logging" →
 * logging), but a weak match yields to a stronger one higher up ("Security › … › Identified Solution
 * Scope" → security).
 */
export function sectionKind(name: string | null): string | null {
  if (!name) return null;
  let weak: string | null = null;
  for (const part of name.split(" › ").reverse()) {
    const kind = KINDS.find(([, re]) => re.test(part))?.[0];
    if (!kind) continue;
    if (!WEAK.has(kind)) return kind;
    weak ??= kind;
  }
  return weak;
}
