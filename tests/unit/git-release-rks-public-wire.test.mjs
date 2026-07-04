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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const RELEASE_SRC = readFileSync(
  join(ROOT, "packages/mcp-rks/src/server/git/git-release.mjs"),
  "utf-8",
);
const config = yaml.load(
  readFileSync(join(ROOT, ".routekit/publish-profiles.yaml"), "utf-8"),
);

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

  it("the publish step stays NON-FATAL — failures become warnings, not throws", () => {
    // A failed/thrown publish is captured on publishResult; the release still returns ok.
    expect(RELEASE_SRC).toMatch(/publishResult = \{ ok: false, warning/);
    expect(RELEASE_SRC).toMatch(/catch \(pubErr\)/);
    // The publish block is wrapped so a profile-load failure is caught, not thrown.
    expect(RELEASE_SRC).toMatch(/catch \(profileErr\)/);
  });

  it("config: the profile resolver finds the routekit-shell remote via rks-public", () => {
    const match = Object.entries(config.remotes).find(
      ([name, r]) => r.profile === "rks-public" || name === "rks-public",
    );
    expect(match).toBeTruthy();
    const [remoteName, remote] = match;
    expect(remoteName).toBe("rks-public");
    expect(remote.url).toContain("routekit-shell.git");
    expect(config.profiles["rks-public"]).toBeTruthy();
  });
});
