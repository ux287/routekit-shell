/**
 * Content-assertion test for the INIT/ATTACH RUNBOOK section in CLAUDE.md
 * (backlog.feat.init-attach-runbook).
 *
 * The runbook gives the Dispatcher a concrete Path-B recipe (template selection + the
 * terminal-handoff scaffold flow, since rks_init is base-only and the shell session's rails
 * scope to the current project). Durable phrase assertions — no fixed-window slices.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const claudeMd = () => fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");

// Heading-bounded section slice (heading → next "\n## ").
function section(md, heading) {
  const start = md.indexOf(heading);
  if (start < 0) return "";
  const rest = md.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}
const runbook = () => section(claudeMd(), "## INIT/ATTACH RUNBOOK");

describe("CLAUDE.md — INIT/ATTACH RUNBOOK", () => {
  it("has an INIT/ATTACH RUNBOOK section", () => {
    expect(claudeMd()).toContain("## INIT/ATTACH RUNBOOK");
  });

  describe("template selection", () => {
    it("calls rks_templates_list for discovery", () => {
      expect(runbook()).toContain("rks_templates_list");
    });
    it("names the stack ids with when-to-use guidance", () => {
      const r = runbook();
      expect(r).toContain("app-web");
      expect(r).toContain("base");
      expect(r).toContain("web-vite-rag-agency");
      expect(r).toMatch(/web app|browser|localhost|npm run dev/i);   // app-web = web app
      expect(r).toMatch(/heavy|large|official|explicit/i);           // web-vite-rag-agency caveat
    });
  });

  describe("scaffold / attach commands", () => {
    it("gives `routekit project init` with --id --stack --path", () => {
      const r = runbook();
      expect(r).toContain("routekit project init");
      expect(r).toContain("--id");
      expect(r).toContain("--stack");
      expect(r).toContain("--path");
    });
    it("gives `routekit project attach`", () => {
      expect(runbook()).toContain("routekit project attach");
    });
    it("sets the honest handoff: run in terminal, then open the new project in Claude Code", () => {
      const r = runbook();
      expect(r).toMatch(/terminal/i);
      expect(r).toMatch(/open .*in claude code/i);
    });
  });

  it("has the calculator worked example on app-web", () => {
    const r = runbook();
    expect(r).toContain("calculator-app");
    expect(r).toContain("app-web");
  });

  // ── Regression witnesses: the runbook must NOT contaminate the onboarder section ──
  describe("does not break the onboarder-section pins", () => {
    it("the Onboarder Auto-Trigger section still has no issue/github (conversational Test 6 pin)", () => {
      expect(section(claudeMd(), "## Onboarder Auto-Trigger")).not.toMatch(/issue|github/i);
    });
    it("init/attach still appear in the onboarder section (conversational Test 4 pin)", () => {
      const onboarder = section(claudeMd(), "## Onboarder Auto-Trigger");
      expect(onboarder).toContain("routekit project init");
      expect(onboarder).toContain("routekit project attach");
    });
    it("the runbook heading comes AFTER the onboarder heading", () => {
      const md = claudeMd();
      expect(md.indexOf("## INIT/ATTACH RUNBOOK")).toBeGreaterThan(md.indexOf("## Onboarder Auto-Trigger"));
    });
  });
});
