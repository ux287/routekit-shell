import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.resolve(__dirname, "../../.rks/prompts", f), "utf8");
const QA = read("governor-qa.md");
const ARCH = read("governor-arch.md");

// The QA requirementCoverage step: from its field marker to the next phase write.
function qaCoverageStep() {
  const start = QA.indexOf("field: 'requirementCoverage'");
  if (start < 0) return "";
  const end = QA.indexOf("field: 'phase'", start);
  return end < 0 ? QA.slice(start) : QA.slice(start, end);
}

const paragraphs = (src) => src.split(/\n\s*\n/);

describe("governor-qa.md — requirementCoverage write", () => {
  it("Path 2 has a dendron_update_field step for field requirementCoverage between the testRequirements and phase writes", () => {
    const callLine = QA.split("\n").find(
      (l) => l.includes("dendron_update_field({") && l.includes("field: 'requirementCoverage'"),
    );
    expect(callLine, "no dendron_update_field call for requirementCoverage").toBeTruthy();
    const at = QA.indexOf(callLine);
    expect(at).toBeGreaterThan(QA.indexOf("field: 'testRequirements'"));
    expect(at).toBeLessThan(QA.indexOf("field: 'phase'"));
  });

  it("the step value is an array of { index, testFile, path } objects with 0-based indices and describe > title paths", () => {
    const step = qaCoverageStep();
    expect(step).toContain("{ index, testFile, path }");
    expect(step).toContain("0-based");
    expect(step).toContain("describe > title");
  });

  it("the step maps only requirements that do not carry the [process] prefix", () => {
    const step = qaCoverageStep();
    expect(step).toContain("[process] ");
    expect(step).toMatch(/non-process|not carry/i);
  });

  it("the step is followed by a dendron_read_note read-back", () => {
    expect(qaCoverageStep()).toContain("dendron_read_note");
  });
});

describe("governor-arch.md — structured array values", () => {
  it("drops the unconditional array-of-objects prohibition", () => {
    expect(ARCH).not.toContain(
      "NEVER pass an object or an array of objects as a `dendron_update_field` value.",
    );
  });

  it("sanctions a JSON array value for targetFiles and requirementCoverage with a read-back", () => {
    const p = paragraphs(ARCH).find(
      (x) => x.includes("targetFiles") && x.includes("requirementCoverage") && x.includes("dendron_update_field"),
    );
    expect(p, "no paragraph sanctions the structured array write").toBeTruthy();
    expect(p).toMatch(/array/i);
    expect(ARCH).toContain("dendron_read_note");
  });

  it("still forbids object values for verdict and narrative fields", () => {
    expect(ARCH).toMatch(/verdict/i);
    expect(ARCH).toMatch(/narrative/i);
    expect(ARCH).toContain("50KB");
  });

  it("raises a finding when a story with non-process testRequirements lacks a frontmatter requirementCoverage map", () => {
    const p = paragraphs(ARCH).find(
      (x) => x.includes("requirementCoverage") && /finding/i.test(x) && /non-process/i.test(x),
    );
    expect(p, "no paragraph directs a finding for a missing map").toBeTruthy();
  });

  it("does not direct the map into the note body", () => {
    expect(ARCH).not.toContain("## Requirement Coverage");
  });
});

describe("governor-qa.md and governor-arch.md — same write", () => {
  it("both prompts name field requirementCoverage, dendron_update_field and { index, testFile, path }", () => {
    for (const [name, src] of [["governor-qa.md", QA], ["governor-arch.md", ARCH]]) {
      expect(src, name).toContain("requirementCoverage");
      expect(src, name).toContain("dendron_update_field");
      expect(src, name).toContain("{ index, testFile, path }");
    }
  });
});
