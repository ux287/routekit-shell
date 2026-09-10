import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillPath = path.resolve(__dirname, "../../.claude/skills/arch/SKILL.md");
const raw = fs.readFileSync(skillPath, "utf8");

// Parse frontmatter
const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
const body = raw.slice(fmMatch ? fmMatch[0].length : 0);

// Simple YAML key extraction
function extractFmValue(key) {
  const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

describe("arch SKILL.md — frontmatter", () => {
  it("file exists at .claude/skills/arch/SKILL.md", () => {
    expect(fs.existsSync(skillPath)).toBe(true);
  });

  it("has parseable YAML frontmatter", () => {
    expect(fmMatch).not.toBeNull();
  });

  it("frontmatter contains non-empty name field", () => {
    const name = extractFmValue("name");
    expect(name).toBeTruthy();
  });

  it("frontmatter contains user-invocable: true", () => {
    expect(raw).toContain("user-invocable: true");
  });

  it("frontmatter contains disable-model-invocation: false", () => {
    expect(raw).toContain("disable-model-invocation: false");
  });

  it("frontmatter description mentions one or more stories at phase ready", () => {
    expect(raw).toMatch(/one or more stor/i);
    expect(raw).toMatch(/ready/);
  });

  it("frontmatter description states invoked by Dispatcher after QAs complete", () => {
    expect(raw).toMatch(/Dispatcher/);
    expect(raw).toMatch(/QA/);
  });
});

describe("arch SKILL.md — body", () => {
  it("bootstrap instructions reference governor-arch.md", () => {
    expect(body).toContain("governor-arch.md");
  });

  // arch/SKILL.md is the CANONICAL TWO-TOKEN EXEMPLAR: one token is SUBSTITUTED at publish
  // time, the other SURVIVES. Guarding the trailing clause is the cheapest defence against
  // the ONE-TOKEN COLLAPSE that aborted a prior build.
  //
  // backlog.fix.published-tests-upstream-coupled — AC9. This file reads the REAL
  // .claude/skills tree, and normalizeExportIdentity substitutes __RKS_SOURCE_PROJECT__
  // there (publish.mjs rewrites .claude/skills/**/*.md). Pinning that literal therefore
  // asserted something true upstream and FALSE in the published snapshot — one of the
  // couplings that left the public mirror's CI red. The substituted token is now DERIVED
  // from the clause itself: upstream it reads back as the sentinel, in the snapshot as the
  // resolved identity, and each is correct in its own topology. What must never happen, in
  // either, is the two tokens collapsing into one — and that is what this still pins.
  it("bootstrap instructions substitute the source-project token while __PROJECT_ID__ survives", () => {
    const clause = body.match(/Replace __PROJECT_ID__ with ([A-Za-z0-9_-]+)/);
    expect(clause, "the two-token Replace clause is missing — this is the one-token collapse").not.toBeNull();
    const substituted = clause[1];

    // The SURVIVING placeholder, never rewritten in any topology.
    expect(body).toContain("__PROJECT_ID__");
    // TWO DIFFERENT TOKENS, NEVER ONE — the invariant that actually matters.
    expect(substituted).not.toBe("__PROJECT_ID__");
    // The substituted token appears in the instructions themselves, not only in the clause
    // that names it. A single occurrence would mean the clause describes a substitution the
    // skill never performs.
    expect(body.split(substituted).length - 1).toBeGreaterThanOrEqual(2);

    // UPSTREAM ONLY. The bare projectId literal is gone, because it was one string doing two
    // jobs. In the published snapshot the identity rewrite deliberately PUTS a project id
    // here, so this absence is correct upstream and false there BY DESIGN — scoping it to the
    // un-rewritten case is the fix, not a weakening.
    if (substituted === "__RKS_SOURCE_PROJECT__") {
      expect(body).not.toContain("routekit-shell");
    }
  });

  it("bootstrap instructions substitute __STORY_IDS__ with $ARGUMENTS", () => {
    expect(body).toContain("__STORY_IDS__");
    expect(body).toContain("$ARGUMENTS");
  });

  it("launches Task() subagent with subagent_type governor", () => {
    // F2: governors run in the restricted `governor` agent-type (no Bash/Edit/Write).
    expect(body).toContain("subagent_type: governor");
  });

  it("specifies max_turns 15", () => {
    expect(body).toContain("max_turns: 15");
  });

  it("documents approved return path — Dispatcher proceeds to Build", () => {
    expect(body).toContain("approved");
    expect(body).toContain("Build");
  });

  it("documents needs-revision return path — Dispatcher holds Build", () => {
    expect(body).toContain("needs-revision");
    expect(body).toMatch(/wait|hold|do not/i);
  });

  it("documents the Singleton Rule", () => {
    expect(body).toContain("Singleton Rule");
    expect(body).toContain("two Governors in parallel");
  });
});
