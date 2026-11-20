#!/usr/bin/env node
/**
 * Dendron MCP Smoke Test
 *
 * Tests the ACTUAL dendron module functions to catch real bugs.
 * Uses a temp directory to avoid affecting real notes.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readNoteRaw,
  writeNoteRaw,
  frontmatterDefaults,
  formatWithFrontmatter,
  parseFrontmatter,
  validateNoteFrontmatter,
  mergeTemplateWithGenerated,
} from "../../packages/mcp-dendron/src/dendron.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`SMOKE TEST FAILED: ${message}`);
  }
}

async function run() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "dendron-smoke-"));
  const testId = `smoke-test-${Date.now()}`;
  const testPath = path.join(tmpBase, `${testId}.md`);
  const testContent = "This is smoke test content.\n\nWith multiple paragraphs.";

  console.log("[dendron-smoke] Testing actual dendron module functions...");
  console.log(`[dendron-smoke] Temp dir: ${tmpBase}`);

  try {
    // Test 1: frontmatterDefaults generates correct structure
    console.log("[dendron-smoke] Test 1: frontmatterDefaults...");
    const fm = frontmatterDefaults({ id: testId, title: "Smoke Test", desc: "Testing" });
    assert(fm.id === testId, `ID mismatch: expected ${testId}, got ${fm.id}`);
    assert(fm.title === "Smoke Test", "Title not set correctly");
    assert(typeof fm.created === "number", "Created should be timestamp");
    assert(typeof fm.updated === "number", "Updated should be timestamp");
    console.log("[dendron-smoke] ✓ frontmatterDefaults works");

    // Test 2: formatWithFrontmatter produces valid output
    console.log("[dendron-smoke] Test 2: formatWithFrontmatter...");
    const formatted = formatWithFrontmatter(fm, testContent);
    assert(formatted.startsWith("---\n"), "Should start with ---");
    const delimiters = (formatted.match(/^---$/gm) || []).length;
    assert(delimiters === 2, `Expected 2 delimiters, got ${delimiters}`);
    console.log("[dendron-smoke] ✓ formatWithFrontmatter works");

    // Test 3: writeNoteRaw + readNoteRaw roundtrip
    console.log("[dendron-smoke] Test 3: write/read roundtrip...");
    writeNoteRaw(testPath, formatted);
    assert(fs.existsSync(testPath), "File should exist after write");
    const readBack = readNoteRaw(testPath);
    assert(readBack === formatted, "Read content should match written content");
    console.log("[dendron-smoke] ✓ write/read roundtrip works");

    // Test 4: parseFrontmatter extracts data correctly
    console.log("[dendron-smoke] Test 4: parseFrontmatter...");
    const parsed = parseFrontmatter(readBack);
    assert(parsed.data.id === testId, "Parsed ID should match");
    assert(parsed.content.trim() === testContent, "Parsed body should match");
    console.log("[dendron-smoke] ✓ parseFrontmatter works");

    // Test 5: validateNoteFrontmatter catches issues
    console.log("[dendron-smoke] Test 5: validateNoteFrontmatter...");
    const validation = validateNoteFrontmatter(readBack);
    assert(validation.ok === true, `Validation should pass: ${JSON.stringify(validation.issues)}`);

    // Test invalid content
    const invalidValidation = validateNoteFrontmatter("no frontmatter here");
    assert(invalidValidation.ok === false, "Should fail for missing frontmatter");
    console.log("[dendron-smoke] ✓ validateNoteFrontmatter works");

    // Test 6: mergeTemplateWithGenerated (the bug we just fixed!)
    console.log("[dendron-smoke] Test 6: mergeTemplateWithGenerated...");
    const generated = frontmatterDefaults({ id: "test-merge", title: "Merge Test" });
    const templateParsed = { data: { tags: ["template"] }, content: "Template body content" };

    // Case A: content provided - should use content, NOT append template
    const resultA = mergeTemplateWithGenerated({
      generated,
      templateParsed,
      content: "My custom content",
      id: "test-merge"
    });
    assert(resultA.body === "My custom content", `Body should be custom content, not appended. Got: "${resultA.body}"`);
    assert(!resultA.body.includes("Template body"), "Should NOT include template body when content provided");

    // Case B: no content - should use template body
    const resultB = mergeTemplateWithGenerated({
      generated,
      templateParsed,
      content: "",
      id: "test-merge"
    });
    assert(resultB.body === "Template body content", `Body should be template content. Got: "${resultB.body}"`);
    console.log("[dendron-smoke] ✓ mergeTemplateWithGenerated works (no duplicate content!)");

    // Test 7: Full roundtrip with template merge
    console.log("[dendron-smoke] Test 7: Full roundtrip with template...");
    const fullTest = mergeTemplateWithGenerated({
      generated: frontmatterDefaults({ id: "full-test", title: "Full Test" }),
      templateParsed: { data: { priority: "high" }, content: "Default template" },
      content: "Actual content",
      id: "full-test"
    });
    const fullFormatted = formatWithFrontmatter(fullTest.merged, fullTest.body);
    const fullDelimiters = (fullFormatted.match(/^---$/gm) || []).length;
    assert(fullDelimiters === 2, `Full roundtrip: expected 2 delimiters, got ${fullDelimiters}`);
    assert(fullFormatted.includes("Actual content"), "Should contain provided content");
    assert(!fullFormatted.includes("Default template"), "Should NOT contain template body");
    console.log("[dendron-smoke] ✓ Full roundtrip works");

    // Cleanup
    fs.rmSync(tmpBase, { recursive: true, force: true });
    console.log("[dendron-smoke] ✓ Cleanup complete");
    console.log("[dendron-smoke] ========================================");
    console.log("[dendron-smoke] ALL TESTS PASSED - dendron module is healthy");
    console.log("[dendron-smoke] ========================================");

  } catch (error) {
    // Cleanup on failure
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
    console.error(`[dendron-smoke] ✗ ${error.message}`);
    process.exitCode = 1;
  }
}

run();
