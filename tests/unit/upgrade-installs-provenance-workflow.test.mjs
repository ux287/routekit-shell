// backlog.feat.commit-provenance-ci-verifier — installProvenanceWorkflow and its upgradeProject wiring.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installProvenanceWorkflow, CHILD_WORKFLOW_YAML, CHILD_WORKFLOW_PATH, CHILD_VERIFIER_PATH } from "../../packages/cli/src/provenance/provenance-workflow.mjs";
import { upgradeProject } from "../../packages/cli/src/project/upgrade.mjs";
import { verifyRange } from "../../packages/cli/src/provenance/verify-provenance.mjs";

const ROOT = path.join(fileURLToPath(import.meta.url), "../../..");
const VERIFIER_SRC = fs.readFileSync(path.join(ROOT, "packages/cli/src/provenance/verify-provenance.mjs"));
const created = [];
afterAll(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); created.push(d); return d; };
const write = (root, rel, body) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000, env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

function child({ projectJson = {}, init = true } = {}) {
  const root = tmp("rks-prov-child-");
  write(root, ".rks/project.json", JSON.stringify({ id: "child", rksVersion: "0.59.6", ...projectJson }, null, 2) + "\n");
  write(root, ".gitignore", "node_modules/\n.rks/.upgrade-backup/\n.rks/.backup/\n");
  if (init) { git(root, ["init", "-q", "-b", "feature/x"]); git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "fixture"]); }
  return root;
}
function shell() { const s = tmp("rks-prov-shell-"); write(s, ".routekit/hooks-manifest.json", "{}"); return s; }
function deps(extra = {}) {
  return {
    readRksVersion: () => "0.59.7",
    syncProject: () => [],
    repinMcpServer: () => ({ ok: true, changed: false, argsChanged: false, envRootChanges: [] }),
    migrateChildSettingsHookPaths: () => false,
    ensureHookRegistration: () => ({ changed: false }),
    mergeRksPermissionAllow: () => ({ changed: false, reason: "unchanged", added: [], addedAsk: [] }),
    migrateConfig: () => ({ ok: true, applied: [], noOp: true }),
    seedVitestFiles: () => ({ created: [], templateMissing: [] }),
    now: () => "TS",
    ...extra,
  };
}
// backlog.fix.upgrade-provenance-test-hermetic-git-identity — upgradeProject's own git (defaultGit) inherits
// process.env, not the helper `env` above. Without a supplied identity its commit depends on the machine's
// global config / identity auto-detection, which fails on the Linux CI runner (commit_failed, committedFiles []).
// The describe below supplies a hermetic identity on process.env and an empty HOME, and restores both after.
// Note: the helper `env` (line 19) was built at module load, so the fixture git() keeps the pre-describe HOME.
const ENV_KEYS = ["HOME", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
const snapshotEnv = () => Object.fromEntries(ENV_KEYS.map((k) => [k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined]));
const ENV_BEFORE_DESCRIBE = snapshotEnv();
const UPGRADE_IDENTITY = { name: "rks-upgrade-test", email: "rks-upgrade-test@example.invalid" };
const diag = (r) => `commitSkipped=${JSON.stringify(r.commitSkipped)} warnings=${JSON.stringify(r.warnings)}`;
const upgrade = (root, d = deps(), opts) => upgradeProject({ projectRoot: root, projectId: "child", shellRoot: shell(), opts }, d);

describe("installProvenanceWorkflow", () => {
  it("AC8 writes both files when absent and reports them as written", () => {
    const root = child({ init: false });
    const r = installProvenanceWorkflow({ projectRoot: root });
    expect(fs.readFileSync(path.join(root, CHILD_WORKFLOW_PATH), "utf8")).toBe(CHILD_WORKFLOW_YAML);
    expect(fs.readFileSync(path.join(root, CHILD_VERIFIER_PATH)).equals(VERIFIER_SRC)).toBe(true);
    expect(r.written.sort()).toEqual([CHILD_VERIFIER_PATH, CHILD_WORKFLOW_PATH].sort());
  });
  it("AC8 leaves an existing different file byte-identical, reports it skipped, writes the other", () => {
    const root = child({ init: false });
    write(root, CHILD_WORKFLOW_PATH, "# operator edit\n");
    const r = installProvenanceWorkflow({ projectRoot: root });
    expect(fs.readFileSync(path.join(root, CHILD_WORKFLOW_PATH), "utf8")).toBe("# operator edit\n");
    expect(r.skipped).toContain(CHILD_WORKFLOW_PATH);
    expect(r.written).toEqual([CHILD_VERIFIER_PATH]);
  });
});

describe("upgradeProject provenance wiring", () => {
  let savedEnv;
  beforeAll(() => {
    savedEnv = snapshotEnv();
    Object.assign(process.env, {
      HOME: tmp("rks-prov-home-"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: UPGRADE_IDENTITY.name,
      GIT_AUTHOR_EMAIL: UPGRADE_IDENTITY.email,
      GIT_COMMITTER_NAME: UPGRADE_IDENTITY.name,
      GIT_COMMITTER_EMAIL: UPGRADE_IDENTITY.email,
    });
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  it("runs with an empty HOME (no .gitconfig) and GIT_CONFIG_NOSYSTEM=1", () => {
    const home = process.env.HOME;
    expect(fs.statSync(home).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(home, ".gitconfig"))).toBe(false);
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });
  it("AC8 reconciled names each installed path; preserved names each skipped path", () => {
    const fresh = upgrade(child());
    expect(fresh.reconciled.some((e) => e.includes(CHILD_WORKFLOW_PATH))).toBe(true);
    expect(fresh.reconciled.some((e) => e.includes(CHILD_VERIFIER_PATH))).toBe(true);
    const root = child();
    write(root, CHILD_WORKFLOW_PATH, "# mine\n"); write(root, CHILD_VERIFIER_PATH, "// mine\n");
    git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "operator"]);
    const r = upgrade(root);
    expect(r.preserved.some((e) => e.includes(CHILD_WORKFLOW_PATH))).toBe(true);
    expect(r.preserved.some((e) => e.includes(CHILD_VERIFIER_PATH))).toBe(true);
    expect(fs.readFileSync(path.join(root, CHILD_WORKFLOW_PATH), "utf8")).toBe("# mine\n");
  });
  it("dry run writes neither file", () => {
    const root = child();
    upgrade(root, deps(), { dryRun: true });
    expect(exists(root, CHILD_WORKFLOW_PATH)).toBe(false);
    expect(exists(root, CHILD_VERIFIER_PATH)).toBe(false);
  });
  it("commits the installed files and leaves the tree clean", () => {
    const root = child();
    const r = upgrade(root);
    expect(r.committed, diag(r)).toBe(true);
    expect(r.committedFiles, diag(r)).toEqual(expect.arrayContaining([CHILD_WORKFLOW_PATH, CHILD_VERIFIER_PATH]));
    expect(git(root, ["status", "--porcelain", "--untracked-files=all"]).trim()).toBe("");
  });
  it("AC10 the upgrade commit carries exactly one Rks-Provenance v1 trailer and verifyRange classifies it governed", () => {
    const root = child();
    const pre = git(root, ["rev-parse", "HEAD"]).trim();
    const r = upgrade(root);
    expect(r.committed, diag(r)).toBe(true);
    const added = git(root, ["rev-list", `${pre}..HEAD`]).trim().split("\n").filter(Boolean);
    expect(added).toHaveLength(1);
    const head = added[0];
    const raw = git(root, ["show", "-s", "--format=%(trailers:key=Rks-Provenance,valueonly,separator=%x01)", head]);
    const vals = raw.replace(/\n$/, "").split("\x01").map((s) => s.trim()).filter(Boolean);
    expect(vals).toHaveLength(1);
    expect(vals[0].startsWith("v1 ")).toBe(true);
    expect(vals[0]).toMatch(/(^| )session=none( |$)/);
    expect(vals[0]).toMatch(/(^| )tool=routekit_project_upgrade( |$)/);
    expect(git(root, ["show", "-s", "--format=%s", head]).trim()).toMatch(/^chore\(rks\): upgrade scaffolding \S+ -> 0\.59\.7$/);
    const res = verifyRange({ cwd: root, base: pre, head: "HEAD" });
    expect(res.commits.find((c) => c.sha === head)?.class).toBe("governed");
  });
  it("the upgrade commit carries the identity the describe supplied via process.env", () => {
    const root = child();
    const r = upgrade(root);
    expect(r.committed, diag(r)).toBe(true);
    const ident = git(root, ["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", r.commitSha]).replace(/\n$/, "").split("\0");
    expect(ident).toEqual([UPGRADE_IDENTITY.name, UPGRADE_IDENTITY.email, UPGRADE_IDENTITY.name, UPGRADE_IDENTITY.email]);
  });
  it("a content-only child gets nothing under .github", () => {
    const root = child({ projectJson: { vcs: { contentOnly: true } } });
    upgrade(root);
    expect(exists(root, ".github")).toBe(false);
  });
  it("uses an injected deps.installProvenanceWorkflow", () => {
    const inst = vi.fn(() => ({ written: [], skipped: [] }));
    const root = child();
    upgrade(root, deps({ installProvenanceWorkflow: inst }));
    expect(inst).toHaveBeenCalled();
    expect(exists(root, CHILD_WORKFLOW_PATH)).toBe(false);
  });
});

describe("after upgradeProject provenance wiring", () => {
  it("restores every process.env key the describe mutated (absent keys stay absent)", () => {
    const after = snapshotEnv();
    for (const k of ENV_KEYS) {
      expect(after[k], k).toBe(ENV_BEFORE_DESCRIBE[k]);
      expect(Object.prototype.hasOwnProperty.call(process.env, k), k).toBe(ENV_BEFORE_DESCRIBE[k] !== undefined);
    }
  });
});
