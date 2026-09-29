/**
 * Witness for backlog.fix.skills-manifest-never-distributed-to-children.
 *
 * Nothing ever wrote `.routekit/skills-manifest.json` INTO a child. Two readers parse that file and
 * no code path anywhere produces one for a child, so `loadSkillsManifest(childRoot)` always hit
 * ENOENT — and preflight's `manifest_missing` branch sets `skillsPassed = true` without statting a
 * single skill directory. `core_skills` was a permanent no-op green in every child project.
 *
 * That is the same failure the skills check was added to end, reproduced one layer out: a health
 * oracle certifying a corpse. The UAT box that lost 17 skills read 7/7 green; a child that loses all
 * of them today reads green too, and for a *different* reason, so fixing the first did not fix this.
 *
 * The manifest is written from the OBSERVED COPY SET — the names that survived the exclusion
 * `continue` in the copy loop — never restated from the shell's own manifest. Three shapes were
 * available and only one is correct:
 *
 *   copied from the shell's manifest  → advertises a skill the child never received (a published
 *                                       mirror strips `whitepaper`, so the child would claim it and
 *                                       preflight would red a clean tree)
 *   derived at CHECK time from disk   → expected becomes actual by construction; a wipe deletes the
 *                                       skills AND the evidence, and the check can never fail
 *   recorded at DISTRIBUTION time     → outlives the directories, so it can witness a wipe
 *
 * The WIPE WITNESS below is what distinguishes the third from the second. An implementation that
 * enumerated the child directory at check time passes every other test here and fails that one.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ensureGovernorArtifacts } from "../../packages/cli/src/project/bootstrap.mjs";
import { syncProject } from "../../packages/cli/src/project/sync.mjs";
import { loadSkillsManifest } from "../../packages/mcp-rks/src/shared/skills-manifest.mjs";
import { checkGitReadiness } from "../../packages/mcp-rks/src/server/preflight.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const TIMEOUT = 20_000;
const CHILD_ID = "kid-project";
const MANIFEST_REL = path.join(".routekit", "skills-manifest.json");

const g = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT });

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

/**
 * A shell fixture, WRITTEN rather than copied from the ambient checkout — the same discipline
 * mirror-clone-bootstrap-sentinel.test.mjs uses. A witness that read its precondition off whatever
 * tree it happens to run in would behave differently upstream and on a mirror clone.
 *
 * `manifestSkills` and `treeSkills` are separate on purpose: their DIVERGENCE is the mirror-clone
 * shape, and it is what distinguishes a derived manifest from a copied one.
 */
function makeShell({ manifestSkills, treeSkills, shellOnly = ["promote"] } = {}) {
  const shellRoot = tmp("rks-shell-manifest-");
  fs.mkdirSync(path.join(shellRoot, ".routekit"), { recursive: true });
  fs.writeFileSync(
    path.join(shellRoot, ".routekit", "skills-manifest.json"),
    `${JSON.stringify({ version: 1, skills: manifestSkills, shellOnly }, null, 2)}\n`,
  );
  for (const s of treeSkills) {
    const d = path.join(shellRoot, ".claude", "skills", s);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${s}\n---\n\n# ${s}\n`);
  }
  fs.mkdirSync(path.join(shellRoot, ".rks", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(shellRoot, ".rks", "prompts", "governor-build.md"), "prompt\n");
  fs.writeFileSync(
    path.join(shellRoot, ".rks", "project.json"),
    `${JSON.stringify({ id: "source-shell" }, null, 2)}\n`,
  );
  return shellRoot;
}

/** The unit under change, driven directly. NOT attachProject — that runs a real dependency install. */
function deliver(shellRoot, projectRoot = tmp("rks-child-")) {
  ensureGovernorArtifacts({ projectRoot, projectId: CHILD_ID, shellRoot });
  return projectRoot;
}

function manifestPath(projectRoot) {
  return path.join(projectRoot, MANIFEST_REL);
}

function readManifest(projectRoot) {
  const p = manifestPath(projectRoot);
  // EXECUTED-PATH EVIDENCE. A missing file would otherwise satisfy several negative assertions.
  expect(fs.existsSync(p)).toBe(true);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** The child's skill directories as they actually stand on disk. */
function childSkillDirs(projectRoot) {
  const dir = path.join(projectRoot, ".claude", "skills");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * A child that is also a git repo, so checkGitReadiness reaches its skills check rather than
 * bailing earlier. The commit matters: a repo with no HEAD fails other checks and would make a
 * core_skills assertion uninterpretable.
 */
function gitify(projectRoot) {
  g(projectRoot, ["init", "-b", "staging"]);
  g(projectRoot, ["config", "user.email", "t@t"]);
  g(projectRoot, ["config", "user.name", "t"]);
  g(projectRoot, ["add", "-A"]);
  g(projectRoot, ["commit", "-m", "child"]);
  return projectRoot;
}

const coreSkills = (projectRoot) =>
  checkGitReadiness({ projectRoot, projectJson: {}, timeoutMs: TIMEOUT }).find(
    (c) => c.name === "core_skills",
  );

describe("the child receives a manifest derived from what it actually got", () => {
  it("bootstrap writes .routekit/skills-manifest.json into the child", () => {
    const child = deliver(makeShell({ manifestSkills: ["arch", "build"], treeSkills: ["arch", "build"] }));
    expect(fs.existsSync(manifestPath(child))).toBe(true);
  });

  it("the manifest skill list equals the child's own skill directories", () => {
    const child = deliver(
      makeShell({ manifestSkills: ["arch", "build", "qa"], treeSkills: ["arch", "build", "qa"] }),
    );
    // Compared against the CHILD DIRECTORY, never against the shell's list.
    expect([...readManifest(child).skills].sort()).toEqual(childSkillDirs(child));
  });

  it("a shellOnly skill reaches neither the child tree nor the child manifest", () => {
    const child = deliver(
      makeShell({
        manifestSkills: ["arch", "promote"],
        treeSkills: ["arch", "promote"],
        shellOnly: ["promote"],
      }),
    );
    expect(childSkillDirs(child)).not.toContain("promote");
    expect(readManifest(child).skills).not.toContain("promote");
  });

  it("DERIVED, NOT COPIED — a shell manifest declaring more than its tree holds is not echoed", () => {
    // The mirror-clone shape: the manifest still names `whitepaper`, the directory is stripped.
    const shellRoot = makeShell({
      manifestSkills: ["arch", "build", "whitepaper"],
      treeSkills: ["arch", "build"],
    });
    const child = deliver(shellRoot);
    const childManifest = readManifest(child);
    expect(childManifest.skills).not.toContain("whitepaper");
    expect([...childManifest.skills].sort()).toEqual(["arch", "build"]);
    // And it is not the shell's file by another route.
    const shellManifest = JSON.parse(
      fs.readFileSync(path.join(shellRoot, ".routekit", "skills-manifest.json"), "utf8"),
    );
    expect(childManifest.skills).not.toEqual(shellManifest.skills);
  });

  it("MIRROR SHAPE — the stripped skill does not red the child's core_skills check", () => {
    const child = gitify(
      deliver(makeShell({ manifestSkills: ["arch", "build", "whitepaper"], treeSkills: ["arch", "build"] })),
    );
    const check = coreSkills(child);
    expect(check.passed).toBe(true);
    expect(check.detail).not.toContain("whitepaper");
  });

  it("the written file satisfies the REAL reader, not just JSON.parse", () => {
    const child = deliver(makeShell({ manifestSkills: ["arch", "build"], treeSkills: ["arch", "build"] }));
    const m = loadSkillsManifest(child);
    expect(m.ok).toBe(true);
    expect(m.skills.length).toBeGreaterThan(0);
    // shellOnly is empty in a child — excluded skills were never copied — so nothing is subtracted.
    expect([...m.distributable].sort()).toEqual(childSkillDirs(child));
  });
});

describe("core_skills stops greening on nothing", () => {
  it("a freshly bootstrapped child reports a real count, not 'no manifest'", () => {
    const child = gitify(
      deliver(makeShell({ manifestSkills: ["arch", "build", "qa"], treeSkills: ["arch", "build", "qa"] })),
    );
    const check = coreSkills(child);
    expect(check.passed).toBe(true);
    expect(check.detail).not.toContain("no manifest");
    expect(check.detail).toContain("3/3 present");
  });

  it("WIPE WITNESS — a skill deleted from the child after distribution REDS the check", () => {
    // The whole point of the story. A check-time enumeration of the child directory passes every
    // other test in this file and fails here, because it would delete the expectation along with
    // the skill and green forever.
    const child = gitify(
      deliver(makeShell({ manifestSkills: ["arch", "build", "qa"], treeSkills: ["arch", "build", "qa"] })),
    );
    expect(coreSkills(child).passed).toBe(true); // positive control — healthy before the wipe
    fs.rmSync(path.join(child, ".claude", "skills", "qa"), { recursive: true, force: true });
    const after = coreSkills(child);
    expect(after.passed).toBe(false);
    expect(after.detail).toContain("qa");
  });
});

describe("sync keeps the child manifest in step", () => {
  it("a first sync onto a child with no manifest writes one", () => {
    const shellRoot = makeShell({ manifestSkills: ["arch", "build"], treeSkills: ["arch", "build"] });
    const child = tmp("rks-child-sync-");
    expect(fs.existsSync(manifestPath(child))).toBe(false); // positive control
    syncProject({ projectRoot: child, projectId: CHILD_ID, shellRoot, refreshStamp: false });
    expect([...readManifest(child).skills].sort()).toEqual(childSkillDirs(child));
  });

  it("a skill ADDED to the shell appears in the child manifest after the next sync", () => {
    const shellRoot = makeShell({ manifestSkills: ["arch"], treeSkills: ["arch"] });
    const child = tmp("rks-child-sync-add-");
    syncProject({ projectRoot: child, projectId: CHILD_ID, shellRoot, refreshStamp: false });
    expect(readManifest(child).skills).not.toContain("ship"); // positive control

    const added = path.join(shellRoot, ".claude", "skills", "ship");
    fs.mkdirSync(added, { recursive: true });
    fs.writeFileSync(path.join(added, "SKILL.md"), "---\nname: ship\n---\n\n# ship\n");
    syncProject({ projectRoot: child, projectId: CHILD_ID, shellRoot, refreshStamp: false });

    expect(readManifest(child).skills).toContain("ship");
    expect([...readManifest(child).skills].sort()).toEqual(childSkillDirs(child));
  });

  it("a skill REMOVED from the shell leaves the child manifest SHRUNK, not stale", () => {
    // A manifest that only ever grows would keep greening a skill the child no longer holds — the
    // same lie as the missing file, arrived at from the other direction.
    const shellRoot = makeShell({ manifestSkills: ["arch", "ship"], treeSkills: ["arch", "ship"] });
    const child = tmp("rks-child-sync-rm-");
    syncProject({ projectRoot: child, projectId: CHILD_ID, shellRoot, refreshStamp: false });
    expect(readManifest(child).skills).toContain("ship"); // positive control

    fs.rmSync(path.join(shellRoot, ".claude", "skills", "ship"), { recursive: true, force: true });
    fs.rmSync(path.join(child, ".claude", "skills", "ship"), { recursive: true, force: true });
    syncProject({ projectRoot: child, projectId: CHILD_ID, shellRoot, refreshStamp: false });

    expect(readManifest(child).skills).not.toContain("ship");
    expect([...readManifest(child).skills].sort()).toEqual(childSkillDirs(child));
  });
});

describe("guards", () => {
  it("EMPTY SET GUARD — a zero-copy bootstrap never writes an empty skills array", () => {
    // ORDER-CRITICAL. loadSkillsManifest rejects a zero-length skills array as manifest_malformed.
    // That degrades to the same green as a missing file TODAY, but reds unconditionally once
    // backlog.fix.preflight-core-skills-greens-unreadable-manifest ships — so emitting
    // `{"skills": []}` here would be harmless now and fatal later.
    const shellRoot = makeShell({ manifestSkills: ["promote"], treeSkills: ["promote"], shellOnly: ["promote"] });
    const child = deliver(shellRoot);
    expect(childSkillDirs(child)).toEqual([]); // positive control — nothing was copied
    if (fs.existsSync(manifestPath(child))) {
      expect(loadSkillsManifest(child).ok).toBe(true);
    } else {
      expect(loadSkillsManifest(child).reason).toBe("manifest_missing");
    }
  });

  it("the child manifest is TRACKABLE — no gitignore entry hides it", () => {
    // Being trackable in HEAD is what lets the sibling story red a DELETED manifest. An ignore
    // entry here would quietly foreclose that.
    const child = gitify(
      deliver(makeShell({ manifestSkills: ["arch"], treeSkills: ["arch"] })),
    );
    const res = g(child, ["check-ignore", MANIFEST_REL]);
    // git check-ignore exits 1 when the path is NOT ignored.
    expect(res.status).toBe(1);
    expect(res.stdout.trim()).toBe("");
  });

  it("the .yaml policy seeding filter is not widened to .json", () => {
    // The manifest is written by a separate step. Asserted on the durable expression over full
    // source — never a line number, never a fixed-size slice.
    const src = fs.readFileSync(path.join(REPO_ROOT, "packages/cli/src/project/bootstrap.mjs"), "utf8");
    expect(src).toContain('.filter(f => f.endsWith(".yaml"))');
    expect(src).not.toContain('.filter(f => f.endsWith(".json"))');
  });
});
