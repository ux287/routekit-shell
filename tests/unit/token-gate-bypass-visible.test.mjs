/**
 * backlog.feat.token-gate-bypass-visible: unit witness for the token-gate bypass report.
 * The spawn cases follow tests/unit/mcp-boot-dotenv-bypass-vars.test.mjs: a temp project root with
 * an empty .routekit/hooks/, a temp HOME, scrubbed bypass/credential env and an explicit spawnSync
 * timeout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
  tokenGateBypass,
  tokenGateAuditFields,
  reportTokenGateBypass,
  TOKEN_GATE_BYPASS_EVENT,
} from "../../packages/mcp-rks/src/shared/token-gate-bypass.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bin = path.join(repoRoot, "packages", "mcp-rks", "bin", "mcp-rks.mjs");
const serverSrc = () => fs.readFileSync(path.join(repoRoot, "packages", "mcp-rks", "src", "server.mjs"), "utf8");
const BYPASS = ["RKS_SKIP_PREFLIGHT", "RKS_TEST_MODE", "NODE_ENV"];
const SCRUBBED = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ROUTEKIT_LLM_PROVIDER", "RKS_PROJECT_ROOT", "ROUTEKIT_PROJECT_ID"];
const SPAWN_TIMEOUT_MS = 15_000;
const SECRET = "sk-ant-token-gate-sentinel-not-a-real-key";

// Every combination of the three bypass variables, set or unset.
const COMBOS = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) => ({
  ...(bits & 1 ? { RKS_SKIP_PREFLIGHT: "1" } : {}),
  ...(bits & 2 ? { NODE_ENV: "test" } : {}),
  ...(bits & 4 ? { RKS_TEST_MODE: "1" } : {}),
}));

// The pre-story inline _skipTokenValidation expression from server.mjs, pasted, never imported.
const legacySkip = (env) => env.RKS_SKIP_PREFLIGHT === "1" || env.NODE_ENV === "test" || env.RKS_TEST_MODE === "1";

describe("tokenGateBypass (AC1)", () => {
  it("returns inactive with no vars for an empty env", () => {
    expect(tokenGateBypass({})).toEqual({ active: false, vars: [] });
  });

  it("names each set bypass value in declaration order", () => {
    expect(tokenGateBypass({ NODE_ENV: "test", RKS_TEST_MODE: "1" })).toEqual({ active: true, vars: ["NODE_ENV=test", "RKS_TEST_MODE=1"] });
    expect(tokenGateBypass({ RKS_TEST_MODE: "1", NODE_ENV: "test", RKS_SKIP_PREFLIGHT: "1" }).vars).toEqual(["RKS_SKIP_PREFLIGHT=1", "NODE_ENV=test", "RKS_TEST_MODE=1"]);
  });

  it("ignores values other than the exact bypass values", () => {
    expect(tokenGateBypass({ RKS_SKIP_PREFLIGHT: "0", NODE_ENV: "production", RKS_TEST_MODE: "true" })).toEqual({ active: false, vars: [] });
  });
});

describe("gate decision unchanged (AC2)", () => {
  it("active equals the pre-story _skipTokenValidation expression for all eight combinations", () => {
    for (const env of COMBOS) expect(tokenGateBypass(env).active, JSON.stringify(env)).toBe(legacySkip(env));
  });

  it("server.mjs derives _skipTokenValidation from tokenGateBypass and keeps the protected-tool gate line", () => {
    const src = serverSrc();
    expect(src).toMatch(/const _skipTokenValidation = tokenGateBypass\([^)]*\)\.active/);
    expect(src).toContain("if (!_skipTokenValidation && isProtectedTool(tool)) {");
  });
});

describe("boot report (AC3, AC6)", () => {
  it("emits exactly one governance.token_gate_bypass event and one stderr line when a bypass variable is set", () => {
    const emit = vi.fn();
    const write = vi.fn();
    reportTokenGateBypass({ env: { NODE_ENV: "test", RKS_TEST_MODE: "1" }, emit, write });
    expect(TOKEN_GATE_BYPASS_EVENT).toBe("governance.token_gate_bypass");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]).toEqual(["governance.token_gate_bypass", { vars: ["NODE_ENV=test", "RKS_TEST_MODE=1"] }]);
    expect(write).toHaveBeenCalledTimes(1);
    const line = write.mock.calls[0][0];
    expect(line).toContain("token gate disabled");
    expect(line).toContain("NODE_ENV");
    expect(line).toContain("RKS_TEST_MODE");
    expect(line.trimEnd().split("\n")).toHaveLength(1);
  });

  it("produces neither event nor stderr line when no bypass variable is set", () => {
    const emit = vi.fn();
    const write = vi.fn();
    reportTokenGateBypass({ env: { NODE_ENV: "production" }, emit, write });
    expect(emit).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("never carries other environment content or a secret value", () => {
    const emit = vi.fn();
    const write = vi.fn();
    const env = { RKS_SKIP_PREFLIGHT: "1", ANTHROPIC_API_KEY: SECRET, HOME: "/tmp/token-gate-home-sentinel" };
    reportTokenGateBypass({ env, emit, write });
    const out = JSON.stringify(emit.mock.calls) + write.mock.calls.map((c) => c[0]).join("") + JSON.stringify(tokenGateAuditFields(env));
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("ANTHROPIC_API_KEY");
    expect(out).not.toContain("token-gate-home-sentinel");
    expect(Object.keys(emit.mock.calls[0][1])).toEqual(["vars"]);
  });

  it("startServer wires the boot report", () => {
    const src = serverSrc();
    expect(src).toContain("reportTokenGateBypass(");
    // backlog.feat.remote-http-entry-multi-session: the call sits inside bootServer's body (the boot
    // path), and startServer runs bootServer() before connectServer(), whose body holds the only
    // transport connect.
    const boot = src.indexOf("export function bootServer() {");
    expect(boot, "bootServer declaration").toBeGreaterThan(-1);
    const connectDecl = src.indexOf("export async function connectServer(transport) {");
    expect(connectDecl, "connectServer declaration").toBeGreaterThan(boot);
    const bootBody = src.slice(boot, connectDecl);
    expect(bootBody.indexOf("reportTokenGateBypass("), "reportTokenGateBypass( inside bootServer").toBeGreaterThan(-1);
    expect(bootBody, "no transport connect inside bootServer").not.toContain("server.connect(");

    const start = src.indexOf("export async function startServer(transport) {");
    expect(start, "startServer declaration").toBeGreaterThan(-1);
    const startBody = src.slice(start, src.indexOf("\n}\n", start));
    const bootCall = startBody.indexOf("bootServer();");
    const connectCall = startBody.indexOf("connectServer(");
    expect(bootCall, "bootServer() inside startServer").toBeGreaterThan(-1);
    expect(connectCall, "connectServer( inside startServer").toBeGreaterThan(-1);
    expect(bootCall, "boot path precedes transport connect").toBeLessThan(connectCall);
    expect(startBody, "startServer connects only through connectServer").not.toContain("server.connect(");

    const connectBody = src.slice(connectDecl, src.indexOf("\n}\n", connectDecl));
    expect(connectBody).toContain("await server.connect(");
  });
});

describe("audit fields (AC4)", () => {
  it("carries tokenGate and tokenGateBypassVars while bypassed", () => {
    expect(tokenGateAuditFields({ RKS_SKIP_PREFLIGHT: "1" })).toEqual({ tokenGate: "bypassed", tokenGateBypassVars: ["RKS_SKIP_PREFLIGHT=1"] });
  });

  it("adds no key when the gate is enforced", () => {
    expect(tokenGateAuditFields({})).toEqual({});
    expect(Object.keys(tokenGateAuditFields({ NODE_ENV: "production" }))).toEqual([]);
  });

  it("server.mjs spreads the audit fields onto the mcp.tool audit event", () => {
    const src = serverSrc();
    expect(src).toContain("tokenGateAuditFields(");
    // The spread sits inside the payload of the one emit that names mcp.tool.complete / mcp.tool.failed.
    const anchor = src.indexOf('_auditOk ? "mcp.tool.complete" : "mcp.tool.failed"');
    expect(anchor, "mcp.tool audit emit anchor").toBeGreaterThan(-1);
    const payloadEnd = src.indexOf("\n      );", anchor);
    expect(payloadEnd, "end of the mcp.tool audit emit call").toBeGreaterThan(anchor);
    expect(src.slice(anchor, payloadEnd)).toMatch(/\.\.\.tokenGateAuditFields\(/);
  });
});

describe("boot stderr from the real bin (AC3)", () => {
  let tmp;
  let home;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "token-gate-bypass-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "token-gate-bypass-home-"));
    fs.mkdirSync(path.join(tmp, ".routekit", "hooks"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  function bootGateLines(extraEnv = {}) {
    const env = { ...process.env };
    for (const k of [...BYPASS, ...SCRUBBED]) delete env[k];
    Object.assign(env, { ROUTEKIT_PROJECT_ROOT: tmp, CLAUDE_PROJECT_DIR: tmp, HOME: home, ROUTEKIT_RAG_EMBEDDINGS_MODE: "stub", ...extraEnv });
    const res = spawnSync(process.execPath, [bin], { env, cwd: tmp, encoding: "utf8", input: "", timeout: SPAWN_TIMEOUT_MS });
    return (res.stderr || "").split("\n").filter((l) => l.includes("token gate disabled"));
  }

  it("writes exactly one token-gate line naming the variable when RKS_TEST_MODE=1 is in the process env", () => {
    const lines = bootGateLines({ RKS_TEST_MODE: "1" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("RKS_TEST_MODE");
    expect(lines[0].startsWith("[preflight] removed ")).toBe(false);
  });

  it("writes no token-gate line when no bypass variable is set", () => {
    expect(bootGateLines()).toEqual([]);
  });
});
