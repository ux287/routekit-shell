/**
 * Structural test for the telemetry-and-CI-observability audit paper.
 *
 * Pure fs.readFileSync + regex assertions. No subprocess spawns, no git
 * shell-out. Mirrors the pattern of
 * tests/unit/canon-phase-state-machine-v2-sweep.test.mjs.
 *
 * Acceptance criteria pinned:
 *  - AC1   paper file exists
 *  - AC1.b word count between 4000-6000 (frontmatter / fenced code / HTML
 *          comments stripped before counting)
 *  - AC2   all 8 section headers present (^## )
 *  - AC3   >=10 telemetry event ids matched from a fixed catalog
 *  - AC4   dashboard plugin path cited
 *  - AC5   all 5 migration story IDs traced
 *  - AC6   all 5 CI run numbers present
 *  - AC7   Section 6 contains a fenced code block with ASCII signal-flow
 *          indicators (permissive regex)
 *  - AC8   Section 7 contains "Immediate", "Near-term", "Structural"
 *          subsection labels
 *  - AC9   all 4 precedent paper filenames cited
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PAPER_PATH = path.join(
  PROJECT_ROOT,
  "notes/research.2026.06.15.telemetry-and-ci-observability-audit.md",
);

const PAPER_SRC = fs.existsSync(PAPER_PATH) ? fs.readFileSync(PAPER_PATH, "utf8") : "";

// Strip frontmatter, fenced code blocks, and HTML comments before word-count
// and section-header analysis.
const STRIPPED_SRC = PAPER_SRC
  .replace(/^---[\s\S]*?---\n/, "")
  .replace(/```[\s\S]*?```/g, "")
  .replace(/<!--[\s\S]*?-->/g, "");

describe("research telemetry-and-ci-observability-audit structural sweep", () => {
  describe("AC1 — paper exists", () => {
    it("research note exists at the canonical path", () => {
      expect(fs.existsSync(PAPER_PATH)).toBe(true);
    });
  });

  describe("AC1.b — word count band", () => {
    it("body word count is between 4000 and 6000", () => {
      const words = STRIPPED_SRC.split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThanOrEqual(4000);
      expect(words).toBeLessThanOrEqual(6000);
    });
  });

  describe("AC2 — all 8 section headers present", () => {
    // Section title fragments — match against `^## ` headers in the stripped
    // body. Fragments are case-sensitive substring matches to allow numeric
    // prefixes (e.g. "## 1. Empirical state of telemetry") without coupling
    // to the exact numbering scheme.
    const requiredHeaderFragments = [
      "Empirical state of telemetry",
      "Dashboard reality check",
      "V1 to V2 event semantics shift",
      "Empirical state of CI observability",
      "The unification",
      "End-state thesis",
      "Tiered recommendations",
      "What this paper cannot answer",
    ];

    const headers = STRIPPED_SRC.match(/^## [^\n]*/gm) || [];

    for (const fragment of requiredHeaderFragments) {
      it(`a ^## header contains "${fragment}"`, () => {
        const found = headers.some((h) => h.includes(fragment));
        expect(found, `no ^## header matched "${fragment}". Headers found: ${headers.join(" | ")}`).toBe(true);
      });
    }

    it("at least 8 ^## headers exist in the body", () => {
      expect(headers.length).toBeGreaterThanOrEqual(8);
    });
  });

  describe("AC3 — >=10 telemetry event ids cited", () => {
    // Fixed catalog of event ids that should appear by literal token in the
    // paper body (Section 1 table and elsewhere). The threshold is >=10
    // distinct matches.
    const eventCatalog = [
      "auto_phase.transition",
      "auto_phase.invalid",
      "auto_phase.error",
      "story.phase.changed",
      "story_ship.start",
      "story_ship.success",
      "story_ship.failed",
      "story_ship.step.completed",
      "story_ship.step.skipped",
      "story_ship.step.started",
      "ci.poll.start",
      "ci.poll.pass",
      "ci.poll.fail",
      "pr.merged",
      "merge.unlinked",
      "staging.merge.no_ci",
      "release.start",
      "release.complete",
      "release.failed",
      "refine.start",
      "refine.decompose",
      "refine.apply",
      "refine.complete",
      "refine.failed",
      "plan.complete",
      "plan.failed",
      "mcp.llm.complete",
      "exec.start",
      "exec.complete",
      "exec.failed",
      "cycle.complete",
      "ship.start",
      "ship.success",
      "ship.failed",
      "guardrails.off",
      "guardrails.on",
      "governor.init",
      "governor.tool_summary",
      "hooks.integrity.check",
      "validate_story.complete",
    ];

    it("paper cites >=10 distinct event ids from the catalog", () => {
      const matched = eventCatalog.filter((evt) => PAPER_SRC.includes(evt));
      expect(matched.length, `matched events: ${matched.join(", ")}`).toBeGreaterThanOrEqual(10);
    });
  });

  describe("AC4 — dashboard plugin path cited", () => {
    it("paper cites packages/telemetry-dashboard/vite-plugin-telemetry-api.ts", () => {
      expect(PAPER_SRC).toContain("packages/telemetry-dashboard/vite-plugin-telemetry-api.ts");
    });
  });

  describe("AC5 — all 5 migration story IDs traced", () => {
    const migrationStoryIds = [
      "R1.3e",
      "R1.3f",
      "R1.3-followup-rks-release",
      "R1.3-followup-rks-ship",
      "R8",
    ];

    for (const storyId of migrationStoryIds) {
      it(`paper traces migration story ${storyId}`, () => {
        expect(PAPER_SRC).toContain(storyId);
      });
    }
  });

  describe("AC6 — all 5 CI run numbers present", () => {
    const ciRuns = ["1965", "1966", "1967", "1968", "1973"];

    for (const run of ciRuns) {
      it(`paper references CI run #${run}`, () => {
        // Permissive: any "#1965", "1965", or "CI #1965" form counts.
        expect(PAPER_SRC).toMatch(new RegExp(`#?${run}\\b`));
      });
    }
  });

  describe("AC7 — Section 6 contains a fenced code block with ASCII signal-flow indicators", () => {
    it("a fenced block exists in Section 6 with arrow / pipe / plus-dash markers", () => {
      // Locate Section 6 by its header fragment, then slice to the next
      // top-level header.
      const sec6Match = PAPER_SRC.match(/^## [^\n]*End-state thesis[^\n]*\n([\s\S]*?)(?=\n## |\Z)/m);
      expect(sec6Match, "Section 6 header not found").not.toBeNull();
      const sec6Body = sec6Match[1];

      // Find any fenced code block inside Section 6.
      const fenced = sec6Body.match(/```[\s\S]*?```/);
      expect(fenced, "no fenced code block found in Section 6").not.toBeNull();

      // Permissive ASCII signal-flow check: arrows, pipe-pipe, or plus-dash.
      const block = fenced[0];
      const signalFlowRe = /->|-->|\|.*\||\+--/;
      expect(signalFlowRe.test(block), `Section 6 fenced block lacks signal-flow indicators. Block: ${block.slice(0, 200)}`).toBe(true);
    });
  });

  describe("AC8 — Section 7 contains Immediate, Near-term, Structural subsection labels", () => {
    const sec7Match = PAPER_SRC.match(/^## [^\n]*Tiered recommendations[^\n]*\n([\s\S]*?)(?=\n## |\Z)/m);
    const sec7Body = sec7Match ? sec7Match[1] : "";

    it("Section 7 exists", () => {
      expect(sec7Match).not.toBeNull();
    });

    it("Section 7 contains the literal label 'Immediate'", () => {
      expect(sec7Body).toContain("Immediate");
    });

    it("Section 7 contains the literal label 'Near-term'", () => {
      expect(sec7Body).toContain("Near-term");
    });

    it("Section 7 contains the literal label 'Structural'", () => {
      expect(sec7Body).toContain("Structural");
    });
  });

  describe("AC9 — all 4 precedent paper filenames cited", () => {
    const precedentPapers = [
      "research.2026.06.10.phase-machine-redesign.md",
      "research.2026.06.12.re-plan-workflow-audit.md",
      "research.2026.06.13.integrated-implemented-released-arc.md",
      "research.2026.06.15.test-suite-bloat-audit-and-tier-redesign.md",
    ];

    for (const paper of precedentPapers) {
      it(`paper cites precedent ${paper}`, () => {
        expect(PAPER_SRC).toContain(paper);
      });
    }
  });
});
