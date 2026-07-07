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

  it("bootstrap instructions substitute __PROJECT_ID__ with routekit-shell", () => {
    expect(body).toContain("__PROJECT_ID__");
    expect(body).toContain("routekit-shell");
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
