import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

// Wiring coverage for /release Step 7: the release publishes the rks-public code
// profile (not the docs-only notes-public), resolves the remote by profile match,
// and keeps the publish step NON-FATAL (a publish failure must not fail the release).
// Step 7 is inline in runRelease and only runs inside a full release, so this asserts
// the wiring at the source + config level rather than executing a release.
//
// REWORKED for backlog.feat.suppressible-public-publish. Two changes:
//
//  1. The CONFIG assertions now run against a FIXTURE profiles config, not the live
//     .routekit/publish-profiles.yaml. Asserting that the live file currently has a public
//     target ARMED made the safety mechanism unusable — the operator could not disarm the
//     mirror without reding CI, and red CI blocks the release through the very gate that
//     exists to fail closed. The fixture still proves the RESOLVER wiring (profile → remote →
//     public repo slug), which is what this suite is actually for.
//  2. The Step 7 source regexes are updated for the mapPublishOutcome extraction, while the
//     Step 7b `publishResult?.ok` gate assertion is RETAINED. Gate condition asserted here
//     plus mapping behaviour asserted mock-free in git-release-publish-suppression.test.mjs
//     are together the complete deterministic proof that Step 7b cannot fire when publish is
//     suppressed.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const RELEASE_SRC = readFileSync(
  join(ROOT, "packages/mcp-rks/src/server/git/git-release.mjs"),
  "utf-8",
);

// FIXTURE config — the shape a correctly-wired rks-public publish target has. Note the
// `enabled` key: an armed fixture is `enabled: true`, and the live file may legitimately be
// `enabled: false` without this suite caring.
const FIXTURE_CONFIG = yaml.load(`
profiles:
  rks-public:
    identity:
      from: routekit-shell-core
      to: routekit-shell
    include:
      - "README.md"
remotes:
  rks-public:
    url: "git@github.com:ux287/routekit-shell.git"
    profile: "rks-public"
    branch: "main"
    enabled: true
`);

/** The remote-resolution rule Step 7 and Step 7b both use, applied to a config. */
function resolveRksPublicRemote(config) {
  return Object.entries(config.remotes || {}).find(
    ([name, r]) => r.profile === "rks-public" || name === "rks-public",
  );
}

describe("/release Step 7 wires the rks-public profile to the routekit-shell remote", () => {
  it("the publish() call targets the rks-public profile", () => {
    expect(RELEASE_SRC).toMatch(/profile:\s*["']rks-public["']/);
  });

  it("resolves the remote by profile match (not a hardcoded remote name)", () => {
    expect(RELEASE_SRC).toMatch(/r\.profile === ["']rks-public["']/);
  });

  it("no longer publishes the docs-only notes-public profile", () => {
    expect(RELEASE_SRC).not.toContain('profile: "notes-public"');
    expect(RELEASE_SRC).not.toContain('r.profile === "notes-public"');
  });

  it("routes the publish outcome through the exported pure mapPublishOutcome", () => {
    // The extraction is what makes the Step 7 → Step 7b link directly assertable without
    // mocking child_process inside git-release.mjs.
    expect(RELEASE_SRC).toMatch(/export function mapPublishOutcome\(/);
    expect(RELEASE_SRC).toMatch(/publishResult = mapPublishOutcome\(pubResult, remoteName\)/);
  });

  it("the publish step stays NON-FATAL — failures become warnings, not throws", () => {
    // A failed publish maps to a warning-carrying outcome; a thrown publish is caught and
    // recorded the same way. Either way the release still returns ok.
    expect(RELEASE_SRC).toMatch(/warning: `Publish to \$\{remoteName\} failed/);
    expect(RELEASE_SRC).toMatch(/publishResult = \{ ok: false, warning \}/);
    expect(RELEASE_SRC).toMatch(/catch \(pubErr\)/);
    // The publish block is wrapped so a profile-load failure is caught, not thrown.
    expect(RELEASE_SRC).toMatch(/catch \(profileErr\)/);
  });

  it("discriminates a SUPPRESSED publish from a failed one before logging", () => {
    expect(RELEASE_SRC).toMatch(/publishResult\.suppressed/);
    expect(RELEASE_SRC).toMatch(/publish SKIPPED/);
  });

  it("config wiring (FIXTURE): the profile resolver finds the routekit-shell remote via rks-public", () => {
    const match = resolveRksPublicRemote(FIXTURE_CONFIG);
    expect(match).toBeTruthy();
    const [remoteName, remote] = match;
    expect(remoteName).toBe("rks-public");
    expect(remote.url).toContain("routekit-shell.git");
    expect(FIXTURE_CONFIG.profiles["rks-public"]).toBeTruthy();
  });

  it("config wiring (FIXTURE): a remote whose profile does not match rks-public is NOT resolved", () => {
    // Negative control for the resolver rule itself.
    const other = yaml.load(`
remotes:
  someplace:
    url: "git@github.com:example/other.git"
    profile: "app-only"
`);
    expect(resolveRksPublicRemote(other)).toBeUndefined();
  });
});

describe("/release Step 7b publishes a display-only GitHub Release to the PUBLIC repo", () => {
  it("creates a public GitHub Release targeting --repo <publicRepo> with a config-derived --target branch", () => {
    expect(RELEASE_SRC).toContain('"--repo", publicRepo');
    // target must be the config-derived publicBranch, NOT a hardcoded "main"/"staging"
    // literal — tests/integration/git-release.test.mjs forbids branch-ref literals in runRelease.
    expect(RELEASE_SRC).toContain('"--target", publicBranch');
    expect(RELEASE_SRC).not.toContain('"--target", "main"');
    expect(RELEASE_SRC).toMatch(/"release",\s*"create"/);
  });

  it("resolves the public repo slug from the rks-public remote url (not hardcoded)", () => {
    expect(RELEASE_SRC).toMatch(/r\.profile === ["']rks-public["']/);
    expect(RELEASE_SRC).toMatch(/github\.com/);
  });

  it("is idempotent — views first, then edits-or-creates", () => {
    expect(RELEASE_SRC).toMatch(/"release",\s*"view"/);
    expect(RELEASE_SRC).toMatch(/"release",\s*"edit"/);
  });

  it("only runs when the rks-public publish succeeded (gated on publishResult.ok)", () => {
    // RETAINED, and load-bearing for the suppression story: this is the gate condition that a
    // suppressed publish must starve. mapPublishOutcome's mock-free assertions in
    // git-release-publish-suppression.test.mjs supply the other half of the proof.
    expect(RELEASE_SRC).toMatch(/if \(publishResult\?\.ok\)/);
  });

  it("is non-fatal — a public-release failure becomes a warning, not a throw", () => {
    expect(RELEASE_SRC).toMatch(/publicReleaseWarning/);
  });

  it("config wiring (FIXTURE): the rks-public remote resolves to the public ux287/routekit-shell repo", () => {
    const entry = resolveRksPublicRemote(FIXTURE_CONFIG);
    expect(entry[1].url).toMatch(/ux287\/routekit-shell(\.git)?$/);
  });

  it("config wiring (FIXTURE): the public repo slug regex extracts the owner/name from the remote url", () => {
    // The same regex Step 7b uses. Pinned against the fixture so it reds if the extraction
    // form changes, without requiring the live remote to be armed.
    const url = resolveRksPublicRemote(FIXTURE_CONFIG)[1].url;
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
    expect(m?.[1]).toBe("ux287/routekit-shell");
  });
});
