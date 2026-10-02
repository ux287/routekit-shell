/**
 * Witness for backlog.fix.governed-push-ahead-only-integration-branch — the GOVERNANCE half.
 *
 * Unit tier: no real subprocess. `child_process` is mocked (every spawn-family export this
 * path can reach is a vi.fn), server.mjs is imported ONCE (no vi.resetModules re-import),
 * and the handler is exercised behaviourally through createServer() + InMemoryTransport.
 *
 *  - AC2 / AC11: ops init + executing admit rks_sync_staging with no transition; the
 *    rks_git_push guardrails and every other flow are unchanged.
 *  - AC3: with a governor token (valid, or present-but-invalid under NODE_ENV=test) the
 *    handler forces push-only and refuses rebase/merge/auto before runSyncStaging runs.
 *  - AC4: the real runSyncStaging push-only path, driven by a scripted spawnSync mock,
 *    issues exactly `git push origin <sha>:refs/heads/<integration>` and reports from the
 *    recorded SHA and the observed remote ref (R8).
 *  - AC9 / AC12 / Schema / AC13.
 *
 * The real-git behavioural fixtures live in tests/integration/sync-staging-push-only.test.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const benign = () => ({ stdout: "", stderr: "", status: 0 });
  return {
    ...actual,
    spawnSync: vi.fn(benign),
    execSync: vi.fn(() => ""),
    execFileSync: vi.fn(() => ""),
  };
});

const runSyncStagingMock = vi.fn(async () => ({ ok: true, action: "none", mocked: true }));
vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runSyncStaging: runSyncStagingMock };
});

// loadContext is replaced so the handler receives these exact objects, which lets the test
// assert that context.record and context.projectJson reach runSyncStaging by identity.
const ctxHolder = { current: null };
const loadContextMock = vi.fn(async () => ctxHolder.current);
vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadContext: loadContextMock };
});

const { spawnSync } = await import("child_process");
const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
const { runSyncStaging } = await import("../../packages/mcp-rks/src/server/git/git-release.mjs");
const { checkStateAllowed, getStates } = await import("../../packages/mcp-rks/src/shared/governor-state.mjs");
const {
  OPS_FLOW_TOOLS,
  STORY_FLOW_TOOLS,
  OPEN_FLOW_TOOLS,
  createSession,
  resetToken,
} = await import("../../packages/mcp-rks/src/shared/governor-token.mjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const PROJECT_ID = "sync-staging-push-only-fixture";

let root;
beforeEach(() => {
  vi.clearAllMocks();
  resetToken();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-push-only-gov-"));
  ctxHolder.current = {
    record: { id: PROJECT_ID, root, branches: { working: "feature", integration: "dev", production: "main" } },
    projectJson: { id: PROJECT_ID, branches: { working: "feature", integration: "dev", production: "main" } },
  };
});

afterEach(() => {
  resetToken();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function withClient(fn) {
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function callSync(args) {
  return withClient(async (client) => {
    const r = await client.callTool({ name: "rks_sync_staging", arguments: args });
    const text = r?.content?.[0]?.text ?? "{}";
    try { return JSON.parse(text); } catch { return { raw: text, isError: r?.isError }; }
  });
}

const MUTATING_GIT_VERBS = new Set(["push", "pull", "rebase", "merge", "reset", "checkout", "commit", "fetch"]);
function mutatingGitCalls() {
  return spawnSync.mock.calls.filter(([cmd, args]) => cmd === "git" && Array.isArray(args) && MUTATING_GIT_VERBS.has(args[0]));
}

// ── AC2 / AC11 ─────────────────────────────────────────────────────────────

describe("AC2 — ops flow admits rks_sync_staging with no transition", () => {
  it("ops init and executing allow it, OPS_FLOW_TOOLS has it, and no transitions map names it", () => {
    expect(checkStateAllowed("ops", "init", "rks_sync_staging").allowed).toBe(true);
    expect(checkStateAllowed("ops", "executing", "rks_sync_staging").allowed).toBe(true);
    expect(OPS_FLOW_TOOLS.has("rks_sync_staging")).toBe(true);
    const ops = getStates("ops");
    for (const [name, def] of Object.entries(ops)) {
      expect(Object.keys(def.transitions || {}), `ops.${name}.transitions`).not.toContain("rks_sync_staging");
    }
  });
});

describe("AC11 — negative controls", () => {
  it("rks_git_push stays refused in ship init and in every ops state, and is not an ops flow tool", () => {
    expect(checkStateAllowed("ship", "init", "rks_git_push").allowed).toBe(false);
    for (const state of Object.keys(getStates("ops"))) {
      expect(checkStateAllowed("ops", state, "rks_git_push").allowed, `ops.${state}`).toBe(false);
    }
    expect(OPS_FLOW_TOOLS.has("rks_git_push")).toBe(false);
  });

  it("rks_sync_staging is not a story/open flow tool and is refused in every qa and ship state", () => {
    expect(STORY_FLOW_TOOLS.has("rks_sync_staging")).toBe(false);
    expect(OPEN_FLOW_TOOLS.has("rks_sync_staging")).toBe(false);
    for (const flow of ["qa", "ship"]) {
      for (const state of Object.keys(getStates(flow))) {
        expect(checkStateAllowed(flow, state, "rks_sync_staging").allowed, `${flow}.${state}`).toBe(false);
      }
    }
  });
});

// ── AC3 / AC9 / AC12 / Schema (handler, behavioural) ───────────────────────

describe("AC3 — a governor token locks the strategy to push-only", () => {
  it("valid ops token: strategy undefined and 'push-only' both call runSyncStaging with push-only", async () => {
    const { token } = createSession({ projectId: PROJECT_ID, flowType: "ops" });
    await callSync({ projectId: PROJECT_ID, _governorToken: token });
    await callSync({ projectId: PROJECT_ID, strategy: "push-only", _governorToken: token });
    expect(runSyncStagingMock).toHaveBeenCalledTimes(2);
    for (const [arg] of runSyncStagingMock.mock.calls) expect(arg.strategy).toBe("push-only");
  });

  it.each(["rebase", "merge", "auto"])("valid ops token: strategy '%s' is refused with a stable code and zero git mutation", async (strategy) => {
    const { token } = createSession({ projectId: PROJECT_ID, flowType: "ops" });
    const res = await callSync({ projectId: PROJECT_ID, strategy, _governorToken: token });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("strategy_not_allowed_under_governor");
    expect(res.requestedStrategy).toBe(strategy);
    expect(runSyncStagingMock).not.toHaveBeenCalled();
    expect(mutatingGitCalls()).toEqual([]);
  });

  it("present-but-invalid token under NODE_ENV=test still locks to push-only", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    await callSync({ projectId: PROJECT_ID, _governorToken: "not-a-real-token" });
    for (const strategy of ["rebase", "merge", "auto"]) {
      const res = await callSync({ projectId: PROJECT_ID, strategy, _governorToken: "not-a-real-token" });
      expect(res.ok).toBe(false);
    }
    expect(runSyncStagingMock).toHaveBeenCalledTimes(1);
    for (const [arg] of runSyncStagingMock.mock.calls) expect(arg.strategy).toBe("push-only");
  });
});

describe("AC9 — handler passes branch context through", () => {
  it("runSyncStaging receives context.record and context.projectJson by identity (integration 'dev')", async () => {
    const { token } = createSession({ projectId: PROJECT_ID, flowType: "ops" });
    await callSync({ projectId: PROJECT_ID, _governorToken: token });
    expect(runSyncStagingMock).toHaveBeenCalledTimes(1);
    const [arg] = runSyncStagingMock.mock.calls[0];
    expect(arg.projectRecord).toBe(ctxHolder.current.record);
    expect(arg.projectJson).toBe(ctxHolder.current.projectJson);
    expect(arg.projectRecord.branches.integration).toBe("dev");
    expect(arg.projectRoot).toBe(root);
  });
});

describe("AC12 — untokened handler behaviour is unchanged", () => {
  it("strategy undefined → auto; explicit rebase and merge pass through", async () => {
    await callSync({ projectId: PROJECT_ID });
    await callSync({ projectId: PROJECT_ID, strategy: "rebase" });
    await callSync({ projectId: PROJECT_ID, strategy: "merge" });
    expect(runSyncStagingMock.mock.calls.map(([a]) => a.strategy)).toEqual(["auto", "rebase", "merge"]);
  });
});

describe("Schema — both enum sites accept push-only", () => {
  it("advertised inputSchema enum includes push-only", async () => {
    const tools = await withClient((client) => client.listTools());
    const tool = tools.tools.find((t) => t.name === "rks_sync_staging");
    expect(tool).toBeTruthy();
    expect(tool.inputSchema.properties.strategy.enum).toEqual(expect.arrayContaining(["auto", "rebase", "merge", "push-only"]));
  });

  it("handler z.enum parses push-only (untokened push-only passes through, no zod failure)", async () => {
    const res = await callSync({ projectId: PROJECT_ID, strategy: "push-only" });
    expect(res.mocked).toBe(true);
    expect(runSyncStagingMock).toHaveBeenCalledTimes(1);
    expect(runSyncStagingMock.mock.calls[0][0].strategy).toBe("push-only");
  });
});

// ── AC4 (real runSyncStaging, scripted spawnSync) ──────────────────────────

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);

function scriptGit({ lsRemote = { stdout: `${SHA_A}\trefs/heads/staging\n`, status: 0 } } = {}) {
  let revParseCalls = 0;
  spawnSync.mockImplementation((cmd, args) => {
    const ok = (stdout = "") => ({ stdout, stderr: "", status: 0 });
    if (cmd !== "git") return ok();
    const [verb] = args;
    if (verb === "branch") return ok("staging\n");
    if (verb === "status") return ok("");
    if (verb === "fetch") return ok("");
    if (verb === "rev-parse") {
      revParseCalls += 1;
      // Any rev-parse AFTER the first simulates the branch moving before the push.
      return ok(`${revParseCalls === 1 ? SHA_A : SHA_B}\n`);
    }
    if (verb === "rev-list" && args.includes("--count")) return ok("2\t0\n");
    if (verb === "rev-list" && args.includes("--merges")) return ok("");
    if (verb === "log" && args.includes("--name-only")) return ok("\nnotes/backlog.x.md\n\nnotes/research.y.md\n");
    if (verb === "log") return ok(`${C1}\x1fdocs(backlog): x\n${C2}\x1fdocs(research): y\n`);
    if (verb === "diff") return ok("notes/backlog.x.md\nnotes/research.y.md\n");
    if (verb === "push") return ok("");
    if (verb === "ls-remote") return { stderr: "", ...lsRemote };
    return ok("");
  });
}

const gitCalls = (verb) => spawnSync.mock.calls.filter(([cmd, args]) => cmd === "git" && args[0] === verb).map(([, args]) => args);

describe("AC4 — push-only push argv and evidence-bound report (mocked spawnSync)", () => {
  it("issues exactly one push: ['push', 'origin', '<sha>:refs/heads/<integration>'] with no force of any kind", async () => {
    scriptGit();
    const res = await runSyncStaging({ projectRoot: root, strategy: "push-only" });
    expect(res.ok).toBe(true);
    expect(res.action).toBe("pushed");
    const pushes = gitCalls("push");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual(["push", "origin", `${SHA_A}:refs/heads/staging`]);
    for (const a of pushes[0]) {
      expect(["--force", "--force-with-lease", "-f"]).not.toContain(a);
      expect(a.startsWith("--force")).toBe(false);
      expect(a.startsWith("+")).toBe(false);
    }
    // The bare-branch form is not what push-only issues.
    expect(pushes[0]).not.toEqual(["push", "origin", "staging"]);
    // Every git spawn on this path carries a timeout.
    for (const [, , opts] of spawnSync.mock.calls) expect(typeof opts?.timeout).toBe("number");
  });

  it("R8: a moved branch after the SHA is recorded does not change the refspec or the report", async () => {
    scriptGit();
    const res = await runSyncStaging({ projectRoot: root, strategy: "push-only" });
    expect(res.ok).toBe(true);
    expect(res.sha).toBe(SHA_A);
    expect(gitCalls("push")[0][2]).toBe(`${SHA_A}:refs/heads/staging`);
    expect(res.pushed).toBe(2);
    expect(res.commits).toEqual([
      { sha: C1, subject: "docs(backlog): x" },
      { sha: C2, subject: "docs(research): y" },
    ]);
    expect(res.paths).toEqual(["notes/backlog.x.md", "notes/research.y.md"]);
    // Ranges are computed against the recorded SHA, never the moving branch ref or SHA_B.
    const flat = spawnSync.mock.calls.flatMap(([, args]) => args);
    expect(flat).not.toContain(SHA_B);
    expect(flat.some((a) => typeof a === "string" && a.includes(SHA_B))).toBe(false);
    expect(flat).toContain(`origin/staging..${SHA_A}`);
  });

  it("R8: remote-ref disagreement after the push yields ok=false carrying the observed SHA", async () => {
    scriptGit({ lsRemote: { stdout: `${SHA_B}\trefs/heads/staging\n`, status: 0 } });
    const res = await runSyncStaging({ projectRoot: root, strategy: "push-only" });
    expect(res.ok).toBe(false);
    expect(res.action).not.toBe("pushed");
    expect(res.remoteSha).toBe(SHA_B);
  });

  it("R8: a failed remote-ref read after the push yields ok=false", async () => {
    scriptGit({ lsRemote: { stdout: "", stderr: "fatal: unreachable", status: 128 } });
    const res = await runSyncStaging({ projectRoot: root, strategy: "push-only" });
    expect(res.ok).toBe(false);
    expect(res.action).not.toBe("pushed");
  });
});

// ── AC13 ───────────────────────────────────────────────────────────────────

describe("AC13 — ops SKILL.md names the governed publish path", () => {
  it("contains rks_sync_staging and push-only, with any projectId as the placeholder", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, ".claude/skills/ops/SKILL.md"), "utf8");
    expect(src).toContain("rks_sync_staging");
    expect(src).toContain("push-only");
    const lines = src.split("\n").filter((l) => l.includes("rks_sync_staging"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      for (const m of line.matchAll(/projectId\s*:\s*['"]([^'"]*)['"]/g)) {
        expect(m[1]).toBe("__RKS_SOURCE_PROJECT__");
      }
    }
  });
});
