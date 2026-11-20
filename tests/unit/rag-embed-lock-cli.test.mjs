/**
 * backlog.fix.rag-embed-lock-never-acquired-in-process — the embed.mjs CLI main guard takes the
 * embed lock; the exported embed() (the post-commit hook's entry point, which runs under the
 * hook's own lock) does not.
 *
 * backlog.feat.rag-embed-lock-kernel-held — the lock is the kernel-held node:sqlite lock on
 * .rks/rag/embed-lock.sqlite. The test process holds it in-process (real node:sqlite) while the
 * spawned CLI contends from another process.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-embed-lock-cli.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireEmbedLock, embedLockPath, EMBED_LOCK_HELD_EXIT_CODE } from "../../packages/rag/src/embed-lock.mjs";

const EMBED_CLI = fileURLToPath(new URL("../../packages/rag/src/embed.mjs", import.meta.url));
const ENV_KEYS = [
  "RKS_CODE_GLOB",
  "ROUTEKIT_CODE_GLOB",
  "RKS_RAG_CODE_GLOB",
  "RKS_RAG_SCOPE_MODE",
  "ROUTEKIT_RAG_SCOPE_MODE",
  "RKS_RAG_RESET",
  "ROUTEKIT_RAG_RESET",
];
const STUB_KEYS = ["RKS_RAG_EMBEDDINGS_MODE", "ROUTEKIT_RAG_EMBEDDINGS_MODE"];
const NOTE = (title, body) => `---\nid: ${title.toLowerCase()}\ntitle: ${title}\n---\n\n${body}\n`;

let projectRoot;
let dbPath;
let saved;
const lockPath = () => embedLockPath(projectRoot);
/** Spawn-family timeout floor (tests/unit/subprocess-timeout-convention.test.mjs). */
const CLI_TIMEOUT_MS = 120_000;
/** Per-test timeout: exceeds the largest spawn timeout in each test. */
const TEST_TIMEOUT_MS = 300_000;
let open = [];
function take(holder) {
  const lock = acquireEmbedLock(projectRoot, { holder });
  if (lock.acquired) open.push(lock);
  return lock;
}
const manifestPath = () => path.join(projectRoot, ".rks", "rag", "embed-manifest.json");
const writeFile = (p, s) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
};

beforeEach(() => {
  saved = Object.fromEntries([...ENV_KEYS, ...STUB_KEYS].map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  for (const k of STUB_KEYS) process.env[k] = "stub";
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-embed-lock-cli-"));
  writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "rag-embed-lock-cli", private: true }));
  writeFile(path.join(projectRoot, "notes", "alpha.md"), NOTE("Alpha", "alpha body text"));
  dbPath = path.join(projectRoot, ".rks", "rag", "lance", "notes.lance");
  open = [];
});

afterEach(() => {
  for (const lock of open) {
    try { lock.release(); } catch { /* best-effort */ }
  }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

const embedInProcess = async () => {
  const { embed } = await import("../../packages/rag/src/embed.mjs");
  return embed({ projectRoot, vault: path.join(projectRoot, "notes"), glob: "**/*", db: dbPath });
};

// The main guard compares import.meta.url with file://${process.argv[1]}, so the script is
// spawned by absolute path; the child finds the temp project through ROUTEKIT_PROJECT_ROOT.
const runCli = () => {
  const env = { ...process.env, ROUTEKIT_PROJECT_ROOT: projectRoot };
  for (const k of ENV_KEYS) delete env[k];
  for (const k of STUB_KEYS) env[k] = "stub";
  const r = spawnSync(process.execPath, [EMBED_CLI, "--files=notes/alpha.md"], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
  });
  expect(r.error, `CLI spawn failed or timed out: ${r.error}`).toBeUndefined();
  return r;
};

describe("embed.mjs CLI takes the embed lock", () => {
  it("exits 75 while another process holds the kernel lock, names the holder pid, and changes nothing", async () => {
    expect((await embedInProcess()).ok).toBe(true); // positive control: index and manifest exist
    const manifestBefore = fs.readFileSync(manifestPath());
    // A run that proceeded would re-hash this edit, so unchanged manifest bytes are not vacuous.
    writeFile(path.join(projectRoot, "notes", "alpha.md"), NOTE("Alpha", "alpha body text, edited"));
    const lock = take("test-other-process");
    expect(lock.acquired).toBe(true);
    const inoBefore = fs.statSync(lockPath()).ino;
    const r = runCli();
    expect(r.status).not.toBeNull();
    expect(r.status).toBe(EMBED_LOCK_HELD_EXIT_CODE); // 75, distinct from the embed-failure exit 1
    expect(r.status).toBe(75);
    expect(r.stderr).toContain(`[rag.embed] refused: embed lock held (PID: ${process.pid}`);
    expect(fs.readFileSync(manifestPath()).equals(manifestBefore)).toBe(true);
    expect(fs.statSync(lockPath()).ino).toBe(inoBefore);
  }, TEST_TIMEOUT_MS);

  it("exits 75 over a non-database lock file with errcode, errstr and the lock path in stderr, leaving the file", () => {
    const bytes = Buffer.alloc(4096, "not a sqlite database\n");
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), bytes);
    const probe = acquireEmbedLock(projectRoot, { holder: "detail-probe" });
    expect(probe.acquired).toBe(false);
    expect(typeof probe.errcode).toBe("number");
    expect(typeof probe.errstr).toBe("string");
    const r = runCli();
    expect(r.status).toBe(EMBED_LOCK_HELD_EXIT_CODE);
    expect(r.stderr).toContain("[rag.embed] refused: embed lock held (PID: ");
    expect(r.stderr).toContain("ERR_SQLITE_ERROR");
    expect(r.stderr).toContain(String(probe.errcode));
    expect(r.stderr).toContain(probe.errstr);
    expect([lockPath(), fs.realpathSync(lockPath())].some((p) => r.stderr.includes(p))).toBe(true);
    expect(fs.readFileSync(lockPath()).equals(bytes)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("exits 75 over a directory at the kernel lock path with EISDIR in stderr", () => {
    fs.mkdirSync(lockPath(), { recursive: true });
    const r = runCli();
    expect(r.status).toBe(EMBED_LOCK_HELD_EXIT_CODE);
    expect(r.stderr).toContain("refused: embed lock held");
    expect(r.stderr).toContain("EISDIR");
    expect(fs.statSync(lockPath()).isDirectory()).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("exits 0 when the lock is free, rewrites the manifest, and leaves the lock free", async () => {
    expect((await embedInProcess()).ok).toBe(true);
    const manifestBefore = fs.readFileSync(manifestPath());
    writeFile(path.join(projectRoot, "notes", "alpha.md"), NOTE("Alpha", "alpha body text, CLI edit"));
    const r = runCli();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(manifestPath()).equals(manifestBefore)).toBe(false);
    const after = take("after-cli");
    expect(after.acquired).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("a kernel-held refusal line carries no legacy-record hint", () => {
    const lock = take("kernel-only");
    expect(lock.acquired).toBe(true);
    const r = runCli();
    expect(r.status).toBe(EMBED_LOCK_HELD_EXIT_CODE);
    const line = r.stderr.split("\n").find((l) => l.includes("[rag.embed] refused:"));
    expect(line).toBeDefined();
    expect(line).not.toContain("legacy lock record");
  }, TEST_TIMEOUT_MS);
});

describe("embed() hook entry point", () => {
  it("does not consult or acquire the lock: runs while the kernel lock is held and leaves it held", async () => {
    const lock = take("rag-embed-on-commit");
    expect(lock.acquired).toBe(true);
    const res = await embedInProcess();
    expect(res.ok).toBe(true);
    expect(res.locked).not.toBe(true);
    expect(fs.existsSync(manifestPath())).toBe(true); // it did real work
    const second = acquireEmbedLock(projectRoot, { holder: "second" });
    expect(second.acquired).toBe(false);
  }, TEST_TIMEOUT_MS);
});
