// backlog.fix.release-unbounded-network-subprocess-hang — runRelease bounds every network git/gh spawn,
// and a timed-out spawn is a named failure (timeout_at) with the guarded rollback where rollback is safe.
// spawnSync is mocked (vi.mock("child_process")); no real subprocess or network is spawned.
// publish.mjs is mocked too (ARCH decision): its own network calls are a follow-up story, and an
// unmocked publish() would record its own spawns through the mocked child_process.
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";

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

const { spawnSync } = await import("child_process");
const { runGit } = await import("../../packages/mcp-rks/src/server/git/git-utils.mjs");
const { loadPublishProfiles, publish } = await import("../../packages/mcp-rks/src/server/publish.mjs");
const { runRelease } = await import("../../packages/mcp-rks/src/server/git/git-release.mjs");

const FAKE_ROOT = "/tmp/fake-project-release-network-timeout";
const VERSION = "1.0.1";
const BUMP_SUBJECT = `chore(release): ${VERSION}`;
// backlog.feat.release-write-release-notes: a fresh release refuses without a changelog.
const NOTES = "- Test release notes written from the released stories.";

const TIMED_OUT = () => ({
  status: null, stdout: "", stderr: "", signal: "SIGTERM",
  error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }),
});

const NETWORK = (cmd, args) => cmd === "gh" || ["push", "fetch", "ls-remote", "pull"].includes(args[0]);
const is = (cmd, ...prefix) => (c, a) => c === cmd && prefix.every((p, i) => a[i] === p);

// Per-test overrides: [matcher(cmd,args), result | () => result]
let overrides = [];
let resumeHead = false;

function defaultSpawn(cmd, args) {
  if (cmd === "git" && args[0] === "status") return { stdout: "", stderr: "", status: 0 };
  if (cmd === "git" && args[0] === "rev-list" && args.includes("--left-right")) return { stdout: "0\t0", stderr: "", status: 0 };
  if (cmd === "gh" && args[0] === "run") {
    return { stdout: JSON.stringify([{ status: "completed", conclusion: "success", headSha: "abc" }]), stderr: "", status: 0 };
  }
  return { stdout: "", stderr: "", status: 0 };
}

function calls() { return spawnSync.mock.calls.map(([cmd, args, opts]) => ({ cmd, args, opts })); }
function lastCheckout() {
  const co = calls().filter((c) => c.cmd === "git" && c.args[0] === "checkout");
  return co.length ? co[co.length - 1].args[1] : null;
}
function seqIndex(pred, from = 0) {
  const all = calls();
  for (let i = from; i < all.length; i++) if (pred(all[i])) return i;
  return -1;
}

beforeEach(() => {
  vi.clearAllMocks();
  overrides = [];
  resumeHead = false;
  fs.mkdirSync(`${FAKE_ROOT}/notes`, { recursive: true });
  fs.writeFileSync(`${FAKE_ROOT}/package.json`, JSON.stringify({ name: "test", version: "1.0.0" }, null, 2));
  // Fresh releases here really write CHANGELOG.md; a resume reads it. Start every test without one.
  fs.rmSync(`${FAKE_ROOT}/CHANGELOG.md`, { force: true });
  loadPublishProfiles.mockImplementation(() => ({ profiles: {}, remotes: {} }));
  publish.mockImplementation(async () => ({ ok: true }));

  spawnSync.mockImplementation((cmd, args, opts) => {
    for (const [match, res] of overrides) if (match(cmd, args)) return typeof res === "function" ? res() : res;
    return defaultSpawn(cmd, args, opts);
  });

  runGit.mockImplementation((root, args) => {
    if (args[0] === "branch" && args[1] === "--show-current") return "staging";
    if (args[0] === "log" && args[1] === "-1" && args[3] === "staging") return resumeHead ? BUMP_SUBJECT : "feat: something";
    if (args[0] === "log" && args[1] === "-1" && args[3] === "HEAD") return BUMP_SUBJECT;
    if (args[0] === "rev-parse" && args[1] === "main") return "sha-main";
    if (args[0] === "rev-parse" && args[1] === "origin/main") return "sha-main";
    if (args[0] === "rev-parse" && args[1] === "staging") return "sha-staging";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "sha-premain";
    if (args[0] === "rev-parse" && args[1] === `v${VERSION}`) return "sha-localtag";
    if (args[0] === "merge-base") return "sha-main";
    if (args[0] === "tag" && args[1] === "--list") return "";
    return "sha-default";
  });
});

function withPublicMirror() {
  loadPublishProfiles.mockImplementation(() => ({
    profiles: { "rks-public": {} },
    remotes: { "rks-public": { profile: "rks-public", url: "https://github.com/owner/public-repo.git" } },
  }));
}

describe("runRelease network spawn timeouts", () => {
  it("passes a positive finite timeout to every network spawn on a successful release (incl. public gh)", async () => {
    withPublicMirror();
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES });
    expect(r.ok, r.error).toBe(true);
    const net = calls().filter((c) => NETWORK(c.cmd, c.args));
    // production push, tag push, integration push, gh release create, public view + create, fetches, ls-remote
    expect(net.some((c) => c.cmd === "git" && c.args[0] === "push" && c.args[2] === "main")).toBe(true);
    expect(net.some((c) => c.cmd === "gh" && c.args[0] === "release" && c.args[1] === "view")).toBe(true);
    expect(net.length).toBeGreaterThanOrEqual(8);
    for (const c of net) {
      expect(c.opts?.timeout, `${c.cmd} ${c.args.join(" ")}`).toBeGreaterThan(0);
      expect(Number.isFinite(c.opts.timeout)).toBe(true);
    }
    expect(publish).toHaveBeenCalled();
  });

  it("production push timeout returns ok:false, timeout_at push_production, and runs the guarded rollback", async () => {
    overrides.push([is("git", "push", "origin", "main"), TIMED_OUT]);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES });
    expect(r.ok).toBe(false);
    expect(r.timeout_at).toBe("push_production");
    expect(r.error).toMatch(/push_production|git push origin main/);
    expect(r.error).toMatch(/120000ms/);

    const pushIdx = seqIndex((c) => c.cmd === "git" && c.args[0] === "push" && c.args[2] === "main");
    const tagD = seqIndex((c) => c.cmd === "git" && c.args[0] === "tag" && c.args[1] === "-d" && c.args[2] === `v${VERSION}`, pushIdx);
    const resetMain = seqIndex((c) => c.cmd === "git" && c.args[0] === "reset" && c.args[2] === "sha-premain", tagD);
    const coInt = seqIndex((c) => c.cmd === "git" && c.args[0] === "checkout" && c.args[1] === "staging", resetMain);
    const undoBump = seqIndex((c) => c.cmd === "git" && c.args[0] === "reset" && c.args[2] === "HEAD~1", coInt);
    expect(pushIdx).toBeGreaterThan(-1);
    expect(tagD).toBeGreaterThan(pushIdx);
    expect(resetMain).toBeGreaterThan(tagD);
    expect(coInt).toBeGreaterThan(resetMain);
    expect(undoBump).toBeGreaterThan(coInt);
    expect(lastCheckout()).toBe("staging");
    // Nothing after the failed production push touches the network.
    expect(calls().slice(pushIdx + 1).some((c) => NETWORK(c.cmd, c.args))).toBe(false);
  });

  it("tag push timeout follows the non-zero tag-push guarded path and reports timeout_at push_tag", async () => {
    overrides.push([is("git", "push", "origin", `v${VERSION}`), TIMED_OUT]);
    // ls-remote answers: tag NOT on origin → rollback
    overrides.push([is("git", "ls-remote", "--tags", "origin"), () => ({ stdout: "", stderr: "", status: 0 })]);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES });
    expect(r.ok).toBe(false);
    expect(r.timeout_at).toBe("push_tag");
    const tagPushIdx = seqIndex((c) => c.cmd === "git" && c.args[0] === "push" && c.args[2] === `v${VERSION}`);
    const lsIdx = seqIndex((c) => c.cmd === "git" && c.args[0] === "ls-remote", tagPushIdx);
    const tagD = seqIndex((c) => c.cmd === "git" && c.args[0] === "tag" && c.args[1] === "-d", lsIdx);
    const undoBump = seqIndex((c) => c.cmd === "git" && c.args[0] === "reset" && c.args[2] === "HEAD~1", tagD);
    expect(lsIdx).toBeGreaterThan(tagPushIdx);
    expect(tagD).toBeGreaterThan(lsIdx);
    expect(undoBump).toBeGreaterThan(tagD);
    expect(lastCheckout()).toBe("staging");
  });

  it("tag push timeout whose follow-up ls-remote also times out is NOT treated as tag-absent", async () => {
    overrides.push([is("git", "push", "origin", `v${VERSION}`), TIMED_OUT]);
    // The pre-mutation ls-remote (before the bump) must answer; only the post-tag-push one times out.
    let lsCount = 0;
    overrides.push([is("git", "ls-remote"), () => (++lsCount >= 2 ? TIMED_OUT() : { stdout: "", stderr: "", status: 0 })]);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES });
    expect(r.ok).toBe(false);
    expect(r.timeout_at).toBe("push_tag");
    expect(r.tagOnOrigin).toBe("unknown");
    const tagPushIdx = seqIndex((c) => c.cmd === "git" && c.args[0] === "push" && c.args[2] === `v${VERSION}`);
    const after = calls().slice(tagPushIdx + 1);
    expect(after.some((c) => c.args[0] === "tag" && c.args[1] === "-d")).toBe(false);
    expect(after.some((c) => c.args[0] === "reset" && c.args[1] === "--hard")).toBe(false);
    expect(lastCheckout()).toBe("staging");
  });

  it("resume ls-remote timeout is a named failure, not 'tag absent'", async () => {
    resumeHead = true;
    overrides.push([is("git", "ls-remote", "--tags", "origin", `v${VERSION}`), TIMED_OUT]);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch" });
    expect(r.ok).toBe(false);
    expect(r.timeout_at).toBe("resume_ls_remote_tag");
    // Did not proceed into the merge/tag/push stages as if the tag were absent.
    expect(calls().some((c) => c.args[0] === "merge")).toBe(false);
    expect(calls().some((c) => c.args[0] === "push")).toBe(false);
    expect(calls().some((c) => c.args[0] === "tag" && c.args[1] === "-a")).toBe(false);
    const co = lastCheckout();
    expect(co === null || co === "staging").toBe(true);
  });

  it("integration push timeout after production+tag on origin does not roll back and warns precisely", async () => {
    overrides.push([is("git", "push", "origin", "staging"), TIMED_OUT]);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/main and tag v1\.0\.1 are on origin, but staging is not/);
    expect(r.warning).toMatch(/timed out/);
    expect(calls().some((c) => c.args[0] === "reset" && c.args[1] === "--hard")).toBe(false);
    expect(calls().some((c) => c.args[0] === "tag" && c.args[1] === "-d")).toBe(false);
    expect(lastCheckout()).toBe("staging");
  });

  it("gh release create timeout is a non-fatal warning naming the step", async () => {
    overrides.push([is("gh", "release", "create"), TIMED_OUT]);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/gh_release_create/);
    expect(calls().some((c) => c.args[0] === "reset" && c.args[1] === "--hard")).toBe(false);
    expect(calls().some((c) => c.args[0] === "tag" && c.args[1] === "-d")).toBe(false);
  });

  it("public-publish gh release view / create timeouts are non-fatal warnings naming the step", async () => {
    withPublicMirror();
    overrides.push([is("gh", "release", "view"), TIMED_OUT]);
    let r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/gh_public_release_view/);

    vi.clearAllMocks();
    withPublicMirror();
    overrides = [
      [is("gh", "release", "view"), { stdout: "", stderr: "not found", status: 1 }],
      [(c, a) => c === "gh" && a[0] === "release" && a[1] === "create" && a.includes("--repo"), TIMED_OUT],
    ];
    r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/gh_public_release_create/);
    expect(calls().some((c) => c.args[0] === "reset" && c.args[1] === "--hard")).toBe(false);
    expect(lastCheckout()).toBe("staging");
  });

  it("pre-bump fetch timeout fails before any version-bump commit", async () => {
    overrides.push([is("git", "fetch", "origin", "staging"), TIMED_OUT]);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES });
    expect(r.ok).toBe(false);
    expect(r.timeout_at).toBe("fetch_integration");
    expect(calls().some((c) => c.args[0] === "commit")).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${FAKE_ROOT}/package.json`, "utf8")).version).toBe("1.0.0");
    const co = lastCheckout();
    expect(co === null || co === "staging").toBe(true);
  });

  it("pre-bump push-ahead timeout fails before any version-bump commit", async () => {
    overrides.push([(c, a) => c === "git" && a[0] === "rev-list" && a.includes("--left-right"), { stdout: "1\t0", stderr: "", status: 0 }]);
    overrides.push([is("git", "push", "origin", "staging"), TIMED_OUT]);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES });
    expect(r.ok).toBe(false);
    expect(r.timeout_at).toBe("push_integration_ahead");
    expect(calls().some((c) => c.args[0] === "commit")).toBe(false);
    const co = lastCheckout();
    expect(co === null || co === "staging").toBe(true);
  });

  it("pre-bump production fetch / tag ls-remote timeouts fail before any version-bump commit", async () => {
    overrides.push([is("git", "fetch", "origin", "main"), TIMED_OUT]);
    let r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES });
    expect(r.ok).toBe(false);
    expect(r.timeout_at).toBe("fetch_production");
    expect(calls().some((c) => c.args[0] === "commit")).toBe(false);

    vi.clearAllMocks();
    overrides = [[is("git", "ls-remote", "--tags", "origin"), TIMED_OUT]];
    r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES });
    expect(r.ok).toBe(false);
    expect(r.timeout_at).toBe("ls_remote_tag");
    expect(calls().some((c) => c.args[0] === "commit")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// backlog.feat.release-write-release-notes — the notes block runs before the first network call;
// the gh --notes values are changelog.trim() on a fresh run and the committed CHANGELOG.md entry
// on a Rows 2/3 resume; a resume with no entry refuses and says whether it self-pushed.
// ---------------------------------------------------------------------------

/** No git fetch, git push, git commit, git tag, or gh call was spawned. */
function expectNoRemoteOrMutatingCall() {
  const bad = calls().filter((c) => c.cmd === "gh" || (c.cmd === "git" && ["fetch", "push", "commit", "tag"].includes(c.args[0])));
  expect(bad.map((c) => `${c.cmd} ${c.args.join(" ")}`)).toEqual([]);
}
const notesOf = (c) => c.args[c.args.indexOf("--notes") + 1];
const mainGhCreate = () => calls().filter((c) => c.cmd === "gh" && c.args[0] === "release" && c.args[1] === "create" && !c.args.includes("--repo"));
const publicGhRelease = () => calls().filter((c) => c.cmd === "gh" && c.args[0] === "release" && (c.args[1] === "create" || c.args[1] === "edit") && c.args.includes("--repo"));
const ENTRY_BODY = "- Committed notes for 1.0.1.\n- A second committed line.";
function writeChangelog(withEntry) {
  const entry = withEntry ? `## [1.0.1] - 2026-11-07\n\n${ENTRY_BODY}\n\n` : "";
  fs.writeFileSync(`${FAKE_ROOT}/CHANGELOG.md`, `# Changelog\n\n${entry}## [1.0.0] - 2026-11-01\n\n- Older notes.\n\n`);
}
/** Row 1: origin/main equals the integration HEAD. */
function originMainAtStaging() {
  const prev = runGit.getMockImplementation();
  runGit.mockImplementation((root, args) => (args[0] === "rev-parse" && args[1] === "origin/main" ? "sha-staging" : prev(root, args)));
}
const AHEAD_ONE = [(c, a) => c === "git" && a[0] === "rev-list" && a.includes("--left-right"), { stdout: "1\t0", stderr: "", status: 0 }];
const IGNORED = /1\.0\.1[^\n]*changelog argument was ignored/;

describe("runRelease release notes (backlog.feat.release-write-release-notes)", () => {
  it("AC1 — no changelog and no notesOverride refuses with release_notes_missing before any fetch, push, commit, tag or gh call", async () => {
    let r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("release_notes_missing");
    expectNoRemoteOrMutatingCall();

    // Local staging ahead of origin: the self-push must not have run either.
    vi.clearAllMocks();
    overrides = [AHEAD_ONE];
    r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch" });
    expect(r.reason).toBe("release_notes_missing");
    expectNoRemoteOrMutatingCall();
  });

  it("AC3 — the main-repo gh release create --notes value equals changelog.trim()", async () => {
    const changelog = "\n  - Users can now do X.\n- Y no longer fails.  \n\n";
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog });
    expect(r.ok, r.error).toBe(true);
    expect(mainGhCreate()).toHaveLength(1);
    expect(notesOf(mainGhCreate()[0])).toBe(changelog.trim());
  });

  it("AC3 — the public-mirror gh release --repo --notes value equals changelog.trim()", async () => {
    withPublicMirror();
    const changelog = "  - Users can now do X.\n- Y no longer fails.\n ";
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog });
    expect(r.ok, r.error).toBe(true);
    expect(publicGhRelease()).toHaveLength(1);
    expect(notesOf(publicGhRelease()[0])).toBe(changelog.trim());
  });

  it("AC4 — notesOverride { enabled: false } is refused with notes_override_invalid on a fresh and a resumed run, before any network call", async () => {
    let r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES, notesOverride: { enabled: false, reason: "x" } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("notes_override_invalid");
    expectNoRemoteOrMutatingCall();

    vi.clearAllMocks();
    resumeHead = true;
    r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES, notesOverride: { enabled: false, reason: "x" } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("notes_override_invalid");
    expectNoRemoteOrMutatingCall();
  });

  it("AC5(a) Rows 2/3 — both gh --notes values are the committed CHANGELOG.md entry, not the changelog argument", async () => {
    resumeHead = true;
    withPublicMirror();
    writeChangelog(true);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: "- A different changelog argument." });
    expect(r.ok, r.error).toBe(true);
    expect(r.resumed).toBe(true);
    expect(mainGhCreate()).toHaveLength(1);
    expect(notesOf(mainGhCreate()[0])).toBe(ENTRY_BODY);
    expect(publicGhRelease()).toHaveLength(1);
    expect(notesOf(publicGhRelease()[0])).toBe(ENTRY_BODY);
  });

  it("AC5(b) Rows 2/3 — no committed entry refuses with release_notes_resume_entry_missing before the merge, tag, pushes and gh", async () => {
    resumeHead = true;
    writeChangelog(false);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("release_notes_resume_entry_missing");
    expect(r.resumed).toBe(true);
    const all = calls();
    expect(all.some((c) => c.cmd === "git" && c.args[0] === "merge")).toBe(false);
    expect(all.some((c) => c.cmd === "git" && c.args[0] === "tag" && c.args[1] === "-a")).toBe(false);
    expect(all.some((c) => c.cmd === "git" && c.args[0] === "push" && c.args[2] === "main")).toBe(false);
    expect(all.some((c) => c.cmd === "git" && c.args[0] === "push" && c.args[2] === `v${VERSION}`)).toBe(false);
    expect(all.some((c) => c.cmd === "gh" && c.args[0] === "release")).toBe(false);
  });

  it("AC5(b) integrationSelfPushed true — the self-push exited 0, and the error states it pushed", async () => {
    resumeHead = true;
    writeChangelog(false);
    overrides.push(AHEAD_ONE);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch" });
    expect(r.reason).toBe("release_notes_resume_entry_missing");
    expect(r.integrationSelfPushed).toBe(true);
    expect(calls().filter((c) => c.cmd === "git" && c.args[0] === "push" && c.args[1] === "origin" && c.args[2] === "staging")).toHaveLength(1);
    expect(r.error).toContain("pushed 1 pre-existing commit");
    expect(r.error).toContain("origin/staging");
    expect(r.error).not.toContain("may have");
  });

  it("AC5(b) integrationSelfPushed false — staging not ahead, no push of any kind, and the error states no push", async () => {
    resumeHead = true;
    writeChangelog(false);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch" });
    expect(r.reason).toBe("release_notes_resume_entry_missing");
    expect(r.integrationSelfPushed).toBe(false);
    expect(calls().some((c) => c.cmd === "git" && c.args[0] === "push")).toBe(false);
    expect(r.error).toContain("no push");
    expect(r.error).not.toContain("may have");
  });

  it("AC5(c) Row 1 — a release complete on origin resumes ok with no committed entry and makes no gh call", async () => {
    resumeHead = true;
    writeChangelog(false);
    originMainAtStaging();
    overrides.push([is("git", "ls-remote", "--tags", "origin", `v${VERSION}`), { stdout: `abc\trefs/tags/v${VERSION}`, stderr: "", status: 0 }]);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch" });
    expect(r.ok, r.error).toBe(true);
    expect(r.resumed).toBe(true);
    expect(calls().some((c) => c.cmd === "gh" && c.args[0] === "release")).toBe(false);
  });

  it("AC5(d) Row 1 — the ignored-changelog line is joined into the resume warning alongside resume_fetch_tag", async () => {
    resumeHead = true;
    writeChangelog(false);
    originMainAtStaging();
    overrides.push([is("git", "ls-remote", "--tags", "origin", `v${VERSION}`), { stdout: `abc\trefs/tags/v${VERSION}`, stderr: "", status: 0 }]);
    overrides.push([is("git", "fetch", "origin", "tag", `v${VERSION}`), TIMED_OUT]);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES });
    expect(r.ok, r.error).toBe(true);
    expect(r.warning).toMatch(/resume_fetch_tag/);
    expect(r.warning).toMatch(IGNORED);
  });

  it("AC5(d) Rows 2/3 — the ignored-changelog line is appended to the warning chain alongside gh_release_create", async () => {
    resumeHead = true;
    writeChangelog(true);
    overrides.push([is("gh", "release", "create"), TIMED_OUT]);
    const r = await runRelease({ projectRoot: FAKE_ROOT, version: "patch", changelog: NOTES });
    expect(r.ok, r.error).toBe(true);
    expect(r.warning).toMatch(/gh_release_create/);
    expect(r.warning).toMatch(IGNORED);
  });
});
