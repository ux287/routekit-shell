import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTempFixture,
  cleanupTempFixture,
  createTestClient,
  closeTestClient,
  callToolSafe,
} from "./mcp-contract-helpers.mjs";

// Finding 2 (notes/research.2026.06.28.uat-findings.md): rks_rag_init and
// rks_rag_embed must NOT block on a dirty working tree. The clean-tree gate was
// orphaned copy-paste from exec (which writes commits); RAG writes no commits and
// reads the working tree via globby, so a dirty tree (e.g. an npm-install'd
// package-lock.json, already in CODE_IGNORE) must be allowed through.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "server.mjs"), "utf8");
const GIT_UTIL_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "utils", "git.mjs"), "utf8");

function assertNoCleanTreeError(res) {
  const blob = res.threw
    ? String(res.error?.message || res.error)
    : JSON.stringify(res.result ?? "");
  // Whatever else happens (branch guard, RAG index outcome), the one error that
  // must NOT appear on a dirty tree is the clean-tree gate.
  assert.doesNotMatch(
    blob,
    /working tree is not clean/i,
    "RAG tool must not emit a clean-tree gate error on a dirty working tree",
  );
}

describe("RAG tools do not block on a dirty working tree (Finding 2)", () => {
  let fixture;
  let conn;

  before(async () => {
    fixture = createTempFixture(); // git-initialized, clean
    // Dirty the tree with exactly the kind of file the old gate rejected:
    // an untracked generated lockfile (the onboarding-blocker from the UAT).
    fs.writeFileSync(path.join(fixture, "package-lock.json"), '{"lockfileVersion":3}\n');
    conn = await createTestClient({ projectRoot: fixture });
  });

  after(async () => {
    if (conn) await closeTestClient(conn);
    cleanupTempFixture(fixture);
  });

  it("rks_rag_init does not throw a clean-tree error on a dirty tree", async () => {
    const res = await callToolSafe(conn.client, "rks_rag_init", { projectId: "test-project" });
    assertNoCleanTreeError(res);
  });

  it("rks_rag_embed does not throw a clean-tree error on a dirty tree", async () => {
    const res = await callToolSafe(conn.client, "rks_rag_embed", { projectId: "test-project" });
    assertNoCleanTreeError(res);
  });
});

describe("clean-tree gate removal is scoped to the RAG handlers (regression guards)", () => {
  it("rks_rag_init handler no longer calls assertCleanWorkingTree", () => {
    assert.doesNotMatch(SERVER_SRC, /assertCleanWorkingTree\(projectRoot, \{ toolName: 'rks_rag_init' \}\)/);
  });

  it("rks_rag_embed handler no longer calls assertCleanWorkingTree", () => {
    assert.doesNotMatch(SERVER_SRC, /assertCleanWorkingTree\(projectRoot, \{ toolName: 'rks_rag_embed', notesOk: true \}\)/);
  });

  it("rks_project_init STILL enforces the clean-tree gate (out of scope — unchanged)", () => {
    assert.match(SERVER_SRC, /assertCleanWorkingTree\(projectRoot, \{ toolName: 'rks_project_init' \}\)/);
  });

  it("the working-branch guard is preserved in both RAG handlers", () => {
    assert.match(SERVER_SRC, /rks_rag_init: expected to run from working branch/);
    assert.match(SERVER_SRC, /rks_rag_embed: expected to run from working branch/);
  });

  it("the assertCleanWorkingTree util itself is unchanged (still defined and throws)", () => {
    assert.match(GIT_UTIL_SRC, /export function assertCleanWorkingTree/);
    assert.match(GIT_UTIL_SRC, /McpError/); // still throws on a blocked dirty tree
  });
});
