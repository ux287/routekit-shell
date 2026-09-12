import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDirNonEmpty(dir) {
  try {
    const entries = fs.readdirSync(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

function runGit(shellRoot, args) {
  try {
    const res = spawnSync("git", args, { cwd: shellRoot, encoding: "utf8" });
    if (res.status !== 0) return null;
    return String(res.stdout || "").trim() || null;
  } catch {
    return null;
  }
}

function readVersionFromToolchain(toolchainDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(toolchainDir, "package.json"), "utf8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}

function buildPinFromShellRoot(shellRoot) {
  const sha = runGit(shellRoot, ["rev-parse", "HEAD"]);
  const remote = runGit(shellRoot, ["config", "--get", "remote.origin.url"]);
  return {
    vendoredAt: new Date().toISOString(),
    source: remote || null,
    gitSha: sha || null,
    version: readVersionFromToolchain(shellRoot),
  };
}

async function writePin(destDir, pin) {
  const pinPath = path.join(destDir, "ROUTEKIT_PIN.json");
  await fsp.writeFile(pinPath, JSON.stringify(pin, null, 2) + "\n", "utf8");
  return pinPath;
}

function shouldCopyRelative(relPosix) {
  const rel = relPosix.replace(/\\/g, "/");
  if (!rel || rel === ".") return true;
  const ignoredTop = new Set([
    ".git",
    "node_modules",
    ".rks",
    "runs",
    "dist",
    "coverage",
    ".pytest_cache",
    ".ruff_cache",
    ".DS_Store",
    ".vscode",
  ]);
  const first = rel.split("/")[0];
  if (ignoredTop.has(first)) return false;
  if (rel.includes("/node_modules/")) return false;
  if (rel.includes("/.git/")) return false;
  if (rel.includes("/.rks/")) return false;
  if (rel.includes("/dist/")) return false;
  if (rel.includes("/coverage/")) return false;
  if (rel.endsWith(".log")) return false;
  return true;
}

export async function vendorViaCopy({
  shellRoot,
  projectRoot,
  destRel = path.join("tools", "routekit-shell"),
  yes = false,
} = {}) {
  if (!shellRoot) throw new Error("shellRoot is required");
  if (!projectRoot) throw new Error("projectRoot is required");
  const resolvedShell = path.resolve(shellRoot);
  const resolvedProject = path.resolve(projectRoot);
  const dest = path.join(resolvedProject, destRel);

  if (!isDir(resolvedShell)) throw new Error(`shellRoot not found: ${resolvedShell}`);
  if (!isDir(resolvedProject)) throw new Error(`projectRoot not found: ${resolvedProject}`);

  if (pathExists(dest) && listDirNonEmpty(dest)) {
    if (!yes) {
      throw new Error(`Vendored toolchain already exists at ${destRel}. Re-run with --yes to replace.`);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${dest}.bak.${stamp}`;
    await fsp.rename(dest, backup);
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.cp(resolvedShell, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(resolvedShell, src);
      const relPosix = rel.split(path.sep).join("/");
      return shouldCopyRelative(relPosix);
    },
  });

  const ref = runGit(resolvedShell, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";
const pin = { ...buildPinFromShellRoot(resolvedShell), mode: "copy", ref };
  const pinPath = await writePin(dest, pin);

  return { ok: true, dest, destRel, pinPath, pin };
}

function runGitInRepo(repoRoot, args) {
  const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: String(res.stdout || ""),
    stderr: String(res.stderr || ""),
  };
}

function isGitWorkTree(repoRoot) {
  const res = runGitInRepo(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  return res.ok && res.stdout.trim() === "true";
}

function hasGitHead(repoRoot) {
  const res = runGitInRepo(repoRoot, ["rev-parse", "HEAD"]);
  return res.ok;
}

function ensureRemote({ repoRoot, remoteName, remoteUrl }) {
  const existing = runGitInRepo(repoRoot, ["remote", "get-url", remoteName]);
  if (!existing.ok) {
    const add = runGitInRepo(repoRoot, ["remote", "add", remoteName, remoteUrl]);
    if (!add.ok) throw new Error(`Failed to add git remote '${remoteName}': ${add.stderr || add.stdout}`);
    return;
  }
  const currentUrl = existing.stdout.trim();
  if (currentUrl && currentUrl !== remoteUrl) {
    const setUrl = runGitInRepo(repoRoot, ["remote", "set-url", remoteName, remoteUrl]);
    if (!setUrl.ok) throw new Error(`Failed to set git remote '${remoteName}' url: ${setUrl.stderr || setUrl.stdout}`);
  }
}

function resolveRemoteUrl({ shellRoot, remoteUrl }) {
  if (remoteUrl && String(remoteUrl).trim()) return String(remoteUrl).trim();
  const fromOrigin = runGit(shellRoot, ["config", "--get", "remote.origin.url"]);
  if (fromOrigin) return fromOrigin;
  return null;
}

function resolveRemoteRefSha(remoteUrl, ref) {
  const res = spawnSync("git", ["ls-remote", remoteUrl, ref], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const line = String(res.stdout || "").trim().split("\n")[0] || "";
  const sha = line.split(/\s+/)[0];
  return sha && sha.length >= 7 ? sha : null;
}

export async function vendorViaSubtree({
  shellRoot,
  projectRoot,
  destRel = path.join("tools", "routekit-shell"),
  remoteName = "routekit-shell",
  remoteUrl = null,
  ref = "main",
  gitInit = false,
} = {}) {
  if (!shellRoot) throw new Error("shellRoot is required");
  if (!projectRoot) throw new Error("projectRoot is required");
  const resolvedShell = path.resolve(shellRoot);
  const resolvedProject = path.resolve(projectRoot);

  if (!isDir(resolvedShell)) throw new Error(`shellRoot not found: ${resolvedShell}`);
  if (!isDir(resolvedProject)) throw new Error(`projectRoot not found: ${resolvedProject}`);

  let isRepo = isGitWorkTree(resolvedProject);
  if (!isRepo) {
    if (!gitInit) {
      throw new Error("Project is not a git repository. Re-run with --git-init or initialize git manually.");
    }
    const initRes = runGitInRepo(resolvedProject, ["init"]);
    if (!initRes.ok) throw new Error(`git init failed: ${initRes.stderr || initRes.stdout}`);
    isRepo = isGitWorkTree(resolvedProject);
  }
  if (!isRepo) throw new Error("Unable to initialize git work tree for subtree vendoring.");

  if (!hasGitHead(resolvedProject)) {
    throw new Error("git subtree requires the target repo to have at least one commit (HEAD). Create an initial commit and retry.");
  }

  const effectiveRemoteUrl = resolveRemoteUrl({ shellRoot: resolvedShell, remoteUrl });
  if (!effectiveRemoteUrl) {
    throw new Error("Unable to determine --vendor-remote (no explicit value and shellRoot has no remote.origin.url).");
  }

  ensureRemote({ repoRoot: resolvedProject, remoteName, remoteUrl: effectiveRemoteUrl });

  const dest = path.join(resolvedProject, destRel);
  const hasPrefix = pathExists(dest) && isDir(dest) && listDirNonEmpty(dest);
  const subtreeArgs = hasPrefix
    ? ["subtree", "pull", "--prefix", destRel, remoteName, ref, "--squash"]
    : ["subtree", "add", "--prefix", destRel, remoteName, ref, "--squash"];

  const subtreeRes = runGitInRepo(resolvedProject, subtreeArgs);
  if (!subtreeRes.ok) {
    throw new Error(`git ${subtreeArgs.join(" ")} failed: ${subtreeRes.stderr || subtreeRes.stdout}`);
  }

  const toolchainVersion = readVersionFromToolchain(dest);
  const sha = resolveRemoteRefSha(effectiveRemoteUrl, ref);
  const pin = {
    vendoredAt: new Date().toISOString(),
    source: effectiveRemoteUrl,
    gitSha: sha,
    version: toolchainVersion,
    mode: "subtree",
    ref,
    remoteName,
  };
  const pinPath = await writePin(dest, pin);
  return { ok: true, dest, destRel, pinPath, pin, ref, remoteName, remoteUrl: effectiveRemoteUrl };
}

// Backwards-compatible alias (copy-based vendoring).
export async function vendorRoutekitShell(opts = {}) {
  return await vendorViaCopy(opts);
}
