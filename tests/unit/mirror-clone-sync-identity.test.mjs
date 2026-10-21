/**
 * Witness for backlog.fix.mirror-clone-sync-reverts-child-skill-identity.
 *
 * THE DEFECT: `syncProject` substituted only the source-project sentinel. On a published-mirror
 * clone that sentinel is already spent — publish resolves it to the literal public id across the
 * delivered skills tree — so the replacement matched nothing, and a child that bootstrapped
 * CORRECTLY had its skills reverted to source-project names by the next `project sync` or
 * `project upgrade`. The v0.50.3 fix to the bootstrap path was silently undone in the same
 * user journey.
 *
 * There is no conditional execution in this file: every case runs on every tree shape. The guard
 * below asserts that, because the sibling defect this pair closes was hidden for months by a test
 * that SKIPPED on precisely the tree where it should have failed.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncProject } from "../../packages/cli/src/project/sync.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SENTINEL = "__RKS_SOURCE" + "_PROJECT__";
const PLACEHOLDER = "__PROJECT" + "_ID__";
const MIRROR_ID = "routekit-shell";

// PROSE_A is LIVE prose: a verbatim prefix of a command line in the release skill. It is a
// SUPERSTRING of MIRROR_ID, so a \b word boundary does not protect it (`-` is a non-word char).
// It must survive verbatim — this is what rejects a blanket id replacement.
const PROSE_A = "cd ../routekit-shell-release && git fetch origin --tags";
// PROSE_B is a SYNTHESISED superstring probe, not live prose. Do not "repair" this fixture by
// hunting for it in the shipped corpus — it was never there.
const PROSE_B = "routekit-shell-release is the checkout, routekit-shellx is not";

const forms = (id) => [
  `for projectId ${id}`,
  `Replace ${PLACEHOLDER} with ${id}`,
  `projectId: '${id}'`,
  `projectId: "${id}"`,
];
const presentForms = (content, id) => forms(id).filter((f) => content.includes(f));

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

// The fixture skill dir basename is DELIBERATELY `build` — the one directory a governed
// exhaustive search scoped at .claude/skills silently prunes, and a real carrier of sentinel
// occurrences. Modelling it keeps the trap in view.
const skillPath = (root) => path.join(root, ".claude", "skills", "build", "SKILL.md");

function skillBody(id) {
  return [
    "---", "name: build", "---", "",
    `You are a Build Governor for projectId ${id}. Read your prompt at`,
    `.rks/prompts/governor-build.md. Replace ${PLACEHOLDER} with ${id}`,
    "",
    `  mcp__rks__rks_preflight({ projectId: '${id}' })`,
    `Call rks_onboarder with { projectId: "${id}" } before starting.`,
    "", PROSE_A, PROSE_B, "",
  ].join("\n");
}

/** Fixture precondition, ASSERTED. A fixture that is not the shape it claims makes every
 *  downstream assertion vacuous — the same failure mode as the skip this file forbids. */
function assertShape(shellRoot, shape) {
  const token = { mirror: MIRROR_ID, upstream: SENTINEL }[shape];
  const wrong = [];
  if (!token) wrong.push(`unknown shape ${shape}`);
  const src = fs.readFileSync(skillPath(shellRoot), "utf8");
  for (const f of forms(token)) if (!src.includes(f)) wrong.push(`missing form: ${f}`);
  if (src.includes(SENTINEL) !== (shape === "upstream")) wrong.push("sentinel presence wrong");
  if (!src.includes(PROSE_A)) wrong.push("PROSE_A missing");
  const idFile = path.join(shellRoot, ".rks", "project.json");
  if (!fs.existsSync(idFile)) wrong.push("shell identity file missing");
  else if (JSON.parse(fs.readFileSync(idFile, "utf8")).id !== MIRROR_ID) wrong.push("shell id wrong");
  expect(wrong).toEqual([]);
}

function makeShellRoot(shape, { identity = MIRROR_ID } = {}) {
  const shellRoot = tmp(`rks-sync-shell-${shape}-`);
  const token = { mirror: MIRROR_ID, upstream: SENTINEL }[shape];
  fs.mkdirSync(path.dirname(skillPath(shellRoot)), { recursive: true });
  fs.writeFileSync(skillPath(shellRoot), skillBody(token));
  fs.mkdirSync(path.join(shellRoot, ".rks"), { recursive: true });
  fs.writeFileSync(
    path.join(shellRoot, ".rks", "project.json"),
    JSON.stringify({ id: identity }, null, 2) + "\n",
  );
  if (identity === MIRROR_ID) assertShape(shellRoot, shape);
  return shellRoot;
}

function sync(shellRoot, projectId) {
  const projectRoot = tmp("rks-sync-child-");
  syncProject({ projectRoot, projectId, shellRoot, refreshStamp: false });
  const p = skillPath(projectRoot);
  expect(fs.existsSync(p)).toBe(true); // executed-path evidence
  const src = fs.readFileSync(p, "utf8");
  expect(src.length).toBeGreaterThan(0);
  return src;
}

describe("no case in this file can be silenced by a skip", () => {
  it("declares no conditional-execution construct", () => {
    // Split so the array does not contain the tokens it searches for. A red here must NOT be
    // repaired by deleting this guard or asserting a nonzero length — a guard that cannot fail
    // is the defect class this pair of stories exists to close. Note the no-whole-tokens rule
    // binds the prose too: the scan reads this entire file, comments included.
    const self = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    const banned = [
      "it.sk" + "ip(",
      "test.sk" + "ip(",
      "describe.sk" + "ip(",
      ".skip" + "If(",
      "it.to" + "do(",
    ];
    const found = banned.filter((b) => self.includes(b));
    expect(found).toEqual([]);
  });
});

describe("syncProject on a mirror-shaped shell", () => {
  it("delivers a child naming the CLONER's id in all four forms, not the source project", () => {
    const src = sync(makeShellRoot("mirror"), "my-child-app");
    expect(presentForms(src, "my-child-app")).toEqual(forms("my-child-app"));
    // The discriminating assertion: pre-fix all four MIRROR_ID forms survive into the child.
    expect(presentForms(src, MIRROR_ID)).toEqual([]);
    expect(src).not.toContain(SENTINEL);
    expect(src).toContain(PLACEHOLDER); // two-token invariant
    expect(src).toContain(PROSE_A); // scoped fix, not a blanket prose rewrite
    expect(src).toContain(PROSE_B);
  });

  it("still substitutes on an upstream-shaped shell, where the sentinel survives", () => {
    const src = sync(makeShellRoot("upstream"), "my-child-app");
    expect(presentForms(src, "my-child-app")).toEqual(forms("my-child-app"));
    expect(src).not.toContain(SENTINEL);
    expect(src).toContain(PLACEHOLDER);
    expect(src).toContain(PROSE_A);
  });

  it("delivers a child id that CONTAINS the source id verbatim, undoubled", () => {
    // presentForms(MIRROR_ID) is deliberately NOT used here: `for projectId routekit-shell` is a
    // strict prefix of `for projectId routekit-shell-core`, so it would false-positive on correct
    // output. The doubling checks below are the discriminators for this case.
    const childId = "routekit-shell-core";
    const src = sync(makeShellRoot("mirror"), childId);
    expect(presentForms(src, childId)).toEqual(forms(childId));
    expect(src).not.toContain("routekit-shell-core-core");
    expect(src).not.toContain("routekit-shell-corecore");
    expect(src).not.toContain(SENTINEL);
    expect(src).toContain(PROSE_A);
  });

  it("is a strict no-op when the shell identity equals the child id, and does NOT warn", () => {
    // Covered by no pre-existing test: every existing syncProject fixture omits .rks/project.json
    // entirely, so the fallback never arms there. Nothing is substituted here and that is CORRECT
    // — the tree already names this child, because this child IS the source project. A warning
    // would be the same false status as the silent no-op, pointed the other way.
    const shellRoot = makeShellRoot("mirror");
    const projectRoot = tmp("rks-sync-child-noop-");
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      syncProject({ projectRoot, projectId: MIRROR_ID, shellRoot, refreshStamp: false });
    } finally {
      console.warn = realWarn;
    }
    expect(warnings).toEqual([]);
    const src = fs.readFileSync(skillPath(projectRoot), "utf8");
    expect(presentForms(src, MIRROR_ID)).toEqual(forms(MIRROR_ID));
    expect(src).toContain(PROSE_A);
  });

  it("WARNS rather than silently no-opping when nothing was substituted", () => {
    const shellRoot = tmp("rks-sync-shell-noid-");
    fs.mkdirSync(path.dirname(skillPath(shellRoot)), { recursive: true });
    fs.writeFileSync(skillPath(shellRoot), skillBody("some-unrelated-source"));
    fs.mkdirSync(path.join(shellRoot, ".rks"), { recursive: true });
    const idFile = path.join(shellRoot, ".rks", "project.json");
    fs.writeFileSync(idFile, JSON.stringify({ id: MIRROR_ID }, null, 2) + "\n");

    const projectRoot = tmp("rks-sync-child-noid-");
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      syncProject({ projectRoot, projectId: "cloner-noid", shellRoot, refreshStamp: false });
    } finally {
      console.warn = realWarn;
    }
    // Asserted on OBSERVED OUTPUT, never a return value — the point is that the return looked
    // like success while nothing happened.
    expect(warnings.length).toBeGreaterThan(0);
    const joined = warnings.join("\n");
    expect(joined).toContain(MIRROR_ID);
    expect(joined).toContain(idFile);
  });
});

describe("one implementation, and a fixture that represents the real corpus", () => {
  it("substituteSourceIdentity is defined exactly once across sync.mjs and bootstrap.mjs", () => {
    // Option A (extract to a shared leaf module) was ARCH's ruling precisely because the defect
    // being closed IS a divergence between two copies of one substitution rule.
    const files = ["packages/cli/src/project/sync.mjs", "packages/cli/src/project/bootstrap.mjs"];
    const definers = files.filter((rel) =>
      /^\s*(export\s+)?function\s+substituteSourceIdentity\s*\(/m.test(
        fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"),
      ),
    );
    expect(definers).toEqual([]);
    const shared = fs.readFileSync(
      path.join(REPO_ROOT, "packages/cli/src/project/source-identity.mjs"),
      "utf8",
    );
    expect(/export\s+function\s+substituteSourceIdentity\s*\(/.test(shared)).toBe(true);
  });

  it("every form this fixture models actually occurs in the shipped skills corpus", () => {
    // REPRESENTATIVENESS, the converse of the sibling witness's soundness sweep at
    // mirror-clone-bootstrap-sentinel.test.mjs:241. That one asks "is every sentinel line a form
    // we model?"; this asks "is every form we model real?". A one-form corpus would pass the
    // sibling and fail here. A plain fs walk, NOT a governed search: a scoped search prunes
    // .claude/skills/build and under-reports.
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
    // The pruned-basename tripwire, asserted BEFORE coverage so a truncated walk fails loudly.
    expect(files).toContain(path.join(root, "build", "SKILL.md"));

    const corpus = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    const unattested = forms(SENTINEL).filter((f) => !corpus.includes(f));
    expect(unattested).toEqual([]);
  });
});
