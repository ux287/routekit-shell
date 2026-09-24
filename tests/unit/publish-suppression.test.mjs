/**
 * backlog.feat.suppressible-public-publish — DECISIVE no-push coverage at the publish() layer.
 *
 * The force-push this suite guards is `spawnSync("git", ["push", "-f", "target", HEAD:<branch>])`
 * inside publish(). Every assertion here inspects the RECORDED spawnSync calls — never a parsed
 * config value, never a getProfile() return — because only the recorded spawn proves that no push
 * was attempted.
 *
 * Interception pattern: hoisted module-level `vi.mock("child_process", ...)` + a STATIC import of
 * publish(). This is the pattern proven in tests/unit/publish.test.mjs. The
 * `vi.doMock` + `vi.resetModules()` + dynamic-import pattern is deliberately NOT used — it is the
 * documented reason tests/unit/git-release.gh-release.test.mjs is skipped at the describe level —
 * its mock did not intercept, and the tests ran real commands against GitHub.
 *
 * MANDATORY INTERCEPTION CANARY: control runs assert `expect(spawnSync).toHaveBeenCalled()`, so a
 * mock that silently fails to intercept reds instead of passing vacuously.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  publish,
  listRemotes,
  loadPublishProfiles,
  validateRemoteEntry,
} from "../../packages/mcp-rks/src/server/publish.mjs";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn() };
});

const { spawnSync } = await import("child_process");

// --- fixture helpers ---------------------------------------------------------------

const tempRoots = [];

/** A fixture project root carrying its OWN .routekit/publish-profiles.yaml. Never the live repo. */
function makeRoot(profilesYaml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-publish-suppression-"));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  fs.writeFileSync(path.join(root, ".routekit", "publish-profiles.yaml"), profilesYaml, "utf-8");
  return root;
}

/**
 * `remotes` is an array of [name, [lines...]] — raw YAML lines so a test can express a
 * malformed value or a typo'd key that a JS object could not round-trip faithfully.
 */
function profilesYaml(remotes) {
  const lines = [
    "profiles:",
    "  rks-public:",
    '    description: "fixture public profile"',
    "    include:",
    '      - "README.md"',
    "",
    "remotes:",
  ];
  for (const [name, entryLines] of remotes) {
    lines.push(`  ${name}:`);
    for (const l of entryLines) lines.push(`    ${l}`);
  }
  return lines.join("\n") + "\n";
}

const ARMED_URL = 'url: "git@github.com:example/fixture-mirror.git"';
const PROFILE_LINE = 'profile: "rks-public"';
const BRANCH_LINE = 'branch: "main"';

/** Happy-path spawnSync: every git/tar call succeeds so a permitted publish runs to the push. */
function armSpawnSync() {
  spawnSync.mockImplementation((cmd, args) => {
    if (cmd === "git" && args?.[0] === "remote" && args?.[1] === "get-url") {
      return { status: 1, stdout: "", stderr: "not found" };
    }
    if (cmd === "git" && args?.[0] === "archive") {
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.from("") };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
}

const calls = () => spawnSync.mock.calls;
const matching = (pred) => calls().filter(([cmd, args]) => pred(cmd, Array.isArray(args) ? args : []));
const forcePushes = () => matching((cmd, args) => cmd === "git" && args[0] === "push" && args[1] === "-f");

beforeEach(() => {
  spawnSync.mockReset();
  armSpawnSync();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tempRoots.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// --- the decisive assertions -------------------------------------------------------

describe("publish() — enabled:false disarms the force-push (DECISIVE)", () => {
  it("records ZERO `git push -f` spawns when the resolved remote has enabled: false", async () => {
    const root = makeRoot(
      profilesYaml([["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, "enabled: false"]]]),
    );

    const result = await publish(root, { remote: "rks-public", profile: "rks-public" });

    // Inspect EVERY recorded call — not a config value.
    expect(forcePushes()).toEqual([]);
    expect(result.ok).not.toBe(true);
    expect(result.suppressed).toBe(true);
    expect(result.reason).toMatch(/rks-public/);
    expect(result.reason).toMatch(/enabled/);
  });

  it("MUTATION 1 control (guard inverted): the SAME fixture with enabled: true DOES push", async () => {
    const root = makeRoot(
      profilesYaml([["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, "enabled: true"]]]),
    );

    const result = await publish(root, { remote: "rks-public", profile: "rks-public" });

    expect(spawnSync).toHaveBeenCalled(); // INTERCEPTION CANARY
    expect(forcePushes().length).toBe(1);
    expect(forcePushes()[0][1]).toEqual(["push", "-f", "target", "HEAD:main"]);
    expect(result.ok).toBe(true);
  });

  it("MUTATION 3 (backward-compat control): with `enabled` ABSENT the publish proceeds and DOES push", async () => {
    const root = makeRoot(
      profilesYaml([["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE]]]),
    );

    const result = await publish(root, { remote: "rks-public", profile: "rks-public" });

    expect(spawnSync).toHaveBeenCalled(); // INTERCEPTION CANARY
    expect(forcePushes().length).toBe(1);
    expect(result.ok).toBe(true);
  });

  it("short-circuits BEFORE the temp export — no git archive, no tar, no `git remote add target`", async () => {
    const root = makeRoot(
      profilesYaml([["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, "enabled: false"]]]),
    );

    await publish(root, { remote: "rks-public", profile: "rks-public" });

    expect(matching((cmd, args) => cmd === "git" && args[0] === "archive")).toEqual([]);
    expect(matching((cmd) => cmd === "tar")).toEqual([]);
    expect(
      matching((cmd, args) => cmd === "git" && args[0] === "remote" && args[1] === "add" && args[2] === "target"),
    ).toEqual([]);
    // Nothing at all is spawned: it does not build a snapshot it then declines to push.
    expect(calls()).toEqual([]);
  });

  it("ARCH D1: enabled:false with NO url is still suppressed — it never reaches the remoteExists fallback", async () => {
    const root = makeRoot(
      profilesYaml([["rks-public", [PROFILE_LINE, BRANCH_LINE, "enabled: false"]]]),
    );

    const result = await publish(root, { remote: "rks-public", profile: "rks-public" });

    expect(result.suppressed).toBe(true);
    expect(forcePushes()).toEqual([]);
    // The `else if (!remoteExists(...))` fallback would have spawned `git remote get-url`.
    // A guard nested inside `if (remoteConfig?.url)` would fall through to it and could push
    // to a locally-configured git remote of the same name.
    expect(matching((cmd, args) => cmd === "git" && args[0] === "remote" && args[1] === "get-url")).toEqual([]);
  });

  it("cannot be bypassed by naming the disarmed remote explicitly via the `remote` option", async () => {
    const root = makeRoot(
      profilesYaml([
        ["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, "enabled: false"]],
        ["scratch", ['url: "git@github.com:example/scratch.git"', PROFILE_LINE, BRANCH_LINE]],
      ]),
    );

    const result = await publish(root, { remote: "rks-public", profile: "rks-public" });

    expect(result.suppressed).toBe(true);
    expect(forcePushes()).toEqual([]);
  });
});

// --- fail-closed on ambiguity ------------------------------------------------------

describe("publish() — malformed `enabled` BLOCKS (fail closed, never coerced)", () => {
  const cases = [
    { label: 'string "false"', yamlValue: '"false"', shown: "false" },
    { label: 'string "true"', yamlValue: '"true"', shown: "true" },
    { label: 'string "no"', yamlValue: '"no"', shown: "no" },
    { label: "number 0", yamlValue: "0", shown: "0" },
    { label: "number 1", yamlValue: "1", shown: "1" },
    { label: "null", yamlValue: "null", shown: "null" },
    { label: "empty array", yamlValue: "[]", shown: "[]" },
  ];

  for (const { label, yamlValue, shown } of cases) {
    it(`MUTATION 2 (fail-open by coercion): ${label} is BLOCKED with an explicit error and records no push`, async () => {
      const root = makeRoot(
        profilesYaml([["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, `enabled: ${yamlValue}`]]]),
      );

      const result = await publish(root, { remote: "rks-public", profile: "rks-public" });

      expect(forcePushes()).toEqual([]);
      expect(result.ok).toBe(false);
      expect(result.blocked).toBe(true);
      expect(typeof result.error).toBe("string");
      expect(result.error).toContain(shown); // names the offending value
      expect(result.error).toMatch(/enabled/);
    });
  }

  it("BLOCK and SKIP are discriminable in the returned result (distinct error/reason fields)", async () => {
    const blockedRoot = makeRoot(
      profilesYaml([["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, 'enabled: "false"']]]),
    );
    const suppressedRoot = makeRoot(
      profilesYaml([["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, "enabled: false"]]]),
    );

    const blocked = await publish(blockedRoot, { remote: "rks-public", profile: "rks-public" });
    const suppressed = await publish(suppressedRoot, { remote: "rks-public", profile: "rks-public" });

    // BLOCK: an error, and NOT flagged as a deliberate suppression.
    expect(blocked.blocked).toBe(true);
    expect(blocked.error).toBeTruthy();
    expect(blocked.suppressed).toBeUndefined();
    expect(blocked.reason).toBeUndefined();

    // SKIP: a reason, and NOT flagged as a config error.
    expect(suppressed.suppressed).toBe(true);
    expect(suppressed.reason).toBeTruthy();
    expect(suppressed.blocked).toBeUndefined();
    expect(suppressed.error).toBeUndefined();

    expect(forcePushes()).toEqual([]);
  });

  it("`enabled:` with an empty YAML value (parses to null) also BLOCKS", async () => {
    const root = makeRoot(
      profilesYaml([["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, "enabled:"]]]),
    );

    const result = await publish(root, { remote: "rks-public", profile: "rks-public" });

    expect(result.blocked).toBe(true);
    expect(forcePushes()).toEqual([]);
  });
});

// --- strict known-key validation, scoped to the RESOLVED entry ----------------------

describe("publish() — unknown-key validation is strict and SCOPED to the resolved remote", () => {
  it("a typo'd sibling key (`enabeld: false`) BLOCKS with an error naming the key, and records no push", async () => {
    const root = makeRoot(
      profilesYaml([["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, "enabeld: false"]]]),
    );

    const result = await publish(root, { remote: "rks-public", profile: "rks-public" });

    expect(forcePushes()).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.error).toContain("enabeld");
  });

  it("an unknown key on an UNUSED remote does NOT brick publishing through the valid resolved remote", async () => {
    const root = makeRoot(
      profilesYaml([
        ["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE]],
        ["stale", ['url: "git@github.com:example/stale.git"', "enabeld: false", "wat: 3"]],
      ]),
    );

    const result = await publish(root, { remote: "rks-public", profile: "rks-public" });

    expect(spawnSync).toHaveBeenCalled(); // INTERCEPTION CANARY
    expect(result.ok).toBe(true);
    expect(forcePushes().length).toBe(1);
  });

  it("all four known keys (url, profile, branch, enabled) are accepted together with no validation error", async () => {
    const root = makeRoot(
      profilesYaml([["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, "enabled: true"]]]),
    );

    const result = await publish(root, { remote: "rks-public", profile: "rks-public" });

    expect(result.ok).toBe(true);
    expect(result.blocked).toBeUndefined();
    expect(result.suppressed).toBeUndefined();
  });

  it("validateRemoteEntry is pure and agrees with the driven behaviour (no fixture, no mocks)", () => {
    expect(validateRemoteEntry("m", { url: "u", profile: "p", branch: "b" })).toBeNull();
    expect(validateRemoteEntry("m", { url: "u", enabled: true })).toBeNull();
    expect(validateRemoteEntry("m", { url: "u", enabled: false })).toMatchObject({
      ok: false,
      suppressed: true,
    });
    expect(validateRemoteEntry("m", { url: "u", enabled: "false" })).toMatchObject({
      ok: false,
      blocked: true,
    });
    expect(validateRemoteEntry("m", { url: "u", enabeld: false })).toMatchObject({
      ok: false,
      blocked: true,
    });
    // A missing remote entry is not this helper's business — the existing
    // "Remote not found and no URL configured" path still owns that case.
    expect(validateRemoteEntry("m", null)).toBeNull();
  });
});

// --- ARCH D2: validation is NOT at load time ---------------------------------------

describe("ARCH D2 — loadPublishProfiles and listRemotes do NOT validate", () => {
  const yamlWithStaleEntry = () =>
    profilesYaml([
      ["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, "enabled: false"]],
      ["stale", ['url: "git@github.com:example/stale.git"', "enabeld: false"]],
    ]);

  it("loadPublishProfiles returns normally on a YAML whose UNUSED entry carries an out-of-set key", () => {
    const root = makeRoot(yamlWithStaleEntry());

    const config = loadPublishProfiles(root);

    expect(config.error).toBeUndefined();
    expect(Object.keys(config.remotes)).toEqual(["rks-public", "stale"]);
    expect(config.remotes.stale.enabeld).toBe(false);
  });

  it("listRemotes still enumerates EVERY remote entry, including the one with the out-of-set key", () => {
    const root = makeRoot(yamlWithStaleEntry());

    const remotes = listRemotes(root);

    expect(remotes.map((r) => r.name)).toEqual(["rks-public", "stale"]);
  });
});

// --- ARCH D3: honest reporting through listRemotes ---------------------------------

describe("ARCH D3 — listRemotes surfaces `enabled` (rks_publish_profiles cannot show a disarmed mirror as armed)", () => {
  it("includes enabled:false in the projection for an entry that sets it", () => {
    const root = makeRoot(
      profilesYaml([["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, "enabled: false"]]]),
    );

    const [entry] = listRemotes(root);

    expect(entry.name).toBe("rks-public");
    expect(entry.enabled).toBe(false);
    // The pre-existing projection is unchanged.
    expect(entry.url).toContain("fixture-mirror.git");
    expect(entry.profile).toBe("rks-public");
    expect(entry.branch).toBe("main");
  });

  it("includes enabled:true for an armed entry", () => {
    const root = makeRoot(
      profilesYaml([["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, "enabled: true"]]]),
    );
    expect(listRemotes(root)[0].enabled).toBe(true);
  });
});

// --- ARCH D4: dryRun interaction ---------------------------------------------------

describe("ARCH D4 — a disarmed remote returns the suppressed result, not a dry-run preview", () => {
  it("publish(..., { dryRun: true }) on a disarmed remote yields suppression and no preview payload", async () => {
    const root = makeRoot(
      profilesYaml([["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, "enabled: false"]]]),
    );

    const result = await publish(root, { remote: "rks-public", profile: "rks-public", dryRun: true });

    expect(result.ok).not.toBe(true);
    expect(result.suppressed).toBe(true);
    expect(result.dryRun).toBeUndefined();
    expect(result.plannedRenames).toBeUndefined();
    expect(result.includePatterns).toBeUndefined();
    expect(forcePushes()).toEqual([]);
  });

  it("CONTROL: a dry run against an ARMED remote still returns the preview", async () => {
    const root = makeRoot(
      profilesYaml([["rks-public", [ARMED_URL, PROFILE_LINE, BRANCH_LINE, "enabled: true"]]]),
    );

    const result = await publish(root, { remote: "rks-public", profile: "rks-public", dryRun: true });

    expect(spawnSync).toHaveBeenCalled(); // INTERCEPTION CANARY
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.includePatterns).toEqual(["README.md"]);
    expect(forcePushes()).toEqual([]);
  });
});
