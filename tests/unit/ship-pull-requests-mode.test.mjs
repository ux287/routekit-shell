// backlog.feat.rks-ship-local-merge-on-non-github-remote — the pure ship.pullRequests resolver,
// the shared GitHub-remote predicate, and source checks that the predicate is single-sourced in
// git-release.mjs.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resolveShipPullRequestMode } from "../../packages/mcp-rks/src/server/git/git-ship.mjs";
import { isGitHubRemoteUrl } from "../../packages/mcp-rks/src/server/git/git-release.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const GITHUB = ["https://github.com/o/r.git", "git@github.com:o/r.git", "https://github.example.com/o/r.git"];
const NON_GITHUB = ["https://gitlab.com/o/r.git", "git@bitbucket.org:o/r.git", "https://gitea.example.org/o/r.git", "/tmp/origin.git", "file:///tmp/origin.git"];

describe("isGitHubRemoteUrl", () => {
  for (const url of GITHUB) it(`true for ${url}`, () => expect(isGitHubRemoteUrl(url)).toBe(true));
  for (const url of NON_GITHUB) it(`false for ${url}`, () => expect(isGitHubRemoteUrl(url)).toBe(false));
});

describe("resolveShipPullRequestMode", () => {
  it("auto + GitHub origin opens a PR", () => {
    for (const url of GITHUB.slice(0, 2)) expect(resolveShipPullRequestMode({ pullRequests: "auto", originUrl: url }).mode).toBe("pr");
  });
  it("auto + non-GitHub origin merges locally with reason non_github_remote", () => {
    for (const url of NON_GITHUB) expect(resolveShipPullRequestMode({ pullRequests: "auto", originUrl: url })).toMatchObject({ mode: "local", reason: "non_github_remote" });
  });
  it("always opens a PR even for a non-GitHub origin", () => {
    expect(resolveShipPullRequestMode({ pullRequests: "always", originUrl: NON_GITHUB[0] }).mode).toBe("pr");
  });
  it("never merges locally even for a GitHub origin, with reason pull_requests_never", () => {
    expect(resolveShipPullRequestMode({ pullRequests: "never", originUrl: GITHUB[0] })).toMatchObject({ mode: "local", reason: "pull_requests_never" });
  });
  it("absent and invalid values resolve exactly as auto", () => {
    for (const pullRequests of [undefined, "bogus", 1]) {
      for (const url of [GITHUB[0], NON_GITHUB[0]]) {
        expect(resolveShipPullRequestMode({ pullRequests, originUrl: url })).toEqual(resolveShipPullRequestMode({ pullRequests: "auto", originUrl: url }));
      }
    }
  });
});

describe("GitHub-remote predicate is single-sourced", () => {
  it("git-ship.mjs imports isGitHubRemoteUrl from git-release.mjs and git-release.mjs exports it", () => {
    expect(read("packages/mcp-rks/src/server/git/git-ship.mjs")).toMatch(/import\s*\{[^}]*\bisGitHubRemoteUrl\b[^}]*\}\s*from\s*"\.\/git-release\.mjs"/);
    expect(read("packages/mcp-rks/src/server/git/git-release.mjs")).toMatch(/export\s+function\s+isGitHubRemoteUrl\b/);
  });
  it("the regex text appears in exactly one source file under packages/mcp-rks/src", () => {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.m?js$/.test(e.name) && fs.readFileSync(p, "utf8").includes("github\\.com|github\\.")) hits.push(p);
      }
    };
    walk(path.join(ROOT, "packages/mcp-rks/src"));
    expect(hits).toHaveLength(1);
    expect(path.relative(ROOT, hits[0]).split(path.sep).join("/")).toBe("packages/mcp-rks/src/server/git/git-release.mjs");
  });
  it("the release CI gate calls the helper instead of an inline regex test", () => {
    const src = read("packages/mcp-rks/src/server/git/git-release.mjs");
    expect(src).toMatch(/isGitHubRemoteUrl\(\s*remotes\.stdout/);
    // The helper body may hold `/github\.com|github\./i.test(url)`; only the gate's inline test of remotes.stdout must be gone.
    expect(src).not.toMatch(/\/i\.test\(\s*remotes\.stdout/);
  });
});
