/**
 * backlog.fix.rag-embed-on-commit-uses-acquire-embed-lock — the post-commit hook takes the
 * embed lock through acquireEmbedLock (packages/rag/src/embed-lock.mjs) in its detached child;
 * the hook parent never writes, inspects or deletes it.
 *
 * backlog.feat.rag-embed-lock-kernel-held — the lock is the kernel-held node:sqlite lock on
 * .rks/rag/embed-lock.sqlite, released by COMMIT + close (or process exit), so the old
 * foreign-nonce release test is gone.
 *
 * The hook is run in place (canonical copy) against a throwaway git repo whose
 * packages/rag/src holds a COPY of the real embed-lock.mjs (alone: it imports no sibling) and a
 * STUB embed.mjs. The stub records what inspectEmbedLock from its sibling embed-lock.mjs copy
 * reports while it runs, plus its own pid (the detached child's pid), so the test can wait for
 * the child to exit before asserting on the lock. A live holder is a real in-process acquire by
 * the test on the throwaway root; lock-free state is a fresh acquire.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-embed-on-commit-lock.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CANONICAL = path.join(REPO_ROOT, "packages", "hooks", "system", "rag-embed-on-commit.mjs");
const TEMPLATE = path.join(REPO_ROOT, "templates", "generic", ".routekit", "hooks", "system", "rag-embed-on-commit.mjs");
const EMBED_LOCK_SRC = path.join(REPO_ROOT, "packages", "rag", "src", "embed-lock.mjs");

/** Spawn-family timeout floor (tests/unit/subprocess-timeout-convention.test.mjs). */
const SPAWN_TIMEOUT_MS = 120_000;
/** Per-test timeout: exceeds the largest spawn timeout in each test. */
const TEST_TIMEOUT_MS = 300_000;

// Stub embed(): mode is read from .rks/rag/stub-mode (ok | fail | throw).
const STUB_EMBED = `
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectEmbedLock } from "./embed-lock.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rag = path.join(root, ".rks", "rag");
export async function embed() {
  const modeFile = path.join(rag, "stub-mode");
  const mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, "utf8").trim() : "ok";
  const lock = inspectEmbedLock(root);
  fs.writeFileSync(path.join(rag, "observed-lock.json"), JSON.stringify({ lock, pid: process.pid }));
  if (mode === "throw") throw new Error("stub embed threw");
  if (mode === "fail") return { ok: false, error: "stub failure" };
  return { ok: true, embeddedNotes: 0, addedEmbeddings: 0 };
}
`;

let root;
const ragDir = () => path.join(root, ".rks", "rag");
const lockPath = () => path.join(ragDir(), "embed-lock.sqlite");
const logPath = () => path.join(ragDir(), "post-commit.log");
const observedPath = () => path.join(ragDir(), "observed-lock.json");

function writeFile(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
}

function git(args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function setupProject({ withRag = true } = {}) {
  git(["init", "-q"]);
  writeFile(path.join(root, "README.md"), "fixture\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "initial"]);
  if (withRag) {
    writeFile(path.join(root, "packages", "rag", "src", "embed-lock.mjs"), fs.readFileSync(EMBED_LOCK_SRC, "utf8"));
    writeFile(path.join(root, "packages", "rag", "src", "embed.mjs"), STUB_EMBED);
  }
}

function commitChange(message, { empty = false } = {}) {
  if (empty) {
    git(["commit", "-q", "--allow-empty", "-m", message]);
    return;
  }
  writeFile(path.join(root, "note.md"), `${message} ${Date.now()}\n`);
  git(["add", "note.md"]);
  git(["commit", "-q", "-m", message]);
}

function runHook(env = { ...process.env }) {
  return spawnSync(process.execPath, [CANONICAL], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "x"' },
      tool_response: { stdout: "[main 1234567] x\n 1 file changed", stderr: "", interrupted: false, isImage: false },
    }),
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...env, ROUTEKIT_PROJECT_ROOT: root, CLAUDE_PROJECT_DIR: root },
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

async function waitFor(pred, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

/** pid the hook parent logged for its spawned child, or null when it spawned none. */
function spawnedPid() {
  if (!fs.existsSync(logPath())) return null;
  const all = [...fs.readFileSync(logPath(), "utf8").matchAll(/spawned in background \(PID: (\d+)\)/g)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

/** Wait for the stub embed to run, then for the detached child that ran it to exit. */
async function waitForEmbedChild() {
  expect(await waitFor(() => fs.existsSync(observedPath()))).toBe(true);
  const observed = JSON.parse(fs.readFileSync(observedPath(), "utf8"));
  expect(await waitFor(() => !isAlive(observed.pid))).toBe(true);
  return observed;
}

/** When the parent spawned a child, wait for it to exit (it may refuse without embedding). */
async function waitForAnySpawnedChild() {
  const pid = spawnedPid();
  if (pid !== null) expect(await waitFor(() => !isAlive(pid))).toBe(true);
}

/** The throwaway repo's copy of embed-lock.mjs, loaded by the test (the hook's child loads the same file). */
async function rootLockModule() {
  return import(pathToFileURL(path.join(root, "packages", "rag", "src", "embed-lock.mjs")).href);
}

/** True when a fresh acquire on the throwaway root succeeds; the probe lock is released at once. */
async function lockIsFree() {
  const { acquireEmbedLock } = await rootLockModule();
  const probe = acquireEmbedLock(root, { holder: "free-probe" });
  if (probe.acquired) probe.release();
  return probe.acquired === true;
}

let open = [];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rag-embed-on-commit-lock-")));
  open = [];
});

afterEach(() => {
  for (const lock of open) {
    try { lock.release(); } catch { /* best-effort */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("rag-embed-on-commit: embed lock via acquireEmbedLock", () => {
  it("successful commit: the hook's embed runs under the kernel lock held by rag-embed-on-commit and the lock is free afterwards", async () => {
    setupProject();
    commitChange("change one");
    expect(runHook().status).toBe(0);
    const observed = await waitForEmbedChild();
    expect(observed.lock.locked).toBe(true);
    expect(observed.lock.holder).toBe("rag-embed-on-commit");
    expect(observed.lock.pid).toBe(observed.pid);
    expect(await lockIsFree()).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("live in-process kernel holder: the hook's child is refused, runs no embed, and logs the lock-held skip", async () => {
    setupProject();
    commitChange("change two");
    const { acquireEmbedLock } = await rootLockModule();
    const lock = acquireEmbedLock(root, { holder: "in-process" });
    expect(lock.acquired).toBe(true);
    open.push(lock);
    expect(runHook().status).toBe(0);
    expect(spawnedPid()).not.toBeNull(); // the parent spawned the child without pre-checking the lock
    await waitForAnySpawnedChild();
    expect(fs.existsSync(observedPath())).toBe(false);
    expect(fs.readFileSync(logPath(), "utf8")).toContain("[rag-embed] Skipped: embed lock held");
  }, TEST_TIMEOUT_MS);

  it("embed returns ok false or throws: the lock is free after the child exits", async () => {
    setupProject();
    for (const mode of ["fail", "throw"]) {
      commitChange(`change ${mode}`);
      writeFile(path.join(ragDir(), "stub-mode"), mode);
      fs.rmSync(observedPath(), { force: true });
      expect(runHook().status).toBe(0);
      const observed = await waitForEmbedChild();
      expect(observed.lock.locked).toBe(true); // positive control: the stub ran under the lock
      expect(await lockIsFree()).toBe(true);
    }
  }, TEST_TIMEOUT_MS);

  it("with the node:sqlite ExperimentalWarning on the child's stderr the hook still takes and releases the lock", async () => {
    // The vitest base config sets NODE_NO_WARNINGS=1 for every tier, which children inherit and
    // which would hide the warning; both the probe and the hook run without it.
    const warningsOn = { ...process.env };
    delete warningsOn.NODE_NO_WARNINGS;
    const probe = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      env: warningsOn,
    });
    expect(probe.error).toBeUndefined();
    expect(probe.status).toBe(0);
    const probeWarned = String(probe.stderr).includes("ExperimentalWarning");
    setupProject();
    commitChange("change warning");
    expect(runHook(warningsOn).status).toBe(0);
    const observed = await waitForEmbedChild();
    expect(observed.lock.locked).toBe(true);
    const log = fs.readFileSync(logPath(), "utf8");
    expect(log).toContain("[rag-embed] Completed successfully");
    expect(await lockIsFree()).toBe(true);
    expect(log.includes("ExperimentalWarning")).toBe(probeWarned);
  }, TEST_TIMEOUT_MS);

  it("[skip-rag] commit creates no lock and runs no embed", async () => {
    setupProject();
    commitChange("docs: tidy [skip-rag]");
    expect(runHook().status).toBe(0);
    await waitForAnySpawnedChild();
    expect(spawnedPid()).toBeNull();
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(fs.existsSync(observedPath())).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("commit with no changed files creates no lock and runs no embed", async () => {
    setupProject();
    commitChange("empty", { empty: true });
    expect(runHook().status).toBe(0);
    await waitForAnySpawnedChild();
    expect(spawnedPid()).toBeNull();
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(fs.existsSync(observedPath())).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("project without packages/rag: hook exits 0 and leaves no lock", async () => {
    setupProject({ withRag: false });
    commitChange("change six");
    expect(runHook().status).toBe(0);
    await waitForAnySpawnedChild();
    expect(fs.existsSync(lockPath())).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("hook source has no non-exclusive lock write, no LOCK_FILE unlink, and no private lock helpers", () => {
    const src = fs.readFileSync(CANONICAL, "utf8");
    expect(src).toMatch(/acquireEmbedLock/);
    expect(src).not.toMatch(/writeFileSync\(\s*LOCK_FILE/);
    expect(src).not.toMatch(/unlinkSync\(\s*['"`]?\$?\{?LOCK_FILE/);
    expect(src).not.toMatch(/function\s+(createLock|isLocked|isProcessAlive)\b/);
  });

  it("successful embed: post-commit.log contains the child's completion line after the child exits", async () => {
    setupProject();
    commitChange("change eight");
    expect(runHook().status).toBe(0);
    await waitForEmbedChild();
    expect(fs.readFileSync(logPath(), "utf8")).toContain("[rag-embed] Completed successfully");
  }, TEST_TIMEOUT_MS);

  it("hook source hands the child a post-commit.log fd for stdout and stderr and does not pre-check the lock", () => {
    const src = fs.readFileSync(CANONICAL, "utf8");
    expect(src).toMatch(/openSync\(\s*LOG_FILE/);
    expect(src).not.toMatch(/child\.(stdout|stderr)\.on\(/);
    // The detached child's stdio is the only stdio array whose first slot is "ignore";
    // its stdout and stderr slots must be fd identifiers, not "ignore" or "pipe" strings.
    const childStdio = [...src.matchAll(/stdio:\s*\[\s*["']ignore["']\s*,\s*([^,\]]+?)\s*,\s*([^\]]+?)\s*\]/g)];
    expect(childStdio.length).toBe(1);
    for (const slot of [childStdio[0][1], childStdio[0][2]]) {
      expect(slot).toMatch(/^[A-Za-z_$][\w$]*$/);
    }
    expect(src).not.toMatch(/\bisLocked\s*\(/);
    expect(src).not.toMatch(/inspectEmbedLock/);
  });

  it("live-pid legacy record: the hook's child is refused and the Skipped line ends with the legacy-record removal hint", async () => {
    setupProject();
    commitChange("change legacy");
    const record = path.join(ragDir(), ".embed-lock");
    writeFile(record, JSON.stringify({ pid: process.pid, started: 1700000000000, holder: "pre-redesign" }));
    expect(runHook().status).toBe(0);
    expect(spawnedPid()).not.toBeNull();
    await waitForAnySpawnedChild();
    expect(fs.existsSync(observedPath())).toBe(false);
    const line = fs.readFileSync(logPath(), "utf8").split("\n").find((l) => l.includes("[rag-embed] Skipped: embed lock held"));
    expect(line).toBeDefined();
    expect(line.endsWith(` (legacy lock record: ${record}; remove it if no rks process is running)`)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("live in-process kernel holder: the Skipped line carries no legacy-record hint", async () => {
    setupProject();
    commitChange("change kernel");
    const { acquireEmbedLock } = await rootLockModule();
    const lock = acquireEmbedLock(root, { holder: "in-process" });
    expect(lock.acquired).toBe(true);
    open.push(lock);
    expect(runHook().status).toBe(0);
    await waitForAnySpawnedChild();
    const line = fs.readFileSync(logPath(), "utf8").split("\n").find((l) => l.includes("[rag-embed] Skipped: embed lock held"));
    expect(line).toBeDefined();
    expect(line).not.toContain("legacy lock record");
  }, TEST_TIMEOUT_MS);

  it("installed .routekit copy is byte-identical to canonical", () => {
    const installed = path.join(REPO_ROOT, ".routekit", "hooks", "system", "rag-embed-on-commit.mjs");
    expect(fs.readFileSync(installed, "utf8")).toBe(fs.readFileSync(CANONICAL, "utf8"));
  });

  it("template copy is byte-identical to canonical", () => {
    expect(fs.readFileSync(TEMPLATE, "utf8")).toBe(fs.readFileSync(CANONICAL, "utf8"));
  });
});
