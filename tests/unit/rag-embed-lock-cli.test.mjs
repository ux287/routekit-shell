/**
 * backlog.fix.rag-embed-lock-never-acquired-in-process — the embed.mjs CLI main guard takes the
 * embed lock; the exported embed() (the post-commit hook's entry point, which runs under the
 * hook's own lock) does not.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-embed-lock-cli.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
const lockPath = () => path.join(projectRoot, ".rks", "rag", ".embed-lock");
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
});

afterEach(() => {
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
    timeout: 45_000,
  });
  expect(r.error, `CLI spawn failed or timed out: ${r.error}`).toBeUndefined();
  return r;
};

describe("embed.mjs CLI takes the embed lock", () => {
  it("exits non-zero while another process holds a live lock, names the holder pid, and changes nothing", async () => {
    expect((await embedInProcess()).ok).toBe(true); // positive control: index and manifest exist
    const manifestBefore = fs.readFileSync(manifestPath());
    // A run that proceeded would re-hash this edit, so unchanged manifest bytes are not vacuous.
    writeFile(path.join(projectRoot, "notes", "alpha.md"), NOTE("Alpha", "alpha body text, edited"));
    writeFile(lockPath(), JSON.stringify({ pid: process.pid, started: Date.now(), holder: "test-other-process" }));
    const lockBefore = fs.readFileSync(lockPath());
    const r = runCli();
    expect(r.status).not.toBeNull();
    expect(r.status).toBe(75); // EMBED_LOCK_HELD_EXIT_CODE, distinct from the embed-failure exit 1
    expect(`${r.stdout}\n${r.stderr}`).toContain(String(process.pid));
    expect(fs.readFileSync(lockPath()).equals(lockBefore)).toBe(true);
    expect(fs.readFileSync(manifestPath()).equals(manifestBefore)).toBe(true);
  }, 90_000);

  it("exits 0 when the lock is free, rewrites the manifest, and leaves no lock behind", async () => {
    expect((await embedInProcess()).ok).toBe(true);
    const manifestBefore = fs.readFileSync(manifestPath());
    writeFile(path.join(projectRoot, "notes", "alpha.md"), NOTE("Alpha", "alpha body text, CLI edit"));
    expect(fs.existsSync(lockPath())).toBe(false);
    const r = runCli();
    expect(r.status).toBe(0);
    expect(fs.readFileSync(manifestPath()).equals(manifestBefore)).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(false);
  }, 90_000);
});

describe("embed() hook entry point", () => {
  it("does not consult or acquire the lock: runs under a live lock and leaves it byte-identical", async () => {
    writeFile(lockPath(), JSON.stringify({ pid: process.pid, started: Date.now(), holder: "rag-embed-on-commit" }));
    const lockBefore = fs.readFileSync(lockPath());
    const res = await embedInProcess();
    expect(res.ok).toBe(true);
    expect(res.locked).not.toBe(true);
    expect(fs.existsSync(manifestPath())).toBe(true); // it did real work
    expect(fs.readFileSync(lockPath()).equals(lockBefore)).toBe(true);
  }, 90_000);
});
