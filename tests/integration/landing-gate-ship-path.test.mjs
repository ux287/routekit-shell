// backlog.feat.landing-gate-ship-path-behaviour — the real rks_ship path with the landing gate off and on.
//
// Drives the real runShip against a temp work clone with a local bare origin (a non-GitHub URL, so
// the local-merge arm runs). Harness exemplars: tests/integration/ship-non-github-remote-local-merge.test.mjs
// and tests/integration/landing-refusal-hints.test.mjs. Every assertion is read back from git or from
// the returned object; no source-text assertion. Every spawnSync carries timeout:.
// This file deliberately imports and mocks no @routekit/telemetry specifier
// (tests/unit/telemetry-global-mock-triage.test.mjs): the suite-wide stub from tests/setup.mjs serves.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Partial mock: only runFullSuiteGate is replaced. An enabled gate passes; any other config
// delegates to the real function, so the gate-disabled cases stay on the real path.
vi.mock("../../packages/mcp-rks/src/exec/full-suite-gate.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runFullSuiteGate: vi.fn((projectRoot, options) =>
      actual.resolveFullSuiteGateConfig(projectRoot).enabled === true
        ? { ran: true, blocked: false, reason: "no_new_failures" }
        : actual.runFullSuiteGate(projectRoot, options)),
  };
});

// Short-circuit only the embedding step after commits (no ONNX model load); git semantics stay real.
vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));

import { runShip } from "../../packages/mcp-rks/src/server/git/git-ship.mjs";

const GIT_TIMEOUT_MS = 30_000;
const GIT_ID_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
const LANDING_STEPS = ["landing_candidate", "full_suite_gate", "landing_verify"];

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: { ...process.env, ...GIT_ID_ENV } });
}
function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout || "").trim();
}
function configIdentity(dir) {
  gitOk(dir, ["config", "user.email", "t@t"]);
  gitOk(dir, ["config", "user.name", "t"]);
  gitOk(dir, ["config", "commit.gpgsign", "false"]);
}

let base, bare, work, savedPath;

beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), "rks-landing-ship-")); });
afterEach(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  savedPath = undefined;
  fs.rmSync(base, { recursive: true, force: true });
});

/**
 * Bare origin with main and staging, a work clone on the feature branch rks/feat (cut from staging)
 * with an uncommitted feature.txt, and origin's staging advanced (from a second clone) past the
 * feature branch's base. The clone sits on an rks/* branch so runShip reuses it: creating a new
 * branch would pull --ff-only the advance into the base first. projectJson is the committed
 * project config. Returns the name of the file the target advance added.
 */
function setup(projectJson) {
  bare = path.join(base, "origin.git");
  work = path.join(base, "work");
  gitOk(base, ["init", "--bare", "-q", "-b", "main", bare]);
  gitOk(base, ["clone", "-q", bare, work]);
  configIdentity(work);
  fs.writeFileSync(path.join(work, "README.md"), "seed\n");
  fs.mkdirSync(path.join(work, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(work, ".rks", "project.json"), JSON.stringify(projectJson, null, 2));
  gitOk(work, ["add", "-A"]);
  gitOk(work, ["commit", "-q", "-m", "seed"]);
  gitOk(work, ["push", "-q", "-u", "origin", "main"]);
  gitOk(work, ["checkout", "-q", "-b", "staging"]);
  gitOk(work, ["push", "-q", "-u", "origin", "staging"]);
  gitOk(work, ["checkout", "-q", "-b", "rks/feat"]);

  // Origin's target advances past the feature base.
  const other = path.join(base, "other");
  gitOk(base, ["clone", "-q", "-b", "staging", bare, other]);
  configIdentity(other);
  const advanceFile = "target-advance.txt";
  fs.writeFileSync(path.join(other, advanceFile), "advance\n");
  gitOk(other, ["add", advanceFile]);
  gitOk(other, ["commit", "-q", "-m", "origin target advance"]);
  gitOk(other, ["push", "-q", "origin", "staging"]);

  // A gh stub that fails, so no path can reach GitHub.
  const binDir = path.join(base, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;

  fs.writeFileSync(path.join(work, "feature.txt"), "feature\n");
  // The feature base does not contain the target advance.
  expect(git(work, ["cat-file", "-e", `HEAD:${advanceFile}`]).status).not.toBe(0);
  return advanceFile;
}

const ship = () => runShip({ projectRoot: work, message: "ship feature", scope: "test", type: "feat", files: ["feature.txt"] });
const stepOf = (res, name) => (res.steps || []).find((s) => s.step === name);
const originTip = () => gitOk(bare, ["rev-parse", "refs/heads/staging"]);
const parentsOf = (sha) => gitOk(bare, ["rev-list", "--parents", "-n", "1", sha]).split(/\s+/).slice(1);

function expectNoLandingSurface(res) {
  expect(res.ok, JSON.stringify(res, null, 2)).toBe(true);
  for (const name of LANDING_STEPS) expect(stepOf(res, name)).toBeUndefined();
  expect(res).not.toHaveProperty("landingCandidate");
  expect(res).not.toHaveProperty("landingVerify");
  expect(res).not.toHaveProperty("fullSuiteGate");
}

function expectWorkCommitLandedAsSecondParent(res) {
  expect(res.ok, JSON.stringify(res, null, 2)).toBe(true);
  const commitStep = stepOf(res, "commit");
  expect(commitStep.fullCommitId).toMatch(/^[0-9a-f]{40}$/);
  expect(commitStep.commitId).toBe(commitStep.fullCommitId.slice(0, 7));
  const parents = parentsOf(originTip());
  expect(parents).toHaveLength(2);
  expect(parents[1]).toBe(commitStep.fullCommitId);
  // The feature branch's history (reachable from the landed second parent) has no landing merge.
  const subjects = gitOk(bare, ["log", "--format=%s", parents[1]]).split("\n");
  expect(subjects.some((s) => s.includes("into landing candidate"))).toBe(false);
}

describe("rks_ship with the landing gate disabled", () => {
  it("with no fullSuiteGate config adds no landing or gate step and no landing result fields", async () => {
    setup({});
    expectNoLandingSurface(await ship());
  });

  it("with no fullSuiteGate config lands the work commit itself as the merge second parent", async () => {
    setup({});
    expectWorkCommitLandedAsSecondParent(await ship());
  });

  it("with fullSuiteGate enabled false adds no landing or gate step and no landing result fields", async () => {
    setup({ fullSuiteGate: { enabled: false } });
    expectNoLandingSurface(await ship());
  });

  it("with fullSuiteGate enabled false lands the work commit itself as the merge second parent", async () => {
    setup({ fullSuiteGate: { enabled: false } });
    expectWorkCommitLandedAsSecondParent(await ship());
  });
});

describe("rks_ship with the landing gate enabled", () => {
  it("the gate tests the prepared landing candidate sha", async () => {
    setup({ fullSuiteGate: { enabled: true } });
    const res = await ship();
    expect(res.ok, JSON.stringify(res, null, 2)).toBe(true);
    const landing = stepOf(res, "landing_candidate");
    expect(landing).toMatchObject({ ok: true, mergedTarget: true });
    expect(landing.preparedSha).toMatch(/^[0-9a-f]{40}$/);
    const gate = stepOf(res, "full_suite_gate");
    expect(gate).toBeDefined();
    expect(gate.testedSha).toBe(landing.preparedSha);
  });

  it("lands the prepared combined tree that the gate tested", async () => {
    const advanceFile = setup({ fullSuiteGate: { enabled: true } });
    const res = await ship();
    expect(res.ok, JSON.stringify(res, null, 2)).toBe(true);
    const landing = stepOf(res, "landing_candidate");
    expect(landing).toMatchObject({ ok: true, mergedTarget: true });
    const tip = originTip();
    expect(git(bare, ["merge-base", "--is-ancestor", landing.preparedSha, tip]).status).toBe(0);
    const files = gitOk(bare, ["ls-tree", "-r", "--name-only", tip]).split("\n");
    expect(files).toContain(advanceFile);
    expect(files).toContain("feature.txt");
  });
});
