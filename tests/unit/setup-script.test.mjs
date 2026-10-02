import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { tmpdir } from "os";

// The whole existing suite drives runSetup through an INJECTED runner and never reaches the real
// spawnSync, so mocking node:child_process here is inert for those tests. It exists solely so the
// defaultRunner forwarding test (below) can inspect what spawnSync received without spawning.
// backlog.feat.setup-embed-untimed-runner
vi.mock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 0, error: null })) }));
import { spawnSync } from "node:child_process";
import { ensureEnv, ensureMcpJson, readProjectId, runSetup, shouldDisablePush, defaultRunner, checkCloneHealth } from "../../scripts/setup.mjs";

// Unit coverage for the turnkey `npm run setup` onboarding script. The pure file logic
// (ensureEnv / ensureMcpJson / readProjectId) is tested directly in a temp dir. The spawn
// side-effects (dev:link, add-existing, rag init/embed) are asserted via an INJECTED runner
// that records intent — never executed, so no real child process is ever spawned. RAG indexing
// is key-free, so the keyless non-interactive path runs those spawns too; only LLM-backed tools
// and the MCP server need a credential (checked at server boot, not here).

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
// `branch` DEFAULTS TO "main" — i.e. NOT detached — so every pre-existing call site below keeps its
// current behavior. Before backlog.fix.setup-preserve-detached-head-pin these args fell through to
// `{ stdout: "", status: 0 }`, which is also non-detached, so the default is behavior-preserving by
// construction. Pass branch: "HEAD" to simulate a tag-pinned clone.
function mockGit({ origin = "", staging = true, dirty = false, branch = "main", described = "v0.4.2" } = {}) {
  return (args) => {
    if (args[0] === "remote" && args[1] === "get-url") return { stdout: origin, status: origin ? 0 : 1 };
    if (args[0] === "status") return { stdout: dirty ? " M somefile\n" : "", status: 0 };
    if (args[0] === "ls-remote") return { stdout: staging ? "deadbeef\trefs/heads/staging\n" : "", status: 0 };
    // Status 0 even when detached — that success is exactly what made status-based checks wrong.
    if (args[0] === "rev-parse") return { stdout: `${branch}\n`, status: 0 };
    if (args[0] === "describe") return { stdout: described ? `${described}\n` : "", status: 0 };
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
  // backlog.fix.published-tests-upstream-coupled — AC1/AC6.
  //
  // publish.mjs:216 rewrites the identity WHOLESALE inside scripts/setup.mjs
  // (`s.split(from).join(to)`) but does NOT rewrite tests/**. A test-side literal compared
  // against a value produced by that source therefore AGREES upstream and DISAGREES on the
  // mirror — the asymmetry that left the public mirror's CI red for ten consecutive days.
  //
  // The expectation is derived from the source instead, using the two INDEPENDENT executable
  // sites in scripts/setup.mjs:
  //   :76  `....id || "routekit-shell-core";`  DERIVATION site — the fallback never reaches it
  //   :78  `return "routekit-shell-core";`     EXERCISED site — the catch branch it does reach
  // Deriving from :76 while exercising :78 is what makes AC1 and AC6 jointly satisfiable: the
  // whole-file rewrite moves BOTH (so this stays green in the snapshot), while a single-site
  // mutation of :78 moves only the actual (so it goes red). Collapsing them into one site
  // would compare a value against itself and prove nothing.

  // Matches :76 ONLY — :78 has no `.id ||` prefix, and :73/:108/:111 are prose comments.
  const DERIVATION_SITE = /\.id\s*\|\|\s*"([^"]+)"/;
  // Matches :78 ONLY — line-anchored on WHATEVER identity the source currently carries, so it
  // lands in either topology. Under /m the `$` anchor is end-of-LINE, which is the scope
  // wanted here. Built per-call rather than as a constant, because a pattern hardcoded to the
  // upstream literal matches NOTHING in the published snapshot, where the source is already
  // rewritten — and a control that silently matches nothing proves nothing.
  const exercisedSitePattern = (identity) =>
    new RegExp(`^(\\s*return )"${identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}";$`, "m");

  const identityFromDerivationSite = (src) => {
    const m = src.match(DERIVATION_SITE);
    // A miss is a hard failure, never a silent default: the expectation has to be an
    // OBSERVATION of the source, not a guess about it.
    if (!m) throw new Error("AC1: could not read the identity from the derivation site of setup.mjs");
    return m[1];
  };

  const loadFrom = async (src, name) => {
    const p = join(root, name);
    writeFileSync(p, src);
    return import(pathToFileURL(p).href);
  };

  it("reads the id from .rks/project.json", () => {
    // Round trip: the beforeEach writes this id into the fixture and readProjectId reads it
    // back. Both sides are test-side, so it agrees in the snapshot too. Correct as it stands.
    expect(readProjectId(root)).toBe("routekit-shell-core");
  });

  it("falls back to routekit-shell-core when project.json is missing", () => {
    rmSync(join(root, ".rks", "project.json"));
    expect(readProjectId(root)).toBe(identityFromDerivationSite(readFileSync(SETUP_MJS, "utf8")));
  });

  it("AC6 — a project.json id that is neither identity is returned verbatim", () => {
    // Proves the project.json path is observably DISTINCT from the fallback path, so the
    // assertion above cannot be passing because both paths return the same thing.
    writeFileSync(join(root, ".rks", "project.json"), JSON.stringify({ id: "sentinel-neither-core-nor-mirror" }));
    expect(readProjectId(root)).toBe("sentinel-neither-core-nor-mirror");
  });

  it("AC1 — the fallback assertion survives the publish identity rewrite (whole-file)", async () => {
    // The rewrite publish.mjs:216 actually performs. It moves :76 and :78 TOGETHER, so
    // expected and actual both become the to-value and the assertion still holds.
    const src = readFileSync(SETUP_MJS, "utf8");
    const current = identityFromDerivationSite(src);
    // Rewrite whatever identity the source CURRENTLY carries to a synthetic marker — the same
    // whole-file split/join publish.mjs:216 performs. Hardcoding the upstream literal here
    // would make this control itself upstream-coupled: in the published snapshot the source is
    // ALREADY rewritten, so that split is a no-op and the case fails on the mirror. It did,
    // until the portability guard in tests/integration caught it.
    const rewritten = src.split(current).join("REWRITTEN-IDENTITY");
    expect(rewritten).not.toBe(src); // the rewrite is not a no-op, in EITHER topology
    const mod = await loadFrom(rewritten, "setup-identity-rewritten.mjs");
    rmSync(join(root, ".rks", "project.json"), { force: true });
    expect(identityFromDerivationSite(rewritten)).toBe("REWRITTEN-IDENTITY");
    expect(mod.readProjectId(root)).toBe(identityFromDerivationSite(rewritten));
  });

  it("AC6 — the fallback assertion FAILS under a SINGLE-SITE mutation of the exercised site", async () => {
    // The control that makes the AC1 case non-vacuous. Mutating ONLY :78 leaves the :76
    // derivation site untouched, so expected and actual diverge and the assertion must fail.
    // A whole-file split/join would move both and pass while proving nothing — which is why
    // this control is a single-site mutation and the case above is not.
    const src = readFileSync(SETUP_MJS, "utf8");
    const current = identityFromDerivationSite(src);
    const mutated = src.replace(exercisedSitePattern(current), '$1"MUTATED-EXERCISED-SITE";');
    expect(mutated).not.toBe(src); // the mutation actually applied — a no-op would prove nothing
    expect(identityFromDerivationSite(mutated)).toBe(current); // :76 untouched
    const mod = await loadFrom(mutated, "setup-single-site-mutated.mjs");
    rmSync(join(root, ".rks", "project.json"), { force: true });
    expect(mod.readProjectId(root)).toBe("MUTATED-EXERCISED-SITE");
    expect(mod.readProjectId(root)).not.toBe(identityFromDerivationSite(mutated));
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
      // branch stated EXPLICITLY: this test must not depend on the unmatched-args fallthrough for
      // rev-parse. It is the happy path, so it has to be unambiguously on a branch.
      gitCapture: mockGit({ origin: "git@github.com:ux287/routekit-shell-core.git", staging: true, dirty: false, branch: "main" }),
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

  it("keyless non-interactive: still runs the four key-free spawns, warns a key is needed later", async () => {
    const calls = [];
    const warns = [];
    const r = await runSetup({
      root,
      isTTY: false,
      runner: (c, a) => calls.push([c, ...a]),
      gitCapture: mockGit({ origin: "git@github.com:ux287/routekit-shell-core.git", staging: false }),
      log: () => {},
      warn: (m) => warns.push(String(m)),
    });
    expect(r.ranSpawns).toBe(true);
    expect(existsSync(join(root, ".env"))).toBe(true);
    // RAG indexing is key-free: the four spawns run in order even with no API key. With no
    // origin/staging there is no git-posture spawn, so these four are the COMPLETE spawn set —
    // the regression guard that no credential-consuming step is attempted without a key.
    expect(calls).toEqual([
      ["npm", "run", "dev:link"],
      ["routekit", "project", "add-existing", "--id", "routekit-shell-core", "--stack", "routekit-shell", "--path", root],
      ["routekit", "rag", "init", "routekit-shell-core"],
      ["routekit", "rag", "embed", "routekit-shell-core"],
    ]);
    // Warn-only gate: points at the key-free rebuild path and flags the credential needed later.
    expect(warns.join("\n")).toMatch(/rag:embed/);
    expect(warns.join("\n")).toMatch(/ANTHROPIC_API_KEY/);
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

describe("runSetup — no-TTY keyless path (in-process, no real subprocess)", () => {
  it("piped/no-TTY stdin with no key: creates .env, prints template + key-free guidance, resolves ok without hanging", async () => {
    const logs = [];
    const warns = [];
    // In-process equivalent of the old real-subprocess smoke test: a no-op runner stands in for
    // the child processes, so nothing is actually spawned and the no-TTY path cannot hang on a
    // real prompt or a real `rag embed`. Asserts the same "resolves ok / creates .env / prints
    // guidance" contract the subprocess test protected, without executing anything.
    const r = await runSetup({
      root,
      isTTY: false,
      runner: () => {},
      gitCapture: mockGit({ origin: "git@github.com:ux287/routekit-shell-core.git", staging: false }),
      log: (m) => logs.push(String(m)),
      warn: (m) => warns.push(String(m)),
    });
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, ".env"))).toBe(true);
    // ensureEnv template message (setup.mjs:57) — pinned here, DISTINCT from the line-147 gate
    // guidance. It travels the `log` channel on template creation.
    expect(logs.join("\n")).toMatch(/set ANTHROPIC_API_KEY in \.env/);
    // Reworded line-147 gate guidance — key-free build / `npm run rag:embed`, on the `warn` channel.
    expect(warns.join("\n")).toMatch(/rag:embed/);
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
    // Collect-then-assert-once (no assertion inside the loop body): map both arms, then assert
    // none is non-runnable in a single expect.
    const nonRunnable = [true, false]
      .map((hasRemoteStaging) => landOnStagingCommand({ hasRemoteStaging }))
      .filter((cmd) => !/^git checkout -B staging/.test(cmd));
    expect(nonRunnable).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// backlog.fix.setup-preserve-detached-head-pin — setup must not silently un-pin a tag
// ══════════════════════════════════════════════════════════════════════════════════
//
// runSetup()'s land-on-staging chain had exactly three guards — no origin/staging, dirty tree, else
// land. Detached HEAD was not one of them, so a clone deliberately pinned to a release tag (the
// state the README's own stability advice recommends) fell into the else and was silently converted
// to a staging branch checkout. Nothing in the output said a pin had been discarded; the log line
// read as success.
//
// checkCloneHealth() already detected this correctly — but it runs AFTER the block, so it could only
// report the damage. This is a HOIST of that detection into a guard, not a MOVE of it: the health
// gate must still report detachedHead:true afterward, which the last test here pins.
//
// Every assertion below inspects RECORDED INTENT through the injected runner/gitCapture. No test in
// this block spawns git.

const DETACHED_GUARD = /HEAD is detached \(at/;
const DIRTY_GUARD = /Uncommitted changes present/;

async function runWithGit(gitOpts = {}) {
  const calls = [];
  const warnings = [];
  const logs = [];
  const r = await runSetup({
    root,
    isTTY: false,
    runner: (cmd, args) => calls.push([cmd, ...args]),
    gitCapture: mockGit({ origin: "git@github.com:ux287/routekit-shell-core.git", ...gitOpts }),
    log: (m) => logs.push(String(m)),
    warn: (m) => warnings.push(String(m)),
  });
  const gitCalls = calls.filter((c) => c[0] === "git");
  return {
    r,
    calls,
    warnings,
    logs,
    landed: gitCalls.some((c) => c[1] === "checkout" && c[2] === "-B" && c[3] === "staging"),
    fetched: gitCalls.some((c) => c[1] === "fetch" && c[2] === "origin" && c[3] === "staging"),
    detachedWarning: warnings.find((w) => DETACHED_GUARD.test(w)),
  };
}

describe("runSetup — detached HEAD preserves the pin", () => {
  it("PRIMARY: detached + clean + origin/staging present records NO checkout -B staging", async () => {
    const { landed } = await runWithGit({ branch: "HEAD", dirty: false, staging: true });
    expect(landed).toBe(false);
  });

  it("skips the WHOLE block — no `git fetch origin staging` either, not just the checkout", async () => {
    const { fetched } = await runWithGit({ branch: "HEAD", dirty: false, staging: true });
    expect(fetched).toBe(false);
  });

  it("reads the VALUE not the exit status: a status-0 rev-parse returning \"HEAD\" is detached", async () => {
    // mockGit returns status 0 for rev-parse in BOTH cases. That success is exactly what made every
    // truthiness/status-based check read a detached clone as healthy, so a status-driven
    // implementation would land on staging here and fail this test.
    const detached = await runWithGit({ branch: "HEAD", dirty: false, staging: true });
    const onBranch = await runWithGit({ branch: "main", dirty: false, staging: true });
    expect(detached.landed).toBe(false);
    expect(onBranch.landed).toBe(true);
  });

  it("POSITIVE CONTROL: a normal branch still fetches then checks out, in that order", async () => {
    const { calls } = await runWithGit({ branch: "main", dirty: false, staging: true });
    const gitSeq = calls.filter((c) => c[0] === "git").map((c) => c.join(" "));
    expect(gitSeq).toEqual(["git fetch origin staging", "git checkout -B staging --track origin/staging"]);
  });

  it("names the pinned ref from `git describe --tags --always`", async () => {
    const { detachedWarning } = await runWithGit({ branch: "HEAD", described: "v0.4.2", staging: true });
    expect(detachedWarning).toBeTruthy();
    expect(detachedWarning).toContain("v0.4.2");
  });

  it("falls back to a non-empty descriptor when git describe returns nothing", async () => {
    const { detachedWarning } = await runWithGit({ branch: "HEAD", described: "", staging: true });
    expect(detachedWarning).toBeTruthy();
    expect(detachedWarning).not.toMatch(/\(at \)/);
    expect(detachedWarning).toContain("an unnamed commit");
  });

  it("says setup deliberately did not switch — matched on a durable phrase, not the whole message", async () => {
    const { detachedWarning } = await runWithGit({ branch: "HEAD", staging: true });
    expect(detachedWarning).toMatch(/deliberately did NOT switch/);
  });

  it("MIRROR-SAFE ADVICE (origin/staging present): advice equals landOnStagingCommand(true)", async () => {
    const { landOnStagingCommand } = await import("../../scripts/setup.mjs");
    const { detachedWarning } = await runWithGit({ branch: "HEAD", staging: true });
    // Compared against the helper's own return, never a hardcoded literal, so it cannot drift.
    expect(detachedWarning).toContain(landOnStagingCommand({ hasRemoteStaging: true }));
  });

  it("MIRROR-SAFE ADVICE (origin/staging absent): advice equals landOnStagingCommand(false), no --track", async () => {
    const { landOnStagingCommand } = await import("../../scripts/setup.mjs");
    const { detachedWarning } = await runWithGit({ branch: "HEAD", staging: false });
    expect(detachedWarning).toContain(landOnStagingCommand({ hasRemoteStaging: false }));
    expect(detachedWarning).not.toContain("--track");
    expect(detachedWarning).not.toContain("origin/staging");
  });

  it("MATRIX detached + dirty: no checkout, and exactly one guard message fires (detached wins)", async () => {
    const { landed, warnings } = await runWithGit({ branch: "HEAD", dirty: true, staging: true });
    expect(landed).toBe(false);
    expect(warnings.filter((w) => DETACHED_GUARD.test(w))).toHaveLength(1);
    expect(warnings.filter((w) => DIRTY_GUARD.test(w))).toHaveLength(0);
  });

  it("MATRIX detached + origin/staging absent, clean and dirty alike: never lands", async () => {
    const clean = await runWithGit({ branch: "HEAD", dirty: false, staging: false });
    const dirty = await runWithGit({ branch: "HEAD", dirty: true, staging: false });
    expect([clean.landed, dirty.landed]).toEqual([false, false]);
  });

  it("HOIST NOT MOVE: checkCloneHealth still runs after the block and still reports detachedHead", async () => {
    const { r } = await runWithGit({ branch: "HEAD", dirty: false, staging: true });
    expect(r.health.detachedHead).toBe(true);
  });

  it("runSetup's return shape is unchanged", async () => {
    const { r } = await runWithGit({ branch: "HEAD", staging: true });
    expect(Object.keys(r).sort()).toEqual(["env", "health", "mcp", "ok", "projectId", "ranSpawns"]);
  });

  it("SINGLE IMPLEMENTATION: the literal HEAD comparison appears exactly once in scripts/setup.mjs", async () => {
    // Full-source count on a durable phrase — deliberately NOT a fixed-size src.slice() window,
    // which is how a previous structural test in this repo broke when the file shifted.
    const src = readFileSync(SETUP_MJS, "utf8");
    expect(src.match(/=== "HEAD"/g) || []).toHaveLength(1);
  });
});

describe("runSetup — pre-existing guards are untouched", () => {
  it("NEGATIVE CONTROL: dirty tree on a normal branch keeps its verbatim warning and never lands", async () => {
    const { landed, fetched, warnings } = await runWithGit({ branch: "main", dirty: true, staging: true });
    expect(landed).toBe(false);
    expect(fetched).toBe(false);
    const dirtyWarning = warnings.find((w) => DIRTY_GUARD.test(w));
    expect(dirtyWarning).toContain("Uncommitted changes present — setup did NOT switch you to the staging branch.");
    expect(dirtyWarning).toContain("git stash && ");
  });

  it("NO-REMOTE-STAGING guard preserved on a normal branch", async () => {
    const { landed, fetched, logs } = await runWithGit({ branch: "main", dirty: false, staging: false });
    expect(landed).toBe(false);
    expect(fetched).toBe(false);
    expect(logs.join("\n")).toContain("→ origin/staging not found — staying on the current branch.");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// backlog.feat.setup-embed-untimed-runner — cold-clone `npm run setup` ETIMEDOUT + orphan fix
// ══════════════════════════════════════════════════════════════════════════════════
//
// On a COLD fresh clone the first `rag embed` (ONNX model download + LanceDB table + ~11888
// chunks from scratch) can exceed the fixed 10-min spawnSync cap. When the cap fired, spawnSync
// SIGTERM'd only its direct child (the `routekit` CLI) — not the process group — so the grandchild
// embedder orphaned to PID 1, kept running, and held the TTY, while setup threw a false ETIMEDOUT
// that aborted the post-embed finishing steps. Fix: untime the embed step so setup blocks until it
// truly completes (nothing to orphan); the fast steps keep the protective default cap.
describe("runSetup — embed step is untimed while fast steps keep the cap", () => {
  it("passes timeout:0 to the `rag embed` runner call; add-existing + rag init do NOT opt out of the cap", async () => {
    const calls = [];
    await runSetup({
      root,
      isTTY: true,
      promptKey: async () => "sk-ant-TESTKEY",
      runner: (cmd, args, opts = {}) => calls.push({ cmd, args, opts }),
      gitCapture: mockGit({ origin: "git@github.com:ux287/routekit-shell-core.git", staging: false }),
      log: () => {},
    });
    const embed = calls.find((c) => c.cmd === "routekit" && c.args[0] === "rag" && c.args[1] === "embed");
    const addExisting = calls.find((c) => c.cmd === "routekit" && c.args[0] === "project");
    const ragInit = calls.find((c) => c.cmd === "routekit" && c.args[0] === "rag" && c.args[1] === "init");
    expect(embed).toBeTruthy();
    // The load-bearing assertion: the embed is invoked untimed (0 → no cap in defaultRunner/spawnSync).
    expect(embed.opts.timeout).toBe(0);
    // The fast steps carry no timeout override, so they inherit defaultRunner's protective 600000 cap.
    expect(addExisting.opts.timeout).toBeUndefined();
    expect(ragInit.opts.timeout).toBeUndefined();
  });
});

describe("defaultRunner — per-call timeout forwarding to spawnSync", () => {
  it("defaults to 600000ms when no timeout is given, and forwards a provided timeout verbatim", () => {
    spawnSync.mockClear();

    // Omitted → the protective 10-min default is forwarded.
    defaultRunner("echo", ["hi"], { cwd: root });
    expect(spawnSync).toHaveBeenLastCalledWith(
      "echo",
      ["hi"],
      expect.objectContaining({ cwd: root, stdio: "inherit", timeout: 600000 }),
    );

    // Provided (0 = untimed, the embed case) → forwarded verbatim, NOT coerced back to the default.
    defaultRunner("routekit", ["rag", "embed", "p"], { cwd: root, timeout: 0 });
    expect(spawnSync).toHaveBeenLastCalledWith(
      "routekit",
      ["rag", "embed", "p"],
      expect.objectContaining({ timeout: 0 }),
    );

    // A non-zero custom timeout is also forwarded verbatim.
    defaultRunner("x", [], { cwd: root, timeout: 1234 });
    expect(spawnSync).toHaveBeenLastCalledWith("x", [], expect.objectContaining({ timeout: 1234 }));
  });
});

/**
 * backlog.fix.preflight-core-skills-not-distributed — the SECOND consumer.
 *
 * scripts/setup.mjs ships in the rks-public archive and runs BEFORE preflight on a clean clone.
 * It called findMissingSkills(root, manifest.skills) — ALL skills, not just distributable — so a
 * mirror clone was warned that whitepaper was MISSING, a no-op `git checkout` was attempted, and
 * the post-restore re-check at :364 (which re-derives independently) printed
 * "Restore incomplete — still missing: whitepaper." A fix touching only the first call site would
 * still print it.
 *
 * checkCloneHealth is exported with gitCapture/runner/log/warn all injected, so every assertion
 * below reads a captured emitted STRING and no subprocess is spawned.
 */
const HEALTH_NOT_PUBLISHED = [
  { skill: "whitepaper", requires: "packages/whitepaper", reason: "excluded with its renderer" },
];

function makeHealthRoot({ present = ["arch", "build"], companionPresent = false, notPublished = HEALTH_NOT_PUBLISHED } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rks-setup-health-"));
  mkdirSync(join(root, ".routekit"), { recursive: true });
  const manifest = { version: 1, skills: ["arch", "build", "whitepaper"], shellOnly: [] };
  if (notPublished !== null) manifest.notPublished = notPublished;
  writeFileSync(join(root, ".routekit", "skills-manifest.json"), JSON.stringify(manifest));
  for (const name of present) {
    mkdirSync(join(root, ".claude", "skills", name), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", name, "SKILL.md"), `# ${name}\n`);
  }
  // checkCloneHealth resolves the shared reader against `root` at call time. A fixture lacking it
  // degrades silently and SKIPS the check — which would make every assertion below vacuous.
  const shared = join(root, "packages", "mcp-rks", "src", "shared");
  mkdirSync(shared, { recursive: true });
  writeFileSync(
    join(shared, "skills-manifest.mjs"),
    readFileSync(join(REPO_ROOT_FOR_HEALTH, "packages/mcp-rks/src/shared/skills-manifest.mjs"), "utf8"),
  );
  if (companionPresent) {
    mkdirSync(join(root, "packages", "whitepaper"), { recursive: true });
    writeFileSync(join(root, "packages", "whitepaper", "package.json"), "{}");
  }
  return root;
}

const REPO_ROOT_FOR_HEALTH = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function runHealth(root) {
  const logs = [];
  const warns = [];
  const ran = [];
  const health = await checkCloneHealth(root, {
    gitCapture: () => ({ stdout: "main\n" }),
    runner: (cmd, args) => { ran.push([cmd, ...args].join(" ")); return { status: 0 }; },
    log: (m) => logs.push(String(m)),
    warn: (m) => warns.push(String(m)),
    hasRemoteStaging: true,
  });
  return { health, logs, warns, ran, all: [...logs, ...warns].join("\n") };
}

describe("checkCloneHealth — a not-distributed skill is not a missing skill", () => {
  it("PUBLISHED TREE: no MISSING warning, no restore attempted, no terminal 'Restore incomplete'", async () => {
    const root = makeHealthRoot();
    const { health, all, ran, logs } = await runHealth(root);

    // Anti-vacuity: the check must actually have RUN, not degraded away.
    expect(all).not.toMatch(/skipping the core-skills check/);
    expect(logs.join("\n")).toMatch(/Core skills present/);

    expect(health.missingSkills).toEqual([]);
    expect(health.notDistributedSkills).toEqual(["whitepaper"]);
    expect(all).not.toMatch(/are MISSING from \.claude\/skills/);
    expect(all).not.toMatch(/Restore incomplete/);
    expect(all).not.toMatch(/git checkout/);
    // The no-op restore must never fire.
    expect(ran.filter((c) => c.includes("checkout"))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("NOT BLIND — full checkout with the companion package present: still warns and still restores", async () => {
    const root = makeHealthRoot({ companionPresent: true });
    const { health, all, ran } = await runHealth(root);
    expect(health.missingSkills).toEqual(["whitepaper"]);
    expect(all).toMatch(/are MISSING from \.claude\/skills/);
    expect(all).toMatch(/whitepaper/);
    expect(ran.some((c) => c.startsWith("git checkout HEAD -- .claude/skills"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("NOT BLIND — an UNDECLARED absent skill warns in BOTH tree shapes", async () => {
    for (const companionPresent of [false, true]) {
      const root = makeHealthRoot({ present: ["arch"], companionPresent });
      const { health, all } = await runHealth(root);
      expect(health.missingSkills, `companionPresent=${companionPresent}`).toContain("build");
      expect(all).toMatch(/are MISSING from \.claude\/skills/);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FAILS CLOSED — no notPublished declaration: whitepaper reads as genuinely missing", async () => {
    const root = makeHealthRoot({ notPublished: null });
    const { health, all } = await runHealth(root);
    expect(health.missingSkills).toEqual(["whitepaper"]);
    expect(all).toMatch(/are MISSING from \.claude\/skills/);
    rmSync(root, { recursive: true, force: true });
  });
});
