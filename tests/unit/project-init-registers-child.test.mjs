/**
 * Story: backlog.fix.project-init-does-not-register-child
 *
 * Empirical confirmation (per QA/ARCH): registration is correct IN-PROCESS —
 * upsertProject(record, shellRoot) writes projects/index.jsonl under the passed
 * shellRoot with upsert semantics. The 2026-06-22 UAT "not registered" failure
 * was a global `routekit` link resolving SHELL_ROOT to a different shell, not a
 * baseDir-threading bug. This locks in the invariant and guards against a silent
 * process.cwd() default.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertProject, loadProjects } from "../../packages/cli/src/project/index.js";

const tmps = [];
function mkTmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe("project registration writes to the passed shell root", () => {
  it("upsertProject(record, shellRoot) writes projects/index.jsonl UNDER shellRoot (not cwd)", () => {
    const shellRoot = mkTmp("reg-shell-");
    upsertProject({ id: "child-x", root: "/tmp/child-x", stack: "app" }, shellRoot);
    const registry = path.join(shellRoot, "projects", "index.jsonl");
    expect(fs.existsSync(registry)).toBe(true);
    const rows = fs.readFileSync(registry, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(rows.find((p) => p.id === "child-x")).toBeTruthy();
    // and NOT written to the current working directory
    expect(fs.existsSync(path.join(process.cwd(), "projects", "index.jsonl")) &&
      loadProjects(process.cwd()).some((p) => p.id === "child-x")).toBe(false);
  });

  it("preserves pre-existing entries (upsert, not overwrite)", () => {
    const shellRoot = mkTmp("reg-shell2-");
    upsertProject({ id: "a", root: "/tmp/a" }, shellRoot);
    upsertProject({ id: "b", root: "/tmp/b" }, shellRoot);
    expect(loadProjects(shellRoot).map((p) => p.id).sort()).toEqual(["a", "b"]);
  });

  it("replaces (not duplicates) a record with the same id", () => {
    const shellRoot = mkTmp("reg-shell3-");
    upsertProject({ id: "a", root: "/tmp/a", stack: "old" }, shellRoot);
    upsertProject({ id: "a", root: "/tmp/a", stack: "new" }, shellRoot);
    const rows = loadProjects(shellRoot).filter((p) => p.id === "a");
    expect(rows.length).toBe(1);
    expect(rows[0].stack).toBe("new");
  });
});
