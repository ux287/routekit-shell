import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { connect } from "@lancedb/lancedb";

// embed.mjs reads this into a module-level constant: set it BEFORE importing the rag modules.
process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
delete process.env.RKS_RAG_RESET;
delete process.env.ROUTEKIT_RAG_RESET;

const INIT_PATH = path.resolve("packages/rag/src/init.mjs");
const SERVER_SRC = fs.readFileSync(path.resolve("packages/mcp-rks/src/server.mjs"), "utf8");
const { runRagInit, runRagReset, runRagEmbed, setRagHostHooks } = await import("../../packages/rag/src/tools.mjs");
const { init } = await import("../../packages/rag/src/init.mjs");

const DIM = 384;
const vec = () => Array.from({ length: DIM }, () => 0.01);
let root;
let events;

function writeConfig(projectRoot, kind) {
  const ragDir = path.join(projectRoot, ".rks", "rag");
  fs.mkdirSync(ragDir, { recursive: true });
  const config = kind === "legacy"
    ? { version: 1, engine: "lancedb", paths: { notes: ".rks/rag/lance/notes.lance", code: ".rks/rag/lance/code.lance", kg: ".rks/rag/lance/kg.lance" } }
    : { version: 2, engine: "lancedb", paths: { unified: ".rks/rag/test.lancedb" } };
  fs.writeFileSync(path.join(ragDir, "config.json"), JSON.stringify(config, null, 2));
  return kind === "legacy"
    ? path.join(projectRoot, ".rks/rag/lance/notes.lance")
    : path.join(projectRoot, ".rks/rag/test.lancedb");
}

async function seedRows(dbPath, n = 3) {
  fs.mkdirSync(dbPath, { recursive: true });
  const db = await connect(dbPath);
  const rows = Array.from({ length: n }, (_, i) => ({ id: `seed-${i}`, path: `notes/n${i}.md`, text: "seed", vector: vec() }));
  await db.createTable("embeddings", rows);
}

async function tableState(dbPath) {
  const db = await connect(dbPath);
  if (!(await db.tableNames()).includes("embeddings")) return { exists: false, rows: 0 };
  return { exists: true, rows: await (await db.openTable("embeddings")).countRows() };
}

async function allRows(dbPath) {
  const db = await connect(dbPath);
  return (await db.openTable("embeddings")).query().toArray();
}

const manifestAt = (r) => path.join(r, ".rks", "rag", "embed-manifest.json");
function seedManifest(file, tag) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ hashes: { "notes/foo.md": tag } }));
  fs.writeFileSync(file, bytes);
  return bytes;
}
const sameBytes = (file, bytes) => fs.existsSync(file) && fs.readFileSync(file).equals(bytes);

function runCli(projectRoot) {
  return spawnSync(process.execPath, [INIT_PATH], {
    cwd: projectRoot,
    env: { ...process.env, ROUTEKIT_PROJECT_ROOT: projectRoot },
    encoding: "utf8",
    timeout: 15_000,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rag-init-reset-"));
  events = [];
  setRagHostHooks({ getTelemetryCollector: () => ({ emit: (type, _projectId, payload) => events.push({ type, payload }) }) });
});

afterEach(() => {
  setRagHostHooks({ getTelemetryCollector: () => ({ emit() {} }) });
  vi.doUnmock("@lancedb/lancedb");
  // The unverified-drop case loads init.mjs under the mocked connect; clear the registry so the
  // top-level tools.mjs's dynamic import("./init.mjs") re-evaluates against the real LanceDB.
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("plain init is non-destructive and never touches the manifest", () => {
  for (const kind of ["unified", "legacy"]) {
    it(`${kind}: runRagInit, init({ db }) and the CLI entrypoint keep every row and every manifest byte`, async () => {
      const dbPath = writeConfig(root, kind);
      await seedRows(dbPath, 3);
      const seeded = [[manifestAt(root), seedManifest(manifestAt(root), "embed-path")]];
      if (kind === "legacy") {
        const dirnameManifest = path.join(path.dirname(dbPath), "embed-manifest.json");
        seeded.push([dirnameManifest, seedManifest(dirnameManifest, "dirname-path")]);
      }
      const untouched = async (label) => {
        expect(await tableState(dbPath), label).toEqual({ exists: true, rows: 3 });
        for (const [file, bytes] of seeded) expect(sameBytes(file, bytes), `${label}: ${file}`).toBe(true);
      };

      const viaTools = await runRagInit(root);
      expect(viaTools.ok).toBe(true);
      expect(viaTools.tableDropped).not.toBe(true);
      await untouched("runRagInit");

      const viaRaw = await init({ db: dbPath });
      expect(viaRaw.ok).toBe(true);
      await untouched("init({ db })");

      const cli = runCli(root);
      expect(cli.status, cli.stderr).toBe(0);
      await untouched("CLI entrypoint");
    });
  }
});

describe("runRagReset (rks_rag_init reset: true)", () => {
  it("drops a populated table and reports observed rowsBeforeReset and tableDropped", async () => {
    const dbPath = writeConfig(root, "unified");
    await seedRows(dbPath, 3);
    const result = await runRagReset(root);
    expect(result.ok).toBe(true);
    expect(result.tableDropped).toBe(true);
    expect(result.rowsBeforeReset).toBe(3);
    expect((await tableState(dbPath)).exists).toBe(false);
  });

  it("with no existing table returns ok true, tableDropped false, rowsBeforeReset 0", async () => {
    writeConfig(root, "unified");
    const result = await runRagReset(root);
    expect(result).toMatchObject({ ok: true, tableDropped: false, rowsBeforeReset: 0 });
  });

  it("with no existing table but a seeded manifest still clears the manifest and reports manifestPath", async () => {
    writeConfig(root, "unified");
    seedManifest(manifestAt(root), "stale");
    const result = await runRagReset(root);
    expect(result).toMatchObject({ ok: true, tableDropped: false, rowsBeforeReset: 0 });
    expect(fs.existsSync(manifestAt(root))).toBe(false);
    expect(result.manifestPath).toBe(manifestAt(root));
  });

  for (const kind of ["unified", "legacy"]) {
    it(`${kind}: clears <root>/.rks/rag/embed-manifest.json and reports it as manifestPath`, async () => {
      const dbPath = writeConfig(root, kind);
      await seedRows(dbPath, 1);
      seedManifest(manifestAt(root), "x");
      const result = await runRagReset(root);
      expect(result.ok).toBe(true);
      expect(fs.existsSync(manifestAt(root))).toBe(false);
      expect(result.manifestPath).toBe(manifestAt(root));
    });
  }

  it("refuses under a live embed lock, changes nothing, and emits the refusal", async () => {
    const dbPath = writeConfig(root, "unified");
    await seedRows(dbPath, 2);
    const bytes = seedManifest(manifestAt(root), "x");
    fs.writeFileSync(path.join(root, ".rks", "rag", ".embed-lock"), JSON.stringify({ pid: process.pid, started: Date.now() }));
    const result = await runRagReset(root);
    expect(result.ok).toBe(false);
    expect(result.locked).toBe(true);
    expect(String(result.error)).toMatch(/lock/i);
    expect(await tableState(dbPath)).toEqual({ exists: true, rows: 2 });
    expect(sameBytes(manifestAt(root), bytes)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  it("an unverifiable drop returns ok false and leaves the manifest in place (drop before manifest)", async () => {
    const dbPath = writeConfig(root, "unified");
    await seedRows(dbPath, 2);
    const bytes = seedManifest(manifestAt(root), "x");
    // Mechanism is Build's choice (an injection seam is equally acceptable): make dropTable resolve without dropping.
    vi.resetModules();
    vi.doMock("@lancedb/lancedb", async (importOriginal) => {
      const real = await importOriginal();
      return { ...real, connect: async (...args) => { const db = await real.connect(...args); db.dropTable = async () => {}; return db; } };
    });
    const fresh = await import("../../packages/rag/src/tools.mjs");
    const result = await fresh.runRagReset(root);
    expect(result.ok).toBe(false);
    expect(result.tableDropped).not.toBe(true);
    expect(sameBytes(manifestAt(root), bytes)).toBe(true);
    expect((await tableState(dbPath)).exists).toBe(true);
  });
});

describe("rag.init telemetry ok comes from the result (R1)", () => {
  it("emits ok false when init() returns ok false", async () => {
    writeConfig(root, "legacy");
    // .rks/rag/lance is a regular file, so initializeDatabase fails inside its own catch.
    fs.writeFileSync(path.join(root, ".rks", "rag", "lance"), "not a directory");
    const result = await runRagInit(root);
    expect(result.ok).toBe(false);
    expect(events.filter((e) => e.type === "rag.init").at(-1)?.payload?.ok).toBe(false);
  });

  it("emits ok true on success", async () => {
    writeConfig(root, "unified");
    const result = await runRagInit(root);
    expect(result.ok).toBe(true);
    expect(events.filter((e) => e.type === "rag.init").at(-1)?.payload?.ok).toBe(true);
  });
});

describe("reset then full embed is a clean rebuild", () => {
  async function seedWithResidue() {
    const dbPath = writeConfig(root, "unified");
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes", "foo.md"), "---\nid: foo\ntitle: Foo\n---\n\nFoo body text for the stub embedder.\n");
    const first = await runRagEmbed(root);
    expect(first.ok).toBe(true);
    // Clone a real row so the residue carries the exact schema embed writes (no schema-mismatch drop).
    const table = await (await connect(dbPath)).openTable("embeddings");
    const [real] = await table.query().limit(1).toArray();
    // Arrow list columns come back as Vector objects; turn them into plain arrays before re-adding.
    const plain = Object.fromEntries(Object.entries(real).map(([k, v]) => [k, v && typeof v === "object" && typeof v.toArray === "function" ? Array.from(v.toArray()) : v]));
    await table.add([{ ...plain, id: "residue-1", path: "notes/foo.md", tags: ["code"], vector: Array.from(real.vector) }]);
    return dbPath;
  }
  const isResidue = (r) => String(r.path).startsWith("notes/") && Array.from(r.tags ?? []).includes("code");

  it("positive control: plain init + full embed keeps the residue row", async () => {
    const dbPath = await seedWithResidue();
    expect((await runRagInit(root)).ok).toBe(true);
    await runRagEmbed(root);
    expect((await allRows(dbPath)).some((r) => r.id === "residue-1")).toBe(true);
  });

  it("runRagReset + full embed leaves no notes/ code residue and no duplicate ids", async () => {
    const dbPath = await seedWithResidue();
    expect((await runRagReset(root)).ok).toBe(true);
    expect((await runRagEmbed(root)).ok).toBe(true);
    const rows = await allRows(dbPath);
    expect(rows.filter(isResidue)).toHaveLength(0);
    expect(rows.some((r) => r.id === "residue-1")).toBe(false);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("rks_rag_init server surface (full-source assertions, no source-window slices)", () => {
  it("ragInitSchema declares an optional boolean reset", () => {
    expect(SERVER_SRC).toMatch(/const ragInitSchema = z\.object\(\{[^;]*reset:\s*z\.boolean\(\)/);
  });

  it("imports runRagReset from the rag barrel and dispatches on reset === true", () => {
    expect(SERVER_SRC).toMatch(/import \{[^}]*\brunRagReset\b[^}]*\} from "@routekit\/rag";/);
    expect(SERVER_SRC).toMatch(/input\.reset === true/);
    expect(SERVER_SRC).toMatch(/await runRagReset\(projectRoot\)/);
    expect(SERVER_SRC).toMatch(/await runRagInit\(projectRoot\)/);
  });

  it("the payload projects the observed reset fields", () => {
    for (const field of ["rowsBeforeReset", "tableDropped", "manifestPath"]) expect(SERVER_SRC).toContain(field);
  });

  it("the description states reset deletes every row and plain init only creates or opens", () => {
    const m = SERVER_SRC.match(/name: "rks_rag_init",\s*description:\s*("(?:[^"\\]|\\.)*")/);
    expect(m).not.toBeNull();
    const desc = JSON.parse(m[1]);
    expect(desc).toMatch(/reset/);
    expect(desc).toMatch(/every row|all rows/i);
    expect(desc).toMatch(/manifest/i);
    expect(desc).toMatch(/creat\w* or open\w*|open\w* or creat\w*/i);
  });
});
