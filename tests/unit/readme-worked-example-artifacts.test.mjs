/**
 * backlog.feat.readme-worked-example-walkthrough.
 *
 * The README's "What One Change Looks Like" section exists to PROVE the pitch — you see the story,
 * the plan, the change and the cost. A proof section citing an artifact that does not resolve would
 * be worse than no section at all.
 *
 * That is not hypothetical here. A shipped artifact referencing an unshipped one has bitten this
 * project repeatedly: App.tsx importing excluded presentation modules; the preflight skills list
 * naming an excluded skill; three agents importing a module that never existed; and the README
 * itself sending readers to a namespace excluded from the public mirror.
 *
 * So every artifact the section names is EXTRACTED at run time and resolved against the live repo.
 * Nothing is hardcoded, and each resolver carries a negative control, so an always-true resolver
 * fails rather than passing silently.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateIncludeArgs } from "../../packages/mcp-rks/src/server/publish.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

// Slice by INDEX, not regex. Two real traps live in the obvious regex form:
//   1. The \Z escape does not exist in JS. readme-public-launch-content.test.mjs:104 uses it and
//      silently degrades to a literal "Z" alternative; it only works because README has no "Z".
//   2. Under the /m flag the dollar anchor matches END OF LINE, not end of string, so a lookahead
//      of (?=^##\s+|<dollar>) terminates the slice at the very first newline.
// Index arithmetic has neither failure mode.
function sectionSlice(src, heading) {
  const start = src.indexOf(heading);
  if (start < 0) return "";
  const rest = src.slice(start + heading.length);
  const next = rest.search(/\n##\s+/);
  return heading + (next < 0 ? rest : rest.slice(0, next));
}

const section = sectionSlice(readme, "## What One Change Looks Like");

const storyExists = (id) =>
  fs.existsSync(path.join(REPO_ROOT, "notes", `${id}.md`)) ||
  fs.existsSync(
    path.join(REPO_ROOT, "notes", `${id.replace(/^backlog\./, "backlog.z_implemented.")}.md`),
  );

// AC3 — pure, string-only reader for `git rev-parse --is-shallow-repository` stdout. It
// spawns nothing and reads no file, so it is unit-testable directly. Only an explicit
// "false" means the checkout carries full history: a null, empty or unrecognised stdout
// is never read as "not shallow". The invocation's own success is established at the
// CALL SITE, not here.
const isShallowProbeOutput = (stdout) => (stdout ?? "").trim() !== "false";

const shaExists = (sha) =>
  spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
  }).status === 0;

// backlog.fix.published-tests-upstream-coupled — AC2.
//
// PARENTLESS is a DIFFERENT condition from SHALLOW, and conflating them is what let this
// class ship. The published mirror is a force-pushed single-commit snapshot with no parents,
// and such a repository is NOT shallow — `git rev-parse --is-shallow-repository` prints
// "false" there, so the shallow guard above passes and the cited shas then fail to resolve,
// producing the misleading "cited but not in history" message on a repo where no cited sha
// CAN resolve. Detect it explicitly instead.
//
// Pure, string-only reader over `git rev-list --count HEAD` stdout, mirroring the shallow
// reader's shape so it is unit-testable with no spawn. Exactly one commit means HEAD has no
// parents. The invocation's own success is established at the CALL SITE, never here.
const isParentlessCountOutput = (stdout) => (stdout ?? "").trim() === "1";

const gitProbe = (args) =>
  spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 });

// Evaluated once. A probe that could not RUN is never read as "history is present" — that
// default would resurrect the exact misreport this guard exists to prevent. Each branch
// names the topology as the cause and none of them blames the README.
const historyTopology = (() => {
  const shallow = gitProbe(["rev-parse", "--is-shallow-repository"]);
  const count = gitProbe(["rev-list", "--count", "HEAD"]);
  if (shallow.status !== 0 || count.status !== 0) {
    return {
      usable: false,
      reason: `git could not report repository topology (exits ${shallow.status}/${count.status})`,
    };
  }
  if (isShallowProbeOutput(shallow.stdout)) {
    return {
      usable: false,
      reason:
        "shallow clone — commits older than HEAD are absent from history; set fetch-depth: 0 on the checkout step",
    };
  }
  if (isParentlessCountOutput(count.stdout)) {
    return {
      usable: false,
      reason:
        "parentless single-commit repository (the published mirror snapshot) — no cited sha can resolve here. This is a property of the REPOSITORY, not of the README",
    };
  }
  return { usable: true, reason: "" };
})();

// AC3 — `notes/backlog.*.md` is on NO include pattern in publish-profiles.yaml, so the
// published snapshot carries notes/ (public, playbooks, ten how-to files, root) while having
// no backlog notes at all. The gate therefore keys on backlog-note AVAILABILITY: a
// "does notes/ exist" check would never fire on the mirror, because notes/ IS there.
const backlogNotesAvailable = (() => {
  try {
    return fs
      .readdirSync(path.join(REPO_ROOT, "notes"))
      .some((f) => f.startsWith("backlog.") && f.endsWith(".md"));
  } catch {
    return false;
  }
})();

describe("the worked example exists and is placed correctly", () => {
  it("is an H2 between Quick Start and The Permission Model", () => {
    expect(readme).toMatch(/^##\s+What One Change Looks Like/m);
    const qs = readme.indexOf("## Quick Start");
    const wo = readme.indexOf("## What One Change Looks Like");
    const pm = readme.indexOf("## The Permission Model");
    expect(qs).toBeGreaterThan(-1);
    expect(pm).toBeGreaterThan(-1);
    expect(qs).toBeLessThan(wo);
    expect(wo).toBeLessThan(pm);
  });

  it("POSITIVE CONTROL: the slice is non-empty and names all four artifacts", () => {
    expect(section.length).toBeGreaterThan(400);
    for (const marker of ["story", "plan", "change", "cost"]) {
      expect(section.toLowerCase()).toContain(marker);
    }
  });
});

describe("every artifact the section cites resolves", () => {
  it.skipIf(!backlogNotesAvailable)("every backlog story id it names exists on disk", () => {
    const ids = [...new Set([...section.matchAll(/\b(backlog\.[a-z0-9._-]+)/g)].map((m) => m[1]))];
    expect(ids.length, "the section must cite at least one real story").toBeGreaterThan(0);
    // NEGATIVE CONTROL — an always-true resolver must fail here.
    expect(storyExists("backlog.feat.this-story-does-not-exist")).toBe(false);
    const missing = ids.filter((id) => !storyExists(id));
    expect(missing, `story ids cited but not on disk: ${missing.join(", ")}`).toEqual([]);
  });

  it("AC3: the backlog gate keys on backlog-note availability, not on notes/ existing", () => {
    // This case ALWAYS runs, in every topology, because it is what proves the gate above is
    // condition-scoped rather than a blanket disable.
    //
    // The distinction is load-bearing: publish-profiles.yaml ships notes/public.**,
    // notes/playbooks.**, ten notes/how-to.* files, notes/root.md and notes/root.schema.yml,
    // but NO notes/backlog.* pattern. So on the mirror notes/ EXISTS while every cited
    // backlog note is absent, and a "does notes/ exist" gate would never fire there.
    const notesDirPresent = fs.existsSync(path.join(REPO_ROOT, "notes"));
    const backlogPresent = fs
      .readdirSync(path.join(REPO_ROOT, "notes"))
      .some((f) => f.startsWith("backlog.") && f.endsWith(".md"));

    // The two predicates are genuinely different questions — asserted, not assumed.
    expect(backlogNotesAvailable).toBe(backlogPresent);
    expect(notesDirPresent).toBe(true);

    // And the resolver still discriminates wherever it does run: a fabricated id must not
    // resolve, so the gate cannot have been satisfied by making storyExists always true.
    expect(storyExists("backlog.feat.this-story-does-not-exist")).toBe(false);
  });

  it("AC1: the unit-tests job checks out full history, and only that job", () => {
    const workflow = yaml.load(
      fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8"),
    );
    const checkoutOf = (job) =>
      workflow.jobs[job].steps.find(
        (s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout"),
      );
    // NON-VACUITY: all three jobs really do declare a checkout step to assert about.
    for (const job of ["unit-tests", "integration-tests", "e2e-tests"]) {
      expect(checkoutOf(job), `${job} declares no actions/checkout step`).toBeTruthy();
    }
    // Asserted against the PARSED workflow object, never a line number or line position.
    expect(checkoutOf("unit-tests").with?.["fetch-depth"]).toBe(0);
    // SCOPE CONTAINMENT: the edit did not spread to the other two byte-identical checkouts.
    expect(checkoutOf("integration-tests").with?.["fetch-depth"]).toBeUndefined();
    expect(checkoutOf("e2e-tests").with?.["fetch-depth"]).toBeUndefined();
  });

  it("AC3: the shallow-probe reader is pure and reads both directions", () => {
    // Both directions in one run — a predicate exercised on one input only, or one that
    // returns a constant, fails this pair. No spawn, no file read.
    expect(isShallowProbeOutput("true\n")).toBe(true);
    expect(isShallowProbeOutput("false\n")).toBe(false);
  });

  it.skipIf(!historyTopology.usable)("every commit sha it names exists in history", () => {
    // AC2 — reached ONLY when upstream history is genuinely present. The topology gate
    // (probe-failure / shallow / parentless) is evaluated once at module scope, and the case
    // below always runs and states the reason, so a skip here is never silent.
    const shas = [...new Set([...section.matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1]))];
    expect(shas.length, "the section must cite at least one real commit").toBeGreaterThan(0);
    // Controls preserved: the resolver must still discriminate, so the gate above cannot have
    // been satisfied by weakening shaExists into something always-true.
    expect(shaExists("HEAD")).toBe(true);
    expect(shaExists("0".repeat(40))).toBe(false);
    const unresolved = shas.filter((sha) => !shaExists(sha));
    expect(unresolved, `commit shas cited but not in history: ${unresolved.join(", ")}`).toEqual([]);
  });

  it("AC2: the topology gate states its reason and never blames the README", () => {
    // ALWAYS runs, in every topology. When the sha case above is skipped, THIS is where the
    // cause is stated — which is what makes the skip loud instead of silent.
    if (historyTopology.usable) {
      expect(historyTopology.reason).toBe("");
      return;
    }
    expect(
      historyTopology.reason,
      "a skipped sha check must state a repository-topology reason",
    ).not.toBe("");
    // The reason must name the REPOSITORY, never accuse the README of citing a bad sha. That
    // misdirection — a correct citation reported as a bad one — is the defect being fixed.
    expect(historyTopology.reason).toMatch(/repository|clone|history/i);
    expect(historyTopology.reason).not.toMatch(/cited but not in history/i);
  });

  it("AC2: parentless and shallow are INDEPENDENT conditions", () => {
    // The finding in one assertion pair: a genuine single-commit repository is NOT shallow.
    // That is exactly why the shallow guard alone did not catch the published mirror, and
    // why a second, differently-shaped probe has to exist.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-parentless-"));
    try {
      const run = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30_000 });
      run(["init", "-q"]);
      run(["config", "user.email", "portability@example.invalid"]);
      run(["config", "user.name", "portability"]);
      fs.writeFileSync(path.join(dir, "f.txt"), "x\n");
      run(["add", "f.txt"]);
      run(["commit", "-q", "-m", "single parentless commit"]);

      const shallow = run(["rev-parse", "--is-shallow-repository"]);
      const count = run(["rev-list", "--count", "HEAD"]);
      const parent = run(["rev-parse", "HEAD^"]);

      // Non-vacuity: the probes actually ran, so the readings below are observations.
      expect(shallow.status).toBe(0);
      expect(count.status).toBe(0);

      // The two probes DISAGREE on this repository, and the disagreement IS the point.
      expect(isShallowProbeOutput(shallow.stdout)).toBe(false);
      expect(isParentlessCountOutput(count.stdout)).toBe(true);
      // Corroborated by a third, independent signal: HEAD has no parent to resolve.
      expect(parent.status).not.toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AC2: the parentless reader is pure and reads both directions", () => {
    // Same shape as the shallow reader's pair. A predicate exercised on one input only, or
    // one that returns a constant, fails this.
    expect(isParentlessCountOutput("1\n")).toBe(true);
    expect(isParentlessCountOutput("2\n")).toBe(false);
    expect(isParentlessCountOutput("")).toBe(false);
    expect(isParentlessCountOutput(null)).toBe(false);
  });

  it("every repo path it names is present in the PUBLISHED tree", () => {
    const profile = yaml.load(
      fs.readFileSync(path.join(REPO_ROOT, ".routekit/publish-profiles.yaml"), "utf8"),
    ).profiles["rks-public"];
    const shipped = new Set(generateIncludeArgs(profile, REPO_ROOT));

    // NON-VACUITY: the derived set is real — it covers README.md and is plausibly sized.
    expect(shipped.has("README.md")).toBe(true);
    expect(shipped.size).toBeGreaterThan(500);

    // Anywhere in the section, not only inside backticks — a path inside a fenced plan excerpt
    // is exactly as much of a promise to the reader as one in inline code.
    const paths = [
      ...new Set(
        [...section.matchAll(/\b((?:packages|scripts|tests|notes|\.routekit)\/[\w./-]+\.(?:mjs|json|md|ts|tsx|js|yml|yaml))/g)].map(
          (m) => m[1],
        ),
      ),
    ];
    expect(paths.length, "the section must cite at least one real path").toBeGreaterThan(0);
    const unshipped = paths.filter((p) => !shipped.has(p));
    expect(
      unshipped,
      `paths cited in the README but absent from the tree a reader clones: ${unshipped.join(", ")}`,
    ).toEqual([]);
  });

  it("every git ref it names still resolves", () => {
    // A branch is NOT a durable citation: an off-rail branch is deleted by its own ship. This
    // README cited `off-rail/e1b511a7` after that branch had been deleted, and the sha-only
    // resolver above happily passed it. Commit shas are durable; refs must be checked or omitted.
    const refs = [
      ...new Set(
        [...section.matchAll(/`((?:off-rail|feature|fix|refactor|docs|chore)\/[\w.-]+)`/g)].map(
          (m) => m[1],
        ),
      ),
    ];
    const refExists = (ref) =>
      spawnSync("git", ["rev-parse", "--verify", ref], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 30_000,
      }).status === 0;
    // NEGATIVE CONTROL — an always-true resolver must fail here.
    expect(refExists("off-rail/definitely-not-a-branch")).toBe(false);
    const dead = refs.filter((r) => !refExists(r));
    expect(dead, `git refs cited in the README that no longer resolve: ${dead.join(", ")}`).toEqual([]);
  });

  it("names story ids as identifiers but never LINKS an unpublished note", () => {
    // notes/backlog.** and notes/canon.** are on no include list, so a link to either is a dead
    // link in the mirror — the exact defect the README already had.
    const links = [...section.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    const dead = links.filter(
      (l) => l.startsWith("notes/backlog.") || l.startsWith("notes/canon."),
    );
    expect(dead, `links to namespaces excluded from the mirror: ${dead.join(", ")}`).toEqual([]);
  });

  it("the cost fields it names are real fields of the cost report", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "packages/telemetry/src/cost-report.mjs"),
      "utf8",
    );
    for (const field of ["wasteRatio", "cacheRatio", "rawCost", "efficientCost"]) {
      if (section.includes(field)) {
        expect(src, `README quotes ${field} but cost-report.mjs no longer defines it`).toContain(
          field,
        );
      }
    }
    // POSITIVE CONTROL: the section really does quote at least one field.
    expect(section).toContain("wasteRatio");
  });

  it("figures are either traceable to a commit or marked as not measurements", () => {
    // Token figures cannot be recomputed from disk — telemetry is not in the published tree. So the
    // section must either carry a resolvable sha or state plainly that the figures are not
    // measurements. It must never present invented numbers as measured.
    const hasSha = [...section.matchAll(/`([0-9a-f]{7,40})`/g)].some((m) => shaExists(m[1]));
    const disclaims = /not measurements from this run/i.test(section);
    expect(hasSha || disclaims).toBe(true);
  });
});

describe("the insertion did not disturb what the existing witnesses pin", () => {
  it("Quick Start keeps its positive pins and its raw-MCP negatives", () => {
    const qs = sectionSlice(readme, "## Quick Start");
    expect(qs.length).toBeGreaterThan(200);
    for (const pin of ["Claude Code", "npm install", "npm run setup"]) {
      expect(qs).toContain(pin);
    }
    expect(qs).not.toMatch(/dendron_create_note\s*\{/);
    expect(qs).not.toMatch(/rks_plan\s*\{[^}]*projectId/);
  });

  it("adds no image or binary asset", () => {
    expect(section).not.toMatch(/!\[[^\]]*\]\(/);
    expect(section).not.toMatch(/\.(png|jpe?g|gif|svg|webp|mp4|cast)\b/i);
  });

  it("README still contains no MIT claim", () => {
    expect(readme).not.toMatch(/\bMIT\b/);
  });
});
