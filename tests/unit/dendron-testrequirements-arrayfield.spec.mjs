import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parseFrontmatter, updateField, ARRAY_FIELDS } from "../../packages/mcp-rks/src/dendron.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Root-cause (write-path) half of the refine testRequirements crash fix:
// `testRequirements` must be in ARRAY_FIELDS so dendron_update_field always
// normalizes it to a YAML array on write — it can never be persisted as a bare
// JSON string, which is what fed the "testRequirements.filter is not a function"
// crash in refine. Follows the updateField test pattern in dendron-tools.spec.mjs.
describe("dendron ARRAY_FIELDS — testRequirements write-path normalization", () => {
  it("testRequirements is a member of ARRAY_FIELDS", () => {
    expect(ARRAY_FIELDS.has("testRequirements")).toBe(true);
  });

  describe("updateField normalizes testRequirements to a YAML array on write", () => {
    const TMP_DIR = join(__dirname, "../.tmp/dendron-testreq-" + Date.now());
    const writeNote = () =>
      writeFileSync(join(TMP_DIR, "story.md"), `---\nid: backlog.test.story\ntitle: Test\n---\n\nBody`);
    const readBack = () => parseFrontmatter(readFileSync(join(TMP_DIR, "story.md"), "utf8")).data;

    beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
    afterEach(() => {
      if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
    });

    it("a JSON-array STRING value persists as a YAML array, not a string", () => {
      writeNote();
      updateField(TMP_DIR, "story", "testRequirements", '["req one","req two"]');
      const data = readBack();
      expect(Array.isArray(data.testRequirements)).toBe(true);
      expect(data.testRequirements).toEqual(["req one", "req two"]);
    });

    it("a comma-free single string becomes a one-element array", () => {
      writeNote();
      updateField(TMP_DIR, "story", "testRequirements", "the only requirement");
      const data = readBack();
      expect(Array.isArray(data.testRequirements)).toBe(true);
      expect(data.testRequirements).toEqual(["the only requirement"]);
    });

    it("an array input round-trips as an array", () => {
      writeNote();
      updateField(TMP_DIR, "story", "testRequirements", ["a", "b", "c"]);
      const data = readBack();
      expect(Array.isArray(data.testRequirements)).toBe(true);
      expect(data.testRequirements).toEqual(["a", "b", "c"]);
    });
  });
});
