import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptPath = path.resolve(__dirname, "../../.rks/prompts/governor-arch.md");
const content = fs.readFileSync(promptPath, "utf8");

describe("governor-arch.md — structural requirements", () => {
  it("file exists at .rks/prompts/governor-arch.md", () => {
    expect(fs.existsSync(promptPath)).toBe(true);
  });

  it("contains __PROJECT_ID__ substitution variable", () => {
    expect(content).toContain("__PROJECT_ID__");
  });

  it("contains __STORY_IDS__ substitution variable", () => {
    expect(content).toContain("__STORY_IDS__");
  });

  it("does NOT contain __PROBLEM_ID__ (single-story var replaced by batch var)", () => {
    expect(content).not.toContain("__PROBLEM_ID__");
  });

  it("calls rks_governor_init with no problemId (open flow)", () => {
    expect(content).toMatch(/rks_governor_init\(\{[^}]*projectId[^}]*\}\)/);
    const initCall = content.match(/rks_governor_init\(\{[^}]*\}\)/)?.[0] ?? "";
    expect(initCall).not.toContain("problemId");
  });

  it("calls rks_agent_research for each storyId in the batch", () => {
    expect(content).toContain("rks_agent_research");
    expect(content).toContain("storyId");
  });

  it("includes all 8 ARCH checklist items", () => {
    expect(content).toContain("Correct function/variable/condition");
    expect(content).toContain("Secondary firing paths");
    expect(content).toContain("Tests to delete vs. update");
    expect(content).toContain("Frontmatter consistency");
    expect(content).toContain("Left-side/right-side imbalance");
    expect(content).toContain("Wrong-phase validation");
    expect(content).toContain("Circular dogfood dependency");
    expect(content).toContain("Stale active/target scope");
  });

  it("routes the verdict through rks_arch_verdict and writes no verdict field directly", () => {
    // Was: ARCH asserted its own verdict via dendron_update_field. That left the gate
    // with no pass condition — it re-reviewed the whole story every round, so a fix
    // that added surface added findings, and one story took two rounds whose finding
    // sets were entirely disjoint. The verdict is now COMPUTED server-side from a
    // frozen finding ledger and ARCH is not permitted to write it.
    // (arch_guidance stays banned for the original reason: a nested object passed to
    // dendron_update_field got JSON.stringify'd into frontmatter — one note hit 50KB.)
    expect(content).toContain("rks_arch_verdict");
    expect(content).toContain("arch_verdict");
    expect(content).toContain("arch_findings_count");
    expect(content).not.toContain("arch_guidance:");

    // These three fields belong to rks_arch_verdict alone. No surviving
    // dendron_update_field call may write any of them — including the one on the
    // Graceful Degradation path, which is the branch taken when RAG fails and so the
    // one least likely to be exercised before it ships.
    const updateCalls = content
      .split("\n")
      .filter((l) => l.includes("dendron_update_field({"));
    for (const call of updateCalls) {
      expect(call).not.toMatch(/field:\s*['"]arch_verdict['"]/);
      expect(call).not.toMatch(/field:\s*['"]arch_findings_count['"]/);
      expect(call).not.toMatch(/field:\s*['"]phase['"]/);
      // Value contract unchanged: string or flat array only, never an object literal.
      expect(call).not.toMatch(/value:\s*\{/);
      expect(call).not.toMatch(/value:\s*\[/);
    }
  });

  it("states the ledger semantics, so ARCH knows late findings cannot block", () => {
    // Without this the prompt would mandate a call whose behaviour surprises the
    // caller: findings raised for the first time after round 1 come back deferred.
    expect(content).toMatch(/Round 1 freezes the ledger/);
    expect(content).toContain("deferred");
    expect(content).toMatch(/write NEITHER `arch_verdict` NOR `phase`/);
  });

  it("routes the narrative verdict into an ARCH Guidance body section", () => {
    expect(content).toContain("dendron_edit_note");
    expect(content).toContain("## ARCH Guidance");
    // dendron_edit_note is literal search/replace with no append mode and aborts
    // on search_not_found, so a replace-only instruction would silently lose the
    // verdict on a story's FIRST pass. Both branches must be specified.
    expect(content).toContain("search_not_found");
    expect(content).toMatch(/already contains `## ARCH Guidance`/);
    expect(content).toMatch(/does NOT contain `## ARCH Guidance`/);
    // Repeated ARCH passes must converge on exactly one section.
    expect(content).toMatch(/converge on exactly one/);
  });

  it("allows dendron_edit_note, which the narrative write requires", () => {
    const allowlist = content.slice(
      content.indexOf("Allowed:"),
      content.indexOf("NOT Allowed"),
    );
    expect(allowlist).toContain("dendron_edit_note");
    expect(allowlist).toContain("dendron_update_field");
    expect(allowlist).toContain("dendron_read_note");
    // The verdict write has no other path — without this the reworked prompt
    // mandates a call the allowlist forbids.
    expect(allowlist).toContain("rks_arch_verdict");
  });

  it("specifies approved return format with findings array", () => {
    expect(content).toContain("status: 'approved'");
    expect(content).toContain("findings");
  });

  it("specifies needs-revision return format with storyId/item/file/detail shape", () => {
    expect(content).toContain("needs-revision");
    expect(content).toContain("storyId");
    expect(content).toContain("item");
    expect(content).toContain("detail");
  });

  it("includes graceful degradation path for RAG unavailable", () => {
    expect(content).toContain("SKIPPED: RAG unavailable");
    expect(content).toContain("approved");
  });

  it("includes cross-story stale-snapshot hazard check", () => {
    expect(content).toContain("stale-snapshot");
  });
});
