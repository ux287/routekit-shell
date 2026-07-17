import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { ensureEnv, ensureMcpJson, readProjectId, runSetup, shouldDisablePush } from "../../scripts/setup.mjs";

// Unit coverage for the turnkey `npm run setup` onboarding script. The pure file logic
// (ensureEnv / ensureMcpJson / readProjectId) is tested directly in a temp dir. The spawn
// side-effects (dev:link, rag init/embed) are asserted via an INJECTED runner that records
// intent — never executed. One real subprocess run exercises the no-TTY CLI exit path with a
// hard timeout guard (no dev:link/rag runs there because there is no key).

const ENV_EXAMPLE = [
  "ROUTEKIT_LLM_PROVIDER=anthropic",
  "ROUTEKIT_LLM_MODEL=claude-sonnet-4-6",
  "ANTHROPIC_API_KEY=",
  "",
  "# ROUTEKIT_LLM_PROVIDER is optional — inferred from whichever key is set.",
  "",
].join("\n");
const MCP_EXAMPLE = '{\n  "mcpServers": {}\n}\n';
const SETUP_MJS = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/setup.mjs");

// Mock captured-git reader: simulate origin URL, working-tree cleanliness, and origin/staging
// presence — so runSetup's git-posture step is deterministic and spawns no real git.
function mockGit({ origin = "", staging = true, dirty = false } = {}) {
  return (args) => {
    if (args[0] === "remote" && args[1] === "get-url") return { stdout: origin, status: origin ? 0 : 1 };
    if (args[0] === "status") return { stdout: dirty ? " M somefile\n" : "", status: 0 };
    if (args[0] === "ls-remote") return { stdout: staging ? "deadbeef\trefs/heads/staging\n" : "", status: 0 };
    return { stdout: "", status: 0 };
  };
}

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rks-setup-"));
  writeFileSync(join(root, ".env.example"), ENV_EXAMPLE);
  writeFileSync(join(root, ".mcp.json.example"), MCP_EXAMPLE);
  mkdirSync(join(root, ".rks"), { recursive: true });
  writeFileSync(join(root, ".rks", "project.json"), JSON.stringify({ id: "routekit-shell-core" }));
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("ensureEnv — template copy + key write", () => {
  it("creates .env from .env.example when absent (no key)", () => {
    const r = ensureEnv(root, {});
    expect(existsSync(join(root, ".env"))).toBe(true);
    expect(r).toEqual({ hasKey: false, action: "created-no-key" });
  });

  it("writes ANTHROPIC_API_KEY when a key is provided (interactive path)", () => {
    const r = ensureEnv(root, { key: "sk-ant-TESTKEY" });
    expect(readFileSync(join(root, ".env"), "utf8")).toMatch(/^ANTHROPIC_API_KEY=sk-ant-TESTKEY$/m);
    expect(r).toEqual({ hasKey: true, action: "created-with-key" });
  });
});

describe("ensureEnv — idempotency (never clobber an existing .env)", () => {
  it("preserves an existing keyed .env byte-for-byte and does NOT write the offered key", () => {
    const existing = "ANTHROPIC_API_KEY=sk-ant-MINE\nCUSTOM=1\n";
    writeFileSync(join(root, ".env"), existing);
    const r = ensureEnv(root, { key: "sk-ant-SHOULD-NOT-WRITE" });
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(existing);
    expect(r).toEqual({ hasKey: true, action: "preserved" });
  });

  it("preserves an existing keyless .env and reports hasKey=false", () => {
    const existing = "ANTHROPIC_API_KEY=\nFOO=bar\n";
    writeFileSync(join(root, ".env"), existing);
    const r = ensureEnv(root, {});
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(existing);
    expect(r).toEqual({ hasKey: false, action: "preserved" });
  });
});

describe("ensureMcpJson", () => {
  it("creates .mcp.json from template when absent", () => {
    expect(ensureMcpJson(root, {})).toEqual({ action: "created" });
    expect(existsSync(join(root, ".mcp.json"))).toBe(true);
  });

  it("leaves an existing .mcp.json untouched", () => {
    const existing = '{"custom":true}\n';
    writeFileSync(join(root, ".mcp.json"), existing);
    expect(ensureMcpJson(root, {})).toEqual({ action: "preserved" });
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe(existing);
  });
});

describe("readProjectId", () => {
  it("reads the id from .rks/project.json", () => {
    expect(readProjectId(root)).toBe("routekit-shell-core");
  });
  it("falls back to routekit-shell-core when project.json is missing", () => {
    rmSync(join(root, ".rks", "project.json"));
    expect(readProjectId(root)).toBe("routekit-shell-core");
  });
});

describe("runSetup — spawn intent via injected runner (no real execution)", () => {
  it("WOULD run dev:link, rag init + embed, then land on staging", async () => {
    const calls = [];
    const r = await runSetup({
      root,
      isTTY: true,
      promptKey: async () => "sk-ant-TESTKEY",
      runner: (cmd, args) => calls.push([cmd, ...args]),
      gitCapture: mockGit({ origin: "git@github.com:ux287/routekit-shell-core.git", staging: true, dirty: false }),
      log: () => {},
    });
    expect(r.ok).toBe(true);
    expect(r.ranSpawns).toBe(true);
    expect(calls).toEqual([
      ["npm", "run", "dev:link"],
      ["routekit", "project", "add-existing", "--id", "routekit-shell-core", "--stack", "routekit-shell", "--path", root],
      ["routekit", "rag", "init", "routekit-shell-core"],
      ["routekit", "rag", "embed", "routekit-shell-core"],
      ["git", "fetch", "origin", "staging"],
      ["git", "checkout", "-B", "staging", "--track", "origin/staging"],
    ]);
    // private -core clone → push is NOT disabled (no `git remote set-url` call)
    expect(calls.some((c) => c[0] === "git" && c[1] === "remote")).toBe(false);
    expect(readFileSync(join(root, ".env"), "utf8")).toMatch(/ANTHROPIC_API_KEY=sk-ant-TESTKEY/);
  });

  it("registers with `add-existing` (not `attach`/`init`) AFTER dev:link and BEFORE rag init", async () => {
    const calls = [];
    await runSetup({
      root,
      isTTY: true,
      promptKey: async () => "sk-ant-TESTKEY",
      runner: (cmd, args) => calls.push([cmd, ...args]),
      gitCapture: mockGit({ staging: false }),
      log: () => {},
    });
    const linkIdx = calls.findIndex((c) => c[0] === "npm" && c[2] === "dev:link");
    const registerIdx = calls.findIndex((c) => c[0] === "routekit" && c[1] === "project");
    const ragInitIdx = calls.findIndex((c) => c[0] === "routekit" && c[1] === "rag" && c[2] === "init");
    // load-bearing order: registration needs `routekit` on PATH (from dev:link) and must populate
    // the registry before rag init can resolve the project.
    expect(linkIdx).toBeGreaterThanOrEqual(0);
    expect(registerIdx).toBeGreaterThan(linkIdx);
    expect(ragInitIdx).toBeGreaterThan(registerIdx);
    expect(calls[registerIdx]).toEqual([
      "routekit", "project", "add-existing", "--id", "routekit-shell-core", "--stack", "routekit-shell", "--path", root,
    ]);
    // must be the pure registry upsert `add-existing` — never `attach` (self-copies skills on a
    // self-hosting clone → ENOENT) or `init` (throws ensureEmptyDirectory on a populated clone)
    expect(calls.some((c) => c[1] === "project" && (c[2] === "attach" || c[2] === "init"))).toBe(false);
  });

  it("is idempotent — an existing keyed .env skips the prompt but still links + builds the KG", async () => {
    writeFileSync(join(root, ".env"), "ANTHROPIC_API_KEY=sk-ant-EXISTING\n");
    let prompted = false;
    const calls = [];
    const r = await runSetup({
      root,
      isTTY: true,
      promptKey: async () => {
        prompted = true;
        return "sk-ant-NEW";
      },
      runner: (cmd, args) => calls.push([cmd, ...args]),
      gitCapture: mockGit({ staging: false }),
      log: () => {},
    });
    expect(prompted).toBe(false);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("ANTHROPIC_API_KEY=sk-ant-EXISTING\n");
    expect(r.ranSpawns).toBe(true);
    expect(calls[0]).toEqual(["npm", "run", "dev:link"]);
  });

  it("runs NO spawns when there is no key (non-interactive)", async () => {
    const calls = [];
    const r = await runSetup({ root, isTTY: false, runner: (c, a) => calls.push([c, ...a]), log: () => {} });
    expect(r.ranSpawns).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(join(root, ".env"))).toBe(true);
  });
});

describe("shouldDisablePush — pull-only discriminator (survives publish identity rewrite)", () => {
  it("disables push for the PUBLIC mirror, keeps it for the private -core repo", () => {
    expect(shouldDisablePush("git@github.com:ux287/routekit-shell.git")).toBe(true);
    expect(shouldDisablePush("https://github.com/ux287/routekit-shell")).toBe(true);
    expect(shouldDisablePush("git@github.com:ux287/routekit-shell-core.git")).toBe(false);
    expect(shouldDisablePush("https://github.com/ux287/routekit-shell-core")).toBe(false);
    expect(shouldDisablePush("")).toBe(false);
  });

  it("POST-PUBLISH-REWRITE GUARD: discriminator survives publish.mjs's identity rewrite", async () => {
    // publish.mjs rewrites `routekit-shell-core` -> `routekit-shell` in the shipped public
    // setup.mjs. Apply the same transform to the real source, load it, and assert the
    // discriminator STILL distinguishes public vs core — the exact false-green ARCH flagged.
    const src = readFileSync(SETUP_MJS, "utf8");
    const rewritten = src.split("routekit-shell-core").join("routekit-shell");
    const tmpMod = join(root, "setup-rewritten.mjs");
    writeFileSync(tmpMod, rewritten);
    const mod = await import(pathToFileURL(tmpMod).href);
    expect(mod.shouldDisablePush("git@github.com:ux287/routekit-shell.git")).toBe(true);
    expect(mod.shouldDisablePush("git@github.com:ux287/routekit-shell-core.git")).toBe(false);
  });
});

describe("runSetup — git posture (staging checkout + pull-only public origin)", () => {
  const KEY = async () => "sk-ant-TESTKEY";

  it("PUBLIC mirror clone: disables push AND checks out staging", async () => {
    const calls = [];
    await runSetup({
      root, isTTY: true, promptKey: KEY, log: () => {},
      runner: (c, a) => calls.push([c, ...a]),
      gitCapture: mockGit({ origin: "git@github.com:ux287/routekit-shell.git", staging: true, dirty: false }),
    });
    expect(calls).toContainEqual(["git", "remote", "set-url", "--push", "origin", "no_push"]);
    expect(calls).toContainEqual(["git", "checkout", "-B", "staging", "--track", "origin/staging"]);
  });

  it("private -core clone: does NOT disable push, but checks out staging", async () => {
    const calls = [];
    await runSetup({
      root, isTTY: true, promptKey: KEY, log: () => {},
      runner: (c, a) => calls.push([c, ...a]),
      gitCapture: mockGit({ origin: "git@github.com:ux287/routekit-shell-core.git", staging: true, dirty: false }),
    });
    expect(calls.some((c) => c[0] === "git" && c[1] === "remote")).toBe(false);
    expect(calls).toContainEqual(["git", "checkout", "-B", "staging", "--track", "origin/staging"]);
  });

  it("missing origin/staging: graceful — no checkout, no throw", async () => {
    const calls = [];
    const r = await runSetup({
      root, isTTY: true, promptKey: KEY, log: () => {},
      runner: (c, a) => calls.push([c, ...a]),
      gitCapture: mockGit({ origin: "git@github.com:ux287/routekit-shell-core.git", staging: false }),
    });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c[0] === "git" && c[1] === "checkout")).toBe(false);
  });

  it("dirty tree: non-destructive — no checkout, logs stash guidance", async () => {
    const calls = [];
    const logs = [];
    await runSetup({
      root, isTTY: true, promptKey: KEY, log: (m) => logs.push(String(m)),
      runner: (c, a) => calls.push([c, ...a]),
      gitCapture: mockGit({ origin: "git@github.com:ux287/routekit-shell-core.git", staging: true, dirty: true }),
    });
    expect(calls.some((c) => c[0] === "git" && c[1] === "checkout")).toBe(false);
    expect(logs.join("\n")).toMatch(/stash/i);
  });

  it("closing guidance: reload, verify MCP, run preflight, then onboard", async () => {
    const logs = [];
    await runSetup({
      root, isTTY: true, promptKey: KEY, log: (m) => logs.push(String(m)),
      runner: () => {},
      gitCapture: mockGit({ staging: false }),
    });
    const out = logs.join("\n");
    expect(out).toContain("rks_preflight");
    expect(out).toContain("rks-onboard");
    expect(out).toMatch(/\/mcp/);
    expect(out).toMatch(/reload/i);
  });
});

describe("setup.mjs CLI — no-TTY process exits 0 (real subprocess, timeout-guarded)", () => {
  it("piped stdin: creates .env, prints guidance, exits 0, no hang, no dev:link/rag", () => {
    const r = spawnSync("node", [SETUP_MJS], {
      cwd: root,
      input: "", // non-TTY stdin → no prompt path
      encoding: "utf8",
      timeout: 20000,
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(root, ".env"))).toBe(true);
    expect(`${r.stdout || ""}${r.stderr || ""}`).toMatch(/set ANTHROPIC_API_KEY in \.env/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// backlog.fix.clean-machine-honesty — the advice must WORK on the clone you're standing in
// ══════════════════════════════════════════════════════════════════════════════════
//
// v0.27.2's health gate told a detached user to run:
//     git checkout -B staging --track origin/staging
// On a PUBLIC MIRROR clone that command FAILS outright — `fatal: 'origin/staging' is not a commit` —
// because the mirror publishes only origin/main and tags. `staging` is a -core branch and is not
// mirrored, so there is nothing to track.
//
// So the fix that DETECTED the problem prescribed a cure that fails in the exact environment it was
// most likely to run in: a fresh clone of the public mirror. That is worse than silence — the user
// follows the instructions, gets an error, and now distrusts both halves.
describe("landOnStagingCommand — mirror-aware remediation", () => {
  it("MIRROR (no origin/staging): does NOT tell you to --track a ref that does not exist", async () => {
    const { landOnStagingCommand } = await import("../../scripts/setup.mjs");
    const cmd = landOnStagingCommand({ hasRemoteStaging: false });
    expect(cmd).not.toContain("--track");
    expect(cmd).not.toContain("origin/staging");
    expect(cmd).toContain("git checkout -B staging");
  });

  // POSITIVE CONTROL. Without this, "no --track" is also satisfied by advice that says nothing at
  // all, or by an empty string — the test would pass while the guidance became useless.
  it("FULL CLONE (origin/staging exists): DOES track it", async () => {
    const { landOnStagingCommand } = await import("../../scripts/setup.mjs");
    const cmd = landOnStagingCommand({ hasRemoteStaging: true });
    expect(cmd).toBe("git checkout -B staging --track origin/staging");
  });

  it("both arms produce a runnable git command (not prose)", async () => {
    const { landOnStagingCommand } = await import("../../scripts/setup.mjs");
    for (const hasRemoteStaging of [true, false]) {
      expect(landOnStagingCommand({ hasRemoteStaging })).toMatch(/^git checkout -B staging/);
    }
  });
});
