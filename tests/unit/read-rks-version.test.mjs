import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readRksVersion } from "../../packages/cli/src/project/read-rks-version.mjs";

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
