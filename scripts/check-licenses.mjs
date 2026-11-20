#!/usr/bin/env node
/**
 * check-licenses.mjs — dependency-license CI gate.
 *
 * Scans third-party node_modules and classifies each package's license against
 * .routekit/license-policy.yaml into allow / deny / flag / unknown. The gate FAILS
 * (exit 1) only on DENY; FLAG and unknown are warn-only (listed, non-fatal) unless the
 * policy sets `unknownIsDeny`. `--report` lists everything and always exits 0.
 *
 * CRITICAL RATIONALE — this gate is deliberately STRICTER than AGPL compatibility. The
 * core is AGPL-3.0 and could legally consume GPL/AGPL deps, but a strong-copyleft
 * dependency would poison the dual-license + proprietary-Pro-plugin monetization model
 * (you cannot relicense code you don't own). Do NOT relax it as "redundant with AGPL".
 *
 * Build-free: pure Node + js-yaml (already a devDep). The classification helpers are
 * exported for unit testing; the CLI runs only when the file is invoked directly.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";

// Verdict rank: index === severity (0 = worst). OR takes the max (least restrictive
// operand wins); AND takes the min (most restrictive operand wins).
const VERDICTS = ["deny", "unknown", "flag", "allow"];
const rankOf = (v) => VERDICTS.indexOf(v);
const byRank = (r) => VERDICTS[Math.max(0, Math.min(VERDICTS.length - 1, r))];

/** Load + normalize the policy yaml into Sets. */
export function loadPolicy(policyPath) {
  const raw = yaml.load(fs.readFileSync(policyPath, "utf8")) || {};
  return {
    allow: new Set(raw.allow || []),
    deny: new Set(raw.deny || []),
    flag: new Set(raw.flag || []),
    unknownIsDeny: Boolean(raw.unknownIsDeny),
  };
}

/** Classify a single SPDX license identifier (no operators). */
export function classifyId(id, policy) {
  const t = String(id || "").trim().replace(/\+$/, ""); // GPL-2.0+ (legacy) → GPL-2.0
  if (!t) return "unknown";
  if (policy.allow.has(t)) return "allow";
  if (policy.deny.has(t)) return "deny";
  if (policy.flag.has(t)) return "flag";
  // Family fallback (defense-in-depth): catch legacy/short copyleft forms (GPL-2.0,
  // GPL-2.0+, AGPL-3.0) that aren't spelled out in the explicit lists. This is a safety
  // net, NOT a license to thin the lists — the lists remain the documented policy.
  if (/^AGPL-/i.test(t) || /^GPL-/i.test(t)) return "deny";
  if (/^LGPL-/i.test(t)) return "flag";
  return "unknown";
}

function tokenize(expr) {
  return String(expr).replace(/\(/g, " ( ").replace(/\)/g, " ) ").trim().split(/\s+/).filter(Boolean);
}

/**
 * Evaluate a full SPDX expression (OR / AND / parens / "WITH exception") → verdict.
 * AND binds tighter than OR (SPDX precedence). OR = max rank, AND = min rank.
 */
export function classifyExpression(expr, policy) {
  const tokens = tokenize(expr);
  if (!tokens.length) return "unknown";
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];
  function parseOr() {
    let v = parseAnd();
    while (peek() && peek().toUpperCase() === "OR") {
      eat();
      v = byRank(Math.max(rankOf(v), rankOf(parseAnd())));
    }
    return v;
  }
  function parseAnd() {
    let v = parseAtom();
    while (peek() && peek().toUpperCase() === "AND") {
      eat();
      v = byRank(Math.min(rankOf(v), rankOf(parseAtom())));
    }
    return v;
  }
  function parseAtom() {
    const t = eat();
    if (t === "(") {
      const v = parseOr();
      if (peek() === ")") eat();
      return v;
    }
    if (peek() && peek().toUpperCase() === "WITH") {
      eat(); // WITH
      eat(); // <exception-id> — dropped; classify by the base license
    }
    return classifyId(t, policy);
  }
  return parseOr();
}

/** Resolve a package.json license field (modern string, legacy object/array) → expression | null. */
export function resolveLicenseExpr(pkg) {
  if (!pkg) return null;
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license === "object" && pkg.license.type) return String(pkg.license.type);
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => (typeof l === "string" ? l : l && l.type)).filter(Boolean);
    if (types.length) return types.join(" OR "); // legacy array = disjunction
  }
  if (typeof pkg.licenses === "string") return pkg.licenses;
  return null;
}

/** Classify a package.json object → verdict. */
export function classifyPackage(pkg, policy) {
  const expr = resolveLicenseExpr(pkg);
  return expr ? classifyExpression(expr, policy) : "unknown";
}

/** Discover first-party workspace package names (exempt from the third-party gate). */
export function getSelfPackages(root) {
  const self = new Set();
  try {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (rootPkg.name) self.add(rootPkg.name);
    const ws = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces?.packages || [];
    for (const pattern of ws) {
      const base = pattern.replace(/[/\\]\*+$/, "");
      const dir = path.join(root, base);
      if (!fs.existsSync(dir)) continue;
      for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const pj = path.join(dir, sub.name, "package.json");
        if (!fs.existsSync(pj)) continue;
        try {
          const n = JSON.parse(fs.readFileSync(pj, "utf8")).name;
          if (n) self.add(n);
        } catch {
          /* skip unparseable workspace package */
        }
      }
    }
  } catch {
    /* no root package.json */
  }
  return self;
}

/** Collect every package under node_modules (scoped + nested). */
export function collectPackages(nmDir, out = []) {
  if (!fs.existsSync(nmDir)) return out;
  for (const entry of fs.readdirSync(nmDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // .bin, .cache, .package-lock.json
    const full = path.join(nmDir, entry.name);
    if (entry.name.startsWith("@")) {
      for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
        addPackage(path.join(full, sub.name), `${entry.name}/${sub.name}`, out);
      }
    } else {
      addPackage(full, entry.name, out);
    }
  }
  return out;
}
function addPackage(dir, name, out) {
  const pj = path.join(dir, "package.json");
  if (fs.existsSync(pj)) out.push({ name, dir, pkgJsonPath: pj });
  const nested = path.join(dir, "node_modules");
  if (fs.existsSync(nested)) collectPackages(nested, out);
}

/** Audit collected packages → grouped verdicts. First-party (workspace) packages are skipped. */
export function auditPackages(packages, policy, selfPackages = new Set()) {
  const groups = { allow: [], deny: [], flag: [], unknown: [] };
  const seen = new Set();
  for (const p of packages) {
    if (selfPackages.has(p.name)) continue; // first-party AGPL — exempt by construction
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(p.pkgJsonPath, "utf8"));
    } catch {
      pkg = {};
    }
    if (pkg.name && selfPackages.has(pkg.name)) continue;
    const key = `${p.name}@${pkg.version || "?"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    groups[classifyPackage(pkg, policy)].push({
      name: p.name,
      version: pkg.version || "?",
      license: resolveLicenseExpr(pkg) || "(none)",
    });
  }
  return groups;
}

// ------------------------------- CLI -------------------------------

function main(argv) {
  const report = argv.includes("--report");
  const envRoot = process.env.ROUTEKIT_PROJECT_ROOT;
  const root = envRoot && fs.existsSync(envRoot) ? path.resolve(envRoot) : process.cwd();
  const policyPath = path.join(root, ".routekit", "license-policy.yaml");
  if (!fs.existsSync(policyPath)) {
    console.error(`license policy not found: ${policyPath}`);
    process.exit(2);
  }
  const policy = loadPolicy(policyPath);
  const self = getSelfPackages(root);
  const groups = auditPackages(collectPackages(path.join(root, "node_modules")), policy, self);
  const total = groups.allow.length + groups.deny.length + groups.flag.length + groups.unknown.length;
  const line = (p) => `  ${p.name}@${p.version} — ${p.license}`;
  const sortByName = (a, b) => a.name.localeCompare(b.name);

  if (report) {
    console.log(`Dependency license report — ${total} third-party packages\n`);
    for (const v of ["deny", "flag", "unknown", "allow"]) {
      if (!groups[v].length) continue;
      console.log(`${v.toUpperCase()} (${groups[v].length}):`);
      for (const p of [...groups[v]].sort(sortByName)) console.log(line(p));
      console.log("");
    }
    process.exit(0);
  }

  if (groups.flag.length) {
    console.warn(`⚠️  ${groups.flag.length} FLAG (weak copyleft — review):`);
    for (const p of [...groups.flag].sort(sortByName)) console.warn(line(p));
  }
  if (groups.unknown.length) {
    console.warn(`⚠️  ${groups.unknown.length} UNKNOWN license — review:`);
    for (const p of [...groups.unknown].sort(sortByName)) console.warn(line(p));
  }
  const denied = policy.unknownIsDeny ? [...groups.deny, ...groups.unknown] : groups.deny;
  if (denied.length) {
    console.error(`\n❌ ${denied.length} DENIED (copyleft — blocked by license policy):`);
    for (const p of [...denied].sort(sortByName)) console.error(line(p));
    console.error(`\nDenied to keep the codebase re-licensable for the commercial/Pro surface.`);
    console.error(`See .routekit/license-policy.yaml — do NOT relax as "redundant with AGPL".`);
    process.exit(1);
  }
  const extra = groups.flag.length || groups.unknown.length ? ` (${groups.flag.length} flagged, ${groups.unknown.length} unknown — review)` : "";
  console.log(`✓ license gate passed — ${total} third-party deps, 0 denied${extra}`);
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "x").href) {
  main(process.argv.slice(2));
}
