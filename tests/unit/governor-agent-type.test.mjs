/**
 * F2: restricted `governor` agent-type so Governor subagents cannot use Claude Code
 * built-ins (Bash/Edit/Write/Read/Grep/Glob). The restriction is a launch-time tool
 * allowlist (.claude/agents/governor.md) — harness-enforced, not prose.
 *
 * Story: backlog.fix.governor-subagent-ungoverned-builtin-tools
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const governorMd = fs.readFileSync(path.join(repoRoot, ".claude/agents/governor.md"), "utf8");

// The `tools:` allowlist section of the frontmatter (between `tools:` and the closing `---`).
// Scoped so the built-in NAMES that appear in the prose description/body are not matched.
const toolsStart = governorMd.indexOf("tools:");
const toolsSection = governorMd.slice(toolsStart, governorMd.indexOf("\n---", toolsStart));

// Skills that launch a Governor subagent — all must use the restricted type.
const GOVERNOR_SKILLS = ["build", "qa", "arch", "po", "research", "ship", "pipeline"];

describe("F2: restricted governor agent-type", () => {
  it("governor.md defines the agent with a tools: allowlist", () => {
    expect(governorMd).toMatch(/^name:\s*governor\s*$/m);
    expect(governorMd).toMatch(/^tools:/m);
  });

  it("the allowlist EXCLUDES the shell/mutation built-ins (the F2 restriction)", () => {
    for (const builtin of ["Bash", "Edit", "Write", "NotebookEdit"]) {
      expect(toolsSection, `${builtin} must not be allowlisted`).not.toMatch(new RegExp(`\\b${builtin}\\b`));
    }
  });

  it("the allowlist ALLOWS the read-only built-ins (governors must load their prompt)", () => {
    for (const builtin of ["Read", "Grep", "Glob"]) {
      expect(toolsSection, `${builtin} must be allowlisted`).toMatch(new RegExp(`\\b${builtin}\\b`));
    }
  });

  it("the allowlist INCLUDES the rks MCP/dendron tools the governor chains call", () => {
    for (const tool of [
      "mcp__rks__rks_governor_init",
      "mcp__rks__rks_agent_research",
      "mcp__rks__rks_refine",
      "mcp__rks__rks_refine_apply",
      "mcp__rks__rks_plan",
      "mcp__rks__rks_plan_ready",
      "mcp__rks__rks_plan_review",
      "mcp__rks__rks_exec",
      "mcp__rks__rks_analyze",
      "mcp__rks__rks_story_ship",
      "mcp__rks__dendron_create_note",
      "mcp__rks__dendron_edit_note",
      "mcp__rks__dendron_read_note",
      "mcp__rks__dendron_update_field",
    ]) {
      expect(toolsSection, `${tool} must be allowlisted`).toContain(tool);
    }
  });

  it("all governor-launching skills use subagent_type governor (not general-purpose)", () => {
    for (const skill of GOVERNOR_SKILLS) {
      const md = fs.readFileSync(path.join(repoRoot, ".claude/skills", skill, "SKILL.md"), "utf8");
      expect(md, `${skill} should launch governor`).toContain("subagent_type: governor");
      expect(md, `${skill} should not launch general-purpose`).not.toContain("subagent_type: general-purpose");
    }
  });

  it("bootstrap provisions .claude/agents to children (so the restriction reaches child projects)", () => {
    const bootstrapSrc = fs.readFileSync(path.join(repoRoot, "packages/cli/src/project/bootstrap.mjs"), "utf8");
    expect(bootstrapSrc).toContain('".claude", "agents"');
  });
});
