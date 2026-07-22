/**
 * Contract tests for story-validator-v2.mjs (rks_validate_story)
 *
 * Tests the validateStory() function against synthetic story content
 * using temp files to avoid coupling to real backlog state.
 */
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import the module under test
const { validateStory } = await import("../src/server/story-validator-v2.mjs");

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function createTempProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-sv2-"));
  const notesDir = path.join(tmpDir, "notes");
  fs.mkdirSync(notesDir, { recursive: true });

  // Minimal .rks/project.json so loadThresholds doesn't error
  const rksDir = path.join(tmpDir, ".rks");
  fs.mkdirSync(rksDir, { recursive: true });
  fs.writeFileSync(
    path.join(rksDir, "project.json"),
    JSON.stringify({ id: "test-project", root: tmpDir })
  );

  return { tmpDir, notesDir };
}

function writeStory(notesDir, problemId, frontmatter, body) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map(i => `  - ${i}`).join("\n")}`;
      return `${k}: ${v}`;
    })
    .join("\n");

  const content = `---\n${fm}\n---\n\n${body}`;
  fs.writeFileSync(path.join(notesDir, `${problemId}.md`), content);
}

function cleanup(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ──────────────────────────────────────────
// Well-formed story body (high quality + completeness)
// ──────────────────────────────────────────

const GOOD_BODY = `
## Problem

The system lacks X capability, causing Y failures in production.

## Solution

Add a new module that handles X by integrating with the existing Z pipeline.

## Target Files

- src/server/new-module.mjs

## Acceptance Criteria

- [ ] New module returns correct output for valid input
- [ ] Error paths return structured error objects
- [ ] Integration test covers happy path and error path

## Telemetry

- emit \`module.create.complete\` on success

## Testing Requirements

- [ ] Unit test for core logic
- [ ] Error path test for invalid input

\`\`\`javascript
export function handleX(input) {
  return { ok: true, result: input };
}
\`\`\`

Related: [[backlog.epics.infrastructure]]
`;

// ──────────────────────────────────────────
// Test 1: Well-formed story returns ready=true with high scores
// ──────────────────────────────────────────
{
  const { tmpDir, notesDir } = createTempProject();

  // Create the target file so it "exists"
  const targetDir = path.join(tmpDir, "src", "server");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "new-module.mjs"), "// placeholder");

  writeStory(notesDir, "backlog.test.good-story", {
    phase: "ready",
    targetFiles: ["src/server/new-module.mjs"],
    testFile: "src/server/__tests__/new-module.test.mjs",
  }, GOOD_BODY);

  const result = await validateStory({
    projectId: "test-project",
    problemId: "backlog.test.good-story",
    projectRoot: tmpDir,
  });

  assert.strictEqual(result.ready, true, "Well-formed story should be ready");
  assert.strictEqual(result.problemId, "backlog.test.good-story");
  assert.ok(result.validated, "Ready result must have validated object");
  assert.ok(result.validated.frontmatter, "Must have frontmatter section");
  assert.ok(result.validated.body, "Must have body section");
  assert.ok(result.validated.body.qualityScore >= 0.7, `Quality score ${result.validated.body.qualityScore} should be >= 0.7`);
  assert.ok(result.validated.body.completenessScore >= 0.8, `Completeness score ${result.validated.body.completenessScore} should be >= 0.8`);
  assert.ok(result.validated.body.sections.problem, "Problem section should be detected");
  assert.ok(result.validated.body.sections.solution, "Solution section should be detected");
  assert.ok(result.validated.body.sections.acceptanceCriteria, "AC section should be detected");
  assert.ok(result.validated.body.sections.telemetry, "Telemetry section should be detected");
  assert.ok(result.validated.benchmark, "Must have benchmark section");
  assert.strictEqual(result.validated.frontmatter.phase, "ready");
  assert.ok(result.validated.frontmatter.acCount >= 3, "Should count AC checkboxes");

  console.log("✓ Test 1: Well-formed story returns ready=true with high scores");
  cleanup(tmpDir);
}

// ──────────────────────────────────────────
// Test 2: Missing story file returns ready=false
// ──────────────────────────────────────────
{
  const { tmpDir } = createTempProject();

  const result = await validateStory({
    projectId: "test-project",
    problemId: "backlog.test.nonexistent",
    projectRoot: tmpDir,
  });

  assert.strictEqual(result.ready, false, "Missing story should not be ready");
  assert.strictEqual(result.currentPhase, "not_found");
  assert.ok(result.gaps.length > 0, "Should have gaps");
  assert.strictEqual(result.gaps[0].field, "story");
  assert.strictEqual(result.gaps[0].status, "not_found");

  console.log("✓ Test 2: Missing story file returns ready=false with not_found gap");
  cleanup(tmpDir);
}

// ──────────────────────────────────────────
// Test 3: Draft phase story returns ready=false with phase gap
// ──────────────────────────────────────────
{
  const { tmpDir, notesDir } = createTempProject();

  const targetDir = path.join(tmpDir, "src");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "file.mjs"), "// placeholder");

  writeStory(notesDir, "backlog.test.draft-story", {
    phase: "draft",
    targetFiles: ["src/file.mjs"],
    testFile: "src/file.test.mjs",
  }, GOOD_BODY);

  const result = await validateStory({
    projectId: "test-project",
    problemId: "backlog.test.draft-story",
    projectRoot: tmpDir,
  });

  assert.strictEqual(result.ready, false, "Draft phase story should not be ready");
  const phaseGap = result.gaps.find(g => g.field === "phase");
  assert.ok(phaseGap, "Should have a phase gap");
  assert.strictEqual(phaseGap.status, "invalid");
  assert.strictEqual(phaseGap.current, "draft");

  console.log("✓ Test 3: Draft phase story returns ready=false with phase gap");
  cleanup(tmpDir);
}

// ──────────────────────────────────────────
// Test 4: Missing targetFiles returns ready=false
// ──────────────────────────────────────────
{
  const { tmpDir, notesDir } = createTempProject();

  const body = `
## Problem

Something needs fixing.

## Solution

Fix it.

## Acceptance Criteria

- [ ] It works

## Telemetry

- emit done

## Testing Requirements

- [ ] Test it works
- [ ] Test error path
`;

  writeStory(notesDir, "backlog.test.no-targets", {
    phase: "ready",
  }, body);

  const result = await validateStory({
    projectId: "test-project",
    problemId: "backlog.test.no-targets",
    projectRoot: tmpDir,
  });

  assert.strictEqual(result.ready, false, "Story without targets should not be ready");
  const targetGap = result.gaps.find(g => g.field === "targetFiles");
  assert.ok(targetGap, "Should have a targetFiles gap");
  assert.strictEqual(targetGap.status, "missing");

  console.log("✓ Test 4: Missing targetFiles returns ready=false");
  cleanup(tmpDir);
}

// ──────────────────────────────────────────
// Test 5: Too many AC for CREATE FILE story returns gap
// ──────────────────────────────────────────
{
  const { tmpDir, notesDir } = createTempProject();

  const body = `
## Problem

Need a brand new file.

## Solution

Create it.

// CREATE FILE: src/brand-new.mjs

## Target Files

- src/brand-new.mjs

## Acceptance Criteria

- [ ] AC one
- [ ] AC two
- [ ] AC three
- [ ] AC four
- [ ] AC five

## Telemetry

- emit done

## Testing Requirements

- [ ] Test error case
- [ ] Test happy path

\`\`\`javascript
export function brandNew() {}
\`\`\`

Related: [[backlog.epics.test]]
`;

  writeStory(notesDir, "backlog.test.too-many-ac", {
    phase: "ready",
    targetFiles: ["src/brand-new.mjs"],
    testFile: "src/brand-new.test.mjs",
  }, body);

  const result = await validateStory({
    projectId: "test-project",
    problemId: "backlog.test.too-many-ac",
    projectRoot: tmpDir,
  });

  const acGap = result.gaps.find(g => g.field === "acceptanceCriteria" && g.status === "exceeds_threshold");
  assert.ok(acGap, "Should flag AC count exceeding CREATE FILE threshold");
  assert.strictEqual(acGap.max, 4, "Default max for CREATE FILE should be 4");

  console.log("✓ Test 5: Too many AC for CREATE FILE story returns gap");
  cleanup(tmpDir);
}

// ──────────────────────────────────────────
// Test 6: Quality score components
// ──────────────────────────────────────────
{
  const { tmpDir, notesDir } = createTempProject();

  // Minimal story — no sections, no code blocks, has vague language
  const body = `
This story maybe needs some work. TBD on the details.
Possibly we should consider doing something.
`;

  const targetDir = path.join(tmpDir, "src");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "file.mjs"), "// placeholder");

  writeStory(notesDir, "backlog.test.low-quality", {
    phase: "ready",
    targetFiles: ["src/file.mjs"],
  }, body);

  const result = await validateStory({
    projectId: "test-project",
    problemId: "backlog.test.low-quality",
    projectRoot: tmpDir,
  });

  assert.strictEqual(result.ready, false, "Low quality story should not be ready");
  assert.ok(result.gaps.some(g => g.field === "quality"), "Should flag quality below threshold");

  // Quality score should be very low (no sections, vague language)
  const qualityGap = result.gaps.find(g => g.field === "quality");
  assert.ok(qualityGap.score < 0.3, `Quality score ${qualityGap.score} should be < 0.3 for minimal story`);

  console.log("✓ Test 6: Low quality story has low score and quality gap");
  cleanup(tmpDir);
}

// ──────────────────────────────────────────
// Test 7: Per-project thresholds override defaults
// ──────────────────────────────────────────
{
  const { tmpDir, notesDir } = createTempProject();

  // Write custom thresholds
  const projectJson = JSON.parse(fs.readFileSync(path.join(tmpDir, ".rks", "project.json"), "utf8"));
  projectJson.validation = {
    qualityThreshold: 0.3,
    completenessThreshold: 0.3,
    maxAcForCreateFile: 10,
    maxAcForEditFile: 12,
  };
  fs.writeFileSync(path.join(tmpDir, ".rks", "project.json"), JSON.stringify(projectJson));

  // A mediocre story that would fail default thresholds but pass lowered ones
  const body = `
## Problem

Something.

## Solution

Fix it.

## Acceptance Criteria

- [ ] It works

\`\`\`javascript
fix()
\`\`\`

Related: [[backlog.epics.test]]
`;

  const targetDir = path.join(tmpDir, "src");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "file.mjs"), "// placeholder");

  writeStory(notesDir, "backlog.test.low-threshold", {
    phase: "ready",
    targetFiles: ["src/file.mjs"],
    testFile: "src/file.test.mjs",
  }, body);

  const result = await validateStory({
    projectId: "test-project",
    problemId: "backlog.test.low-threshold",
    projectRoot: tmpDir,
  });

  // With lowered thresholds, this mediocre story should pass
  // (quality ~0.55 and completeness ~0.80 should both clear 0.3 thresholds)
  const hasQualityGap = result.gaps?.some(g => g.field === "quality");
  const hasCompletenessGap = result.gaps?.some(g => g.field === "completeness");

  // With threshold at 0.3, neither score should be flagged as below threshold
  assert.ok(!hasQualityGap, "Quality should not be flagged with lowered threshold");
  assert.ok(!hasCompletenessGap, "Completeness should not be flagged with lowered threshold");

  console.log("✓ Test 7: Per-project thresholds override defaults");
  cleanup(tmpDir);
}

// ──────────────────────────────────────────
// Test 8: RAG benchmark returns gracefully when unavailable
// ──────────────────────────────────────────
{
  const { tmpDir, notesDir } = createTempProject();

  const targetDir = path.join(tmpDir, "src", "server");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "new-module.mjs"), "// placeholder");

  writeStory(notesDir, "backlog.test.rag-test", {
    phase: "ready",
    targetFiles: ["src/server/new-module.mjs"],
    testFile: "src/server/new-module.test.mjs",
  }, GOOD_BODY);

  const result = await validateStory({
    projectId: "test-project",
    problemId: "backlog.test.rag-test",
    projectRoot: tmpDir,
  });

  // RAG won't be available in temp project — should degrade gracefully
  assert.ok(result.validated?.benchmark || result.benchmark, "Should have benchmark field");
  const benchmark = result.validated?.benchmark || result.benchmark;
  assert.ok(
    ["rag_unavailable", "no_data", "benchmark_available"].includes(benchmark.comparison),
    `Benchmark comparison should be a valid state, got: ${benchmark.comparison}`
  );

  console.log("✓ Test 8: RAG benchmark degrades gracefully when unavailable");
  cleanup(tmpDir);
}

// ──────────────────────────────────────────
// Test 9: Output contract shape — ready=true
// ──────────────────────────────────────────
{
  const { tmpDir, notesDir } = createTempProject();

  const targetDir = path.join(tmpDir, "src", "server");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "new-module.mjs"), "// placeholder");

  writeStory(notesDir, "backlog.test.contract", {
    phase: "ready",
    targetFiles: ["src/server/new-module.mjs"],
    testFile: "src/server/new-module.test.mjs",
  }, GOOD_BODY);

  const result = await validateStory({
    projectId: "test-project",
    problemId: "backlog.test.contract",
    projectRoot: tmpDir,
  });

  // Verify output contract shape
  assert.strictEqual(typeof result.problemId, "string");
  assert.strictEqual(typeof result.ready, "boolean");

  if (result.ready) {
    // Ready contract
    assert.ok(result.validated);
    assert.ok(result.validated.frontmatter);
    assert.ok(Array.isArray(result.validated.frontmatter.targetFiles));
    assert.strictEqual(typeof result.validated.frontmatter.phase, "string");
    assert.strictEqual(typeof result.validated.frontmatter.acCount, "number");
    assert.ok(result.validated.body);
    assert.strictEqual(typeof result.validated.body.qualityScore, "number");
    assert.strictEqual(typeof result.validated.body.completenessScore, "number");
    assert.strictEqual(typeof result.validated.body.sections, "object");
    assert.strictEqual(typeof result.validated.body.codeSnippetCount, "number");
    assert.ok(Array.isArray(result.validated.body.createFileDirectives));
    assert.ok(result.validated.benchmark);
  }

  console.log("✓ Test 9: Output contract shape verified for ready=true");
  cleanup(tmpDir);
}

// ──────────────────────────────────────────
// Test 10: Output contract shape — ready=false
// ──────────────────────────────────────────
{
  const { tmpDir, notesDir } = createTempProject();

  writeStory(notesDir, "backlog.test.contract-fail", {
    phase: "draft",
  }, "Just a stub.");

  const result = await validateStory({
    projectId: "test-project",
    problemId: "backlog.test.contract-fail",
    projectRoot: tmpDir,
  });

  // Not-ready contract
  assert.strictEqual(result.ready, false);
  assert.strictEqual(typeof result.problemId, "string");
  assert.strictEqual(typeof result.currentPhase, "string");
  assert.ok(Array.isArray(result.gaps));
  assert.ok(result.gaps.length > 0, "Should have at least one gap");
  assert.strictEqual(typeof result.suggestion, "string");
  assert.ok(result.benchmark);
  assert.ok(result.thresholds);
  assert.strictEqual(typeof result.thresholds.qualityThreshold, "number");
  assert.strictEqual(typeof result.thresholds.completenessThreshold, "number");

  // Each gap has required fields
  for (const gap of result.gaps) {
    assert.strictEqual(typeof gap.field, "string");
    assert.strictEqual(typeof gap.status, "string");
    assert.strictEqual(typeof gap.priority, "string");
  }

  console.log("✓ Test 10: Output contract shape verified for ready=false");
  cleanup(tmpDir);
}

console.log("\n✅ All 10 story-validator-v2 contract tests passed");

// Force clean exit — telemetry collector auto-flush may throw after temp dirs are cleaned up
process.exit(0);
