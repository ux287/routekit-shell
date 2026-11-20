/**
 * Story: backlog.feat.preflight-secret-scan-posture
 *
 * Drives checkSecretScanPosture() against real temp git repos. No real gitleaks binary is used:
 * scanners are fake executable files on disk, and `<scanner> version` is answered by an injected
 * spawnImpl. Every other command routed through spawnImpl (git) runs for real with the parent
 * environment. Every subprocess spawn passes an explicit timeout.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkSecretScanPosture } from "../../packages/mcp-rks/src/server/preflight.mjs";
import * as shared from "../../packages/mcp-rks/src/shared/secret-scan-constants.mjs";
import * as installer from "../../scripts/install-git-hooks.mjs";

const { PRE_COMMIT_MARKER } = shared;

const TIMEOUT = 20_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PIN_VERSION = "8.30.1";
const WARNING_CODES = [
  "unpinned_path_scanner",
  "scanner_version_mismatch",
  "scanner_version_unreadable",
  "override_set_in_server_env",
  "gitleaks_config_missing",
  "pin_unreadable",
];
const tmps = [];

function mkTmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tmps.push(d);
  return d;
}
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function writeExe(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}
function writePin(version = PIN_VERSION) {
  const p = path.join(mkTmp("rks-pin-"), "gitleaks-pin.json");
  fs.writeFileSync(p, JSON.stringify({ version }));
  return p;
}
function makeRepo({ armHooksPath = true, hooksPathValue = ".routekit/git-hooks", config = true } = {}) {
  const root = mkTmp("rks-secret-scan-");
  git(root, ["init"]);
  fs.mkdirSync(path.join(root, ".routekit", "git-hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".routekit", "git-hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (armHooksPath) git(root, ["config", "--local", "core.hooksPath", hooksPathValue]);
  if (config) fs.writeFileSync(path.join(root, ".gitleaks.toml"), "title = \"t\"\n");
  return root;
}
function rksToolsScanner(root, name = "gitleaks") {
  const common = path.resolve(root, git(root, ["rev-parse", "--git-common-dir"]));
  return writeExe(path.join(common, "rks-tools", "gitleaks", name));
}
function pathScanner() {
  const dir = mkTmp("rks-path-bin-");
  return { dir, bin: writeExe(path.join(dir, "gitleaks")) };
}
function emptyPath() {
  return mkTmp("rks-empty-path-");
}
/** Answers `<gitleaks> version`; every other command (git) runs for real with the parent env. */
function fakeSpawn({ stdout = `${PIN_VERSION}\n`, status = 0, error } = {}) {
  const calls = [];
  const impl = (cmd, args, opts = {}) => {
    if (path.basename(String(cmd)).startsWith("gitleaks")) {
      calls.push({ cmd, args, opts });
      if (error) return { status: null, stdout: "", stderr: "", error };
      return { status, stdout, stderr: "" };
    }
    const { env: _ignoredEnv, ...rest } = opts;
    return spawnSync(cmd, args, { encoding: "utf8", ...rest, timeout: rest.timeout ?? TIMEOUT });
  };
  impl.calls = calls;
  return impl;
}
function run(root, { env, spawnImpl = fakeSpawn(), pinPath = writePin() } = {}) {
  return checkSecretScanPosture({ projectRoot: root, env: env ?? { PATH: emptyPath() }, spawnImpl, pinPath });
}
const real = (p) => fs.realpathSync(p);

afterEach(() => {
  for (const d of tmps.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe("checkSecretScanPosture shape", () => {
  it("returns a secret_scan check carrying name, passed, detail, hint and posture", () => {
    const root = makeRepo();
    rksToolsScanner(root);
    const check = run(root);
    expect(check.name).toBe("secret_scan");
    for (const k of ["name", "passed", "detail", "hint", "posture"]) expect(check).toHaveProperty(k);
    for (const k of ["armed", "hookArmed", "scannerSource", "scannerPath", "scannerVersion", "pinnedVersion", "overrideSet", "configPresent", "warnings"]) {
      expect(check.posture).toHaveProperty(k);
    }
    expect(Array.isArray(check.posture.warnings)).toBe(true);
    for (const w of check.posture.warnings) expect(WARNING_CODES).toContain(w);
  });

  it("a fully armed pinned scanner at the pin version passes with no warnings", () => {
    const root = makeRepo();
    rksToolsScanner(root);
    const check = run(root);
    expect(check.passed).toBe(true);
    expect(check.posture.armed).toBe(true);
    expect(check.posture.hookArmed).toBe(true);
    expect(check.posture.scannerSource).toBe("rks_tools");
    expect(check.posture.scannerVersion).toBe(PIN_VERSION);
    expect(check.posture.pinnedVersion).toBe(PIN_VERSION);
    expect(check.posture.warnings).toEqual([]);
    expect(typeof check.detail).toBe("string");
  });
});

describe("scanner resolution order", () => {
  it("prefers the rks-tools gitleaks over a PATH gitleaks when both exist", () => {
    const root = makeRepo();
    const rks = rksToolsScanner(root);
    const { dir } = pathScanner();
    const check = run(root, { env: { PATH: dir } });
    expect(check.posture.scannerSource).toBe("rks_tools");
    expect(real(check.posture.scannerPath)).toBe(real(rks));
    expect(check.posture.warnings).not.toContain("unpinned_path_scanner");
  });

  it("falls back to the rks-tools gitleaks.exe when the rks-tools gitleaks is absent", () => {
    const root = makeRepo();
    const exe = rksToolsScanner(root, "gitleaks.exe");
    const check = run(root);
    expect(check.posture.scannerSource).toBe("rks_tools");
    expect(real(check.posture.scannerPath)).toBe(real(exe));
  });

  it("uses a PATH gitleaks when no rks-tools copy exists, passing with an unpinned_path_scanner warning", () => {
    const root = makeRepo();
    const { dir, bin } = pathScanner();
    const check = run(root, { env: { PATH: dir } });
    expect(check.posture.scannerSource).toBe("path");
    expect(real(check.posture.scannerPath)).toBe(real(bin));
    expect(check.passed).toBe(true);
    expect(check.posture.warnings).toContain("unpinned_path_scanner");
    expect(typeof check.hint).toBe("string");
    expect(check.hint.length).toBeGreaterThan(0);
  });
});

describe("hook arming", () => {
  it("core.hooksPath with a trailing slash counts as hookArmed", () => {
    const root = makeRepo({ hooksPathValue: ".routekit/git-hooks/" });
    rksToolsScanner(root);
    expect(run(root).posture.hookArmed).toBe(true);
  });

  it("a managed shim carrying PRE_COMMIT_MARKER in the git hooks dir counts as hookArmed", () => {
    const root = makeRepo({ armHooksPath: false });
    rksToolsScanner(root);
    const hooksDir = path.resolve(root, git(root, ["rev-parse", "--git-path", "hooks"]));
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, "pre-commit"), `#!/bin/sh\n${PRE_COMMIT_MARKER}\nexit 0\n`, { mode: 0o755 });
    const check = run(root);
    expect(check.posture.hookArmed).toBe(true);
    expect(check.posture.armed).toBe(true);
  });
});

describe("not armed", () => {
  it("no hook armed gives passed false with a hint naming npm install and routekit project upgrade", () => {
    const root = makeRepo({ armHooksPath: false });
    rksToolsScanner(root);
    const check = run(root);
    expect(check.posture.hookArmed).toBe(false);
    expect(check.posture.armed).toBe(false);
    expect(check.passed).toBe(false);
    expect(check.hint).toContain("npm install");
    expect(check.hint).toContain("routekit project upgrade");
  });

  it("no scanner anywhere gives passed false with scannerSource, scannerPath and scannerVersion null", () => {
    const root = makeRepo();
    const spawnImpl = fakeSpawn();
    const check = run(root, { spawnImpl });
    expect(check.posture.scannerSource).toBeNull();
    expect(check.posture.scannerPath).toBeNull();
    expect(check.posture.scannerVersion).toBeNull();
    expect(check.posture.armed).toBe(false);
    expect(check.passed).toBe(false);
    expect(check.hint).toContain("npm install");
    expect(check.hint).toContain("routekit project upgrade");
    expect(spawnImpl.calls).toHaveLength(0);
  });
});

describe("scanner version", () => {
  it("a version different from the pin gives scanner_version_mismatch and still passes", () => {
    const root = makeRepo();
    rksToolsScanner(root);
    const check = run(root, { spawnImpl: fakeSpawn({ stdout: "8.29.0\n" }) });
    expect(check.posture.scannerVersion).toBe("8.29.0");
    expect(check.posture.warnings).toContain("scanner_version_mismatch");
    expect(check.posture.warnings).not.toContain("scanner_version_unreadable");
    expect(check.passed).toBe(true);
  });

  it("unparseable version stdout gives scanner_version_unreadable and scannerVersion null", () => {
    const root = makeRepo();
    rksToolsScanner(root);
    const check = run(root, { spawnImpl: fakeSpawn({ stdout: "not a version\n" }) });
    expect(check.posture.scannerVersion).toBeNull();
    expect(check.posture.warnings).toContain("scanner_version_unreadable");
  });

  it("a failed version spawn gives scanner_version_unreadable and scannerVersion null", () => {
    const root = makeRepo();
    rksToolsScanner(root);
    const check = run(root, { spawnImpl: fakeSpawn({ error: new Error("spawn ENOENT") }) });
    expect(check.posture.scannerVersion).toBeNull();
    expect(check.posture.warnings).toContain("scanner_version_unreadable");
  });

  it("runs `<scannerPath> version` with a bounded timeout", () => {
    const root = makeRepo();
    const rks = rksToolsScanner(root);
    const spawnImpl = fakeSpawn();
    run(root, { spawnImpl });
    expect(spawnImpl.calls).toHaveLength(1);
    expect(real(spawnImpl.calls[0].cmd)).toBe(real(rks));
    expect(spawnImpl.calls[0].args).toEqual(["version"]);
    expect(Number.isFinite(spawnImpl.calls[0].opts.timeout)).toBe(true);
    expect(spawnImpl.calls[0].opts.timeout).toBeGreaterThan(0);
  });
});

describe("server-env override", () => {
  it("RKS_ALLOW_UNSCANNED_COMMIT=1 gives overrideSet true, override_set_in_server_env, and a hint naming the server environment", () => {
    const root = makeRepo();
    rksToolsScanner(root);
    const check = run(root, { env: { PATH: emptyPath(), RKS_ALLOW_UNSCANNED_COMMIT: "1" } });
    expect(check.posture.overrideSet).toBe(true);
    expect(check.posture.warnings).toContain("override_set_in_server_env");
    expect(check.hint).toMatch(/server/i);
  });

  it.each([[undefined], ["0"], ["true"], [""]])("RKS_ALLOW_UNSCANNED_COMMIT=%s gives overrideSet false", (value) => {
    const root = makeRepo();
    rksToolsScanner(root);
    const env = { PATH: emptyPath() };
    if (value !== undefined) env.RKS_ALLOW_UNSCANNED_COMMIT = value;
    const check = run(root, { env });
    expect(check.posture.overrideSet).toBe(false);
    expect(check.posture.warnings).not.toContain("override_set_in_server_env");
  });
});

describe("gitleaks config", () => {
  it("a missing .gitleaks.toml gives configPresent false and gitleaks_config_missing", () => {
    const root = makeRepo({ config: false });
    rksToolsScanner(root);
    const check = run(root);
    expect(check.posture.configPresent).toBe(false);
    expect(check.posture.warnings).toContain("gitleaks_config_missing");
    expect(check.passed).toBe(true);
  });

  it("a present .gitleaks.toml gives configPresent true and no gitleaks_config_missing", () => {
    const root = makeRepo();
    rksToolsScanner(root);
    const check = run(root);
    expect(check.posture.configPresent).toBe(true);
    expect(check.posture.warnings).not.toContain("gitleaks_config_missing");
  });
});

describe("pin source", () => {
  it("reads the shell's scripts/gitleaks-pin.json, never <projectRoot>/scripts/gitleaks-pin.json", () => {
    const shellPin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts", "gitleaks-pin.json"), "utf8")).version;
    const root = makeRepo();
    rksToolsScanner(root);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "gitleaks-pin.json"), JSON.stringify({ version: "0.0.0-decoy" }));
    const check = checkSecretScanPosture({
      projectRoot: root,
      env: { PATH: emptyPath() },
      spawnImpl: fakeSpawn({ stdout: `${shellPin}\n` }),
    });
    expect(check.posture.pinnedVersion).toBe(shellPin);
    expect(check.posture.pinnedVersion).not.toBe("0.0.0-decoy");
  });
});

describe("pin read fails soft", () => {
  it("a missing pin file gives pinnedVersion null and pin_unreadable without throwing", () => {
    const root = makeRepo();
    rksToolsScanner(root);
    const missing = path.join(mkTmp("rks-nopin-"), "absent-gitleaks-pin.json");
    let check;
    expect(() => { check = run(root, { pinPath: missing }); }).not.toThrow();
    expect(check.posture.pinnedVersion).toBeNull();
    expect(check.posture.warnings).toContain("pin_unreadable");
    expect(check.posture.warnings).not.toContain("scanner_version_mismatch");
    expect(check.passed).toBe(true);
  });

  it("an unparseable pin file gives pinnedVersion null and pin_unreadable without throwing", () => {
    const root = makeRepo();
    rksToolsScanner(root);
    const bad = path.join(mkTmp("rks-badpin-"), "gitleaks-pin.json");
    fs.writeFileSync(bad, "not json");
    let check;
    expect(() => { check = run(root, { pinPath: bad }); }).not.toThrow();
    expect(check.posture.pinnedVersion).toBeNull();
    expect(check.posture.warnings).toContain("pin_unreadable");
  });
});

describe("single-source secret-scan constants", () => {
  it("scripts/install-git-hooks.mjs re-exports the shared marker, hook path, override name and PATH lookup", () => {
    expect(installer.PRE_COMMIT_MARKER).toBe(shared.PRE_COMMIT_MARKER);
    expect(installer.HOOK_REL).toBe(shared.HOOK_REL);
    expect(installer.OVERRIDE_ENV).toBe(shared.OVERRIDE_ENV);
    expect(installer.findGitleaksOnPath).toBe(shared.findGitleaksOnPath);
  });

  it("the marker literal appears in the shared module and not in scripts/install-git-hooks.mjs", () => {
    const literal = "# rks-gitleaks-pre-commit (managed)";
    const sharedSrc = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/shared/secret-scan-constants.mjs"), "utf8");
    const installerSrc = fs.readFileSync(path.join(REPO_ROOT, "scripts/install-git-hooks.mjs"), "utf8");
    expect(sharedSrc).toContain(literal);
    expect(installerSrc).not.toContain(literal);
  });
});

describe("preflight.mjs import boundary", () => {
  it("every relative import in preflight.mjs and the shared module resolves inside packages/mcp-rks", () => {
    const pkgRoot = path.join(REPO_ROOT, "packages", "mcp-rks");
    for (const rel of ["packages/mcp-rks/src/server/preflight.mjs", "packages/mcp-rks/src/shared/secret-scan-constants.mjs"]) {
      const file = path.join(REPO_ROOT, rel);
      const src = fs.readFileSync(file, "utf8");
      // Covers `import x from "s"`, `export ... from "s"`, bare side-effect `import "s"`, and `import("s")`,
      // with either quote style, so no static or dynamic form can reach outside the package unseen.
      const specs = [
        ...src.matchAll(/\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ].map((m) => m[1] ?? m[2] ?? m[3]);
      expect(specs.length).toBeGreaterThan(0);
      for (const s of specs.filter((x) => x.startsWith("."))) {
        const resolved = path.resolve(path.dirname(file), s);
        expect(resolved.startsWith(pkgRoot + path.sep), `${rel} imports ${s}`).toBe(true);
      }
    }
  });
});

describe("non-git directory", () => {
  it("returns the check with passed false and detail 'not a git repo' without throwing", () => {
    const dir = mkTmp("rks-not-git-");
    let check;
    expect(() => { check = run(dir); }).not.toThrow();
    expect(check.name).toBe("secret_scan");
    expect(check.passed).toBe(false);
    expect(check.detail).toBe("not a git repo");
  });
});

describe("rks_preflight wiring", () => {
  it("planner.mjs imports checkSecretScanPosture and calls it after the checkGitReadiness loop inside the rks_preflight handler", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/handlers/planner.mjs"), "utf8");
    expect(src).toMatch(/import\s*\{[^}]*\bcheckSecretScanPosture\b[^}]*\}\s*from\s*"\.\.\/preflight\.mjs"/);
    const handlerIdx = src.indexOf('registerHandler("rks_preflight"');
    const gitIdx = src.indexOf("checkGitReadiness({");
    const scanIdx = src.indexOf("checkSecretScanPosture({");
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(gitIdx).toBeGreaterThan(handlerIdx);
    expect(scanIdx).toBeGreaterThan(gitIdx);
  });
});

// ---------------------------------------------------------------------------
// backlog.fix.preflight-secret-scan-hook-file-armed
// ---------------------------------------------------------------------------

const HOOK_FILE_REL = path.join(".routekit", "git-hooks", "pre-commit");
const IS_WIN = process.platform === "win32";
const NON_WIN = IS_WIN ? "linux" : process.platform;

function hookFile(root) {
  return path.join(root, HOOK_FILE_REL);
}
function installMarkerShim(root) {
  const hooksDir = path.resolve(root, git(root, ["rev-parse", "--git-path", "hooks"]));
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "pre-commit"), `#!/bin/sh\n${PRE_COMMIT_MARKER}\nexit 0\n`, { mode: 0o755 });
}
function textOf(check) {
  return `${check.detail ?? ""} ${check.hint ?? ""}`;
}

describe("shared isExecutableFile and RKS_TOOLS_SCANNER_NAMES", () => {
  it("isExecutableFile: 0o755 file true, directory false, missing false", () => {
    expect(typeof shared.isExecutableFile).toBe("function");
    const dir = mkTmp("rks-isexe-");
    const exe = writeExe(path.join(dir, "tool"));
    expect(shared.isExecutableFile(exe)).toBe(true);
    expect(shared.isExecutableFile(dir)).toBe(false);
    expect(shared.isExecutableFile(path.join(dir, "absent"))).toBe(false);
  });

  it.skipIf(IS_WIN)("isExecutableFile: a 0o644 file is false on non-win32 and true when platform is win32", () => {
    const dir = mkTmp("rks-isexe-644-");
    const f = path.join(dir, "plain");
    fs.writeFileSync(f, "x\n", { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    expect(shared.isExecutableFile(f, NON_WIN)).toBe(false);
    expect(shared.isExecutableFile(f, "win32")).toBe(true);
  });

  it("RKS_TOOLS_SCANNER_NAMES is gitleaks then gitleaks.exe", () => {
    expect(shared.RKS_TOOLS_SCANNER_NAMES).toEqual(["gitleaks", "gitleaks.exe"]);
  });

  it("findGitleaksOnPath returns the executable gitleaks in a PATH directory", () => {
    const { dir, bin } = pathScanner();
    expect(shared.findGitleaksOnPath({ PATH: dir }, NON_WIN)).toBe(bin);
  });

  it.skipIf(IS_WIN)("findGitleaksOnPath skips a 0o644 gitleaks and a directory named gitleaks, then finds a later executable one", () => {
    const plainDir = mkTmp("rks-path-644-");
    const plain = path.join(plainDir, "gitleaks");
    fs.writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
    fs.chmodSync(plain, 0o644);
    const dirDir = mkTmp("rks-path-dir-");
    fs.mkdirSync(path.join(dirDir, "gitleaks"));
    expect(shared.findGitleaksOnPath({ PATH: [plainDir, dirDir].join(path.delimiter) }, NON_WIN)).toBeNull();
    const { dir, bin } = pathScanner();
    expect(shared.findGitleaksOnPath({ PATH: [plainDir, dirDir, dir].join(path.delimiter) }, NON_WIN)).toBe(bin);
  });

  it("findGitleaksOnPath returns null for a PATH holding no gitleaks", () => {
    expect(shared.findGitleaksOnPath({ PATH: emptyPath() }, NON_WIN)).toBeNull();
    expect(shared.findGitleaksOnPath({}, NON_WIN)).toBeNull();
  });

  it("secret-scan-constants.mjs contains exactly one fs.constants.X_OK", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/shared/secret-scan-constants.mjs"), "utf8");
    expect(src.split("fs.constants.X_OK").length - 1).toBe(1);
  });

  it("preflight.mjs has no local isExecutableFile, imports the shared helper and names, and has no inline candidate array", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/preflight.mjs"), "utf8");
    expect(src).not.toMatch(/\bfunction\s+isExecutableFile\b/);
    expect(src).not.toMatch(/\b(?:const|let|var)\s+isExecutableFile\b/);
    const imp = src.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\.\/shared\/secret-scan-constants\.mjs["']/);
    expect(imp).not.toBeNull();
    expect(imp[1]).toMatch(/\bisExecutableFile\b/);
    expect(imp[1]).toMatch(/\bRKS_TOOLS_SCANNER_NAMES\b/);
    expect(src).not.toMatch(/\[\s*["'`]gitleaks["'`]\s*,\s*["'`]gitleaks\.exe["'`]\s*\]/);
  });
});

describe("hook arming requires the hook file", () => {
  it("core.hooksPath route with the hook file deleted: hook_file_missing, not armed, passed false", () => {
    const root = makeRepo();
    rksToolsScanner(root);
    fs.rmSync(hookFile(root));
    const check = run(root);
    expect(check.posture.hookArmed).toBe(false);
    expect(check.posture.hookReason).toBe("hook_file_missing");
    expect(check.posture.hookFilePresent).toBe(false);
    expect(check.posture.armed).toBe(false);
    expect(check.passed).toBe(false);
  });

  it.skipIf(IS_WIN)("core.hooksPath route with the hook file at 0o644: hook_file_not_executable, passed false", () => {
    const root = makeRepo();
    rksToolsScanner(root);
    fs.chmodSync(hookFile(root), 0o644);
    const check = run(root);
    expect(check.posture.hookArmed).toBe(false);
    expect(check.posture.hookReason).toBe("hook_file_not_executable");
    expect(check.posture.hookFilePresent).toBe(true);
    expect(check.posture.hookFileExecutable).toBe(false);
    expect(check.passed).toBe(false);
  });

  it("shim route with the hook file deleted: hook_file_missing, passed false", () => {
    const root = makeRepo({ armHooksPath: false });
    rksToolsScanner(root);
    installMarkerShim(root);
    fs.rmSync(hookFile(root));
    const check = run(root);
    expect(check.posture.hookArmed).toBe(false);
    expect(check.posture.hookReason).toBe("hook_file_missing");
    expect(check.passed).toBe(false);
  });

  it("shim route with the hook file at 0o644 still arms (the shim runs it via exec sh)", () => {
    const root = makeRepo({ armHooksPath: false });
    rksToolsScanner(root);
    installMarkerShim(root);
    fs.chmodSync(hookFile(root), 0o644);
    const check = run(root);
    expect(check.posture.hookArmed).toBe(true);
    expect(check.posture.hookReason).toBeNull();
    expect(check.passed).toBe(true);
  });

  it("hook_file_missing: detail names the code; hint names the file, git checkout, npm install and routekit project upgrade", () => {
    const root = makeRepo();
    rksToolsScanner(root);
    fs.rmSync(hookFile(root));
    const check = run(root);
    expect(check.detail).toContain("hook_file_missing");
    expect(check.hint).toContain(".routekit/git-hooks/pre-commit");
    expect(check.hint).toContain("git checkout");
    expect(check.hint).toContain("npm install");
    expect(check.hint).toContain("routekit project upgrade");
  });

  it.skipIf(IS_WIN)("hook_file_not_executable: detail names the code; hint names the file, chmod +x, npm install and routekit project upgrade", () => {
    const root = makeRepo();
    rksToolsScanner(root);
    fs.chmodSync(hookFile(root), 0o644);
    const check = run(root);
    expect(check.detail).toContain("hook_file_not_executable");
    expect(check.hint).toContain(".routekit/git-hooks/pre-commit");
    expect(check.hint).toContain("chmod +x");
    expect(check.hint).toContain("npm install");
    expect(check.hint).toContain("routekit project upgrade");
  });

  it("a fully armed core.hooksPath repo reports hookFilePresent true, hookFileExecutable true and hookReason null", () => {
    const root = makeRepo();
    rksToolsScanner(root);
    const check = run(root);
    expect(check.posture.hookFilePresent).toBe(true);
    expect(check.posture.hookFileExecutable).toBe(true);
    expect(check.posture.hookReason).toBeNull();
    expect(check.passed).toBe(true);
  });

  it("a foreign core.hooksPath gives hookArmed false and hookReason hooks_path_foreign", () => {
    const root = makeRepo({ hooksPathValue: ".husky" });
    rksToolsScanner(root);
    const check = run(root);
    expect(check.posture.hookArmed).toBe(false);
    expect(check.posture.hookReason).toBe("hooks_path_foreign");
  });

  it("no core.hooksPath and no marker shim gives hookArmed false and hookReason not_installed", () => {
    const root = makeRepo({ armHooksPath: false });
    rksToolsScanner(root);
    const check = run(root);
    expect(check.posture.hookArmed).toBe(false);
    expect(check.posture.hookReason).toBe("not_installed");
  });
});

describe("scanner candidate order is tied to the pre-commit hook", () => {
  it("the repo's .routekit/git-hooks/pre-commit lists rks-tools candidates in RKS_TOOLS_SCANNER_NAMES order, before command -v gitleaks", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, ".routekit", "git-hooks", "pre-commit"), "utf8");
    // Each candidate is matched with its closing quote, so `.../gitleaks"` is not a prefix match of
    // `.../gitleaks.exe"` and the unquoted mention in the REFUSED echo is not counted.
    const positions = shared.RKS_TOOLS_SCANNER_NAMES.map((name) => {
      const idx = src.indexOf(`rks-tools/gitleaks/${name}"`);
      expect(idx, `candidate rks-tools/gitleaks/${name}" in the hook`).toBeGreaterThan(-1);
      return idx;
    });
    for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    const pathLookup = src.indexOf("command -v gitleaks");
    expect(pathLookup).toBeGreaterThan(-1);
    for (const p of positions) expect(p).toBeLessThan(pathLookup);
  });
});

describe("PATH lookup is the MCP server's", () => {
  it("scannerSource path: detail or hint says the PATH lookup used the MCP server's environment", () => {
    const root = makeRepo();
    const { dir } = pathScanner();
    const check = run(root, { env: { PATH: dir } });
    expect(check.posture.scannerSource).toBe("path");
    expect(textOf(check)).toContain("MCP server");
    expect(textOf(check)).toContain("PATH");
  });

  it("no scanner found: detail or hint says the PATH lookup used the MCP server's environment", () => {
    const root = makeRepo();
    const check = run(root);
    expect(check.posture.scannerSource).toBeNull();
    expect(textOf(check)).toContain("MCP server");
    expect(textOf(check)).toContain("PATH");
  });
});
