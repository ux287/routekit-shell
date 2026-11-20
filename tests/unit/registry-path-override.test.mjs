import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveRegistryPath, loadProjects, upsertProject } from "../../packages/cli/src/project/index.js";

// backlog.fix.e2e-shared-registry-race — RKS_REGISTRY_PATH is a TEST-ONLY seam: honoured only
// when process.env.VITEST is set, ignored otherwise, and with it unset the default is unchanged.

// Captured at module load, after tests/setup.mjs ran and before any beforeEach in this file.
const registryEnvAtLoad = process.env.RKS_REGISTRY_PATH;

let savedRegistryEnv;
let savedVitestEnv;
let tmpRoot;

beforeEach(() => {
  savedRegistryEnv = process.env.RKS_REGISTRY_PATH;
  savedVitestEnv = process.env.VITEST;
  delete process.env.RKS_REGISTRY_PATH;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-registry-override-"));
});

afterEach(() => {
  if (savedRegistryEnv === undefined) delete process.env.RKS_REGISTRY_PATH;
  else process.env.RKS_REGISTRY_PATH = savedRegistryEnv;
  if (savedVitestEnv === undefined) delete process.env.VITEST;
  else process.env.VITEST = savedVitestEnv;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const defaultPath = () => path.join(tmpRoot, "projects", "index.jsonl");

describe("tests/setup.mjs scrubs an inherited RKS_REGISTRY_PATH", () => {
  it("is undefined when this file loads, even if exported in the parent shell", () => {
    expect(registryEnvAtLoad).toBeUndefined();
  });
});

describe("resolveRegistryPath — RKS_REGISTRY_PATH unset leaves the default unchanged", () => {
  it("returns <baseDir>/projects/index.jsonl inside a test run", () => {
    process.env.VITEST = "true";
    expect(resolveRegistryPath(tmpRoot)).toBe(defaultPath());
  });

  it("returns <baseDir>/projects/index.jsonl outside a test run", () => {
    delete process.env.VITEST;
    expect(resolveRegistryPath(tmpRoot)).toBe(defaultPath());
  });

  it("still prefers opts.registryPath", () => {
    const explicit = path.join(tmpRoot, "explicit.jsonl");
    expect(resolveRegistryPath(tmpRoot, { registryPath: explicit })).toBe(explicit);
  });
});

describe("resolveRegistryPath — RKS_REGISTRY_PATH is honoured only during a test run", () => {
  it("inside a test run returns the trimmed env path", () => {
    process.env.VITEST = "true";
    const redirected = path.join(tmpRoot, "redirected.jsonl");
    process.env.RKS_REGISTRY_PATH = `  ${redirected}  `;
    expect(resolveRegistryPath(tmpRoot)).toBe(redirected);
  });

  it("inside a test run a whitespace-only value falls back to the default", () => {
    process.env.VITEST = "true";
    process.env.RKS_REGISTRY_PATH = "   ";
    expect(resolveRegistryPath(tmpRoot)).toBe(defaultPath());
  });

  it("inside a test run opts.registryPath beats the env path", () => {
    process.env.VITEST = "true";
    process.env.RKS_REGISTRY_PATH = path.join(tmpRoot, "redirected.jsonl");
    const explicit = path.join(tmpRoot, "explicit.jsonl");
    expect(resolveRegistryPath(tmpRoot, { registryPath: explicit })).toBe(explicit);
  });

  it("outside a test run a set RKS_REGISTRY_PATH is ignored and never written", () => {
    delete process.env.VITEST;
    const stray = path.join(tmpRoot, "stray.jsonl");
    process.env.RKS_REGISTRY_PATH = stray;
    expect(resolveRegistryPath(tmpRoot)).toBe(defaultPath());
    upsertProject({ id: "real-project", root: tmpRoot }, tmpRoot);
    expect(fs.existsSync(stray)).toBe(false);
    expect(loadProjects(tmpRoot).map((p) => p.id)).toEqual(["real-project"]);
    expect(fs.existsSync(defaultPath())).toBe(true);
  });

  it("inside a test run loadProjects/upsertProject use the env registry, not <baseDir>", () => {
    process.env.VITEST = "true";
    const redirected = path.join(tmpRoot, "sub", "redirected.jsonl");
    process.env.RKS_REGISTRY_PATH = redirected;
    upsertProject({ id: "e2e-only", root: tmpRoot }, tmpRoot);
    expect(fs.existsSync(redirected)).toBe(true);
    expect(fs.existsSync(defaultPath())).toBe(false);
    expect(loadProjects(tmpRoot).map((p) => p.id)).toEqual(["e2e-only"]);
  });
});
