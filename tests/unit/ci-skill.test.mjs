/**
 * /ci skill: structural + read-only contract enforcement.
 *
 * Pure fs.readFileSync + regex assertions. No subprocess spawns. No live gh CLI
 * invocations. Pins:
 *   - SKILL.md frontmatter shape (name, description, user-invocable,
 *     disable-model-invocation, verbosity)
 *   - Skill body references the 4 gh CLI subcommands + scripts/analyze-vitest-report.mjs
 *   - 5 argument modes documented (latest, runId, green, red, failures)
 *   - Output format includes status header, per-shard summary, failure list, diagnosis hint
 *   - Read-only contract: no `gh run rerun`, `gh run cancel`, `gh workflow dispatch`,
 *     `gh pr comment/edit/close/merge`, `npx vitest`
 *   - `gh run download` always paired with `--pattern "vitest-unit-*"` (no full-archive pulls)
 *   - Graceful degradation explicitly handled for 4 failure modes
 *   - CLAUDE.md skill table includes a `/ci` row
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL_PATH = path.join(PROJECT_ROOT, ".claude/skills/ci/SKILL.md");
const CLAUDE_MD_PATH = path.join(PROJECT_ROOT, "CLAUDE.md");
const SKILL_SRC = fs.readFileSync(SKILL_PATH, "utf8");
const CLAUDE_SRC = fs.readFileSync(CLAUDE_MD_PATH, "utf8");

function readFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error("No frontmatter found");
  const fm = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0 && !line.startsWith(" ")) {
      fm[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
    }
  }
  return fm;
}

describe("/ci skill — SKILL.md structural test", () => {
  describe("AC1 — frontmatter shape", () => {
    const fm = readFrontmatter(SKILL_SRC);

    it("has name: skills-ci", () => {
      expect(fm.name).toBe("skills-ci");
    });

    it("has a non-empty description (multi-line YAML literal)", () => {
      // Description is a YAML block scalar starting with `|`. Body lines follow.
      // The simple parser above only captures the first line; check body presence too.
      expect(SKILL_SRC).toMatch(/^description:\s*\|/m);
      expect(SKILL_SRC).toMatch(/GitHub Actions CLI/);
    });

    it("has user-invocable: true", () => {
      expect(fm["user-invocable"]).toBe("true");
    });

    it("has disable-model-invocation: false", () => {
      expect(fm["disable-model-invocation"]).toBe("false");
    });

    it("has verbosity: heartbeat", () => {
      expect(fm.verbosity).toBe("heartbeat");
    });
  });

  describe("AC2 — gh CLI sequence referenced in order", () => {
    it("references gh run list", () => {
      expect(SKILL_SRC).toContain("gh run list");
    });

    it("references gh run view (with --log-failed somewhere)", () => {
      expect(SKILL_SRC).toContain("gh run view");
      expect(SKILL_SRC).toContain("--log-failed");
    });

    it("references gh run download AND scripts/analyze-vitest-report.mjs", () => {
      expect(SKILL_SRC).toContain("gh run download");
      expect(SKILL_SRC).toContain("scripts/analyze-vitest-report.mjs");
    });
  });

  describe("AC3 — 5 argument modes documented", () => {
    it("documents all five modes (latest, runId, green, red, failures)", () => {
      // Argument modes are presented in a markdown table.
      expect(SKILL_SRC).toMatch(/\| latest \|/);
      expect(SKILL_SRC).toMatch(/\| runId \|/);
      expect(SKILL_SRC).toMatch(/\| green \|/);
      expect(SKILL_SRC).toMatch(/\| red \|/);
      expect(SKILL_SRC).toMatch(/\| failures \|/);
    });
  });

  describe("AC4 — output format sections present", () => {
    it("documents status header, per-shard summary, failure list, diagnosis hint", () => {
      expect(SKILL_SRC).toMatch(/Status header/i);
      expect(SKILL_SRC).toMatch(/Per-shard summary/i);
      expect(SKILL_SRC).toMatch(/Failure list/i);
      expect(SKILL_SRC).toMatch(/Diagnosis hint/i);
    });
  });

  describe("AC5 — CLAUDE.md skill table includes /ci row", () => {
    it("CLAUDE.md skill table has a /ci entry", () => {
      expect(CLAUDE_SRC).toMatch(/\| `\/ci`\s+\|/);
    });
  });

  describe("AC7 — read-only contract enforced (no mutation commands)", () => {
    // The skill MUST NOT instruct calling these. We check by ensuring they
    // appear only in a "Forbidden" / "MUST NOT" context — never as imperative
    // instructions. The simplest rigid check: the skill explicitly forbids them.
    const forbiddenCommands = [
      "gh run rerun",
      "gh run cancel",
      "gh workflow dispatch",
      "gh pr comment",
      "gh pr edit",
      "gh pr close",
      "gh pr merge",
      "npx vitest",
    ];

    for (const cmd of forbiddenCommands) {
      it(`explicitly forbids \`${cmd}\``, () => {
        expect(SKILL_SRC).toContain(cmd);
        // The forbidden command appears under the Read-only Contract section
        const readOnlyIdx = SKILL_SRC.indexOf("Read-only Contract");
        expect(readOnlyIdx).toBeGreaterThan(-1);
        const forbiddenIdx = SKILL_SRC.indexOf(cmd);
        expect(forbiddenIdx).toBeGreaterThan(readOnlyIdx);
      });
    }

    it("gh run download in code blocks is always paired with --pattern \"vitest-unit-*\"", () => {
      // Check every occurrence inside a fenced code block (``` ... ```).
      // Bare `gh run download` mentions in prose (e.g., the description listing
      // the subcommands the skill wraps) are not actionable instructions.
      const codeBlockMatches = SKILL_SRC.match(/```[\s\S]*?```/g) || [];
      const downloadOccurrences = [];
      for (const block of codeBlockMatches) {
        if (block.includes("gh run download")) {
          downloadOccurrences.push(block);
        }
      }
      expect(downloadOccurrences.length).toBeGreaterThan(0);
      for (const block of downloadOccurrences) {
        expect(block).toContain("--pattern");
        expect(block).toContain("vitest-unit-*");
      }
    });
  });

  describe("AC8 — graceful degradation documented", () => {
    it("handles gh not authenticated", () => {
      expect(SKILL_SRC).toMatch(/not authenticated/i);
    });

    it("handles no recent CI runs", () => {
      expect(SKILL_SRC).toMatch(/no recent CI runs/i);
    });

    it("handles artifacts not yet uploaded", () => {
      expect(SKILL_SRC).toMatch(/artifacts.*not.*uploaded|artifacts haven.?t uploaded/i);
    });

    it("handles JSON malformed or empty", () => {
      expect(SKILL_SRC).toMatch(/JSON malformed|malformed.*JSON/i);
    });
  });

  describe("AC9 — scope discipline (no production/workflow paths referenced as edit targets)", () => {
    // The skill should NOT propose editing packages/, scripts/, .rks/prompts/,
    // .routekit/hooks/, .github/workflows/, src/. It only READS the vitest report
    // script and gh CLI output.
    it("does not instruct editing production code", () => {
      // SKILL.md references scripts/analyze-vitest-report.mjs but only as a callable,
      // never as an edit target. Verify no imperative "edit" or "modify" near
      // packages/ or .github/workflows/.
      expect(SKILL_SRC).not.toMatch(/edit packages\//i);
      expect(SKILL_SRC).not.toMatch(/modify packages\//i);
      expect(SKILL_SRC).not.toMatch(/edit \.github\/workflows/i);
    });
  });
});
