// backlog.feat.remote-surface-http-entry: boot refusals and the bearer check.
// Every spawnSync passes timeout. Temp repos only; never a real registered project or the real .rks.
// The linked worktree and the primary checkout are BOTH created inside a fresh temp dir; `git worktree
// add` runs only with cwd inside that temp repo, after asserting its git common dir is inside it.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(ROOT, "packages/mcp-rks/bin/mcp-rks-http.mjs");
const PKG = path.join(ROOT, "packages/mcp-rks/package.json");
const SPAWN_MS = 15_000;
const PROJECT_ID = "http-boot-fixture";
const SECRET = "s3cret-boot-fixture-0123456789abcdef"; // 36 characters
const ACTOR = "grokbot";

const {
  checkBootEnv,
  checkBearer,
  buildBootEnv,
  MIN_BEARER_LENGTH,
  REMOTE_BIND_HOST,
  readSessionBounds,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SESSION_IDLE_MS,
  DEFAULT_STREAM_MAX_MS,
  DEFAULT_SSE_HEARTBEAT_MS,
  runBootIndex,
  BOOT_INDEX_START,
  BOOT_INDEX_END,
} = await import(BIN);

const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rks-http-boot-")));
const primary = path.join(tmpBase, "primary");
const worktree = path.join(tmpBase, "wt");
const plainDir = path.join(tmpBase, "plain");
const tmpHome = path.join(tmpBase, "home");
const registryPath = path.join(tmpBase, "registry.jsonl");

function gitEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
}

function git(cwd, args) {
  if (!fs.realpathSync(cwd).startsWith(tmpBase)) throw new Error(`refusing git outside the temp base: ${cwd}`);
  const r = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", timeout: SPAWN_MS });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeFixture() {
  fs.mkdirSync(path.join(primary, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(primary, "notes"), { recursive: true });
  fs.mkdirSync(plainDir, { recursive: true });
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.writeFileSync(registryPath, "");
  fs.writeFileSync(path.join(primary, ".rks", "project.json"), JSON.stringify({ id: PROJECT_ID, notes: { vaultPath: "notes" } }, null, 2));
  fs.writeFileSync(path.join(primary, ".gitignore"), ".env\n.rks/session/\n.rks/telemetry/\n.rks/state/\n");
  fs.writeFileSync(path.join(primary, "notes", "fixture.md"), "---\nid: fixture\n---\n");
  git(primary, ["init", "-b", "main"]);
  git(primary, ["config", "user.email", "boot@test.invalid"]);
  git(primary, ["config", "user.name", "Boot Test"]);
  git(primary, ["config", "commit.gpgsign", "false"]);
  git(primary, ["add", "-A"]);
  git(primary, ["commit", "-m", "fixture", "--no-verify"]);
  // Positive control that the worktree add below can only touch this temp repo.
  const common = path.resolve(primary, git(primary, ["rev-parse", "--git-common-dir"]));
  if (!fs.realpathSync(common).startsWith(tmpBase)) throw new Error(`temp repo common dir escaped: ${common}`);
  git(primary, ["worktree", "add", "-b", "remote/inbox", worktree]);
}

function writeWorktreeEnv(content) {
  fs.writeFileSync(path.join(worktree, ".env"), content);
}

function validEnv(extra = {}) {
  return { RKS_REMOTE_ROOT: worktree, RKS_REMOTE_BEARER: SECRET, RKS_ACTOR: ACTOR, ...extra };
}

/** The child env: temp HOME, temp registry, VITEST kept, bypass vars and launcher identity dropped. */
function childEnv(extra = {}) {
  const env = gitEnv();
  for (const k of Object.keys(env)) {
    if (k.startsWith("RKS_") || k.startsWith("ROUTEKIT_") || k === "CLAUDE_PROJECT_DIR" || k === "NODE_ENV") delete env[k];
  }
  env.HOME = tmpHome;
  env.VITEST = env.VITEST || "true";
  env.RKS_REGISTRY_PATH = registryPath;
  env.RKS_REMOTE_PORT = "0";
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function spawnBin(extra) {
  const r = spawnSync(process.execPath, [BIN], { env: childEnv(extra), encoding: "utf8", timeout: SPAWN_MS });
  return { status: r.status, signal: r.signal, out: `${r.stdout || ""}${r.stderr || ""}`, stderr: r.stderr || "" };
}

beforeAll(() => {
  makeFixture();
});

afterAll(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("fixture premise", () => {
  it("the worktree is linked and the primary is not, both inside the temp base", () => {
    const wtDir = path.resolve(worktree, git(worktree, ["rev-parse", "--git-dir"]));
    const wtCommon = path.resolve(worktree, git(worktree, ["rev-parse", "--git-common-dir"]));
    expect(fs.realpathSync(wtDir)).not.toBe(fs.realpathSync(wtCommon));
    expect(fs.realpathSync(wtCommon).startsWith(tmpBase)).toBe(true);
    const pDir = path.resolve(primary, git(primary, ["rev-parse", "--git-dir"]));
    const pCommon = path.resolve(primary, git(primary, ["rev-parse", "--git-common-dir"]));
    expect(fs.realpathSync(pDir)).toBe(fs.realpathSync(pCommon));
  });
});

describe("mcp-rks-http checkBootEnv", () => {
  it("admits a valid env (positive control)", () => {
    expect(checkBootEnv(validEnv())).toBeNull();
  });

  it("refuses token-gate bypass vars", () => {
    for (const extra of [{ RKS_SKIP_PREFLIGHT: "1" }, { NODE_ENV: "test" }, { RKS_TEST_MODE: "1" }]) {
      expect(checkBootEnv(validEnv(extra))?.reason, JSON.stringify(extra)).toBe("token_gate_bypass");
    }
    expect(checkBootEnv(validEnv({ NODE_ENV: "production" }))).toBeNull();
  });

  it("refuses a missing or short bearer secret and admits 32 characters", () => {
    expect(MIN_BEARER_LENGTH).toBe(32);
    expect(checkBootEnv(validEnv({ RKS_REMOTE_BEARER: undefined }))?.reason).toBe("bearer_missing");
    const env = validEnv();
    delete env.RKS_REMOTE_BEARER;
    expect(checkBootEnv(env)?.reason).toBe("bearer_missing");
    expect(checkBootEnv(validEnv({ RKS_REMOTE_BEARER: "a".repeat(31) }))?.reason).toBe("bearer_too_short");
    expect(checkBootEnv(validEnv({ RKS_REMOTE_BEARER: "a".repeat(32) }))).toBeNull();
  });

  it("refuses a bad RKS_REMOTE_ROOT and admits a linked worktree", () => {
    const unset = validEnv();
    delete unset.RKS_REMOTE_ROOT;
    expect(checkBootEnv(unset)?.reason).toBe("remote_root_unset");
    expect(checkBootEnv(validEnv({ RKS_REMOTE_ROOT: path.join(tmpBase, "does-not-exist") }))?.reason).toBe("remote_root_missing");
    expect(checkBootEnv(validEnv({ RKS_REMOTE_ROOT: plainDir }))?.reason).toBe("remote_root_not_worktree");
    expect(checkBootEnv(validEnv({ RKS_REMOTE_ROOT: path.join(worktree, "notes") }))?.reason).toBe("remote_root_not_worktree");
    expect(checkBootEnv(validEnv({ RKS_REMOTE_ROOT: primary }))?.reason).toBe("remote_root_primary_checkout");
    expect(checkBootEnv(validEnv({ RKS_REMOTE_ROOT: worktree }))).toBeNull();
  });

  it("refuses an unset or invalid RKS_ACTOR", () => {
    const unset = validEnv();
    delete unset.RKS_ACTOR;
    expect(checkBootEnv(unset)?.reason).toBe("actor_invalid");
    for (const actor of ["", "Grok", "grok.bot", "-grok", "grok bot", "grok_bot"]) {
      expect(checkBootEnv(validEnv({ RKS_ACTOR: actor }))?.reason, actor).toBe("actor_invalid");
    }
    expect(checkBootEnv(validEnv({ RKS_ACTOR: "grok-bot-2" }))).toBeNull();
  });

  it("refuses any bind host other than 127.0.0.1", () => {
    expect(REMOTE_BIND_HOST).toBe("127.0.0.1");
    for (const host of ["0.0.0.0", "localhost", "::1", "", "192.168.1.10"]) {
      expect(checkBootEnv(validEnv({ RKS_REMOTE_HOST: host }))?.reason, host).toBe("bind_host_refused");
    }
    expect(checkBootEnv(validEnv({ RKS_REMOTE_HOST: "127.0.0.1" }))).toBeNull();
  });
});

describe("mcp-rks-http readSessionBounds stream bounds", () => {
  const INVALID = ["0", "-5", "abc", "1.5"];

  it("readSessionBounds({}) returns the exported defaults for all four bounds", () => {
    expect(readSessionBounds({})).toEqual({
      maxSessions: DEFAULT_MAX_SESSIONS,
      idleMs: DEFAULT_SESSION_IDLE_MS,
      streamMaxMs: DEFAULT_STREAM_MAX_MS,
      sseHeartbeatMs: DEFAULT_SSE_HEARTBEAT_MS,
    });
    expect(DEFAULT_MAX_SESSIONS).toBe(8);
    expect(DEFAULT_SESSION_IDLE_MS).toBe(30 * 60_000);
    expect(Number.isSafeInteger(DEFAULT_STREAM_MAX_MS) && DEFAULT_STREAM_MAX_MS > 0).toBe(true);
    expect(Number.isSafeInteger(DEFAULT_SSE_HEARTBEAT_MS) && DEFAULT_SSE_HEARTBEAT_MS > 0).toBe(true);
    expect(DEFAULT_SSE_HEARTBEAT_MS).toBeLessThan(DEFAULT_STREAM_MAX_MS);
  });

  it("RKS_REMOTE_STREAM_MAX_MS: a positive integer is used; 0, -5, abc and 1.5 refuse with remote_stream_max_ms_invalid", () => {
    expect(readSessionBounds({ RKS_REMOTE_STREAM_MAX_MS: "60000" }).streamMaxMs).toBe(60000);
    const refusals = INVALID.map((v) => readSessionBounds({ RKS_REMOTE_STREAM_MAX_MS: v }).refusal);
    expect(refusals.map((r) => r?.reason)).toEqual(INVALID.map(() => "remote_stream_max_ms_invalid"));
    expect(refusals.map((r) => String(r?.message).includes("RKS_REMOTE_STREAM_MAX_MS"))).toEqual([true, true, true, true]);
  });

  it("RKS_REMOTE_SSE_HEARTBEAT_MS: a positive integer is used; 0, -5, abc and 1.5 refuse with remote_sse_heartbeat_ms_invalid", () => {
    expect(readSessionBounds({ RKS_REMOTE_SSE_HEARTBEAT_MS: "5000" }).sseHeartbeatMs).toBe(5000);
    const refusals = INVALID.map((v) => readSessionBounds({ RKS_REMOTE_SSE_HEARTBEAT_MS: v }).refusal);
    expect(refusals.map((r) => r?.reason)).toEqual(INVALID.map(() => "remote_sse_heartbeat_ms_invalid"));
    expect(refusals.map((r) => String(r?.message).includes("RKS_REMOTE_SSE_HEARTBEAT_MS"))).toEqual([true, true, true, true]);
  });

  it("checkBootEnv refuses an invalid RKS_REMOTE_STREAM_MAX_MS or RKS_REMOTE_SSE_HEARTBEAT_MS and admits valid values", () => {
    expect(checkBootEnv(validEnv({ RKS_REMOTE_STREAM_MAX_MS: "0" }))?.reason).toBe("remote_stream_max_ms_invalid");
    expect(checkBootEnv(validEnv({ RKS_REMOTE_SSE_HEARTBEAT_MS: "0" }))?.reason).toBe("remote_sse_heartbeat_ms_invalid");
    expect(checkBootEnv(validEnv({ RKS_REMOTE_STREAM_MAX_MS: "60000", RKS_REMOTE_SSE_HEARTBEAT_MS: "5000" }))).toBeNull();
  });
});

describe("mcp-rks-http buildBootEnv", () => {
  it("takes the bearer from the .env only, the actor from the launch env only, and a bypass var from either", () => {
    const launch = { RKS_REMOTE_ROOT: worktree, RKS_REMOTE_BEARER: "launch-bearer", NODE_ENV: "production" };
    const merged = buildBootEnv(launch, { RKS_REMOTE_BEARER: SECRET, RKS_ACTOR: "intruder", NODE_ENV: "test" });
    expect(merged.RKS_REMOTE_BEARER).toBe(SECRET);
    expect("RKS_ACTOR" in merged).toBe(false);
    expect(merged.NODE_ENV).toBe("test");
    expect(checkBootEnv(merged)?.reason).toBe("token_gate_bypass");
    const noFileBearer = buildBootEnv({ ...launch, NODE_ENV: undefined, RKS_ACTOR: ACTOR }, {});
    expect("RKS_REMOTE_BEARER" in noFileBearer).toBe(false);
    expect(noFileBearer.RKS_ACTOR).toBe(ACTOR);
  });
});

describe("mcp-rks-http checkBearer", () => {
  it("accepts only the exact secret", () => {
    expect(checkBearer(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(checkBearer(undefined, SECRET)).toBe(false);
    expect(checkBearer("", SECRET)).toBe(false);
    expect(checkBearer(`Basic ${SECRET}`, SECRET)).toBe(false);
    expect(checkBearer(`bearer ${SECRET}`, SECRET)).toBe(false);
    const sameLength = SECRET.slice(0, -1) + (SECRET.endsWith("f") ? "e" : "f");
    expect(sameLength.length).toBe(SECRET.length);
    expect(checkBearer(`Bearer ${sameLength}`, SECRET)).toBe(false);
    expect(checkBearer(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(checkBearer(`Bearer ${SECRET.slice(1)}`, SECRET)).toBe(false);
    expect(() => checkBearer(["Bearer x"], SECRET)).not.toThrow();
    expect(checkBearer(`Bearer ${SECRET}`, undefined)).toBe(false);
  });
});

describe("mcp-rks-http spawned boot", () => {
  it("exits non-zero before listening for each refusal, naming the cause, with no secret in its output", () => {
    const valid = { RKS_REMOTE_ROOT: worktree, RKS_ACTOR: ACTOR };
    const cases = [
      { name: "RKS_SKIP_PREFLIGHT", env: { ...valid, RKS_SKIP_PREFLIGHT: "1" }, dotenv: `RKS_REMOTE_BEARER=${SECRET}\n`, reason: "token_gate_bypass" },
      { name: "NODE_ENV=test", env: { ...valid, NODE_ENV: "test" }, dotenv: `RKS_REMOTE_BEARER=${SECRET}\n`, reason: "token_gate_bypass" },
      { name: "RKS_TEST_MODE", env: { ...valid, RKS_TEST_MODE: "1" }, dotenv: `RKS_REMOTE_BEARER=${SECRET}\n`, reason: "token_gate_bypass" },
      { name: "bearer missing", env: valid, dotenv: "OTHER=1\n", reason: "bearer_missing" },
      { name: "bearer only in launch env", env: { ...valid, RKS_REMOTE_BEARER: SECRET }, dotenv: "OTHER=1\n", reason: "bearer_missing" },
      { name: "bearer 31 chars", env: valid, dotenv: `RKS_REMOTE_BEARER=${SECRET.slice(0, 31)}\n`, reason: "bearer_too_short" },
      { name: "root unset", env: { RKS_ACTOR: ACTOR }, dotenv: `RKS_REMOTE_BEARER=${SECRET}\n`, reason: "remote_root_unset" },
      { name: "root missing", env: { ...valid, RKS_REMOTE_ROOT: path.join(tmpBase, "nope") }, dotenv: `RKS_REMOTE_BEARER=${SECRET}\n`, reason: "remote_root_missing" },
      { name: "root not a worktree", env: { ...valid, RKS_REMOTE_ROOT: plainDir }, dotenv: `RKS_REMOTE_BEARER=${SECRET}\n`, reason: "remote_root_not_worktree" },
      { name: "root is the primary", env: { ...valid, RKS_REMOTE_ROOT: primary }, dotenv: `RKS_REMOTE_BEARER=${SECRET}\n`, reason: "remote_root_primary_checkout" },
      { name: "actor unset", env: { RKS_REMOTE_ROOT: worktree }, dotenv: `RKS_REMOTE_BEARER=${SECRET}\n`, reason: "actor_invalid" },
      { name: "actor only in .env", env: { RKS_REMOTE_ROOT: worktree }, dotenv: `RKS_REMOTE_BEARER=${SECRET}\nRKS_ACTOR=${ACTOR}\n`, reason: "actor_invalid" },
      { name: "actor invalid", env: { ...valid, RKS_ACTOR: "Grok.Bot" }, dotenv: `RKS_REMOTE_BEARER=${SECRET}\n`, reason: "actor_invalid" },
      { name: "host 0.0.0.0", env: { ...valid, RKS_REMOTE_HOST: "0.0.0.0" }, dotenv: `RKS_REMOTE_BEARER=${SECRET}\n`, reason: "bind_host_refused" },
      { name: "host localhost", env: { ...valid, RKS_REMOTE_HOST: "localhost" }, dotenv: `RKS_REMOTE_BEARER=${SECRET}\n`, reason: "bind_host_refused" },
      { name: "host ::1", env: { ...valid, RKS_REMOTE_HOST: "::1" }, dotenv: `RKS_REMOTE_BEARER=${SECRET}\n`, reason: "bind_host_refused" },
    ];
    for (const c of cases) {
      writeWorktreeEnv(c.dotenv);
      // The primary gets the same .env so the primary-checkout case is refused for the right reason.
      fs.writeFileSync(path.join(primary, ".env"), c.dotenv);
      const r = spawnBin(c.env);
      expect(r.signal, `${c.name}: killed by timeout`).toBeNull();
      expect(r.status, `${c.name}: ${r.out}`).toBe(1);
      expect(r.stderr, c.name).toContain(c.reason);
      expect(r.out, c.name).not.toContain("listening");
      expect(r.out, c.name).not.toContain(SECRET);
      expect(r.out, c.name).not.toContain(SECRET.slice(0, 31));
    }
  });

  it("refuses a bypass var introduced only by the RKS_REMOTE_ROOT .env", () => {
    for (const line of ["NODE_ENV=test", "RKS_SKIP_PREFLIGHT=1", "RKS_TEST_MODE=1"]) {
      writeWorktreeEnv(`RKS_REMOTE_BEARER=${SECRET}\n${line}\n`);
      const r = spawnBin({ RKS_REMOTE_ROOT: worktree, RKS_ACTOR: ACTOR });
      expect(r.signal, `${line}: killed by timeout`).toBeNull();
      expect(r.status, `${line}: ${r.out}`).toBe(1);
      expect(r.stderr, line).toContain("token_gate_bypass");
      expect(r.out, line).not.toContain("listening");
      expect(r.out, line).not.toContain(SECRET);
    }
  });
});

// backlog.fix.remote-rag-query-inline-full-index-build: the exported boot-index step, driven with injected
// dependencies only (no embed, no model, no index write).
describe("mcp-rks-http boot index", () => {
  const BOOT_ROOT = "/injected/boot-index-root";
  function recorder({ presence, embedImpl } = {}) {
    const lines = [];
    const ensure = vi.fn(async () => presence);
    const embed = vi.fn(embedImpl ?? (async () => ({ ok: true, indexed: 3 })));
    return { lines, ensure, embed, log: (line) => lines.push(line) };
  }

  it("present index: the embed dependency is not called", async () => {
    for (const presence of [{ ok: true, seeded: false }, { ok: false, reason: "no-notes" }]) {
      const r = recorder({ presence });
      const out = await runBootIndex({ root: BOOT_ROOT, ensure: r.ensure, embed: r.embed, log: r.log });
      expect(out, JSON.stringify(presence)).toEqual({ ok: true, built: false });
      expect(r.ensure.mock.calls).toEqual([[BOOT_ROOT, { autoEmbed: false }]]);
      expect(r.embed).not.toHaveBeenCalled();
      expect(r.lines.some((l) => l.includes(BOOT_INDEX_START))).toBe(false);
    }
  });

  it("absent index: the embed dependency is called once with the root and start and completion are logged", async () => {
    const r = recorder({ presence: { ok: false, reason: "no-index" } });
    const out = await runBootIndex({ root: BOOT_ROOT, ensure: r.ensure, embed: r.embed, log: r.log });
    expect(out).toEqual({ ok: true, built: true });
    expect(r.ensure).toHaveBeenCalledTimes(1);
    expect(r.ensure).toHaveBeenCalledWith(BOOT_ROOT, { autoEmbed: false });
    expect(r.embed).toHaveBeenCalledTimes(1);
    expect(r.embed.mock.calls[0][0]).toBe(BOOT_ROOT);
    const startAt = r.lines.findIndex((l) => l.includes(BOOT_INDEX_START));
    const endAt = r.lines.findIndex((l) => l.includes(BOOT_INDEX_END));
    expect(startAt, r.lines.join("\n")).toBeGreaterThan(-1);
    expect(endAt, r.lines.join("\n")).toBeGreaterThan(startAt);
    expect(r.lines).toHaveLength(2);
  });

  it("a rejecting embed resolves ok false with the cause and logs it", async () => {
    const cause = "boot-index embed exploded: lance write failed";
    const r = recorder({ presence: { ok: false, reason: "no-index" }, embedImpl: async () => { throw new Error(cause); } });
    const pending = runBootIndex({ root: BOOT_ROOT, ensure: r.ensure, embed: r.embed, log: r.log });
    await expect(pending).resolves.toEqual({ ok: false, error: cause });
    expect(r.embed).toHaveBeenCalledTimes(1);
    expect(r.lines.some((l) => l.includes(cause))).toBe(true);
    expect(r.lines.some((l) => l.includes(BOOT_INDEX_END))).toBe(false);

    // runRagEmbed reports most failures as a resolved { ok: false, error } rather than a rejection.
    const reported = recorder({ presence: { ok: false, reason: "no-index" }, embedImpl: async () => ({ ok: false, error: "embed reported failure" }) });
    const out = await runBootIndex({ root: BOOT_ROOT, ensure: reported.ensure, embed: reported.embed, log: reported.log });
    expect(out).toEqual({ ok: false, error: "embed reported failure" });
    expect(reported.lines.some((l) => l.includes("embed reported failure"))).toBe(true);
  });

  it("the bin header comment states the boot index failure posture and the RKS_REMOTE_BOOT_INDEX knob", () => {
    const src = fs.readFileSync(BIN, "utf8");
    const header = src.slice(0, src.search(/^import /m));
    expect(header.length).toBeGreaterThan(0);
    const commentLines = header.split("\n").filter((l) => l.startsWith("//"));
    const comment = commentLines.join("\n");
    expect(comment).toContain("REFUSE BOOT");
    expect(comment).toContain("boot_index_failed");
    expect(comment).toContain("RKS_REMOTE_BOOT_INDEX=skip");
    expect(comment).toMatch(/^\/\/\s+RKS_REMOTE_BOOT_INDEX\s/m);
    expect(comment).toContain("rag_index_unavailable");
  });
});

describe("package.json bin", () => {
  it("maps mcp-rks-http and keeps mcp-rks", () => {
    const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
    expect(pkg.bin["mcp-rks-http"]).toBe("bin/mcp-rks-http.mjs");
    expect(pkg.bin["mcp-rks"]).toBe("bin/mcp-rks.mjs");
    expect(fs.existsSync(path.join(path.dirname(PKG), pkg.bin["mcp-rks-http"]))).toBe(true);
  });
});
