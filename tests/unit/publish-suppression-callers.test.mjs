/**
 * backlog.feat.suppressible-public-publish — per-caller coverage for callers 2 and 3.
 *
 * publish() has exactly three callers. Caller 1 (git-release.mjs) is covered in
 * tests/unit/git-release-publish-suppression.test.mjs. This suite covers:
 *
 *   CALLER 2 — the `rks_publish` MCP tool in packages/mcp-rks/src/server.mjs (a thin
 *              pass-through): driven by exercising the REAL publish() with the exact option
 *              shape the handler passes, plus a no-bypass assertion that the handler can only
 *              reach a push through that single publish() call.
 *   CALLER 3 — `routekit publish` (packages/cli/src/cli/publish.js): driven through
 *              handlePublishCommand with --yes and deps.publish UNSTUBBED. Injecting a stub
 *              publish would bypass the code under test and prove nothing, so only
 *              log/errorLog/processExit are injected and spawnSync is mocked instead.
 *
 * Same hoisted `vi.mock("child_process", ...)` + static import pattern and the same mandatory
 * interception canary as tests/unit/publish-suppression.test.mjs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { publish } from "../../packages/mcp-rks/src/server/publish.mjs";
import { handlePublishCommand } from "../../packages/cli/src/cli/publish.js";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn() };
});

const { spawnSync } = await import("child_process");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");

// --- fixture helpers ---------------------------------------------------------------

const tempRoots = [];

function makeRoot(profilesYaml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-publish-callers-"));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  fs.writeFileSync(path.join(root, ".routekit", "publish-profiles.yaml"), profilesYaml, "utf-8");
  return root;
}

function profilesYaml({ enabled }) {
  const lines = [
    "profiles:",
    "  rks-public:",
    '    description: "fixture public profile"',
    "    include:",
    '      - "README.md"',
    "",
    "remotes:",
    "  rks-public:",
    '    url: "git@github.com:example/fixture-mirror.git"',
    '    profile: "rks-public"',
    '    branch: "main"',
  ];
  if (enabled !== undefined) lines.push(`    enabled: ${enabled}`);
  return lines.join("\n") + "\n";
}

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

const forcePushes = () =>
  spawnSync.mock.calls.filter(
    ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[0] === "push" && args[1] === "-f",
  );

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

// --- CALLER 2: the rks_publish MCP tool --------------------------------------------

/** The exact option shape server.mjs's rks_publish handler passes to publish(). */
function handlerOptions(remote, { dryRun = false } = {}) {
  return {
    projectId: "routekit-shell-core",
    remote,
    profile: "rks-public",
    branch: "main",
    dryRun,
    message: `Publish from RKS - ${new Date().toISOString()}`,
  };
}

describe("CALLER 2 — rks_publish MCP tool inherits the suppression", () => {
  it("the handler's exact option shape yields suppression and records no `git push -f`", async () => {
    const root = makeRoot(profilesYaml({ enabled: false }));

    const result = await publish(root, handlerOptions("rks-public"));

    expect(forcePushes()).toEqual([]);
    expect(result.ok).not.toBe(true);
    expect(result.suppressed).toBe(true);
    expect(result.reason).toMatch(/rks-public/);
  });

  it("CONTROL: the same option shape against an armed remote DOES push", async () => {
    const root = makeRoot(profilesYaml({ enabled: true }));

    const result = await publish(root, handlerOptions("rks-public"));

    expect(spawnSync).toHaveBeenCalled(); // INTERCEPTION CANARY
    expect(forcePushes().length).toBe(1);
    expect(result.ok).toBe(true);
  });

  it("NO BYPASS: the rks_publish handler reaches a push only through that single publish() call", () => {
    const src = readFileSync(path.join(ROOT, "packages/mcp-rks/src/server.mjs"), "utf-8");
    const start = src.indexOf('if (tool === "rks_publish") {');
    const end = src.indexOf('if (tool === "rks_publish_profiles") {');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = src.slice(start, end);

    // Exactly one publish() invocation…
    expect(handler.match(/await publish\(/g)?.length).toBe(1);
    // …and no independent route to a subprocess or a push.
    expect(handler).not.toMatch(/spawnSync|execSync|spawn\(/);
    expect(handler).not.toMatch(/"push"/);
    // …and the result is passed through unchanged, so suppression is reported honestly.
    expect(handler).toMatch(/JSON\.stringify\(result/);
  });
});

// --- CALLER 3: the routekit publish CLI --------------------------------------------

function driveCli(root, extraKv = {}) {
  const out = [];
  const err = [];
  let exitCode = null;
  return handlePublishCommand(
    { kv: { root, yes: true, ...extraKv }, args: [], SHELL_ROOT: root },
    {
      // deps.publish deliberately NOT stubbed — the REAL publish() runs under the mocked
      // spawnSync, so the guard under test actually executes.
      processExit: (code) => { exitCode = code; return code; },
      log: (m) => out.push(String(m)),
      errorLog: (m) => err.push(String(m)),
    },
  ).then(() => ({ out: out.join("\n"), err: err.join("\n"), exitCode }));
}

describe("CALLER 3 — `routekit publish --yes` inherits the suppression", () => {
  it("records no `git push -f` against a disarmed remote (real publish, mocked spawnSync)", async () => {
    const root = makeRoot(profilesYaml({ enabled: false }));

    const { exitCode } = await driveCli(root);

    expect(forcePushes()).toEqual([]);
    expect(exitCode).not.toBe(0);
  });

  it("CONTROL: with the remote armed the CLI DOES push and reports success", async () => {
    const root = makeRoot(profilesYaml({ enabled: true }));

    const { out, exitCode } = await driveCli(root);

    expect(spawnSync).toHaveBeenCalled(); // INTERCEPTION CANARY
    expect(forcePushes().length).toBe(1);
    expect(exitCode).toBe(0);
    expect(out).toMatch(/Published to/);
  });

  it("honest reporting: suppression is NOT surfaced as `publish failed: unknown error`", async () => {
    const root = makeRoot(profilesYaml({ enabled: false }));

    const { err, exitCode } = await driveCli(root);

    expect(err).not.toMatch(/publish failed/);
    expect(err).toMatch(/SKIPPED/);
    expect(err).toMatch(/disarmed|enabled: false/);
    // The exit code distinguishes suppression from failure (1) and from success (0).
    expect(exitCode).not.toBe(1);
    expect(exitCode).not.toBe(0);
  });

  it("a genuine publish failure still reports through the failure path with exit 1", async () => {
    const root = makeRoot(profilesYaml({ enabled: true }));
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "git" && args?.[0] === "remote" && args?.[1] === "get-url") {
        return { status: 1, stdout: "", stderr: "not found" };
      }
      if (cmd === "git" && args?.[0] === "archive") {
        return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("no such ref") };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const { err, exitCode } = await driveCli(root);

    expect(err).toMatch(/publish failed/);
    expect(err).not.toMatch(/unknown error/);
    expect(exitCode).toBe(1);
    expect(forcePushes()).toEqual([]);
  });

  it("ARCH D4: a suppressed --dry-run is reported as SKIPPED — not as a successful preview", async () => {
    const root = makeRoot(profilesYaml({ enabled: false }));

    const { out, err, exitCode } = await driveCli(root, { "dry-run": true, yes: false });

    // Must NOT print the successful-preview text from the `if (dryRun)` branch…
    expect(out).not.toMatch(/Dry run/);
    expect(out).not.toMatch(/include patterns/);
    // …and must NOT fall through the generic failure path.
    expect(err).not.toMatch(/publish failed/);
    expect(err).toMatch(/SKIPPED/);
    expect(exitCode).not.toBe(0);
    expect(forcePushes()).toEqual([]);
  });

  it("CONTROL: an armed --dry-run still prints the preview and does not push", async () => {
    const root = makeRoot(profilesYaml({ enabled: true }));

    const { out, exitCode } = await driveCli(root, { "dry-run": true, yes: false });

    expect(out).toMatch(/Dry run/);
    expect(exitCode).toBe(0);
    expect(forcePushes()).toEqual([]);
  });
});
