/**
 * backlog.fix.rag-embed-on-commit-uses-acquire-embed-lock — the post-commit hook takes
 * .rks/rag/.embed-lock through acquireEmbedLock (packages/rag/src/embed-lock.mjs) in its
 * detached child and releases it only by nonce; the hook parent never writes or unlinks it.
 *
 * The hook is run in place (canonical copy) against a throwaway git repo whose
 * packages/rag/src holds a COPY of the real embed-lock.mjs and a STUB embed.mjs. The stub
 * records the lock it observes while it runs, plus its own pid (the detached child's pid),
 * so the test can wait for the child to exit before asserting on the lock.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-embed-on-commit-lock.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CANONICAL = path.join(REPO_ROOT, "packages", "hooks", "system", "rag-embed-on-commit.mjs");
const TEMPLATE = path.join(REPO_ROOT, "templates", "generic", ".routekit", "hooks", "system", "rag-embed-on-commit.mjs");
const EMBED_LOCK_SRC = path.join(REPO_ROOT, "packages", "rag", "src", "embed-lock.mjs");

// Stub embed(): mode is read from .rks/rag/stub-mode (ok | fail | throw | foreign).
const STUB_EMBED = `
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rag = path.join(root, ".rks", "rag");
export async function embed() {
  const lock = path.join(rag, ".embed-lock");
  const modeFile = path.join(rag, "stub-mode");
  const mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, "utf8").trim() : "ok";
  const raw = fs.existsSync(lock) ? fs.readFileSync(lock, "utf8") : null;
  fs.writeFileSync(path.join(rag, "observed-lock.json"), JSON.stringify({ raw, pid: process.pid }));
  if (mode === "foreign") {
    fs.writeFileSync(lock, fs.readFileSync(path.join(rag, "foreign-lock.json"), "utf8"));
    return { ok: true, embeddedNotes: 0, addedEmbeddings: 0 };
  }
  if (mode === "throw") throw new Error("stub embed threw");
  if (mode === "fail") return { ok: false, error: "stub failure" };
  return { ok: true, embeddedNotes: 0, addedEmbeddings: 0 };
}
`;

let root;
const ragDir = () => path.join(root, ".rks", "rag");
const lockPath = () => path.join(ragDir(), ".embed-lock");
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
    timeout: 15_000,
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

function runHook() {
  return spawnSync(process.execPath, [CANONICAL], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "x"' },
      tool_response: { stdout: "[main 1234567] x\n 1 file changed", stderr: "", interrupted: false, isImage: false },
    }),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ROUTEKIT_PROJECT_ROOT: root, CLAUDE_PROJECT_DIR: root },
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

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rag-embed-on-commit-lock-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("rag-embed-on-commit: embed lock via acquireEmbedLock", () => {
  it("successful commit: the lock held while the hook's embed runs carries a nonce and holder rag-embed-on-commit, and is removed after the embed", async () => {
    setupProject();
    commitChange("change one");
    expect(runHook().status).toBe(0);
    const observed = await waitForEmbedChild();
    expect(observed.raw).not.toBeNull();
    const held = JSON.parse(observed.raw);
    expect(typeof held.nonce).toBe("string");
    expect(held.nonce.length).toBeGreaterThan(0);
    expect(held.holder).toBe("rag-embed-on-commit");
    expect(held.pid).toBe(observed.pid);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("live in-process holder: the hook leaves the lock byte-identical and runs no embed", async () => {
    setupProject();
    commitChange("change two");
    const liveLock = JSON.stringify({ started: Date.now(), pid: process.pid, holder: "in-process", nonce: "live-holder-nonce" });
    writeFile(lockPath(), liveLock);
    expect(runHook().status).toBe(0);
    expect(spawnedPid()).not.toBeNull();
    await waitForAnySpawnedChild();
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(liveLock);
    expect(fs.existsSync(observedPath())).toBe(false);
  });

  it("foreign lock at release: the child does not delete a lock carrying another nonce", async () => {
    setupProject();
    commitChange("change three");
    const foreign = JSON.stringify({ started: Date.now(), pid: process.pid, holder: "in-process", nonce: "foreign-nonce" });
    writeFile(path.join(ragDir(), "foreign-lock.json"), foreign);
    writeFile(path.join(ragDir(), "stub-mode"), "foreign");
    expect(runHook().status).toBe(0);
    await waitForEmbedChild();
    expect(fs.existsSync(lockPath())).toBe(true);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(foreign);
  });

  it("embed returns ok: false: the child removes its own lock", async () => {
    setupProject();
    commitChange("change four");
    writeFile(path.join(ragDir(), "stub-mode"), "fail");
    expect(runHook().status).toBe(0);
    const observed = await waitForEmbedChild();
    expect(typeof JSON.parse(observed.raw).nonce).toBe("string");
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("embed throws: the child removes its own lock", async () => {
    setupProject();
    commitChange("change five");
    writeFile(path.join(ragDir(), "stub-mode"), "throw");
    expect(runHook().status).toBe(0);
    const observed = await waitForEmbedChild();
    expect(typeof JSON.parse(observed.raw).nonce).toBe("string");
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("[skip-rag] commit creates no lock and runs no embed", async () => {
    setupProject();
    commitChange("docs: tidy [skip-rag]");
    expect(runHook().status).toBe(0);
    await waitForAnySpawnedChild();
    expect(spawnedPid()).toBeNull();
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(fs.existsSync(observedPath())).toBe(false);
  });

  it("commit with no changed files creates no lock and runs no embed", async () => {
    setupProject();
    commitChange("empty", { empty: true });
    expect(runHook().status).toBe(0);
    await waitForAnySpawnedChild();
    expect(spawnedPid()).toBeNull();
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(fs.existsSync(observedPath())).toBe(false);
  });

  it("project without packages/rag: hook exits 0 and leaves no lock", async () => {
    setupProject({ withRag: false });
    commitChange("change six");
    expect(runHook().status).toBe(0);
    await waitForAnySpawnedChild();
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("hook source has no non-exclusive lock write, no LOCK_FILE unlink, and no private lock helpers", () => {
    const src = fs.readFileSync(CANONICAL, "utf8");
    expect(src).toMatch(/acquireEmbedLock/);
    expect(src).not.toMatch(/writeFileSync\(\s*LOCK_FILE/);
    expect(src).not.toMatch(/unlinkSync\(\s*['"`]?\$?\{?LOCK_FILE/);
    expect(src).not.toMatch(/function\s+(createLock|isLocked|isProcessAlive)\b/);
  });

  it("live holder: the parent spawns the child without pre-checking the lock, and post-commit.log contains the child's lock-held refusal line", async () => {
    setupProject();
    commitChange("change seven");
    const liveLock = JSON.stringify({ started: Date.now(), pid: process.pid, holder: "in-process", nonce: "live-holder-nonce-log" });
    writeFile(lockPath(), liveLock);
    expect(runHook().status).toBe(0);
    expect(spawnedPid()).not.toBeNull();
    await waitForAnySpawnedChild();
    expect(fs.readFileSync(logPath(), "utf8")).toContain("[rag-embed] Skipped: embed lock held");
  });

  it("successful embed: post-commit.log contains the child's completion line after the child exits", async () => {
    setupProject();
    commitChange("change eight");
    expect(runHook().status).toBe(0);
    await waitForEmbedChild();
    expect(fs.readFileSync(logPath(), "utf8")).toContain("[rag-embed] Completed successfully");
  });

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

  it("template copy is byte-identical to canonical", () => {
    expect(fs.readFileSync(TEMPLATE, "utf8")).toBe(fs.readFileSync(CANONICAL, "utf8"));
  });
});
