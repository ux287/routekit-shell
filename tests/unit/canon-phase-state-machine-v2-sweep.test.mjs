/**
 * Canon v2 sweep structural test.
 *
 * Pure fs.readFileSync + regex assertions. Pins:
 *  - AC1: every [GAP-N] subsection header has a status marker (CLOSED/OPEN/PARTIALLY)
 *  - AC1.b: GAP-3 specifically marked CLOSED with backref
 *  - AC2: phase list reflects v2 (executing + committed live; implemented retired)
 *  - AC3: transitions section includes all 7 v2 ops
 *  - AC4: release note exists with required sections + paper citations + word count
 *  - AC5: orphan stub deleted
 *  - AC6-8: scope discipline (canon, release note, orphan, this test only)
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CANON_PATH = path.join(PROJECT_ROOT, "notes/canon.phase-state-machine.md");
const RELEASE_NOTE_PATH = path.join(PROJECT_ROOT, "notes/release-notes/2026.06-v2-phase-machine.md");
const ORPHAN_PATH = path.join(PROJECT_ROOT, "notes/backlog.fixes.chain-state-allowed-tool-symmetry.md");

const CANON_SRC = fs.readFileSync(CANON_PATH, "utf8");
const RELEASE_SRC = fs.readFileSync(RELEASE_NOTE_PATH, "utf8");

describe("canon-phase-state-machine v2 sweep", () => {
  describe("AC1 — every [GAP-N] subsection header has a status marker", () => {
    it("every '### [GAP-N]' header ends with CLOSED, OPEN, or PARTIALLY marker", () => {
      const headers = CANON_SRC.match(/^### \[GAP-\d+\][^\n]*/gm) || [];
      expect(headers.length).toBeGreaterThan(0);
      const unmarked = headers.filter((h) => {
        // Accept any of: **CLOSED ...**, — CLOSED, — OPEN, — still open, — remains open,
        // — PARTIALLY CLOSED (or with markdown bold)
        return !/(CLOSED|OPEN|PARTIALLY|remains open|still open)/i.test(h);
      });
      expect(unmarked).toEqual([]);
    });
  });

  describe("AC1.b — GAP-3 marked CLOSED with backref to R1.3f or R1.3-followup", () => {
    it("GAP-3 header contains CLOSED + (R1.3f or R1.3-followup)", () => {
      const gap3 = CANON_SRC.match(/^### \[GAP-3\][^\n]*/m);
      expect(gap3).not.toBeNull();
      expect(gap3[0]).toMatch(/CLOSED/);
      expect(gap3[0]).toMatch(/R1\.3f|R1\.3-followup/);
    });
  });

  describe("AC2 — phase list reflects v2", () => {
    it("Section 2 (Phases) includes `executing` as a live phase", () => {
      // Find section 2 boundary
      const sec2Start = CANON_SRC.indexOf("## 2. Phases");
      const sec3Start = CANON_SRC.indexOf("## 3. Transitions");
      expect(sec2Start).toBeGreaterThan(-1);
      expect(sec3Start).toBeGreaterThan(sec2Start);
      const sec2 = CANON_SRC.slice(sec2Start, sec3Start);
      expect(sec2).toMatch(/\*\*`executing`\*\*/);
    });

    it("Section 2 includes `committed` as a live phase", () => {
      const sec2Start = CANON_SRC.indexOf("## 2. Phases");
      const sec3Start = CANON_SRC.indexOf("## 3. Transitions");
      const sec2 = CANON_SRC.slice(sec2Start, sec3Start);
      expect(sec2).toMatch(/\*\*`committed`\*\*/);
    });

    it("Section 2 does NOT list `implemented` as a live phase (tolerates 'retired' annotation)", () => {
      const sec2Start = CANON_SRC.indexOf("## 2. Phases");
      const sec3Start = CANON_SRC.indexOf("## 3. Transitions");
      const sec2 = CANON_SRC.slice(sec2Start, sec3Start);
      // Live-phase format is `**`<name>`**`. The retired phase is documented under
      // a "Retired phases" subsection. The bullet-bold `implemented` shape should
      // not appear OUTSIDE the retired subsection.
      const retiredIdx = sec2.indexOf("Retired phases");
      const livePart = retiredIdx > -1 ? sec2.slice(0, retiredIdx) : sec2;
      expect(livePart).not.toMatch(/^- \*\*`implemented`\*\*/m);
    });
  });

  describe("AC3 — Section 3 transitions includes all 7 v2 ops", () => {
    const sec3Start = CANON_SRC.indexOf("## 3. Transitions");
    const sec4Start = CANON_SRC.indexOf("## 4. Governor Ownership");
    const sec3 = CANON_SRC.slice(sec3Start, sec4Start);

    const v2Ops = [
      "exec_start",
      "exec_end",
      "commit",
      "promote",
      "guardrails_off",
      "guardrails_on.commit",
      "guardrails_on.merge",
    ];

    for (const op of v2Ops) {
      it(`Section 3 mentions \`${op}\``, () => {
        expect(sec3).toContain(op);
      });
    }
  });

  describe("AC4 — release note structure", () => {
    it("AC4.a release note file exists at notes/release-notes/2026.06-v2-phase-machine.md", () => {
      expect(fs.existsSync(RELEASE_NOTE_PATH)).toBe(true);
    });

    it("AC4.b has TL;DR + Breaking changes + New operations + Migration headers", () => {
      expect(RELEASE_SRC).toMatch(/^##\s+TL;DR/m);
      expect(RELEASE_SRC).toMatch(/^##\s+Breaking changes/m);
      expect(RELEASE_SRC).toMatch(/^##\s+New operations/m);
      expect(RELEASE_SRC).toMatch(/^##\s+Migration path/m);
    });

    it("AC4.c cites all 3 v2-arc paper filenames", () => {
      expect(RELEASE_SRC).toContain("research.2026.06.10.phase-machine-redesign.md");
      expect(RELEASE_SRC).toContain("research.2026.06.12.re-plan-workflow-audit.md");
      expect(RELEASE_SRC).toContain("research.2026.06.13.integrated-implemented-released-arc.md");
    });

    it("AC4.d release note word count is between 400 and 1200", () => {
      const words = RELEASE_SRC
        .replace(/```[\s\S]*?```/g, "") // strip code blocks
        .split(/\s+/)
        .filter(Boolean).length;
      expect(words).toBeGreaterThanOrEqual(400);
      expect(words).toBeLessThanOrEqual(1200);
    });
  });

  describe("AC5 — orphan stub deleted", () => {
    it("notes/backlog.fixes.chain-state-allowed-tool-symmetry.md does NOT exist on disk", () => {
      expect(fs.existsSync(ORPHAN_PATH)).toBe(false);
    });
  });

  // AC6-8 (scope discipline) — the original git-diff scope assertion was a
  // one-time check meaningful only during the canon-sweep ship itself. Once
  // canon sweep shipped (b4598430), the assertion has no useful runtime
  // signal — subsequent ships (Tier 2, etc.) will legitimately have other
  // files in the diff. Scope discipline is now enforced at the off-rail
  // active-scope.json layer and at the ARCH review.
});
