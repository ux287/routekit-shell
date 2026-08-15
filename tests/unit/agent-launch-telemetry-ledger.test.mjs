/**
 * backlog.fix.agent-launch-telemetry-ledger
 *
 * `redirect-task-explore-to-agent.mjs` wrote telemetry ONLY on its deny path, so the only agent
 * launches rks recorded were the ones it REFUSED. A permitted launch left no trace anywhere — which
 * meant delegated work could not be reconciled after the fact: an agent that died silently looked
 * exactly like one still running, and there was nothing to query.
 *
 * The load-bearing property here is READ-BACK by the real reader, not "a write was attempted". A
 * test that only greps the JSONL with fs proves the file exists; it does not prove the ledger is
 * usable. Hence `loadEvents` from `@routekit/telemetry/reports`.
 *
 * The second non-negotiable is FAIL-OPEN. A ledger that can block an agent launch is strictly worse
 * than no ledger, so the emitter is proven harmless against an unwritable sink both end-to-end and
 * at unit level.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs tests/unit/agent-launch-telemetry-ledger.test.mjs
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHookByName } from "../helpers/hook-path.mjs";
import { emitAgentLaunch } from "../../packages/hooks/system/hook-output.mjs";
import { loadEvents, generateReport } from "@routekit/telemetry/reports";

// Behavior cases spawn the CANONICAL copy deliberately. During an off-rail session the deployed
// tree is moved to `.routekit/hooks.bak/` and `sync-hooks` refuses to regenerate it mid-session, so
// the deployed copy is legitimately stale and would exercise pre-change code. Under guardrails-on
// (CI) canonical and deployed are byte-identical, enforced by the SYNC PARITY block below and by
// `node scripts/sync-hooks.mjs --check`. resolveHookByName is still used for the parity assertion.
const HOOK = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../packages/hooks/read/redirect-task-explore-to-agent.mjs",
);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const SPAWN_TIMEOUT = 15000;

/** Fresh CLAUDE_PROJECT_DIR per case, so per-branch event counts are exact, not cumulative. */
function tmpProject(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sinkFile(dir) {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(dir, ".rks", "telemetry", `events-${date}.jsonl`);
}

function readSink(dir) {
  const file = sinkFile(dir);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const launches = (dir) => readSink(dir).filter((e) => e.type === "hook.agent_launch");

/**
 * Spawn the hook with a hook envelope on stdin.
 * RKS_GUARDRAILS is set explicitly on every call — this suite may itself run inside an off-rail
 * session, where an inherited RKS_GUARDRAILS=off would silently reroute every case to one branch.
 */
function runHook({ dir, toolName = "Task", toolInput = {}, guardrails = "on" }) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, RKS_GUARDRAILS: guardrails },
  });
}

const GOVERNOR_INPUT = {
  subagent_type: "general-purpose",
  description: "Governor run",
  prompt: "You are the Governor. Call the rks MCP tools in sequence.",
};

const PLAIN_TASK = { subagent_type: "Explore", description: "look around", prompt: "find the thing" };

describe("emitAgentLaunch — canonical event to the server sink", () => {
  it("is exported as a function", () => {
    expect(typeof emitAgentLaunch).toBe("function");
  });

  it("appends exactly ONE hook.agent_launch line to events-<date>.jsonl", () => {
    const dir = tmpProject("al-one-");
    emitAgentLaunch({ projectDir: dir, subagentType: "Explore", description: "d", allowReason: "resume" });
    const events = readSink(dir);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("hook.agent_launch");
  });

  it("uses the same top-level envelope as emitGuardrailBump, with no extra keys", () => {
    const dir = tmpProject("al-shape-");
    emitAgentLaunch({ projectDir: dir, projectId: "proj-1", subagentType: "Explore", allowReason: "resume" });
    const ev = readSink(dir)[0];

    expect(Object.keys(ev).sort()).toEqual(["id", "payload", "projectId", "timestamp", "type"]);
    expect(typeof ev.id).toBe("string");
    expect(typeof ev.timestamp).toBe("string");
    expect(new Date(ev.timestamp).toISOString()).toBe(ev.timestamp);
    expect(ev.projectId).toBe("proj-1");
    expect(typeof ev.payload).toBe("object");
  });

  it("reads problemId/sessionId from active-scope.json, and yields null (not undefined) without it", () => {
    const withScope = tmpProject("al-scope-");
    fs.mkdirSync(path.join(withScope, ".rks"), { recursive: true });
    fs.writeFileSync(
      path.join(withScope, ".rks", "active-scope.json"),
      JSON.stringify({ problemId: "backlog.fix.x", sessionId: "sess-9" }),
    );
    emitAgentLaunch({ projectDir: withScope, allowReason: "resume" });
    const scoped = readSink(withScope)[0];
    expect(scoped.payload.problemId).toBe("backlog.fix.x");
    expect(scoped.payload.sessionId).toBe("sess-9");

    const bare = tmpProject("al-noscope-");
    emitAgentLaunch({ projectDir: bare, allowReason: "resume" });
    const unscoped = readSink(bare)[0];
    expect(unscoped.payload.problemId).toBeNull();
    expect(unscoped.payload.sessionId).toBeNull();
    expect("problemId" in unscoped.payload).toBe(true); // null, never undefined
  });

  it("FAIL-OPEN (unit): an uncreatable sink does not throw", () => {
    const dir = tmpProject("al-broken-");
    // `.rks/telemetry` as a regular FILE → mkdirSync throws ENOTDIR. More reliable across CI users
    // than chmod, which root ignores.
    fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".rks", "telemetry"), "not a directory");

    expect(() => emitAgentLaunch({ projectDir: dir, allowReason: "resume" })).not.toThrow();
  });
});

describe("redirect-task-explore-to-agent — every ALLOW branch is recorded", () => {
  it("branch 1 (guardrails off): records allowReason 'guardrails_off' WITH subagentType/description", () => {
    const dir = tmpProject("al-off-");
    const res = runHook({ dir, toolInput: PLAIN_TASK, guardrails: "off" });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");

    const evs = launches(dir);
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.allowReason).toBe("guardrails_off");
    // The guardrails-off exit used to precede the tool_input read; a null here means the hoist
    // was not applied and the record is useless.
    expect(evs[0].payload.subagentType).toBe("Explore");
    expect(evs[0].payload.description).toBe("look around");
    expect(evs[0].payload.hookName).toBe("redirect-task-explore-to-agent");
  });

  it("branch 2 (resume): records allowReason 'resume'", () => {
    const dir = tmpProject("al-resume-");
    const res = runHook({ dir, toolInput: { ...PLAIN_TASK, resume: "agent-123" } });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");

    const evs = launches(dir);
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.allowReason).toBe("resume");
  });

  it("branch 3 (governor launch): records allowReason 'governor_launch'", () => {
    const dir = tmpProject("al-gov-");
    const res = runHook({ dir, toolInput: GOVERNOR_INPUT });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");

    const evs = launches(dir);
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.allowReason).toBe("governor_launch");
    expect(evs[0].payload.subagentType).toBe("general-purpose");
  });

  it("allowReason is drawn from a closed set across all three branches", () => {
    const seen = [
      { dir: tmpProject("al-e1-"), input: PLAIN_TASK, guardrails: "off" },
      { dir: tmpProject("al-e2-"), input: { ...PLAIN_TASK, resume: "x" }, guardrails: "on" },
      { dir: tmpProject("al-e3-"), input: GOVERNOR_INPUT, guardrails: "on" },
    ].map(({ dir, input, guardrails }) => {
      runHook({ dir, toolInput: input, guardrails });
      return launches(dir)[0].payload.allowReason;
    });

    expect(seen).toEqual(["guardrails_off", "resume", "governor_launch"]);
  });

  it("never writes a full prompt body into the ledger", () => {
    const dir = tmpProject("al-big-");
    const huge = "SECRETPROMPTBODY".repeat(400); // ~6400 chars
    runHook({ dir, toolInput: { subagent_type: "Explore", prompt: huge }, guardrails: "off" });

    const ev = launches(dir)[0];
    expect(ev.payload.description.length).toBeLessThanOrEqual(200);
    // Asserted over the WHOLE file, not just the description field — the body must not reappear
    // anywhere in the record.
    expect(fs.readFileSync(sinkFile(dir), "utf8")).not.toContain(huge);
  });
});

describe("LOAD-BEARING: the record is retrievable by the real reader", () => {
  it("loadEvents() returns the emitted hook.agent_launch event", async () => {
    const dir = tmpProject("al-readback-");
    runHook({ dir, toolInput: GOVERNOR_INPUT });

    // The real reader — not fs. A file that exists but is unreadable by the reader is not a ledger.
    const events = await loadEvents(dir);
    const found = events.filter((e) => e.type === "hook.agent_launch");
    expect(found).toHaveLength(1);
    expect(found[0].payload.allowReason).toBe("governor_launch");
  });

  it("the loadEvents export is additive — generateReport is still exported", () => {
    expect(typeof loadEvents).toBe("function");
    expect(typeof generateReport).toBe("function");
  });
});

describe("NEGATIVE CONTROLS", () => {
  it("a non-Task tool call records nothing", () => {
    const dir = tmpProject("al-nontask-");
    const res = runHook({ dir, toolName: "Bash", toolInput: { command: "ls" } });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
    expect(launches(dir)).toHaveLength(0);
  });

  it("the deny path still denies, with its redirect output unchanged", () => {
    const dir = tmpProject("al-deny-");
    const res = runHook({ dir, toolInput: PLAIN_TASK });

    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.additionalContext).toContain("REDIRECT ORDER:");
    expect(out.hookSpecificOutput.additionalContext).toContain("GOVERNOR ROUTING:");
  });

  it("the deny path still writes its existing guardrails.log entry", () => {
    const dir = tmpProject("al-denylog-");
    runHook({ dir, toolInput: PLAIN_TASK });

    const log = path.join(dir, ".routekit", "telemetry", "guardrails.log");
    expect(fs.existsSync(log)).toBe(true);
    const entries = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(entries.some((e) => e.blocked === true)).toBe(true);
  });

  it("the deny path emits ZERO launch records — filtered by type, not by empty sink", () => {
    const dir = tmpProject("al-denyfilter-");
    runHook({ dir, toolInput: PLAIN_TASK });

    // The sink is NOT empty: buildRedirectOutput calls emitGuardrailBump on every deny, writing a
    // hook.guardrail_bump into this same file. Asserting emptiness here would be wrong and red.
    expect(readSink(dir).some((e) => e.type === "hook.guardrail_bump")).toBe(true);
    expect(launches(dir)).toHaveLength(0);
  });

  it("FAIL-OPEN (end-to-end): an uncreatable sink still permits the launch", () => {
    const dir = tmpProject("al-failopen-");
    fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".rks", "telemetry"), "not a directory");

    const res = runHook({ dir, toolInput: GOVERNOR_INPUT });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
    // No 'Hook error' proves the emitter SWALLOWED the failure, rather than throwing out of main()
    // and being caught by the top-level handler.
    expect(res.stderr).not.toContain("Hook error");
  });
});

describe("SYNC PARITY across the three hook copies", () => {
  const files = ["read/redirect-task-explore-to-agent.mjs", "system/hook-output.mjs"];
  const canonicalOf = (rel) => fs.readFileSync(path.join(REPO_ROOT, "packages/hooks", rel), "utf8");

  // `scripts/sync-hooks.mjs` REFUSES to regenerate `.routekit/hooks/` while an off-rail session is
  // active (`.routekit/hooks.bak` present), so it does not re-enable moved hook tiers mid-session.
  // The deployed copy is therefore legitimately stale until `rks_guardrails_on` completes and the
  // sync re-runs. Asserting deployed parity here would fail for a correct reason, so it is gated —
  // CI runs guardrails-on and enforces it, as does `node scripts/sync-hooks.mjs --check`.
  const offRail = fs.existsSync(path.join(REPO_ROOT, ".routekit", "hooks.bak"));

  it("canonical and the child-project template seed are byte-identical", () => {
    const mismatches = files.filter(
      (rel) => canonicalOf(rel) !== fs.readFileSync(path.join(REPO_ROOT, "templates/generic/.routekit/hooks", rel), "utf8"),
    );
    expect(mismatches).toEqual([]);
  });

  it.skipIf(offRail)("the DEPLOYED copy — the one that actually executes — matches canonical", () => {
    const mismatches = files.filter(
      (rel) => canonicalOf(rel) !== fs.readFileSync(resolveHookByName(path.basename(rel), REPO_ROOT), "utf8"),
    );
    expect(mismatches).toEqual([]);
  });
});

describe("documentation", () => {
  it("docs.telemetry-events.md catalogues hook.agent_launch and its payload fields", () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, "notes/docs.telemetry-events.md"), "utf8");
    const missing = ["hook.agent_launch", "subagentType", "description", "allowReason", "hookName"]
      .filter((token) => !doc.includes(token));
    expect(missing).toEqual([]);
  });
});
