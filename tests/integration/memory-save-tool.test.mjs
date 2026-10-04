/**
 * Witness for backlog.fix.hook-memory-skill-contradiction (route B1).
 *
 * rks_memory_save is a token-free MCP tool that writes ONLY notes/memories.<slug>.md
 * and commits it as `docs(memory): save <slug>`. commitAndEmbedNote refuses on
 * getProtectedBranches(projectRoot) in both of its forms. It does not read
 * .routekit/branch-policy.yaml.
 *
 * Evidence comes from git and from disk, not from the response envelope.
 * Every spawn carries an explicit timeout. Fixtures live in makeTempDir(); nothing
 * is written to the home directory or ~/.claude.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTempDir, initGitRepo } from "../helpers/tmp.mjs";
import { commitAndEmbedNote } from "../../packages/mcp-rks/src/shared/commit-and-embed-note.mjs";
import { isProtectedTool, UNPROTECTED_TOOLS } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { CHILD_RKS_ALLOW_TOOLS } from "../../packages/cli/src/project/child-permissions.mjs";

const SPAWN_TIMEOUT_MS = 15_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
const roots = [];

function git(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  return res.stdout;
}

function makeRepo(branch, { projectJson = null, branchPolicy = null } = {}) {
  const root = makeTempDir("memory-save-tool");
  roots.push(root);
  initGitRepo(root, { branch });
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  if (projectJson) {
    fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify(projectJson, null, 2));
  }
  if (branchPolicy) {
    fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
    fs.writeFileSync(path.join(root, ".routekit", "branch-policy.yaml"), branchPolicy);
  }
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "fixture");
  return root;
}

const head = (root) => git(root, "rev-parse", "HEAD").trim();
const subject = (root) => git(root, "show", "--format=%s", "--no-patch", "HEAD").trim();
const headPaths = (root) => git(root, "show", "--name-only", "--format=", "HEAD").trim().split("\n").filter(Boolean);
const porcelain = (root) => git(root, "status", "--porcelain").trim();

async function withClient(fn) {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
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

async function callSave(args) {
  // Fixture-root precondition. resolveProjectRoot (dendron.mjs) falls back to process.cwd(),
  // which under vitest is the shell repo, when ROUTEKIT_PROJECT_ROOT names a path that does
  // not exist. Assert the fixture exists before EVERY tool call so a missing fixture fails
  // here instead of writing into the real repository.
  const envRoot = process.env.ROUTEKIT_PROJECT_ROOT;
  expect(envRoot, "ROUTEKIT_PROJECT_ROOT must be set before rks_memory_save").toBeTruthy();
  expect(fs.existsSync(path.join(envRoot, ".git")), `fixture root ${envRoot} must exist`).toBe(true);
  expect(path.resolve(envRoot)).not.toBe(path.resolve(REPO_ROOT));
  return withClient(async (client) => {
    const r = await client.callTool({ name: "rks_memory_save", arguments: args });
    return JSON.parse(r?.content?.[0]?.text ?? "{}");
  });
}

afterEach(() => {
  if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
  while (roots.length) {
    try { fs.rmSync(roots.pop(), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe("AC1/AC3 — rks_memory_save registration and schema", () => {
  it("is advertised, with no path/filename/notePath input and no _governorToken", async () => {
    const { tools } = await withClient((client) => client.listTools());
    const tool = tools.find((t) => t.name === "rks_memory_save");
    expect(tool).toBeDefined();
    const props = Object.keys(tool.inputSchema.properties || {});
    expect(props).toEqual(expect.arrayContaining(["projectId", "slug", "content"]));
    for (const banned of ["path", "filename", "notePath", "_governorToken"]) {
      expect(props).not.toContain(banned);
    }
  });
});

describe("AC2 — token-free classification", () => {
  it("is unprotected and allow-classified for children", () => {
    expect(UNPROTECTED_TOOLS.has("rks_memory_save")).toBe(true);
    expect(isProtectedTool("rks_memory_save")).toBe(false);
    expect(CHILD_RKS_ALLOW_TOOLS).toContain("mcp__rks__rks_memory_save");
  });
});

describe("AC1/AC8 — save on an unprotected branch", () => {
  it("writes notes/memories.<slug>.md and commits exactly that path, without a token", async () => {
    const root = makeRepo("feature/memory");
    process.env.ROUTEKIT_PROJECT_ROOT = root;
    const res = await callSave({ projectId: "p", slug: "user-pref", content: "Prefers terse output.\n" });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(fs.existsSync(path.join(root, "notes", "memories.user-pref.md"))).toBe(true);
    expect(subject(root)).toBe("docs(memory): save user-pref");
    expect(headPaths(root)).toEqual(["notes/memories.user-pref.md"]);
    expect(res.commitId).toBe(head(root));
    const written = path.resolve(root, res.notePath);
    expect(written.startsWith(path.join(root, "notes") + path.sep)).toBe(true);
  });
});

describe("AC3 — slug validation", () => {
  it.each([["empty", ""], ["slash", "a/b"], ["backslash", "a\\b"], ["dotdot", ".."], ["leading dot", ".hidden"], ["whitespace", "   "]])(
    "refuses a %s slug, writing and committing nothing",
    async (_label, slug) => {
      const root = makeRepo("feature/memory");
      process.env.ROUTEKIT_PROJECT_ROOT = root;
      const before = head(root);
      const notesBefore = fs.readdirSync(path.join(root, "notes")).sort();
      const res = await callSave({ projectId: "p", slug, content: "x\n" });
      expect(res.ok).toBe(false);
      expect(head(root)).toBe(before);
      expect(porcelain(root)).toBe("");
      expect(fs.readdirSync(path.join(root, "notes")).sort()).toEqual(notesBefore);
    },
  );
});

describe("AC4 — legacy form refuses on a protected branch", () => {
  it("refuses on main before writing, naming the branch", async () => {
    const root = makeRepo("main");
    const before = head(root);
    const res = await commitAndEmbedNote({ projectRoot: root, slug: "blocked", content: "x\n" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("main");
    expect(fs.existsSync(path.join(root, "notes", "memories.blocked.md"))).toBe(false);
    expect(head(root)).toBe(before);
    expect(porcelain(root)).toBe("");
  });

  it("positive control: the same call commits on a feature branch", async () => {
    const root = makeRepo("feature/x");
    const res = await commitAndEmbedNote({ projectRoot: root, slug: "allowed", content: "x\n" });
    expect(res.ok).toBe(true);
    expect(res.commitId).toBe(head(root));
  });
});

describe("AC5 — general form refuses on a protected branch", () => {
  it("returns commitOk false with commitError naming main, and makes no commit", async () => {
    const root = makeRepo("main");
    const rel = "notes/backlog.fix.fixture.md";
    fs.writeFileSync(path.join(root, rel), "---\nid: backlog.fix.fixture\n---\nbody\n");
    const before = head(root);
    const res = await commitAndEmbedNote({ projectRoot: root, notePath: rel, commitMessage: "docs(backlog): create backlog.fix.fixture" });
    expect(res.commitOk).toBe(false);
    expect(res.writeOk).toBe(true);
    expect(res.commitError).toContain("main");
    expect(head(root)).toBe(before);
  });

  it("skipCommit still short-circuits on a protected branch", async () => {
    const root = makeRepo("main");
    const rel = "notes/backlog.fix.skip.md";
    fs.writeFileSync(path.join(root, rel), "---\nid: backlog.fix.skip\n---\nbody\n");
    const res = await commitAndEmbedNote({ projectRoot: root, notePath: rel, commitMessage: "docs(backlog): create backlog.fix.skip", skipCommit: true });
    expect(res.ok).toBe(true);
    expect(res.skipped).toBe(true);
  });
});

describe("AC6 — topology, not branch-policy.yaml", () => {
  it("default config: a save on staging commits", async () => {
    const root = makeRepo("staging");
    const res = await commitAndEmbedNote({ projectRoot: root, slug: "on-staging", content: "x\n" });
    expect(res.ok).toBe(true);
    expect(res.commitId).toBe(head(root));
  });

  const THREE = { branches: { working: "dev", integration: "staging", production: "main" } };
  const POLICY = "block_direct_commits_to:\n  - dev\n";

  it("three-branch config: dev commits even when branch-policy.yaml blocks it", async () => {
    const root = makeRepo("dev", { projectJson: THREE, branchPolicy: POLICY });
    const res = await commitAndEmbedNote({ projectRoot: root, slug: "on-dev", content: "x\n" });
    expect(res.ok).toBe(true);
    expect(subject(root)).toBe("docs(memory): save on-dev");
  });

  it("three-branch config: staging is refused", async () => {
    const root = makeRepo("staging", { projectJson: THREE });
    const before = head(root);
    const res = await commitAndEmbedNote({ projectRoot: root, slug: "on-int", content: "x\n" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("staging");
    expect(head(root)).toBe(before);
  });
});

describe("AC7 — /memory skill Step 1 uses the MCP tool", () => {
  const skillSrc = () => fs.readFileSync(path.join(REPO_ROOT, ".claude", "skills", "memory", "SKILL.md"), "utf8");

  it("names mcp__rks__rks_memory_save and carries no node -e wrapper", () => {
    const src = skillSrc();
    expect(src).toContain("mcp__rks__rks_memory_save");
    expect(src).not.toContain("node -e");
    expect(src).not.toContain("commit-and-embed-note.mjs");
  });

  it("passes the distributed-skill sentinel in projectId VALUE position on the invocation line", () => {
    // VALUE position (projectId: '...') is what skill-distribution-invariants INVARIANT 4b admits;
    // any other occurrence of the sentinel is a mention and reds that suite.
    const line = skillSrc().split("\n").find((l) => l.includes("mcp__rks__rks_memory_save("));
    expect(line).toBeDefined();
    expect(line).toMatch(/projectId:\s*'__RKS_SOURCE_PROJECT__'/);
  });
});

// ── AC3/AC10/AC11 (added after ARCH round 1) ─────────────────────────────────────
// SAFETY: the ONLY injection payload is `touch PWNED`, a relative path resolved against the
// git cwd, which is always the makeTempDir() fixture. If the fix regresses, the failure mode
// is a marker file inside the temp fixture, never a destructive command.

const PAYLOAD_SLUGS = [
  ["command substitution", "$(touch PWNED)"],
  ["backtick", "a`touch PWNED`b"],
  ["semicolon", "a;touch PWNED"],
  ["newline", "a\ntouch PWNED"],
  ["space", "a b"],
];

function expectNoPwned(root) {
  for (const dir of [root, path.join(root, "notes"), process.cwd()]) {
    expect(fs.existsSync(path.join(dir, "PWNED")), `PWNED artifact in ${dir}`).toBe(false);
  }
}

const memoryNotes = (root) => fs.readdirSync(path.join(root, "notes")).filter((n) => n.startsWith("memories."));
// -z: NUL-separated, so paths holding `$`, a backtick or a space are never quoted by core.quotePath.
const headPathsZ = (root) =>
  git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD").split("\0").filter(Boolean).sort();

function expectRefusedCleanly(root, res, before) {
  expect(res.ok).toBe(false);
  expect(memoryNotes(root)).toEqual([]);
  expect(head(root)).toBe(before);
  expect(porcelain(root)).toBe("");
  expectNoPwned(root);
}

describe("AC3/AC10 — shell-metacharacter slugs are refused and never execute", () => {
  it.each(PAYLOAD_SLUGS)("rks_memory_save refuses a %s slug", async (_label, slug) => {
    const root = makeRepo("feature/memory");
    process.env.ROUTEKIT_PROJECT_ROOT = root;
    const before = head(root);
    const res = await callSave({ projectId: "p", slug, content: "x\n" });
    expectRefusedCleanly(root, res, before);
  });

  it.each(PAYLOAD_SLUGS)("a direct legacy commitAndEmbedNote call refuses a %s slug", async (_label, slug) => {
    const root = makeRepo("feature/memory");
    const before = head(root);
    const res = await commitAndEmbedNote({ projectRoot: root, slug, content: "x\n" });
    expectRefusedCleanly(root, res, before);
  });

  it("positive control: a dotted slug is accepted", async () => {
    const root = makeRepo("feature/memory");
    process.env.ROUTEKIT_PROJECT_ROOT = root;
    const res = await callSave({ projectId: "p", slug: "2026.10.02.user-pref", content: "x\n" });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(root, "notes", "memories.2026.10.02.user-pref.md"))).toBe(true);
    expect(subject(root)).toBe("docs(memory): save 2026.10.02.user-pref");
    expect(res.commitId).toBe(head(root));
  });
});

describe("AC10 — general form never passes a path or message through a shell", () => {
  const SUB = "notes/$(touch PWNED).md";
  const TICK = "notes/a`touch PWNED`b.md";
  const put = (root, rel) => fs.writeFileSync(path.join(root, rel), "---\nid: fixture\n---\nbody\n");

  it.each([[SUB], [TICK]])("notePath %s is committed literally on the skipEmbed path", async (rel) => {
    const root = makeRepo("feature/general");
    put(root, rel);
    const res = await commitAndEmbedNote({ projectRoot: root, notePath: rel, commitMessage: "docs(notes): create fixture", skipEmbed: true });
    expect(res.commitOk).toBe(true);
    expect(headPathsZ(root)).toEqual([rel]);
    expectNoPwned(root);
  });

  it.each([[true], [false]])("an extraStagePaths entry holding a backtick is committed literally (skipEmbed %s)", async (skipEmbed) => {
    const root = makeRepo("feature/general");
    const main = "notes/plain.md";
    put(root, main);
    put(root, TICK);
    // commitAndEmbedNoteGeneral never stages extraStagePaths: it only adds them to its write
    // set and stages notePath alone. Staging extras is the caller's job (commitDendronWriteResult
    // in server.mjs), and the rename witness in commit-and-embed-note.test.mjs pre-stages its
    // extra the same way. Stage it here with argv git (the git() helper carries the timeout).
    git(root, "add", "--", TICK);
    expect(git(root, "diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean)).toEqual([TICK]);
    expectNoPwned(root);
    const res = await commitAndEmbedNote({
      projectRoot: root, notePath: main, commitMessage: "docs(notes): edit plain", extraStagePaths: [TICK], skipEmbed,
    });
    expect(res.commitOk).toBe(true);
    expect(headPathsZ(root)).toEqual([main, TICK].sort());
    expectNoPwned(root);
  });

  it("a commit message holding $(...) and a backtick is committed verbatim", async () => {
    const root = makeRepo("feature/general");
    const rel = "notes/msg.md";
    put(root, rel);
    const msg = "docs(notes): edit msg $(touch PWNED) `touch PWNED`";
    const res = await commitAndEmbedNote({ projectRoot: root, notePath: rel, commitMessage: msg, skipEmbed: true });
    expect(res.commitOk).toBe(true);
    expect(git(root, "log", "-1", "--format=%B").trim()).toBe(msg);
    expectNoPwned(root);
  });
});

describe("AC10 — source: no shell-interpolated git on the note write path", () => {
  it("commit-and-embed-note.mjs uses argv git calls", () => {
    const helper = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/shared/commit-and-embed-note.mjs"), "utf8");
    expect(helper).not.toMatch(/execSync\(\s*`git (add|diff|commit)\b/);
    expect(helper).toMatch(/execFileSync\(\s*["']git["']/);
  });

  it("commitDendronWriteResult stages extraStagePaths with argv git and holds no shell call", () => {
    const server = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server.mjs"), "utf8");
    const start = server.indexOf("async function commitDendronWriteResult(");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = server.indexOf("\n}\n", start); // the function's top-level closing brace
    expect(end).toBeGreaterThan(start);
    const body = server.slice(start, end);
    // Positive controls: the slice IS the function that stages extras and delegates the commit,
    // and it stops before the plan-phase advance (server.mjs:2483), which is out of scope.
    expect(body).toContain("extraStagePaths");
    expect(body).toContain("commitAndEmbedNote(");
    expect(body).not.toContain("advance ${");
    // Any shell call in the body fails, including a template that drops JSON.stringify.
    expect(body).not.toMatch(/\bexecSync\(/);
    expect(body).toMatch(/execFileSync\(\s*["']git["']\s*,\s*\[\s*["']add["']\s*,\s*["']--["']/);
    expect(server).not.toContain("execSync(`git add ${JSON.stringify(extra)}");
  });
});

describe("AC11 — projectId does not select the write root", () => {
  // An UNREGISTERED id only: a registered id would make a mis-implementation commit into a
  // real repository on this machine. A registry-resolved root (loadContext) cannot resolve an
  // unregistered id, so ok:true with a commit in the env root discriminates the two designs.
  it("writes and commits in ROUTEKIT_PROJECT_ROOT whatever projectId says", async () => {
    const root = makeRepo("feature/memory");
    process.env.ROUTEKIT_PROJECT_ROOT = root;
    const before = head(root);
    const res = await callSave({ projectId: "memory-save-unregistered-fixture-id", slug: "env-root", content: "x\n" });
    expect(res.ok).toBe(true);
    expect(head(root)).not.toBe(before);
    expect(res.commitId).toBe(head(root));
    expect(headPathsZ(root)).toEqual(["notes/memories.env-root.md"]);
  });
});
