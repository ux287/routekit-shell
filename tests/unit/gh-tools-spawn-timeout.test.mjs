// backlog.fix.ship-merge-gh-git-spawns-unbounded — gh-tools.mjs spawns are bounded and a timeout is a named failure.
// child_process spawnSync is mocked; no real subprocess is started by this file. A timeout is simulated with the
// synthetic reply shape Node returns on a killed spawnSync (status null, signal SIGTERM, error.code ETIMEDOUT).
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }));
vi.mock("child_process", () => ({ spawnSync: mockSpawnSync }));

const gh = await import("../../packages/mcp-rks/src/server/gh-tools.mjs");

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "", signal: null, error: null });
const timedOut = () => ({
  status: null, stdout: "", stderr: "", signal: "SIGTERM",
  error: Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" }),
});
const SRC = fs.readFileSync(path.resolve("packages/mcp-rks/src/server/gh-tools.mjs"), "utf8");

/**
 * Extract the full argument text of every `spawnSync("gh"|"git", ...)` call by walking to the
 * BALANCED closing paren, skipping string/template literals and comments. Unlike a lazy match to
 * the first `);`, this is not fooled by `);` inside an argument string or a nested call.
 */
function maskComments(src) {
  // Replace // and /* */ comment bodies with spaces (offsets preserved), skipping string literals,
  // so a doc comment such as "Use `spawnSync('gh', ...)`" is not counted as a call site.
  const out = src.split("");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      for (; i < src.length && src[i] !== "\n"; i++) out[i] = " ";
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const stop = close === -1 ? src.length : close + 2;
      for (; i < stop; i++) if (src[i] !== "\n") out[i] = " ";
      i--;
    }
  }
  return out.join("");
}

function spawnCallSites(rawSrc) {
  const src = maskComments(rawSrc);
  const sites = [];
  const re = /\bspawnSync\(\s*["'`](gh|git)["'`]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].indexOf("(");
    let depth = 0;
    let i = start;
    let end = -1;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const q = ch;
        for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\") i++;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) throw new Error(`unbalanced spawnSync( call at offset ${m.index}`);
    sites.push({ offset: m.index, text: src.slice(start, end + 1) });
  }
  return sites;
}

beforeEach(() => mockSpawnSync.mockReset());

describe("gh-tools spawn timeouts", () => {
  it("the call-site scanner handles `);` inside a string argument (robustness control)", () => {
    const sample = '// spawnSync("gh", in a comment)\nspawnSync("gh", ["x", "a);b"], { cwd: r }); spawnSync("git", ["y"], { cwd: r, timeout: T });';
    const sites = spawnCallSites(sample);
    expect(sites).toHaveLength(2);
    expect(sites[0].text).toContain("{ cwd: r }");
    expect(sites[0].text).not.toMatch(/timeout\s*:/);
    expect(sites[1].text).toMatch(/timeout\s*:/);
  });

  it("every gh/git spawnSync call in gh-tools.mjs passes a timeout option", () => {
    const sites = spawnCallSites(SRC);
    // ghPrList, ghPrView, ghPrCreate, ghPrMerge, ghBranchesPrune (4), ghBranchDelete (2).
    expect(sites.length).toBeGreaterThanOrEqual(10);
    const missing = sites.filter((s) => !/\btimeout\s*:/.test(s.text)).map((s) => s.text);
    expect(missing).toEqual([]);
  });

  it("ghPrView passes a positive numeric timeout to spawnSync", () => {
    mockSpawnSync.mockReturnValue(ok(JSON.stringify({ number: 1, statusCheckRollup: [] })));
    gh.ghPrView({ projectRoot: "/mock", prNumber: 1 });
    const [, , opts] = mockSpawnSync.mock.calls[0];
    expect(typeof opts.timeout).toBe("number");
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it("ghPrView returns ok:false naming the timeout when gh is killed past the bound", () => {
    mockSpawnSync.mockReturnValue(timedOut());
    const r = gh.ghPrView({ projectRoot: "/mock", prNumber: 1 });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/tim(ed )?out/i);
    expect(String(r.error)).not.toMatch(/no PR found/i);
    expect(r.timeout_at).toBe("gh_pr_view");
  });
});
