import assert from "node:assert";
import { buildNoteDrivenSteps } from "../src/server.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

function loadNote(relPath) {
  const abs = path.join(repoRoot, relPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Fixture note missing: ${abs}`);
  }
  return fs.readFileSync(abs, "utf8");
}

function titles(steps) {
  return steps.map((s) => s.title);
}

function nonEmptyContentSteps(steps) {
  return steps.filter((s) => s.action === "edit_file");
}

function hasActionable(steps) {
  return steps.some((s) => s.action && s.action !== "note");
}

function assertValidSteps(steps) {
  assert(steps.length > 1, "Expected multiple steps");
  assert(hasActionable(steps), "Expected at least one actionable step");
  steps.forEach((s) => {
    if (s.action === "note") return;
    assert(s.path && !s.path.includes("\n") && s.path.trim().length > 0, "Path must be well-formed");
    if (s.action === "edit_file") {
      const abs = path.join(repoRoot, s.path);
      assert(fs.existsSync(abs), `edit_file target must exist: ${s.path}`);
    }
    if (s.action === "edit_file" || s.action === "create_file") {
      assert(s.content && s.content.trim().length > 0, "File actions must have non-empty content");
    }
  });
}

// Fixture A: numbered list under Implementation Tasks
{
  const note = `
# Implementation Tasks
1. Update buildNoteDrivenSteps to handle numbered lists.
2. Add nested bullet parsing support.
`;
  const steps = buildNoteDrivenSteps(note);
  assert(steps.length >= 2, "Expected multiple steps for numbered list");
  assert(titles(steps)[0].toLowerCase().includes("numbered"), "First step should mention numbered lists");
  nonEmptyContentSteps(steps).forEach((s) => {
    assert(s.content && s.content.trim().length > 0, "edit_file actions must have non-empty content");
  });
}

// Fixture B: nested bullets under Constraints
{
  const note = `
## Constraints
- Parent item
  - Child item A
  - Child item B
`;
  const steps = buildNoteDrivenSteps(note);
  assert(steps.length >= 3, "Expected parent + nested bullets as separate steps");
  nonEmptyContentSteps(steps).forEach((s) => {
    assert(s.content && s.content.trim().length > 0, "edit_file actions must have non-empty content");
  });
}

// Fixture C: fallback when no headings
{
  const note = `
This note has no recognized headings or bullet formats.
`;
  const steps = buildNoteDrivenSteps(note);
  assert.strictEqual(steps.length, 1, "Fallback should produce exactly one step");
  assert.strictEqual(steps[0].title, "Review problem note", "Fallback step should be review note");
}

// Fixture D: phase-2 backlog note (golden)
{
  const note = loadNote("notes/backlog.planner.requirements-flexibility.phase-2.md");
  const steps = buildNoteDrivenSteps(note);
  assertValidSteps(steps);
}

// Fixture E: phase-3 backlog note (golden)
{
  const note = loadNote("notes/backlog.planner.requirements-flexibility.phase-3.md");
  const steps = buildNoteDrivenSteps(note);
  assertValidSteps(steps);
}
