// backlog.feat.commit-provenance-ci-verifier — verifier, CLI verb, direct invocation, ci.yml job, child workflow string.
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { classifyCommit, verifyRange, exitCodeFor } from "../../packages/cli/src/provenance/verify-provenance.mjs";
import { CHILD_WORKFLOW_YAML, CHILD_WORKFLOW_PATH, CHILD_VERIFIER_PATH } from "../../packages/cli/src/provenance/provenance-workflow.mjs";

const ROOT = path.join(fileURLToPath(import.meta.url), "../../..");
const CLI = path.join(ROOT, "packages/cli/bin/routekit.js");
const VERIFIER = path.join(ROOT, "packages/cli/src/provenance/verify-provenance.mjs");
const V1 = "v1 session=a tool=b client=c via=ide actor=x run=none";
const ZERO = "0".repeat(40);

const created = [];
afterAll(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });

const baseEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
function git(cwd, args, env = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000, env: { ...baseEnv, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function repo() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-prov-")));
  created.push(d);
  git(d, ["init", "-q", "-b", "main"]);
  git(d, ["commit", "-q", "--allow-empty", "-m", "root"]);
  return d;
}
function commit(d, subject, { trailer, env } = {}) {
  const msg = trailer ? `${subject}\n\nRks-Provenance: ${trailer}\n` : subject;
  git(d, ["commit", "-q", "--allow-empty", "-m", msg], env);
  return git(d, ["rev-parse", "HEAD"]);
}
const run = (args, cwd) => spawnSync("node", args, { cwd, encoding: "utf8", timeout: 30_000, env: baseEnv });
const classOf = (res, sha) => res.commits.find((c) => c.sha === sha)?.class;

describe("verifyRange classification", () => {
  it("AC1 governed with a v1 trailer, ungoverned without one", () => {
    const d = repo(); const base = git(d, ["rev-parse", "HEAD"]);
    const g = commit(d, "governed", { trailer: V1 }); const u = commit(d, "raw");
    const res = verifyRange({ cwd: d, base, head: "HEAD" });
    expect(classOf(res, g)).toBe("governed");
    expect(classOf(res, u)).toBe("ungoverned");
  });
  it("AC1 a non-v1 trailer value is not governed", () => {
    const d = repo(); const base = git(d, ["rev-parse", "HEAD"]);
    const s = commit(d, "v2", { trailer: "v2 session=a" });
    expect(classOf(verifyRange({ cwd: d, base, head: "HEAD" }), s)).toBe("ungoverned");
  });
  it("AC2 no trailer and a noreply@github.com committer is unverifiable", () => {
    const d = repo(); const base = git(d, ["rev-parse", "HEAD"]);
    const s = commit(d, "squash (#1)", { env: { GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" } });
    expect(classOf(verifyRange({ cwd: d, base, head: "HEAD" }), s)).toBe("unverifiable");
  });
  it("AC2 a v1 trailer wins over the platform committer", () => {
    const d = repo(); const base = git(d, ["rev-parse", "HEAD"]);
    const s = commit(d, "squash (#2)", { trailer: V1, env: { GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" } });
    expect(classOf(verifyRange({ cwd: d, base, head: "HEAD" }), s)).toBe("governed");
    expect(classifyCommit({ provenance: [V1], committerEmail: "noreply@github.com" })).toBe("governed");
  });
  it("AC3 merge commits are not listed; both merged sides are", () => {
    const d = repo(); const base = git(d, ["rev-parse", "HEAD"]);
    git(d, ["checkout", "-q", "-b", "side"]); const side = commit(d, "side");
    git(d, ["checkout", "-q", "main"]); const mainC = commit(d, "main");
    git(d, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    const merge = git(d, ["rev-parse", "HEAD"]);
    const shas = verifyRange({ cwd: d, base, head: "HEAD" }).commits.map((c) => c.sha);
    expect(shas).not.toContain(merge);
    expect(shas).toEqual(expect.arrayContaining([side, mainC]));
  });
  it("AC3 since excludes that commit and its ancestors", () => {
    const d = repo(); const base = git(d, ["rev-parse", "HEAD"]);
    const a = commit(d, "a"); const b = commit(d, "b"); const c = commit(d, "c");
    const shas = verifyRange({ cwd: d, base, head: "HEAD", since: b }).commits.map((x) => x.sha);
    expect(shas).toEqual([c]);
    expect(shas).not.toContain(a);
  });
  it("AC5 result shape and counts", () => {
    const d = repo(); const base = git(d, ["rev-parse", "HEAD"]);
    commit(d, "g", { trailer: V1 }); commit(d, "u");
    const res = verifyRange({ cwd: d, base, head: "HEAD" });
    expect(res).toMatchObject({ ok: false, skipped: false, reason: null, mode: "warn", range: { base, head: "HEAD", since: null } });
    expect(verifyRange({ cwd: d, base, head: "HEAD", mode: "enforce" }).ok).toBe(false);
    expect(Object.keys(res.counts).sort()).toEqual(["governed", "ungoverned", "unverifiable"]);
    expect(res.counts.governed + res.counts.ungoverned + res.counts.unverifiable).toBe(res.commits.length);
    for (const c of res.commits) expect(Object.keys(c)).toEqual(expect.arrayContaining(["sha", "subject", "class", "provenance"]));
  });
  it("AC5 ok is true only when every classified commit is governed, in either mode", () => {
    const d = repo(); const base = git(d, ["rev-parse", "HEAD"]);
    commit(d, "g", { trailer: V1 });
    for (const mode of ["warn", "enforce"]) expect(verifyRange({ cwd: d, base, head: "HEAD", mode })).toMatchObject({ ok: true, skipped: false, mode });
  });
  it("AC5 a resolvable empty range is ok and not skipped", () => {
    const d = repo(); const base = git(d, ["rev-parse", "HEAD"]);
    expect(verifyRange({ cwd: d, base, head: base })).toMatchObject({ ok: true, skipped: false, reason: null, counts: { governed: 0, ungoverned: 0, unverifiable: 0 }, commits: [] });
  });
  it("AC4 an unresolvable base returns an explicit skipped result, never ok", () => {
    const d = repo(); commit(d, "raw");
    for (const base of [ZERO, "f".repeat(40)]) {
      expect(verifyRange({ cwd: d, base, head: "HEAD" })).toMatchObject({ ok: false, skipped: true, reason: "base_unresolvable", counts: null, commits: null });
    }
  });
  it("AC4 an unresolvable since returns an explicit skipped result, never ok", () => {
    const d = repo(); const base = git(d, ["rev-parse", "HEAD"]); commit(d, "raw");
    expect(verifyRange({ cwd: d, base, head: "HEAD", since: "e".repeat(40) })).toMatchObject({ ok: false, skipped: true, reason: "since_unresolvable", counts: null, commits: null });
  });
  it("AC4 exitCodeFor depends on mode only through ok", () => {
    expect(exitCodeFor({ mode: "warn", ok: false })).toBe(0);
    expect(exitCodeFor({ mode: "warn", ok: true })).toBe(0);
    expect(exitCodeFor({ mode: "enforce", ok: false })).toBe(1);
    expect(exitCodeFor({ mode: "enforce", ok: true })).toBe(0);
  });
});

describe("routekit verify-provenance verb", () => {
  const fixture = () => { const d = repo(); const base = git(d, ["rev-parse", "HEAD"]); const u = commit(d, "raw change"); return { d, base, u }; };
  it("AC4 warn exits 0 and lists the ungoverned sha and subject", () => {
    const { d, base, u } = fixture();
    const r = run([CLI, "verify-provenance", "--base", base, "--head", "HEAD", "--mode", "warn"], d);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(u.slice(0, 7));
    expect(r.stdout).toContain("raw change");
  });
  it("AC4 enforce exits 1 on ungoverned, 1 on unverifiable, 0 when all governed", () => {
    const { d, base } = fixture();
    expect(run([CLI, "verify-provenance", "--base", base, "--head", "HEAD", "--mode", "enforce"], d).status).toBe(1);
    const p = repo(); const pb = git(p, ["rev-parse", "HEAD"]);
    commit(p, "squash", { env: { GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" } });
    expect(run([CLI, "verify-provenance", "--base", pb, "--head", "HEAD", "--mode", "enforce"], p).status).toBe(1);
    const g = repo(); const gb = git(g, ["rev-parse", "HEAD"]);
    commit(g, "ok", { trailer: V1 });
    expect(run([CLI, "verify-provenance", "--base", gb, "--head", "HEAD", "--mode", "enforce"], g).status).toBe(0);
  });
  it("AC4 default mode is warn", () => {
    const { d, base } = fixture();
    expect(run([CLI, "verify-provenance", "--base", base, "--head", "HEAD"], d).status).toBe(0);
  });
  it("AC4 an unresolvable --base is reported as skipped base_unresolvable; warn exits 0, enforce exits 1", () => {
    const { d } = fixture();
    const r = run([CLI, "verify-provenance", "--base", ZERO, "--head", "HEAD", "--mode", "warn"], d);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("base_unresolvable");
    const j = JSON.parse(run([CLI, "verify-provenance", "--base", ZERO, "--head", "HEAD", "--json"], d).stdout);
    expect(j).toMatchObject({ ok: false, skipped: true, reason: "base_unresolvable" });
    expect(run([CLI, "verify-provenance", "--base", ZERO, "--head", "HEAD", "--mode", "enforce"], d).status).toBe(1);
  });
  it("AC4 an unresolvable --since is reported as skipped since_unresolvable", () => {
    const { d, base } = fixture();
    const j = JSON.parse(run([CLI, "verify-provenance", "--base", base, "--head", "HEAD", "--since", "e".repeat(40), "--json"], d).stdout);
    expect(j).toMatchObject({ ok: false, skipped: true, reason: "since_unresolvable" });
  });
  it("AC5 --json prints one JSON object with counts per class", () => {
    const { d, base } = fixture();
    const r = run([CLI, "verify-provenance", "--base", base, "--head", "HEAD", "--json"], d);
    const obj = JSON.parse(r.stdout);
    expect(obj.counts.ungoverned).toBe(obj.commits.filter((c) => c.class === "ungoverned").length);
    expect(obj).toMatchObject({ ok: false, skipped: false, reason: null, mode: "warn" });
  });
  it("--since defaults to .rks/project.json commitProvenance.since", () => {
    const d = repo(); const base = git(d, ["rev-parse", "HEAD"]);
    const old = commit(d, "old raw"); const fresh = commit(d, "fresh raw");
    fs.mkdirSync(path.join(d, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(d, ".rks/project.json"), JSON.stringify({ commitProvenance: { since: old } }));
    const obj = JSON.parse(run([CLI, "verify-provenance", "--base", base, "--head", fresh, "--json"], d).stdout);
    expect(obj.commits.map((c) => c.sha)).toEqual([fresh]);
  });
  it("AC9 direct node invocation honours --mode", () => {
    const { d, base } = fixture();
    expect(run([VERIFIER, "--base", base, "--head", "HEAD", "--mode", "enforce"], d).status).toBe(1);
    expect(run([VERIFIER, "--base", base, "--head", "HEAD", "--mode", "warn"], d).status).toBe(0);
    const z = run([VERIFIER, "--base", ZERO, "--head", "HEAD", "--json"], d);
    expect(z.status).toBe(0);
    expect(JSON.parse(z.stdout)).toMatchObject({ ok: false, skipped: true, reason: "base_unresolvable" });
  });
});

describe("zero dependencies and workflows", () => {
  it("AC6 the verifier imports only node: built-ins", () => {
    const src = fs.readFileSync(VERIFIER, "utf8");
    const specs = [...src.matchAll(/(?:^|\n)\s*import\s[^"']*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s.startsWith("node:")).toBe(true);
  });
  it("AC7 ci.yml has a warn-mode provenance job on pull_request and push", () => {
    const ci = yaml.load(fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"));
    expect(ci.on).toHaveProperty("pull_request");
    expect(ci.on).toHaveProperty("push");
    const job = ci.jobs.provenance;
    expect(job).toBeDefined();
    const checkout = job.steps.find((s) => String(s.uses || "").startsWith("actions/checkout"));
    expect(checkout.with["fetch-depth"]).toBe(0);
    const runs = job.steps.map((s) => s.run || "").join("\n");
    expect(runs).toMatch(/verify-provenance/);
    expect(runs).toMatch(/--mode warn/);
    expect(runs).not.toMatch(/--mode enforce/);
  });
  it("AC9 the child workflow runs the copied verifier in warn mode with no rks checkout", () => {
    const wf = yaml.load(CHILD_WORKFLOW_YAML);
    expect(wf.on).toHaveProperty("pull_request");
    expect(wf.on).toHaveProperty("push");
    const runs = Object.values(wf.jobs).flatMap((j) => j.steps).map((s) => s.run || "").join("\n");
    expect(runs).toMatch(/node \.github\/rks\/verify-provenance\.mjs/);
    expect(runs).toMatch(/--mode warn/);
    expect(CHILD_WORKFLOW_YAML).not.toMatch(/packages\/cli|routekit-shell/);
  });
  it("child paths are the documented ones", () => {
    expect(CHILD_WORKFLOW_PATH).toBe(".github/workflows/rks-provenance.yml");
    expect(CHILD_VERIFIER_PATH).toBe(".github/rks/verify-provenance.mjs");
  });
});
