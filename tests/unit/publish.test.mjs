import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyTransforms, publish, generateExcludeArgs, generateIncludeArgs } from "../../packages/mcp-rks/src/server/publish.mjs";
import { makeTempDir } from "../helpers/tmp.mjs";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn() };
});

const { spawnSync } = await import("child_process");

// --- applyTransforms unit tests ---

describe("applyTransforms — single rule", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir("apply-transforms-single");
    const notesDir = path.join(tmpDir, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, "canon.getting-started.md"), "# Getting Started");
    fs.writeFileSync(path.join(notesDir, "canon.what-is-rks.md"), "# What is RKS");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("globs matching files and moves each matched file", () => {
    applyTransforms(tmpDir, [
      { match: "notes/canon.**", rename: "notes/rks.canon.{rest}" },
    ]);

    expect(fs.existsSync(path.join(tmpDir, "notes", "rks.canon.getting-started.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "notes", "rks.canon.what-is-rks.md"))).toBe(true);
  });

  it("removes original files after rename", () => {
    applyTransforms(tmpDir, [
      { match: "notes/canon.**", rename: "notes/rks.canon.{rest}" },
    ]);

    expect(fs.existsSync(path.join(tmpDir, "notes", "canon.getting-started.md"))).toBe(false);
  });

  it("computes destination using {rest} substitution from wildcard capture", () => {
    applyTransforms(tmpDir, [
      { match: "notes/canon.**", rename: "notes/rks.canon.{rest}" },
    ]);

    const { renamedFiles } = applyTransforms(makeTempDir("verify"), []);
    // verify via returned renamedFiles
    const tmpDir2 = makeTempDir("apply-transforms-single-verify");
    fs.mkdirSync(path.join(tmpDir2, "notes"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir2, "notes", "canon.getting-started.md"), "# content");
    const result = applyTransforms(tmpDir2, [
      { match: "notes/canon.**", rename: "notes/rks.canon.{rest}" },
    ]);
    expect(result.renamedFiles).toContainEqual({
      from: "notes/canon.getting-started.md",
      to: "notes/rks.canon.getting-started.md",
    });
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });

  it("creates parent directories for destination if needed", () => {
    const tmpDir2 = makeTempDir("apply-transforms-newdir");
    fs.mkdirSync(path.join(tmpDir2, "notes"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir2, "notes", "canon.guide.md"), "# Guide");

    applyTransforms(tmpDir2, [
      { match: "notes/canon.**", rename: "published/rks.canon.{rest}" },
    ]);

    expect(fs.existsSync(path.join(tmpDir2, "published", "rks.canon.guide.md"))).toBe(true);
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });
});

describe("applyTransforms — multiple rules", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir("apply-transforms-multi");
    const notesDir = path.join(tmpDir, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, "canon.getting-started.md"), "# Getting Started");
    fs.writeFileSync(path.join(notesDir, "research.public.2026.md"), "# Research");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies each rule independently", () => {
    applyTransforms(tmpDir, [
      { match: "notes/canon.**", rename: "notes/rks.canon.{rest}" },
      { match: "notes/research.public.**", rename: "notes/rks.research.{rest}" },
    ]);

    expect(fs.existsSync(path.join(tmpDir, "notes", "rks.canon.getting-started.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "notes", "rks.research.2026.md"))).toBe(true);
  });

  it("all matched files from all rules are renamed correctly", () => {
    const result = applyTransforms(tmpDir, [
      { match: "notes/canon.**", rename: "notes/rks.canon.{rest}" },
      { match: "notes/research.public.**", rename: "notes/rks.research.{rest}" },
    ]);

    expect(result.renamedFiles).toHaveLength(2);
    expect(result.renamedFiles).toContainEqual({
      from: "notes/canon.getting-started.md",
      to: "notes/rks.canon.getting-started.md",
    });
    expect(result.renamedFiles).toContainEqual({
      from: "notes/research.public.2026.md",
      to: "notes/rks.research.2026.md",
    });
  });
});

describe("applyTransforms — allowlist drop", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir("apply-transforms-allowlist");
    const notesDir = path.join(tmpDir, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, "canon.getting-started.md"), "# Public");
    fs.writeFileSync(path.join(notesDir, "private.secret.md"), "# Private");
    fs.writeFileSync(path.join(notesDir, "backlog.feat.foo.md"), "# Backlog");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes files in the transform root not matched by any rule", () => {
    applyTransforms(tmpDir, [
      { match: "notes/canon.**", rename: "notes/rks.canon.{rest}" },
    ]);

    expect(fs.existsSync(path.join(tmpDir, "notes", "private.secret.md"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "notes", "backlog.feat.foo.md"))).toBe(false);
  });

  it("keeps files outside the transform root", () => {
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "index.mjs"), "// code");

    applyTransforms(tmpDir, [
      { match: "notes/canon.**", rename: "notes/rks.canon.{rest}" },
    ]);

    expect(fs.existsSync(path.join(tmpDir, "src", "index.mjs"))).toBe(true);
  });

  it("includes unmatched files in deletedFiles return value", () => {
    const result = applyTransforms(tmpDir, [
      { match: "notes/canon.**", rename: "notes/rks.canon.{rest}" },
    ]);

    expect(result.deletedFiles).toContain("notes/private.secret.md");
    expect(result.deletedFiles).toContain("notes/backlog.feat.foo.md");
  });
});

describe("applyTransforms — empty transforms passthrough", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir("apply-transforms-passthrough");
    const notesDir = path.join(tmpDir, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, "canon.getting-started.md"), "# content");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("leaves all files untouched when transforms is empty array", () => {
    applyTransforms(tmpDir, []);
    expect(fs.existsSync(path.join(tmpDir, "notes", "canon.getting-started.md"))).toBe(true);
  });

  it("returns empty renamedFiles and deletedFiles", () => {
    const result = applyTransforms(tmpDir, []);
    expect(result.renamedFiles).toEqual([]);
    expect(result.deletedFiles).toEqual([]);
  });
});

// --- publish() integration tests ---

function makeProfilesYaml(profiles, remotes = {}) {
  const lines = ["profiles:"];
  for (const [name, p] of Object.entries(profiles)) {
    lines.push(`  ${name}:`);
    if (p.description) lines.push(`    description: "${p.description}"`);
    if (p.exclude) lines.push(`    exclude: []`);
    if (p.transforms) {
      lines.push(`    transforms:`);
      for (const t of p.transforms) {
        lines.push(`      - match: "${t.match}"`);
        lines.push(`        rename: "${t.rename}"`);
      }
    }
  }
  lines.push("remotes:");
  for (const [name, r] of Object.entries(remotes)) {
    lines.push(`  ${name}:`);
    lines.push(`    url: "${r.url}"`);
    if (r.profile) lines.push(`    profile: "${r.profile}"`);
  }
  return lines.join("\n") + "\n";
}

describe("publish() — transforms wiring", () => {
  let projectRoot, dirs;

  beforeEach(() => {
    dirs = [];
    projectRoot = makeTempDir("publish-wiring-test");
    dirs.push(projectRoot);
    const profilesDir = path.join(projectRoot, ".routekit");
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(
      path.join(profilesDir, "publish-profiles.yaml"),
      makeProfilesYaml(
        {
          "notes-transform": {
            description: "test profile with transforms",
            transforms: [
              { match: "notes/canon.**", rename: "notes/rks.canon.{rest}" },
            ],
          },
        },
        { origin: { url: "file:///dev/null", profile: "notes-transform" } }
      )
    );
    spawnSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("publish() calls applyTransforms after tar extraction when profile.transforms is non-empty", async () => {
    const renames = [];
    const origRenameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      renames.push([path.basename(String(args[0])), path.basename(String(args[1]))]);
      origRenameSync(...args);
    });

    spawnSync.mockImplementation((cmd, args, opts) => {
      if (cmd === "git" && args[0] === "remote" && args[1] === "get-url") {
        return { status: 1, stdout: "", stderr: "not found" };
      }
      if (cmd === "git" && args[0] === "remote" && args[1] === "add") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args[0] === "archive") {
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.from("") };
      }
      if (cmd === "tar") {
        const notesDir = path.join(opts.cwd, "notes");
        fs.mkdirSync(notesDir, { recursive: true });
        fs.writeFileSync(
          path.join(notesDir, "canon.getting-started.md"),
          "# Getting Started"
        );
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    await publish(projectRoot, {
      remote: "origin",
      profile: "notes-transform",
      dryRun: false,
    });

    expect(renames.some(([, dest]) => dest.includes("rks.canon"))).toBe(true);
  });

  it("publish() dry-run with transforms returns plannedRenames: [{ from, to }]", async () => {
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "git" && args[0] === "remote" && args[1] === "get-url") {
        return { status: 0, stdout: "file:///dev/null\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "ls-tree") {
        return {
          status: 0,
          stdout:
            "notes/canon.getting-started.md\nnotes/canon.what-is-rks.md\n",
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = await publish(projectRoot, {
      remote: "origin",
      profile: "notes-transform",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.plannedRenames).toEqual([
      {
        from: "notes/canon.getting-started.md",
        to: "notes/rks.canon.getting-started.md",
      },
      {
        from: "notes/canon.what-is-rks.md",
        to: "notes/rks.canon.what-is-rks.md",
      },
    ]);
  });

  it("publish() dry-run with no transforms returns empty plannedRenames", async () => {
    fs.writeFileSync(
      path.join(projectRoot, ".routekit", "publish-profiles.yaml"),
      makeProfilesYaml(
        { "app-only": { description: "no transforms", exclude: [] } },
        { origin: { url: "file:///dev/null" } }
      )
    );

    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "git" && args[0] === "remote" && args[1] === "get-url") {
        return { status: 0, stdout: "file:///dev/null\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = await publish(projectRoot, {
      remote: "origin",
      profile: "app-only",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.plannedRenames).toEqual([]);
  });

  it("publish() with no transforms key behaves identically to current behavior — no renames in output", async () => {
    fs.writeFileSync(
      path.join(projectRoot, ".routekit", "publish-profiles.yaml"),
      makeProfilesYaml(
        { "app-only": { description: "no transforms", exclude: [] } },
        { origin: { url: "file:///dev/null" } }
      )
    );

    spawnSync.mockImplementation((cmd, args, opts) => {
      if (cmd === "git" && args[0] === "remote" && args[1] === "get-url") {
        return { status: 0, stdout: "file:///dev/null\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "archive") {
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.from("") };
      }
      if (cmd === "tar") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const renameCallCount = { n: 0 };
    const origRenameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      renameCallCount.n++;
      origRenameSync(...args);
    });

    const result = await publish(projectRoot, {
      remote: "origin",
      profile: "app-only",
      dryRun: false,
    });

    expect(result.ok).toBe(true);
    expect(renameCallCount.n).toBe(0);
  });
});

// --- generateIncludeArgs unit tests ---

describe("generateIncludeArgs", () => {
  it("returns [] when profile is undefined", () => {
    expect(generateIncludeArgs(undefined)).toEqual([]);
  });

  it("returns [] when profile is null", () => {
    expect(generateIncludeArgs(null)).toEqual([]);
  });

  it("returns [] when profile.include is absent", () => {
    expect(generateIncludeArgs({})).toEqual([]);
  });

  it("returns [] when profile.include is an empty array", () => {
    expect(generateIncludeArgs({ include: [] })).toEqual([]);
  });

  it("returns include paths as plain strings (no flags)", () => {
    const result = generateIncludeArgs({ include: ["notes/canon.**", "README.md"] });
    expect(result).toEqual(["notes/canon.**", "README.md"]);
    expect(result.every(a => !a.startsWith("--"))).toBe(true);
  });

  it("returns each include path as a separate positional argument", () => {
    const result = generateIncludeArgs({ include: ["packages/", "scripts/", "README.md"] });
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("packages/");
    expect(result[1]).toBe("scripts/");
    expect(result[2]).toBe("README.md");
  });
});

// --- generateExcludeArgs regression tests ---

describe("generateExcludeArgs", () => {
  it("returns [] when profile is undefined", () => {
    expect(generateExcludeArgs(undefined)).toEqual([]);
  });

  it("returns [] when profile.exclude is absent", () => {
    expect(generateExcludeArgs({})).toEqual([]);
  });

  it("returns --exclude= flags for each pattern", () => {
    const result = generateExcludeArgs({ exclude: ["CLAUDE.md", ".rks/"] });
    expect(result).toEqual(["--exclude=CLAUDE.md", "--exclude=.rks/"]);
  });

  it("skips negation patterns", () => {
    const result = generateExcludeArgs({ exclude: ["CLAUDE.md", "!README.md"] });
    expect(result).toEqual(["--exclude=CLAUDE.md"]);
  });
});

// --- git archive arg construction ---

describe("git archive arg construction (include + exclude)", () => {
  it("exclude-only: no include args appended", () => {
    const excludeArgs = generateExcludeArgs({ exclude: ["CLAUDE.md"] });
    const includeArgs = generateIncludeArgs({ exclude: ["CLAUDE.md"] });
    const args = ["archive", "--format=tar", ...excludeArgs, "HEAD", ...includeArgs];
    expect(args).toContain("--exclude=CLAUDE.md");
    expect(args).not.toContain(expect.stringMatching(/^[^-]/));
    // HEAD is at index after --format=tar and --exclude flags
    const headIdx = args.indexOf("HEAD");
    expect(headIdx).toBeGreaterThan(args.indexOf("--format=tar"));
    expect(args.slice(headIdx + 1)).toHaveLength(0);
  });

  it("include-only: include paths appear after HEAD", () => {
    const excludeArgs = generateExcludeArgs({ include: ["notes/public.**"] });
    const includeArgs = generateIncludeArgs({ include: ["notes/public.**"] });
    const args = ["archive", "--format=tar", ...excludeArgs, "HEAD", ...includeArgs];
    const headIdx = args.indexOf("HEAD");
    expect(args.slice(headIdx + 1)).toEqual(["notes/public.**"]);
    expect(args.some(a => a.startsWith("--exclude="))).toBe(false);
  });

  it("include + exclude: exclude flags before HEAD, include paths after HEAD", () => {
    const profile = { exclude: ["CLAUDE.md", ".rks/"], include: ["notes/public.**", "packages/"] };
    const excludeArgs = generateExcludeArgs(profile);
    const includeArgs = generateIncludeArgs(profile);
    const args = ["archive", "--format=tar", ...excludeArgs, "HEAD", ...includeArgs];
    const headIdx = args.indexOf("HEAD");
    const beforeHead = args.slice(0, headIdx);
    const afterHead = args.slice(headIdx + 1);
    expect(beforeHead).toContain("--exclude=CLAUDE.md");
    expect(beforeHead).toContain("--exclude=.rks/");
    expect(afterHead).toEqual(["notes/public.**", "packages/"]);
  });
});
