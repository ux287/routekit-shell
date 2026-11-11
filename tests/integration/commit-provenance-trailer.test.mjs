// backlog.feat.commit-provenance-trailer AC1b, AC2-AC7: real git in temp repos, MCP handlers over
// InMemoryTransport. Every git spawn carries an explicit timeout (GIT_TIMEOUT_MS).
//
// The createServer cases use a fixture root with NO lanes block (ARCH Item 11), pinned through
// ROUTEKIT_PROJECT_ROOT; RKS_VIA, RKS_VIA_DEFAULT, RKS_ACTOR and RKS_DISPATCH_RUN_ID are saved and
// restored around every case.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTempDir } from "../helpers/tmp.mjs";

vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));

// RAG is stubbed so no handler embeds or loads a model in this test.
vi.mock("@routekit/rag", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureRagIndex: vi.fn(async () => {}),
    runRagEmbed: vi.fn(async () => ({ ok: true })),
    runRagQuery: vi.fn(async () => ({ ok: true, matches: [] })),
  };
});

// runAgent is stubbed so an auto-route can never start a real LLM run.
vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runAgent: vi.fn(async () => ({ ok: true, output: { stub: true } })) };
});

import { runGitCommit } from "../../packages/mcp-rks/src/server/git/git-workflow.mjs";
import { commitAndEmbed } from "../../packages/mcp-rks/src/shared/commit-and-embed.mjs";
import { commitAndEmbedNote } from "../../packages/mcp-rks/src/shared/commit-and-embed-note.mjs";
import { findStoryCommitEvidence } from "../../packages/mcp-rks/src/workflow/auto-phase.mjs";

const GIT_TIMEOUT_MS = 15_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../../packages/mcp-rks/src");

function git(dir, args, opts = {}) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: GIT_TIMEOUT_MS, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "feature/test"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "a v1\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
}

const headBody = (dir, ref = "HEAD") => git(dir, ["log", "-1", "--format=%B", ref]);
const parsedTrailersOf = (dir, body) => git(dir, ["interpret-trailers", "--parse"], { input: body });
const parsedTrailers = (dir, ref = "HEAD") => parsedTrailersOf(dir, headBody(dir, ref));
const provenanceLines = (dir, ref = "HEAD") => parsedTrailers(dir, ref).split("\n").filter((l) => l.startsWith("Rks-Provenance: "));
const lastParagraph = (body) => body.trimEnd().split("\n\n").pop().split("\n");
const field = (line, name) => (line.match(new RegExp(`(?:^|\\s)${name}=(\\S+)`)) || [])[1];

const ATTR_ENV = ["RKS_VIA", "RKS_VIA_DEFAULT", "RKS_ACTOR", "RKS_DISPATCH_RUN_ID"];
let savedAttrEnv;
beforeEach(() => {
  savedAttrEnv = Object.fromEntries(ATTR_ENV.map((k) => [k, process.env[k]]));
  for (const k of ATTR_ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ATTR_ENV) { if (savedAttrEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedAttrEnv[k]; }
});

describe("runGitCommit carries the Rks-Provenance trailer", { timeout: 30_000 }, () => {
  let dir;
  beforeEach(() => { dir = makeTempDir("commit-provenance"); initRepo(dir); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it("structured mode puts Rks-Provenance in the same trailer block as Story and Co-Authored-By", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a v2\n");
    const res = await runGitCommit({ projectRoot: dir, message: "m", files: ["a.txt"], storyId: "backlog.x.y", coAuthor: "A <a@example.com>" });
    expect(res.ok).toBe(true);
    const block = lastParagraph(headBody(dir));
    expect(block).toContain("Story: backlog.x.y");
    expect(block).toContain("Co-Authored-By: A <a@example.com>");
    expect(block.filter((l) => l.startsWith("Rks-Provenance: v1 "))).toHaveLength(1);
    expect(provenanceLines(dir)).toHaveLength(1);
  });

  it("structured mode with no storyId, coAuthor or trailers still carries exactly one Rks-Provenance trailer (AC5)", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a v2b\n");
    const res = await runGitCommit({ projectRoot: dir, message: "plain", files: ["a.txt"] });
    expect(res.ok).toBe(true);
    expect(headBody(dir).startsWith("feat: plain\n\nRks-Provenance: v1 ")).toBe(true);
    expect(provenanceLines(dir)).toHaveLength(1);
  });

  it("rawMessage mode keeps the caller bytes as an exact prefix and adds the rks trailer as the final trailer line", async () => {
    const MSG = "chore(sync): x\n\nBody.\n\nCo-Authored-By: S <s@example.com>\nStory: backlog.x.y";
    fs.writeFileSync(path.join(dir, "a.txt"), "a v3\n");
    const res = await runGitCommit({ projectRoot: dir, rawMessage: MSG, files: ["a.txt"] });
    expect(res.ok).toBe(true);
    const body = headBody(dir);
    expect(body.startsWith(MSG)).toBe(true);
    expect(body.trimEnd().split("\n").pop().startsWith("Rks-Provenance: v1 ")).toBe(true);
    const parsed = parsedTrailers(dir).split("\n");
    expect(parsed).toContain("Co-Authored-By: S <s@example.com>");
    expect(parsed).toContain("Story: backlog.x.y");
    expect(provenanceLines(dir)).toHaveLength(1);
  });

  it("rawMessage with no trailer paragraph gets the trailer in a new paragraph that git parses", async () => {
    const MSG = "chore: no trailers here";
    fs.writeFileSync(path.join(dir, "a.txt"), "a v3b\n");
    const res = await runGitCommit({ projectRoot: dir, rawMessage: MSG, files: ["a.txt"] });
    expect(res.ok).toBe(true);
    expect(headBody(dir).startsWith(`${MSG}\n\nRks-Provenance: v1 `)).toBe(true);
    expect(provenanceLines(dir)).toHaveLength(1);
  });

  it("a commit outside any MCP request carries client=unknown-client (AC6) and session=none, the untokened rks_ship path (AC1b)", async () => {
    // server/git/git-ship.mjs (the rks_ship commit step) calls runGitCommit with no session.
    fs.writeFileSync(path.join(dir, "a.txt"), "a v4\n");
    const res = await runGitCommit({ projectRoot: dir, message: "no session", files: ["a.txt"] });
    expect(res.ok).toBe(true);
    const [line] = provenanceLines(dir);
    expect(field(line, "client")).toBe("unknown-client");
    expect(field(line, "session")).toBe("none");
    expect(field(line, "tool")).toBe("rks_git_commit");
    expect(field(line, "run")).toBe("none");
  });

  it("commitAndEmbed keeps the caller message as a byte-exact prefix and adds exactly one Rks-Provenance trailer (AC5)", async () => {
    const MSG = "docs: `tick` $(not run) \"q\"\n\nbody line";
    fs.writeFileSync(path.join(dir, "a.txt"), "a v5\n");
    git(dir, ["add", "a.txt"]);
    await commitAndEmbed(dir, MSG);
    expect(headBody(dir).startsWith(MSG)).toBe(true);
    expect(provenanceLines(dir)).toHaveLength(1);
  });

  it("commitAndEmbed never stamps a message that already carries the trailer a second time", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a v5b\n");
    git(dir, ["add", "a.txt"]);
    await commitAndEmbed(dir, "x: y\n\nRks-Provenance: v1 session=none tool=t client=c via=mcp actor=a run=none");
    expect(provenanceLines(dir)).toHaveLength(1);
  });

  it("commitAndEmbedNote keeps the supplied subject line and adds exactly one Rks-Provenance trailer (AC5)", async () => {
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "notes", "research.x.md"), "---\nid: research.x\n---\nbody\n");
    const res = await commitAndEmbedNote({ projectRoot: dir, notePath: "notes/research.x.md", commitMessage: "docs(research): create research.x" });
    expect(res.commitOk).toBe(true);
    expect(headBody(dir).split("\n")[0]).toBe("docs(research): create research.x");
    expect(provenanceLines(dir)).toHaveLength(1);
  });

  it("commitAndEmbedNote with skipEmbed (raw git commit) also carries the trailer", async () => {
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "notes", "research.y.md"), "---\nid: research.y\n---\nbody\n");
    const res = await commitAndEmbedNote({ projectRoot: dir, notePath: "notes/research.y.md", commitMessage: "docs(research): create research.y", skipEmbed: true, provenanceTool: "dendron_create_note" });
    expect(res.commitOk).toBe(true);
    expect(headBody(dir).split("\n")[0]).toBe("docs(research): create research.y");
    const [line] = provenanceLines(dir);
    expect(field(line, "tool")).toBe("dendron_create_note");
  });

  it("findStoryCommitEvidence returns form trailer and the sha for a commit carrying both Story and Rks-Provenance (AC7)", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a v6\n");
    const res = await runGitCommit({ projectRoot: dir, message: "backlog.x.evidence", scope: "exec", files: ["a.txt"], storyId: "backlog.x.evidence" });
    expect(res.ok).toBe(true);
    const block = lastParagraph(headBody(dir));
    expect(block).toContain("Story: backlog.x.evidence");
    expect(block.some((l) => l.startsWith("Rks-Provenance: v1 "))).toBe(true);
    const ev = findStoryCommitEvidence(dir, "backlog.x.evidence", "HEAD");
    expect(ev?.form).toBe("trailer");
    expect(ev?.commit).toBe(git(dir, ["rev-parse", "HEAD"]).trim());
  });
});

// ── createServer over InMemoryTransport ─────────────────────────────

const PROJECT_ID = "provenance-fixture";
const CLIENT_NAME = "Provenance Test Client";
const GATE_ENV = ["NODE_ENV", "RKS_SKIP_PREFLIGHT", "RKS_TEST_MODE"];
const ROOT_ENV = ["ROUTEKIT_PROJECT_ROOT", "RKS_PROJECT_ROOT", "ROUTEKIT_PROJECT_ID", "DENDRON_VAULT_PATH", "ROUTEKIT_NOTES_DIR"];
const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-provenance-srv-")));
const fixtureRoot = path.join(tmpBase, "fixture");
const savedRootEnv = Object.fromEntries(ROOT_ENV.map((k) => [k, process.env[k]]));

function makeFixture(root) {
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(root, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  // No lanes block (ARCH Item 11): the lane gate admits every lane.
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ id: PROJECT_ID, root, kgFile: "routekit/kg.yaml", notes: { vaultPath: "notes" } }, null, 2));
  fs.writeFileSync(path.join(root, "routekit", "kg.yaml"), "project: fixture\n");
  fs.writeFileSync(path.join(root, "notes", "research.fixture.md"), '---\nid: "research.fixture"\ntitle: "Fixture"\nstatus: "original"\n---\n\n## Body\n\nfirst line\n');
  fs.writeFileSync(path.join(root, ".gitignore"), ".rks/\n");
  git(root, ["init", "-b", "feature/provenance-test"]);
  git(root, ["config", "user.email", "prov@test.invalid"]);
  git(root, ["config", "user.name", "Prov Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "fixture", "--no-verify"]);
}

let createServer;
let endSession;
const liveTokens = new Set();

beforeAll(async () => {
  makeFixture(fixtureRoot);
  process.env.ROUTEKIT_PROJECT_ROOT = fixtureRoot;
  delete process.env.RKS_PROJECT_ROOT;
  process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;
  delete process.env.DENDRON_VAULT_PATH;
  delete process.env.ROUTEKIT_NOTES_DIR;
  ({ createServer } = await import("../../packages/mcp-rks/src/server.mjs"));
  ({ endSession } = await import("../../packages/mcp-rks/src/shared/governor-token.mjs"));
});

afterAll(() => {
  for (const t of liveTokens) { try { endSession(t); } catch { /* best-effort */ } }
  for (const k of ROOT_ENV) { if (savedRootEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedRootEnv[k]; }
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function call(name, args, { clientName = CLIENT_NAME } = {}) {
  const prev = Object.fromEntries(GATE_ENV.map((k) => [k, process.env[k]]));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: clientName, version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  process.env.NODE_ENV = "test";
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = res?.content?.[0]?.text ?? "";
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (name === "rks_governor_init" && json?.ok && json.token) liveTokens.add(json.token);
    return { res, text, json };
  } finally {
    for (const k of GATE_ENV) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    await client.close().catch(() => {});
  }
}

async function openToken() {
  const { json, text } = await call("rks_governor_init", { projectId: PROJECT_ID });
  expect(json?.ok, text).toBe(true);
  return json.token;
}

async function endToken(token) {
  try { endSession(token); } catch { /* best-effort */ }
  liveTokens.delete(token);
}

const headSha = () => git(fixtureRoot, ["rev-parse", "HEAD"]).trim();

function expectOneProvenanceCommit(before, text) {
  const after = headSha();
  expect(after, `no commit was made: ${text}`).not.toBe(before);
  const lines = provenanceLines(fixtureRoot);
  expect(lines, headBody(fixtureRoot)).toHaveLength(1);
  return lines[0];
}

describe("dendron writes over createServer carry provenance (AC3, AC6, AC2, AC1b)", { timeout: 60_000 }, () => {
  it("dendron_create_note, dendron_update_field and dendron_edit_note each commit one trailer naming the tool and client=Provenance_Test_Client", async () => {
    let before = headSha();
    const create = await call("dendron_create_note", { projectId: PROJECT_ID, filename: "research.prov-created", title: "Created", content: "## Body\n\nhello\n" });
    let line = expectOneProvenanceCommit(before, create.text);
    expect(field(line, "tool")).toBe("dendron_create_note");
    expect(field(line, "client")).toBe("Provenance_Test_Client");

    before = headSha();
    const upd = await call("dendron_update_field", { projectId: PROJECT_ID, filename: "research.fixture", field: "status", value: "updated" });
    line = expectOneProvenanceCommit(before, upd.text);
    expect(field(line, "tool")).toBe("dendron_update_field");
    expect(field(line, "client")).toBe("Provenance_Test_Client");

    before = headSha();
    const edit = await call("dendron_edit_note", { projectId: PROJECT_ID, filename: "research.fixture", patches: [{ search: "first line", replace: "edited line" }] });
    line = expectOneProvenanceCommit(before, edit.text);
    expect(field(line, "tool")).toBe("dendron_edit_note");
    expect(field(line, "client")).toBe("Provenance_Test_Client");
  });

  it("two writes under one token share session=, a second token gets a different one, and no message contains a raw token (AC2)", async () => {
    const t1 = await openToken();
    let before = headSha();
    const w1 = await call("dendron_update_field", { projectId: PROJECT_ID, filename: "research.fixture", field: "status", value: "s1", _governorToken: t1 });
    const l1 = expectOneProvenanceCommit(before, w1.text);
    const b1 = headBody(fixtureRoot);
    before = headSha();
    const w2 = await call("dendron_update_field", { projectId: PROJECT_ID, filename: "research.fixture", field: "status", value: "s2", _governorToken: t1 });
    const l2 = expectOneProvenanceCommit(before, w2.text);
    const b2 = headBody(fixtureRoot);
    await endToken(t1);

    const t2 = await openToken();
    before = headSha();
    const w3 = await call("dendron_update_field", { projectId: PROJECT_ID, filename: "research.fixture", field: "status", value: "s3", _governorToken: t2 });
    const l3 = expectOneProvenanceCommit(before, w3.text);
    const b3 = headBody(fixtureRoot);
    await endToken(t2);

    expect(field(l1, "session")).not.toBe("none");
    expect(field(l1, "session")).toBe(field(l2, "session"));
    expect(field(l3, "session")).not.toBe("none");
    expect(field(l3, "session")).not.toBe(field(l1, "session"));
    for (const body of [b1, b2, b3]) {
      expect(body).not.toContain(t1);
      expect(body).not.toContain(t2);
    }
  });

  it("a session started with RKS_DISPATCH_RUN_ID and RKS_VIA=dispatch records via=dispatch and run=<id>; unset run id records run=none (AC1b)", async () => {
    process.env.RKS_DISPATCH_RUN_ID = "run-prov-1";
    process.env.RKS_VIA = "dispatch";
    const t1 = await openToken();
    let before = headSha();
    const w1 = await call("dendron_update_field", { projectId: PROJECT_ID, filename: "research.fixture", field: "status", value: "d1", _governorToken: t1 });
    const l1 = expectOneProvenanceCommit(before, w1.text);
    await endToken(t1);
    expect(field(l1, "via")).toBe("dispatch");
    expect(field(l1, "run")).toBe("run-prov-1");

    delete process.env.RKS_DISPATCH_RUN_ID;
    delete process.env.RKS_VIA;
    const t2 = await openToken();
    before = headSha();
    const w2 = await call("dendron_update_field", { projectId: PROJECT_ID, filename: "research.fixture", field: "status", value: "d2", _governorToken: t2 });
    const l2 = expectOneProvenanceCommit(before, w2.text);
    await endToken(t2);
    expect(field(l2, "run")).toBe("none");
  });
});

describe("rks_git_commit description names the trailer (AC4)", () => {
  it("no longer says no trailer added, names Rks-Provenance, still says verbatim / byte-for-byte", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client({ name: CLIENT_NAME, version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    try {
      const tools = (await client.listTools()).tools;
      const desc = tools.find((t) => t.name === "rks_git_commit")?.description ?? "";
      expect(desc).not.toContain("no trailer added");
      expect(desc).toContain("Rks-Provenance");
      expect(desc).toMatch(/verbatim|byte-for-byte/i);
    } finally {
      await client.close().catch(() => {});
    }
  });
});

describe("commit-site source scan (AC5)", () => {
  const SITES = [
    "server/git/git-workflow.mjs", "shared/commit-and-embed.mjs", "shared/commit-and-embed-note.mjs", "server.mjs",
    "server/exec.mjs", "server/git/git-release.mjs", "server/guardrails-audit.mjs", "server/handlers/planner.mjs",
    "server/planner-persistence.mjs", "server/story-ship.mjs", "utils/git.mjs", "agents/git.mjs", "agents/ship.mjs",
    "server/git/local-merge.mjs",
    "server/git/git-ship.mjs", "server/gh-tools.mjs", "server/git/git-core.mjs", "server/init.mjs",
  ];
  const IMPORTS_PROVENANCE = /from\s+["'][./]*(?:shared\/)?commit-provenance\.mjs["']/;
  const VIA_HELPER = /\b(runGitCommit|commitAndEmbed|commitAndEmbedNote)\s*\(/;
  const RAW_COMMIT_SPAWN = /\[\s*["']commit["']/;

  for (const rel of SITES) {
    it(`${rel} imports shared/commit-provenance.mjs or commits only through runGitCommit / commitAndEmbed / commitAndEmbedNote`, () => {
      const src = fs.readFileSync(path.join(SRC, rel), "utf8");
      const imports = IMPORTS_PROVENANCE.test(src);
      const helperOnly = VIA_HELPER.test(src) && !RAW_COMMIT_SPAWN.test(src);
      expect(imports || helperOnly, rel).toBe(true);
    });
  }

  it("server/publish.mjs (temp mirror dir commit) imports neither and is out of scope", () => {
    const src = fs.readFileSync(path.join(SRC, "server/publish.mjs"), "utf8");
    expect(IMPORTS_PROVENANCE.test(src)).toBe(false);
    expect(/commit-and-embed/.test(src)).toBe(false);
  });
});
