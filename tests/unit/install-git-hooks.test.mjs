// tests/unit/install-git-hooks.test.mjs
// backlog.security.gitleaks-gate-arming — installer: pin, provisioning, shim, armSecretScan, CLI.
// No network: every download goes through a stub fetchImpl serving a fixture archive, and the CLI
// download path runs under a node --import preload that replaces globalThis.fetch.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PRE_COMMIT_MARKER, HOOK_REL, loadPin, provisionGitleaks, installPreCommitShim, armSecretScan,
} from "../../scripts/install-git-hooks.mjs";
import { installContentOnlyPrePush } from "../../packages/cli/src/project/content-only.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO, "scripts", "install-git-hooks.mjs");
const T = 15_000;
const TEST_TIMEOUT = 30_000;
const ASSET = "gitleaks_8.30.1_linux_x64.tar.gz";
const LINUX = { platform: "linux", arch: "x64" };
const dirs = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf-8", timeout: T }).trim();
function repo() { const d = tmp("rks-igh-"); git(d, ["init", "-q"]); return d; }
function repoWithHook() {
  const d = repo();
  fs.mkdirSync(path.join(d, path.dirname(HOOK_REL)), { recursive: true });
  fs.writeFileSync(path.join(d, HOOK_REL), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return d;
}
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const commonDir = (d) => path.resolve(d, git(d, ["rev-parse", "--git-common-dir"]));
const gitHooksDir = (d) => path.resolve(d, git(d, ["rev-parse", "--git-path", "hooks"]));
const hooksPathCfg = (d) => spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: d, encoding: "utf-8", timeout: T });
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map(String) : []);

// Fixture: a tar.gz holding an executable stub named gitleaks.
function fixtureArchive(name = ASSET) {
  const src = tmp("rks-igh-src-");
  fs.writeFileSync(path.join(src, "gitleaks"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const out = path.join(tmp("rks-igh-arc-"), name);
  execFileSync("tar", ["-czf", out, "-C", src, "gitleaks"], { timeout: T });
  return fs.readFileSync(out);
}
const testPin = (bytes, file = ASSET) => ({
  version: "8.30.1", baseUrl: "https://example.invalid/dl/", assets: { "linux-x64": { file, sha256: sha(bytes) } },
});
const stubFetch = (bytes, { ok = true, status = 200 } = {}) => {
  const calls = [];
  const f = async (url) => { calls.push(url); return { ok, status, arrayBuffer: async () => bytes }; };
  f.calls = calls;
  return f;
};
const rejectingFetch = () => {
  const calls = [];
  const f = async (url) => { calls.push(url); throw new Error("network down (stub)"); };
  f.calls = calls;
  return f;
};
const emptyPathEnv = () => ({ PATH: tmp("rks-igh-emptybin-") });

describe("gitleaks pin", () => {
  it("pins 8.30.1 with exactly the six platform keys and the release base URL", () => {
    const pin = loadPin();
    expect(pin.version).toBe("8.30.1");
    expect(pin.baseUrl).toBe("https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/");
    expect(Object.keys(pin.assets).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
  });
  it("every asset file agrees with its key and carries a 64-hex lowercase sha256", () => {
    for (const [key, a] of Object.entries(loadPin().assets)) {
      const [plat, arch] = key.split("-");
      const os_ = plat === "win32" ? "windows" : plat;
      const ext = plat === "win32" ? "zip" : "tar.gz";
      expect(a.file).toBe(`gitleaks_8.30.1_${os_}_${arch}.${ext}`);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("provisionGitleaks", () => {
  it("installs from a verified download and caches the archive", async () => {
    const bytes = fixtureArchive();
    const d = repo();
    const r = await provisionGitleaks(d, { pin: testPin(bytes), fetchImpl: stubFetch(bytes), ...LINUX });
    expect(r.installed).toBe(true);
    const bin = path.join(commonDir(d), "rks-tools", "gitleaks", "gitleaks");
    expect(r.bin).toBe(bin);
    const st = fs.statSync(bin);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o111).not.toBe(0);
    const cached = path.join(commonDir(d), "rks-tools", "cache", ASSET);
    expect(fs.existsSync(cached)).toBe(true);
    expect(sha(fs.readFileSync(cached))).toBe(sha(bytes));
  }, TEST_TIMEOUT);

  it("fetches only the pinned asset URL, never a checksum or signature file", async () => {
    const bytes = fixtureArchive();
    const pin = testPin(bytes);
    const f = stubFetch(bytes);
    await provisionGitleaks(repo(), { pin, fetchImpl: f, ...LINUX });
    expect(f.calls).toEqual([`${pin.baseUrl}${ASSET}`]);
    for (const u of f.calls) expect(u).not.toMatch(/checksums|\.sha256|\.sig|\.asc/);
  }, TEST_TIMEOUT);

  it("checksum mismatch leaves no archive, no .part and no binary", async () => {
    const bytes = fixtureArchive();
    const d = repo();
    const r = await provisionGitleaks(d, { pin: testPin(bytes), fetchImpl: stubFetch(Buffer.from("tampered")), ...LINUX });
    expect(r.installed).toBe(false);
    expect(r.reason).toBe("checksum_mismatch");
    const tools = path.join(commonDir(d), "rks-tools");
    const files = walk(tools);
    expect(files.filter((f) => f.endsWith(ASSET))).toEqual([]);
    expect(files.filter((f) => f.endsWith(".part"))).toEqual([]);
    expect(fs.existsSync(path.join(tools, "gitleaks", "gitleaks"))).toBe(false);
  }, TEST_TIMEOUT);

  it("reuses the verified cache with zero fetches on a second run", async () => {
    const bytes = fixtureArchive();
    const d = repo();
    const pin = testPin(bytes);
    expect((await provisionGitleaks(d, { pin, fetchImpl: stubFetch(bytes), ...LINUX })).installed).toBe(true);
    const f2 = stubFetch(bytes);
    const r2 = await provisionGitleaks(d, { pin, fetchImpl: f2, ...LINUX });
    expect(f2.calls).toHaveLength(0);
    expect(r2.installed).toBe(true);
  }, TEST_TIMEOUT);

  it("reuses a matching caller cacheDirs archive and ignores a mismatching one", async () => {
    const bytes = fixtureArchive();
    const pin = testPin(bytes);
    const good = tmp("rks-igh-cache-good-");
    fs.writeFileSync(path.join(good, ASSET), bytes);
    const f1 = stubFetch(bytes);
    const r1 = await provisionGitleaks(repo(), { pin, fetchImpl: f1, cacheDirs: [good], ...LINUX });
    expect(f1.calls).toHaveLength(0);
    expect(r1.installed).toBe(true);

    const bad = tmp("rks-igh-cache-bad-");
    fs.writeFileSync(path.join(bad, ASSET), Buffer.from("not the pinned archive"));
    const f2 = stubFetch(bytes);
    const r2 = await provisionGitleaks(repo(), { pin, fetchImpl: f2, cacheDirs: [bad], ...LINUX });
    expect(f2.calls).toHaveLength(1);
    expect(r2.installed).toBe(true);
  }, TEST_TIMEOUT);

  it("unsupported platform installs nothing and fetches nothing", async () => {
    const d = repo();
    const f = stubFetch(Buffer.from(""));
    const r = await provisionGitleaks(d, { fetchImpl: f, platform: "aix", arch: "ppc64" });
    expect(r.installed).toBe(false);
    expect(r.reason).toBe("unsupported_platform");
    expect(f.calls).toHaveLength(0);
    expect(fs.existsSync(path.join(commonDir(d), "rks-tools", "gitleaks", "gitleaks"))).toBe(false);
  }, TEST_TIMEOUT);

  it("download failure (reject and 404) reports download_failed with no archive left", async () => {
    const bytes = fixtureArchive();
    const pin = testPin(bytes);
    for (const fetchImpl of [rejectingFetch(), stubFetch(bytes, { ok: false, status: 404 })]) {
      const d = repo();
      const r = await provisionGitleaks(d, { pin, fetchImpl, ...LINUX });
      expect(r.installed).toBe(false);
      expect(r.reason).toBe("download_failed");
      const files = walk(path.join(commonDir(d), "rks-tools"));
      expect(files.filter((f) => f.endsWith(ASSET))).toEqual([]);
      expect(files.filter((f) => f.endsWith(".part"))).toEqual([]);
    }
  }, TEST_TIMEOUT);

  it("an unextractable archive with the pinned hash reports tar_unavailable_or_failed", async () => {
    const junk = Buffer.from("this is not a tar archive at all\n");
    const d = repo();
    const r = await provisionGitleaks(d, { pin: testPin(junk), fetchImpl: stubFetch(junk), ...LINUX });
    expect(r.installed).toBe(false);
    expect(r.reason).toBe("tar_unavailable_or_failed");
    expect(fs.existsSync(path.join(commonDir(d), "rks-tools", "gitleaks", "gitleaks"))).toBe(false);
  }, TEST_TIMEOUT);
});

describe("installPreCommitShim", () => {
  it("writes the managed shim when core.hooksPath is unset and never sets core.hooksPath", () => {
    const d = repo();
    const r = installPreCommitShim(d);
    expect(r.armed).toBe(true);
    expect(r.via).toBe("shim");
    const file = path.join(gitHooksDir(d), "pre-commit");
    const body = fs.readFileSync(file, "utf-8");
    expect(body).toContain(PRE_COMMIT_MARKER);
    expect(body).toContain(HOOK_REL);
    expect(fs.statSync(file).mode & 0o111).not.toBe(0);
    expect(hooksPathCfg(d).status).toBe(1);
  });

  it("is idempotent over its own shim", () => {
    const d = repo();
    installPreCommitShim(d);
    const r = installPreCommitShim(d);
    expect(r.armed).toBe(true);
    const body = fs.readFileSync(path.join(gitHooksDir(d), "pre-commit"), "utf-8");
    expect(body.split("\n").filter((l) => l === PRE_COMMIT_MARKER)).toHaveLength(1);
  });

  it("refuses a foreign pre-commit and leaves it byte-identical", () => {
    const d = repo();
    const file = path.join(gitHooksDir(d), "pre-commit");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const foreign = "#!/bin/sh\necho foreign\nexit 0\n";
    fs.writeFileSync(file, foreign, { mode: 0o755 });
    const r = installPreCommitShim(d);
    expect(r.armed).toBe(false);
    expect(r.reason).toBe("foreign_pre_commit");
    expect(fs.readFileSync(file, "utf-8")).toBe(foreign);
  });

  it("refuses a foreign core.hooksPath and writes nothing", () => {
    const d = repo();
    git(d, ["config", "core.hooksPath", "custom-hooks"]);
    const r = installPreCommitShim(d);
    expect(r.armed).toBe(false);
    expect(r.reason).toBe("core_hooks_path");
    expect(fs.existsSync(path.join(d, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(fs.existsSync(path.join(d, "custom-hooks", "pre-commit"))).toBe(false);
    expect(git(d, ["config", "--get", "core.hooksPath"])).toBe("custom-hooks");
  });

  it("reports armed with nothing written when core.hooksPath is .routekit/git-hooks", () => {
    for (const value of [".routekit/git-hooks", ".routekit/git-hooks/"]) {
      const d = repo();
      git(d, ["config", "core.hooksPath", value]);
      const r = installPreCommitShim(d);
      expect(r.armed).toBe(true);
      expect(fs.existsSync(path.join(d, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(fs.existsSync(path.join(d, ".routekit", "git-hooks", "pre-commit"))).toBe(false);
      expect(git(d, ["config", "--get", "core.hooksPath"])).toBe(value);
    }
  });

  it("coexists with the content-only pre-push guard", () => {
    const d = repo();
    const prePush = installContentOnlyPrePush(d, { extraPaths: [] });
    expect(prePush.installed).toBe(true);
    const before = fs.readFileSync(prePush.path);
    const r = installPreCommitShim(d);
    expect(r.armed).toBe(true);
    expect(hooksPathCfg(d).status).toBe(1);
    expect(fs.readFileSync(prePush.path).equals(before)).toBe(true);
  });
});

describe("armSecretScan", () => {
  it("not_a_git_repo and hook_missing never fetch", async () => {
    const f = stubFetch(Buffer.from(""));
    const nogit = tmp("rks-igh-nogit-");
    expect(await armSecretScan(nogit, { fetchImpl: f })).toMatchObject({ armed: false, reason: "not_a_git_repo" });
    expect(await armSecretScan(repo(), { fetchImpl: f })).toMatchObject({ armed: false, reason: "hook_missing" });
    expect(f.calls).toHaveLength(0);
  });

  it("download failure with no PATH scanner hoists download_failed (reject and 404)", async () => {
    const bytes = fixtureArchive();
    for (const fetchImpl of [rejectingFetch(), stubFetch(bytes, { ok: false, status: 404 })]) {
      const r = await armSecretScan(repoWithHook(), { pin: testPin(bytes), fetchImpl, env: emptyPathEnv(), ...LINUX });
      expect(r.armed).toBe(false);
      expect(r.reason).toBe("download_failed");
      expect(r.hook.armed).toBe(true);
    }
  }, TEST_TIMEOUT);

  it("checksum mismatch with no PATH scanner hoists checksum_mismatch", async () => {
    const bytes = fixtureArchive();
    const r = await armSecretScan(repoWithHook(), {
      pin: testPin(bytes), fetchImpl: stubFetch(Buffer.from("tampered")), env: emptyPathEnv(), ...LINUX,
    });
    expect(r.armed).toBe(false);
    expect(r.reason).toBe("checksum_mismatch");
    expect(r.hook.armed).toBe(true);
  }, TEST_TIMEOUT);

  it("unsupported platform with no PATH scanner hoists unsupported_platform with zero fetches", async () => {
    const f = stubFetch(Buffer.from(""));
    const r = await armSecretScan(repoWithHook(), { fetchImpl: f, env: emptyPathEnv(), platform: "aix", arch: "ppc64" });
    expect(r.armed).toBe(false);
    expect(r.reason).toBe("unsupported_platform");
    expect(r.hook.armed).toBe(true);
    expect(f.calls).toHaveLength(0);
  }, TEST_TIMEOUT);

  it("provisioning failure with a gitleaks on PATH is armed via path", async () => {
    const bin = tmp("rks-igh-pathbin-");
    const stub = path.join(bin, "gitleaks");
    fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const bytes = fixtureArchive();
    const r = await armSecretScan(repoWithHook(), { pin: testPin(bytes), fetchImpl: rejectingFetch(), env: { PATH: bin }, ...LINUX });
    expect(r.armed).toBe(true);
    expect(r.scannerSource).toBe("path");
    expect(r.scannerPath).toBe(stub);
  }, TEST_TIMEOUT);

  it("successful provisioning is armed via rks_tools", async () => {
    const bytes = fixtureArchive();
    const d = repoWithHook();
    const r = await armSecretScan(d, { pin: testPin(bytes), fetchImpl: stubFetch(bytes), env: emptyPathEnv(), ...LINUX });
    expect(r.armed).toBe(true);
    expect(r.scannerSource).toBe("rks_tools");
    expect(r.scannerPath).toBe(path.join(commonDir(d), "rks-tools", "gitleaks", "gitleaks"));
  }, TEST_TIMEOUT);

  it("a foreign pre-commit with a provisioned scanner is not armed: foreign_pre_commit", async () => {
    const bytes = fixtureArchive();
    const d = repoWithHook();
    const file = path.join(gitHooksDir(d), "pre-commit");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const r = await armSecretScan(d, { pin: testPin(bytes), fetchImpl: stubFetch(bytes), env: emptyPathEnv(), ...LINUX });
    expect(r.armed).toBe(false);
    expect(r.reason).toBe("foreign_pre_commit");
    expect(r.scanner.installed).toBe(true);
  }, TEST_TIMEOUT);
});

describe("install-git-hooks CLI", () => {
  it("CLI exits 0 with a JSON reason and names the override; --strict exits non-zero", () => {
    const dir = tmp("rks-igh-nogit-");
    const r = spawnSync(process.execPath, [SCRIPT, "--project", dir, "--json"], { encoding: "utf-8", timeout: T });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim()).reason).toBe("not_a_git_repo");
    expect(r.stderr).toContain("RKS_ALLOW_UNSCANNED_COMMIT=1");
    const s = spawnSync(process.execPath, [SCRIPT, "--project", dir, "--json", "--strict"], { encoding: "utf-8", timeout: T });
    expect(s.status).not.toBe(0);
  }, TEST_TIMEOUT);

  it("CLI with provisioning failing (stubbed fetch 404) and no PATH gitleaks under --json --strict exits non-zero with download_failed", () => {
    // Precondition: this platform-arch pair is pinned, so the download path (not unsupported_platform) runs.
    expect(loadPin().assets[`${process.platform}-${process.arch}`]).toBeDefined();
    const which = (cmd) => execFileSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf-8", timeout: T }).trim();
    const bin = tmp("rks-igh-clibin-");
    fs.symlinkSync(which("git"), path.join(bin, "git"));
    fs.symlinkSync(which("tar"), path.join(bin, "tar"));
    const PATH = bin;
    const pre = spawnSync("/bin/sh", ["-c", "command -v gitleaks"], { env: { PATH }, encoding: "utf-8", timeout: T });
    expect(pre.status).not.toBe(0); // precondition: no gitleaks on this PATH
    const preload = path.join(tmp("rks-igh-preload-"), "stub-fetch.mjs");
    fs.writeFileSync(
      preload,
      "globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });\n",
    );
    const d = repoWithHook();
    const r = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preload).href, SCRIPT, "--project", d, "--json", "--strict"],
      { encoding: "utf-8", timeout: T, env: { PATH, HOME: d } },
    );
    expect(r.status).not.toBe(0);
    const result = JSON.parse(r.stdout.trim().split("\n").pop());
    expect(result.reason).toBe("download_failed");
    expect(result.armed).toBe(false);
  }, TEST_TIMEOUT);
});

describe("no wrapper dependency, docs row", () => {
  it("no package.json dependency key contains gitleaks", () => {
    for (const rel of ["package.json", path.join("packages", "cli", "package.json")]) {
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf-8"));
      for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
        for (const name of Object.keys(pkg[field] || {})) expect(name.toLowerCase()).not.toContain("gitleaks");
      }
    }
  });

  it("the readiness row names the arming mechanism", () => {
    const lines = fs
      .readFileSync(path.join(REPO, "notes", "research.2026.05.03.making-rks-public-requirements.md"), "utf-8")
      .split("\n");
    for (const line of lines.filter((l) => l.includes("Pre-commit hook confirmed functional."))) {
      expect(line).toContain("scripts/install-git-hooks.mjs");
    }
    expect(lines.some((l) => l.includes("scripts/install-git-hooks.mjs"))).toBe(true);
  });
});
