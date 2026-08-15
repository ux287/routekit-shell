/**
 * redirect-bash-to-governor — read-only CI allowlist (Part B of the /ci skill).
 *
 * Under guardrails-on, the bash-redirect hook normally routes ALL Bash to the
 * Governor. This pins the narrow read-only CI observability carve-out that lets
 * the /ci skill run: read-only `gh run list|view|download` and
 * `node scripts/analyze-vitest-report.mjs` are ALLOWED; everything else —
 * including MUTATING gh and any shell-chaining/redirection bypass — still
 * REDIRECTS.
 *
 * The hook is spawned by its canonical path (packages/hooks/...), which is the
 * source of truth and is always present in-repo regardless of guardrails state.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOOK = path.join(PROJECT_ROOT, "packages/hooks/write/redirect-bash-to-governor.mjs");

let tmpProjectDir;
beforeAll(() => {
  // Isolate telemetry writes (the hook appends to CLAUDE_PROJECT_DIR/.routekit/telemetry).
  tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ci-allowlist-"));
});
afterAll(() => {
  try { fs.rmSync(tmpProjectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function runBashHook(command, { toolName = "Bash", guardrails = "on" } = {}) {
  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmpProjectDir,
      RKS_GUARDRAILS: guardrails,
      RKS_PROJECT_ID: "test-project",
    },
    timeout: 10_000,
  });
  return { exitCode: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function expectAllowed(command) {
  const r = runBashHook(command);
  expect(r.exitCode, `expected ALLOW (exit 0) for: ${JSON.stringify(command)} | stdout=${r.stdout}`).toBe(0);
  expect(r.stdout.trim(), `expected empty stdout (allow) for: ${JSON.stringify(command)}`).toBe("");
}

function expectRedirected(command) {
  const r = runBashHook(command);
  expect(r.exitCode).toBe(0);
  expect(r.stdout, `expected REDIRECT (Pattern A) for: ${JSON.stringify(command)}`).not.toBe("");
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  expect(out.permissionDecision).toBe("deny");
  expect(out.additionalContext).toContain("REDIRECT ORDER:");
  expect(out.additionalContext).toContain("GOVERNOR ROUTING:");
}

describe("redirect-bash-to-governor — read-only CI allowlist", () => {
  describe("ALLOW: read-only CI inspection commands the /ci skill uses", () => {
    const allowed = [
      'gh run list --branch staging --limit 5 --json databaseId,conclusion,workflowName',
      'gh run view 123 --json conclusion,jobs,workflowName,startedAt,updatedAt',
      'gh run view 123 --log-failed',
      'gh run download 123 --pattern "vitest-unit-*" --dir /tmp/ci-123-artifacts',
      'node scripts/analyze-vitest-report.mjs /tmp/ci-123-artifacts/shard.json',
      '\n\tgh run list --limit 5', // leading whitespace-only is trimmed, still allowed
    ];
    for (const cmd of allowed) {
      it(`allows: ${JSON.stringify(cmd)}`, () => expectAllowed(cmd));
    }
  });

  describe("REDIRECT: mutating gh and non-allowlisted commands", () => {
    const redirected = [
      'gh pr merge 5',
      'gh pr comment 5 --body "see gh run 5"', // embedded "gh run" substring must NOT leak through
      'gh pr edit 5',
      'gh run rerun 123',
      'gh run cancel 123',
      'gh run delete 123',  // only list/view/download are allowed
      'gh run watch 123',
      'gh workflow run ci.yml',
      'gh workflow dispatch ci.yml',
      'rm -rf /tmp/foo',
      'npx vitest run',
      'git commit -m wip',
    ];
    for (const cmd of redirected) {
      it(`redirects: ${JSON.stringify(cmd)}`, () => expectRedirected(cmd));
    }
  });

  describe("REDIRECT: shell-chaining / redirection / injection bypass attempts", () => {
    const bypass = [
      'echo x && gh run list',
      'gh run list; rm -rf /tmp/foo',
      'gh run list && gh pr merge 5',
      'gh run list | sh',
      'gh run view 123 --log-failed > /tmp/x.log', // output redirection
      'gh run list `rm -rf /tmp/x`',               // backtick substitution
      'gh run list $(rm -rf /tmp/x)',              // $() substitution
      'gh run list\nrm -rf /tmp/x',                // embedded newline
    ];
    for (const cmd of bypass) {
      it(`redirects bypass: ${JSON.stringify(cmd)}`, () => expectRedirected(cmd));
    }
  });

  describe("ALLOW: read-only git inspection (backlog.fix.ci-readonly-git-allowlist)", () => {
    const allowed = [
      'git status',
      'git status --porcelain',
      'git log',
      'git log --oneline -5',
      'git rev-parse HEAD',
      'git rev-parse --short HEAD',
      'git show HEAD',
      'git diff',
      'git branch',              // bare = list all branches (read-only)
      'git branch --list',
      'git branch --show-current',
    ];
    for (const cmd of allowed) {
      it(`allows: ${JSON.stringify(cmd)}`, () => expectAllowed(cmd));
    }
  });

  describe("REDIRECT: git mutations, branch creation, and mutation-leak via trailing flags", () => {
    const redirected = [
      'git branch my-new-branch',   // branch CREATION is not read-only
      'git push origin staging',
      'git checkout main',
      'git merge feature',
      'git reset --hard HEAD',
      'git rebase main',
      // Mutation-leak cases: a leading read-only flag must NOT smuggle a trailing mutating
      // flag. The terminal-anchored `git branch` regex rejects all of these.
      'git branch -v -d foo',
      'git branch --list -D foo',
      'git branch -a -m old new',
      'git branch -r -d origin/foo',
    ];
    for (const cmd of redirected) {
      it(`redirects: ${JSON.stringify(cmd)}`, () => expectRedirected(cmd));
    }
  });

  it("non-Bash tools are never intercepted by this hook", () => {
    const r = runBashHook("gh pr merge 5", { toolName: "Read" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("guardrails-off passthrough preserved (RKS_GUARDRAILS=off allows even mutating gh)", () => {
    const r = runBashHook("gh pr merge 5", { guardrails: "off" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
