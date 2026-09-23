/**
 * backlog.fix.skill-distribution-invariants-harness
 *
 * WHAT THIS IS, AND WHY IT IS SHAPED THIS WAY
 *
 * The parent story (backlog.fix.skill-templates-wrong-projectid) was written five times as an
 * ENUMERATION: find every occurrence of a stale sentinel across the skills tree and edit it.
 * Its correctness therefore depended on the enumeration of substitution SITES being complete.
 * It was proven incomplete twice — a whole skill file (`ops`) was invisible to every sweep
 * because the sweeps were keyed to the VALUE `routekit-shell` and `ops` contains none of it,
 * and a fifth distribution site (the publish mirror) was invisible because its coupling is
 * declared in YAML and because `.routekit/` is pruned from the search tool.
 *
 * This harness is the inversion: it asserts on DELIVERED OUTPUT rather than on source text.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * INVARIANT CLASSIFICATION — READ THIS BEFORE CHANGING ANYTHING
 *
 * INVARIANT 3 is PRE-FIX DISCOVERY. It reds against the unfixed tree and names the work.
 * INVARIANTS 1, 2, 4 and 5 are POST-FIX CONSISTENCY CONTROLS. They are green against the
 * unfixed tree BY CONSTRUCTION, and that is correct, not a bug:
 *   - INV 1 cannot red pre-fix because `__RKS_SOURCE_PROJECT__` does not exist in the repo
 *     yet — the sentinel is introduced BY the fix.
 *   - INV 2 cannot red pre-fix because every distribution path runs an unanchored
 *     `routekit-shell` → id replace, so value and prose stay COREFERENT; and the mirror's
 *     own target id is literally `routekit-shell`.
 *   - INV 4 and 5 hold in the current tree already.
 *
 * A harness reporting 1/2/4/5 RED pre-fix is BROKEN. The red output is NOT the enumeration —
 * that claim was withdrawn. These are regression and completeness controls.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * REQUIREMENT A — EVERY DISTRIBUTION PATH IS DRIVEN AS REAL SHIPPED CODE.
 *
 * This is the single most important constraint in the file. A harness that reimplemented
 * `content.replace(/routekit-shell/g, id)`, or transcribed the shell scripts' `sed`/`perl`
 * into JS, would be testing a COPY of the logic and would go vacuous the moment production
 * diverged — which is precisely the defect class this harness exists to eliminate.
 *
 * Nothing below reimplements substitution. The JS paths are imported; the shell paths are
 * spawned.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * RESIDUAL RISKS — recorded by name, not papered over.
 *
 * (R1) The driven-path-set control derives production call sites from an AUTHORED DISJUNCTION
 *      of three forms (F1/F2/F3). A module reaching the skills tree by a FOURTH form — a path
 *      computed from config, an `fs.cp` of the whole `.claude` tree — is still not discovered.
 *      This control NARROWS the gap; it does not close it. The convergence claim is therefore
 *      stated at its true strength: "an existing DRIVEN path that stops substituting reds
 *      automatically, and so does a new skill file or a new skill directory." The broader
 *      "a sixth site added later reds automatically" is WITHDRAWN AS FALSE for an undriven path.
 *
 * (R2) The reads-but-does-not-deliver exemption list can in principle be widened to hide a
 *      genuinely DELIVERING module, and no automated check can distinguish "reads" from
 *      "delivers". The mitigation is that every entry carries a reason in source and is
 *      reviewer-visible.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ensureGovernorArtifacts } from "../../packages/cli/src/project/bootstrap.mjs";
import { syncProject } from "../../packages/cli/src/project/sync.mjs";
import { loadProjects } from "../../packages/cli/src/project/index.js";
import { normalizeExportIdentity } from "../../packages/mcp-rks/src/server/publish.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SPAWN_TIMEOUT = 30_000;

/** The shell's own registered id. */
const SHELL_ID = "routekit-shell-core";
/** The public mirror's registered id — the value the mirror's identity transform targets. */
const MIRROR_ID = "routekit-shell";
/**
 * Deliberately distinctive: shares no prefix with any real id, so a substitution residue
 * (`<id>-core`, `<id>-release`) is visually obvious in a failure message.
 */
const CHILD_ID = "zzz-synthetic-child";

// ── temp-tree bookkeeping ────────────────────────────────────────────────────────────────
const tempDirs = [];
function tmp(prefix) {
  const base = path.join(REPO_ROOT, "tests", ".tmp");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `${prefix}_`));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tempDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── fs walk — the corpus is DERIVED, never enumerated ─────────────────────────────────────
/**
 * Walk a delivered skills tree and return every `.md` file, relative-pathed.
 *
 * REQUIREMENT B: the corpus comes from an `fs` walk of the DELIVERED tree. It must never come
 * from a search tool — `rks_exhaustive_search` prunes any path segment named `build`, `dist`,
 * `node_modules`, `coverage`, `.git`, `.rks` or `.routekit` when it meets one mid-walk, and
 * that pruning caused BOTH of the parent story's proven misses.
 *
 * `backlog.fix.exhaustive-search-dotdir-silent-zero` made those prunes VISIBLE — the tool now
 * names each one in `skipped` and computes `exhaustive` instead of asserting it, so a pruned
 * scope can no longer masquerade as proven absence. That does NOT relax this requirement. A
 * disclosed prune is still a prune: the corpus would still be short the pruned subtrees, and
 * an invariant harness that has to notice a disclosure field and compensate is a harness that
 * can forget to. Derive from `fs`; the tool is for evidence, not for enumeration.
 *
 * It must never come from a hardcoded list either: `shellOnly` skills are excluded by the
 * production code's own manifest, so they are absent from the delivered set BY CONSTRUCTION
 * and need no exclusion list here.
 *
 * A NEW skill file or a NEW skill directory therefore enters the corpus automatically. That
 * is half of the convergence property.
 */
function walkSkillMarkdown(skillsRoot) {
  const out = [];
  if (!fs.existsSync(skillsRoot)) return out;
  const stack = [skillsRoot];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push({
          rel: path.relative(skillsRoot, full),
          abs: full,
          lines: fs.readFileSync(full, "utf8").split("\n"),
        });
      }
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// ── VALUE POSITION — rules V1 and V2, with NO fencing qualifier ───────────────────────────
/**
 * A "projectId VALUE position" is a place where the text supplies an ACTUAL project id, as
 * opposed to merely mentioning the word.
 *
 * THE FENCED-BLOCK QUALIFIER IS DELETED, AND THAT DELETION IS LOAD-BEARING. An earlier
 * definition required the occurrence to sit inside a fenced code block. `.claude/skills/ops/`
 * has ZERO fenced blocks in its 59 lines, so that definition matched ONE of its four
 * occurrences and would have let three ship broken. No tool-argument occurrence that requires
 * the fix sits in a fence anywhere in this corpus.
 *
 *   V1 (object-key form)      `projectId` `:` value — bare, or in '', "" or ``
 *   V2 (launch-directive form) `for projectId` value — optionally quoted
 *
 * CARVE-OUT: an angle-bracket value (`<projectId>`, `<id>`) is a documentation metavariable,
 * not a supplied id. Exempt. This is what correctly spares `release`'s and `telemetry`'s
 * `projectId: '<projectId>'` examples.
 *
 * CORRECTLY NOT MATCHED, and each for a structural reason rather than an exception:
 *   - prose reading "...with the target projectId" — `projectId` is line-final with no colon,
 *     and there is no `for projectId`;
 *   - `{ projectId, skipTour: true }` — object SHORTHAND; no colon follows `projectId`.
 */
/**
 * An id token may contain internal dots but must not absorb TRAILING punctuation.
 *
 * This is not a nicety. The first draft used `[A-Za-z0-9_.<>-]+`, which swallowed the sentence
 * period in `...for projectId __PROJECT_ID__. Your job is to...`, yielding the value
 * `__PROJECT_ID__.` — so the equality check missed it and INVARIANT 3 named THREE of `ops`'s
 * four occurrences instead of four. That is the same failure shape as the fenced-block
 * qualifier this definition replaced: a rule that matches most of a class and reports the
 * remainder as absent. The AC requiring all four be named is what caught it.
 */
const ID_TOKEN = "[A-Za-z0-9_<>-]+(?:\\.[A-Za-z0-9_<>-]+)*";
const V1_RE = new RegExp(`projectId\\s*:\\s*(?:'([^']*)'|"([^"]*)"|\`([^\`]*)\`|(${ID_TOKEN}))`, "g");
const V2_RE = new RegExp(`\\bfor\\s+projectId\\s+[\`'"]?(${ID_TOKEN})[\`'"]?`, "g");

function isMetavariable(value) {
  return /^<.*>$/.test(value);
}

/** Every projectId value position in a file, with the rule that matched and the exact line. */
function valuePositions(file) {
  const hits = [];
  file.lines.forEach((lineText, idx) => {
    for (const [rule, re] of [["V2", V2_RE], ["V1", V1_RE]]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lineText)) !== null) {
        const value = m.slice(1).find(g => g !== undefined);
        if (value === undefined || isMetavariable(value)) continue;
        hits.push({ file: file.rel, line: idx + 1, rule, value, text: lineText.trim() });
      }
    }
  });
  return hits;
}

/** `Replace <A> with <B>` clauses — the launch-directive resolution instruction. */
const REPLACE_RE = /Replace\s+(\S+)\s+with\s+([^\s,.]+)/g;
function replaceClauses(file) {
  const out = [];
  file.lines.forEach((lineText, idx) => {
    REPLACE_RE.lastIndex = 0;
    let m;
    while ((m = REPLACE_RE.exec(lineText)) !== null) {
      out.push({ file: file.rel, line: idx + 1, from: m[1], to: m[2], text: lineText.trim() });
    }
  });
  return out;
}

/** Prompt files a skill tells its Governor to read. */
const PROMPT_REF_RE = /\.rks\/prompts\/([A-Za-z0-9_.-]+\.md)/g;
function promptRefs(file) {
  const out = new Set();
  for (const lineText of file.lines) {
    PROMPT_REF_RE.lastIndex = 0;
    let m;
    while ((m = PROMPT_REF_RE.exec(lineText)) !== null) out.add(m[1]);
  }
  return [...out];
}

// ── the occurrence-level allowlist engine (B7) ────────────────────────────────────────────
/**
 * An allowlist entry excuses ONE occurrence, identified by its VERBATIM DELIVERED LINE.
 *
 * File-granular entries ("allow `routekit-shell` anywhere in release/SKILL.md") are
 * STRUCTURALLY IMPOSSIBLE here: `matchedText` must contain `foreignId` AND be strictly longer
 * than it, and an entry is consumed only where the delivered line equals `matchedText`
 * verbatim. A file-granular entry would blind the invariant to every other occurrence in that
 * file — which is exactly how the coreference-broken prose lines would have escaped.
 *
 * A DEAD entry — one matching nothing — is itself a failure, so the allowlist cannot rot.
 * If `matchedText` is found at a DIFFERENT line, the failure names the actual line. Drift is
 * loud by design.
 *
 * THIS CHILD AUTHORS NO REAL ENTRIES, and that is a ruling, not an oversight. Pre-migration,
 * `routekit-shell-release` is itself rewritten coreferently by every substitution path, so a
 * `release/SKILL.md` entry would match nothing and would RED under the dead-entry rule. For
 * the mirror, `routekit-shell` is the target's OWN id and so is never foreign. Entries become
 * live only once the sentinel moves — they belong to the migration story.
 */
function validateAllowlistEntry(entry, index) {
  const problems = [];
  const need = ["file", "line", "matchedText", "foreignId", "reason"];
  for (const k of need) {
    if (entry[k] === undefined || entry[k] === null || entry[k] === "") {
      problems.push(`entry[${index}] is missing required key "${k}" — bare-id and file-granular entries are not representable`);
    }
  }
  if (problems.length) return problems;
  if (!entry.matchedText.includes(entry.foreignId)) {
    problems.push(`entry[${index}] matchedText does not contain foreignId "${entry.foreignId}"`);
  }
  if (entry.matchedText.length <= entry.foreignId.length) {
    problems.push(`entry[${index}] matchedText is not strictly longer than foreignId — that is a bare-id entry wearing a costume`);
  }
  if (String(entry.reason).trim().length === 0) {
    problems.push(`entry[${index}] has an empty reason`);
  }
  return problems;
}

/**
 * APPLICABILITY, not suppression. An entry excuses an occurrence of a FOREIGN id; against a
 * target that OWNS that id there is no violation to excuse and never can be, so the entry is
 * INAPPLICABLE rather than dead. `routekit-shell` is foreign to every child target but is the
 * PUBLISH MIRROR'S OWN id — without this the three release entries would be reported DEAD on
 * the publish path alone. Applicability is decided ONLY by id ownership; every other control
 * (verbatim line match, line-drift, dead-entry, the strictly-longer matchedText rule) applies
 * in full on every path where the entry IS applicable.
 */
function applicableEntries(allowlist, foreignIds) {
  return allowlist.filter(e => foreignIds.includes(e.foreignId));
}

function applyAllowlist(violations, allowlist) {
  const errors = [];
  allowlist.forEach((e, i) => errors.push(...validateAllowlistEntry(e, i)));
  if (errors.length) return { remaining: violations, errors };

  const consumed = new Set();
  const remaining = violations.filter(v => {
    const idx = allowlist.findIndex((e, i) =>
      !consumed.has(i) && e.file === v.file && e.foreignId === v.foreignId && e.matchedText === v.text);
    if (idx === -1) return true;
    if (allowlist[idx].line !== v.line) {
      errors.push(
        `allowlist entry for "${allowlist[idx].matchedText}" in ${v.file} records line ${allowlist[idx].line} ` +
        `but the delivered occurrence is at line ${v.line} — line drift, update the entry`,
      );
    }
    consumed.add(idx);
    return false;
  });
  allowlist.forEach((e, i) => {
    if (!consumed.has(i)) {
      errors.push(`DEAD allowlist entry[${i}] — nothing in the delivered tree matches ${e.file} :: "${e.matchedText}". An allowlist that can rot is not a control.`);
    }
  });
  return { remaining, errors };
}

// ── the five driven distribution paths — REAL SHIPPED CODE, never a reimplementation ──────
const DRIVEN_PATHS = {
  bootstrap: "packages/cli/src/project/bootstrap.mjs",
  sync: "packages/cli/src/project/sync.mjs",
  "vendor-skills": "scripts/vendor-skills.sh",
  "vendor-rks": "scripts/vendor-rks.sh",
  publish: ".routekit/publish-profiles.yaml",
};

function deliverViaBootstrap() {
  const projectRoot = tmp("deliver-bootstrap");
  ensureGovernorArtifacts({ projectRoot, projectId: CHILD_ID, shellRoot: REPO_ROOT });
  return path.join(projectRoot, ".claude", "skills");
}

function deliverViaSync() {
  const projectRoot = tmp("deliver-sync");
  syncProject({ projectRoot, projectId: CHILD_ID, shellRoot: REPO_ROOT, refreshStamp: false });
  return path.join(projectRoot, ".claude", "skills");
}

/**
 * Both vendor scripts resolve the target's projectId from `.rks/project.json`, so the fixture
 * needs one. They are ALWAYS given an explicit target: `vendor-rks.sh`'s DEFAULT_TARGETS point
 * at real sibling projects on disk, and `vendor-skills.sh` falls back to the live registry —
 * an argv-less invocation from a test would write into real repositories.
 */
function makeVendorTarget(prefix) {
  const target = tmp(prefix);
  fs.mkdirSync(path.join(target, ".rks"), { recursive: true });
  fs.writeFileSync(
    path.join(target, ".rks", "project.json"),
    JSON.stringify({ projectId: CHILD_ID, id: CHILD_ID }, null, 2),
  );
  return target;
}

function deliverViaVendorScript(script, prefix) {
  const target = makeVendorTarget(prefix);
  const res = spawnSync("bash", [path.join(REPO_ROOT, script), target], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT,
    env: { ...process.env, ROUTEKIT_SHELL_ROOT: REPO_ROOT },
  });
  return { skillsRoot: path.join(target, ".claude", "skills"), res };
}

/**
 * The mirror export. `normalizeExportIdentity` makes TARGETED edits to six named files and
 * NEVER touches `.claude/skills` — so the mirror ships the skills tree byte-identical, and
 * the delivered id for that tree is whatever the source literals already say. The identity
 * pair comes from the profile, exactly as the production call site supplies it.
 */
function deliverViaPublish() {
  const tmpDir = tmp("deliver-publish");
  const destSkills = path.join(tmpDir, ".claude", "skills");
  fs.mkdirSync(path.dirname(destSkills), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, ".claude", "skills"), destSkills, { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "CLAUDE.md"), path.join(tmpDir, "CLAUDE.md"));
  const changed = normalizeExportIdentity(tmpDir, SHELL_ID, MIRROR_ID);
  return { skillsRoot: destSkills, changed };
}

// ── seeded registry (B2) ──────────────────────────────────────────────────────────────────
/**
 * `loadProjects` returns `[]` when the registry file is absent; `projects/index.jsonl` is
 * gitignored (twice) and CI never creates it. An unseeded INVARIANT 2 is therefore GREEN on
 * the author's machine and VACUOUS in CI — the empty set makes nothing foreign.
 *
 * NOTE the signature: `loadProjects(baseDir, opts)` is POSITIONAL. Passing `{ registryPath }`
 * as the sole argument overrides nothing — the object lands in `baseDir` and `opts` defaults
 * to `{}`. That mistake would reintroduce the vacuity by a different route.
 */
function seededRegistryIds() {
  const dir = tmp("registry-seed");
  const registryPath = path.join(dir, "index.jsonl");
  const seed = [
    { id: SHELL_ID, root: REPO_ROOT },
    { id: MIRROR_ID, root: "/nonexistent/mirror" },
    { id: "zzz-third-party", root: "/nonexistent/third" },
  ];
  fs.writeFileSync(registryPath, seed.map(r => JSON.stringify(r)).join("\n") + "\n");
  return loadProjects(dir, { registryPath }).map(p => p.id);
}

// ── delivered-tree fixtures, built once ───────────────────────────────────────────────────
let TARGETS;
let REGISTERED_IDS;

beforeAll(() => {
  REGISTERED_IDS = seededRegistryIds();

  const vendorSkills = deliverViaVendorScript(DRIVEN_PATHS["vendor-skills"], "deliver-vendor-skills");
  const vendorRks = deliverViaVendorScript(DRIVEN_PATHS["vendor-rks"], "deliver-vendor-rks");
  const publish = deliverViaPublish();

  TARGETS = [
    { path: "bootstrap", id: CHILD_ID, skillsRoot: deliverViaBootstrap() },
    { path: "sync", id: CHILD_ID, skillsRoot: deliverViaSync() },
    { path: "vendor-skills", id: CHILD_ID, skillsRoot: vendorSkills.skillsRoot, spawn: vendorSkills.res },
    { path: "vendor-rks", id: CHILD_ID, skillsRoot: vendorRks.skillsRoot, spawn: vendorRks.res },
    // The mirror's delivered id IS `routekit-shell` — the profile's identity `to`.
    { path: "publish", id: MIRROR_ID, skillsRoot: publish.skillsRoot },
  ];

  for (const t of TARGETS) {
    t.files = walkSkillMarkdown(t.skillsRoot);
  }
}, 120_000);

// ══════════════════════════════════════════════════════════════════════════════════════════
describe("distribution fixtures are real", () => {
  it("every driven path delivered a non-empty skills tree", () => {
    for (const t of TARGETS) {
      expect(t.files.length, `${t.path} delivered no skill markdown — the fixture proves nothing`).toBeGreaterThan(0);
    }
  });

  it("the two spawned scripts exited cleanly", () => {
    for (const t of TARGETS.filter(x => x.spawn)) {
      expect(t.spawn.error, `${t.path} spawn error`).toBeUndefined();
      expect(t.spawn.status, `${t.path} stderr: ${t.spawn.stderr}`).toBe(0);
    }
  });

  it("the four CHILD-delivery paths agree on the delivered file set", () => {
    // Sensitivity floor. These four read one source tree and vendor it to a CHILD project, so
    // they must agree. A path that silently drops a skill is a real defect.
    const childTargets = TARGETS.filter(t => t.path !== "publish");
    const sets = childTargets.map(t => new Set(t.files.map(f => f.rel)));
    const [first, ...rest] = sets;
    for (let i = 0; i < rest.length; i++) {
      const missing = [...first].filter(r => !rest[i].has(r));
      const extra = [...rest[i]].filter(r => !first.has(r));
      expect(
        { missing, extra },
        `${childTargets[i + 1].path} delivered a different file set than ${childTargets[0].path}`,
      ).toEqual({ missing: [], extra: [] });
    }
  });

  it("the MIRROR is a superset of a child, and the difference is exactly the shellOnly set", () => {
    /**
     * The mirror is NOT a child, and conflating the two is a category error this test exists to
     * keep straight. The four code paths vendor to a CHILD project, where `shellOnly` skills
     * (`promote`) are correctly withheld — they are excluded by the production code's own
     * manifest. The publish profile's `.claude/skills/**` glob has no such exclusion because
     * the mirror is the SHELL's own public face, so it legitimately carries the full set.
     *
     * Asserting sameness here would have been wrong. Asserting the RELATIONSHIP keeps the
     * check honest in both directions: the mirror dropping a skill reds, and a NEW shellOnly
     * skill appearing reds too, because the difference is pinned to what the production
     * manifest actually withholds rather than to a hardcoded name.
     */
    const child = TARGETS.find(t => t.path === "bootstrap");
    const mirror = TARGETS.find(t => t.path === "publish");
    const childSet = new Set(child.files.map(f => f.rel));
    const mirrorSet = new Set(mirror.files.map(f => f.rel));

    const droppedByMirror = [...childSet].filter(r => !mirrorSet.has(r));
    expect(droppedByMirror, "the mirror dropped a skill the child receives — the mirror must be a superset").toEqual([]);

    // The extra files must be exactly the skills the production exclusion manifest withholds.
    const extra = [...mirrorSet].filter(r => !childSet.has(r));
    const extraSkills = [...new Set(extra.map(r => r.split(path.sep)[0]))].sort();
    const sourceSkills = fs
      .readdirSync(path.join(REPO_ROOT, ".claude", "skills"), { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
    const withheldFromChild = sourceSkills.filter(n => !childSet.has(path.join(n, "SKILL.md"))).sort();

    expect(
      extraSkills,
      "the mirror/child difference is not exactly the set the production manifest withholds from children",
    ).toEqual(withheldFromChild);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
describe("INVARIANT 1 — no unresolved sentinel survives into delivered output", () => {
  // POST-FIX CONSISTENCY CONTROL. Green pre-fix by construction: `__RKS_SOURCE_PROJECT__`
  // does not exist in the repo until the migration introduces it.
  const SENTINEL = "__RKS_SOURCE_PROJECT__";

  it.each(["bootstrap", "sync", "vendor-skills", "vendor-rks", "publish"])(
    "%s delivers no unresolved sentinel",
    (pathName) => {
      const t = TARGETS.find(x => x.path === pathName);
      const violations = [];
      for (const f of t.files) {
        f.lines.forEach((text, i) => {
          if (text.includes(SENTINEL)) violations.push(`${f.rel}:${i + 1}: ${text.trim()}`);
        });
      }
      expect(violations, `${pathName} shipped an unsubstituted sentinel into delivered output`).toEqual([]);
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════════
describe("INVARIANT 2 — no FOREIGN registered projectId survives into delivered output", () => {
  // POST-FIX CONSISTENCY CONTROL. Green pre-fix because every path runs an unanchored
  // `routekit-shell` → id replace, keeping value and prose coreferent, and because the
  // mirror's own id IS `routekit-shell`.

  /**
   * THE THREE REAL ENTRIES — LIVE ONLY NOW. Pre-migration every substitution path rewrote
   * `routekit-shell-release` coreferently, so nothing foreign survived and these entries would
   * have been DEAD. After the sentinel move they survive VERBATIM in the delivered tree while
   * `routekit-shell` remains a registered id (the mirror), so they are live and REQUIRED.
   *
   * These are FILESYSTEM NAMES — a sibling release WORKTREE directory — not projectId values.
   * They are correctly byte-identical in every child; rewriting them would name a directory
   * that does not exist.
   *
   * `line` and `matchedText` are RE-DERIVED FROM THE DELIVERED TREE, never from a note. Adding
   * the CLAUDE.md-resolution sentence shifted all three down by two lines (114/118/120 →
   * 116/120/122); line drift reds naming the actual line, which is deliberate.
   *
   * NO ENTRY EXISTS FOR ops/SKILL.md, and none may ever be authored: ops is FIXED, not
   * allowlisted. `tools/routekit-shell` is a PHANTOM (0 matches) — no entry from it either.
   */
  const ALLOWLIST = [
    {
      file: "release/SKILL.md",
      line: 116,
      matchedText: "cd ../routekit-shell-release && git fetch origin --tags && git checkout -f v<new-version>",
      foreignId: "routekit-shell",
      reason:
        "filesystem path to the sibling release WORKTREE directory, not a projectId value; " +
        "substituting it would name a directory that does not exist in the child",
    },
    {
      file: "release/SKILL.md",
      line: 120,
      matchedText: "routekit project upgrade --all --from-release ../routekit-shell-release",
      foreignId: "routekit-shell",
      reason:
        "filesystem path to the sibling release worktree passed to --from-release; it is a " +
        "directory name on the release operator's machine, not the child's identity",
    },
    {
      file: "release/SKILL.md",
      line: 122,
      matchedText:
        "`--from-release` sources the release's hooks/skills/prompts/version while still resolving children from your normal registry; it repins each child's `.mcp.json` and stamps its `rksVersion`. (For a single child: `routekit project upgrade --id <child> --from-release ../routekit-shell-release`.)",
      foreignId: "routekit-shell",
      reason:
        "prose documenting the same --from-release worktree path; the occurrence is a directory " +
        "name inside a command example, not a projectId value",
    },
  ];

  it("the registered-id set is NON-EMPTY before any membership check", () => {
    // Without this floor, an absent registry yields [] and the whole invariant passes
    // vacuously — green locally, meaningless in CI. This is the enumeration floor.
    expect(REGISTERED_IDS.length, "seeded registry produced no ids — INVARIANT 2 would be vacuous").toBeGreaterThan(0);
    expect(REGISTERED_IDS).toContain(MIRROR_ID);
    expect(REGISTERED_IDS).toContain(SHELL_ID);
  });

  it.each(["bootstrap", "sync", "vendor-skills", "vendor-rks", "publish"])(
    "%s delivers no foreign registered id",
    (pathName) => {
      const t = TARGETS.find(x => x.path === pathName);
      expect(REGISTERED_IDS.length).toBeGreaterThan(0);
      const foreign = REGISTERED_IDS.filter(id => id !== t.id);
      const violations = [];
      for (const f of t.files) {
        f.lines.forEach((text, i) => {
          for (const id of foreign) {
            if (text.includes(id)) {
              violations.push({ file: f.rel, line: i + 1, foreignId: id, text: text.trim() });
            }
          }
        });
      }
      const { remaining, errors } = applyAllowlist(violations, applicableEntries(ALLOWLIST, foreign));
      expect(errors, `${pathName} allowlist is malformed or has rotted`).toEqual([]);
      expect(
        remaining.map(v => `${v.file}:${v.line} [${v.foreignId}] ${v.text}`),
        `${pathName} delivered a projectId belonging to a DIFFERENT registered project`,
      ).toEqual([]);
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════════
describe("INVARIANT 3 — the placeholder survives where it must, and never occupies a VALUE position", () => {
  // THE ONLY PRE-FIX DISCOVERY INVARIANT. Against the unfixed tree its value-position half
  // reds and names `.claude/skills/ops/SKILL.md` — all FOUR occurrences, not one.
  const PLACEHOLDER = "__PROJECT_ID__";

  it.each(["bootstrap", "sync", "vendor-skills", "vendor-rks", "publish"])(
    "%s: the placeholder never occupies a projectId VALUE position",
    (pathName) => {
      const t = TARGETS.find(x => x.path === pathName);
      const violations = [];
      for (const f of t.files) {
        for (const hit of valuePositions(f)) {
          if (hit.value === PLACEHOLDER) {
            violations.push(`${hit.file}:${hit.line} [${hit.rule}] ${hit.text}`);
          }
        }
      }
      expect(
        violations,
        `${pathName} delivered ${PLACEHOLDER} in a projectId VALUE position — the receiving ` +
        `Governor has nothing to resolve it against, so the id is unresolvable at runtime`,
      ).toEqual([]);
    },
  );

  it.each(["bootstrap", "sync", "vendor-skills", "vendor-rks", "publish"])(
    "%s: the placeholder SURVIVES wherever a Replace clause names it",
    (pathName) => {
      const t = TARGETS.find(x => x.path === pathName);
      const broken = [];
      for (const f of t.files) {
        const clauses = replaceClauses(f);
        if (!clauses.some(c => c.from === PLACEHOLDER)) continue;
        const body = f.lines.join("\n");
        if (!body.includes(PLACEHOLDER)) {
          broken.push(`${f.rel} names ${PLACEHOLDER} in a Replace clause but the token was destroyed in delivery`);
        }
      }
      expect(broken, `${pathName} destroyed a placeholder its own instruction depends on`).toEqual([]);
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════════
describe("INVARIANT 4b — the sentinel is never used in MENTION position in the SOURCE tree", () => {
  /**
   * THE MENTION-FREE RULE, and why it needs its own control.
   *
   * The sentinel does TWO incompatible things if it is allowed into prose. In VALUE position
   * (`for projectId __RKS_SOURCE_PROJECT__`) it is data to be resolved. In MENTION position
   * ("if the projectId is still the raw sentinel `__RKS_SOURCE_PROJECT__` ...") it is the NAME
   * of a token being talked about — and substitution CANNOT TELL THE TWO APART. It rewrites the
   * mention too, so the child receives "still the raw sentinel `my-child-app`": a tautology
   * naming a raw sentinel that no longer appears anywhere in the delivered file.
   *
   * That defect is INVISIBLE to the delivered-tree invariants. INVARIANT 1 sees no unresolved
   * sentinel (it WAS substituted), and INVARIANT 4 sees no `Replace X with X`. It is detectable
   * only in the SOURCE, and only structurally: a legitimate sentinel occurrence is always in a
   * projectId VALUE position under V1/V2. Anything else is a mention.
   *
   * Derived, not enumerated: the file set is fs-walked and the rule is the same V1/V2 machinery
   * INVARIANT 3 uses. No file list, no line number, no count.
   */
  const SENTINEL = "__RKS_SOURCE_PROJECT__";

  it("every sentinel occurrence in the source skills tree sits in a projectId VALUE position", () => {
    const sourceFiles = walkSkillMarkdown(path.join(REPO_ROOT, ".claude", "skills"));
    expect(sourceFiles.length, "no source skill files walked — this control would be vacuous").toBeGreaterThan(0);

    const carrying = sourceFiles.filter(f => f.lines.some(l => l.includes(SENTINEL)));
    expect(
      carrying.length,
      "no source skill carries the sentinel — the migration is absent and this control is vacuous",
    ).toBeGreaterThan(0);

    const mentions = [];
    for (const f of carrying) {
      const valueLines = new Map();
      for (const hit of valuePositions(f)) {
        if (hit.value === SENTINEL) valueLines.set(hit.line, (valueLines.get(hit.line) || 0) + 1);
      }
      f.lines.forEach((text, idx) => {
        const occurrences = text.split(SENTINEL).length - 1;
        if (occurrences === 0) return;
        // A `Replace __PROJECT_ID__ with __RKS_SOURCE_PROJECT__` clause is the TRAILING clause of
        // a launch directive: the sentinel there is the VALUE the placeholder resolves to, so it
        // is a value use, not a mention.
        const inReplaceClause = replaceClauses({ rel: f.rel, lines: [text] })
          .filter(c => c.to === SENTINEL).length;
        const accounted = (valueLines.get(idx + 1) || 0) + inReplaceClause;
        if (occurrences > accounted) {
          mentions.push(`${f.rel}:${idx + 1} ${text.trim()}`);
        }
      });
    }

    expect(
      mentions,
      "the sentinel appears in MENTION position in a source skill. Substitution rewrites mentions " +
      "exactly as it rewrites values, so the child receives a self-defeating sentence naming a " +
      "sentinel that is no longer present. Reword it mention-free.",
    ).toEqual([]);
  });
});

describe("INVARIANT 4 — no self-referential Replace clause", () => {
  // POST-FIX CONSISTENCY CONTROL, and the flagship guard against the design that aborted a
  // build: collapsing the sentinel and the placeholder into ONE token makes every launch
  // directive read `Replace <id> with <id>` in every child. Asserted GENERICALLY over the
  // substituted id — never against a hardcoded string, which would only catch one target.
  it.each(["bootstrap", "sync", "vendor-skills", "vendor-rks", "publish"])(
    "%s delivers no `Replace X with X`",
    (pathName) => {
      const t = TARGETS.find(x => x.path === pathName);
      const violations = [];
      for (const f of t.files) {
        for (const c of replaceClauses(f)) {
          if (c.from === c.to) violations.push(`${c.file}:${c.line} ${c.text}`);
        }
      }
      expect(
        violations,
        `${pathName} delivered a self-referential instruction — one token was made to do two jobs`,
      ).toEqual([]);
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════════
describe("INVARIANT 5 — a Replace clause's referent exists in the DELIVERED prompt", () => {
  // POST-FIX CONSISTENCY CONTROL. `Replace <A> with <B>` is an instruction to find <A> inside
  // the prompt file the clause names. If <A> is absent from the DELIVERED prompt, the
  // instruction is unfollowable — which is what happens if a substitution site is ever
  // widened to cover `.rks/prompts/`.
  it.each(["bootstrap", "sync", "vendor-skills", "vendor-rks"])(
    "%s: every Replace referent is present in the prompt the clause names",
    (pathName) => {
      const t = TARGETS.find(x => x.path === pathName);
      const promptsDir = path.join(t.skillsRoot, "..", "..", ".rks", "prompts");
      const broken = [];
      for (const f of t.files) {
        const refs = promptRefs(f);
        if (refs.length === 0) continue;
        for (const c of replaceClauses(f)) {
          const found = refs.some(r => {
            const p = path.join(promptsDir, r);
            return fs.existsSync(p) && fs.readFileSync(p, "utf8").includes(c.from);
          });
          if (!found) {
            broken.push(`${c.file}:${c.line} instructs "Replace ${c.from}" but ${c.from} is in none of [${refs.join(", ")}]`);
          }
        }
      }
      expect(broken, `${pathName} delivered an unfollowable resolution instruction`).toEqual([]);
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════════
describe("CONVERGENCE — the driven-path set is itself derived, not trusted", () => {
  /**
   * B5. The claim, at its TRUE strength: an existing DRIVEN path that stops substituting reds
   * automatically, and so does a new skill file or a new skill directory. The broader claim —
   * "a sixth site added later reds automatically" — is WITHDRAWN AS FALSE for an UNDRIVEN
   * path, because an undriven path is never walked. See R1.
   *
   * A single literal grep is PROVABLY insufficient: `bootstrap.mjs` — the PRIMARY distribution
   * site — contains no literal `.claude/skills` string. It reaches the tree through
   * `path.join(shellRoot, ".claude", "skills")`. That is the mechanism that hid distribution
   * sites from five review passes.
   */
  const SEARCH_ROOTS = ["packages", "scripts"];

  function walkSource(root) {
    const out = [];
    const stack = [path.join(REPO_ROOT, root)];
    while (stack.length) {
      const dir = stack.pop();
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && /\.(mjs|js|sh)$/.test(entry.name)) out.push(full);
      }
    }
    return out;
  }

  /**
   * Reads or classifies the skills tree but never DELIVERS the shell's skills to a target.
   * Every entry carries its reason (R2: no automated check can distinguish reads from
   * delivers, so these are reviewer-visible by design).
   */
  const EXEMPT = {
    "packages/cli/src/plugin/loader.mjs": "installs PLUGIN-supplied skills into a project; does not distribute the shell's own skills tree",
    "packages/cli/src/plugin/manifest-schema.mjs": "schema doc comment only; no filesystem delivery",
    "packages/mcp-rks/src/server/preflight.mjs": "reads skill presence for a health check; error strings only",
    "packages/mcp-rks/src/shared/skills-manifest.mjs": "resolves skill presence/exclusions; read-only",
    "packages/rag/src/source-classifier.mjs": "classifies a path for indexing; read-only",
    "scripts/setup.mjs": "restores skills from git in-place; never targets another project",
  };

  /**
   * Modules that IMPLEMENT a driven path rather than DECLARING it.
   *
   * SITE 5's coupling is declared in `.routekit/publish-profiles.yaml` — which is what
   * DRIVEN_PATHS.publish names — but the delivery itself is performed by
   * `normalizeExportIdentity` in publish.mjs, which this harness DRIVES DIRECTLY in
   * `deliverViaPublish()`. It began reaching the skills tree when the sentinel moved: without
   * that rewrite the mirror would ship the raw token across every delivered skill.
   *
   * These are DRIVEN, not EXEMPT. The distinction matters: an exemption asserts "this module
   * only reads", which would be false here and would hide a real delivery site.
   */
  const DRIVEN_IMPLEMENTATIONS = {
    "packages/mcp-rks/src/server/publish.mjs":
      "performs SITE 5 delivery via normalizeExportIdentity; driven directly by deliverViaPublish()",
  };

  it("F1 ∪ F2 ∪ F3 minus reasoned exemptions equals the driven set", () => {
    const f1 = new Set();
    const f2 = new Set();
    for (const root of SEARCH_ROOTS) {
      for (const abs of walkSource(root)) {
        const rel = path.relative(REPO_ROOT, abs);
        const lines = fs.readFileSync(abs, "utf8").split("\n");
        for (const line of lines) {
          if (line.includes(".claude/skills")) f1.add(rel);
          if (line.includes('".claude"') && line.includes('"skills"')) f2.add(rel);
        }
      }
    }

    // F3 — SITE 5's coupling is declared in YAML, not code. No code walk can find it.
    const f3 = new Set();
    const profiles = path.join(REPO_ROOT, ".routekit", "publish-profiles.yaml");
    if (fs.existsSync(profiles)) {
      for (const line of fs.readFileSync(profiles, "utf8").split("\n")) {
        if (/^\s*-\s*"?\.claude\/skills/.test(line)) f3.add(path.relative(REPO_ROOT, profiles));
      }
    }

    // F2 must be doing real work — this is what proves a literal-only rule is insufficient.
    expect(
      f2.has(DRIVEN_PATHS.bootstrap),
      "bootstrap.mjs must be discovered by F2; if this fails the segmented-path form changed and a literal-only rule would now silently miss the primary distribution site",
    ).toBe(true);
    expect(
      f1.has(DRIVEN_PATHS.bootstrap),
      "bootstrap.mjs is expected to be ABSENT from F1 — it has no literal `.claude/skills`. If it now appears, F2's justification needs restating, not deleting",
    ).toBe(false);
    expect(f3.size, "F3 found no skills include glob in the publish profile — SITE 5 would be invisible").toBeGreaterThan(0);

    const discovered = new Set([...f1, ...f2, ...f3]);
    const unexplained = [...discovered].filter(
      p => !EXEMPT[p] && !DRIVEN_IMPLEMENTATIONS[p] && !Object.values(DRIVEN_PATHS).includes(p),
    );

    expect(
      unexplained,
      "a module reaches the skills tree but is neither DRIVEN by this harness nor EXEMPTED with a reason. " +
      "Either drive it (it distributes skills) or exempt it with a justification (it only reads).",
    ).toEqual([]);

    for (const [, p] of Object.entries(DRIVEN_PATHS)) {
      expect(discovered.has(p), `driven path ${p} was not rediscovered by F1/F2/F3 — the discovery rule has drifted from reality`).toBe(true);
    }

    // Same liveness rule the exemptions carry: a driven-implementation entry that no longer
    // reaches the skills tree is stale, and a stale entry is a place for a defect to hide.
    for (const impl of Object.keys(DRIVEN_IMPLEMENTATIONS)) {
      expect(
        discovered.has(impl),
        `driven implementation ${impl} no longer reaches the skills tree — remove the entry or restore the delivery`,
      ).toBe(true);
    }
  });

  it("every exemption is live — a stale exemption is a place for a defect to hide", () => {
    // R2's mitigation: the list cannot silently accumulate entries for files that no longer
    // reach the skills tree.
    const present = [];
    for (const root of SEARCH_ROOTS) {
      for (const abs of walkSource(root)) {
        const rel = path.relative(REPO_ROOT, abs);
        if (!EXEMPT[rel]) continue;
        const body = fs.readFileSync(abs, "utf8");
        if (body.includes(".claude/skills") || /".claude".*"skills"|"skills".*".claude"/.test(body)) present.push(rel);
      }
    }
    expect(
      Object.keys(EXEMPT).filter(k => !present.includes(k)),
      "exemption entries that no longer reach the skills tree — remove them",
    ).toEqual([]);
  });
});
