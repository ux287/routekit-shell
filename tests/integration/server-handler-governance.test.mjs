/**
 * S9b governance handler family - integration tier (backlog.feat.server-mjs-governance-handler-family).
 * Pattern: tests/integration/server-handler-agent-bootstrap.test.mjs. createServer() + InMemoryTransport
 * against a remote-less os.tmpdir git fixture bound through ROUTEKIT_PROJECT_ROOT / ROUTEKIT_PROJECT_ID.
 * No case sets RKS_SKIP_PREFLIGHT: none of the seven has a preflight.mjs table entry (preflight.mjs:67-73).
 * Untokened calls reach the registry because _skipTokenValidation is true under NODE_ENV test
 * (server.mjs:2470); no case exercises the protected-tool refusal.
 * No quoted telemetry-package specifier appears in this file (telemetry-global-mock-triage).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const h = vi.hoisted(() => ({
  guardrailsOff: vi.fn(), guardrailsOn: vi.fn(), guardrailsAbort: vi.fn(), getSessionHistory: vi.fn(), commitAndPushNote: vi.fn(),
  runGitCheckout: vi.fn(), repairPhaseToIntegrated: vi.fn(),
}));
vi.mock("../../packages/mcp-rks/src/server/guardrails-audit.mjs", async (io) => ({ ...(await io()), guardrailsOff: h.guardrailsOff, guardrailsOn: h.guardrailsOn, guardrailsAbort: h.guardrailsAbort, getSessionHistory: h.getSessionHistory, commitAndPushNote: h.commitAndPushNote }));
vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", async (io) => ({ ...(await io()), runGitCheckout: h.runGitCheckout }));
vi.mock("../../packages/mcp-rks/src/workflow/auto-phase.mjs", async (io) => ({ ...(await io()), repairPhaseToIntegrated: h.repairPhaseToIntegrated }));

import { loadContext, getBranchConfig } from "../../packages/mcp-rks/src/server/project.mjs";
import { setProjectRoot, getSession } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { CO_AUTHOR_REJECTED_WARNING, coAuthorTrailer } from "../../packages/mcp-rks/src/shared/commit-attribution.mjs";
import { resolveNotesDir } from "../../packages/mcp-rks/src/dendron.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SELF_ABS = fileURLToPath(import.meta.url);
const STORY_NOTE = path.join(REPO_ROOT, "notes/backlog.feat.server-mjs-governance-handler-family.md");
const PROJECT_ID = "s9b-governance-int";
const DECLARED_BASE = "s9b-base";
const FEATURE = "feature/s9b-off-base";
const GIT_TIMEOUT_MS = 15_000;

// Fixture git helper: every spawnSync carries timeout (GI-TR11).
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
const isUnder = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// Expected bytes: the same committed build-base literals as the unit file, captured from the PRE-MOVE
// build-base server.mjs at commit b1ae5e490fefb33f5f94e39ed614b785f6524bce (git show
// <sha>:packages/mcp-rks/src/server.mjs, lines 2685, 2647 and 2644), pasted verbatim. The GI-TR7 error
// code was captured by running this file against the PRE-MOVE tree at the same sha (the client
// rejected with that code). GI-TR9 compares getSession(token).state with the value read just before each
// call; rks_phase_repair bypasses the chain state machine (COMMON_TOOLS, STATE_BYPASS_TOOLS), so no
// post-call state literal is captured.
const INVALID_ARCH_ROUND_DETAIL_AT_BASE = "arch_round must be a finite numeric scalar. Refusing rather than coercing to 0, which would silently restart the round counter and re-freeze the ledger.";
const SKIP_NOTE_AT_BASE = (currentBranch, integrationBranch) => ({ ok: false, skipped: true, reason: "not_on_integration_branch", currentBranch, integrationBranch });
const COMMIT_SUBJECT_AT_BASE = (storyId) => `chore(story): advance ${storyId} to integrated (rks_phase_repair)`;
const NOTE_NOT_FOUND_CODE_AT_BASE = -32602;

let fix;
let before;
let BASE;
let INTEGRATION;
let openToken = null;
const saved = {};

function repoSnapshot() {
  const scope = path.join(REPO_ROOT, ".rks", "active-scope.json");
  return {
    head: git(REPO_ROOT, ["rev-parse", "HEAD"]).trim(),
    branch: git(REPO_ROOT, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    porcelain: git(REPO_ROOT, ["status", "--porcelain"]),
    stashes: git(REPO_ROOT, ["stash", "list"]),
    hooksBak: fs.existsSync(path.join(REPO_ROOT, ".routekit", "hooks.bak")),
    scope: fs.existsSync(scope) ? fs.readFileSync(scope, "utf8") : null,
    guardState: fs.existsSync(path.join(REPO_ROOT, ".rks", "guardrails-state.json")),
    storyPhase: /^phase: .*$/m.exec(fs.readFileSync(STORY_NOTE, "utf8"))?.[0],
  };
}

beforeAll(async () => {
  expect(process.env.NODE_ENV).toBe("test");
  expect(process.env.RKS_SKIP_PREFLIGHT).not.toBe("1");
  before = repoSnapshot();
  fix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-s9b-gov-int-")));
  fs.mkdirSync(path.join(fix, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(fix, "notes"), { recursive: true });
  fs.writeFileSync(path.join(fix, ".rks", "project.json"), JSON.stringify({ id: PROJECT_ID, root: fix, kgFile: ".rks/kg.yaml", baseBranch: DECLARED_BASE }));
  fs.writeFileSync(path.join(fix, ".rks", "kg.yaml"), "{}\n");
  // Ignore everything but the two tracked files: notes, session and telemetry writes made during the
  // run never dirty the fixture worktree.
  fs.writeFileSync(path.join(fix, ".gitignore"), "*\n!.gitignore\n!a.txt\n");
  saved.root = process.env.ROUTEKIT_PROJECT_ROOT;
  saved.id = process.env.ROUTEKIT_PROJECT_ID;
  process.env.ROUTEKIT_PROJECT_ROOT = fix;
  process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;
  const ctx = await loadContext(PROJECT_ID);
  // Every moved body resolves the project root through loadContext; it must be the fixture, never the repo.
  expect(ctx.record.root).toBe(fix);
  BASE = ctx.projectJson?.baseBranch || "staging";
  INTEGRATION = getBranchConfig(ctx.record, ctx.projectJson).integration;
  git(fix, ["init", "-b", INTEGRATION]);
  git(fix, ["config", "user.email", "s9b@example.com"]);
  git(fix, ["config", "user.name", "S9b"]);
  git(fix, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(fix, "a.txt"), "a v1\n");
  git(fix, ["add", ".gitignore", "a.txt"]);
  git(fix, ["commit", "-m", "init"]);
  expect(git(fix, ["remote"]).trim()).toBe("");
  // Session persistence goes to the fixture, never to the real repository's .rks/.
  setProjectRoot(fix);
});

afterAll(() => {
  if (saved.root === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = saved.root;
  if (saved.id === undefined) delete process.env.ROUTEKIT_PROJECT_ID;
  else process.env.ROUTEKIT_PROJECT_ID = saved.id;
  if (fix) fs.rmSync(fix, { recursive: true, force: true });
});

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
});

async function rawCallTool(name, args) {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createServer();
  const client = new Client({ name: "s9b-governance", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close().catch(() => {});
  }
}
async function callTool(name, args) {
  const r = await rawCallTool(name, args);
  return JSON.parse(r.content?.[0]?.text ?? "");
}
const fixtureBranch = () => git(fix, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
function writeFixtureNote(id, extra = "") {
  const p = path.join(resolveNotesDir(fix), `${id}.md`);
  fs.writeFileSync(p, `---\nid: "${id}"\ntitle: "S9b"\ncreated: 1\nupdated: 2\nphase: "ready"\n${extra}---\n\n## Problem\n\nbody\n`);
  return p;
}

describe("S9b governance through createServer", { timeout: 30_000 }, () => {
  it("GI-TR1 fixture is remote-less, outside the repo, and the before snapshot is captured", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(process.env.ROUTEKIT_PROJECT_ROOT).toBe(fix);
    expect(process.env.ROUTEKIT_PROJECT_ID).toBe(PROJECT_ID);
    expect(git(fix, ["remote"]).trim()).toBe("");
    expect(isUnder(fs.realpathSync(fix), REPO_ROOT)).toBe(false);
    expect(BASE).toBe(DECLARED_BASE);
    expect(fixtureBranch()).toBe(INTEGRATION);
    expect(fs.existsSync(path.join(fix, "notes"))).toBe(true);
    expect(before.head).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof before.porcelain).toBe("string");
    expect(typeof before.stashes).toBe("string");
    expect(typeof before.hooksBak).toBe("boolean");
    expect(typeof before.guardState).toBe("boolean");
    expect(before.storyPhase).toMatch(/^phase: /);
    // Never set by this file: none of the seven has a preflight.mjs table entry.
    expect(fs.readFileSync(SELF_ABS, "utf8")).not.toMatch(new RegExp("process\\.env\\.RKS_SKIP_" + "PREFLIGHT\\s*="));
  });

  it("GI-TR2 rks_guardrails_off projection", async () => {
    const res = { ok: true, s9b: "off-through-createServer" };
    h.guardrailsOff.mockResolvedValueOnce(res);
    expect(await callTool("rks_guardrails_off", { projectId: PROJECT_ID, reason: "s9b reason", problemId: "backlog.feat.s9b-x" })).toEqual(res);
    expect(h.guardrailsOff).toHaveBeenCalledTimes(1);
    expect(h.guardrailsOff.mock.calls[0]).toEqual([fix, "s9b reason", "all", "backlog.feat.s9b-x", PROJECT_ID]);
  });

  it("GI-TR3 rks_guardrails_on projection and coAuthor rejection", async () => {
    const res = { ok: true, s9b: "on-through-createServer" };
    h.guardrailsOn.mockResolvedValue(res);
    expect(await callTool("rks_guardrails_on", { projectId: PROJECT_ID, detail: "full" })).toEqual(res);
    expect(h.guardrailsOn.mock.calls[0]).toEqual([fix, {}, PROJECT_ID]);

    await callTool("rks_guardrails_on", { projectId: PROJECT_ID, restoreFromTemplate: true });
    expect(h.guardrailsOn.mock.calls[1]).toEqual([fix, { restoreFromTemplate: true }, PROJECT_ID]);
    expect(Object.keys(h.guardrailsOn.mock.calls[1][1])).toEqual(["restoreFromTemplate"]);

    const rejected = "s9b-not-a-name-and-email";
    expect(coAuthorTrailer(rejected)).toBe("");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await callTool("rks_guardrails_on", { projectId: PROJECT_ID, coAuthor: rejected });
      expect(r).toEqual({ ...res, coAuthorRejected: true, coAuthorWarning: CO_AUTHOR_REJECTED_WARNING });
    } finally {
      errSpy.mockRestore();
    }
    expect(h.guardrailsOn).toHaveBeenCalledTimes(3);
  });

  it("GI-TR4 rks_guardrails_abort coercion", async () => {
    h.guardrailsAbort.mockResolvedValue({ ok: true, s9b: "abort" });
    expect(await callTool("rks_guardrails_abort", { projectId: PROJECT_ID })).toEqual({ ok: true, s9b: "abort" });
    expect(h.guardrailsAbort.mock.calls[0]).toEqual([fix, { discardPreExisting: false }, PROJECT_ID]);
    await callTool("rks_guardrails_abort", { projectId: PROJECT_ID, discardPreExisting: true });
    expect(h.guardrailsAbort.mock.calls[1]).toEqual([fix, { discardPreExisting: true }, PROJECT_ID]);
  });

  it("GI-TR5 rks_guardrails_status limit default", async () => {
    const history = { sessions: [{ id: "s9b-int" }] };
    h.getSessionHistory.mockReturnValue(history);
    expect(await callTool("rks_guardrails_status", { projectId: PROJECT_ID })).toEqual(history);
    expect(h.getSessionHistory.mock.calls[0]).toEqual([fix, 10]);
    expect(await callTool("rks_guardrails_status", { projectId: PROJECT_ID, limit: 1 })).toEqual(history);
    expect(h.getSessionHistory.mock.calls[1]).toEqual([fix, 1]);
  });

  it("GI-TR6 rks_phase_repair refusal, on-branch commit and off-branch skip", async () => {
    const storyId = "backlog.feat.s9b-int-repair";
    const ctx = await loadContext(PROJECT_ID);
    const integrationBranch = getBranchConfig(ctx.record, ctx.projectJson).integration;
    expect(integrationBranch).toBe(INTEGRATION);
    const headBefore = git(fix, ["rev-parse", "HEAD"]).trim();

    // Refusal: no note key, no commit, HEAD unchanged.
    h.repairPhaseToIntegrated.mockResolvedValueOnce({ repaired: false, reason: "s9b no evidence" });
    const refused = await callTool("rks_phase_repair", { projectId: PROJECT_ID, storyId });
    expect(h.repairPhaseToIntegrated).toHaveBeenCalledTimes(1);
    expect(h.repairPhaseToIntegrated.mock.calls[0]).toEqual([fix, storyId, PROJECT_ID, { integrationBranch }]);
    expect(refused).toEqual({ repaired: false, reason: "s9b no evidence" });
    expect(refused).not.toHaveProperty("note");
    expect(h.commitAndPushNote).not.toHaveBeenCalled();
    expect(git(fix, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);

    // Repaired on the integration branch: the real branch probe runs in the fixture.
    expect(fixtureBranch()).toBe(integrationBranch);
    const committed = { ok: true, commitId: "s9b0001", pushed: false };
    h.repairPhaseToIntegrated.mockResolvedValueOnce({ repaired: true });
    h.commitAndPushNote.mockReturnValueOnce(committed);
    const on = await callTool("rks_phase_repair", { projectId: PROJECT_ID, storyId });
    expect(h.commitAndPushNote).toHaveBeenCalledTimes(1);
    expect(h.commitAndPushNote.mock.calls[0]).toEqual([
      fix,
      path.join(resolveNotesDir(fix), `${storyId}.md`),
      integrationBranch,
      COMMIT_SUBJECT_AT_BASE(storyId),
    ]);
    expect(on.note).toEqual(committed);

    // Repaired on another branch: the build-base skip object, no commit.
    git(fix, ["checkout", "-b", FEATURE]);
    try {
      expect(fixtureBranch()).toBe(FEATURE);
      h.repairPhaseToIntegrated.mockResolvedValueOnce({ repaired: true });
      const off = await callTool("rks_phase_repair", { projectId: PROJECT_ID, storyId });
      expect(off.note).toEqual(SKIP_NOTE_AT_BASE(FEATURE, integrationBranch));
      expect(h.commitAndPushNote).toHaveBeenCalledTimes(1);
    } finally {
      git(fix, ["checkout", integrationBranch]);
      git(fix, ["branch", "-D", FEATURE]);
    }
    expect(fixtureBranch()).toBe(integrationBranch);
    expect(git(fix, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
  });

  it("GI-TR7 rks_arch_verdict Note not found and invalid_arch_round", async () => {
    const err = await rawCallTool("rks_arch_verdict", { projectId: PROJECT_ID, storyId: "backlog.feat.s9b-int-missing", findings: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("Note not found");
    expect(err.code).toBe(NOTE_NOT_FOUND_CODE_AT_BASE);

    const id = "backlog.feat.s9b-int-bad-round";
    const p = writeFixtureNote(id, 'arch_round: "abc"\n');
    const bytes = fs.readFileSync(p);
    const r = await callTool("rks_arch_verdict", { projectId: PROJECT_ID, storyId: id, findings: [] });
    expect(r).toEqual({ ok: false, error: "invalid_arch_round", field: "arch_round", value: "abc", storyId: id, detail: INVALID_ARCH_ROUND_DETAIL_AT_BASE });
    expect(fs.readFileSync(p).equals(bytes)).toBe(true);
  });

  it("GI-TR8 rks_governor_init response keys and branch correction", async () => {
    // Open flow, no problemId.
    const open = await callTool("rks_governor_init", { projectId: PROJECT_ID });
    expect(open.ok).toBe(true);
    expect(typeof open.token).toBe("string");
    expect(open.token.length).toBeGreaterThan(0);
    expect(typeof open.scopeFileRemoved).toBe("boolean");
    expect(Object.keys(open.scopeFileReconcile).sort()).toEqual(["reason", "removed"]);
    expect(open.scopeFileReconcile.removed).toBe(open.scopeFileRemoved);
    expect(open).toHaveProperty("orphanGuardrails");
    expect(open).not.toHaveProperty("branch");
    expect(h.runGitCheckout).not.toHaveBeenCalled();
    openToken = open.token;

    // Story flow off the base branch: the mocked checkout corrects, the real fixture branch does not move.
    const problemId = "backlog.feat.s9b-int-governor-init";
    writeFixtureNote(problemId);
    git(fix, ["checkout", "-b", FEATURE]);
    try {
      expect(fixtureBranch()).toBe(FEATURE);
      expect(FEATURE).not.toBe(BASE);
      expect(FEATURE.startsWith("rks/")).toBe(false);
      h.runGitCheckout.mockResolvedValueOnce({ ok: true });
      const story = await callTool("rks_governor_init", { projectId: PROJECT_ID, problemId });
      expect(story.ok).toBe(true);
      expect(h.runGitCheckout).toHaveBeenCalledTimes(1);
      expect(h.runGitCheckout.mock.calls[0][0]).toEqual({ projectRoot: fix, branch: BASE });
      expect(story.branchCorrected).toEqual({ from: FEATURE, to: BASE });
      expect(story.branch).toBe(BASE);
      expect(story.baseBranch).toBe(BASE);
      expect(fixtureBranch()).toBe(FEATURE);
    } finally {
      git(fix, ["checkout", INTEGRATION]);
      git(fix, ["branch", "-D", FEATURE]);
    }
    expect(fixtureBranch()).toBe(INTEGRATION);
  });

  it("GI-TR9 a tokened rks_phase_repair reaches the registry and leaves chain state unchanged (state-bypass tool; not a revert witness)", async () => {
    expect(typeof openToken).toBe("string");
    expect(getSession(openToken)).not.toBeNull();

    // Missing storyId: the moved body's zod parse throws.
    const stateBefore1 = getSession(openToken).state;
    const err = await rawCallTool("rks_phase_repair", { projectId: PROJECT_ID, _governorToken: openToken }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("storyId");
    expect(err.message).toContain("Required");
    expect(h.repairPhaseToIntegrated).not.toHaveBeenCalled();
    expect(getSession(openToken).state).toBe(stateBefore1);

    // Valid tokened call: reaches the mocked entry point exactly once, chain state unchanged.
    const stateBefore2 = getSession(openToken).state;
    h.repairPhaseToIntegrated.mockResolvedValueOnce({ repaired: false, reason: "s9b tokened" });
    const r = await callTool("rks_phase_repair", { projectId: PROJECT_ID, storyId: "backlog.feat.s9b-int-tokened", _governorToken: openToken });
    expect(h.repairPhaseToIntegrated).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ repaired: false, reason: "s9b tokened" });
    expect(getSession(openToken).state).toBe(stateBefore2);
  });

  it("GI-TR11 every subprocess spawn in this file carries an explicit timeout", () => {
    const src = fs.readFileSync(SELF_ABS, "utf8");
    const lines = src
      .split("\n")
      .map((l) => l.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g, '""'))
      .map((l) => { const i = l.indexOf("//"); return i === -1 ? l : l.slice(0, i); });
    const SPAWN_FAMILY_RE = /(?<![\w.])(spawnSync|spawn|execSync|execFileSync|execFile|exec|fork|execa)\s*\(/g;
    let calls = 0;
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(SPAWN_FAMILY_RE)) {
        if (/function\s+$/.test(lines[i].slice(0, m.index))) continue;
        calls++;
        // Collect the call text until its parentheses balance.
        let depth = 0;
        let text = "";
        outer: for (let j = i; j < lines.length; j++) {
          const seg = j === i ? lines[j].slice(m.index) : lines[j];
          for (const ch of seg) {
            text += ch;
            if (ch === "(") depth++;
            else if (ch === ")" && --depth === 0) break outer;
          }
          text += "\n";
        }
        expect(text, `line ${i + 1}`).toMatch(/\btimeout\s*:/);
      }
    }
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("GI-TR10 repository snapshot unchanged, entry points were only mocks, fixture removed", async () => {
    expect(repoSnapshot()).toEqual(before);
    expect(git(fix, ["remote"]).trim()).toBe("");
    for (const name of Object.keys(h)) expect(vi.isMockFunction(h[name]), name).toBe(true);
    // The module bindings the moved bodies resolve are the mocks, not the real entry points.
    const audit = await import("../../packages/mcp-rks/src/server/guardrails-audit.mjs");
    expect(audit.guardrailsOff).toBe(h.guardrailsOff);
    expect(audit.guardrailsOn).toBe(h.guardrailsOn);
    expect(audit.guardrailsAbort).toBe(h.guardrailsAbort);
    expect(audit.getSessionHistory).toBe(h.getSessionHistory);
    expect(audit.commitAndPushNote).toBe(h.commitAndPushNote);
    expect((await import("../../packages/mcp-rks/src/server/git-tools.mjs")).runGitCheckout).toBe(h.runGitCheckout);
    expect((await import("../../packages/mcp-rks/src/workflow/auto-phase.mjs")).repairPhaseToIntegrated).toBe(h.repairPhaseToIntegrated);
    // telemetry-global-mock-triage SPECIFIER_LITERAL (:89): no quoted or backticked telemetry specifier.
    expect(fs.readFileSync(SELF_ABS, "utf8")).not.toMatch(new RegExp("(['\"\\x60])@routekit" + "\\/telemetry(?:\\/[A-Za-z0-9._-]+)*\\1"));
    fs.rmSync(fix, { recursive: true, force: true });
    expect(fs.existsSync(fix)).toBe(false);
  });
});
