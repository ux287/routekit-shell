/**
 * backlog.feat.hook-telemetry-uat-observability — primary oracle (AC1-AC7, AC11, AC12, AC16, TR31).
 * Direct-imports appendTelemetry from the CANONICAL tree (off-rail safe) and proves queryability
 * through the STRICT reader queryTelemetry only — never reports.mjs / loadEvents (the single
 * exception is the TR09 reader-divergence control, which exists to show the two readers disagree).
 * Hook paths are built explicitly under packages/hooks (never resolveHookPath); every spawn has a timeout.
 * Every negative assertion is paired with a positive one in the same it() (no vacuous passes).
 *
 * SYNTHETIC SECRETS ONLY: every secret below is fake and assembled at runtime by concatenation.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as hookOutput from "../../packages/hooks/system/hook-output.mjs";
import { appendTelemetry } from "../../packages/hooks/system/hook-output.mjs";
import { redactValueSecretsOnly } from "../../packages/hooks/lib/redact.mjs";
import yaml from "../../packages/hooks/lib/js-yaml.mjs";
import { queryTelemetry } from "../../packages/telemetry/src/query.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOKS = path.join(REPO, "packages", "hooks");
const SPAWN_TIMEOUT = 15_000;
const EVENTS_RE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;

const SECRET = {
  ghp: "ghp" + "_" + "SYNTHETIC" + "0".repeat(27),
  skAnt: "sk" + "-ant-" + "SYNTHETIC" + "test0001",
  bearer: "SYNTHbearer" + "0123456789ab",
  apiKeyValue: "synthetic-apikey-" + "value-0001",
  tokenValue: "synthetic-" + "token-value-0001",
};
const RAW_SECRETS = Object.values(SECRET);

const tmpRoot = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const eventsFile = (root) =>
  path.join(root, ".rks", "telemetry", `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
const guardrailsLog = (root) => path.join(root, ".routekit", "telemetry", "guardrails.log");
const records = (root) =>
  fs.existsSync(eventsFile(root))
    ? fs.readFileSync(eventsFile(root), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
const rawOf = (root) => (fs.existsSync(eventsFile(root)) ? fs.readFileSync(eventsFile(root), "utf8") : "");

const savedEnv = {
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  RKS_PROJECT_ID: process.env.RKS_PROJECT_ID,
};
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function emitInto(root, entry) {
  process.env.CLAUDE_PROJECT_DIR = root;
  appendTelemetry(entry);
}

function runHook(rel, root, envelope) {
  return spawnSync(process.execPath, [path.join(HOOKS, rel)], {
    cwd: root,
    input: JSON.stringify(envelope),
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      ROUTEKIT_PROJECT_ROOT: root,
      RKS_GUARDRAILS: "on",
    },
  });
}

function writeScope(root, scope) {
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".rks", "active-scope.json"), JSON.stringify(scope));
}

const AGENT_TOOL = "mcp__rks__rks_agent_research";

describe("AC1 — canonical sink, resolved per call", () => {
  it("writes events-<date>.jsonl and nothing to guardrails.log (paired)", () => {
    const root = tmpRoot("htc-sink-");
    emitInto(root, { event: "hook.provenance_heartbeat", phase: "entry" });
    // Positive half first: the canonical events file exists and holds the expected record.
    expect(fs.existsSync(eventsFile(root))).toBe(true);
    expect(path.basename(eventsFile(root))).toBe(`events-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const recs = records(root);
    expect(recs.length).toBeGreaterThanOrEqual(1);
    expect(recs[0].type).toBe("hook.provenance_heartbeat");
    // Absence half, only meaningful because the positive half above held.
    expect(fs.existsSync(guardrailsLog(root))).toBe(false);
  });

  it("re-resolves CLAUDE_PROJECT_DIR on every call (no module-load binding)", () => {
    const a = tmpRoot("htc-a-");
    const b = tmpRoot("htc-b-");
    emitInto(a, { type: "qa.root.a" });
    emitInto(b, { type: "qa.root.b" });
    expect(records(a).map((r) => r.type)).toEqual(["qa.root.a"]);
    expect(records(b).map((r) => r.type)).toEqual(["qa.root.b"]);
  });
});

describe("AC2 — canonical envelope", () => {
  it("every record has exactly the keys id, type, timestamp, projectId, payload", () => {
    const root = tmpRoot("htc-env-");
    emitInto(root, { event: "hook.provenance_heartbeat", stage: "entry" });
    emitInto(root, { type: "qa.envelope" });
    emitInto(root, { reason: "neither" });
    const recs = records(root);
    expect(recs).toHaveLength(3);
    for (const r of recs) {
      expect(Object.keys(r).sort()).toEqual(["id", "payload", "projectId", "timestamp", "type"]);
      expect(typeof r.id).toBe("string");
      expect(r.id.length).toBeGreaterThan(0);
      expect(typeof r.timestamp).toBe("string");
      expect(Number.isFinite(Date.parse(r.timestamp))).toBe(true);
      expect(typeof r.projectId).toBe("string");
      expect(r.projectId.length).toBeGreaterThan(0);
      expect(r.payload !== null && typeof r.payload === "object" && !Array.isArray(r.payload)).toBe(true);
    }
  });

  it("payload deep-equals the caller's non-secret object, event key copied not moved", () => {
    const root = tmpRoot("htc-payload-");
    const entry = { event: "x", path: "/p", command: "c", extra: { deep: 1 } };
    emitInto(root, entry);
    const [rec] = records(root);
    expect(rec.payload).toEqual(redactValueSecretsOnly(entry));
    expect(rec.payload).toEqual({ event: "x", path: "/p", command: "c", extra: { deep: 1 } });
    expect(rec.payload.event).toBe("x");
    expect(rec.type).toBe("x");
    expect(rec.payload.path).toBe("/p");
    expect(rec.payload.command).toBe("c");
  });
});

describe("AC3 — type precedence: entry.type ?? entry.event ?? hook.unclassified", () => {
  it("canonical type wins over legacy event", () => {
    const cases = [
      [{ event: "hook.provenance_heartbeat" }, "hook.provenance_heartbeat"],
      [{ type: "foo" }, "foo"],
      [{ event: "legacy", type: "canonical" }, "canonical"],
    ];
    for (const [entry, expected] of cases) {
      const root = tmpRoot("htc-type-");
      emitInto(root, entry);
      const recs = records(root);
      expect(recs).toHaveLength(1);
      expect(recs[0].type).toBe(expected);
    }
  });

  it("a caller with neither key yields hook.unclassified", () => {
    const root = tmpRoot("htc-uncl-");
    emitInto(root, { reason: "neither", blocked: true });
    const recs = records(root);
    expect(recs).toHaveLength(1);
    expect(recs[0].type).toBe("hook.unclassified");
    expect(recs[0].payload.reason).toBe("neither");
  });
});

describe("AC4 — queryable through the STRICT reader", () => {
  it("queryTelemetry retrieves hook.provenance_heartbeat, hook.payload_shape_unknown and dispatcher.direct_write by strict type", async () => {
    const root = tmpRoot("htc-q-");
    // Legacy event-keyed callers (track-agent-provenance / rag-embed-on-commit style).
    emitInto(root, { event: "hook.provenance_heartbeat", stage: "entry" });
    emitInto(root, { event: "hook.payload_shape_unknown", hook: "probe" });
    // dispatcher.direct_write from the CANONICAL hook itself.
    const res = runHook("system/track-write-telemetry.mjs", root, {
      tool_name: "Write",
      tool_input: { file_path: path.join(root, "src", "q.txt"), content: "hello" },
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);

    for (const type of ["hook.provenance_heartbeat", "hook.payload_shape_unknown", "dispatcher.direct_write"]) {
      const result = await queryTelemetry(root, { type });
      expect(result.total, type).toBeGreaterThanOrEqual(1);
      expect(result.events.length, type).toBeGreaterThanOrEqual(1);
      expect(result.events.every((ev) => ev.type === type), type).toBe(true);
    }
  });

  it("reader-divergence control, strict reader returns only the type-keyed record while reports.mjs counts both", async () => {
    const root = tmpRoot("htc-div-");
    fs.mkdirSync(path.dirname(eventsFile(root)), { recursive: true });
    const recordA = { id: "a", event: "qa.divergence.probe", timestamp: new Date().toISOString(), payload: { which: "A" } };
    const recordB = { id: "b", type: "qa.divergence.probe", timestamp: new Date().toISOString(), payload: { which: "B" } };
    fs.writeFileSync(eventsFile(root), JSON.stringify(recordA) + "\n" + JSON.stringify(recordB) + "\n");

    // (a) strict reader: only record B.
    const strict = await queryTelemetry(root, { type: "qa.divergence.probe" });
    expect(strict.total).toBe(1);
    expect(strict.events).toHaveLength(1);
    expect(strict.events[0].id).toBe("b");

    // (b) the forgiving reports.mjs path: loadEvents + the reports.mjs type coercion
    // String(ev.type || ev.event || ev.name || "") counts BOTH.
    const { loadEvents } = await import("../../packages/telemetry/src/reports.mjs");
    const loaded = await loadEvents(root);
    const forgiving = loaded.filter(
      (ev) => String(ev.type || ev.event || ev.name || "").toLowerCase() === "qa.divergence.probe",
    );
    expect(forgiving).toHaveLength(2);
  });
});

describe("AC5 — single shared helper", () => {
  it("exactly one function appendTelemetry under packages/hooks, former copy-holders import the shared helper", () => {
    const defs = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".mjs")) {
          const src = fs.readFileSync(p, "utf8");
          if (src.includes("function appendTelemetry")) defs.push(path.relative(HOOKS, p));
        }
      }
    };
    walk(HOOKS);
    expect(defs).toEqual([path.join("system", "hook-output.mjs")]);

    const rag = fs.readFileSync(path.join(HOOKS, "read", "enforce-rag-for-search.mjs"), "utf8");
    expect(rag).toMatch(/import\s*\{[^}]*\bappendTelemetry\b[^}]*\}\s*from\s*"\.\.\/system\/hook-output\.mjs"/);
    expect(rag).not.toContain("function appendTelemetry");

    const tw = fs.readFileSync(path.join(HOOKS, "system", "track-write-telemetry.mjs"), "utf8");
    expect(tw).toMatch(/import\s*\{[^}]*\bappendTelemetry\b[^}]*\}\s*from\s*"\.\/hook-output\.mjs"/);
    expect(tw).not.toContain("function appendTelemetry");
    expect(tw).not.toContain("function appendEvent");
    for (const c of ["TELEMETRY_DIR", "TELEMETRY_FILE", "EVENTS_DIR"]) expect(tw).not.toContain(c);
    expect(tw).toContain("PROJECT_DIR");
  });

  it("track-write-telemetry emits exactly one flat dispatcher.direct_write record", async () => {
    const root = tmpRoot("htc-tw-");
    writeScope(root, { problemId: "backlog.feat.x", sessionId: "sess-9", writeMode: "off-rail" });
    const res = runHook("system/track-write-telemetry.mjs", root, {
      tool_name: "Write",
      tool_input: { file_path: path.join(root, "src", "plain.txt"), content: "first line\nsecond" },
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);

    const result = await queryTelemetry(root, { type: "dispatcher.direct_write" });
    expect(result.total).toBe(1);
    const [rec] = result.events;
    expect(rec.payload.tool).toBe("Write");
    expect(rec.payload.file).toBe("src/plain.txt");
    expect(rec.payload.problemId).toBe("backlog.feat.x");
    expect(rec.payload.sessionId).toBe("[REDACTED]");
    expect(typeof rec.payload.change.preview).toBe("string");
    expect(rec.payload.change.preview).toBe("first line");
    expect(rec.payload.authority).toBe("backlog.feat.x");
    expect(rec.payload.payload).toBeUndefined();
    expect(fs.existsSync(guardrailsLog(root))).toBe(false);
  });
});

describe("AC6 — previously-invisible emitters are queryable", () => {
  it("track-agent-provenance heartbeat yields hook.provenance_heartbeat", async () => {
    const root = tmpRoot("htc-hb-");
    const res = runHook("system/track-agent-provenance.mjs", root, { tool_name: "Read" });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    const result = await queryTelemetry(root, { type: "hook.provenance_heartbeat" });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.events.every((ev) => ev.type === "hook.provenance_heartbeat")).toBe(true);
  });

  it("track-agent-provenance unknown payload shape yields hook.payload_shape_unknown", async () => {
    const root = tmpRoot("htc-tap-");
    const res = runHook("system/track-agent-provenance.mjs", root, {
      hook_event_name: "PostToolUse",
      tool_name: AGENT_TOOL,
      tool_input: { query: "x" },
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    const result = await queryTelemetry(root, { type: "hook.payload_shape_unknown" });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.events.some((ev) => ev.payload && ev.payload.hook === "track-agent-provenance")).toBe(true);
  });

  it("rag-embed-on-commit unknown payload shape yields hook.payload_shape_unknown", async () => {
    const root = tmpRoot("htc-rec-");
    const res = runHook("system/rag-embed-on-commit.mjs", root, {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git commit -m x" },
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    const result = await queryTelemetry(root, { type: "hook.payload_shape_unknown" });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.events.some((ev) => ev.payload && ev.payload.hook === "rag-embed-on-commit")).toBe(true);
  });

  it("enforce-rag-for-search yields hook.unclassified", async () => {
    const root = tmpRoot("htc-ers-");
    const res = runHook("read/enforce-rag-for-search.mjs", root, {
      tool_name: "Bash",
      tool_input: { command: "grep foo src" },
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(2);
    const result = await queryTelemetry(root, { type: "hook.unclassified" });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.events.some((ev) => ev.payload && ev.payload.reason === "grep-find-rg-detected")).toBe(true);
  });
});

describe("AC7 — hook-specific fields recovered inside payload", () => {
  it("redirect-read-to-agent path, enforce-rag-for-search command and redirect-task-explore-to-agent subagentType/query survive under payload", () => {
    // redirect-read-to-agent: no scope, no provenance, guardrails on → blocked with `path`.
    const readRoot = tmpRoot("htc-rr-");
    const rr = runHook("read/redirect-read-to-agent.mjs", readRoot, {
      tool_name: "Read",
      tool_input: { file_path: path.join(readRoot, "src", "a.mjs") },
    });
    expect(rr.error).toBeUndefined();
    expect(rr.status).toBe(0);
    expect(JSON.parse(rr.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const readRec = records(readRoot).find((r) => r.payload && r.payload.hook === "redirect-read-to-agent");
    expect(readRec).toBeDefined();
    expect(readRec.payload.path).toBe(path.join("src", "a.mjs"));
    expect(readRec.path).toBeUndefined();

    // enforce-rag-for-search: `command` retained.
    const ragRoot = tmpRoot("htc-rc-");
    const rc = runHook("read/enforce-rag-for-search.mjs", ragRoot, {
      tool_name: "Bash",
      tool_input: { command: "grep needle src/" },
    });
    expect(rc.status).toBe(2);
    const ragRec = records(ragRoot).find((r) => r.payload && r.payload.reason === "grep-find-rg-detected");
    expect(ragRec).toBeDefined();
    expect(ragRec.payload.command).toBe("grep needle src/");
    expect(ragRec.command).toBeUndefined();

    // redirect-task-explore-to-agent: `subagentType` and `query` retained.
    const taskRoot = tmpRoot("htc-rt-");
    const rt = runHook("read/redirect-task-explore-to-agent.mjs", taskRoot, {
      tool_name: "Task",
      tool_input: { subagent_type: "Explore", description: "look around", prompt: "find the thing" },
    });
    expect(rt.error).toBeUndefined();
    expect(rt.status).toBe(0);
    expect(JSON.parse(rt.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const taskRec = records(taskRoot).find((r) => r.payload && r.payload.hook === "redirect-task-to-governor");
    expect(taskRec).toBeDefined();
    expect(taskRec.payload.subagentType).toBe("Explore");
    expect(taskRec.payload.query).toBe("find the thing");
    expect(taskRec.subagentType).toBeUndefined();
  });
});

describe("AC11 — rotation by date bucket", () => {
  it("emitted basename matches the storage.mjs cleanup regex", () => {
    const root = tmpRoot("htc-rot-");
    emitInto(root, { type: "qa.rotation" });
    const files = fs.readdirSync(path.join(root, ".rks", "telemetry"));
    expect(files).toHaveLength(1);
    const m = files[0].match(EVENTS_RE);
    expect(m).not.toBeNull();
    expect(m[1]).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe("AC12 — read policy retires the orphan", () => {
  it("runtime_paths telemetry entries are exactly provenance-blocks.log and events-*.jsonl", () => {
    const src = fs.readFileSync(path.join(REPO, ".routekit", "read-policy.yaml"), "utf8");
    const rp = yaml.load(src).provenance_enforcement.runtime_paths;
    expect(Array.isArray(rp)).toBe(true);
    expect(rp.filter((p) => p.includes("telemetry"))).toEqual([
      ".routekit/telemetry/provenance-blocks.log",
      ".rks/telemetry/events-*.jsonl",
    ]);
    expect(rp.filter((p) => /guardrails\.log/.test(p))).toEqual([]);
    expect(
      rp.filter((p) => /^\.routekit\/telemetry\/\*|^\.rks\/telemetry\/\*|^\.routekit\/telemetry\/?$|^\.rks\/telemetry\/?$/.test(p)),
    ).toEqual([]);
    // Unchanged in length and content overall: the story's only edit is inside the # rationale block.
    expect(rp).toEqual([
      ".routekit/*.yaml",
      ".routekit/hooks/*",
      ".rks/prompts/*",
      ".rks/project.json",
      ".rks/rag/config.json",
      "package.json",
      "tsconfig.json",
      ".mcp.json",
      "CLAUDE.md",
      "README.md",
      "AGENTS.md",
      ".rks/*.yaml",
      ".rks/runs/*",
      ".rks/session/*",
      ".claude/*",
      ".routekit/telemetry/provenance-blocks.log",
      ".rks/telemetry/events-*.jsonl",
      "notes/backlog.*",
      "notes/research.*",
      "notes/how-to.*",
    ]);
    // The retirement is recorded in the rationale, on #-prefixed lines only.
    const mention = src.split("\n").filter((l) => l.includes("guardrails.log"));
    expect(mention.length).toBeGreaterThanOrEqual(1);
    expect(mention.every((l) => l.trimStart().startsWith("#"))).toBe(true);
  });
});

describe("AC16 — values pass through redactValueSecretsOnly", () => {
  it("enforce-rag-for-search: still blocks, record queryable, command kept, secret masked", async () => {
    const root = tmpRoot("htc-rag-");
    const res = runHook("read/enforce-rag-for-search.mjs", root, {
      tool_name: "Bash",
      tool_input: { command: `grep foo ${SECRET.ghp}` },
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(2);
    const result = await queryTelemetry(root, { type: "hook.unclassified" });
    const rec = result.events.find((ev) => ev.payload && ev.payload.reason === "grep-find-rg-detected");
    expect(rec).toBeDefined();
    expect(rec.payload.blocked).toBe(true);
    expect(rec.payload.command.startsWith("grep foo ")).toBe(true);
    expect(rec.payload.command).toContain("[REDACTED-GH-TOKEN]");
    expect(rawOf(root)).not.toContain(SECRET.ghp);

    const src = fs.readFileSync(path.join(HOOKS, "read", "enforce-rag-for-search.mjs"), "utf8");
    expect(src).toContain("const PROJECT_DIR");
    expect(src).toContain("command: command.slice(0, 200),");
    expect(src).not.toContain("TELEMETRY_DIR");
    expect(src).not.toContain("TELEMETRY_FILE");
  });

  it("no secret sentinel reaches the events file via appendTelemetry, enforce-rag-for-search or track-write-telemetry", () => {
    // 1. appendTelemetry, in-process.
    const direct = tmpRoot("htc-red-at-");
    emitInto(direct, {
      blocked: true,
      reason: "htc-marker",
      command: `grep foo Bearer ${SECRET.bearer} API_KEY=${SECRET.apiKeyValue} ${SECRET.ghp} ${SECRET.skAnt}`,
      token: SECRET.tokenValue,
    });
    const directRaw = rawOf(direct);
    expect(directRaw.length).toBeGreaterThan(0);
    for (const s of RAW_SECRETS) expect(directRaw).not.toContain(s);
    const atRec = records(direct).find((r) => r.payload.reason === "htc-marker");
    expect(atRec).toBeDefined();
    expect(atRec.payload.command.startsWith("grep foo ")).toBe(true);
    expect(atRec.payload.command).toContain("Bearer [REDACTED]");
    expect(atRec.payload.command).toContain("API_KEY=[REDACTED]");
    expect(atRec.payload.command).toContain("[REDACTED-GH-TOKEN]");
    expect(atRec.payload.command).toContain("[REDACTED-ANTHROPIC-KEY]");
    expect(atRec.payload.token).toBe("[REDACTED]");

    // 2. enforce-rag-for-search, spawned. All sentinels sit inside the first 200 characters.
    const rag = tmpRoot("htc-red-rag-");
    const command = `grep foo Bearer ${SECRET.bearer} API_KEY=${SECRET.apiKeyValue} ${SECRET.ghp} ${SECRET.skAnt}`;
    expect(command.length).toBeLessThanOrEqual(200);
    const rr = runHook("read/enforce-rag-for-search.mjs", rag, { tool_name: "Bash", tool_input: { command } });
    expect(rr.status).toBe(2);
    const ragRaw = rawOf(rag);
    expect(ragRaw.length).toBeGreaterThan(0);
    for (const s of RAW_SECRETS) expect(ragRaw).not.toContain(s);
    const ragRec = records(rag).find((r) => r.payload && r.payload.reason === "grep-find-rg-detected");
    expect(ragRec).toBeDefined();
    expect(ragRec.payload.command.startsWith("grep foo ")).toBe(true);
    expect(ragRec.payload.command).toContain("Bearer [REDACTED]");
    expect(ragRec.payload.command).toContain("API_KEY=[REDACTED]");
    expect(ragRec.payload.command).toContain("[REDACTED-GH-TOKEN]");
    expect(ragRec.payload.command).toContain("[REDACTED-ANTHROPIC-KEY]");

    // 3. track-write-telemetry, spawned.
    // track-write-telemetry slices Edit old/new strings to 120 characters before the helper
    // redacts, so every sentinel must sit inside that window; the sentinels are split across them.
    const tw = tmpRoot("htc-red-tw-");
    const oldStr = `${SECRET.skAnt} ${SECRET.ghp}`;
    const newStr = `API_KEY=${SECRET.apiKeyValue} Bearer ${SECRET.bearer}`;
    expect(oldStr.length).toBeLessThanOrEqual(120);
    expect(newStr.length).toBeLessThanOrEqual(120);
    const rt = runHook("system/track-write-telemetry.mjs", tw, {
      tool_name: "Edit",
      tool_input: { file_path: path.join(tw, "src", "plain.txt"), old_string: oldStr, new_string: newStr },
    });
    expect(rt.status).toBe(0);
    const twRaw = rawOf(tw);
    expect(twRaw.length).toBeGreaterThan(0);
    for (const s of RAW_SECRETS) expect(twRaw).not.toContain(s);
    const twRec = records(tw).find((r) => r.type === "dispatcher.direct_write");
    expect(twRec).toBeDefined();
    expect(twRec.payload.file).toBe("src/plain.txt");
    expect(twRec.payload.change.old).toContain("[REDACTED-ANTHROPIC-KEY]");
    expect(twRec.payload.change.old).toContain("[REDACTED-GH-TOKEN]");
    expect(twRec.payload.change.new).toContain("API_KEY=[REDACTED]");
    expect(twRec.payload.change.new).toContain("Bearer [REDACTED]");
  });

  it("appendFileSync and redactValueSecretsOnly share one line and the redact.mjs import is redactValueSecretsOnly only", () => {
    const src = fs.readFileSync(path.join(HOOKS, "system", "hook-output.mjs"), "utf8");
    const start = src.indexOf("export function appendTelemetry(");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n}\n", start);
    const body = src.slice(start, end);
    const writeLines = body.split("\n").filter((l) => l.includes("appendFileSync("));
    expect(writeLines).toHaveLength(1);
    expect(writeLines[0]).toContain("JSON.stringify(redactValueSecretsOnly(record))");
    expect(body).not.toContain("guardrails.log");

    const redactImports = src.split("\n").filter((l) => /from\s+["']\.\.\/lib\/redact\.mjs["']/.test(l));
    expect(redactImports).toEqual(['import { redactValueSecretsOnly } from "../lib/redact.mjs";']);
  });
});

describe("TR31 — export surface", () => {
  it("hook-output.mjs keeps every export with unchanged names and arities", () => {
    const fns = {
      isKeylessNotesTarget: 1,
      readHookInput: 0,
      getProjectId: 0,
      appendTelemetry: 1,
      emitGuardrailBump: 0,
      emitAgentLaunch: 0,
      buildRedirectOutput: 1,
      denyWithRedirect: 1,
      isGuardrailsOff: 0,
      isResearchAgentOutage: 1,
      emitOutageFallthrough: 0,
    };
    for (const [name, arity] of Object.entries(fns)) {
      expect(typeof hookOutput[name], name).toBe("function");
      expect(hookOutput[name].length, name).toBe(arity);
    }
    expect(typeof hookOutput.isKeyless).toBe("function");
    expect(typeof hookOutput.hasLlmCredential).toBe("function");
    expect(typeof hookOutput.PROJECT_DIR).toBe("string");
    expect(Object.keys(hookOutput).sort()).toEqual(
      [...Object.keys(fns), "isKeyless", "hasLlmCredential", "PROJECT_DIR"].sort(),
    );
  });
});
