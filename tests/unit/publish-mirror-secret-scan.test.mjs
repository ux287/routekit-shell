/**
 * backlog.security.publish-mirror-secret-scan — publish() secret-scans the assembled mirror tree
 * after transforms + identity normalization and before the fresh `git init` repo commits and
 * force-pushes it.
 *
 * Every assertion reads RECORDED spawnSync calls (hoisted vi.mock of child_process, the pattern of
 * publish-suppression.test.mjs), so ordering and the absence of git init/commit/push are observed,
 * not inferred. No real subprocess is started by publish() in this file; the only real filesystem
 * effects are under os.tmpdir() fixture roots.
 *
 * [process] No subprocess is spawned by this test file itself: spawnSync is a vi.fn() mock
 * throughout. publish()'s own gitleaks / rev-parse spawns carry an explicit timeout (asserted).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn() };
});

const { spawnSync } = await import("child_process");
const { publish } = await import("../../packages/mcp-rks/src/server/publish.mjs");

const isGitleaks = (cmd) => path.basename(String(cmd)).startsWith("gitleaks");
const MARKER = "SEKRIT-MARKER-7f3a9c";

// --- fixtures -----------------------------------------------------------------------------

const roots = [];

function makeRoot({ transforms = false, identity = false, enabled } = {}) {
  const root = makeTempDir("publish-mirror-secret-scan");
  roots.push(root);
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  const lines = [
    "profiles:",
    "  mirror:",
    '    description: "fixture"',
    "    include:",
    '      - "README.md"',
  ];
  if (transforms) {
    lines.push("    transforms:");
    lines.push('      - match: "notes/canon.**"');
    lines.push('        rename: "notes/rks.canon.{rest}"');
  }
  if (identity) {
    lines.push("    identity:");
    lines.push('      from: "devident"');
    lines.push('      to: "pubident"');
  }
  lines.push("remotes:");
  lines.push("  target-remote:");
  lines.push('    url: "git@github.com:example/fixture-mirror.git"');
  lines.push('    profile: "mirror"');
  lines.push('    branch: "main"');
  if (enabled !== undefined) lines.push(`    enabled: ${enabled}`);
  fs.writeFileSync(path.join(root, ".routekit", "publish-profiles.yaml"), lines.join("\n") + "\n", "utf-8");
  return root;
}

const argAfter = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const insideDir = (p, dir) => {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Arm spawnSync. `gitleaks(cmd, args, opts)` decides the scan result (default clean, writing `[]`
 * like a real clean scan). `tar(opts)` may seed the extracted tree. `commonDir` is the rev-parse
 * --git-common-dir stdout (default empty → PATH fallback).
 */
function arm({ gitleaks, tar, commonDir = "" } = {}) {
  spawnSync.mockImplementation((cmd, args, opts) => {
    args = Array.isArray(args) ? args : [];
    if (isGitleaks(cmd)) {
      if (gitleaks) return gitleaks(cmd, args, opts);
      fs.writeFileSync(argAfter(args, "--report-path"), "[]", "utf-8");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--git-common-dir") {
      return { status: 0, stdout: commonDir ? `${commonDir}\n` : "", stderr: "" };
    }
    if (cmd === "git" && args[0] === "remote" && args[1] === "get-url") {
      return { status: 1, stdout: "", stderr: "not found" };
    }
    if (cmd === "git" && args[0] === "archive") {
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.from("") };
    }
    if (cmd === "tar") {
      if (tar) tar(opts);
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
}

/** A gitleaks mock that writes `report` (string) to the argv --report-path and returns `status`. */
const leaks = (report, status = 1) => (cmd, args) => {
  if (report !== undefined) fs.writeFileSync(argAfter(args, "--report-path"), report, "utf-8");
  return { status, stdout: "", stderr: "" };
};

const FINDING_REPORT = JSON.stringify([
  {
    RuleID: "generic-api-key",
    File: "src/config/leaky.js",
    StartLine: 3,
    Match: `apiKey = "${MARKER}"`,
    Secret: MARKER,
  },
]);

const calls = () => spawnSync.mock.calls.map(([cmd, args, opts]) => ({ cmd, args: Array.isArray(args) ? args : [], opts }));
const gitCalls = (sub) => calls().filter((c) => c.cmd === "git" && c.args[0] === sub);
const gitleaksCalls = () => calls().filter((c) => isGitleaks(c.cmd));
const forcePushes = () => calls().filter((c) => c.cmd === "git" && c.args[0] === "push" && c.args[1] === "-f");
const remoteAddTarget = () =>
  calls().filter((c) => c.cmd === "git" && c.args[0] === "remote" && c.args[1] === "add" && c.args[2] === "target");

function expectNoMirrorCommit() {
  expect(gitCalls("init")).toEqual([]);
  expect(gitCalls("add")).toEqual([]);
  expect(gitCalls("commit")).toEqual([]);
  expect(remoteAddTarget()).toEqual([]);
  expect(forcePushes()).toEqual([]);
}

const reportPathOf = () => argAfter(gitleaksCalls()[0].args, "--report-path");
const publishLive = (root) => publish(root, { remote: "target-remote", profile: "mirror" });

beforeEach(() => {
  spawnSync.mockReset();
  arm();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// --- ordering and bytes -------------------------------------------------------------------

describe("publish() mirror secret scan — ordering and bytes", () => {
  it("spawns exactly one gitleaks scan after tar extract and before git init", async () => {
    const root = makeRoot();
    const result = await publishLive(root);
    expect(result.ok).toBe(true);

    const all = calls();
    const tarIdx = all.findIndex((c) => c.cmd === "tar");
    const scanIdxs = all.map((c, i) => (isGitleaks(c.cmd) ? i : -1)).filter((i) => i >= 0);
    const initIdx = all.findIndex((c) => c.cmd === "git" && c.args[0] === "init");
    expect(scanIdxs).toHaveLength(1);
    expect(tarIdx).toBeGreaterThanOrEqual(0);
    expect(scanIdxs[0]).toBeGreaterThan(tarIdx);
    expect(initIdx).toBeGreaterThan(scanIdxs[0]);
    expect(all[initIdx].opts.cwd).toBe(path.join(root, ".rks", "publish-tmp"));
  });

  it("scans post-transform and post-identity bytes", async () => {
    const root = makeRoot({ transforms: true, identity: true });
    let seen = null;
    arm({
      tar: (opts) => {
        fs.mkdirSync(path.join(opts.cwd, "notes"), { recursive: true });
        fs.writeFileSync(path.join(opts.cwd, "notes", "canon.getting-started.md"), "# Start");
        // normalizeExportIdentity rewrites package.json's name (among a fixed set of files).
        fs.writeFileSync(path.join(opts.cwd, "package.json"), JSON.stringify({ name: "devident" }));
      },
      gitleaks: (cmd, args, opts) => {
        const d = opts.cwd;
        seen = {
          renamed: fs.existsSync(path.join(d, "notes", "rks.canon.getting-started.md")),
          original: fs.existsSync(path.join(d, "notes", "canon.getting-started.md")),
          pkg: fs.readFileSync(path.join(d, "package.json"), "utf-8"),
        };
        fs.writeFileSync(argAfter(args, "--report-path"), "[]", "utf-8");
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const result = await publishLive(root);
    expect(result.ok).toBe(true);
    expect(seen).not.toBeNull();
    expect(seen.renamed).toBe(true);
    expect(seen.original).toBe(false);
    expect(seen.pkg).toContain("pubident");
    expect(seen.pkg).not.toContain("devident");
  });

  it("spawns gitleaks dir . with cwd tmpDir, a timeout, absolute project-root --config and --gitleaks-ignore-path, --redact, json report outside tmpDir, and no detect/git/tmpDir argument", async () => {
    const root = makeRoot();
    await publishLive(root);
    const [scan] = gitleaksCalls();
    const tmpDir = path.resolve(root, ".rks", "publish-tmp");
    const absRoot = path.resolve(root);

    expect(scan.opts.cwd).toBe(tmpDir);
    expect(typeof scan.opts.timeout).toBe("number");
    expect(scan.opts.timeout).toBeGreaterThan(0);
    expect(scan.args.slice(0, 2)).toEqual(["dir", "."]);
    expect(argAfter(scan.args, "--config")).toBe(path.join(absRoot, ".gitleaks.toml"));
    expect(argAfter(scan.args, "--gitleaks-ignore-path")).toBe(absRoot);
    expect(scan.args).toContain("--redact");
    expect(argAfter(scan.args, "--report-format")).toBe("json");
    const rp = argAfter(scan.args, "--report-path");
    expect(path.isAbsolute(rp)).toBe(true);
    expect(insideDir(rp, tmpDir)).toBe(false);
    for (const a of scan.args) {
      expect(a).not.toBe("detect");
      expect(a).not.toBe("git");
      expect(a).not.toBe(tmpDir);
      if (path.isAbsolute(a)) expect(insideDir(a, tmpDir)).toBe(false);
    }
  });
});

// --- refusal ------------------------------------------------------------------------------

describe("publish() mirror secret scan — refusal", () => {
  it("a finding (status 1, non-empty JSON report) returns ok false with no git init, add, commit, remote add or push -f", async () => {
    const root = makeRoot();
    arm({ gitleaks: leaks(FINDING_REPORT, 1) });
    const result = await publishLive(root);
    expect(gitleaksCalls()).toHaveLength(1);
    expect(result.ok).toBe(false);
    expectNoMirrorCommit();
  });

  it("the refusal error carries the report's File and RuleID and neither its Secret nor its Match marker", async () => {
    const root = makeRoot();
    arm({ gitleaks: leaks(FINDING_REPORT, 1) });
    const result = await publishLive(root);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("src/config/leaky.js");
    expect(result.error).toContain("generic-api-key");
    expect(result.error).not.toContain(MARKER);
    expect(result.error).not.toContain("apiKey =");
  });

  it.each([
    ["no report", undefined],
    ["an unparseable report", "{not json"],
    ["an empty array", "[]"],
  ])("status 1 with %s refuses as a scan failure", async (_label, report) => {
    const root = makeRoot();
    arm({ gitleaks: leaks(report, 1) });
    const result = await publishLive(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/secret scan failed/i);
    expect(gitCalls("commit")).toEqual([]);
    expect(forcePushes()).toEqual([]);
  });

  it("a stale report at the report path is not read when the scan writes none", async () => {
    const root = makeRoot();
    const stalePath = path.join(root, ".rks", "publish-secret-scan.json");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    fs.writeFileSync(
      stalePath,
      JSON.stringify([{ RuleID: "stale-rule-id", File: "stale/file.txt", StartLine: 1, Secret: "x", Match: "x" }]),
    );
    arm({ gitleaks: leaks(undefined, 1) });
    const result = await publishLive(root);
    expect(reportPathOf()).toBe(stalePath); // the stale file sat at the exact path the scan used
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/secret scan failed/i);
    expect(result.error).not.toContain("stale/file.txt");
    expect(result.error).not.toContain("stale-rule-id");
  });

  it("gitleaks unavailable (ENOENT) refuses with no commit or push", async () => {
    const root = makeRoot();
    arm({
      gitleaks: () => ({ status: null, error: Object.assign(new Error("spawnSync gitleaks ENOENT"), { code: "ENOENT" }) }),
    });
    const result = await publishLive(root);
    expect(gitleaksCalls()[0].cmd).toBe("gitleaks");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/gitleaks is unavailable/i);
    expect(gitCalls("init")).toEqual([]);
    expect(gitCalls("commit")).toEqual([]);
    expect(forcePushes()).toEqual([]);
  });

  it.each([
    ["status null (signal/timeout)", () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "" })],
    ["status 2", () => ({ status: 2, stdout: "", stderr: "" })],
    ["status 126", () => ({ status: 126, stdout: "", stderr: "" })],
    [
      "a non-ENOENT spawn error",
      () => ({ status: 0, error: Object.assign(new Error("EACCES"), { code: "EACCES" }) }),
    ],
  ])("%s refuses; only status 0 with no error is clean", async (_label, impl) => {
    const root = makeRoot();
    arm({ gitleaks: impl });
    const result = await publishLive(root);
    expect(result.ok).toBe(false);
    expect(gitCalls("commit")).toEqual([]);
    expect(forcePushes()).toEqual([]);
  });

  it.each([
    ["success", (args) => { fs.writeFileSync(argAfter(args, "--report-path"), "[]"); return { status: 0 }; }, true],
    ["finding", (args) => { fs.writeFileSync(argAfter(args, "--report-path"), FINDING_REPORT); return { status: 1 }; }, false],
    ["scan failure", (args) => { fs.writeFileSync(argAfter(args, "--report-path"), "{bad"); return { status: 1 }; }, false],
    ["unavailable", () => ({ status: null, error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) }), false],
  ])("leaves no report file after the %s return", async (_label, impl, ok) => {
    const root = makeRoot();
    arm({ gitleaks: (cmd, args) => impl(args) });
    const result = await publishLive(root);
    expect(result.ok).toBe(ok);
    expect(fs.existsSync(reportPathOf())).toBe(false);
  });

  it.each([
    ["finding", leaks(FINDING_REPORT, 1)],
    ["scan failure", leaks(undefined, 1)],
    ["unavailable", () => ({ status: null, error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) })],
  ])("removes .rks/publish-tmp after the %s refusal", async (_label, impl) => {
    const root = makeRoot();
    let tmpExistedAtScan = false;
    arm({
      gitleaks: (cmd, args, opts) => {
        tmpExistedAtScan = fs.existsSync(opts.cwd);
        return impl(cmd, args, opts);
      },
    });
    const result = await publishLive(root);
    expect(result.ok).toBe(false);
    expect(tmpExistedAtScan).toBe(true);
    expect(fs.existsSync(path.join(root, ".rks", "publish-tmp"))).toBe(false);
  });
});

// --- resolution and parity ----------------------------------------------------------------

describe("publish() mirror secret scan — .gitleaksignore refusal", () => {
  const PUBLISH_SRC = fs.readFileSync(
    new URL("../../packages/mcp-rks/src/server/publish.mjs", import.meta.url),
    "utf8"
  );
  const revParseCalls = () =>
    calls().filter((c) => c.cmd === "git" && c.args[0] === "rev-parse" && c.args[1] === "--git-common-dir");
  const expectIgnoreRefusal = (result) => {
    expect(result.ok).toBe(false);
    expect(String(result.error).startsWith("Publish refused:")).toBe(true);
    expect(String(result.error)).toContain(".gitleaksignore");
    expect(gitleaksCalls()).toHaveLength(0);
    expect(revParseCalls()).toHaveLength(0);
    expectNoMirrorCommit();
  };

  it("a regular-file .gitleaksignore at the mirror root refuses before any gitleaks or rev-parse spawn, with no commit or push", async () => {
    const root = makeRoot();
    arm({ tar: (opts) => fs.writeFileSync(path.join(opts.cwd, ".gitleaksignore"), "deadbeef:file.txt:rule:1\n") });
    expectIgnoreRefusal(await publishLive(root));
  });

  it("a .gitleaksignore symlink to an existing file at the mirror root refuses the same way", async () => {
    const root = makeRoot();
    const target = path.join(root, "ignore-target.txt");
    fs.writeFileSync(target, "deadbeef:file.txt:rule:1\n");
    arm({ tar: (opts) => fs.symlinkSync(target, path.join(opts.cwd, ".gitleaksignore")) });
    expectIgnoreRefusal(await publishLive(root));
  });

  it("a dangling .gitleaksignore symlink at the mirror root refuses the same way", async () => {
    const root = makeRoot();
    arm({ tar: (opts) => fs.symlinkSync(path.join(root, "does-not-exist"), path.join(opts.cwd, ".gitleaksignore")) });
    expectIgnoreRefusal(await publishLive(root));
  });

  it("removes tmpDir and the secret-scan report after the refusal", async () => {
    const root = makeRoot();
    arm({ tar: (opts) => fs.writeFileSync(path.join(opts.cwd, ".gitleaksignore"), "x\n") });
    const result = await publishLive(root);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(root, ".rks", "publish-tmp"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".rks", "publish-secret-scan.json"))).toBe(false);
  });

  it("a .gitleaksignore below the mirror root does not refuse; the scan runs and publish succeeds", async () => {
    const root = makeRoot();
    arm({
      tar: (opts) => {
        fs.mkdirSync(path.join(opts.cwd, "notes"), { recursive: true });
        fs.writeFileSync(path.join(opts.cwd, "notes", ".gitleaksignore"), "x\n");
      },
    });
    const result = await publishLive(root);
    expect(result.ok).toBe(true);
    expect(gitleaksCalls()).toHaveLength(1);
  });

  it("the scanMirrorForSecrets JSDoc states the refusal instead of saying the ignore file is merely loaded", () => {
    expect(PUBLISH_SRC).not.toContain("also loads `<source>/.gitleaksignore` unconditionally, so");
    expect(PUBLISH_SRC).toMatch(/\.gitleaksignore`[\s\S]{0,40}is refused before any spawn/);
  });

  it("the publish() JSDoc sits directly above export async function publish and not above the mirror secret scan marker", () => {
    expect(PUBLISH_SRC).toMatch(/\/\*\*\n \* Publish filtered project to remote\n \*\/\nexport async function publish\(projectRoot, options = \{\}\) \{/);
    expect(PUBLISH_SRC).not.toMatch(/Publish filtered project to remote\n \*\/\n\/\/ --- Mirror secret scan/);
    expect(PUBLISH_SRC.match(/Publish filtered project to remote/g)).toHaveLength(1);
  });
});

describe("publish() mirror secret scan — resolution and parity", () => {
  it("prefers <git-common-dir>/rks-tools/gitleaks/gitleaks over PATH when present", async () => {
    const root = makeRoot();
    // Relative common dir, as `git rev-parse --git-common-dir` prints in a main checkout.
    const bin = path.join(root, ".git", "rks-tools", "gitleaks", "gitleaks");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    arm({ commonDir: ".git" });
    const result = await publishLive(root);
    expect(result.ok).toBe(true);
    const revParse = calls().find((c) => c.cmd === "git" && c.args[0] === "rev-parse" && c.args[1] === "--git-common-dir");
    expect(revParse.opts.cwd).toBe(root);
    expect(typeof revParse.opts.timeout).toBe("number");
    expect(gitleaksCalls()).toHaveLength(1);
    expect(gitleaksCalls()[0].cmd).toBe(bin);
  });

  it("falls back to bare gitleaks on PATH when no rks-tools copy exists or rev-parse stdout is empty", async () => {
    const rootA = makeRoot();
    arm({ commonDir: ".git" }); // common dir resolves, but no rks-tools copy under it
    await publishLive(rootA);
    expect(gitleaksCalls()[0].cmd).toBe("gitleaks");

    spawnSync.mockReset();
    const rootB = makeRoot();
    const bin = path.join(rootB, ".git", "rks-tools", "gitleaks", "gitleaks");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    arm({ commonDir: "" }); // empty stdout: the copy exists but cannot be located
    await publishLive(rootB);
    expect(gitleaksCalls()[0].cmd).toBe("gitleaks");
  });

  it("a clean scan publishes with the same git init/add/commit/remote add/push -f sequence", async () => {
    const root = makeRoot();
    const result = await publish(root, { remote: "target-remote", profile: "mirror", message: "Pub msg" });
    expect(result.ok).toBe(true);
    const tmpDir = path.join(root, ".rks", "publish-tmp");
    const seq = calls().filter(
      (c) =>
        c.cmd === "git" &&
        c.opts?.cwd === tmpDir &&
        ["init", "add", "commit", "remote", "push"].includes(c.args[0]),
    );
    expect(seq.map((c) => c.args)).toEqual([
      ["init"],
      ["add", "-A"],
      ["commit", "-m", "Pub msg"],
      ["remote", "add", "target", "git@github.com:example/fixture-mirror.git"],
      ["push", "-f", "target", "HEAD:main"],
    ]);
  });

  it("dry-run and enabled:false remotes spawn no gitleaks", async () => {
    const rootDry = makeRoot();
    const dry = await publish(rootDry, { remote: "target-remote", profile: "mirror", dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(gitleaksCalls()).toEqual([]);

    spawnSync.mockReset();
    arm();
    const rootOff = makeRoot({ enabled: false });
    const off = await publishLive(rootOff);
    expect(off.suppressed).toBe(true);
    expect(gitleaksCalls()).toEqual([]);
  });
});
