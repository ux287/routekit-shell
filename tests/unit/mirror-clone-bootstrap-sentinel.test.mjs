import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureGovernorArtifacts } from "../../packages/cli/src/project/bootstrap.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SENTINEL = "__RKS_SOURCE_PROJECT__";
const PLACEHOLDER = "__PROJECT_ID__";
const MIRROR_ID = "routekit-shell";
// A SUPERSTRING of MIRROR_ID, modelled on live prose at .claude/skills/release/SKILL.md:116.
// It must survive verbatim: this is what rejects the blanket replacement AND the \b-regex variant.
const PROSE = "cd ../routekit-shell-release && git fetch origin --tags";

// THE FOUR VALUE-POSITION FORMS the sentinel actually occupies in the shipped skills tree.
// 36 matching lines across 13 SKILL.md files decompose into exactly these four (11 / 10 / 14 / 1).
// Forms 3 and 4 span 7 of the 13 files, so a fix scoped to form 1 alone would ship green against a
// one-form fixture and leave most of a cloner's skills broken.
const formShapes = (id) => [
  `for projectId ${id}`,
  `Replace ${PLACEHOLDER} with ${id}`,
  `projectId: '${id}'`,
  `projectId: "${id}"`,
];

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

// The fixture skill directory basename is DELIBERATELY `build`. `.claude/skills/build` is the one
// directory a governed exhaustive search scoped at `.claude/skills` silently prunes, and it is a
// real carrier of 4 sentinel occurrences (:36, :37, :48, :49). Modelling it keeps the trap in view.
const skillPath = (root) => path.join(root, ".claude", "skills", "build", "SKILL.md");

// One fixture line per form, shaped like the real skills rather than invented.
function skillBody(id) {
  return [
    "---",
    "name: build",
    "---",
    "",
    `You are a Build Governor for projectId ${id}. Read your prompt at`,
    `.rks/prompts/governor-build.md. Replace ${PLACEHOLDER} with ${id}`,
    "",
    `  mcp__rks__rks_preflight({ projectId: '${id}' })`,
    `Call rks_onboarder with { projectId: "${id}" } before starting.`,
    "",
    PROSE,
    "",
  ].join("\n");
}

// FIXTURE PRECONDITION — asserted, never assumed. A fixture that is not the shape it claims makes
// every downstream assertion vacuous, which is the same failure mode as the skip this story removes.
// NO BRANCH: the expected sentinel presence is COMPUTED from the shape, so neither arm can be
// silently skipped, and an unrecognised shape argument fails on the `token` assertion.
function assertShape(shellRoot, shape) {
  const token = { mirror: MIRROR_ID, upstream: SENTINEL }[shape];
  expect(token).toBeDefined();
  const src = fs.readFileSync(skillPath(shellRoot), "utf8");
  const missing = formShapes(token).filter((f) => !src.includes(f));
  expect(missing).toEqual([]);
  expect(src.includes(SENTINEL)).toBe(shape === "upstream");
  expect(src).toContain(PROSE);
  // The shellRoot-side identity carrier the chosen mechanism reads. Asserted present, because a
  // fixture without it would fail every case for a reason unrelated to the defect and make the RED
  // uninterpretable. `.rks` is a pruned basename — confirm by reading the file, never by a scoped
  // governed search.
  const idFile = path.join(shellRoot, ".rks", "project.json");
  expect(fs.existsSync(idFile)).toBe(true);
  expect(JSON.parse(fs.readFileSync(idFile, "utf8")).id).toBe(MIRROR_ID);
}

// The fixture shellRoot is WRITTEN, never copied from the ambient checkout. That is the whole
// point: the witness must behave identically upstream and on a mirror clone, so it may not read
// its own precondition off the tree it happens to be running in.
function makeShellRoot(shape) {
  const shellRoot = tmp(`rks-shell-${shape}-`);
  const token = { mirror: MIRROR_ID, upstream: SENTINEL }[shape];
  expect(token).toBeDefined();
  fs.mkdirSync(path.dirname(skillPath(shellRoot)), { recursive: true });
  fs.writeFileSync(skillPath(shellRoot), skillBody(token));
  fs.mkdirSync(path.join(shellRoot, ".rks", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(shellRoot, ".rks", "prompts", "governor-build.md"), "prompt\n");
  // The shell checkout's own identity. On a real mirror clone this file says `routekit-shell`,
  // which is exactly what publish already burned into the delivered skills.
  fs.writeFileSync(
    path.join(shellRoot, ".rks", "project.json"),
    JSON.stringify({ id: MIRROR_ID }, null, 2) + "\n",
  );
  assertShape(shellRoot, shape);
  return shellRoot;
}

function readChildSkill(projectRoot) {
  const p = skillPath(projectRoot);
  // EXECUTED-PATH EVIDENCE. Bootstrap must actually have produced the tree — a missing or empty
  // read would otherwise satisfy every negative assertion below.
  expect(fs.existsSync(p)).toBe(true);
  const src = fs.readFileSync(p, "utf8");
  expect(src.length).toBeGreaterThan(0);
  return src;
}

// Collect-then-assert-once: no bare expect inside a loop body, so the analyser's
// loop_only_assertion gate stays clean and a failure names EVERY form that missed, not just the
// first. NOTE: the leak check compares whole form strings, not the bare id, so PROSE — which holds
// the superstring `routekit-shell-release` — cannot false-positive.
function assertChildOwnsItsId(src, childId) {
  const missingForms = formShapes(childId).filter((f) => !src.includes(f));
  expect(missingForms).toEqual([]);
  const leakedForms = formShapes(MIRROR_ID).filter((f) => src.includes(f));
  expect(leakedForms).toEqual([]);
  expect(src).not.toContain(SENTINEL);
  expect(src).toContain(PLACEHOLDER); // two-token invariant — never substituted
  expect(src).toContain(PROSE); // scoped fix, not a blanket prose rewrite
}

// The unit under change, driven DIRECTLY. Exemplar:
// tests/integration/skill-distribution-invariants.test.mjs:319. Deliberately NOT via attachProject:
// ensurePackageScripts synthesises a package.json at bootstrap.mjs:923/:936 and runs at :1163,
// BEFORE runDependencyInstall at :1274, so the no-op guard at :1036 is unreachable and every call
// would spawn a real `npm install` (timeout 180000) plus real git subprocesses via
// ensureGitBootstrap at :1269. This test spawns nothing and touches no network.
function deliver(shellRoot, childId) {
  const projectRoot = tmp("rks-child-");
  ensureGovernorArtifacts({ projectRoot, projectId: childId, shellRoot });
  return readChildSkill(projectRoot);
}

describe("mirror-clone bootstrap — the sentinel is already spent", () => {
  it("mirror-shaped shellRoot delivers a child naming the CLONER's id, in all four forms", () => {
    assertChildOwnsItsId(deliver(makeShellRoot("mirror"), "cloner-mirror"), "cloner-mirror");
  });

  it("upstream-shaped shellRoot still substitutes, in all four forms", () => {
    // Own fixture, own project root, own id — independent of the mirror case.
    assertChildOwnsItsId(deliver(makeShellRoot("upstream"), "cloner-upstream"), "cloner-upstream");
  });

  it("a child id containing the source id as a substring is delivered VERBATIM, undoubled", () => {
    // The naive mirror-shaped fix is a second replacement pass keyed on the literal `routekit-shell`.
    // Any child id that CONTAINS the source id then doubles. Pinned here for the bootstrap path;
    // tests/unit/skill-projectid-substitution.test.mjs:103 pins the syncProject sibling.
    // assertChildOwnsItsId is NOT reused here: `for projectId routekit-shell-core` legitimately
    // contains `for projectId routekit-shell`, so its leak check would misfire on this id.
    const childId = "routekit-shell-core";
    const src = deliver(makeShellRoot("mirror"), childId);
    const missing = formShapes(childId).filter((f) => !src.includes(f));
    expect(missing).toEqual([]);
    expect(src).not.toContain("routekit-shell-core-core");
    expect(src).not.toContain("routekit-shell-corecore");
    expect(src).not.toContain(SENTINEL);
    expect(src).toContain(PLACEHOLDER);
    expect(src).toContain(PROSE);
  });

  it("warns instead of silently no-opping when the recovered identity matches nothing", () => {
    // AC (f). Returning success from a skills tree the function did not change is the same
    // "status not sourced from an observation" defect this story removes. The shellRoot below
    // records one identity but ships skills naming a DIFFERENT one and carries no sentinel, so
    // neither substitution path fires and nothing at all is written.
    const shellRoot = tmp("rks-shell-noid-");
    fs.mkdirSync(path.dirname(skillPath(shellRoot)), { recursive: true });
    fs.writeFileSync(skillPath(shellRoot), skillBody("some-unrelated-source"));
    fs.mkdirSync(path.join(shellRoot, ".rks"), { recursive: true });
    const idFile = path.join(shellRoot, ".rks", "project.json");
    fs.writeFileSync(idFile, JSON.stringify({ id: MIRROR_ID }, null, 2) + "\n");

    const projectRoot = tmp("rks-child-noid-");
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      ensureGovernorArtifacts({ projectRoot, projectId: "cloner-noid", shellRoot });
    } finally {
      console.warn = realWarn;
    }
    // Asserted on OBSERVED OUTPUT, never on a return value — the whole point is that the return
    // value looked like success while nothing happened.
    const joined = warnings.join("\n");
    expect(warnings.length).toBeGreaterThan(0);
    expect(joined).toContain(MIRROR_ID); // the identity it looked for
    expect(joined).toContain(idFile); // the file it read that identity from
  });

  it("does NOT warn when the skills tree holds no markdown to substitute", () => {
    // The AC (f) warning must be sourced from an observation that something was inspected and left
    // unchanged — not merely from two flags being false. An empty skills tree is a legitimate state,
    // and warning about skills that do not exist would be the same defect pointed the other way.
    const shellRoot = tmp("rks-shell-empty-");
    fs.mkdirSync(path.join(shellRoot, ".claude", "skills", "build"), { recursive: true });
    fs.mkdirSync(path.join(shellRoot, ".rks"), { recursive: true });
    fs.writeFileSync(
      path.join(shellRoot, ".rks", "project.json"),
      JSON.stringify({ id: MIRROR_ID }, null, 2) + "\n",
    );
    const projectRoot = tmp("rks-child-empty-");
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      ensureGovernorArtifacts({ projectRoot, projectId: "cloner-empty", shellRoot });
    } finally {
      console.warn = realWarn;
    }
    expect(warnings).toEqual([]);
  });

  it("still refuses to bootstrap a shell from itself, on mirror-shaped input too", () => {
    const shellRoot = makeShellRoot("mirror");
    // ensureGovernorArtifacts is SYNCHRONOUS — bootstrap.mjs throws, it does not reject, so
    // `rejects.toMatchObject` would silently never run. try/catch also proves the throw HAPPENED
    // rather than inferring it from an absent rejection.
    let caught = null;
    try {
      ensureGovernorArtifacts({ projectRoot: shellRoot, projectId: MIRROR_ID, shellRoot });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe("self_sync_refused");
  });

  it("the sentinel witness can no longer be silenced by a skip", () => {
    // AC (b). skipIf is the mechanism that turned this defect into a skipped test, so its absence
    // is the assertion. The `it.skip` entries in that file are separate, declared slow-subprocess
    // debt and are not what this guards.
    const src = fs.readFileSync(path.join(REPO_ROOT, "tests", "project-bootstrap.test.mjs"), "utf8");
    expect(src).not.toContain("skipIf");
    expect(src).not.toContain("sentinelSurvivesInSkills");
  });

  it("the four modelled forms still cover every value position in the shipped skills tree", () => {
    // ANTI-TOO-NARROW GUARD. If a fifth syntactic form ever lands in a skill this fails and the
    // fixture must grow — otherwise a phrase-scoped fix ships green against a stale fixture.
    // A plain fs walk, NOT a governed search: rks_exhaustive_search scoped at `.claude/skills`
    // prunes `.claude/skills/build` and reports 12 files / 32 matches when the truth is 13 / 36.
    // The membership assertion below names that file directly, which is the only safe form.
    const root = path.join(REPO_ROOT, ".claude", "skills");
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".md")) files.push(p);
      }
    };
    walk(root);
    expect(files).toContain(path.join(root, "build", "SKILL.md"));

    // Shape-agnostic: an upstream tree holds the sentinel, a mirror clone holds the resolved id.
    // Both are enumerated, so this case is non-vacuous on either tree shape and needs no branch.
    const recognisers = [...formShapes(SENTINEL), ...formShapes(MIRROR_ID)];
    const unmodelled = [];
    let seen = 0;
    for (const file of files) {
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const carriesId = line.includes(SENTINEL) || line.includes(MIRROR_ID);
          const isValuePosition = line.includes("projectId") || line.includes(PLACEHOLDER);
          if (!carriesId || !isValuePosition) return;
          seen += 1;
          if (!recognisers.some((r) => line.includes(r))) {
            unmodelled.push(`${path.relative(REPO_ROOT, file)}:${i + 1} ${line.trim()}`);
          }
        });
    }
    // POSITIVE CONTROL — a zero would make the sweep vacuous rather than clean.
    expect(seen).toBeGreaterThan(0);
    expect(unmodelled).toEqual([]);
  });

  it("ensureGovernorArtifacts still has exactly one invocation site, so one witness suffices", () => {
    // COVERAGE TRIPWIRE for AC (a2). `routekit project init` and `routekit project attach` are
    // covered by ONE unit-tier witness only because both funnel through the single invocation
    // inside attachProject. If init ever gains its own substitution path this FAILS, and whoever
    // adds it must add a second witness rather than silently under-covering.
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "packages", "cli", "src", "project", "bootstrap.mjs"),
      "utf8",
    );
    // Anchored at line start (after indentation) so a commented mention such as
    // `// calls ensureGovernorArtifacts(...)` cannot inflate the count, and comment/JSDoc lines are
    // excluded outright. A call site whose opening paren sits on the next line would be missed —
    // accepted, because that is not a shape this file uses and a stricter parse is not worth it here.
    const invocations = src
      .split("\n")
      .filter((l) => {
        const trimmed = l.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
        if (trimmed.startsWith("export function")) return false;
        return /^ensureGovernorArtifacts\s*\(/.test(trimmed);
      });
    expect(invocations).toHaveLength(1);
  });
});
