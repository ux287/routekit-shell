// backlog.fix.exec-tests-exhausted-steps-applied-length
// The tests_exhausted ctx.terminalDetail in exec.mjs must report stepsApplied as
// the numeric count (the same value the following return carries), never
// stepsApplied.length on a number (which is undefined).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");

const DETAIL_OPEN = "ctx.terminalDetail = ";

function locate(src) {
  const idxReason = src.indexOf('reason: "tests_exhausted"');
  expect(idxReason).toBeGreaterThan(-1);
  const detailStart = src.lastIndexOf(DETAIL_OPEN + "{", idxReason);
  expect(detailStart).toBeGreaterThan(-1);
  // the located opener must belong to the same object literal as the reason
  expect(src.slice(detailStart, idxReason)).not.toContain("};");
  const detailEnd = src.indexOf("};", idxReason);
  expect(detailEnd).toBeGreaterThan(idxReason);
  const returnStart = src.indexOf("return {", idxReason);
  expect(returnStart).toBeGreaterThan(detailEnd);
  const returnEnd = src.indexOf("directive:", returnStart);
  expect(returnEnd).toBeGreaterThan(returnStart);
  return {
    idxReason,
    spanText: src.slice(detailStart, returnEnd),
    detailText: src.slice(detailStart, detailEnd + 2),
    objectLiteral: src.slice(detailStart + DETAIL_OPEN.length, detailEnd + 1),
    returnText: src.slice(returnStart, returnEnd),
    returnStart,
    detailEnd,
  };
}

describe("exec tests_exhausted terminalDetail stepsApplied", () => {
  it("the tests_exhausted terminalDetail evaluates stepsApplied to the numeric count, not undefined", () => {
    const { objectLiteral } = locate(EXEC_SRC);
    // eslint-disable-next-line no-new-func
    const build = new Function("stepsApplied", "attemptNumber", "execStartMs", `return (${objectLiteral});`);
    const detail = build(5, 3, Date.now());
    expect(detail.reason).toBe("tests_exhausted");
    expect(typeof detail.stepsApplied).toBe("number");
    expect(detail.stepsApplied).toBe(5);
  });

  it("the tests_exhausted terminalDetail does not read .length on stepsApplied", () => {
    const { detailText } = locate(EXEC_SRC);
    expect(detailText).not.toMatch(/stepsApplied\.length/);
    expect(detailText).toMatch(/\bstepsApplied\b/);
  });

  it("the tests_exhausted return carries the same stepsApplied number", () => {
    const { returnText } = locate(EXEC_SRC);
    expect(returnText).toMatch(/^\s*stepsApplied,\s*$/m);
    expect(returnText).not.toMatch(/stepsApplied\.length/);
  });

  it("the tests_exhausted terminalDetail-through-return span contains no stepsApplied.length", () => {
    // Scoped to the tests_exhausted block only: no whole-file counts, so sibling
    // edits elsewhere in exec.mjs cannot turn this test red.
    const { spanText } = locate(EXEC_SRC);
    expect(spanText).toContain('reason: "tests_exhausted"');
    expect(spanText).not.toContain("stepsApplied.length");
  });

  it("the reason tests_exhausted literal stays ahead of the tests-exhausted return", () => {
    const { idxReason, returnStart, detailEnd } = locate(EXEC_SRC);
    expect(idxReason).toBeLessThan(detailEnd);
    expect(detailEnd).toBeLessThan(returnStart);
  });
});
