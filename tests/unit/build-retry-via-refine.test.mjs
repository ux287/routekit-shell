import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = process.cwd();

function readPrompt(filename) {
  return fs.readFileSync(path.join(PROJECT_ROOT, ".rks", "prompts", filename), "utf8");
}

function readClaudeMd() {
  return fs.readFileSync(path.join(PROJECT_ROOT, "CLAUDE.md"), "utf8");
}

describe("governor-build.md — refine-retry loop", () => {
  const prompt = readPrompt("governor-build.md");

  it("contains a refine-retry loop after exec test failure", () => {
    expect(prompt).toContain("Refine-retry loop");
    expect(prompt).toContain("test_failed");
  });

  it("calls rks_refine with trigger test_failed before retrying", () => {
    expect(prompt).toContain("rks_refine");
    expect(prompt).toContain("trigger: 'test_failed'");
  });

  it("calls rks_refine_apply after rks_refine returns suggestions", () => {
    expect(prompt).toContain("rks_refine_apply");
    // refine_apply should come after refine in the retry loop
    const refineIdx = prompt.indexOf("step 6a");
    const applyIdx = prompt.indexOf("rks_refine_apply", refineIdx);
    expect(applyIdx).toBeGreaterThan(refineIdx);
  });

  it("re-plans and re-executes after applying refinements", () => {
    // After refine_apply, should go back to plan -> plan_review -> exec
    const retrySection = prompt.slice(prompt.indexOf("Refine-retry loop"));
    expect(retrySection).toContain("rks_plan");
    expect(retrySection).toContain("rks_plan_review");
    expect(retrySection).toContain("re-exec");
  });

  it("caps retry budget at max 2 attempts", () => {
    expect(prompt).toContain("max 2");
    expect(prompt).toContain("2 failed refine-retry attempts");
  });

  it("still returns failed with testsFailed after exhausting retries", () => {
    const rulesSection = prompt.slice(prompt.indexOf("## Rules"));
    expect(rulesSection).toContain("testsFailed: true");
    expect(rulesSection).toContain("partialDiffPath");
    expect(rulesSection).toContain("refinementSuggestions");
    expect(rulesSection).toContain("attempts");
  });

  it("includes partialDiffPath, refinementSuggestions, and attempts in failure return", () => {
    expect(prompt).toContain("partialDiffPath");
    expect(prompt).toContain("refinementSuggestions");
    expect(prompt).toContain("attempts");
  });
});

describe("CLAUDE.md — Dispatcher failure handling", () => {
  const claudeMd = readClaudeMd();

  it("does NOT instruct spawning a new PO Governor on build failure", () => {
    // Extract the testsFailed section
    const failedIdx = claudeMd.indexOf("testsFailed: true");
    const nextBullet = claudeMd.indexOf("\n-", failedIdx + 1);
    const failedSection = claudeMd.slice(failedIdx, nextBullet > -1 ? nextBullet : undefined);

    // Should not instruct launching PO — only mention it in a prohibition
    expect(failedSection).toContain("Do NOT");
    expect(failedSection).not.toContain("Launch PO Governor");
    expect(failedSection).not.toContain("governor-po");
    expect(failedSection).not.toContain("Step 1");
  });

  it("instructs waiting for user direction on test failure", () => {
    const failedIdx = claudeMd.indexOf("testsFailed: true");
    const nextBullet = claudeMd.indexOf("\n-", failedIdx + 1);
    const failedSection = claudeMd.slice(failedIdx, nextBullet > -1 ? nextBullet : undefined);

    expect(failedSection).toContain("Wait for user direction");
  });

  it("explicitly prohibits auto-creating stories when a build fails", () => {
    const failedIdx = claudeMd.indexOf("testsFailed: true");
    const nextBullet = claudeMd.indexOf("\n-", failedIdx + 1);
    const failedSection = claudeMd.slice(failedIdx, nextBullet > -1 ? nextBullet : undefined);

    expect(failedSection).toContain("Do NOT create a new story");
  });

  it("generic failure handler also blocks auto-creation", () => {
    const genericIdx = claudeMd.indexOf("Any Governor returns `failed`");
    const nextSection = claudeMd.indexOf("\n\n", genericIdx);
    const genericSection = claudeMd.slice(genericIdx, nextSection > -1 ? nextSection : undefined);

    expect(genericSection).toContain("Do NOT auto-create replacement stories");
  });

  it("notes that Build Governor already retried internally", () => {
    const failedIdx = claudeMd.indexOf("testsFailed: true");
    const nextBullet = claudeMd.indexOf("\n-", failedIdx + 1);
    const failedSection = claudeMd.slice(failedIdx, nextBullet > -1 ? nextBullet : undefined);

    expect(failedSection).toContain("already retried via refine");
  });
});
