// backlog.feat.remote-inbox-owner-review
// Temp git repo fixture: current branch staging, branch grok-spike carrying two
// notes/inbox.grokbot.*.md notes, and a linked worktree checked out on grok-spike.
// Every spawnSync passes timeout. core.hooksPath is set explicitly in the temp repo so a
// user-global hooksPath can neither add hooks nor bypass the fixture's failing hook.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inboxActor,
  validateAcceptTarget,
  INBOX_DECISIONS_PATH,
} from "../../packages/mcp-rks/src/shared/inbox-review.mjs";
import { registerInboxHandlers } from "../../packages/mcp-rks/src/server/handlers/inbox.mjs";
import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { decideLane, REMOTE_LANE_TOOLS } from "../../packages/mcp-rks/src/shared/lane-policy.mjs";
import {
  isProtectedTool,
  OPEN_FLOW_TOOLS,
  STORY_FLOW_TOOLS,
  checkAllowedTool,
  createSession,
  resetToken,
} from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { getStates } from "../../packages/mcp-rks/src/shared/governor-state.mjs";
import { getProtectedBranches } from "../../packages/mcp-rks/src/server/branch-protection.mjs";
import { TOOL_AGENTS } from "../../packages/mcp-rks/src/llm/claude-cli/subscription-status.mjs";
import {
  CHILD_RKS_ALLOW_TOOLS,
  CHILD_RKS_PROMPT_TOOLS,
  CHILD_RKS_ASK_RULES,
} from "../../packages/cli/src/project/child-permissions.mjs";
import { TOOL_ARG_SCHEMAS } from "../../packages/mcp-rks/src/server.mjs";

const TOOL = "rks_inbox_review";
const GIT_TIMEOUT_MS = 15_000;
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const NOTE_A = "inbox.grokbot.spike-test";
const NOTE_B = "inbox.grokbot.2026-11-09-remote-lane-test";
const noteBody = (title, extra = "") => `\n# ${title}\n\nRemote-authored body for ${title}.\n${extra}`;
const noteText = (id, title, extra) => `---\nid: "${id}"\ntitle: "${title}"\ndesc: ""\n---\n${noteBody(title, extra)}`;

/** Split a note at the closing frontmatter fence: [frontmatter text, body bytes]. */
function splitAtFence(raw) {
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!m) return [null, raw];
  return [m[1], raw.slice(m[0].length)];
}

let tmp;
let repo;
let worktree;
let commitA;
let commitB;

function makeFixture() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-inbox-review-"));
  repo = path.join(tmp, "repo");
  worktree = path.join(tmp, "remote-wt");
  fs.mkdirSync(path.join(repo, "notes"), { recursive: true });
  git(repo, ["init", "-q", "-b", "staging"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Inbox Test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
  git(repo, ["config", "core.hooksPath", path.join(repo, ".git", "hooks")]);
  fs.writeFileSync(path.join(repo, "notes", "base.md"), noteText("base", "Base"));
  git(repo, ["add", "--", "notes/base.md"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["checkout", "-q", "-b", "grok-spike"]);
  fs.writeFileSync(path.join(repo, "notes", `${NOTE_A}.md`), noteText(NOTE_A, "Spike test"));
  git(repo, ["add", "--", `notes/${NOTE_A}.md`]);
  git(repo, ["commit", "-q", "-m", `docs(notes): create ${NOTE_A}`]);
  commitA = git(repo, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repo, "notes", `${NOTE_B}.md`), noteText(NOTE_B, "Remote lane test"));
  git(repo, ["add", "--", `notes/${NOTE_B}.md`]);
  git(repo, ["commit", "-q", "-m", `docs(notes): create ${NOTE_B}`]);
  commitB = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-q", "staging"]);
  git(repo, ["worktree", "add", "-q", worktree, "grok-spike"]);
}

function snapshot() {
  return {
    head: git(repo, ["rev-parse", "HEAD"]),
    branch: git(repo, ["branch", "--show-current"]),
    status: git(repo, ["status", "--porcelain"]),
    refs: git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
  };
}

function worktreeFiles() {
  const out = {};
  for (const name of fs.readdirSync(path.join(worktree, "notes")).sort()) {
    out[name] = fs.readFileSync(path.join(worktree, "notes", name), "utf8");
  }
  return { files: out, status: git(worktree, ["status", "--porcelain"]), head: git(worktree, ["rev-parse", "HEAD"]) };
}

function commitCount() {
  return Number(git(repo, ["rev-list", "--count", "HEAD"]));
}

function readLedger() {
  const p = path.join(repo, INBOX_DECISIONS_PATH);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8")).decisions;
}

function makeCaller() {
  const registry = createHandlerRegistry();
  registerInboxHandlers(registry, { inboxReviewSchema: TOOL_ARG_SCHEMAS[TOOL] }, {
    getDendronContext: () => ({ projectRoot: repo, notesDir: path.join(repo, "notes") }),
  });
  const handler = registry.lookupHandler(TOOL);
  return async (args) => {
    const res = await handler(args, Object.freeze({ tool: TOOL, args }));
    return JSON.parse(res.content[0].text);
  };
}

describe("inboxActor", () => {
  it("returns the actor for inbox.<actor>.<rest> and null otherwise", () => {
    expect(inboxActor("inbox.grokbot.spike-test")).toBe("grokbot");
    for (const n of ["research.x", "inbox.", "inbox.grokbot", "inbox.grokbot."]) expect(inboxActor(n), n).toBeNull();
  });
});

describe("validateAcceptTarget", () => {
  it("refuses inbox. and empty targets and accepts a non-inbox name", () => {
    expect(validateAcceptTarget("inbox.grokbot.x")).toEqual({ ok: false, reason: "target_in_inbox" });
    expect(validateAcceptTarget("  ")).toEqual({ ok: false, reason: "target_missing" });
    expect(validateAcceptTarget("")).toEqual({ ok: false, reason: "target_missing" });
    expect(validateAcceptTarget("research.2026.11.09.x")).toEqual({ ok: true });
  });
});

describe("rks_inbox_review fixture", () => {
  beforeEach(() => makeFixture());
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("treats staging as unprotected in the temp repo (no .rks/project.json), so the happy-path accept is not refused", () => {
    expect(fs.existsSync(path.join(repo, ".rks", "project.json"))).toBe(false);
    const protectedBranches = getProtectedBranches(repo);
    expect(protectedBranches).toContain("main");
    expect(protectedBranches).not.toContain("staging");
    expect(git(repo, ["config", "core.hooksPath"])).toBe(path.join(repo, ".git", "hooks"));
  });
});

describe("rks_inbox_review list", () => {
  beforeEach(() => makeFixture());
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("returns both inbox.grokbot notes with filename, actor and adding commit", async () => {
    const call = makeCaller();
    const r = await call({ action: "list", branch: "grok-spike" });
    expect(r.ok).toBe(true);
    const notes = [...r.notes].sort((a, b) => a.filename.localeCompare(b.filename));
    expect(notes.map((n) => n.filename)).toEqual([NOTE_B, NOTE_A].sort());
    const byName = Object.fromEntries(notes.map((n) => [n.filename, n]));
    expect(byName[NOTE_A]).toMatchObject({ filename: NOTE_A, actor: "grokbot", commit: commitA });
    expect(byName[NOTE_B]).toMatchObject({ filename: NOTE_B, actor: "grokbot", commit: commitB });
    expect(byName[NOTE_A].heading).toBe("Spike test");
  });

  it("makes no worktree, index or ref change", async () => {
    const call = makeCaller();
    const before = snapshot();
    const wtBefore = worktreeFiles();
    const r = await call({ action: "list", branch: "grok-spike" });
    expect(r.ok).toBe(true);
    expect(snapshot()).toEqual(before);
    expect(worktreeFiles()).toEqual(wtBefore);
  });

  it("refuses a branch that does not exist", async () => {
    const call = makeCaller();
    const r = await call({ action: "list", branch: "no-such-branch" });
    expect(r).toMatchObject({ ok: false, reason: "branch_not_found" });
  });
});

describe("rks_inbox_review accept", () => {
  beforeEach(() => makeFixture());
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const TARGET = "research.2026.11.09.spike-test";

  it("writes the note under targetFilename with the source body and id rewritten", async () => {
    const call = makeCaller();
    const r = await call({ action: "accept", branch: "grok-spike", filename: NOTE_A, targetFilename: TARGET });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const written = fs.readFileSync(path.join(repo, "notes", `${TARGET}.md`), "utf8");
    // Untrimmed bytes of the source note at the branch tip.
    const sourceRaw = spawnSync("git", ["cat-file", "blob", `grok-spike:notes/${NOTE_A}.md`], { cwd: repo, encoding: "utf8", timeout: GIT_TIMEOUT_MS }).stdout;
    expect(sourceRaw.length).toBeGreaterThan(0);
    const [fmWritten, bodyWritten] = splitAtFence(written);
    const [, bodySource] = splitAtFence(sourceRaw);
    expect(fmWritten).not.toBeNull();
    expect(Buffer.compare(Buffer.from(bodyWritten), Buffer.from(bodySource))).toBe(0);
    expect(fmWritten).toMatch(new RegExp(`^id: "?${TARGET.replace(/\./g, "\\.")}"?$`, "m"));
    expect(fmWritten).not.toContain(NOTE_A);
    // Committed on the current branch, not just on disk.
    expect(git(repo, ["ls-tree", "--name-only", "HEAD", "--", `notes/${TARGET}.md`])).toBe(`notes/${TARGET}.md`);
    expect(git(repo, ["branch", "--show-current"])).toBe("staging");
  });

  it("creates one commit naming source branch, source commit and original filename", async () => {
    const call = makeCaller();
    const before = commitCount();
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const r = await call({ action: "accept", branch: "grok-spike", filename: NOTE_A, targetFilename: TARGET });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(commitCount()).toBe(before + 1);
    expect(git(repo, ["rev-parse", "HEAD~1"])).toBe(headBefore);
    expect(r.commit).toBe(git(repo, ["rev-parse", "HEAD"]));
    const msg = git(repo, ["log", "-1", "--format=%B"]);
    expect(msg.split("\n")[0]).toBe(`docs(notes): accept ${NOTE_A} as ${TARGET}`);
    expect(msg).toMatch(/^Inbox-Source-Branch: grok-spike$/m);
    expect(msg).toMatch(new RegExp(`^Inbox-Source-Commit: ${commitA}$`, "m"));
    expect(msg).toMatch(new RegExp(`^Inbox-Source-File: ${NOTE_A.replace(/\./g, "\\.")}$`, "m"));
    expect(msg).toMatch(/Rks-Provenance:.*rks_inbox_review/);
    // Exactly the target path changed in that commit.
    expect(git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe(`notes/${TARGET}.md`);
    // Ledger written after the commit was observed.
    const ledger = readLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ branch: "grok-spike", filename: NOTE_A, decision: "accept", targetFilename: TARGET, commit: r.commit });
    expect(ledger[0].blob).toBe(git(repo, ["rev-parse", `grok-spike:notes/${NOTE_A}.md`]));
  });

  it("leaves the source branch tip and linked worktree unchanged", async () => {
    const call = makeCaller();
    const tipBefore = git(repo, ["rev-parse", "grok-spike"]);
    const wtBefore = worktreeFiles();
    const r = await call({ action: "accept", branch: "grok-spike", filename: NOTE_A, targetFilename: TARGET });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(git(repo, ["rev-parse", "grok-spike"])).toBe(tipBefore);
    expect(worktreeFiles()).toEqual(wtBefore);
  });
});

describe("rks_inbox_review accept refusals", () => {
  beforeEach(() => makeFixture());
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function assertNothingWritten(before, notesBefore) {
    expect(commitCount()).toBe(before.count);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(git(repo, ["status", "--porcelain"])).toBe(before.status);
    expect(fs.readdirSync(path.join(repo, "notes")).sort()).toEqual(notesBefore);
  }
  const capture = () => ({ count: commitCount(), head: git(repo, ["rev-parse", "HEAD"]), status: git(repo, ["status", "--porcelain"]) });
  const notesList = () => fs.readdirSync(path.join(repo, "notes")).sort();

  it("refuses a targetFilename starting with inbox. and writes nothing", async () => {
    const call = makeCaller();
    const before = capture();
    const notesBefore = notesList();
    const r = await call({ action: "accept", branch: "grok-spike", filename: NOTE_A, targetFilename: "inbox.grokbot.accepted" });
    expect(r).toMatchObject({ ok: false, reason: "target_in_inbox" });
    assertNothingWritten(before, notesBefore);
    expect(readLedger()).toEqual([]);
  });

  it("refuses an existing targetFilename and writes nothing", async () => {
    const call = makeCaller();
    const basePath = path.join(repo, "notes", "base.md");
    const baseBytes = fs.readFileSync(basePath);
    const before = capture();
    const notesBefore = notesList();
    const r = await call({ action: "accept", branch: "grok-spike", filename: NOTE_A, targetFilename: "base" });
    expect(r).toMatchObject({ ok: false, reason: "target_exists" });
    expect(Buffer.compare(fs.readFileSync(basePath), baseBytes)).toBe(0);
    assertNothingWritten(before, notesBefore);
    expect(readLedger()).toEqual([]);
  });

  it("refuses a filename that is not an inbox note present at branch and writes nothing", async () => {
    const call = makeCaller();
    const before = capture();
    const notesBefore = notesList();
    const notInbox = await call({ action: "accept", branch: "grok-spike", filename: "base", targetFilename: "research.x" });
    expect(notInbox).toMatchObject({ ok: false, reason: "not_inbox_note" });
    const absent = await call({ action: "accept", branch: "grok-spike", filename: "inbox.grokbot.never-written", targetFilename: "research.x" });
    expect(absent).toMatchObject({ ok: false, reason: "source_not_found" });
    assertNothingWritten(before, notesBefore);
    expect(readLedger()).toEqual([]);
  });

  it("refuses accept off the working branch or from the current branch and writes nothing", async () => {
    const call = makeCaller();
    // branch === current branch (staging, the working branch).
    let before = capture();
    let notesBefore = notesList();
    const same = await call({ action: "accept", branch: "staging", filename: NOTE_A, targetFilename: "research.x" });
    expect(same).toMatchObject({ ok: false, reason: "source_is_current_branch" });
    assertNothingWritten(before, notesBefore);
    // Off the configured working branch (default working: staging).
    git(repo, ["checkout", "-q", "-b", "feature-x"]);
    before = capture();
    notesBefore = notesList();
    const off = await call({ action: "accept", branch: "grok-spike", filename: NOTE_A, targetFilename: "research.x" });
    expect(off).toMatchObject({ ok: false, reason: "not_on_working_branch" });
    assertNothingWritten(before, notesBefore);
    expect(readLedger()).toEqual([]);
  });

  it("writes no ledger entry when the commit is not observed", async () => {
    const call = makeCaller();
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(hook, 0o755);
    const before = capture();
    const notesBefore = notesList();
    const r = await call({ action: "accept", branch: "grok-spike", filename: NOTE_A, targetFilename: "research.x" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("commit_not_observed");
    assertNothingWritten(before, notesBefore);
    expect(readLedger().filter((e) => e.filename === NOTE_A)).toEqual([]);
    fs.rmSync(hook);
    const listed = await call({ action: "list", branch: "grok-spike" });
    expect(listed.notes.map((n) => n.filename)).toContain(NOTE_A);
  });
});

describe("rks_inbox_review list after decisions", () => {
  beforeEach(() => makeFixture());
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("an accepted note is no longer listed", async () => {
    const call = makeCaller();
    const r = await call({ action: "accept", branch: "grok-spike", filename: NOTE_A, targetFilename: "research.spike-test" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const listed = await call({ action: "list", branch: "grok-spike" });
    expect(listed.notes.map((n) => n.filename)).toEqual([NOTE_B]);
  });

  it("a discarded note is no longer listed and the branch tip is unchanged", async () => {
    const call = makeCaller();
    const tipBefore = git(repo, ["rev-parse", "grok-spike"]);
    const wtBefore = worktreeFiles();
    const r = await call({ action: "discard", branch: "grok-spike", filename: NOTE_B });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const listed = await call({ action: "list", branch: "grok-spike" });
    expect(listed.notes.map((n) => n.filename)).toEqual([NOTE_A]);
    expect(git(repo, ["rev-parse", "grok-spike"])).toBe(tipBefore);
    expect(worktreeFiles()).toEqual(wtBefore);
  });

  it("discard writes one ledger entry and no commit", async () => {
    const call = makeCaller();
    const before = commitCount();
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const r = await call({ action: "discard", branch: "grok-spike", filename: NOTE_B });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(commitCount()).toBe(before);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
    const ledger = readLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      branch: "grok-spike",
      filename: NOTE_B,
      decision: "discard",
      blob: git(repo, ["rev-parse", `grok-spike:notes/${NOTE_B}.md`]),
    });
  });

  it("a discarded note rewritten on the branch is listed again", async () => {
    const call = makeCaller();
    const r = await call({ action: "discard", branch: "grok-spike", filename: NOTE_B });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((await call({ action: "list", branch: "grok-spike" })).notes.map((n) => n.filename)).toEqual([NOTE_A]);
    // The remote rewrites the note in its own worktree (new blob sha).
    fs.writeFileSync(path.join(worktree, "notes", `${NOTE_B}.md`), noteText(NOTE_B, "Remote lane test", "\nRewritten.\n"));
    git(worktree, ["add", "--", `notes/${NOTE_B}.md`]);
    git(worktree, ["commit", "-q", "-m", `docs(notes): edit ${NOTE_B}`]);
    const newBlob = git(repo, ["rev-parse", `grok-spike:notes/${NOTE_B}.md`]);
    expect(newBlob).not.toBe(readLedger()[0].blob);
    const listed = await call({ action: "list", branch: "grok-spike" });
    expect(listed.notes.map((n) => n.filename).sort()).toEqual([NOTE_A, NOTE_B].sort());
  });
});

describe("rks_inbox_review admission", () => {
  beforeEach(() => resetToken());
  afterEach(() => resetToken());

  it("is refused remote_tool_not_allowed in the remote lane", () => {
    expect(REMOTE_LANE_TOOLS.has(TOOL)).toBe(false);
    const d = decideLane({ lane: "remote", tool: TOOL, args: { action: "list", branch: "grok-spike" }, tokenValid: true, bootProjectId: "proj-1" });
    expect(d).toMatchObject({ ok: false, reason: "remote_tool_not_allowed" });
  });

  it("is a protected tool requiring a governor token", () => {
    expect(isProtectedTool(TOOL)).toBe(true);
    expect(checkAllowedTool(null, TOOL)).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("registerInboxHandlers registers exactly rks_inbox_review", () => {
    const registry = createHandlerRegistry();
    registerInboxHandlers(registry, { inboxReviewSchema: TOOL_ARG_SCHEMAS[TOOL] });
    expect(registry.registeredTools()).toEqual([TOOL]);
  });

  it("is open-flow only and admitted in exactly init and writing", () => {
    expect(OPEN_FLOW_TOOLS.has(TOOL)).toBe(true);
    expect(STORY_FLOW_TOOLS.has(TOOL)).toBe(false);
    const open = getStates("open");
    const admitting = Object.entries(open).filter(([, def]) => def.allowed?.has(TOOL)).map(([s]) => s).sort();
    expect(admitting).toEqual(["init", "writing"]);
    expect(open.init.transitions?.[TOOL]).toBeUndefined();
    expect(open.writing.transitions[TOOL]).toBe("writing");
    for (const flow of ["story", "qa", "ship", "ops"]) {
      for (const [state, def] of Object.entries(getStates(flow))) {
        expect(def.allowed?.has(TOOL) ?? false, `${flow}/${state}`).toBe(false);
      }
    }
  });

  it("checkAllowedTool admits an open-flow session at init and writing and refuses a story-flow session", () => {
    const args = { action: "accept", branch: "grok-spike", filename: "inbox.grokbot.x", targetFilename: "research.x" };
    for (const state of ["init", "writing"]) {
      const { token } = createSession({ projectId: "proj-1", initialState: state });
      expect(checkAllowedTool(token, TOOL, args), state).toBeNull();
    }
    const { token } = createSession({ projectId: "proj-1", problemId: "story-1" });
    expect(checkAllowedTool(token, TOOL, args)).toMatchObject({ ok: false, error: "chain_violation" });
  });

  it("TOOL_AGENTS.rks_inbox_review is []", () => {
    expect(TOOL_AGENTS[TOOL]).toEqual([]);
  });

  it("has a registered schema that rejects {} and an unknown action", () => {
    const schema = TOOL_ARG_SCHEMAS[TOOL];
    expect(schema).toBeDefined();
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ action: "merge", branch: "grok-spike" }).success).toBe(false);
    expect(schema.safeParse({ action: "list", branch: "grok-spike" }).success).toBe(true);
  });
});

describe("rks_inbox_review child permission classification", () => {
  it("is prompt-gated in child projects", () => {
    const name = `mcp__rks__${TOOL}`;
    expect(Object.keys(CHILD_RKS_PROMPT_TOOLS)).toContain(name);
    expect(CHILD_RKS_ALLOW_TOOLS).not.toContain(name);
    expect(CHILD_RKS_ASK_RULES).toContain(name);
  });

  it("the base template ask list and Permission mode section carry it", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "templates/base/.claude/settings.json"), "utf8"));
    const rksAsk = settings.permissions.ask.filter((r) => String(r).startsWith("mcp__rks__"));
    expect(rksAsk).toEqual([...CHILD_RKS_ASK_RULES]);
    const md = fs.readFileSync(path.join(REPO_ROOT, "templates/base/CLAUDE.md"), "utf8");
    const start = md.indexOf("## Permission mode");
    expect(start).toBeGreaterThan(-1);
    const rest = md.slice(start + 1);
    const next = rest.search(/^## /m);
    const section = md.slice(start, next === -1 ? undefined : start + 1 + next);
    expect(section).toContain("`rks_inbox_review`");
  });
});
