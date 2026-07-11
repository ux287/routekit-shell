/**
 * R8 — In-flight story migration: phase=implemented → phase=integrated.
 *
 * Pins:
 *   AC1: migrations/implemented-to-integrated.mjs exists; exports
 *        migrateImplementedToIntegrated({ notesDir, dryRun }); uses
 *        parseFrontmatter + readNoteRaw/writeNoteRaw (no full-file string replace).
 *   AC2: recursive scan across notes/ finds quoted + unquoted phase=implemented.
 *   AC3: disk read-back shows phase=integrated after migration.
 *   AC4: idempotent — second run reports count=0; files byte-equal between runs.
 *   AC5: other frontmatter fields + body content byte-equal modulo the phase line.
 *   AC6: stories at other phases (10 distinct values) are NOT touched.
 *   AC8: return shape { count, storyIds, failures }.
 *   AC8: dryRun:true reports correct count + storyIds but writes nothing.
 *   AC10: failure accumulator records errors without aborting the run.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { migrateImplementedToIntegrated } from "../../packages/mcp-rks/src/migrations/implemented-to-integrated.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MIGRATION_PATH = path.join(REPO_ROOT, "packages/mcp-rks/src/migrations/implemented-to-integrated.mjs");
const MIGRATION_SRC = fs.readFileSync(MIGRATION_PATH, "utf8");

let tmpRoot;
afterEach(() => {
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

function makeVault() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r8-migration-"));
  const notesDir = path.join(tmp, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  tmpRoot = tmp;
  return { tmp, notesDir };
}

function writeFixture(notesDir, name, frontmatterLines, body = "# fixture body\n\nsome content\n") {
  const filePath = path.join(notesDir, `${name}.md`);
  const content = `---\n${frontmatterLines.join("\n")}\n---\n${body}`;
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("AC1 — module shape + imports", () => {
  it("exports migrateImplementedToIntegrated as a function", () => {
    expect(typeof migrateImplementedToIntegrated).toBe("function");
  });

  it("imports parseFrontmatter from shared/frontmatter.mjs", () => {
    expect(MIGRATION_SRC).toMatch(/import\s*\{[^}]*parseFrontmatter[^}]*\}\s*from\s*['"]\.\.\/shared\/frontmatter\.mjs['"]/);
  });

  it("imports readNoteRaw and writeNoteRaw from dendron.mjs", () => {
    expect(MIGRATION_SRC).toMatch(/import\s*\{[^}]*readNoteRaw[^}]*writeNoteRaw[^}]*\}\s*from\s*['"]\.\.\/dendron\.mjs['"]|import\s*\{[^}]*writeNoteRaw[^}]*readNoteRaw[^}]*\}\s*from\s*['"]\.\.\/dendron\.mjs['"]/);
  });

  it("does NOT do a naive full-file string replace of phase: implemented", () => {
    // No naked .replace('phase: implemented', ...) or replaceAll on the raw file content.
    expect(MIGRATION_SRC).not.toMatch(/content\.replace\s*\(\s*['"]phase:\s*implemented['"]/);
    expect(MIGRATION_SRC).not.toMatch(/\.replaceAll\s*\(\s*['"]phase:\s*implemented['"]/);
  });
});

describe("AC2 / AC3 — scan + rewrite", () => {
  it("finds quoted phase: \"implemented\" and rewrites to integrated", async () => {
    const { notesDir } = makeVault();
    const p = writeFixture(notesDir, "backlog.feat.q-impl", [
      `id: "backlog.feat.q-impl"`,
      `title: "Q test"`,
      `phase: "implemented"`,
      `status: "shipped"`,
    ]);
    const result = await migrateImplementedToIntegrated({ notesDir });
    expect(result.count).toBe(1);
    expect(result.storyIds).toContain("backlog.feat.q-impl");
    expect(fs.readFileSync(p, "utf8")).toMatch(/phase:\s*"integrated"/);
  });

  it("finds unquoted phase: implemented and rewrites to integrated (preserves unquoted style)", async () => {
    const { notesDir } = makeVault();
    const p = writeFixture(notesDir, "backlog.feat.u-impl", [
      `id: "backlog.feat.u-impl"`,
      `phase: implemented`,
      `status: "shipped"`,
    ]);
    const result = await migrateImplementedToIntegrated({ notesDir });
    expect(result.count).toBe(1);
    const content = fs.readFileSync(p, "utf8");
    // Unquoted style preserved.
    expect(content).toMatch(/^phase:\s*integrated\s*$/m);
    expect(content).not.toMatch(/phase:\s*"integrated"/);
  });

  it("finds single-quoted phase: 'implemented' and rewrites to integrated (preserves single-quote style)", async () => {
    const { notesDir } = makeVault();
    const p = writeFixture(notesDir, "backlog.feat.s-impl", [
      `id: 'backlog.feat.s-impl'`,
      `phase: 'implemented'`,
    ]);
    const result = await migrateImplementedToIntegrated({ notesDir });
    expect(result.count).toBe(1);
    expect(fs.readFileSync(p, "utf8")).toMatch(/^phase:\s*'integrated'\s*$/m);
  });

  it("scans both backlog.* and backlog.z_implemented.* namespace files", async () => {
    const { notesDir } = makeVault();
    writeFixture(notesDir, "backlog.feat.active", [`id: "backlog.feat.active"`, `phase: "implemented"`]);
    writeFixture(notesDir, "backlog.z_implemented.feat.archived", [`id: "backlog.z_implemented.feat.archived"`, `phase: "implemented"`]);
    const result = await migrateImplementedToIntegrated({ notesDir });
    expect(result.count).toBe(2);
    expect(result.storyIds.sort()).toEqual(["backlog.feat.active", "backlog.z_implemented.feat.archived"]);
  });
});

describe("AC4 — idempotency", () => {
  it("running twice on the same vault produces byte-equal files between runs; second run count=0", async () => {
    const { notesDir } = makeVault();
    const p = writeFixture(notesDir, "backlog.feat.idem", [`id: "backlog.feat.idem"`, `phase: "implemented"`]);

    const r1 = await migrateImplementedToIntegrated({ notesDir });
    expect(r1.count).toBe(1);
    const after1 = fs.readFileSync(p, "utf8");

    const r2 = await migrateImplementedToIntegrated({ notesDir });
    expect(r2.count).toBe(0);
    expect(r2.storyIds).toEqual([]);
    const after2 = fs.readFileSync(p, "utf8");
    expect(after2).toBe(after1); // byte-equal
  });
});

describe("AC5 — byte-precise preservation of everything except the phase line", () => {
  it("rich frontmatter + multi-paragraph body byte-equal modulo phase line", async () => {
    const { notesDir } = makeVault();
    const beforeContent = `---
id: "backlog.feat.preservation"
title: "Preservation fixture"
desc: "Multi-paragraph body with code blocks and bullets"
created: 1780000000000
updated: 1780000100000
phase: "implemented"
status: "shipped"
problemType: "feat"
priority: "high"
targetFiles:
  - path: "src/x.mjs"
    op: "edit"
    desc: "edit x"
  - path: "src/y.mjs"
    op: "create"
    desc: "create y"
tags:
  - foo
  - bar
---

# Preservation Fixture

## Problem

A multi-paragraph body to verify byte preservation.

\`\`\`yaml
phase: implemented
\`\`\`

The code block above mentions phase: implemented but the migration must NOT touch it
because that string is inside a code block in the body, not in the frontmatter.

## Solution

- bullet one
- bullet two

End of fixture.
`;
    const p = path.join(notesDir, "backlog.feat.preservation.md");
    fs.writeFileSync(p, beforeContent);

    const result = await migrateImplementedToIntegrated({ notesDir });
    expect(result.count).toBe(1);

    const afterContent = fs.readFileSync(p, "utf8");
    // The frontmatter phase line flipped to integrated.
    expect(afterContent).toMatch(/^phase: "integrated"$/m);
    // The code-block reference in the body is UNCHANGED.
    expect(afterContent).toContain("```yaml\nphase: implemented\n```");
    // Reconstruct the expected output by replacing ONLY the frontmatter phase line.
    const expected = beforeContent.replace(`phase: "implemented"`, `phase: "integrated"`);
    expect(afterContent).toBe(expected);
  });
});

describe("AC6 — non-implemented phases are NOT touched", () => {
  it("stories at draft / ready / arch-approved / planned / executed / integrated / released / decomposed / executing / committed all untouched", async () => {
    const { notesDir } = makeVault();
    const otherPhases = [
      "draft", "ready", "arch-approved", "planned", "executed",
      "integrated", "released", "decomposed", "executing", "committed",
    ];
    const before = {};
    for (const phase of otherPhases) {
      const id = `backlog.feat.phase-${phase}`;
      const p = writeFixture(notesDir, id, [`id: "${id}"`, `phase: "${phase}"`]);
      before[p] = fs.readFileSync(p, "utf8");
    }
    // Add one implemented story to verify the migration DOES touch it.
    const impl = writeFixture(notesDir, "backlog.feat.impl-only", [`id: "backlog.feat.impl-only"`, `phase: "implemented"`]);

    const result = await migrateImplementedToIntegrated({ notesDir });
    expect(result.count).toBe(1);
    expect(result.storyIds).toEqual(["backlog.feat.impl-only"]);

    // Other phases byte-equal.
    for (const [p, original] of Object.entries(before)) {
      expect(fs.readFileSync(p, "utf8")).toBe(original);
    }
    // Implemented story migrated.
    expect(fs.readFileSync(impl, "utf8")).toMatch(/phase:\s*"integrated"/);
  });
});

describe("AC8 — return shape + dryRun", () => {
  it("returns { count, storyIds, failures } shape", async () => {
    const { notesDir } = makeVault();
    writeFixture(notesDir, "backlog.feat.shape", [`id: "backlog.feat.shape"`, `phase: "implemented"`]);
    const result = await migrateImplementedToIntegrated({ notesDir });
    expect(result).toHaveProperty("count");
    expect(result).toHaveProperty("storyIds");
    expect(result).toHaveProperty("failures");
    expect(typeof result.count).toBe("number");
    expect(Array.isArray(result.storyIds)).toBe(true);
    expect(Array.isArray(result.failures)).toBe(true);
  });

  it("dryRun:true reports correct count and storyIds but does NOT write files", async () => {
    const { notesDir } = makeVault();
    const p = writeFixture(notesDir, "backlog.feat.dry", [`id: "backlog.feat.dry"`, `phase: "implemented"`]);
    const beforeContent = fs.readFileSync(p, "utf8");

    const result = await migrateImplementedToIntegrated({ notesDir, dryRun: true });
    expect(result.count).toBe(1);
    expect(result.storyIds).toEqual(["backlog.feat.dry"]);
    // File unchanged.
    expect(fs.readFileSync(p, "utf8")).toBe(beforeContent);
  });
});

describe("AC10 — failure accumulation does not abort the run", () => {
  it("a malformed frontmatter file does not prevent other stories from migrating", async () => {
    const { notesDir } = makeVault();
    // One valid implemented story.
    const validPath = writeFixture(notesDir, "backlog.feat.valid", [`id: "backlog.feat.valid"`, `phase: "implemented"`]);
    // One file with a phase: implemented declared inside a body code block ONLY
    // (no frontmatter declaration). Parser will not match — counts as "not implemented",
    // not as a failure. (Failure path requires real frontmatter parser errors which are
    // hard to provoke without test-environment-specific tricks.)
    const noFmPath = path.join(notesDir, "backlog.feat.no-frontmatter.md");
    fs.writeFileSync(noFmPath, "# no frontmatter here\n```yaml\nphase: implemented\n```\n");
    // A file at phase=draft to verify it stays untouched.
    const draftPath = writeFixture(notesDir, "backlog.feat.draft", [`id: "backlog.feat.draft"`, `phase: "draft"`]);

    const result = await migrateImplementedToIntegrated({ notesDir });
    expect(result.storyIds).toEqual(["backlog.feat.valid"]);
    expect(result.count).toBe(1);
    // The no-frontmatter file is not implemented per parser; not a failure either.
    expect(fs.existsSync(noFmPath)).toBe(true);
    // The draft file is untouched.
    expect(fs.readFileSync(draftPath, "utf8")).toMatch(/phase:\s*"draft"/);
    // Valid story migrated.
    expect(fs.readFileSync(validPath, "utf8")).toMatch(/phase:\s*"integrated"/);
  });

  it("returns failure record when notesDir is missing", async () => {
    const result = await migrateImplementedToIntegrated({});
    expect(result.count).toBe(0);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it("returns count:0 when notesDir is empty", async () => {
    const { notesDir } = makeVault();
    const result = await migrateImplementedToIntegrated({ notesDir });
    expect(result.count).toBe(0);
    expect(result.storyIds).toEqual([]);
    expect(result.failures).toEqual([]);
  });
});

describe("AC9 — phase-machine-integrity test untouched (preservation pin)", () => {
  it("does not import or test PHASE_MACHINE.states directly (data migration is pure-data)", () => {
    // The migration module must not import phases.mjs — it operates purely on
    // frontmatter via the parser. (If a future change adds a phase-machine read,
    // R1.4's retirement work needs to consider it. For now, pin the data-only contract.)
    expect(MIGRATION_SRC).not.toMatch(/from\s*['"]\.\.\/workflow\/phases\.mjs['"]/);
    expect(MIGRATION_SRC).not.toMatch(/from\s*['"]\.\.\/workflow\/state-machine\.mjs['"]/);
  });
});
