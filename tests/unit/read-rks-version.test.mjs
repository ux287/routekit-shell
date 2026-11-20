import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { readRksVersion, advanceStamp } from "../../packages/cli/src/project/read-rks-version.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/cli/src/project");

// The CLI-side rks release-version reader. Used to stamp a child's .rks/project.json
// rksVersion with the ACTUAL shell version so `routekit project upgrade` can compute a
// real from→to jump. rksVersion is a semver STRING, distinct from the integer schemaVersion.

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rks-ver-"));
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("readRksVersion(shellRoot)", () => {
  it("returns the version from the shell root package.json", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "routekit-shell-core", version: "0.20.18" }));
    expect(readRksVersion(root)).toBe("0.20.18");
  });

  it("returns null when package.json is missing", () => {
    expect(readRksVersion(root)).toBeNull();
  });

  it("returns null when package.json is malformed JSON", () => {
    writeFileSync(join(root, "package.json"), "{ not: valid");
    expect(readRksVersion(root)).toBeNull();
  });

  it("returns null when the version field is absent", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "routekit-shell-core" }));
    expect(readRksVersion(root)).toBeNull();
  });

  it("returns a semver STRING (never conflated with the integer schemaVersion)", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.20.18" }));
    const v = readRksVersion(root);
    expect(typeof v).toBe("string");
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("advanceStamp(rksJsonPath, to) — child rksVersion stamp writer", () => {
  it("sets rksVersion to `to`, read-modify-write preserving ALL sibling config", () => {
    const p = join(root, "project.json");
    writeFileSync(
      p,
      JSON.stringify({ id: "my-app", offRail: { enabled: true }, fetchRaw: { mode: "open" }, skillDefaults: { build: "heartbeat" }, rksVersion: "0.20.21" }),
    );
    advanceStamp(p, "0.20.36");
    const pj = JSON.parse(readFileSync(p, "utf8"));
    expect(pj.rksVersion).toBe("0.20.36");
    expect(pj.id).toBe("my-app");
    expect(pj.offRail).toEqual({ enabled: true });
    expect(pj.fetchRaw).toEqual({ mode: "open" });
    expect(pj.skillDefaults).toEqual({ build: "heartbeat" });
  });

  it("creates a fresh { rksVersion } when the file is missing (best-effort, makes parent dir)", () => {
    const p = join(root, ".rks", "project.json");
    advanceStamp(p, "0.20.36");
    expect(JSON.parse(readFileSync(p, "utf8")).rksVersion).toBe("0.20.36");
  });

  it("repairs a malformed file to { rksVersion } without throwing", () => {
    const p = join(root, "project.json");
    writeFileSync(p, "{ not: valid json");
    expect(() => advanceStamp(p, "0.20.36")).not.toThrow();
    expect(JSON.parse(readFileSync(p, "utf8")).rksVersion).toBe("0.20.36");
  });
});

describe("advanceStamp extraction — shared home, no circular import, no duplicate copy", () => {
  it("upgrade.mjs imports advanceStamp from read-rks-version.mjs and no longer defines its own", () => {
    const src = readFileSync(join(CLI, "upgrade.mjs"), "utf8");
    expect(src).toMatch(/import\s*\{[^}]*advanceStamp[^}]*\}\s*from\s*["']\.\/read-rks-version\.mjs["']/);
    expect(src).not.toMatch(/function\s+advanceStamp\s*\(/); // private copy deleted
  });

  it("sync.mjs imports advanceStamp from read-rks-version.mjs, and the shared module has NO back-import (no cycle)", () => {
    const syncSrc = readFileSync(join(CLI, "sync.mjs"), "utf8");
    expect(syncSrc).toMatch(/import\s*\{[^}]*advanceStamp[^}]*\}\s*from\s*["']\.\/read-rks-version\.mjs["']/);
    const shared = readFileSync(join(CLI, "read-rks-version.mjs"), "utf8");
    expect(shared).not.toMatch(/from\s*["']\.\/sync\.mjs["']/);
    expect(shared).not.toMatch(/from\s*["']\.\/upgrade\.mjs["']/);
  });
});
