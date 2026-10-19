/**
 * backlog.fix.refine-test-exemplar-selects-unrelated-file-with-secret-literal
 * add_test_exemplar relevance (whole-token segment match) and secret safety, driven through the
 * real runRefineApplyTool against on-disk temp projects.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { makeTempDir, writeFile, ensureDir } from "../helpers/tmp.mjs";
import { runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";
import { redactStringSecretsOnly } from "../../packages/telemetry/src/redact.mjs";

// Assembled at runtime: no secret-shaped literal in this source or in any note quoting it.
const FAKE_GH_TOKEN = "ghp" + "_" + "Ab3".repeat(12);
const SECRET_SHAPE = /\bgh[pousr]_[A-Za-z0-9]{16,}/;
const PROBLEM = "backlog.fix.exemplar-relevance";
const FALLBACK_HEADER_PREFIX = "### Test Exemplar: (framework fallback — ";
let root;

function medium(name, extra = "") {
  const cases = Array.from({ length: 20 }, (_, i) => `  it("${name} case ${i}", () => { expect(${i}).toBe(${i}); });`).join("\n");
  return `import { describe, it, expect } from "vitest";\n${extra}\ndescribe("${name}", () => {\n${cases}\n});\n`;
}
function small(name) {
  return `import { describe, it, expect } from "vitest";\ndescribe("${name}", () => { it("ok", () => expect(1).toBe(1)); });\n`;
}
function candidate(rel, content) {
  writeFile(path.join(root, "tests", "unit", rel), content);
}
function notePath() {
  return path.join(root, "notes", `${PROBLEM}.md`);
}
function writeStory(extraBody = "") {
  fs.writeFileSync(notePath(), `---\nid: "${PROBLEM}"\nstatus: not-implemented\ntargetFiles:\n  - path: "packages/rag/src/query.mjs"\n    op: "edit"\n  - path: "tests/unit/rag-new.test.mjs"\n    op: "create"\n---\n\n## Problem\n\nRAG change.\n${extraBody}`, "utf8");
}
// Text appended by refine-apply's history step (it is written last, after every body injection).
function historyText(note) {
  const i = note.indexOf("## Refinement History");
  expect(i).toBeGreaterThan(-1); // positive control: the history section was written
  return note.slice(i);
}
async function apply(editTargetDirs = ["packages/rag/src"]) {
  const res = await runRefineApplyTool({ projectRoot: root, problemId: PROBLEM, refinements: [{ type: "add_test_exemplar", editTargetDirs }] });
  return { res, entry: (res.applied || []).find((a) => a.type === "add_test_exemplar"), note: fs.readFileSync(notePath(), "utf8") };
}

beforeEach(() => {
  root = makeTempDir("refine_exemplar_relevance");
  ensureDir(path.join(root, "notes"));
  ensureDir(path.join(root, "tests", "unit"));
  ensureDir(path.join(root, "packages", "rag", "src"));
  writeFile(path.join(root, "packages", "rag", "src", "query.mjs"), "export const q = 1;\n");
  writeStory();
});
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("add_test_exemplar relevance", () => {
  it("a substring-only segment hit (rag in storage) does not select the file", async () => {
    candidate("telemetry-storage-redaction.test.mjs", medium("storage"));
    const size = fs.statSync(path.join(root, "tests/unit/telemetry-storage-redaction.test.mjs")).size;
    expect(size).toBeGreaterThan(500); // positive control: the size bonus is in play
    expect(size).toBeLessThan(8000);
    expect("telemetry-storage-redaction".includes("rag")).toBe(true); // positive control: the substring hit exists
    const { entry, note } = await apply();
    expect(note).not.toContain("### Test Exemplar: tests/unit/telemetry-storage-redaction.test.mjs");
    expect(entry.result).not.toContain("telemetry-storage-redaction");
  });

  it("a whole-token match wins over a medium-sized substring-only file", async () => {
    candidate("telemetry-storage-redaction.test.mjs", medium("storage"));
    candidate("rag-query-keyword-leg.test.mjs", small("rag"));
    const { res, note } = await apply();
    expect(res.ok).toBe(true);
    expect(note).toContain("### Test Exemplar: tests/unit/rag-query-keyword-leg.test.mjs");
  });

  it("a hyphenated or substring segment is matched only on token boundaries", async () => {
    candidate("observer-notes.test.mjs", medium("observer"));
    candidate("server-exec.test.mjs", small("server"));
    const { note } = await apply(["packages/mcp-rks/src/server"]);
    expect(note).toContain("### Test Exemplar: tests/unit/server-exec.test.mjs");
    expect(note).not.toContain("### Test Exemplar: tests/unit/observer-notes.test.mjs");
  });

  it("no token match: no arbitrary file is injected and the applied entry says which path ran", async () => {
    candidate("alpha.test.mjs", medium("alpha"));
    const { res, entry, note } = await apply();
    expect(res.ok).toBe(true);
    expect(note).toContain(FALLBACK_HEADER_PREFIX);
    expect(note).not.toContain("### Test Exemplar: tests/unit/alpha.test.mjs");
    expect(entry.result).not.toMatch(/^injected test exemplar from/);
    expect(entry.result).toMatch(/framework fallback/i);
  });

  it("a prior real-exemplar header does not suppress the fallback (dedup keyed to the fallback header)", async () => {
    writeStory("\n### Test Exemplar: tests/unit/old.test.mjs\n\nold body\n");
    candidate("alpha.test.mjs", medium("alpha"));
    const { res, note } = await apply();
    expect(res.ok).toBe(true);
    expect(note).toContain(FALLBACK_HEADER_PREFIX);
  });

  it("no token match applied twice: the second apply is a refine_noop, not a second injection", async () => {
    candidate("alpha.test.mjs", medium("alpha"));
    await apply();
    const before = fs.readFileSync(notePath(), "utf8");
    const { res, note } = await apply();
    expect(res.ok).toBe(false);
    expect(res.status).toBe("refine_noop");
    expect(note).toBe(before);
  });

  it("REGRESSION: a genuinely relevant real test is preferred over the fallback template", async () => {
    candidate("rag-query.test.mjs", medium("rag query"));
    const { res, entry, note } = await apply();
    expect(res.ok).toBe(true);
    expect(note).toContain("### Test Exemplar: tests/unit/rag-query.test.mjs");
    expect(note).not.toContain("framework fallback");
    expect(entry.result).toContain("tests/unit/rag-query.test.mjs");
  });
});

describe("add_test_exemplar secret safety", () => {
  it("a secret-shaped literal in the selected exemplar never reaches the note, and entry and history report it", async () => {
    candidate("rag-secret.test.mjs", medium("rag secret", `const TOKEN = "${FAKE_GH_TOKEN}";`));
    // positive control: the candidate on disk really holds the secret shape
    expect(fs.readFileSync(path.join(root, "tests/unit/rag-secret.test.mjs"), "utf8")).toMatch(SECRET_SHAPE);
    const { entry, note } = await apply();
    expect(note).not.toContain(FAKE_GH_TOKEN);
    expect(note).not.toMatch(SECRET_SHAPE);
    expect(entry.result).toMatch(/redact|exclud/i);
    expect(historyText(note)).toMatch(/redact|exclud/i);
  });

  it("a name=value secret the redactor changes is reported (claim decided by before/after comparison)", async () => {
    const plain = "plain" + "value" + "42";
    const line = "const sessionToken = " + JSON.stringify(plain) + ";";
    expect(redactStringSecretsOnly(line)).not.toBe(line); // positive control: the redactor changes this text
    candidate("rag-session.test.mjs", medium("rag session", line));
    const { entry, note } = await apply();
    expect(note).not.toContain(plain);
    expect(entry.result).toMatch(/redact|exclud/i);
    expect(historyText(note)).toMatch(/redact|exclud/i);
  });

  it("a clean exemplar is injected without a redaction claim in the entry or the history", async () => {
    candidate("rag-query.test.mjs", medium("rag query"));
    const onDisk = fs.readFileSync(path.join(root, "tests/unit/rag-query.test.mjs"), "utf8");
    expect(redactStringSecretsOnly(onDisk)).toBe(onDisk); // positive control: the redactor leaves it unchanged
    const { entry, note } = await apply();
    expect(entry.result).not.toMatch(/redact|exclud/i);
    expect(historyText(note)).not.toMatch(/redact|exclud/i);
  });
});
