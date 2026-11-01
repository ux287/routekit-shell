/**
 * Witness for backlog.fix.rag-reset-bypasses-manifest-skip.
 *
 * RKS_RAG_RESET=1 and RKS_RAG_SCOPE_MODE=prune drop the embeddings table, but the per-file
 * manifest skip ran first and treated every unchanged file as already indexed. The table was then
 * dropped and rebuilt from the changed subset only (empty when nothing changed), while the manifest
 * kept every hash, so later plain runs skipped those files forever.
 *
 * STUB EMBEDDER: the embeddings mode is read into a module-scope const, so the env is set in
 * beforeEach BEFORE the dynamic import of @routekit/rag/embed.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connect } from "@lancedb/lancedb";
import { makeTempDir, writeFile } from "../helpers/tmp.mjs";

const NOTE = (title, body) => `---\ntitle: ${title}\n---\n\n${body}\n`;
const ENV_KEYS = [
  "RKS_CODE_GLOB",
  "ROUTEKIT_CODE_GLOB",
  "RKS_RAG_CODE_GLOB",
  "RKS_RAG_SCOPE_MODE",
  "ROUTEKIT_RAG_SCOPE_MODE",
  "RKS_RAG_RESET",
  "ROUTEKIT_RAG_RESET",
];
const RESET = { RKS_RAG_RESET: "1" };
const PRUNE = { RKS_RAG_SCOPE_MODE: "prune" };
// Code-file fixture. The code loop records NO fileOutcomes, so the code bypass is observed
// through table rows and manifest hashes only (keyed by projectRoot-relative path).
const CODE = "src/app.mjs";

describe("reset / prune re-embed every file instead of trusting the manifest", { timeout: 60_000 }, () => {
  let projectRoot;
  let dbPath;
  let saved;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "stub";
    process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
    for (const k of ENV_KEYS) delete process.env[k];
    projectRoot = makeTempDir("rag_reset_bypass");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "rag-reset", private: true }));
    dbPath = path.join(projectRoot, ".rks", "rag", "lance", "notes.lance");
    writeFile(path.join(projectRoot, "notes", "alpha.md"), NOTE("Alpha", "alpha body text"));
    writeFile(path.join(projectRoot, "notes", "beta.md"), NOTE("Beta", "beta body text"));
    writeFile(path.join(projectRoot, "src", "app.mjs"), "export const app = 'APP-CODE-FIXTURE';\n");
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const run = async (env = {}, extra = {}) => {
    const { embed } = await import("@routekit/rag/embed");
    Object.assign(process.env, env);
    try {
      return await embed({ projectRoot, vault: path.join(projectRoot, "notes"), glob: "**/*", db: dbPath, ...extra });
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  };

  const outcomeFor = (res, needle) => (res.fileOutcomes || []).find((o) => o.file.includes(needle));

  const rows = async () => {
    const db = await connect(dbPath);
    if (!(await db.tableNames()).includes("embeddings")) return [];
    return (await db.openTable("embeddings")).query().toArray();
  };
  const rowsFor = async (needle) => (await rows()).filter((r) => String(r.path).includes(needle));

  const manifestPath = () => path.join(projectRoot, ".rks", "rag", "embed-manifest.json");
  const rowCounts = async () => {
    const counts = {};
    for (const r of await rows()) counts[String(r.path)] = (counts[String(r.path)] || 0) + 1;
    return counts;
  };

  const readManifest = () => {
    const p = manifestPath();
    if (!fs.existsSync(p)) return { hashes: {} };
    return JSON.parse(fs.readFileSync(p, "utf8"));
  };

  it("fast path kept — a plain second run still skips unchanged notes", async () => {
    expect(outcomeFor(await run(), "alpha.md").embedded).toBe(true);
    const second = await run();
    expect(outcomeFor(second, "alpha.md").reason).toBe("unchanged");
    expect(outcomeFor(second, "beta.md").reason).toBe("unchanged");
    expect((await rowsFor("alpha.md")).length).toBeGreaterThan(0);
  });

  for (const [label, env] of [["RKS_RAG_RESET=1", RESET], ["RKS_RAG_SCOPE_MODE=prune", PRUNE]]) {
    it(`RED at HEAD — ${label} over an unchanged corpus re-embeds every file`, async () => {
      await run();
      expect((await rowsFor("alpha.md")).length).toBeGreaterThan(0); // positive control
      const res = await run(env);
      expect(outcomeFor(res, "alpha.md")?.embedded).toBe(true);
      expect(outcomeFor(res, "beta.md")?.embedded).toBe(true);
      expect((res.fileOutcomes || []).filter((o) => o.reason === "unchanged")).toEqual([]);
      expect((await rowsFor("alpha.md")).length).toBeGreaterThan(0);
      expect((await rowsFor("beta.md")).length).toBeGreaterThan(0);
    });
  }

  it("RED at HEAD — a partial reset keeps rows for the files that did not change", async () => {
    await run();
    writeFile(path.join(projectRoot, "notes", "alpha.md"), NOTE("Alpha", "alpha body text, edited"));
    await run(RESET);
    expect((await rowsFor("alpha.md")).length).toBeGreaterThan(0);
    expect((await rowsFor("beta.md")).length).toBeGreaterThan(0);
  });

  it("RED at HEAD — a plain run after a reset run leaves every note indexed", async () => {
    await run();
    await run(RESET);
    await run();
    expect((await rowsFor("alpha.md")).length).toBeGreaterThan(0);
    expect((await rowsFor("beta.md")).length).toBeGreaterThan(0);
  });

  it("after a reset run the manifest hashes exactly the notes that have rows", async () => {
    await run();
    await run(RESET);
    const keys = Object.keys(readManifest().hashes || {});
    for (const needle of ["alpha.md", "beta.md"]) {
      const hashed = keys.some((k) => k.includes(needle));
      expect(hashed).toBe(true);
      expect((await rowsFor(needle)).length > 0).toBe(hashed);
    }
  });

  it("a backlog.z_implemented.* note re-embedded under reset carries content_type 'implemented'", async () => {
    writeFile(path.join(projectRoot, "notes", "backlog.z_implemented.fix.sample.md"), NOTE("Sample", "shipped work"));
    await run();
    await run(RESET);
    const implRows = await rowsFor("backlog.z_implemented.fix.sample.md");
    expect(implRows.length).toBeGreaterThan(0);
    for (const r of implRows) expect(r.content_type).toBe("implemented");
  });

  for (const [label, env] of [["RKS_RAG_RESET=1", RESET], ["RKS_RAG_SCOPE_MODE=prune", PRUNE]]) {
    it(`RED at HEAD — ${label} over an unchanged corpus re-embeds the CODE file (rows + manifest)`, async () => {
      await run();
      expect((await rowsFor(CODE)).length).toBeGreaterThan(0); // positive control — the code file indexes
      expect(readManifest().hashes[CODE]).toBeTruthy(); // positive control — the code file is hashed
      await run(env);
      expect((await rowsFor(CODE)).length).toBeGreaterThan(0);
      expect(readManifest().hashes[CODE]).toBeTruthy();
    });
  }

  for (const [label, env] of [
    ["RKS_RAG_RESET=1", RESET],
    ["ROUTEKIT_RAG_RESET=1", { ROUTEKIT_RAG_RESET: "1" }],
    ["RKS_RAG_SCOPE_MODE=prune", PRUNE],
  ]) {
    it(`AC6 — ${label} combined with a bounded files list is refused and changes nothing`, async () => {
      expect((await run()).ok).toBe(true);
      const before = await rowCounts();
      expect(Object.keys(before).length).toBeGreaterThan(0); // positive control — the index is populated
      const bytesBefore = fs.readFileSync(manifestPath());
      const res = await run(env, { files: [path.join(projectRoot, "notes", "alpha.md")] });
      expect(res.ok).toBe(false);
      expect(String(res.error)).toMatch(/files/i);
      expect(String(res.error)).toMatch(/reset|prune/i);
      expect(String(res.error)).toMatch(/rks_rag_init/);
      expect(await rowCounts()).toEqual(before);
      expect(fs.readFileSync(manifestPath()).equals(bytesBefore)).toBe(true);
    });
  }

  it("AC6 positive control — a bounded run with neither env var set still succeeds", async () => {
    expect((await run()).ok).toBe(true);
    const alpha = path.join(projectRoot, "notes", "alpha.md");
    writeFile(alpha, NOTE("Alpha", "alpha body text, bounded edit"));
    const res = await run({}, { files: [alpha] });
    expect(res.ok).toBe(true);
    expect(outcomeFor(res, "alpha.md")?.embedded).toBe(true);
    expect((await rowsFor("beta.md")).length).toBeGreaterThan(0);
    expect((await rowsFor(CODE)).length).toBeGreaterThan(0);
  });

  it("AC6 reporting — the refusal is written to console.error with the same text as the returned error", async () => {
    expect((await run()).ok).toBe(true);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let res;
    let logged;
    try {
      res = await run(RESET, { files: [path.join(projectRoot, "notes", "alpha.md")] });
    } finally {
      logged = spy.mock.calls.map((args) => args.map(String).join(" "));
      spy.mockRestore();
    }
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
    expect(res.error.length).toBeGreaterThan(0);
    expect(logged.some((line) => line.includes(res.error))).toBe(true);
  });

  // AC6 reporting, CLI. The main guard compares import.meta.url with `file://${process.argv[1]}`,
  // so the script is spawned by its absolute path. The child finds the temp project through
  // ROUTEKIT_PROJECT_ROOT (read at embed.mjs module scope) and must get the stub embedder env.
  // --files= is resolved against the project root, so a relative note path is passed.
  const EMBED_CLI = fileURLToPath(new URL("../../packages/rag/src/embed.mjs", import.meta.url));
  const runCli = (env = {}) => {
    const childEnv = { ...process.env };
    for (const k of ENV_KEYS) delete childEnv[k];
    Object.assign(childEnv, {
      ROUTEKIT_PROJECT_ROOT: projectRoot,
      ROUTEKIT_RAG_EMBEDDINGS_MODE: "stub",
      RKS_RAG_EMBEDDINGS_MODE: "stub",
      ...env,
    });
    const r = spawnSync(process.execPath, [EMBED_CLI, "--files=notes/alpha.md"], {
      cwd: projectRoot,
      env: childEnv,
      encoding: "utf8",
      timeout: 45_000,
    });
    expect(r.error, `CLI spawn failed or timed out: ${r.error}`).toBeUndefined();
    return r;
  };

  it("AC6 reporting (CLI) — --files= with RKS_RAG_RESET=1 exits non-zero, prints the refusal on stderr, changes nothing", async () => {
    expect((await run()).ok).toBe(true);
    const before = await rowCounts();
    expect(Object.keys(before).length).toBeGreaterThan(0); // positive control — the index is populated
    const bytesBefore = fs.readFileSync(manifestPath());
    const r = runCli(RESET);
    expect(r.status).not.toBeNull();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/rks_rag_init/);
    expect(r.stderr).toMatch(/files/i);
    expect(r.stderr).toMatch(/reset|prune/i);
    expect(await rowCounts()).toEqual(before);
    expect(fs.readFileSync(manifestPath()).equals(bytesBefore)).toBe(true);
  }, 90_000);

  it("AC6 reporting (CLI) positive control — the same --files= invocation with neither env var exits 0 and writes the temp project's manifest", async () => {
    expect((await run()).ok).toBe(true);
    const bytesBefore = fs.readFileSync(manifestPath());
    writeFile(path.join(projectRoot, "notes", "alpha.md"), NOTE("Alpha", "alpha body text, CLI edit"));
    const r = runCli();
    expect(r.status).toBe(0);
    // The CLI targeted THIS temp project: its manifest changed (alpha re-hashed), so the
    // refusal test's unchanged bytes are not vacuous.
    expect(fs.readFileSync(manifestPath()).equals(bytesBefore)).toBe(false);
    expect((await rowsFor("alpha.md")).length).toBeGreaterThan(0);
    expect((await rowsFor("beta.md")).length).toBeGreaterThan(0);
  }, 90_000);
});
