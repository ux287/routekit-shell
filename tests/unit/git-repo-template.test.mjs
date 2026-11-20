import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_GIT_ARGS,
  fixtureGitArgv,
  copyTree,
  COPY_TREE_MAX_ATTEMPTS,
  getRepoCopy,
  disposeTemplates,
} from "../helpers/git-repo-template.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(__dirname, "../helpers/git-repo-template.mjs");
const roots = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
}
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function enoent() {
  const e = new Error("ENOENT: no such file or directory, lstat 'x/maintenance.lock'");
  e.code = "ENOENT";
  return e;
}

describe("fixture git argv", () => {
  it("prepends all four maintenance overrides as -c pairs ahead of caller args", () => {
    const argv = fixtureGitArgv(["init", "-b", "staging", "/x"]);
    for (const kv of ["maintenance.auto=false", "maintenance.autoDetach=false", "gc.auto=0", "gc.autoDetach=false"]) {
      const i = argv.indexOf(kv);
      expect(i).toBeGreaterThan(0);
      expect(argv[i - 1]).toBe("-c");
      expect(i).toBeLessThan(argv.indexOf("init"));
    }
    expect(argv.slice(-4)).toEqual(["init", "-b", "staging", "/x"]);
  });
  it("is not gc.auto=0 alone: both detach settings are present", () => {
    expect(FIXTURE_GIT_ARGS).toContain("gc.autoDetach=false");
    expect(FIXTURE_GIT_ARGS).toContain("maintenance.autoDetach=false");
    expect(FIXTURE_GIT_ARGS).toContain("maintenance.auto=false");
  });
  it("git() builds argv only through fixtureGitArgv (source witness)", () => {
    const src = fs.readFileSync(HELPER, "utf8");
    expect(src).toMatch(/spawnSync\("git", fixtureGitArgv\(args\)/);
    expect(src).not.toMatch(/spawnSync\("git", args,/);
  });
});

describe("copyTree", () => {
  it("survives one ENOENT then succeeds", () => {
    let calls = 0;
    const copyFn = (s, d, o) => {
      calls++;
      if (calls === 1) throw enoent();
      fs.cpSync(s, d, o);
    };
    const src = tmp("rks-ct-src-");
    fs.writeFileSync(path.join(src, "a.txt"), "a");
    const dest = path.join(tmp("rks-ct-dst-"), "out");
    expect(() => copyTree(src, dest, { copyFn })).not.toThrow();
    expect(calls).toBe(2);
    expect(fs.readFileSync(path.join(dest, "a.txt"), "utf8")).toBe("a");
  });
  it("re-throws the original ENOENT after exactly COPY_TREE_MAX_ATTEMPTS attempts", () => {
    let calls = 0;
    const copyFn = () => { calls++; throw enoent(); };
    expect(COPY_TREE_MAX_ATTEMPTS).toBe(5);
    let caught;
    try { copyTree("/nope", "/nope2", { copyFn }); } catch (e) { caught = e; }
    expect(caught?.code).toBe("ENOENT");
    expect(caught?.message).toMatch(/maintenance\.lock/);
    expect(calls).toBe(COPY_TREE_MAX_ATTEMPTS);
  });
  it("does not retry non-ENOENT errors", () => {
    let calls = 0;
    const copyFn = () => { calls++; const e = new Error("EACCES"); e.code = "EACCES"; throw e; };
    expect(() => copyTree("/a", "/b", { copyFn })).toThrow("EACCES");
    expect(calls).toBe(1);
  });
  it("never copies .git/objects/maintenance.lock (real filesystem)", () => {
    const src = tmp("rks-ct-src-");
    fs.mkdirSync(path.join(src, ".git", "objects"), { recursive: true });
    fs.writeFileSync(path.join(src, ".git", "objects", "maintenance.lock"), "");
    fs.writeFileSync(path.join(src, ".git", "HEAD"), "ref: refs/heads/staging\n");
    const dest = path.join(tmp("rks-ct-dst-"), "out");
    copyTree(src, dest);
    expect(fs.existsSync(path.join(dest, ".git", "HEAD"))).toBe(true);
    expect(fs.existsSync(path.join(dest, ".git", "objects", "maintenance.lock"))).toBe(false);
  });
});

describe("call sites and disposal", () => {
  it("no bare fs.cpSync remains at the template copy sites", () => {
    const src = fs.readFileSync(HELPER, "utf8");
    expect(src).not.toMatch(/fs\.cpSync\(tpl\.(workDir|bareDir)/);
    expect((src.match(/copyTree\(tpl\./g) || []).length).toBe(3);
  });
  it("disposeTemplates removes template and copy roots", () => {
    const { base, workDir } = getRepoCopy("working-no-origin");
    expect(fs.existsSync(path.join(workDir, ".git"))).toBe(true);
    disposeTemplates();
    expect(fs.existsSync(base)).toBe(false);
  });
});
