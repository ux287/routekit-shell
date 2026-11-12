import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

// We test validateStory via a minimal mock project on disk
// so we don't need a real RAG/telemetry setup.

vi.mock("../../packages/mcp-rks/src/shared/telemetry-collector.mjs", () => ({
  getTelemetryCollector: () => ({ emit: () => {} }),
}));

vi.mock("../../packages/mcp-rks/src/server/story-validator-v2.mjs", async (importOriginal) => {
  // We want the real module but with RAG benchmarking stubbed out
  const real = await importOriginal();
  return real;
});

// Patch runRagBenchmark to avoid real RAG calls
vi.mock("../../packages/mcp-rks/src/server/rag.mjs", () => ({
  default: { query: async () => [] },
  ragQuery: async () => [],
}));

import { validateStory } from "../../packages/mcp-rks/src/server/story-validator-v2.mjs";

function makeMinimalStory({ body = "", extraFrontmatter = "" } = {}) {
  return `---
id: "test.story"
title: "Test story"
status: "not-implemented"
phase: "ready"
testFile: "tests/unit/some.test.mjs"
targetFiles:
  - path: "src/foo.mjs"
    op: "edit"
    desc: "Edit foo with search replace block"
${extraFrontmatter}
---

## Problem
A problem exists.

## Solution
Do the thing.

## Acceptance Criteria
- [ ] The thing works

${body}
`;
}

async function runValidator(story, projectRoot) {
  const notesDir = path.join(projectRoot, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  const storyPath = path.join(notesDir, "test.story.md");
  fs.writeFileSync(storyPath, story);

  // Create a stub target file so "missing_create_directive" gap doesn't fire
  const srcDir = path.join(projectRoot, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "foo.mjs"), "export const foo = 1;\n");

  return validateStory({ projectId: "test", problemId: "test.story", projectRoot });
}

describe("validateStory — fenced @@SEARCH/@@REPLACE/@@END detection", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-validator-test-"));
  });

  it("returns formatErrors when @@SEARCH block is wrapped in code fence", async () => {
    const body = `## src/foo.mjs
\`\`\`
@@SEARCH
old code
@@REPLACE
new code
@@END
\`\`\`
`;
    const story = makeMinimalStory({ body });
    const result = await runValidator(story, tmpDir);
    expect(result.ready).toBe(false);
    expect(result.formatErrors).toBeDefined();
    expect(result.formatErrors.length).toBeGreaterThan(0);
    expect(result.formatErrors[0].type).toBe("fenced_at_markers");
    expect(result.formatErrors[0].message).toMatch(/must NOT be wrapped/i);
  });

  it("formatErrors message references correct format and reviewer mode impact", async () => {
    const body = `\`\`\`\n@@SEARCH\nfoo\n@@REPLACE\nbar\n@@END\n\`\`\`\n`;
    const story = makeMinimalStory({ body });
    const result = await runValidator(story, tmpDir);
    expect(result.formatErrors?.[0]?.message).toMatch(/@@SEARCH\/@@REPLACE\/@@END/);
    expect(result.formatErrors?.[0]?.message).toMatch(/reviewer mode/i);
  });

  it("returns formatErrors even when quality/completeness scores would pass", async () => {
    // Give it a well-formed body (high quality) but with a fenced @@SEARCH
    const body = `## Problem
Detailed explanation of the problem with enough text to score well on quality.

## Solution
A detailed solution description that covers all the necessary implementation details.

## Acceptance Criteria
- [ ] Criterion one
- [ ] Criterion two
- [ ] Criterion three

## src/foo.mjs
\`\`\`
@@SEARCH
export const foo = 1;
@@REPLACE
export const foo = 2;
@@END
\`\`\`
`;
    const story = makeMinimalStory({ body });
    const result = await runValidator(story, tmpDir);
    expect(result.ready).toBe(false);
    expect(result.formatErrors).toBeDefined();
    expect(result.formatErrors.length).toBeGreaterThan(0);
  });

  it("does NOT return formatErrors for bare (non-fenced) @@SEARCH blocks", async () => {
    const body = `## src/foo.mjs
@@SEARCH
export const foo = 1;
@@REPLACE
export const foo = 2;
@@END
`;
    const story = makeMinimalStory({ body });
    const result = await runValidator(story, tmpDir);
    // Should not have fenced format errors (may have other gaps, but not formatErrors)
    expect(result.formatErrors).toBeUndefined();
  });

  it("does NOT return formatErrors for story with no @@SEARCH markers at all", async () => {
    const body = `Normal body content without any markers.\n`;
    const story = makeMinimalStory({ body });
    const result = await runValidator(story, tmpDir);
    expect(result.formatErrors).toBeUndefined();
  });
});
