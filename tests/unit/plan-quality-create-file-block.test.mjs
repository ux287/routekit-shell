/**
 * Tests for plan-quality-create-file-hard-block — verifies that
 * create_file steps targeting existing files produce a hard error
 * (not a warning), blocking exec.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { reviewPlan } from "../../packages/mcp-rks/src/server/plan-quality.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rks-plan-quality-block-test-"));
}

describe("plan-quality — create_file_already_exists is a hard block", () => {
  it("returns ok: false when create_file targets an existing file", async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "existing.ts"), "export const x = 1;\n");
    const plan = {
      steps: [{ action: "create_file", path: "existing.ts", content: "// overwrite\n" }],
    };
    const result = await reviewPlan({ projectRoot: dir, plan, problemContent: null });
    expect(result.ok).toBe(false);
  });

  it("places create_file_already_exists in errors, not warnings", async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "service.ts"), "// 100 lines of service code\n".repeat(100));
    const plan = {
      steps: [{ action: "create_file", path: "service.ts", content: "// stub\n" }],
    };
    const result = await reviewPlan({ projectRoot: dir, plan, problemContent: null });
    const err = result.errors.find(e => e.check === "create_file_already_exists");
    expect(err).toBeDefined();
    expect(result.warnings.find(w => w.check === "create_file_already_exists")).toBeUndefined();
  });

  it("error severity is 'error'", async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "file.mjs"), "// exists\n");
    const plan = {
      steps: [{ action: "create_file", path: "file.mjs", content: "// new\n" }],
    };
    const result = await reviewPlan({ projectRoot: dir, plan, problemContent: null });
    const err = result.errors.find(e => e.check === "create_file_already_exists");
    expect(err.severity).toBe("error");
  });

  it("does NOT fire when create_file targets a genuinely new file", async () => {
    const dir = makeTempDir();
    const plan = {
      steps: [{ action: "create_file", path: "brand-new.ts", content: "export const y = 2;\n" }],
    };
    const result = await reviewPlan({ projectRoot: dir, plan, problemContent: null });
    expect(result.errors.find(e => e.check === "create_file_already_exists")).toBeUndefined();
    expect(result.warnings.find(w => w.check === "create_file_already_exists")).toBeUndefined();
  });

  it("does NOT fire when projectRoot is not provided", async () => {
    const plan = {
      steps: [{ action: "create_file", path: "some-file.ts", content: "export const z = 3;\n" }],
    };
    const result = await reviewPlan({ projectRoot: null, plan, problemContent: null });
    expect(result.errors.find(e => e.check === "create_file_already_exists")).toBeUndefined();
  });

  it("fires for each create_file step that targets an existing file", async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "a.ts"), "// a\n");
    fs.writeFileSync(path.join(dir, "b.ts"), "// b\n");
    const plan = {
      steps: [
        { action: "create_file", path: "a.ts", content: "// overwrite a\n" },
        { action: "create_file", path: "b.ts", content: "// overwrite b\n" },
        { action: "create_file", path: "c.ts", content: "// new c\n" },
      ],
    };
    const result = await reviewPlan({ projectRoot: dir, plan, problemContent: null });
    const matches = result.errors.filter(e => e.check === "create_file_already_exists");
    expect(matches).toHaveLength(2);
    expect(result.ok).toBe(false);
  });
});
