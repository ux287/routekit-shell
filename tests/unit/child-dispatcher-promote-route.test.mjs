/**
 * backlog.fix.child-dispatcher-promote-route-unrouted
 *
 * The child CLAUDE.md template must route branch promotion to /ops and the
 * staging -> main release to /release, and say rks_promote / rks_release are not
 * called directly. The /ops skill description must name branch promotion so
 * skill discovery matches a promote request. Pins carried by other files
 * (promote-ops-flow-admission, sync-staging-push-only-governance) are repeated
 * here only where this change could break them.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

// Text from a level-2 heading up to (not including) the next level-2 heading.
function section(md, heading) {
  const start = md.indexOf(heading);
  if (start === -1) return "";
  const rest = md.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return md.slice(start, next === -1 ? undefined : start + heading.length + next);
}

function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? m[1] : "";
}

// The description key line plus its indented continuation lines.
function descriptionBlock(fm) {
  const lines = fm.split("\n");
  const i = lines.findIndex((l) => l.startsWith("description:"));
  if (i === -1) return "";
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) out.push(lines[j]);
  return out.join("\n");
}

const TICK = String.fromCharCode(96);
const ticked = (s) => TICK + s + TICK;

describe("templates/base/CLAUDE.md routes branch promotion and release", () => {
  const md = read("templates/base/CLAUDE.md");
  const skills = section(md, "## Skills");
  const rows = skills.split("\n").filter((l) => l.startsWith("|"));
  const paragraphs = skills
    .split("\n")
    .filter((l) => !l.startsWith("|") && !l.startsWith("## "))
    .join("\n")
    .split(/\n\s*\n/);

  it("has a non-empty Skills section holding a table (positive control)", () => {
    expect(skills.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(2);
  });

  it("keeps a row for each of the seven existing skills", () => {
    for (const s of ["/research", "/pipeline", "/build", "/qa", "/arch", "/ship", "/telemetry"]) {
      expect(rows.some((r) => r.includes(ticked(s))), s).toBe(true);
    }
  });

  it("routes branch promotion (working -> integration) to /ops", () => {
    const row = rows.find((r) => r.includes(ticked("/ops")));
    expect(row).toBeDefined();
    expect(row).toMatch(/promot/i);
    expect(row).toMatch(/staging|integration/i);
  });

  it("routes the staging -> main release to /release", () => {
    const row = rows.find((r) => r.includes(ticked("/release")));
    expect(row).toBeDefined();
    expect(row).toMatch(/\bmain\b/);
  });

  it("a paragraph says rks_promote / rks_release are not called directly and are reached via /ops and /release", () => {
    const hit = paragraphs.find(
      (p) =>
        p.includes("rks_promote") &&
        p.includes("rks_release") &&
        p.includes("/ops") &&
        p.includes("/release") &&
        /directly|unauthorized/i.test(p),
    );
    expect(hit).toBeDefined();
  });

  it("the Permission mode section still names every checkpoint (note not moved into it)", () => {
    const perm = section(md, "## Permission mode");
    expect(perm.length).toBeGreaterThan(0);
    for (const t of ["rks_guardrails_off", "rks_release", "rks_promote", "rks_publish", "rks_publish_profiles"]) {
      expect(perm, t).toContain(ticked(t));
    }
  });

  it("introduces no core-only or parent-identity text", () => {
    for (const s of ["/onboard", "/welcome", "routekit-shell-core", "rks_plan_review", "Singleton Rule", "offRail"]) {
      expect(md).not.toContain(s);
    }
  });
});

describe(".claude/skills/ops/SKILL.md description names branch promotion", () => {
  const md = read(".claude/skills/ops/SKILL.md");
  const fm = frontmatter(md);
  const desc = descriptionBlock(fm);

  it("parses the frontmatter description (positive control)", () => {
    expect(fm).toMatch(/^name: ops$/m);
    expect(desc).toContain("run scripts");
  });

  it("the description mentions branch promotion and names rks_promote", () => {
    expect(desc).toMatch(/promot/i);
    expect(desc).toContain("rks_promote");
  });

  it("the description carries no projectId key", () => {
    expect(desc).not.toMatch(/projectId\s*:/);
  });

  it("the other frontmatter keys are unchanged", () => {
    expect(fm).toMatch(/^user-invocable: true$/m);
    expect(fm).toMatch(/^disable-model-invocation: false$/m);
    expect(fm).toMatch(/^verbosity: heartbeat$/m);
  });

  it("the body still launches a general-purpose ops Governor", () => {
    expect(md).toContain("subagent_type: general-purpose");
    expect(md).toContain("flowType: 'ops'");
  });

  it("every rks_promote( line keeps the sentinel projectId and the governor token", () => {
    const lines = md.split("\n").filter((l) => l.includes("rks_promote("));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toContain("projectId: '__RKS_SOURCE_PROJECT__'");
      expect(l).toContain("_governorToken: TOKEN");
    }
  });
});

describe(".claude/agents/governor.md", () => {
  it("still does not list rks_promote (recorded decision)", () => {
    expect(read(".claude/agents/governor.md")).not.toContain("rks_promote");
  });
});
