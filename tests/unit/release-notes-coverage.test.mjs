// backlog.feat.release-notes-account-for-released-stories: rks_release accounts for every story it
// releases. Read-only candidate set, id-free drafted notes, notesCoverage / notesExclusions, dryRun.
// spawnSync and runGit are mocked (vi.mock), so no real subprocess or network call is made.
// Fixture ids, titles and phrases are generic on purpose: tests/** reaches the public mirror.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })) };
});
vi.mock("../../packages/mcp-rks/src/server/git/git-utils.mjs", () => ({
  runGit: vi.fn(),
  getCurrentBranch: vi.fn(() => "staging"),
  isProductionBranch: vi.fn(() => false),
}));
vi.mock("../../packages/mcp-rks/src/server/publish.mjs", () => ({
  loadPublishProfiles: vi.fn(() => ({ profiles: {}, remotes: {} })),
  publish: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../packages/mcp-rks/src/server/guardrails-audit.mjs", () => ({
  isGuardrailsOffSession: vi.fn(() => true),
}));
vi.mock("../../packages/mcp-rks/src/workflow/auto-phase.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, advancePhase: vi.fn(actual.advancePhase) };
});

const { spawnSync } = await import("child_process");
const { runGit, getCurrentBranch } = await import("../../packages/mcp-rks/src/server/git/git-utils.mjs");
const { advancePhase } = await import("../../packages/mcp-rks/src/workflow/auto-phase.mjs");
const { ensureTelemetryStorage } = await import("@routekit/telemetry");
const { runRelease, listReleaseCandidates, draftReleaseNotes, extractChangelogEntry, buildReleaseNotesBrief, loadReleaseNotesDenylist } = await import("../../packages/mcp-rks/src/server/git/git-release.mjs");

const FAKE_ROOT = "/tmp/fake-project-release-notes-coverage";
const NOTES_DIR = path.join(FAKE_ROOT, "notes");
const VERSION = "1.0.1";
const BUMP_SUBJECT = `chore(release): ${VERSION}`;
const ALPHA = "backlog.feat.sample-alpha";
const BETA = "backlog.fix.sample-beta";
const GAMMA = "backlog.feat.sample-gamma";
const CHANGELOG = "- Alpha feature lands.\n- Beta fix and gamma tweak ship together.";
const FULL_COVERAGE = { [ALPHA]: "Alpha feature lands.", [BETA]: "Beta fix and gamma tweak", [GAMMA]: "Beta fix and gamma tweak" };

let overrides = [];
let resumeHead = false;
let branch = "staging";

function writeNote(id, phase, { title = "Sample title", desc = "Sample desc" } = {}) {
  const lines = ["---", `id: "${id}"`];
  if (title !== null) lines.push(`title: "${title}"`);
  if (desc !== null) lines.push(`desc: "${desc}"`);
  lines.push(`phase: "${phase}"`, "---", "", "body", "");
  fs.writeFileSync(path.join(NOTES_DIR, `${id}.md`), lines.join("\n"));
}
function writeThreeCandidates() {
  writeNote(ALPHA, "integrated", { title: "Alpha feature", desc: "lands" });
  writeNote(BETA, "integrated", { title: "Beta fix", desc: "ships" });
  writeNote(GAMMA, "integrated", { title: "Gamma tweak", desc: "ships" });
  writeNote("backlog.feat.sample-draft", "draft");
}
function snapshot() {
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
  const notes = Object.fromEntries(fs.readdirSync(NOTES_DIR).map((f) => [f, read(path.join(NOTES_DIR, f))]));
  return { pkg: read(path.join(FAKE_ROOT, "package.json")), changelog: read(path.join(FAKE_ROOT, "CHANGELOG.md")), notes };
}
function allGitCalls() {
  const viaSpawn = spawnSync.mock.calls.map(([cmd, args]) => ({ cmd, args }));
  const viaRunGit = runGit.mock.calls.map(([, args]) => ({ cmd: "git", args }));
  return [...viaSpawn, ...viaRunGit];
}
const MUTATING = (c) => c.cmd === "gh" || (c.cmd === "git" && ["fetch", "push", "commit", "merge", "tag", "checkout"].includes(c.args[0]));
const mutatingCalls = () => allGitCalls().filter(MUTATING);
const events = () => ensureTelemetryStorage(FAKE_ROOT).emit.mock.calls.map((c) => c[0]);
const release = (args = {}) => runRelease({ projectRoot: FAKE_ROOT, version: "patch", ...args });

beforeEach(() => {
  vi.clearAllMocks();
  overrides = [];
  resumeHead = false;
  branch = "staging";
  fs.rmSync(FAKE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.writeFileSync(path.join(FAKE_ROOT, "package.json"), JSON.stringify({ name: "test", version: "1.0.0" }, null, 2));
  getCurrentBranch.mockImplementation(() => branch);
  spawnSync.mockImplementation((cmd, args) => {
    for (const [match, res] of overrides) if (match(cmd, args)) return typeof res === "function" ? res() : res;
    if (cmd === "git" && args[0] === "rev-list" && args.includes("--left-right")) return { stdout: "0\t0", stderr: "", status: 0 };
    if (cmd === "gh" && args[0] === "run") return { stdout: JSON.stringify([{ status: "completed", conclusion: "success", headSha: "abc" }]), stderr: "", status: 0 };
    return { stdout: "", stderr: "", status: 0 };
  });
  runGit.mockImplementation((root, args) => {
    if (args[0] === "branch" && args[1] === "--show-current") return branch;
    if (args[0] === "log" && args[1] === "-1" && args[3] === "staging") return resumeHead ? BUMP_SUBJECT : "feat: something";
    if (args[0] === "log" && args[1] === "-1" && args[3] === "HEAD") return BUMP_SUBJECT;
    if (args[0] === "tag" && args[1] === "--list") return "";
    return "sha-default";
  });
});

describe("release notes candidate set and draft", () => {
  it("listReleaseCandidates returns the integrated backlog notes in readdir order with title and desc and writes nothing", () => {
    writeThreeCandidates();
    const before = snapshot();
    const expectedOrder = fs.readdirSync(NOTES_DIR).filter((f) => f.startsWith("backlog.") && f.endsWith(".md") && f !== "backlog.feat.sample-draft.md").map((f) => f.replace(/\.md$/, ""));
    const got = listReleaseCandidates(FAKE_ROOT);
    expect(got.map((c) => c.storyId)).toEqual(expectedOrder);
    expect(got.find((c) => c.storyId === ALPHA)).toEqual({ storyId: ALPHA, title: "Alpha feature", desc: "lands" });
    expect(snapshot()).toEqual(before);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("listReleaseCandidates returns an empty array when the notes directory is missing", () => {
    fs.rmSync(NOTES_DIR, { recursive: true, force: true });
    expect(listReleaseCandidates(FAKE_ROOT)).toEqual([]);
  });

  it("draftReleaseNotes writes one id-free line per candidate and a coverage map the draft satisfies", () => {
    const candidates = [{ storyId: ALPHA, title: "Alpha feature", desc: "lands" }, { storyId: BETA, title: "Beta fix", desc: "ships" }];
    const { text, coverage } = draftReleaseNotes(candidates);
    expect(text.split("\n")).toEqual(["### Added", "- Alpha feature: lands", "", "### Fixed", "- Beta fix: ships"]);
    for (const c of candidates) {
      expect(text).not.toContain(c.storyId);
      expect(text).toContain(coverage[c.storyId]);
    }
  });

  it("draftReleaseNotes falls back to desc-only, title-only and Untitled story lines and is empty for no candidates", () => {
    const { text } = draftReleaseNotes([
      { storyId: ALPHA, title: null, desc: "only a desc" },
      { storyId: BETA, title: "Only a title", desc: "" },
      { storyId: GAMMA, title: "", desc: null },
    ]);
    expect(text.split("\n")).toEqual(["### Added", "- only a desc", "- Untitled story 3", "", "### Fixed", "- Only a title"]);
    expect(draftReleaseNotes([])).toEqual({ text: "", coverage: {} });
  });
});

describe("release notes coverage gate", () => {
  it("refuses release_notes_incomplete for an unmapped candidate before any fetch, push, commit, merge, tag or gh call", async () => {
    writeThreeCandidates();
    const before = snapshot();
    const r = await release({ changelog: CHANGELOG, notesCoverage: { [ALPHA]: "Alpha feature lands." } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("release_notes_incomplete");
    expect(r.unaccountedStories).toEqual(listReleaseCandidates(FAKE_ROOT).map((c) => c.storyId).filter((id) => id !== ALPHA));
    expect(r.phrasesNotFound).toEqual([]);
    expect(mutatingCalls()).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it("refuses release_notes_incomplete without notesCoverage even when integration is ahead of origin, with no push", async () => {
    writeThreeCandidates();
    overrides.push([(c, a) => c === "git" && a[0] === "rev-list" && a.includes("--left-right"), { stdout: "0\t2", stderr: "", status: 0 }]);
    const r = await release({ changelog: CHANGELOG });
    expect(r.reason).toBe("release_notes_incomplete");
    expect(allGitCalls().filter((c) => c.cmd === "git" && c.args[0] === "push")).toEqual([]);
  });

  it("a phrase absent from the changelog, including a case-only difference, is listed in phrasesNotFound and refused", async () => {
    writeThreeCandidates();
    const r = await release({ changelog: CHANGELOG, notesCoverage: { ...FULL_COVERAGE, [ALPHA]: "  alpha feature lands.  " } });
    expect(r.reason).toBe("release_notes_incomplete");
    expect(r.unaccountedStories).toEqual([ALPHA]);
    expect(r.phrasesNotFound).toEqual([{ storyId: ALPHA, phrase: "alpha feature lands." }]);
    expect(mutatingCalls()).toEqual([]);
  });

  it("one phrase covers several stories and no story id has to appear in the changelog", async () => {
    writeThreeCandidates();
    const r = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
    expect(r.ok, r.error).toBe(true);
    for (const id of [ALPHA, BETA, GAMMA]) expect(CHANGELOG).not.toContain(id);
  });

  it("a fully accounted release publishes changelog.trim() byte-identically and returns notesCoverage and notesExcludedStories", async () => {
    writeThreeCandidates();
    const notesExclusions = [{ storyId: GAMMA, reason: " internal only " }];
    const notesCoverage = { [ALPHA]: FULL_COVERAGE[ALPHA], [BETA]: FULL_COVERAGE[BETA] };
    const r = await release({ changelog: `\n${CHANGELOG}\n`, notesCoverage, notesExclusions });
    expect(r.ok, r.error).toBe(true);
    expect(fs.readFileSync(path.join(FAKE_ROOT, "CHANGELOG.md"), "utf8")).toContain(CHANGELOG);
    const ghNotes = spawnSync.mock.calls.filter(([cmd, args]) => cmd === "gh" && args.includes("--notes")).map(([, args]) => args[args.indexOf("--notes") + 1]);
    for (const n of ghNotes) expect(n).toBe(CHANGELOG);
    expect(r.notesCoverage).toEqual(notesCoverage);
    expect(r.notesExcludedStories).toEqual([{ storyId: GAMMA, reason: "internal only" }]);
  });

  it("release.complete appends notesCoverage then notesExcludedStories after the existing fields only when non-empty", async () => {
    writeThreeCandidates();
    await release({ changelog: CHANGELOG, notesCoverage: { [ALPHA]: FULL_COVERAGE[ALPHA], [BETA]: FULL_COVERAGE[BETA] }, notesExclusions: [{ storyId: GAMMA, reason: "internal only" }] });
    const collector = ensureTelemetryStorage(FAKE_ROOT);
    const payload = collector.emit.mock.calls.find((c) => c[0] === "release.complete")[2];
    expect(Object.keys(payload).slice(-2)).toEqual(["notesCoverage", "notesExcludedStories"]);
    fs.rmSync(NOTES_DIR, { recursive: true, force: true });
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    fs.rmSync(path.join(FAKE_ROOT, "CHANGELOG.md"), { force: true });
    vi.clearAllMocks();
    await release({ changelog: CHANGELOG });
    const bare = collector.emit.mock.calls.find((c) => c[0] === "release.complete")[2];
    expect(bare).not.toHaveProperty("notesCoverage");
    expect(bare).not.toHaveProperty("notesExcludedStories");
  });

  it("malformed notesCoverage, malformed notesExclusions and a story in both are refused on fresh and resumed runs", async () => {
    writeThreeCandidates();
    for (const resumed of [false, true]) {
      resumeHead = resumed;
      for (const notesCoverage of [[], { "": "x" }, { [ALPHA]: 3 }, { [ALPHA]: "   " }]) {
        expect((await release({ changelog: CHANGELOG, notesCoverage })).reason).toBe("notes_coverage_invalid");
      }
      for (const notesExclusions of [{}, [{ storyId: "", reason: "r" }], [{ storyId: ALPHA, reason: " " }], [{ storyId: ALPHA, reason: "r" }, { storyId: ALPHA, reason: "s" }]]) {
        expect((await release({ changelog: CHANGELOG, notesExclusions })).reason).toBe("notes_exclusions_invalid");
      }
      const both = await release({ changelog: CHANGELOG, notesCoverage: { [ALPHA]: "Alpha" }, notesExclusions: [{ storyId: ALPHA, reason: "r" }] });
      expect(both.reason).toBe("notes_coverage_invalid");
      expect(both.error).toContain(ALPHA);
    }
    expect(mutatingCalls()).toEqual([]);
  });

  it("a notesCoverage or notesExclusions storyId that is not a candidate is refused with unknownStories", async () => {
    writeThreeCandidates();
    const stale = "backlog.feat.sample-not-released";
    const a = await release({ changelog: CHANGELOG, notesCoverage: { ...FULL_COVERAGE, [stale]: "Alpha" } });
    expect(a.reason).toBe("notes_coverage_invalid");
    expect(a.unknownStories).toEqual([stale]);
    const b = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE, notesExclusions: [{ storyId: stale, reason: "r" }] });
    expect(b.reason).toBe("notes_exclusions_invalid");
    expect(b.unknownStories).toEqual([stale]);
    expect(mutatingCalls()).toEqual([]);
  });

  it("a fresh release with no changelog and no notesOverride still refuses release_notes_missing", async () => {
    writeThreeCandidates();
    const r = await release();
    expect(r.reason).toBe("release_notes_missing");
    expect(mutatingCalls()).toEqual([]);
  });

  it("a candidate whose phase advance fails is named in an appended result.warning", async () => {
    writeThreeCandidates();
    advancePhase.mockImplementationOnce(async () => { throw new Error("simulated advance failure"); });
    const r = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
    expect(r.ok, r.error).toBe(true);
    const failedId = listReleaseCandidates(FAKE_ROOT).length ? listReleaseCandidates(FAKE_ROOT)[0].storyId : null;
    expect(failedId).not.toBeNull();
    expect(r.warning).toContain(failedId);
    expect(r.releasedStories).not.toContain(failedId);
  });
});

describe("release notes coverage on waiver and resume", () => {
  it("an applied notesOverride skips the coverage checks and appends an ignored-input warning", async () => {
    writeThreeCandidates();
    const r = await release({ notesOverride: { enabled: true, reason: "hotfix" }, notesCoverage: { [ALPHA]: "Alpha" } });
    expect(r.ok, r.error).toBe(true);
    expect(fs.readFileSync(path.join(FAKE_ROOT, "CHANGELOG.md"), "utf8")).toContain("Release notes waived: hotfix");
    expect(r.warning).toMatch(/notesCoverage/);
  });

  it("changelog plus notesOverride still runs the coverage checks", async () => {
    writeThreeCandidates();
    const r = await release({ changelog: CHANGELOG, notesOverride: { enabled: true, reason: "hotfix" } });
    expect(r.reason).toBe("release_notes_incomplete");
  });

  it("a resumed release runs no coverage check and appends an ignored-input warning naming the resumed version", async () => {
    writeThreeCandidates();
    resumeHead = true;
    fs.writeFileSync(path.join(FAKE_ROOT, "CHANGELOG.md"), `# Changelog\n\n## [${VERSION}] - 2026-11-11\n\n- Committed entry.\n\n## [1.0.0] - 2026-11-01\n\n- Older notes.\n\n`);
    const r = await release({ notesCoverage: { [ALPHA]: "not in the committed entry" } });
    expect(r.reason).not.toBe("release_notes_incomplete");
    expect(r.warning).toContain(VERSION);
    expect(r.warning).toMatch(/notesCoverage/);
  });
});

// backlog.fix.release-notes-coverage-review-followups
function writeRawNote(id, frontmatterLines) {
  fs.writeFileSync(path.join(NOTES_DIR, `${id}.md`), ["---", `id: "${id}"`, ...frontmatterLines, "---", "", "body", ""].join("\n"));
}
const candidateById = (id) => listReleaseCandidates(FAKE_ROOT).find((c) => c.storyId === id);
const COMMITTED_CHANGELOG = `# Changelog\n\n## [${VERSION}] - 2026-11-11\n\n- Committed entry.\n\n## [1.0.0] - 2026-11-01\n\n- Older notes.\n\n`;
const SHIP_HANDLER = path.resolve(import.meta.dirname, "../../packages/mcp-rks/src/server/handlers/ship.mjs");

describe("release notes coverage review follow-ups", () => {
  it("listReleaseCandidates collapses a folded block scalar desc to one space-joined line without absorbing the next key", () => {
    writeRawNote(ALPHA, ['title: "Alpha feature"', "desc: >-", "  First folded line", "  second folded line", 'phase: "integrated"']);
    const c = candidateById(ALPHA);
    expect(c).toEqual({ storyId: ALPHA, title: "Alpha feature", desc: "First folded line second folded line" });
    expect(c.desc).not.toContain("phase");
  });

  it("listReleaseCandidates collapses a literal block scalar title to one space-joined line", () => {
    writeRawNote(ALPHA, ["title: |", "  Literal title line one", "  literal title line two", 'desc: "lands"', 'phase: "integrated"']);
    expect(candidateById(ALPHA)).toEqual({ storyId: ALPHA, title: "Literal title line one literal title line two", desc: "lands" });
  });

  it("listReleaseCandidates recognizes block scalar headers with a chomping indicator or an indentation digit", () => {
    writeRawNote(ALPHA, ["title: >+", "  Keep chomped", "  title text", "desc: |2", "    Indented desc", "    second part", 'phase: "integrated"']);
    writeRawNote(BETA, ["title: |-", "  Strip chomped title", "desc: >2-", "  Digit then chomp", "  desc", 'phase: "integrated"']);
    expect(candidateById(ALPHA)).toEqual({ storyId: ALPHA, title: "Keep chomped title text", desc: "Indented desc second part" });
    expect(candidateById(BETA)).toEqual({ storyId: BETA, title: "Strip chomped title", desc: "Digit then chomp desc" });
  });

  it("listReleaseCandidates returns null for an empty block scalar title or desc", () => {
    writeRawNote(ALPHA, ["title: |", "desc: >-", 'phase: "integrated"']);
    expect(candidateById(ALPHA)).toEqual({ storyId: ALPHA, title: null, desc: null });
    expect(draftReleaseNotes([candidateById(ALPHA)]).text).toBe("### Added\n- Untitled story 1");
  });

  it("listReleaseCandidates leaves quoted and plain single-line values unchanged", () => {
    writeRawNote(ALPHA, ['title: "Quoted title"', "desc:   plain desc value   ", 'phase: "integrated"']);
    writeRawNote(BETA, ["title: 'Single quoted title'", 'desc: "a | pipe and > sign inside"', 'phase: "integrated"']);
    expect(candidateById(ALPHA)).toEqual({ storyId: ALPHA, title: "Quoted title", desc: "plain desc value" });
    expect(candidateById(BETA)).toEqual({ storyId: BETA, title: "Single quoted title", desc: "a | pipe and > sign inside" });
  });

  it("listReleaseCandidates stays read-only over block scalar notes", () => {
    writeRawNote(ALPHA, ['title: "Alpha feature"', "desc: >-", "  First folded line", "  second folded line", 'phase: "integrated"']);
    writeRawNote(BETA, ["title: |", "  Literal title", 'desc: "ships"', 'phase: "integrated"']);
    const before = snapshot();
    expect(listReleaseCandidates(FAKE_ROOT)).toHaveLength(2);
    expect(snapshot()).toEqual(before);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("draftReleaseNotes over block scalar candidates emits one indicator-free line per candidate and its coverage occurs in the text", () => {
    writeRawNote(ALPHA, ['title: "Alpha feature"', "desc: >-", "  First folded line", "  second folded line", 'phase: "integrated"']);
    writeRawNote(BETA, ["title: |", "  Literal title", "desc: >+", "  Kept desc", 'phase: "integrated"']);
    writeRawNote(GAMMA, ["title: |2", "  Digit title", 'phase: "integrated"']);
    const candidates = listReleaseCandidates(FAKE_ROOT);
    expect(candidates).toHaveLength(3);
    const { text, coverage } = draftReleaseNotes(candidates);
    const lines = text.split("\n");
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(candidates.length);
    for (const line of lines) {
      expect(line).not.toContain(">-");
      expect(line).not.toMatch(/(^|\s)\|(\s|$)/);
      expect(line).not.toMatch(/(^|\s)[|>][+-]?\d?[+-]?(\s|$)/);
    }
    for (const c of candidates) expect(text).toContain(coverage[c.storyId]);
  });

  it("resume Row 1 with notesCoverage returns resumed true and an ignored-input warning naming the version", async () => {
    writeThreeCandidates();
    resumeHead = true;
    fs.writeFileSync(path.join(FAKE_ROOT, "CHANGELOG.md"), COMMITTED_CHANGELOG);
    overrides.push([(c, a) => c === "git" && a[0] === "ls-remote" && a.includes("--tags"), { stdout: `abc123\trefs/tags/v${VERSION}\n`, stderr: "", status: 0 }]);
    const r = await release({ notesCoverage: { [ALPHA]: "not in the committed entry" } });
    expect(r.ok, r.error).toBe(true);
    expect(r.resumed).toBe(true);
    expect(r.warning).toContain(VERSION);
    expect(r.warning).toContain("notesCoverage");
    const tagFetches = allGitCalls().filter((c) => c.cmd === "git" && c.args[0] === "fetch" && c.args[1] === "origin" && c.args[2] === "tag");
    expect(tagFetches.map((c) => c.args)).toEqual([["fetch", "origin", "tag", `v${VERSION}`]]);
  });

  it("a dryRun on a resumed HEAD returns resumed true, the bump version and the committed entry with no mutating call", async () => {
    writeThreeCandidates();
    resumeHead = true;
    fs.writeFileSync(path.join(FAKE_ROOT, "CHANGELOG.md"), COMMITTED_CHANGELOG);
    // package.json would bump to 1.0.1 too; make it differ so the version must come from the bump subject.
    fs.writeFileSync(path.join(FAKE_ROOT, "package.json"), JSON.stringify({ name: "test", version: "3.4.5" }, null, 2));
    const entry = extractChangelogEntry(FAKE_ROOT, VERSION);
    expect(entry).not.toBeNull();
    const r = await release({ dryRun: true });
    expect(r).toMatchObject({ ok: true, dryRun: true, resumed: true, version: VERSION, committedEntry: entry });
    expect(mutatingCalls()).toEqual([]);
  });

  it("a refusing dryRun emits no release.failed or other release telemetry event", async () => {
    writeThreeCandidates();
    const refusals = [
      () => { branch = "feature/sample"; return release({ dryRun: true }); },
      () => release({ dryRun: true, notesCoverage: [] }),
      () => release({ dryRun: true, notesExclusions: {} }),
      () => release({ dryRun: true, notesOverride: { enabled: true, reason: " " } }),
    ];
    for (const run of refusals) {
      vi.clearAllMocks();
      branch = "staging";
      const r = await run();
      expect(r.ok).toBe(false);
      expect(events().filter((e) => e.startsWith("release."))).toEqual([]);
    }
    // Positive control: the same wrong-branch refusal without dryRun does emit release.failed.
    vi.clearAllMocks();
    branch = "feature/sample";
    expect((await release({})).ok).toBe(false);
    expect(events()).toContain("release.failed");
  });

  it("the ship.mjs comment names zod as the value-type check and no longer says runRelease validates the types", () => {
    const src = fs.readFileSync(SHIP_HANDLER, "utf8");
    expect(src).not.toContain("runRelease validates them and refuses with notes_coverage_invalid");
    const zodComment = src.split("\n").filter((l) => /^\s*\/\//.test(l) && /\bzod\b/.test(l) && l.includes("notesCoverage") && l.includes("notesExclusions"));
    expect(zodComment.length).toBeGreaterThan(0);
    expect(zodComment.some((l) => /value type/.test(l))).toBe(true);
  });

  it("the failed-transition warning on a coverage release names the failed id without saying the notes counted it", async () => {
    writeThreeCandidates();
    const failedId = listReleaseCandidates(FAKE_ROOT)[0].storyId;
    advancePhase.mockImplementationOnce(async () => { throw new Error("simulated advance failure"); });
    const r = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
    expect(r.ok, r.error).toBe(true);
    expect(r.releasedStories).not.toContain(failedId);
    expect(r.warning).toContain(failedId);
    expect(r.warning).not.toContain("counted by the release notes");
  });

  it("the failed-transition warning on a notesOverride waiver release names the failed id without saying the notes counted it", async () => {
    writeThreeCandidates();
    const failedId = listReleaseCandidates(FAKE_ROOT)[0].storyId;
    advancePhase.mockImplementationOnce(async () => { throw new Error("simulated advance failure"); });
    const r = await release({ notesOverride: { enabled: true, reason: "hotfix" } });
    expect(r.ok, r.error).toBe(true);
    expect(fs.readFileSync(path.join(FAKE_ROOT, "CHANGELOG.md"), "utf8")).toContain("Release notes waived: hotfix");
    expect(r.releasedStories).not.toContain(failedId);
    expect(r.warning).toContain(failedId);
    expect(r.warning).not.toContain("counted by the release notes");
  });
});

// backlog.fix.release-candidates-phase-read-from-frontmatter: candidacy is decided by the
// frontmatter phase only. A story's own @@SEARCH/@@REPLACE text can hold a column-0 phase line.
const BODY_LINE = "backlog.chore.sample-body-line";
const BODY_LINE_BODY = ["@@SEARCH", "phase: draft", "@@REPLACE", "phase: integrated", "@@END"].join("\n");
function writeRawNoteFile(id, text) {
  fs.writeFileSync(path.join(NOTES_DIR, `${id}.md`), text);
}
function writeNoteWithBody(id, frontmatterLines, body) {
  writeRawNoteFile(id, ["---", `id: "${id}"`, ...frontmatterLines, "---", "", body, ""].join("\n"));
}
function writeBodyLineNote() {
  writeNoteWithBody(BODY_LINE, ['title: "Sample body line"', 'desc: "Already released"', 'phase: "released"', 'releasedIn: "0.1.0"'], BODY_LINE_BODY);
}

describe("release candidates read phase from frontmatter only", () => {
  it("a released note whose body holds a column-0 phase integrated line is not a candidate", () => {
    writeBodyLineNote();
    expect(fs.readFileSync(path.join(NOTES_DIR, `${BODY_LINE}.md`), "utf8")).toMatch(/^phase: integrated$/m);
    expect(listReleaseCandidates(FAKE_ROOT).map((c) => c.storyId)).not.toContain(BODY_LINE);
  });

  it("a dryRun omits the body-line note and the coverage gate reports its notesCoverage entry as unknown", async () => {
    writeThreeCandidates();
    writeBodyLineNote();
    const coverage = { ...FULL_COVERAGE, [BODY_LINE]: "Alpha feature lands." };
    const dry = await release({ dryRun: true, changelog: CHANGELOG, notesCoverage: coverage });
    expect(dry.ok, dry.error).toBe(true);
    expect(dry.stories.map((c) => c.storyId)).not.toContain(BODY_LINE);
    expect(dry.coverage.unknownStories).toContain(BODY_LINE);
    vi.clearAllMocks();
    const r = await release({ changelog: CHANGELOG, notesCoverage: coverage });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("notes_coverage_invalid");
    expect(r.unknownStories).toContain(BODY_LINE);
    expect(mutatingCalls()).toEqual([]);
  });

  it("a fresh release with a body-line note present transitions only the frontmatter-integrated candidates and does not warn about it", async () => {
    writeThreeCandidates();
    writeBodyLineNote();
    const bodyLinePath = path.join(NOTES_DIR, `${BODY_LINE}.md`);
    const before = fs.readFileSync(bodyLinePath, "utf8");
    const r = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
    expect(r.ok, r.error).toBe(true);
    expect([...r.releasedStories].sort()).toEqual([ALPHA, BETA, GAMMA].sort());
    expect(advancePhase.mock.calls.map((c) => c[1])).not.toContain(BODY_LINE);
    expect(fs.readFileSync(bodyLinePath, "utf8")).toBe(before);
    expect(r.warning || "").not.toContain(BODY_LINE);
  });

  it("an unquoted, double-quoted or single-quoted frontmatter phase integrated is a candidate with title and desc", () => {
    const forms = { "backlog.feat.sample-unquoted": "phase: integrated", "backlog.feat.sample-double": 'phase: "integrated"', "backlog.feat.sample-single": "phase: 'integrated'" };
    for (const [id, line] of Object.entries(forms)) writeNoteWithBody(id, [`title: "T ${id}"`, `desc: "D ${id}"`, line], "body");
    const got = listReleaseCandidates(FAKE_ROOT);
    for (const id of Object.keys(forms)) {
      expect(got.find((c) => c.storyId === id), id).toMatchObject({ storyId: id, title: `T ${id}`, desc: `D ${id}` });
    }
  });

  it("a phase key with integrated on the next line is not a candidate", () => {
    const id = "backlog.feat.sample-split-line";
    writeRawNoteFile(id, ["---", `id: "${id}"`, 'title: "Split"', "phase:", "integrated", "---", "", "body", ""].join("\n"));
    expect(listReleaseCandidates(FAKE_ROOT).map((c) => c.storyId)).not.toContain(id);
  });

  it("a note with no frontmatter block or a draft frontmatter phase is not a candidate despite a body phase integrated line", () => {
    const noFm = "backlog.feat.sample-no-frontmatter";
    const draft = "backlog.feat.sample-draft-body-line";
    writeRawNoteFile(noFm, ["# No frontmatter", "", "phase: integrated", ""].join("\n"));
    writeNoteWithBody(draft, ['title: "Draft"', 'phase: "draft"'], BODY_LINE_BODY);
    const ids = listReleaseCandidates(FAKE_ROOT).map((c) => c.storyId);
    expect(ids).not.toContain(noFm);
    expect(ids).not.toContain(draft);
  });

  it("a thrown transition failure warning names the story and the thrown message", async () => {
    writeThreeCandidates();
    const failedId = listReleaseCandidates(FAKE_ROOT)[0].storyId;
    advancePhase.mockImplementationOnce(async () => { throw new Error("simulated thrown failure"); });
    const r = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
    expect(r.ok, r.error).toBe(true);
    expect(r.warning).toContain(failedId);
    expect(r.warning).toContain("simulated thrown failure");
    expect(r.warning).not.toContain("at phase integrated");
  });

  it("an advancePhase ok false transition failure warning names the story and the returned error", async () => {
    writeThreeCandidates();
    const failedId = listReleaseCandidates(FAKE_ROOT)[0].storyId;
    advancePhase.mockImplementationOnce(async () => ({ ok: false, error: "simulated returned error" }));
    const r = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
    expect(r.ok, r.error).toBe(true);
    expect(r.releasedStories).not.toContain(failedId);
    expect(r.warning).toContain(failedId);
    expect(r.warning).toContain("simulated returned error");
  });

  it("a fresh release whose transitions all succeed names no candidate in result.warning", async () => {
    writeThreeCandidates();
    const r = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
    expect(r.ok, r.error).toBe(true);
    for (const id of [ALPHA, BETA, GAMMA]) expect(r.warning || "").not.toContain(id);
  });
});

// backlog.feat.release-notes-brief-and-leak-gate: the dry run returns a grouped brief, and a fresh
// release refuses published text carrying a story id or a denylisted term. The denylist term used
// here is synthetic on purpose; no test names a person.
const TERM = "Quuxbertine";
const TERM2 = "Zorvathi";
const CHORE = "backlog.chore.sample-chore";
const DESC_WITH_ID_1 = "S0 of the sample sequence: drop the unused provider, and close the stale backlog.fix.sample-provider-inference.";
const DESC_WITH_ID_2 = "Measure four bindings and record a decision note naming one. Prerequisite for backlog.feat.sample-kernel-held.";
const DENIED_EVENT = () => ensureTelemetryStorage(FAKE_ROOT).emit.mock.calls.filter((c) => c[0] === "release.failed").map((c) => c[2]);
function writeProjectJson(obj) {
  fs.mkdirSync(path.join(FAKE_ROOT, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(FAKE_ROOT, ".rks", "project.json"), JSON.stringify(obj));
}
const phasesOf = () => fs.readdirSync(NOTES_DIR).map((f) => fs.readFileSync(path.join(NOTES_DIR, f), "utf8").match(/^phase: .*$/m)?.[0]);
const expectNoMutation = (phasesBefore) => {
  expect(mutatingCalls()).toEqual([]);
  expect(phasesOf()).toEqual(phasesBefore);
};

describe("release notes brief and leak gate", () => {
  beforeEach(() => { vi.stubEnv("RKS_RELEASE_NOTES_DENYLIST", undefined); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("AC1 notesBrief groups follow Added, Changed, Fixed, Internal, omit empty groups and default by story type", async () => {
    writeNote(ALPHA, "integrated", { title: "Alpha feature", desc: "lands" });
    writeNote(BETA, "integrated", { title: "Beta fix", desc: "ships" });
    writeNote(CHORE, "integrated", { title: "Chore", desc: "tidies" });
    const r = await release({ dryRun: true });
    expect(r.ok, r.error).toBe(true);
    expect(r.notesBrief.map((g) => g.group)).toEqual(["Added", "Fixed", "Internal"]);
    const groupOf = (id) => r.notesBrief.find((g) => g.items.some((it) => it.storyId === id)).group;
    expect(groupOf(ALPHA)).toBe("Added");
    expect(groupOf(BETA)).toBe("Fixed");
    expect(groupOf(CHORE)).toBe("Internal");
  });

  it("AC1 notesBrief items are sorted by storyId within a group", async () => {
    writeNote(GAMMA, "integrated", { title: "Gamma", desc: "g" });
    writeNote(ALPHA, "integrated", { title: "Alpha", desc: "a" });
    writeNote("backlog.feat.sample-aaa", "integrated", { title: "First", desc: "f" });
    const r = await release({ dryRun: true });
    const ids = r.notesBrief.find((g) => g.group === "Added").items.map((it) => it.storyId);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(["backlog.feat.sample-aaa", ALPHA, GAMMA]);
  });

  it("AC2 releaseNotesGroup Changed overrides the default group", async () => {
    writeRawNote(ALPHA, ['title: "Alpha"', 'desc: "a"', 'phase: "integrated"', "releaseNotesGroup: Changed"]);
    const r = await release({ dryRun: true });
    expect(r.notesBrief).toEqual([expect.objectContaining({ group: "Changed" })]);
    expect(r.notesBrief[0].items[0]).toMatchObject({ storyId: ALPHA, group: "Changed" });
  });

  it("AC2 an invalid releaseNotesGroup falls back to the default group and is reported on the item", async () => {
    writeRawNote(BETA, ['title: "Beta"', 'desc: "b"', 'phase: "integrated"', "releaseNotesGroup: Sideways"]);
    const r = await release({ dryRun: true });
    expect(r.notesBrief[0].group).toBe("Fixed");
    expect(r.notesBrief[0].items[0].invalidReleaseNotesGroup).toBe("Sideways");
  });

  it("AC3 brief items carry storyId, group, title, desc and leaks, with a desc story id in leaks", () => {
    const brief = buildReleaseNotesBrief([{ storyId: ALPHA, title: "Alpha", desc: "follows backlog.fix.some-story closely" }]);
    const item = brief[0].items[0];
    for (const k of ["storyId", "group", "title", "desc", "leaks"]) expect(item).toHaveProperty(k);
    expect(item.leaks).toEqual([{ kind: "storyId", id: "backlog.fix.some-story", field: "desc" }]);
  });

  it("AC3 a denylisted synthetic term in a title or desc is reported in leaks", () => {
    const terms = [{ term: TERM, source: "env", index: 0 }];
    const brief = buildReleaseNotesBrief([{ storyId: ALPHA, title: `Work for ${TERM.toLowerCase()}`, desc: "plain" }], terms);
    expect(brief[0].items[0].leaks).toEqual([{ kind: "deniedTerm", source: "env", index: 0, field: "title" }]);
    expect(JSON.stringify(brief[0].items[0].leaks)).not.toContain(TERM);
  });

  it("AC4 notesDraft over story-id descs carries no story id token and renders fixed-order group headings", async () => {
    writeNote("backlog.chore.sample-providers", "integrated", { title: "Make providers truthful", desc: DESC_WITH_ID_1 });
    writeNote("backlog.design.sample-spike", "integrated", { title: "Pick the lock binding", desc: DESC_WITH_ID_2 });
    writeNote(ALPHA, "integrated", { title: "Alpha feature", desc: "lands" });
    const r = await release({ dryRun: true });
    expect(r.notesDraft).not.toMatch(/\bbacklog\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    const lines = r.notesDraft.split("\n");
    expect(lines.filter((l) => l.startsWith("### "))).toEqual(["### Added", "### Internal"]);
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(3);
  });

  it("AC4 notesDraft with coverageDraft over story-id descs passes every notes check on a real release", async () => {
    writeNote("backlog.chore.sample-providers", "integrated", { title: "Make providers truthful", desc: DESC_WITH_ID_1 });
    writeNote("backlog.design.sample-spike", "integrated", { title: "Pick the lock binding", desc: DESC_WITH_ID_2 });
    const dry = await release({ dryRun: true });
    vi.clearAllMocks();
    const r = await release({ changelog: dry.notesDraft, notesCoverage: dry.coverageDraft });
    expect(r.ok, r.error).toBe(true);
  });

  it("AC5 a changelog story id is refused with release_notes_story_id naming id and line, before any mutation", async () => {
    writeThreeCandidates();
    const before = phasesOf();
    const changelog = `${CHANGELOG}\n- Also see backlog.fix.sample-beta for details.`;
    const r = await release({ changelog, notesCoverage: FULL_COVERAGE });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("release_notes_story_id");
    expect(r.storyIdLeaks).toEqual([{ id: "backlog.fix.sample-beta", line: 3 }]);
    expect(r.error).toContain("backlog.fix.sample-beta (line 3)");
    expectNoMutation(before);
  });

  it("AC6 a project.json denylist term in any letter case is refused with release_notes_denied_term and never echoed", async () => {
    writeThreeCandidates();
    writeProjectJson({ releaseNotes: { denylist: [TERM] } });
    const before = phasesOf();
    const r = await release({ changelog: `${CHANGELOG}\n- Thanks to ${TERM.toUpperCase()}.`, notesCoverage: FULL_COVERAGE });
    expect(r.reason).toBe("release_notes_denied_term");
    expect(r.deniedTerms).toEqual([{ source: "project.json", index: 0, line: 3 }]);
    expect(JSON.stringify(r).toLowerCase()).not.toContain(TERM.toLowerCase());
    const failed = DENIED_EVENT();
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed).toLowerCase()).not.toContain(TERM.toLowerCase());
    expectNoMutation(before);
  });

  it("AC6 an RKS_RELEASE_NOTES_DENYLIST environment term is refused and identified by source, index and line", async () => {
    writeThreeCandidates();
    vi.stubEnv("RKS_RELEASE_NOTES_DENYLIST", `${TERM2},${TERM}`);
    const r = await release({ changelog: `- Line one.\n${CHANGELOG}\n- ${TERM} helped.`, notesCoverage: FULL_COVERAGE });
    expect(r.reason).toBe("release_notes_denied_term");
    expect(r.deniedTerms).toEqual([{ source: "env", index: 1, line: 4 }]);
    expect(r.error).toContain("env entry 1 on line 4");
    expect(JSON.stringify(r)).not.toContain(TERM);
  });

  it("AC6 an RKS_RELEASE_NOTES_DENYLIST term from the project .env file is refused", async () => {
    writeThreeCandidates();
    fs.writeFileSync(path.join(FAKE_ROOT, ".env"), `# local\nOTHER=1\nRKS_RELEASE_NOTES_DENYLIST="${TERM}"\n`);
    const r = await release({ changelog: `${CHANGELOG}\n- ${TERM}.`, notesCoverage: FULL_COVERAGE });
    expect(r.reason).toBe("release_notes_denied_term");
    expect(r.deniedTerms[0].source).toBe(".env");
  });

  it("AC7 a notesOverride reason with a story id or denied term is refused before any mutation", async () => {
    writeThreeCandidates();
    const before = phasesOf();
    const a = await release({ notesOverride: { enabled: true, reason: "hotfix for backlog.fix.sample-beta" } });
    expect(a.reason).toBe("release_notes_story_id");
    expectNoMutation(before);
    vi.clearAllMocks();
    vi.stubEnv("RKS_RELEASE_NOTES_DENYLIST", TERM);
    const b = await release({ notesOverride: { enabled: true, reason: `hotfix asked by ${TERM}` } });
    expect(b.reason).toBe("release_notes_denied_term");
    expect(JSON.stringify(b)).not.toContain(TERM);
    expectNoMutation(before);
  });

  it("AC8 a malformed denylist is refused with release_notes_denylist_invalid before any mutation", async () => {
    writeThreeCandidates();
    const before = phasesOf();
    for (const [denylist, problem] of [["not-an-array", "not_an_array"], [[TERM, 7], "non_string_entry"], [[TERM, "  "], "blank_entry"]]) {
      vi.clearAllMocks();
      writeProjectJson({ releaseNotes: { denylist } });
      const r = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
      expect(r.reason).toBe("release_notes_denylist_invalid");
      expect(r.denylistSource).toBe("project.json");
      expect(r.denylistProblem).toBe(problem);
      expectNoMutation(before);
    }
  });

  it("AC8 an absent denylist is not an error", async () => {
    writeThreeCandidates();
    const r = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
    expect(r.ok, r.error).toBe(true);
  });

  it("AC9 a dryRun reports storyIdLeaks and deniedTerms in coverage without refusing", async () => {
    writeThreeCandidates();
    vi.stubEnv("RKS_RELEASE_NOTES_DENYLIST", TERM);
    const r = await release({ dryRun: true, changelog: `${CHANGELOG}\n- See backlog.fix.sample-beta and ${TERM}.`, notesCoverage: FULL_COVERAGE });
    expect(r.ok, r.error).toBe(true);
    expect(r.coverage.storyIdLeaks).toEqual([{ id: "backlog.fix.sample-beta", line: 3 }]);
    expect(r.coverage.deniedTerms).toEqual([{ source: "env", index: 0, line: 3 }]);
    for (const k of ["unknownStories", "unaccountedStories", "phrasesNotFound"]) expect(r.coverage).toHaveProperty(k);
    expect(mutatingCalls()).toEqual([]);
  });

  it("AC9 a resumed release runs no story-id or denylist check", async () => {
    writeThreeCandidates();
    resumeHead = true;
    vi.stubEnv("RKS_RELEASE_NOTES_DENYLIST", " , ");
    fs.writeFileSync(path.join(FAKE_ROOT, "CHANGELOG.md"), `# Changelog\n\n## [${VERSION}] - 2026-11-11\n\n- Committed entry naming backlog.fix.sample-beta and ${TERM}.\n\n## [1.0.0] - 2026-11-01\n\n- Older notes.\n\n`);
    overrides.push([(c, a) => c === "git" && a[0] === "ls-remote" && a.includes("--tags"), { stdout: `abc123\trefs/tags/v${VERSION}\n`, stderr: "", status: 0 }]);
    const r = await release({});
    expect(r.ok, r.error).toBe(true);
    expect(r.resumed).toBe(true);
  });

  it("AC2 listReleaseCandidates carries the raw releaseNotesGroup only when the frontmatter has it", () => {
    writeRawNote(ALPHA, ['title: "Alpha"', 'desc: "a"', 'phase: "integrated"', 'releaseNotesGroup: "Sideways"']);
    writeRawNote(BETA, ['title: "Beta"', 'desc: "b"', 'phase: "integrated"']);
    expect(candidateById(ALPHA)).toEqual({ storyId: ALPHA, title: "Alpha", desc: "a", releaseNotesGroup: "Sideways" });
    expect(candidateById(BETA)).toEqual({ storyId: BETA, title: "Beta", desc: "b" });
    expect(candidateById(BETA)).not.toHaveProperty("releaseNotesGroup");
  });

  it("AC8 an unreadable .env is refused with release_notes_denylist_invalid, source .env and problem unreadable", async () => {
    writeThreeCandidates();
    fs.mkdirSync(path.join(FAKE_ROOT, ".env"));
    const before = phasesOf();
    const r = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
    expect(r).toMatchObject({ ok: false, reason: "release_notes_denylist_invalid", denylistSource: ".env", denylistProblem: "unreadable" });
    expect(DENIED_EVENT()[0]).toMatchObject({ reason: "release_notes_denylist_invalid", denylistSource: ".env", denylistProblem: "unreadable" });
    expectNoMutation(before);
  });

  it("AC8 an unparseable .env line is refused with release_notes_denylist_invalid, source .env and problem unparseable", async () => {
    writeThreeCandidates();
    fs.writeFileSync(path.join(FAKE_ROOT, ".env"), "# ok\nGOOD=1\nthis line is not an assignment\n");
    const before = phasesOf();
    const r = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
    expect(r).toMatchObject({ ok: false, reason: "release_notes_denylist_invalid", denylistSource: ".env", denylistProblem: "unparseable" });
    expect(r.error).toContain("line 3");
    expectNoMutation(before);
  });

  it("AC8 blank RKS_RELEASE_NOTES_DENYLIST entries are dropped and the remaining terms enforced", async () => {
    writeThreeCandidates();
    vi.stubEnv("RKS_RELEASE_NOTES_DENYLIST", ` , ${TERM},, ${TERM2} ,`);
    expect((await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE })).ok).toBe(true);
    vi.clearAllMocks();
    writeThreeCandidates();
    expect((await release({ changelog: `${CHANGELOG}\n- ${TERM}.`, notesCoverage: FULL_COVERAGE })).reason).toBe("release_notes_denied_term");
    vi.clearAllMocks();
    expect((await release({ changelog: `${CHANGELOG}\n- ${TERM2}.`, notesCoverage: FULL_COVERAGE })).reason).toBe("release_notes_denied_term");
  });

  it("AC8 an RKS_RELEASE_NOTES_DENYLIST with no terms is refused with problem no_terms from env and from .env", async () => {
    writeThreeCandidates();
    const before = phasesOf();
    vi.stubEnv("RKS_RELEASE_NOTES_DENYLIST", " , ,");
    const a = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
    expect(a).toMatchObject({ reason: "release_notes_denylist_invalid", denylistSource: "env", denylistProblem: "no_terms" });
    vi.unstubAllEnvs();
    vi.stubEnv("RKS_RELEASE_NOTES_DENYLIST", undefined);
    vi.clearAllMocks();
    fs.writeFileSync(path.join(FAKE_ROOT, ".env"), "RKS_RELEASE_NOTES_DENYLIST=\n");
    const b = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
    expect(b).toMatchObject({ reason: "release_notes_denylist_invalid", denylistSource: ".env", denylistProblem: "no_terms" });
    expectNoMutation(before);
  });

  it("AC8 every release_notes_denylist_invalid refusal names source and problem and never a term", () => {
    const refusals = [
      loadReleaseNotesDenylist(FAKE_ROOT, { releaseNotes: { denylist: [TERM, ""] } }, {}),
      loadReleaseNotesDenylist(FAKE_ROOT, { releaseNotes: { denylist: [TERM, 3] } }, {}),
      loadReleaseNotesDenylist(FAKE_ROOT, { releaseNotes: { denylist: TERM } }, {}),
      loadReleaseNotesDenylist(FAKE_ROOT, { releaseNotes: { denylist: [TERM] } }, { RKS_RELEASE_NOTES_DENYLIST: " ,," }),
      (() => { writeBrokenProjectJson(); return loadReleaseNotesDenylist(FAKE_ROOT, null, {}); })(),
    ];
    for (const r of refusals) {
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("release_notes_denylist_invalid");
      expect(r.error).toContain(r.denylistSource);
      expect(r.error).toContain(r.denylistProblem);
      expect(JSON.stringify(r)).not.toContain(TERM);
    }
  });
});

describe("rks_release tool descriptions", () => {
  it("AC10 changelog description names the story-id and denied-term refusals and dryRun description names notesBrief", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../../packages/mcp-rks/src/server.mjs"), "utf8").split("\n");
    const changelogLine = src.find((l) => l.includes("changelog: {") && l.includes("Release notes. Required on a fresh release"));
    const dryRunLine = src.find((l) => l.includes("Preview only: returns the stories the release would transition"));
    expect(changelogLine).toBeDefined();
    expect(changelogLine).toContain("release_notes_story_id");
    expect(changelogLine).toContain("release_notes_denied_term");
    expect(dryRunLine).toContain("notesBrief");
  });
});

// backlog.fix.release-notes-denylist-review-followups: an unparseable config never echoes its
// parse error (which quotes file text), a dry run refuses a malformed denylist, and an unquoted
// .env value drops a trailing inline comment. Terms are synthetic.
// Short on purpose: JSON.parse quotes short input whole, so the control below sees the term.
const BROKEN_PROJECT_JSON = `[${TERM}]`;
function writeBrokenProjectJson() {
  fs.mkdirSync(path.join(FAKE_ROOT, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(FAKE_ROOT, ".rks", "project.json"), BROKEN_PROJECT_JSON);
}
const parseMessage = () => { try { JSON.parse(BROKEN_PROJECT_JSON); } catch (e) { return e.message; } return null; };
const envTerms = (line) => {
  fs.writeFileSync(path.join(FAKE_ROOT, ".env"), `${line}\n`);
  return loadReleaseNotesDenylist(FAKE_ROOT, null, {});
};

describe("release notes denylist review follow-ups", () => {
  beforeEach(() => { vi.stubEnv("RKS_RELEASE_NOTES_DENYLIST", undefined); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("AC1 an unparseable project.json refusal carries neither the quoted term nor the parse error message", () => {
    const message = parseMessage();
    expect(message).toContain(TERM);
    writeBrokenProjectJson();
    const r = loadReleaseNotesDenylist(FAKE_ROOT, null, {});
    expect(r).toMatchObject({ ok: false, reason: "release_notes_denylist_invalid", denylistSource: "project.json", denylistProblem: "unparseable" });
    const text = JSON.stringify(r);
    expect(text).not.toContain(TERM);
    expect(text).not.toContain(message);
  });

  it("AC2 a non-dry release over an unparseable project.json refuses before any mutation and its release.failed event carries neither the term nor the parse error message", async () => {
    writeThreeCandidates();
    writeBrokenProjectJson();
    const before = phasesOf();
    const r = await release({ changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
    expect(r.reason).toBe("release_notes_denylist_invalid");
    const failed = DENIED_EVENT();
    expect(failed).toHaveLength(1);
    const text = JSON.stringify(failed);
    expect(text).not.toContain(TERM);
    expect(text).not.toContain(parseMessage());
    expectNoMutation(before);
  });

  it("AC4 a dryRun refuses a malformed project.json or env denylist with release_notes_denylist_invalid, no release telemetry and no mutation", async () => {
    writeThreeCandidates();
    const before = phasesOf();
    writeProjectJson({ releaseNotes: { denylist: "not-an-array" } });
    const a = await release({ dryRun: true });
    expect(a).toMatchObject({ ok: false, reason: "release_notes_denylist_invalid", denylistSource: "project.json", denylistProblem: "not_an_array" });
    fs.rmSync(path.join(FAKE_ROOT, ".rks"), { recursive: true, force: true });
    vi.stubEnv("RKS_RELEASE_NOTES_DENYLIST", " , ");
    const b = await release({ dryRun: true, changelog: CHANGELOG });
    expect(b).toMatchObject({ ok: false, reason: "release_notes_denylist_invalid", denylistSource: "env", denylistProblem: "no_terms" });
    expect(events().filter((e) => e.startsWith("release."))).toEqual([]);
    expectNoMutation(before);
  });

  it("AC5 the dryRun description states the dry-run denylist refusal and the golden carries the identical text", () => {
    const prefix = "Preview only: returns the stories the release would transition";
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../../packages/mcp-rks/src/server.mjs"), "utf8");
    const golden = fs.readFileSync(path.resolve(import.meta.dirname, "../integration/fixtures/mcp-surface.golden.json"), "utf8");
    const descOf = (text) => { const m = new RegExp(`"(${prefix}[^"]*)"`).exec(text); return m && m[1]; };
    const desc = descOf(src);
    expect(desc).toContain("notesBrief");
    expect(desc).toContain("release_notes_denylist_invalid on a dry run as well");
    expect(descOf(golden)).toBe(desc);
  });

  it("AC6 a trailing inline comment on an unquoted .env value is stripped and the remaining terms are enforced", async () => {
    const r = envTerms("RKS_RELEASE_NOTES_DENYLIST=synthterm-alpha, synthterm-beta # comment");
    expect(r.ok, r.error).toBe(true);
    expect(r.terms.map((t) => t.term)).toEqual(["synthterm-alpha", "synthterm-beta"]);
    writeThreeCandidates();
    const rel = await release({ changelog: `${CHANGELOG}\n- synthterm-beta.`, notesCoverage: FULL_COVERAGE });
    expect(rel.reason).toBe("release_notes_denied_term");
  });

  it("AC7 a hash without preceding whitespace and a hash inside quotes are kept in the .env term", () => {
    expect(envTerms("RKS_RELEASE_NOTES_DENYLIST=synth#term").terms.map((t) => t.term)).toEqual(["synth#term"]);
    expect(envTerms('RKS_RELEASE_NOTES_DENYLIST="synthterm-alpha # kept"').terms.map((t) => t.term)).toEqual(["synthterm-alpha # kept"]);
  });

  it("AC8 a .env value that is only an inline comment is refused with problem no_terms", () => {
    expect(envTerms("RKS_RELEASE_NOTES_DENYLIST= # nothing")).toMatchObject({ ok: false, reason: "release_notes_denylist_invalid", denylistSource: ".env", denylistProblem: "no_terms" });
  });

  it("AC9 STORY_ID_TOKEN_RE is unchanged", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../../packages/mcp-rks/src/server/git/git-release.mjs"), "utf8");
    expect(src).toContain("const STORY_ID_TOKEN_RE = /\\bbacklog(?:\\.[A-Za-z0-9_][A-Za-z0-9_-]*){2,}/g;");
  });
});

describe("release dryRun", () => {
  it("returns the preview shape and makes no fetch, push, commit, tag, checkout, merge or gh call", async () => {
    writeThreeCandidates();
    const r = await release({ dryRun: true });
    expect(r).toMatchObject({ ok: true, dryRun: true, published: false, version: VERSION, resumed: false, coverage: null, committedEntry: null });
    expect(r.stories).toEqual(listReleaseCandidates(FAKE_ROOT));
    expect(r.notesDraft).toBe(draftReleaseNotes(r.stories).text);
    expect(r.coverageDraft).toEqual(draftReleaseNotes(r.stories).coverage);
    expect(mutatingCalls()).toEqual([]);
  });

  it("emits only release.dry_run and leaves CHANGELOG.md, package.json and every note byte-identical", async () => {
    writeThreeCandidates();
    const before = snapshot();
    await release({ dryRun: true, changelog: CHANGELOG, notesCoverage: FULL_COVERAGE });
    expect(snapshot()).toEqual(before);
    const releaseEvents = events().filter((e) => e.startsWith("release."));
    expect(releaseEvents).toEqual(["release.dry_run"]);
  });

  it("still refuses on the wrong branch, a dirty tree, an invalid notesOverride or malformed coverage inputs", async () => {
    writeThreeCandidates();
    branch = "feature/sample";
    expect((await release({ dryRun: true })).ok).toBe(false);
    branch = "staging";
    overrides.push([(c, a) => c === "git" && a[0] === "status", { stdout: " M package.json\n", stderr: "", status: 0 }]);
    expect((await release({ dryRun: true })).ok).toBe(false);
    overrides = [];
    expect((await release({ dryRun: true, notesOverride: { enabled: true, reason: " " } })).reason).toBe("notes_override_invalid");
    expect((await release({ dryRun: true, notesCoverage: [] })).reason).toBe("notes_coverage_invalid");
    expect((await release({ dryRun: true, notesExclusions: {} })).reason).toBe("notes_exclusions_invalid");
    expect(mutatingCalls()).toEqual([]);
  });

  it("reports unknown, unaccounted and phrase-not-found findings in coverage without refusing", async () => {
    writeThreeCandidates();
    const stale = "backlog.feat.sample-not-released";
    const r = await release({ dryRun: true, changelog: CHANGELOG, notesCoverage: { [ALPHA]: "missing phrase", [stale]: "Alpha" }, notesExclusions: [{ storyId: BETA, reason: "internal" }] });
    expect(r.ok).toBe(true);
    expect(r.coverage.unknownStories).toEqual([stale]);
    expect(r.coverage.unaccountedStories).toEqual(expect.arrayContaining([ALPHA, GAMMA]));
    expect(r.coverage.phrasesNotFound).toEqual([{ storyId: ALPHA, phrase: "missing phrase" }]);
    expect(r.coverage.excludedStories).toEqual([{ storyId: BETA, reason: "internal" }]);
  });

  it("notesDraft with coverageDraft passes a real release's coverage check", async () => {
    writeThreeCandidates();
    const dry = await release({ dryRun: true });
    const r = await release({ changelog: dry.notesDraft, notesCoverage: dry.coverageDraft });
    expect(r.ok, r.error).toBe(true);
  });
});
