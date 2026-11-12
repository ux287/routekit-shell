// backlog.fix.test-suite-mutates-live-project-registry — writer-seam refusal.
// writeRegistry / appendProject (and upsertProject, which writes through writeRegistry) must refuse
// the shell's OWN projects/index.jsonl while process.env.VITEST is set. Every refusal case is
// read-only against the live registry: the refusal throws before any byte is written, and the
// digest is compared before and after. The VITEST-unset cases stub fs so nothing lands on disk.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import {
  writeRegistry,
  appendProject,
  upsertProject,
  loadProjects,
} from "../../packages/cli/src/project/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIVE = path.join(REPO_ROOT, "projects", "index.jsonl");

function liveDigest() {
  if (!fs.existsSync(LIVE)) return "absent";
  return crypto.createHash("sha256").update(fs.readFileSync(LIVE)).digest("hex");
}

const record = { id: "live-refusal-probe", root: "/tmp/live-refusal-probe" };

let savedRegistryEnv;
let savedVitestEnv;
let tmpRoot;

beforeEach(() => {
  savedRegistryEnv = process.env.RKS_REGISTRY_PATH;
  savedVitestEnv = process.env.VITEST;
  delete process.env.RKS_REGISTRY_PATH;
  process.env.VITEST = "true";
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-live-refusal-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedRegistryEnv === undefined) delete process.env.RKS_REGISTRY_PATH;
  else process.env.RKS_REGISTRY_PATH = savedRegistryEnv;
  if (savedVitestEnv === undefined) delete process.env.VITEST;
  else process.env.VITEST = savedVitestEnv;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("writer-seam refusal under VITEST", () => {
  it("writeRegistry throws for the live registry via the default baseDir and leaves its digest unchanged", () => {
    const before = liveDigest();
    expect(() => writeRegistry([record], REPO_ROOT)).toThrow();
    expect(liveDigest()).toBe(before);
  });

  it("appendProject throws for the live registry via the default baseDir and leaves its digest unchanged", () => {
    const before = liveDigest();
    expect(() => appendProject(record, REPO_ROOT)).toThrow();
    expect(liveDigest()).toBe(before);
  });

  it("upsertProject throws for the live registry via the default baseDir and leaves its digest unchanged", () => {
    const before = liveDigest();
    expect(() => upsertProject(record, REPO_ROOT)).toThrow();
    expect(liveDigest()).toBe(before);
  });

  it("writeRegistry throws when opts.registryPath resolves to the live registry (non-normalized path)", () => {
    const before = liveDigest();
    const unnormalized = path.join(REPO_ROOT, "projects", ".", "index.jsonl");
    expect(() => writeRegistry([record], tmpRoot, { registryPath: unnormalized })).toThrow();
    expect(liveDigest()).toBe(before);
  });

  it("writeRegistry and appendProject throw when RKS_REGISTRY_PATH is the live registry", () => {
    const before = liveDigest();
    process.env.RKS_REGISTRY_PATH = LIVE;
    expect(() => writeRegistry([record], tmpRoot)).toThrow();
    expect(() => appendProject(record, tmpRoot)).toThrow();
    expect(liveDigest()).toBe(before);
  });

  it("the refusal error names the live registry file and RKS_REGISTRY_PATH", () => {
    let message = "";
    try {
      writeRegistry([record], REPO_ROOT);
    } catch (err) {
      message = String(err && err.message);
    }
    expect(message).toContain(LIVE);
    expect(message).toContain("RKS_REGISTRY_PATH");
  });
});

describe("non-live paths and non-test runs are unchanged", () => {
  it("writeRegistry to a temp baseDir writes and returns the temp path", () => {
    const written = writeRegistry([record], tmpRoot);
    expect(written).toBe(path.join(tmpRoot, "projects", "index.jsonl"));
    expect(loadProjects(tmpRoot).map((r) => r.id)).toEqual([record.id]);
  });

  it("appendProject to a temp RKS_REGISTRY_PATH appends the record", () => {
    const redirected = path.join(tmpRoot, "redirected", "index.jsonl");
    process.env.RKS_REGISTRY_PATH = redirected;
    appendProject(record, REPO_ROOT);
    const lines = fs.readFileSync(redirected, "utf8").split("\n").filter(Boolean);
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([record.id]);
  });

  it("writeRegistry to a temp opts.registryPath writes the record", () => {
    const explicit = path.join(tmpRoot, "explicit.jsonl");
    expect(writeRegistry([record], REPO_ROOT, { registryPath: explicit })).toBe(explicit);
    expect(fs.readFileSync(explicit, "utf8")).toContain(record.id);
  });

  it("with VITEST unset writeRegistry and appendProject target the live registry path (fs stubbed, nothing lands)", () => {
    delete process.env.VITEST;
    const before = liveDigest();
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const appendSpy = vi.spyOn(fs, "appendFileSync").mockImplementation(() => undefined);
    expect(writeRegistry([record], REPO_ROOT)).toBe(LIVE);
    appendProject(record, REPO_ROOT);
    expect(writeSpy.mock.calls.some((c) => path.resolve(String(c[0])) === LIVE)).toBe(true);
    expect(appendSpy.mock.calls.some((c) => path.resolve(String(c[0])) === LIVE)).toBe(true);
    vi.restoreAllMocks();
    expect(liveDigest()).toBe(before);
  });

  it("loadProjects reads the live registry under VITEST without throwing", () => {
    expect(() => loadProjects(REPO_ROOT)).not.toThrow();
    expect(Array.isArray(loadProjects(REPO_ROOT))).toBe(true);
  });
});
