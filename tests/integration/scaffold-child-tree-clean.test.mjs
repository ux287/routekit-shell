/**
 * backlog.fix.scaffold-ships-routekit-blind-gitignore — the DELIVERY half.
 *
 * The content half (tests/unit/template-gitignore-runtime-parity.test.mjs) proves
 * the two template files agree and carry the right rules. It cannot prove the
 * causal core of this defect: that the file a base-stack child ACTUALLY receives
 * is the skeleton copy we edited. That needs a real scaffold, which is what this
 * file does.
 *
 * TIER. This lives in tests/integration, not tests/unit, because
 * tests/unit/README.md requires ALL FOUR of its criteria to hold and this test
 * fails three — it shells out to git, it does mkdtemp plus multi-step fixture
 * mutation, and it will not finish in 100ms. It is NOT here because
 * unit-tier-purity rule A bans spawn; that enforcer explicitly tolerates a spawn
 * carrying an explicit timeout. The convention is the governing ground, and it is
 * broader than the enforcer.
 *
 * The filename deliberately omits the `.workflow.` infix: vitest.config.mock.mjs
 * includes tests/integration/ but excludes *.workflow.test.*, so a file named that
 * way would never run and would read as green forever.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initProjectFromStack } from "../../packages/cli/src/project/init-stack.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHELL_ROOT = join(__dirname, "../..");
const TIMEOUT = 20000;

// FIXTURE CONTAINMENT — every temp root is under os.tmpdir(), never the repo.
const tempRoots = [];
function scaffold(stackId, id) {
  const root = mkdtempSync(join(tmpdir(), "rks-scaffold-"));
  tempRoots.push(root);
  const targetPath = join(root, id);
  mkdirSync(targetPath, { recursive: true });
  return { targetPath, promise: initProjectFromStack({ shellRoot: SHELL_ROOT, id, stackId, targetPath }) };
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * Raw `git check-ignore` exit status: 0 = ignored, 1 = NOT ignored, 128 = error.
 *
 * Returned raw and asserted exactly, rather than collapsed to a boolean. The
 * in-repo precedent (tests/unit/gitignore-scratch-dirs.test.mjs) returns
 * `r.status === 0`, which makes "not ignored" absorb exit 128 and a null status —
 * so a control asserting NOT-IGNORED would pass when git failed outright. Here a
 * broken git fails both directions instead of silently satisfying one.
 */
function checkIgnoreStatus(cwd, relPath) {
  const r = spawnSync("git", ["check-ignore", "-q", relPath], { cwd, encoding: "utf8", timeout: TIMEOUT });
  return r.status;
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  return r;
}

describe("a scaffolded base-stack child receives the RouteKit-aware .gitignore", () => {
  it("delivers bytes identical to templates/base/skeleton/.gitignore", async () => {
    // THE CAUSAL CORE. init-stack.js copies templates/<stack>/skeleton wholesale,
    // and that copy pre-empts the bootstrap seed — which only fires when the
    // destination is absent. So the skeleton copy is what the child actually gets,
    // and no content assertion over the template can establish that.
    const { targetPath, promise } = scaffold("base", "delivery-probe");
    await promise;

    const delivered = readFileSync(join(targetPath, ".gitignore"), "utf8");
    const template = readFileSync(join(SHELL_ROOT, "templates/base/skeleton/.gitignore"), "utf8");
    expect(delivered).toBe(template);
  });

  it("ignores every runtime path and leaves tracked config visible", async () => {
    const { targetPath, promise } = scaffold("base", "ignore-probe");
    await promise;

    // A real repo, with NOTHING added — check-ignore does not report on tracked
    // paths, so staging anything here would silently void the probe.
    git(targetPath, ["init"]);

    // check-ignore is a pathname query, so none of these need to exist on disk.
    // No artifact materialisation, no `git status --porcelain` parsing — which
    // would have been unsatisfiable anyway, since in a virgin repo the scaffold's
    // own legitimately-tracked files show as untracked permanently.
    const IGNORED = [
      ".rks/rag/proj.lancedb/data.lance",
      ".rks/rag/embeds/e.bin",
      ".rks/rag/embed-manifest.json",
      ".rks/rag/last-embed.json",
      ".rks/fetch-cache/c.json",
      ".rks/session/s.json",
      ".rks/telemetry/events.jsonl",
      ".rks/governor-session.json",
      ".routekit/context-state.json",
      ".dendron.port",
      ".dendron.ws",
      "notes/.dendron.cache.json",
    ];
    for (const p of IGNORED) {
      expect(checkIgnoreStatus(targetPath, p), `${p} must be ignored`).toBe(0);
    }

    // ANTI-VACUITY. These two must remain VISIBLE — they are tracked project
    // content. Without them a blanket `*` or `.rks/` would satisfy every
    // assertion above. Status is pinned to exactly 1, so a git failure (128)
    // fails here rather than reading as "not ignored".
    for (const p of [".rks/project.json", ".rks/prompts/governor-qa.md"]) {
      expect(checkIgnoreStatus(targetPath, p), `${p} is tracked config and must NOT be ignored`).toBe(1);
    }
  });
});

describe("the react stack is unaffected and stays that way", () => {
  it("scaffolds no .gitignore of its own, so the bootstrap seed applies", async () => {
    // This is why app.web.react.spa never had the defect: with no skeleton
    // .gitignore, bootstrap's seed from templates/base/.gitignore is free to land.
    const { targetPath, promise } = scaffold("app.web.react.spa", "react-probe");
    await promise;
    expect(existsSync(join(targetPath, ".gitignore"))).toBe(false);
  });

  it("gains no third template copy from this fix", () => {
    // A third copy would sit outside the parity check in the unit test and could
    // drift from both other files unnoticed.
    expect(existsSync(join(SHELL_ROOT, "templates/app.web.react.spa/skeleton/.gitignore"))).toBe(false);
  });
});

describe("the bootstrap seed route", () => {
  it("seeds from templates/base/.gitignore only when the destination is absent", () => {
    // Source-read, no line numbers and no fixed-size window.
    //
    // Matched on the NEGATED DESTINATION guard specifically. bootstrap.mjs holds
    // two existsSync calls two lines apart, and only this one carries
    // don't-overwrite semantics — the other is a source-presence check. Matching
    // that one instead would leave the behaviour unasserted: the test would stay
    // green even if the `!` were deleted.
    const src = readFileSync(join(SHELL_ROOT, "packages/cli/src/project/bootstrap.mjs"), "utf8");
    expect(src).toMatch(/if\s*\(\s*!\s*fs\.existsSync\(\s*gitignoreDest\s*\)\s*\)/);
    expect(src).toMatch(/path\.join\(\s*shellRoot\s*,\s*"templates"\s*,\s*"base"\s*,\s*"\.gitignore"\s*\)/);
  });
});
