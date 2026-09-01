import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { syncProject } from "../../packages/cli/src/project/sync.mjs";

/**
 * In-process behavioural suite driving the EXPORTED `syncProject` directly.
 *
 * SUBORDINATE TO tests/integration/skill-distribution-invariants.test.mjs. It carries only the
 * cases that are cheaper to assert in-process than through the full distribution harness. It
 * must NOT duplicate the invariants and must NOT become a per-line string checklist.
 *
 * THE TWO-TOKEN CONTRACT under test:
 *   __RKS_SOURCE_PROJECT__  the SUBSTITUTION SENTINEL — resolved to the target's projectId
 *   __PROJECT_ID__          the SURVIVING PLACEHOLDER — must reach the child intact, because the
 *                           child's Governor prompt resolves it at launch time
 * No file and no substitution site may use one token for both roles.
 */

const SENTINEL = "__RKS_SOURCE_PROJECT__";
const PLACEHOLDER = "__PROJECT_ID__";

function tmpDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `rks-skill-subst-${prefix}-`));
}

function write(p, content) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

/**
 * The source fixture.
 *
 * SEEDING IS LOAD-BEARING, NOT DECORATION. The prefix-collision negative control asserts that a
 * child whose id CONTAINS another registered id as a substring receives its own id verbatim, with
 * no doubled or truncated suffix. `routekit-shell-core` appears in ZERO real `.claude/skills`
 * matches, so without seeding it explicitly the `not.toContain("<child>-core")` half would be
 * VACUOUS — true before the fix, after the fix, AND under the mutation. Both prefix-colliding
 * strings are therefore seeded deliberately.
 */
function buildShellRoot(dir) {
  write(path.join(dir, "package.json"), JSON.stringify({ name: "routekit-shell", version: "0.99.0" }));

  // A COMPLETE TWO-TOKEN LAUNCH DIRECTIVE, so output coherence and placeholder survival are
  // both assertable from the delivered file.
  write(
    path.join(dir, ".claude", "skills", "arch", "SKILL.md"),
    `# ARCH Governor Skill\n\n` +
      `    You are an ARCH Governor for projectId ${SENTINEL}. Read your prompt at\n` +
      `    .rks/prompts/governor-arch.md. Replace ${PLACEHOLDER} with ${SENTINEL}\n` +
      `    and __STORY_IDS__ with $ARGUMENTS. Then execute the ARCH review.\n`
  );

  // THE PREFIX-COLLISION SEED. Both strings are longer superstrings of the OLD sentinel
  // `routekit-shell`. Under the old unanchored `replace(/routekit-shell/g, projectId)` these
  // corrupted into `<child>-core` / `<child>-release`. They must now survive VERBATIM, because
  // the sentinel is a distinct token that is not a prefix of either.
  write(
    path.join(dir, ".claude", "skills", "release", "SKILL.md"),
    `# Release Skill\n\n` +
      `    projectId: '${SENTINEL}'\n\n` +
      `Dev repo identity: routekit-shell-core\n` +
      `Release worktree: ../routekit-shell-release\n`
  );

  write(path.join(dir, ".rks", "prompts", "governor-arch.md"), "# ARCH Governor\nprojectId: __PROJECT_ID__\n");
}

let shellRoot, projectRoot;

beforeEach(() => {
  shellRoot = tmpDir("shell");
  projectRoot = tmpDir("proj");
  buildShellRoot(shellRoot);
});

afterEach(() => {
  rmSync(shellRoot, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

const delivered = (skill) =>
  readFileSync(path.join(projectRoot, ".claude", "skills", skill, "SKILL.md"), "utf8");

describe("skill projectId substitution — syncProject, in-process", () => {
  it("resolves the sentinel to the target id while the placeholder SURVIVES", () => {
    syncProject({ projectRoot, projectId: "my-child-app", shellRoot });

    const content = delivered("arch");
    expect(content).toContain("for projectId my-child-app."); // value position resolved
    expect(content).not.toContain(SENTINEL); // no raw sentinel reaches the child
    expect(content).toContain(PLACEHOLDER); // the placeholder is NOT substituted
    // TWO DIFFERENT TOKENS, NEVER ONE. The one-token collapse would render here as the
    // tautology "Replace my-child-app with my-child-app".
    expect(content).toContain(`Replace ${PLACEHOLDER} with my-child-app`);
    expect(content).not.toContain("Replace my-child-app with my-child-app");
  });

  // THE PREFIX-COLLISION NEGATIVE CONTROL. Discriminating only because the fixture seeds both
  // colliding strings — see buildShellRoot.
  it("a target id containing another id as a substring is delivered VERBATIM, undoubled", () => {
    syncProject({ projectRoot, projectId: "my-child-app", shellRoot });

    const content = delivered("release");
    expect(content).toContain("projectId: 'my-child-app'");
    expect(content).not.toContain(SENTINEL);

    // the seeded superstrings survive untouched — they are not the sentinel
    expect(content).toContain("routekit-shell-core");
    expect(content).toContain("routekit-shell-release");
    // and no corrupted hybrid was produced
    expect(content).not.toContain("my-child-app-core");
    expect(content).not.toContain("my-child-app-release");
  });

  it("substitutes for a target whose id is literally routekit-shell (the public mirror)", () => {
    // The projectId-equality exemption is DELETED. The mirror is a real registered project and
    // must receive a resolved sentinel like any other target.
    syncProject({ projectRoot, projectId: "routekit-shell", shellRoot });

    const content = delivered("arch");
    expect(content).toContain("for projectId routekit-shell.");
    expect(content).not.toContain(SENTINEL);
    expect(content).toContain(PLACEHOLDER);
  });

  it("leaves the governor prompt UNSUBSTITUTED, so the placeholder's referent survives", () => {
    // INVARIANT 5's precondition, asserted rather than assumed: prompts are copied without
    // substitution, which is what gives the surviving placeholder something to resolve against.
    syncProject({ projectRoot, projectId: "my-child-app", shellRoot });

    const prompt = readFileSync(
      path.join(projectRoot, ".rks", "prompts", "governor-arch.md"),
      "utf8"
    );
    expect(prompt).toContain(PLACEHOLDER);
    expect(prompt).not.toContain("my-child-app");
  });
});
