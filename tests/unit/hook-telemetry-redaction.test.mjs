/**
 * backlog.feat.hook-telemetry-redaction
 *
 * Every hook telemetry write path must serialise redactValueSecretsOnly(record), the same
 * secrets-only gate TelemetryStorage applies before a line touches disk. Proven per writer,
 * on the BYTES on disk:
 *   hook-output.mjs          appendTelemetry, emitGuardrailBump (incl. the context: agentParams
 *                            path reached through buildRedirectOutput), emitAgentLaunch,
 *                            emitOutageFallthrough
 *   track-write-telemetry    guardrails.log AND events-<date>.jsonl
 *   enforce-rag-for-search   guardrails.log
 *   enforce-read-provenance  provenance-blocks.log
 *
 * SYNTHETIC SECRETS ONLY. Every secret below is fake and assembled at runtime by string
 * concatenation, so no token-shaped literal is committed. Never paste a real credential here.
 *
 * Every negative (raw secret absent) is paired with a positive control (the sink was written and
 * a non-secret marker from the same record is present), so an empty sink cannot pass vacuously.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const HOOKS = path.join(REPO, "packages", "hooks");
const SPAWN_TIMEOUT = 15_000;

// Synthetic, runtime-assembled. Each matches exactly one redaction class in lib/redact.mjs.
const SECRET = {
  bearer: "SYNTHbearer" + "0123456789ab", // BEARER (after "Bearer ")
  apiKeyValue: "synthetic-apikey-" + "value-0001", // NAME_VALUE_SECRET (after "API_KEY=")
  ghp: "ghp" + "_" + "SYNTHETIC" + "0".repeat(27), // GH_TOKEN
  skAnt: "sk" + "-ant-" + "SYNTHETIC" + "test0001", // ANTHROPIC_KEY
  tokenValue: "synthetic-" + "token-value-0001", // value under a secret-NAMED key
};
const RAW_SECRETS = Object.values(SECRET);

const tmpProject = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const eventsFile = (dir) =>
  path.join(dir, ".rks", "telemetry", `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
const guardrailsLog = (dir) => path.join(dir, ".routekit", "telemetry", "guardrails.log");
const provenanceLog = (dir) => path.join(dir, ".routekit", "telemetry", "provenance-blocks.log");
const bytesOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const linesOf = (file) => bytesOf(file).split("\n").filter(Boolean).map((l) => JSON.parse(l));

function expectNoRawSecret(bytes) {
  expect(bytes.length).toBeGreaterThan(0); // positive control: the sink WAS written
  for (const s of RAW_SECRETS) expect(bytes).not.toContain(s);
}

function writeScope(dir, scope) {
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".rks", "active-scope.json"), JSON.stringify(scope));
}

const ENV_KEYS = ["CLAUDE_PROJECT_DIR", "ROUTEKIT_PROJECT_ROOT"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  vi.doUnmock("../../packages/hooks/lib/redact.mjs");
  vi.resetModules();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Fresh hook-output module whose load-time PROJECT_DIR binds to `dir`, never the real repo. */
async function loadHookOutput(dir) {
  vi.resetModules();
  process.env.CLAUDE_PROJECT_DIR = dir;
  process.env.ROUTEKIT_PROJECT_ROOT = dir;
  return import("../../packages/hooks/system/hook-output.mjs");
}

/** Spawn a hook with a PreToolUse/PostToolUse envelope on stdin. Timeout is mandatory. */
function runHook(hookPath, dir, envelope) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(envelope),
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ROUTEKIT_PROJECT_ROOT: dir, RKS_GUARDRAILS: "on" },
  });
}

const offRail = fs.existsSync(path.join(REPO, ".routekit", "hooks.bak"));

describe("vendored redaction core", () => {
  const vendored = () => fs.readFileSync(path.join(HOOKS, "lib", "redact.mjs"), "utf8");

  it("packages/hooks/lib/redact.mjs is byte-identical to packages/telemetry/src/redact.mjs", () => {
    expect(vendored()).toBe(fs.readFileSync(path.join(REPO, "packages", "telemetry", "src", "redact.mjs"), "utf8"));
  });

  it("the vendored copy has no import statement and no dynamic import", () => {
    expect(vendored()).not.toMatch(/^\s*import\s/m);
    expect(vendored()).not.toMatch(/\bimport\s*\(/);
  });

  it("the child-project template seed carries a byte-identical copy", () => {
    const seed = path.join(REPO, "templates", "generic", ".routekit", "hooks", "lib", "redact.mjs");
    expect(fs.readFileSync(seed, "utf8")).toBe(vendored());
  });

  // sync-hooks refuses to regenerate .routekit/hooks while an off-rail session is active, so the
  // deployed copy is legitimately stale mid-session. CI runs guardrails-on and enforces both.
  it.skipIf(offRail)("the deployed .routekit/hooks/lib copy is byte-identical", () => {
    expect(fs.readFileSync(path.join(REPO, ".routekit", "hooks", "lib", "redact.mjs"), "utf8")).toBe(vendored());
  });

  it.skipIf(offRail)("node scripts/sync-hooks.mjs --check exits 0", () => {
    const res = spawnSync(process.execPath, [path.join(REPO, "scripts", "sync-hooks.mjs"), "--check"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(res.error).toBeUndefined();
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
  });

  it("every telemetry appendFileSync under packages/hooks goes through redactValueSecretsOnly", () => {
    // rag-embed-on-commit.mjs writes .rks/rag/post-commit.log (an embed log, not telemetry).
    const EXEMPT = new Set(["rag-embed-on-commit.mjs"]);
    const sites = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".mjs") && !EXEMPT.has(e.name)) {
          fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            if (line.includes("appendFileSync(")) sites.push({ at: `${path.relative(REPO, p)}:${i + 1}`, line });
          });
        }
      }
    };
    walk(HOOKS);
    expect(sites.length).toBeGreaterThanOrEqual(8); // positive control: the walk found the writers
    expect(sites.filter((s) => !s.line.includes("redactValueSecretsOnly(")).map((s) => s.at)).toEqual([]);
  });
});

describe("hook-output.mjs — every emitter redacts before appendFileSync", () => {
  it("emitGuardrailBump — context: agentParams has every secret class masked, non-secret context kept", async () => {
    const dir = tmpProject("htr-gb-");
    const { emitGuardrailBump } = await loadHookOutput(dir);
    emitGuardrailBump({
      projectDir: dir,
      projectId: "proj-1",
      reason: "Raw search tool blocked",
      redirectAgent: "mcp__rks__rks_agent_research",
      blockedTool: "Bash",
      agentParams: {
        projectId: "proj-1",
        command: `curl -H "Authorization: Bearer ${SECRET.bearer}" -e API_KEY=${SECRET.apiKeyValue} ${SECRET.ghp} ${SECRET.skAnt}`,
        token: SECRET.tokenValue,
      },
    });
    expectNoRawSecret(bytesOf(eventsFile(dir)));
    const ev = linesOf(eventsFile(dir)).find((e) => e.type === "hook.guardrail_bump");
    expect(ev.payload.reason).toBe("Raw search tool blocked");
    expect(ev.payload.blockedTool).toBe("Bash");
    expect(ev.payload.context.projectId).toBe("proj-1");
    expect(ev.payload.context.token).toBe("[REDACTED]");
    const cmd = ev.payload.context.command;
    expect(cmd.startsWith("curl -H")).toBe(true);
    expect(cmd).toContain("Bearer [REDACTED]");
    expect(cmd).toContain("API_KEY=[REDACTED]");
    expect(cmd).toContain("[REDACTED-GH-TOKEN]");
    expect(cmd).toContain("[REDACTED-ANTHROPIC-KEY]");
  });

  it("buildRedirectOutput → emitGuardrailBump — a Bash Bearer header is replaced and the rest of the command survives", async () => {
    const dir = tmpProject("htr-bro-");
    const { buildRedirectOutput } = await loadHookOutput(dir);
    const command = `curl -H "Authorization: Bearer ${SECRET.bearer}" https://example.invalid/api`;
    const out = buildRedirectOutput({ reason: "blocked", agent: "mcp__rks__rks_agent_research", agentParams: { command } });
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expectNoRawSecret(bytesOf(eventsFile(dir)));
    const ev = linesOf(eventsFile(dir)).find((e) => e.type === "hook.guardrail_bump");
    expect(ev.payload.context.command).toBe('curl -H "Authorization: Bearer [REDACTED]" https://example.invalid/api');
    expect(ev.payload.blockedTool).toBe("curl");
  });

  it("emitAgentLaunch — description secrets masked; payload.sessionId is [REDACTED] (TelemetryStorage parity)", async () => {
    const dir = tmpProject("htr-al-");
    writeScope(dir, { problemId: "backlog.fix.x", sessionId: "sess-9" });
    const { emitAgentLaunch } = await loadHookOutput(dir);
    emitAgentLaunch({
      projectDir: dir,
      subagentType: "Explore",
      allowReason: "resume",
      description: `probe Bearer ${SECRET.bearer} API_KEY=${SECRET.apiKeyValue} ${SECRET.ghp} ${SECRET.skAnt}`,
    });
    const bytes = bytesOf(eventsFile(dir));
    expectNoRawSecret(bytes);
    expect(bytes).not.toContain("sess-9");
    const ev = linesOf(eventsFile(dir)).find((e) => e.type === "hook.agent_launch");
    expect(ev.payload.subagentType).toBe("Explore");
    expect(ev.payload.allowReason).toBe("resume");
    expect(ev.payload.problemId).toBe("backlog.fix.x");
    expect(ev.payload.description.startsWith("probe ")).toBe(true);
    expect(ev.payload.sessionId).toBe("[REDACTED]");
  });

  it("emitOutageFallthrough — a secret-bearing path is masked; blockedTool/category/reason survive", async () => {
    const dir = tmpProject("htr-rof-");
    const { emitOutageFallthrough } = await loadHookOutput(dir);
    emitOutageFallthrough({
      projectDir: dir,
      blockedTool: "Read",
      category: "timeout",
      targetPath: `src/API_KEY=${SECRET.apiKeyValue} ${SECRET.ghp} Bearer ${SECRET.bearer} ${SECRET.skAnt}.txt`,
    });
    expectNoRawSecret(bytesOf(eventsFile(dir)));
    const ev = linesOf(eventsFile(dir))[0];
    expect(ev.payload.reason).toBe("research_agent_outage_fallthrough");
    expect(ev.payload.blockedTool).toBe("Read");
    expect(ev.payload.category).toBe("timeout");
    expect(ev.payload.path.startsWith("src/")).toBe(true);
  });

  it("appendTelemetry (.routekit/telemetry/guardrails.log) — string classes and a secret-named key masked", async () => {
    const dir = tmpProject("htr-at-");
    const { appendTelemetry } = await loadHookOutput(dir);
    appendTelemetry({
      ts: new Date().toISOString(),
      blocked: true,
      reason: "htr-marker",
      command: `grep foo Bearer ${SECRET.bearer} API_KEY=${SECRET.apiKeyValue} ${SECRET.ghp} ${SECRET.skAnt}`,
      token: SECRET.tokenValue,
    });
    expectNoRawSecret(bytesOf(guardrailsLog(dir)));
    const [entry] = linesOf(guardrailsLog(dir));
    expect(entry.reason).toBe("htr-marker");
    expect(entry.blocked).toBe(true);
    expect(entry.token).toBe("[REDACTED]");
    expect(entry.command.startsWith("grep foo ")).toBe(true);
  });

  it("non-secret content is written unchanged — v4 UUID, absolute path, plain command", async () => {
    const dir = tmpProject("htr-keep-");
    const { emitGuardrailBump } = await loadHookOutput(dir);
    const context = {
      projectId: "proj-1",
      command: "grep foo",
      correlationId: randomUUID(),
      file: "/Users/example/project/src/a.mjs",
    };
    emitGuardrailBump({ projectDir: dir, blockedTool: "Bash", agentParams: context });
    const ev = linesOf(eventsFile(dir))[0];
    expect(ev.payload.context).toEqual(context);
  });
});

describe("standalone hook writers (spawned) — every sink redacted", () => {
  it("track-write-telemetry — Write preview masked in guardrails.log AND events-<date>.jsonl", () => {
    const dir = tmpProject("htr-tw-");
    writeScope(dir, { problemId: "backlog.feat.x", sessionId: "sess-9", writeMode: "off-rail" });
    const res = runHook(path.join(HOOKS, "system", "track-write-telemetry.mjs"), dir, {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(dir, "src", "plain.txt"),
        content: `API_KEY=${SECRET.apiKeyValue} Bearer ${SECRET.bearer} ${SECRET.ghp}\nsecond line`,
      },
    });
    expect(res.status).toBe(0);
    for (const sink of [guardrailsLog(dir), eventsFile(dir)]) {
      const bytes = bytesOf(sink);
      expectNoRawSecret(bytes);
      expect(bytes).not.toContain("sess-9");
      const ev = linesOf(sink).find((e) => e.event === "dispatcher.direct_write");
      expect(ev.tool).toBe("Write");
      expect(ev.file).toBe("src/plain.txt");
      expect(ev.payload.problemId).toBe("backlog.feat.x");
      expect(ev.payload.sessionId).toBe("[REDACTED]");
      expect(ev.payload.change.preview).toContain("API_KEY=[REDACTED]");
      expect(ev.payload.change.preview).toContain("Bearer [REDACTED]");
      expect(ev.payload.change.preview).toContain("[REDACTED-GH-TOKEN]");
    }
  });

  it("track-write-telemetry — Edit new_string with an Anthropic-shaped key masked in both sinks", () => {
    const dir = tmpProject("htr-twe-");
    const res = runHook(path.join(HOOKS, "system", "track-write-telemetry.mjs"), dir, {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(dir, "src", "plain.txt"),
        old_string: "const k = 1;",
        new_string: `const k = "${SECRET.skAnt}";`,
      },
    });
    expect(res.status).toBe(0);
    for (const sink of [guardrailsLog(dir), eventsFile(dir)]) {
      expectNoRawSecret(bytesOf(sink));
      const ev = linesOf(sink).find((e) => e.event === "dispatcher.direct_write");
      expect(ev.payload.change.old).toBe("const k = 1;");
      expect(ev.payload.change.new).toContain("[REDACTED-ANTHROPIC-KEY]");
    }
  });

  it("enforce-rag-for-search — still blocks (exit 2); guardrails.log entry masked", () => {
    const dir = tmpProject("htr-rag-");
    const res = runHook(path.join(HOOKS, "read", "enforce-rag-for-search.mjs"), dir, {
      tool_name: "Bash",
      tool_input: {
        command: `grep foo -H "Authorization: Bearer ${SECRET.bearer}" API_KEY=${SECRET.apiKeyValue} ${SECRET.ghp} ${SECRET.skAnt}`,
      },
    });
    expect(res.status).toBe(2);
    expectNoRawSecret(bytesOf(guardrailsLog(dir)));
    const [entry] = linesOf(guardrailsLog(dir));
    expect(entry.blocked).toBe(true);
    expect(entry.reason).toBe("grep-find-rg-detected");
    expect(entry.command.startsWith("grep foo")).toBe(true);
  });

  // bashCommand is sliced to 60 chars by the hook, so each fixture fits inside the slice and the
  // raw secret WOULD reach disk without redaction.
  it.each([
    ["Bearer header", `cat x.txt Authorization: Bearer ${SECRET.bearer}`],
    ["env-style assignment", `cat API_KEY=${SECRET.apiKeyValue}`],
    ["GitHub token shape", `cat ${SECRET.ghp}`],
    ["Anthropic key shape", `cat ${SECRET.skAnt}`],
  ])("enforce-read-provenance — %s in a Bash read is masked in provenance-blocks.log", (_label, command) => {
    const dir = tmpProject("htr-prov-");
    const res = runHook(path.join(HOOKS, "read", "enforce-read-provenance.mjs"), dir, {
      tool_name: "Bash",
      tool_input: { command },
      session_id: "htr-session",
    });
    expect(res.error).toBeUndefined();
    expect(res.stderr).not.toContain("Hook error");
    expectNoRawSecret(bytesOf(provenanceLog(dir)));
    const [entry] = linesOf(provenanceLog(dir));
    expect(entry.tool).toBe("Bash(read)");
    expect(entry.originalTool).toBe("Bash");
    expect(entry.bashCommand.startsWith("cat ")).toBe(true);
  });
});

describe("FAIL-OPEN — a redaction throw never breaks the hook and never writes the unredacted record", () => {
  it("hook-output emitters (in-process, redact mocked to throw): no throw, deny intact, zero lines", async () => {
    const dir = tmpProject("htr-fo-");
    vi.resetModules();
    vi.doMock("../../packages/hooks/lib/redact.mjs", () => ({
      redactValueSecretsOnly: () => {
        throw new Error("injected redaction failure");
      },
    }));
    process.env.CLAUDE_PROJECT_DIR = dir;
    process.env.ROUTEKIT_PROJECT_ROOT = dir;
    const ho = await import("../../packages/hooks/system/hook-output.mjs");

    const command = `curl -H "Authorization: Bearer ${SECRET.bearer}"`;
    expect(() => ho.appendTelemetry({ reason: "x", command })).not.toThrow();
    expect(() => ho.emitGuardrailBump({ projectDir: dir, agentParams: { command } })).not.toThrow();
    expect(() => ho.emitAgentLaunch({ projectDir: dir, allowReason: "resume", description: command })).not.toThrow();
    expect(() => ho.emitOutageFallthrough({ projectDir: dir, blockedTool: "Read", targetPath: command })).not.toThrow();
    const out = ho.buildRedirectOutput({ reason: "blocked", agent: "mcp__rks__rks_agent_git", agentParams: { command } });
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.additionalContext).toContain("REDIRECT ORDER:");

    // Write nothing on error — neither the unredacted record nor anything else.
    expect(bytesOf(eventsFile(dir))).toBe("");
    expect(bytesOf(guardrailsLog(dir))).toBe("");
  });

  describe("standalone hooks (spawned from a copied tree whose lib/redact.mjs throws)", () => {
    let stubHooks;
    beforeAll(() => {
      stubHooks = path.join(tmpProject("htr-stubtree-"), "hooks");
      fs.cpSync(HOOKS, stubHooks, { recursive: true });
      fs.writeFileSync(
        path.join(stubHooks, "lib", "redact.mjs"),
        'export function redactValueSecretsOnly() { throw new Error("injected redaction failure"); }\n',
      );
    });

    const CASES = [
      [
        "track-write-telemetry",
        "system/track-write-telemetry.mjs",
        (dir) => ({ tool_name: "Write", tool_input: { file_path: path.join(dir, "a.txt"), content: `API_KEY=${SECRET.apiKeyValue}` } }),
        [guardrailsLog, eventsFile],
      ],
      [
        "enforce-rag-for-search",
        "read/enforce-rag-for-search.mjs",
        () => ({ tool_name: "Bash", tool_input: { command: `grep foo Bearer ${SECRET.bearer}` } }),
        [guardrailsLog],
      ],
      [
        "enforce-read-provenance",
        "read/enforce-read-provenance.mjs",
        () => ({ tool_name: "Bash", tool_input: { command: `cat ${SECRET.ghp}` }, session_id: "htr-session" }),
        [provenanceLog],
      ],
    ];

    it.each(CASES)("%s — same exit status as canonical, no Hook error, no telemetry line", (_name, rel, envelopeFor, sinks) => {
      const canonDir = tmpProject("htr-fo-canon-");
      const stubDir = tmpProject("htr-fo-stub-");
      const canon = runHook(path.join(HOOKS, rel), canonDir, envelopeFor(canonDir));
      const stub = runHook(path.join(stubHooks, rel), stubDir, envelopeFor(stubDir));

      expect(canon.error).toBeUndefined();
      expect(stub.error).toBeUndefined();
      expect(stub.status).toBe(canon.status); // primary behaviour unchanged
      expect(stub.stderr).not.toContain("Hook error"); // the throw was swallowed at the write site
      for (const sink of sinks) expect(bytesOf(sink(stubDir))).toBe("");
    });
  });
});
