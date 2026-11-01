import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import { resolveTargets, normalizeTargetFiles } from "../../packages/mcp-rks/src/shared/normalize-target-files.mjs";

describe("resolveTargets", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("resolve-targets-test");
    // Create some files to test existence checks
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src/existing.mjs"), "// exists");
  });

  it("is exported from normalize-target-files.mjs", () => {
    expect(typeof resolveTargets).toBe("function");
  });

  it("returns array with path, absPath, action, exists, mismatch fields", () => {
    const result = resolveTargets(projectRoot, [
      { path: "src/existing.mjs", op: "edit", desc: "Edit existing" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("path", "src/existing.mjs");
    expect(result[0]).toHaveProperty("absPath");
    expect(result[0]).toHaveProperty("action");
    expect(result[0]).toHaveProperty("exists");
    expect(result[0]).toHaveProperty("mismatch");
  });

  it("resolves absPath using projectRoot + relative path", () => {
    const result = resolveTargets(projectRoot, [{ path: "src/existing.mjs", op: "edit" }]);
    expect(result[0].absPath).toBe(path.resolve(projectRoot, "src/existing.mjs"));
  });

  it("sets exists:true when file exists on disk", () => {
    const result = resolveTargets(projectRoot, [{ path: "src/existing.mjs", op: "edit" }]);
    expect(result[0].exists).toBe(true);
  });

  it("sets exists:false when file does not exist", () => {
    const result = resolveTargets(projectRoot, [{ path: "src/missing.mjs", op: "edit" }]);
    expect(result[0].exists).toBe(false);
  });

  it("sets mismatch to 'CREATE but file exists' when action is CREATE and file exists", () => {
    const result = resolveTargets(projectRoot, [{ path: "src/existing.mjs", op: "create" }]);
    expect(result[0].mismatch).toBe("CREATE but file exists");
  });

  it("sets mismatch to 'EDIT but file does not exist' when action is EDIT and file missing", () => {
    const result = resolveTargets(projectRoot, [{ path: "src/missing.mjs", op: "edit" }]);
    expect(result[0].mismatch).toBe("EDIT but file does not exist");
  });

  it("sets mismatch to null when action and existence are consistent", () => {
    const result = resolveTargets(projectRoot, [{ path: "src/existing.mjs", op: "edit" }]);
    expect(result[0].mismatch).toBeNull();
  });

  it("handles empty targetFiles array", () => {
    const result = resolveTargets(projectRoot, []);
    expect(result).toEqual([]);
  });

  it("handles DELETE action without throwing", () => {
    const result = resolveTargets(projectRoot, [{ path: "src/existing.mjs", action: "DELETE" }]);
    expect(result[0].action).toBe("DELETE");
    expect(result[0].exists).toBe(true);
  });

  it("preserves the original relative path in the path field", () => {
    const result = resolveTargets(projectRoot, [{ path: "src/existing.mjs", op: "edit" }]);
    expect(result[0].path).toBe("src/existing.mjs");
    expect(path.isAbsolute(result[0].path)).toBe(false);
  });
});

describe("normalizeTargetFiles (regression)", () => {
  it("still normalizes string arrays", () => {
    const result = normalizeTargetFiles(["src/foo.mjs", "src/bar.mjs"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ path: "src/foo.mjs", action: "EDIT" });
  });

  it("still normalizes object arrays with op field", () => {
    const result = normalizeTargetFiles([{ path: "src/new.mjs", op: "create", desc: "New file" }]);
    expect(result[0].action).toBe("CREATE");
    expect(result[0].desc).toBe("New file");
  });
});
