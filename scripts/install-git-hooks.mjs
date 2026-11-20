#!/usr/bin/env node
// scripts/install-git-hooks.mjs
// backlog.security.gitleaks-gate-arming
// Arms the gitleaks pre-commit secret scan for one git repository:
//   1. provisions a PINNED gitleaks, verified against the SHA-256 values committed in
//      scripts/gitleaks-pin.json (never against a checksum fetched at install time), into
//      <git-common-dir>/rks-tools/gitleaks/;
//   2. installs a managed pre-commit shim in `git rev-parse --git-path hooks` that runs the
//      tracked .routekit/git-hooks/pre-commit. core.hooksPath is never written.
// Every status it reports is read back from disk after the write (evidence-bound).
// Exit code is 0 on every not-armed outcome so `npm install` never breaks; --strict exits 1.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRE_COMMIT_MARKER,
  HOOK_REL,
  OVERRIDE_ENV,
  findGitleaksOnPath,
  rksToolsDirFromCommonDir,
} from "../packages/mcp-rks/src/shared/secret-scan-constants.mjs";

// Single source (backlog.feat.preflight-secret-scan-posture): the marker, hook path, override name
// and PATH lookup live in the shared module and are re-exported so existing importers are unchanged.
export { PRE_COMMIT_MARKER, HOOK_REL, OVERRIDE_ENV, findGitleaksOnPath };
export const PIN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "gitleaks-pin.json");

const GIT_TIMEOUT_MS = 30_000;
const TAR_TIMEOUT_MS = 60_000;

export function loadPin(pinPath = PIN_PATH) {
  return JSON.parse(fs.readFileSync(pinPath, "utf-8"));
}

export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  }).trim();
}

function readGitConfig(cwd, key) {
  try {
    return git(cwd, ["config", "--get", key]);
  } catch {
    return "";
  }
}

export function toolsDir(projectRoot) {
  return rksToolsDirFromCommonDir(path.resolve(projectRoot, git(projectRoot, ["rev-parse", "--git-common-dir"])));
}

export function preCommitShim() {
  return [
    "#!/bin/sh",
    PRE_COMMIT_MARKER,
    'ROOT="$(git rev-parse --show-toplevel)" || exit 1',
    `exec sh "$ROOT/${HOOK_REL}" "$@"`,
    "",
  ].join("\n");
}

export function installPreCommitShim(projectRoot) {
  const hooksPathCfg = readGitConfig(projectRoot, "core.hooksPath");
  if (hooksPathCfg) {
    if (hooksPathCfg.replace(/\/+$/, "") === ".routekit/git-hooks") return { armed: true, via: "core_hooks_path_rks" };
    return { armed: false, reason: "core_hooks_path", hooksPath: hooksPathCfg };
  }
  const hooksDir = path.resolve(projectRoot, git(projectRoot, ["rev-parse", "--git-path", "hooks"]));
  const hookFile = path.join(hooksDir, "pre-commit");
  if (fs.existsSync(hookFile) && !fs.readFileSync(hookFile, "utf-8").includes(PRE_COMMIT_MARKER)) {
    return { armed: false, reason: "foreign_pre_commit", hookFile };
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(hookFile, preCommitShim(), { mode: 0o755 });
  fs.chmodSync(hookFile, 0o755);
  if (!fs.readFileSync(hookFile, "utf-8").includes(PRE_COMMIT_MARKER)) {
    return { armed: false, reason: "verify_failed", hookFile };
  }
  return { armed: true, via: "shim", hookFile };
}

export async function provisionGitleaks(
  projectRoot,
  { pin = loadPin(), fetchImpl = globalThis.fetch, cacheDirs = [], platform = process.platform, arch = process.arch } = {},
) {
  const key = platformKey(platform, arch);
  const entry = pin.assets[key];
  if (!entry) return { installed: false, reason: "unsupported_platform", platform: key };
  const tools = toolsDir(projectRoot);
  const binName = platform === "win32" ? "gitleaks.exe" : "gitleaks";
  const binDir = path.join(tools, "gitleaks");
  const cacheDir = path.join(tools, "cache");
  const archive = path.join(cacheDir, entry.file);
  fs.mkdirSync(cacheDir, { recursive: true });
  const verified = (f) => fs.existsSync(f) && sha256File(f) === entry.sha256;
  if (!verified(archive)) {
    const cached = cacheDirs.map((d) => path.join(d, entry.file)).find(verified);
    if (cached) fs.copyFileSync(cached, archive);
  }
  if (!verified(archive)) {
    const part = `${archive}.part`;
    try {
      const res = await fetchImpl(`${pin.baseUrl}${entry.file}`, { redirect: "follow" });
      if (!res.ok) return { installed: false, reason: "download_failed", status: res.status };
      fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      fs.rmSync(part, { force: true });
      return { installed: false, reason: "download_failed", error: e.message };
    }
    if (sha256File(part) !== entry.sha256) {
      fs.rmSync(part, { force: true });
      fs.rmSync(archive, { force: true });
      return { installed: false, reason: "checksum_mismatch", file: entry.file };
    }
    fs.renameSync(part, archive);
  }
  fs.mkdirSync(binDir, { recursive: true });
  try {
    execFileSync("tar", ["-xf", archive, "-C", binDir, binName], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TAR_TIMEOUT_MS,
    });
  } catch (e) {
    return { installed: false, reason: "tar_unavailable_or_failed", error: e.message };
  }
  const bin = path.join(binDir, binName);
  if (!fs.existsSync(bin)) return { installed: false, reason: "verify_failed", bin };
  if (platform !== "win32") fs.chmodSync(bin, 0o755);
  return { installed: true, version: pin.version, bin, archiveSha256: entry.sha256 };
}

// D16: findGitleaksOnPath moved unchanged to packages/mcp-rks/src/shared/secret-scan-constants.mjs
// and is re-exported above.

export async function armSecretScan(projectRoot, opts = {}) {
  try {
    git(projectRoot, ["rev-parse", "--git-dir"]);
  } catch {
    return { armed: false, reason: "not_a_git_repo" };
  }
  if (!fs.existsSync(path.join(projectRoot, HOOK_REL))) return { armed: false, reason: "hook_missing" };
  const scanner = await provisionGitleaks(projectRoot, opts);
  const hook = installPreCommitShim(projectRoot);
  // armed is sourced from two observations: the hook in place AND a scanner on disk.
  const pathScanner = scanner.installed ? null : findGitleaksOnPath(opts.env, opts.platform);
  const scannerSource = scanner.installed ? "rks_tools" : pathScanner ? "path" : null;
  if (!hook.armed) return { armed: false, reason: hook.reason, hook, scanner };
  if (!scannerSource) return { armed: false, reason: scanner.reason || "scanner_missing", hook, scanner };
  return { armed: true, scannerSource, scannerPath: scanner.installed ? scanner.bin : pathScanner, hook, scanner };
}

async function main(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const projectRoot = path.resolve(valueOf("--project") || process.cwd());
  const cacheDir = valueOf("--cache-dir");
  let result;
  try {
    result = await armSecretScan(projectRoot, { cacheDirs: cacheDir ? [cacheDir] : [] });
  } catch (e) {
    // D6: an unexpected error is a not-armed outcome, never a failed `npm install`.
    result = { armed: false, reason: "installer_error", error: e?.message || String(e) };
  }
  const ok = Boolean(result.armed);
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!ok) {
    console.error(`[install-git-hooks] secret scan NOT fully armed: ${JSON.stringify(result)}`);
    console.error(`[install-git-hooks] without gitleaks, commits are REFUSED. To skip a scan: ${OVERRIDE_ENV}=1 git commit ...`);
  } else if (!args.includes("--json")) {
    console.log(`[install-git-hooks] gitleaks pre-commit secret scan armed (scanner: ${result.scannerSource} ${result.scannerPath}).`);
  }
  process.exitCode = args.includes("--strict") && !ok ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv);
}
