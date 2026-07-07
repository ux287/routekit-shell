#!/usr/bin/env node
/**
 * sync-hooks.mjs — build-time script that keeps packages/hooks/ in sync with
 * .routekit/hooks/ (project) and templates/generic/.routekit/hooks/ (template seed).
 *
 * Usage:
 *   node scripts/sync-hooks.mjs          # sync packages/hooks → both destinations
 *   node scripts/sync-hooks.mjs --check  # exit 1 if templates/generic/.routekit/hooks diverges from packages/hooks
 *
 * --check compares against the template (not .routekit/hooks/) because .routekit/hooks/
 * has read/write tiers moved to .bak during off-rail dev sessions, making it unreliable
 * as a drift baseline.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function listFilesRecursive(dir, base = dir) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFilesRecursive(full, base));
    } else {
      result.push(path.relative(base, full));
    }
  }
  return result.sort();
}

export function syncHooks(src, dest) {
  function copyDir(s, d) {
    fs.mkdirSync(d, { recursive: true });
    for (const entry of fs.readdirSync(s, { withFileTypes: true })) {
      const sf = path.join(s, entry.name);
      const df = path.join(d, entry.name);
      if (entry.isDirectory()) copyDir(sf, df);
      else fs.copyFileSync(sf, df);
    }
  }
  copyDir(src, dest);
  return listFilesRecursive(src);
}

export function checkDrift(src, dest) {
  const srcFiles = listFilesRecursive(src);
  const destFiles = listFilesRecursive(dest);
  const srcSet = new Set(srcFiles);
  const destSet = new Set(destFiles);
  const issues = [];

  for (const f of srcFiles) {
    if (!destSet.has(f)) {
      issues.push(`missing from dest: ${f}`);
    } else {
      const srcContent = fs.readFileSync(path.join(src, f), "utf8");
      const destContent = fs.readFileSync(path.join(dest, f), "utf8");
      if (srcContent !== destContent) {
        issues.push(`content differs: ${f}`);
      }
    }
  }
  for (const f of destFiles) {
    if (!srcSet.has(f)) issues.push(`extra in dest (not in canonical): ${f}`);
  }

  return { ok: issues.length === 0, issues, srcCount: srcFiles.length, destCount: destFiles.length };
}

/**
 * Direction-STRICT reverse scan of a DEPLOYED hook tree against the canonical packages/hooks.
 * Iterates `dest` and flags ONLY:
 *   (a) a deployed hook with NO canonical `src` source  → ORPHAN (deployed-only)
 *   (b) a deployed hook whose content differs from `src` → content DRIFT
 * It deliberately does NOT flag canonical hooks that are MISSING from `dest`: during off-rail dev
 * the deployed `.routekit/hooks/` read/+write/ tiers are moved to `.bak`, so a partial deployed
 * tree is legitimate and must not red the check. (Canonical↔template completeness — including the
 * missing/extra direction — is covered separately by checkDrift(SRC, TEMPLATE_HOOKS).)
 *
 * This closes the historical blind spot where a deployed-only orphan in `.routekit/hooks/` was
 * invisible to `--check` (which previously compared only canonical↔template).
 */
export function checkOrphans(src, dest, { exclude = ["lib"] } = {}) {
  // Shared modules (e.g. lib/) are copied alongside hooks but are not tier hooks; exclude them
  // from the orphan/drift scan so they can evolve without tripping the guard.
  const inExcluded = (f) => exclude.some((seg) => f === seg || f.startsWith(seg + path.sep));
  const srcSet = new Set(listFilesRecursive(src).filter((f) => !inExcluded(f)));
  const destFiles = listFilesRecursive(dest).filter((f) => !inExcluded(f));
  const issues = [];
  for (const f of destFiles) {
    if (!srcSet.has(f)) {
      issues.push(`orphan (deployed-only, no packages/hooks source): ${f}`);
    } else {
      const s = fs.readFileSync(path.join(src, f), "utf8");
      const d = fs.readFileSync(path.join(dest, f), "utf8");
      if (s !== d) issues.push(`content drift (deployed != packages/hooks): ${f}`);
    }
  }
  return { ok: issues.length === 0, issues, destCount: destFiles.length };
}

const isMain = fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const SRC = path.join(ROOT, "packages", "hooks");
  const PROJECT_HOOKS = path.join(ROOT, ".routekit", "hooks");
  const TEMPLATE_HOOKS = path.join(ROOT, "templates", "generic", ".routekit", "hooks");

  if (process.argv.includes("--check")) {
    // (1) canonical↔template completeness (unchanged): missing/extra/drift, both directions.
    const templateDrift = checkDrift(SRC, TEMPLATE_HOOKS);
    // (2) direction-strict reverse-orphan + drift of the DEPLOYED trees. Closes the blind spot
    //     where a deployed-only orphan in .routekit/hooks/ was invisible. Off-rail .bak tolerant.
    const projectOrphans = checkOrphans(SRC, PROJECT_HOOKS);
    const templateOrphans = checkOrphans(SRC, TEMPLATE_HOOKS);
    const issues = [
      ...templateDrift.issues.map((i) => `[canonical↔template] ${i}`),
      ...projectOrphans.issues.map((i) => `[.routekit/hooks] ${i}`),
      ...templateOrphans.issues.map((i) => `[templates/generic/.routekit/hooks] ${i}`),
    ];
    if (issues.length > 0) {
      for (const issue of issues) console.error(`DRIFT: ${issue}`);
      process.exit(1);
    }
    console.log(`No drift or orphans. ${templateDrift.srcCount} canonical hooks match template + deployed .routekit/hooks (deployed-only orphans + drift also checked).`);
  } else {
    const copied1 = syncHooks(SRC, PROJECT_HOOKS);
    const copied2 = syncHooks(SRC, TEMPLATE_HOOKS);
    console.log(`Synced ${copied1.length} hooks → .routekit/hooks/`);
    console.log(`Synced ${copied2.length} hooks → templates/generic/.routekit/hooks/`);

    // Fresh-clone nudge: point the user at `npm run setup` when there's no .env yet.
    // TTY-gated so it never adds noise to CI or non-interactive teammate re-installs.
    if (process.stdout.isTTY && !fs.existsSync(path.join(ROOT, ".env"))) {
      console.log(
        "\n👉 Almost there — run `npm run setup` to finish onboarding" +
          " (creates .env, wires the MCP servers, builds the knowledge graph)."
      );
    }
  }
}
