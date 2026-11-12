// backlog.feat.server-lane-policy — AC5, AC6, AC8-AC14 against an in-memory server and fixture repos.
// Pattern source: tests/integration/dendron-update-field-autoroute-refusal.test.mjs and
// tests/integration/supplied-invalid-token-autoroute-refusal.test.mjs (createServer +
// InMemoryTransport, ROUTEKIT_PROJECT_ROOT pointed at a mkdtemp fixture with its own
// .rks/project.json, runAgent stubbed and spied, telemetry emit intercepted).
//
// AC15: ROUTEKIT_PROJECT_ROOT is pinned per case to a temporary fixture root (no-lanes, full-lanes,
// or a per-case malformed fixture), never this repo. The lane is env-resolved: RKS_VIA and
// RKS_VIA_DEFAULT are set/deleted per case. Every case restores ROUTEKIT_PROJECT_ROOT,
// RKS_PROJECT_ROOT, RKS_VIA and RKS_VIA_DEFAULT (afterEach), and the token-gate env per call.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { emitted } = vi.hoisted(() => ({ emitted: [] }));

vi.mock("@routekit/telemetry/collector", async () => {
  const actual = await vi.importActual("@routekit/telemetry/collector");
  return {
    ...actual,
    getTelemetryCollector: (...a) => {
      const real = actual.getTelemetryCollector(...a);
      return new Proxy(real, {
        get(target, prop) {
          if (prop === "emit") return (name, projectId, payload) => { emitted.push({ name, projectId, payload }); };
          return Reflect.get(target, prop);
        },
      });
    },
  };
});

// runAgent is stubbed (never a real LLM run) and spied.
vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runAgent: vi.fn(async () => ({ ok: true, output: { stub: true } })) };
});

// RAG is stubbed so rks_rag_query never embeds or loads a model in this test.
vi.mock("@routekit/rag", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureRagIndex: vi.fn(async () => {}),
    runRagEmbed: vi.fn(async () => ({ ok: true })),
    runRagQuery: vi.fn(async () => ({ ok: true, matches: [] })),
  };
});

const SPAWN_MS = 10_000;
const PROJECT_ID = "lane-fixture";
const FULL_LANES = { ide: "full", dispatch: "full", call: "read-only", mcp: "read-only" };
const LANE_ENV = ["ROUTEKIT_PROJECT_ROOT", "RKS_PROJECT_ROOT", "RKS_VIA", "RKS_VIA_DEFAULT", "RKS_ACTOR"];
const GATE_ENV = ["NODE_ENV", "RKS_SKIP_PREFLIGHT", "RKS_TEST_MODE"];
const FIXTURE_ENV = ["ROUTEKIT_PROJECT_ID", "DENDRON_VAULT_PATH", "ROUTEKIT_NOTES_DIR"];
const NOTE_NAME = "fixture.lane-note";
const NOTE = '---\nid: "fixture.lane-note"\ntitle: "Fixture"\nstatus: "original"\n---\n\n## Body\n';

const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "server-lane-gate-")));

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: SPAWN_MS });
}

function makeFixture(name, extra) {
  const root = path.join(tmpBase, name);
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(root, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  const projectJson = { id: PROJECT_ID, root, kgFile: "routekit/kg.yaml", notes: { vaultPath: "notes" }, ...extra };
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify(projectJson, null, 2));
  fs.writeFileSync(path.join(root, "routekit", "kg.yaml"), "project: fixture\n");
  fs.writeFileSync(path.join(root, "notes", `${NOTE_NAME}.md`), NOTE);
  const init = git(root, ["init", "-b", "feature/lane-test"]);
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  git(root, ["config", "user.email", "lane@test.invalid"]);
  git(root, ["config", "user.name", "Lane Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "-A"]);
  const c = git(root, ["commit", "-m", "fixture", "--no-verify"]);
  if (c.status !== 0) throw new Error(`git commit failed: ${c.stderr}`);
  return root;
}

const prevFixtureEnv = Object.fromEntries(FIXTURE_ENV.map((k) => [k, process.env[k]]));
const noLanesRoot = makeFixture("no-lanes", {});
const fullLanesRoot = makeFixture("full-lanes", { lanes: FULL_LANES });
process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;
delete process.env.DENDRON_VAULT_PATH;
delete process.env.ROUTEKIT_NOTES_DIR;

const { runAgent } = await import("../../packages/mcp-rks/src/agents/runner.mjs");
const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
const { endSession, setProjectRoot, getSession } = await import("../../packages/mcp-rks/src/shared/governor-token.mjs");
const { runRagQuery } = await import("@routekit/rag");
const { handleGovernorInit } = await import("../../packages/mcp-rks/src/tools/governor-init.mjs");
const { READ_ONLY_TOOLS, REMOTE_LANE_TOOLS, decideLane, loadBootLanePolicy } = await import("../../packages/mcp-rks/src/shared/lane-policy.mjs");

let savedLaneEnv;
const liveTokens = new Set();

function setLane({ root, via, viaDefault } = {}) {
  if (root === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT; else process.env.ROUTEKIT_PROJECT_ROOT = root;
  delete process.env.RKS_PROJECT_ROOT;
  if (via === undefined) delete process.env.RKS_VIA; else process.env.RKS_VIA = via;
  if (viaDefault === undefined) delete process.env.RKS_VIA_DEFAULT; else process.env.RKS_VIA_DEFAULT = viaDefault;
}

// Token gate armed (NODE_ENV=production, no bypass vars) unless `gate` overrides it.
async function call(name, args, { gate = { NODE_ENV: "production" } } = {}) {
  const prev = Object.fromEntries(GATE_ENV.map((k) => [k, process.env[k]]));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "server-lane-gate-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  for (const k of GATE_ENV) delete process.env[k];
  for (const [k, v] of Object.entries(gate)) process.env[k] = v;
  try {
    let res;
    try {
      res = await client.callTool({ name, arguments: args });
    } catch (err) {
      // A handler that throws (e.g. schema validation) surfaces as an MCP error: it was admitted
      // past the lane gate (the gate returns a result, never throws).
      return { res: null, text: String(err?.message ?? err), json: null, thrown: err };
    }
    const text = res?.content?.[0]?.text ?? "";
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (json?.token && name === "rks_governor_init" && json.ok) liveTokens.add(json.token);
    return { res, text, json };
  } finally {
    for (const k of GATE_ENV) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    await client.close().catch(() => {});
  }
}

async function listTools() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "server-lane-gate-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close().catch(() => {});
  }
}

async function listToolNames() {
  return (await listTools()).map((t) => t.name);
}

async function openToken() {
  const { json, text } = await call("rks_governor_init", { projectId: PROJECT_ID });
  expect(json?.ok, text).toBe(true);
  expect(typeof json.token).toBe("string");
  return json.token;
}

function listTree(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listTree(p).map((c) => path.join(ent.name, c)));
    else out.push(ent.name);
  }
  return out.sort();
}

const head = (root) => git(root, ["rev-parse", "HEAD"]).stdout.trim();
const notePath = (root, name = NOTE_NAME) => path.join(root, "notes", `${name}.md`);
const laneRefusals = () => emitted.filter((e) => e.name === "lane.refused");

beforeAll(() => {
  // Positive control that the fixtures carry what the cases assume.
  expect(JSON.parse(fs.readFileSync(path.join(fullLanesRoot, ".rks", "project.json"), "utf8")).lanes).toEqual(FULL_LANES);
  expect(JSON.parse(fs.readFileSync(path.join(noLanesRoot, ".rks", "project.json"), "utf8")).lanes).toBeUndefined();
});

beforeEach(() => {
  savedLaneEnv = Object.fromEntries(LANE_ENV.map((k) => [k, process.env[k]]));
  vi.mocked(runAgent).mockClear();
  emitted.length = 0;
});

afterEach(() => {
  for (const t of liveTokens) { try { endSession(t); } catch { /* best-effort */ } }
  liveTokens.clear();
  for (const k of LANE_ENV) { if (savedLaneEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedLaneEnv[k]; }
});

afterAll(() => {
  for (const k of FIXTURE_ENV) { if (prevFixtureEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevFixtureEnv[k]; }
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("lane gate — read-only lane refuses writes (AC5)", () => {
  it("untokened dendron_create_note returns lane_read_only, isError, no _autoRouted, no LLM agent, no file", async () => {
    setLane({ root: fullLanesRoot });
    const { res, text, json } = await call("dendron_create_note", { projectId: PROJECT_ID, filename: "fixture.should-not-exist", title: "x" });
    expect(json?.reason, text).toBe("lane_read_only");
    expect(json.ok).toBe(false);
    expect(res.isError).toBe(true);
    expect(text).not.toContain("_autoRouted");
    expect(runAgent).not.toHaveBeenCalled();
    expect(fs.existsSync(notePath(fullLanesRoot, "fixture.should-not-exist"))).toBe(false);
  });

  it("untokened rks_ship and rks_story_ship are refused and the fixture HEAD is unchanged", async () => {
    setLane({ root: fullLanesRoot });
    const before = head(fullLanesRoot);
    fs.writeFileSync(path.join(fullLanesRoot, "dirty.txt"), "uncommitted\n");
    try {
      for (const tool of ["rks_ship", "rks_story_ship"]) {
        const { json, text } = await call(tool, { projectId: PROJECT_ID, problemId: "backlog.fixture", message: "x" });
        expect(json?.reason, `${tool}: ${text}`).toBe("lane_read_only");
      }
      expect(head(fullLanesRoot)).toBe(before);
    } finally {
      fs.rmSync(path.join(fullLanesRoot, "dirty.txt"), { force: true });
    }
  });

  it("rks_governor_init with a problemId, or a non-open flowType, is refused and creates no session or lease record", async () => {
    setLane({ root: fullLanesRoot });
    const before = listTree(path.join(fullLanesRoot, ".rks"));
    const cases = [
      { problemId: "backlog.fixture" },
      { flowType: "story" },
      { flowType: "qa" },
      { flowType: "ship" },
      { flowType: "ops" },
    ];
    for (const extra of cases) {
      const { json, text } = await call("rks_governor_init", { projectId: PROJECT_ID, ...extra });
      expect(json?.reason, `${JSON.stringify(extra)}: ${text}`).toBe("lane_read_only");
      expect(json.token).toBeUndefined();
    }
    expect(listTree(path.join(fullLanesRoot, ".rks"))).toEqual(before);
  });

  it("an untokened write call with no projectId is still refused (policy from the boot root)", async () => {
    setLane({ root: fullLanesRoot });
    const { json, text } = await call("dendron_create_note", { filename: "fixture.no-project-id", title: "x" });
    expect(json?.reason, text).toBe("lane_read_only");
    expect(fs.existsSync(notePath(fullLanesRoot, "fixture.no-project-id"))).toBe(false);
  });
});

describe("lane gate — tokened calls in a read-only lane (AC6)", () => {
  it("with a valid open-flow token, dendron_update_field and rks_arch_verdict are refused and the note is unchanged", async () => {
    setLane({ root: fullLanesRoot });
    const token = await openToken();
    const before = fs.readFileSync(notePath(fullLanesRoot), "utf8");
    const upd = await call("dendron_update_field", {
      projectId: PROJECT_ID, filename: NOTE_NAME, field: "status", value: "written", skipCommit: true, _governorToken: token,
    });
    expect(upd.json?.reason, upd.text).toBe("lane_read_only");
    const arch = await call("rks_arch_verdict", { projectId: PROJECT_ID, storyId: NOTE_NAME, verdict: "approved", _governorToken: token });
    expect(arch.json?.reason, arch.text).toBe("lane_read_only");
    expect(fs.readFileSync(notePath(fullLanesRoot), "utf8")).toBe(before);
  });

  it("open-flow rks_governor_init returns a token; rks_rag_query, rks_exhaustive_search and dendron_read_note are not refused", async () => {
    setLane({ root: fullLanesRoot });
    const token = await openToken();
    const rag = await call("rks_rag_query", { projectId: PROJECT_ID, q: "fixture", _governorToken: token });
    expect(rag.json?.reason, rag.text).not.toBe("lane_read_only");
    const search = await call("rks_exhaustive_search", { projectId: PROJECT_ID, pattern: "Fixture", path: "notes", _governorToken: token });
    expect(search.json?.reason, search.text).not.toBe("lane_read_only");
    const read = await call("dendron_read_note", { projectId: PROJECT_ID, filename: NOTE_NAME, _governorToken: token });
    expect(read.json?.reason, read.text).not.toBe("lane_read_only");
    expect(read.json?.ok, read.text).toBe(true);
    expect(laneRefusals()).toHaveLength(0);
  });
});

describe("lane gate — default-deny allowlist against the registered tools (AC7)", () => {
  it("every READ_ONLY_TOOLS member is a tool the server registers", async () => {
    const names = new Set(await listToolNames());
    for (const tool of READ_ONLY_TOOLS) expect(names.has(tool), tool).toBe(true);
  });

  it("every registered tool outside READ_ONLY_TOOLS, and a made-up tool, is refused in lane mcp", async () => {
    setLane({ root: fullLanesRoot });
    const names = (await listToolNames()).filter((n) => !READ_ONLY_TOOLS.has(n));
    expect(names.length).toBeGreaterThan(20);
    const policy = loadBootLanePolicy();
    let laneRefused = 0;
    for (const tool of [...names, "rks_made_up_tool"]) {
      // The pure decision refuses every one of them.
      expect(decideLane({ lane: "mcp", policy, tool, args: { projectId: PROJECT_ID } }), tool)
        .toMatchObject({ ok: false, reason: "lane_read_only" });
      const { json, text } = await call(tool, { projectId: PROJECT_ID });
      // backlog.feat.remote-surface-lane: the lane gate now runs BEFORE the MCP preflight checks
      // (hasPreflightChecks / runPreflight), so a lane refusal is returned first. The skip below is
      // kept as a harmless guard; it never reaches a handler either way.
      if (json?.preflightFailed === true) continue;
      expect(json?.reason, `${tool}: ${text}`).toBe("lane_read_only");
      laneRefused++;
    }
    expect(laneRefused).toBeGreaterThan(20);
    expect(runAgent).not.toHaveBeenCalled();
  }, 60_000);
});

describe("lane gate — full lanes behave as today (AC8)", () => {
  for (const via of ["ide", "dispatch"]) {
    it(`RKS_VIA=${via}: the AC5 and AC6 calls are not lane-refused, and a tokened dendron_update_field writes`, async () => {
      setLane({ root: fullLanesRoot, via });
      const token = await openToken();
      const upd = await call("dendron_update_field", {
        projectId: PROJECT_ID, filename: NOTE_NAME, field: "status", value: `written-${via}`, skipCommit: true, _governorToken: token,
      });
      expect(upd.json?.reason, upd.text).not.toBe("lane_read_only");
      expect(upd.json?.ok, upd.text).toBe(true);
      expect(fs.readFileSync(notePath(fullLanesRoot), "utf8")).toMatch(new RegExp(`^status: "written-${via}"$`, "m"));
      for (const [tool, args] of [
        ["rks_rag_query", { projectId: PROJECT_ID, q: "fixture", _governorToken: token }],
        ["rks_exhaustive_search", { projectId: PROJECT_ID, pattern: "Fixture", path: "notes", _governorToken: token }],
        ["dendron_read_note", { projectId: PROJECT_ID, filename: NOTE_NAME, _governorToken: token }],
        ["rks_arch_verdict", { projectId: PROJECT_ID, storyId: "fixture.missing", verdict: "approved", _governorToken: token }],
        // Schema-incomplete args: the handler rejects them; the point is the lane gate admits them.
        ["dendron_create_note", { projectId: PROJECT_ID, filename: "bad/name" }],
        ["rks_ship", {}],
        ["rks_story_ship", {}],
      ]) {
        const { json, text } = await call(tool, args);
        expect(json?.reason, `${tool}: ${text}`).not.toBe("lane_read_only");
      }
      expect(laneRefusals()).toHaveLength(0);
      fs.writeFileSync(notePath(fullLanesRoot), NOTE);
    });
  }
});

describe("lane gate — call lane (AC9)", () => {
  it("RKS_VIA=call: dendron_read_note is admitted and dendron_create_note is refused", async () => {
    setLane({ root: fullLanesRoot, via: "call", viaDefault: "ide" });
    const token = await openToken();
    const read = await call("dendron_read_note", { projectId: PROJECT_ID, filename: NOTE_NAME, _governorToken: token });
    expect(read.json?.ok, read.text).toBe(true);
    const create = await call("dendron_create_note", { projectId: PROJECT_ID, filename: "fixture.call-lane", title: "x", _governorToken: token });
    expect(create.json?.reason, create.text).toBe("lane_read_only");
    expect(create.json.lane).toBe("call");
    expect(fs.existsSync(notePath(fullLanesRoot, "fixture.call-lane"))).toBe(false);
  });
});

describe("lane gate — not disabled by the token-gate bypass (AC10)", () => {
  for (const gate of [{ RKS_TEST_MODE: "1" }, { NODE_ENV: "test" }]) {
    it(`${JSON.stringify(gate)}: untokened dendron_create_note is still refused and writes no file`, async () => {
      setLane({ root: fullLanesRoot });
      const { json, text } = await call("dendron_create_note", { projectId: PROJECT_ID, filename: "fixture.bypass", title: "x" }, { gate });
      expect(json?.reason, text).toBe("lane_read_only");
      expect(fs.existsSync(notePath(fullLanesRoot, "fixture.bypass"))).toBe(false);
    });
  }
});

describe("lane gate — absent and malformed policy, and the init lane report (AC11)", () => {
  it("no-lanes fixture: untokened and open-flow tokened calls behave as today; init reports policy absent, enforced false", async () => {
    setLane({ root: noLanesRoot });
    const init = await call("rks_governor_init", { projectId: PROJECT_ID });
    expect(init.json?.ok, init.text).toBe(true);
    expect(init.json.lane).toMatchObject({ policy: "absent", enforced: false, mode: "full", root: noLanesRoot });
    liveTokens.add(init.json.token);
    const untokened = await call("dendron_update_field", { projectId: PROJECT_ID, filename: NOTE_NAME, field: "status", value: "x" });
    expect(untokened.json?.reason, untokened.text).not.toBe("lane_read_only");
    expect(untokened.json?.error, untokened.text).toBe("unauthorized");
    const upd = await call("dendron_update_field", {
      projectId: PROJECT_ID, filename: NOTE_NAME, field: "status", value: "written-absent", skipCommit: true, _governorToken: init.json.token,
    });
    expect(upd.json?.ok, upd.text).toBe(true);
    expect(fs.readFileSync(notePath(noLanesRoot), "utf8")).toMatch(/^status: "written-absent"$/m);
    fs.writeFileSync(notePath(noLanesRoot), NOTE);
    expect(laneRefusals()).toHaveLength(0);
  });

  it("malformed lanes block with RKS_VIA=ide: dendron_create_note is refused with invalid_lane_policy naming the problem and the file", async () => {
    const bad = makeFixture("malformed", { lanes: { ide: "sometimes" } });
    setLane({ root: bad, via: "ide" });
    const { json, text, res } = await call("dendron_create_note", { projectId: PROJECT_ID, filename: "fixture.malformed", title: "x" });
    expect(json?.reason, text).toBe("invalid_lane_policy");
    expect(res.isError).toBe(true);
    expect(json.error).toContain("sometimes");
    expect(text).toContain(".rks/project.json");
    expect(fs.existsSync(notePath(bad, "fixture.malformed"))).toBe(false);
  });

  it("full-lanes fixture: init reports via, policy ok, enforced true, mode of the env lane, root = fixture", async () => {
    setLane({ root: fullLanesRoot });
    const mcp = await call("rks_governor_init", { projectId: PROJECT_ID });
    expect(mcp.json?.lane, mcp.text).toEqual({ via: "mcp", policy: "ok", enforced: true, mode: "read-only", root: fullLanesRoot });
    setLane({ root: fullLanesRoot, viaDefault: "ide" });
    const ide = await call("rks_governor_init", { projectId: PROJECT_ID });
    expect(ide.json?.lane, ide.text).toEqual({ via: "ide", policy: "ok", enforced: true, mode: "full", root: fullLanesRoot });
  });
});

describe("lane gate — the init input via does not change the enforced lane (AC12)", () => {
  it("lane mcp, init with via ide: lane.mode read-only and a later dendron_update_field is refused", async () => {
    setLane({ root: fullLanesRoot });
    const init = await call("rks_governor_init", { projectId: PROJECT_ID, via: "ide" });
    expect(init.json?.ok, init.text).toBe(true);
    expect(init.json.via).toBe("ide");
    expect(init.json.lane.mode).toBe("read-only");
    expect(init.json.lane.via).toBe("mcp");
    const upd = await call("dendron_update_field", {
      projectId: PROJECT_ID, filename: NOTE_NAME, field: "status", value: "x", skipCommit: true, _governorToken: init.json.token,
    });
    expect(upd.json?.reason, upd.text).toBe("lane_read_only");
  });
});

describe("lane gate — telemetry (AC13)", () => {
  it("each refusal emits exactly one lane.refused event carrying lane, tool and reason", async () => {
    setLane({ root: fullLanesRoot });
    await call("dendron_create_note", { projectId: PROJECT_ID, filename: "fixture.telemetry", title: "x" });
    expect(laneRefusals()).toHaveLength(1);
    expect(laneRefusals()[0].payload).toEqual({ lane: "mcp", tool: "dendron_create_note", reason: "lane_read_only" });
    await call("rks_ship", { projectId: PROJECT_ID });
    expect(laneRefusals()).toHaveLength(2);
    expect(laneRefusals()[1].payload).toEqual({ lane: "mcp", tool: "rks_ship", reason: "lane_read_only" });
    const bad = makeFixture("malformed-telemetry", { lanes: [] });
    setLane({ root: bad, via: "dispatch" });
    await call("dendron_create_note", { projectId: PROJECT_ID, filename: "fixture.telemetry", title: "x" });
    expect(laneRefusals()).toHaveLength(3);
    expect(laneRefusals()[2].payload).toEqual({ lane: "dispatch", tool: "dendron_create_note", reason: "invalid_lane_policy" });
  });
});

describe("lane gate — policy only from the boot project root (AC14)", () => {
  it("root no-lanes + projectId/path naming the full-lanes project: not refused; root full-lanes + naming no-lanes: refused", async () => {
    setLane({ root: noLanesRoot });
    const a = await call("dendron_create_note", {
      projectId: "fixture-full-lanes", filename: "fixture.cross", title: "x", path: fullLanesRoot, projectRoot: fullLanesRoot,
    });
    expect(a.json?.reason, a.text).not.toBe("lane_read_only");
    setLane({ root: fullLanesRoot });
    const b = await call("dendron_create_note", {
      projectId: "fixture-no-lanes", filename: "fixture.cross2", title: "x", path: noLanesRoot, projectRoot: noLanesRoot,
    });
    expect(b.json?.reason, b.text).toBe("lane_read_only");
  });

  it("no root env, cwd = full-lanes fixture: dendron_create_note not refused; init lane report absent, root null", async () => {
    const prevCwd = process.cwd();
    setLane({});
    process.chdir(fullLanesRoot);
    try {
      const { json, text } = await call("dendron_create_note", { projectId: PROJECT_ID, filename: "fixture.no-root", title: "x" });
      expect(json?.reason, text).not.toBe("lane_read_only");
      expect(laneRefusals()).toHaveLength(0);
      // The init handler's lane report, driven directly: with no boot root the MCP handler cannot
      // resolve a project context, so session persistence is pointed at the fixture explicitly.
      setProjectRoot(fullLanesRoot);
      const init = handleGovernorInit({ projectId: PROJECT_ID });
      expect(init.ok, JSON.stringify(init)).toBe(true);
      liveTokens.add(init.token);
      expect(init.lane).toMatchObject({ policy: "absent", enforced: false, root: null, mode: "full" });
    } finally {
      process.chdir(prevCwd);
    }
  });
});

// ── backlog.feat.remote-surface-lane ────────────────────────────────────────────────────────────
// The remote lane through the real request handler. ROUTEKIT_PROJECT_ROOT is the no-lanes fixture
// (project id lane-fixture); RKS_VIA / RKS_ACTOR are set per case and restored by afterEach. The
// token-gate bypass is DISABLED for every call (call()'s default gate: NODE_ENV=production with
// RKS_SKIP_PREFLIGHT and RKS_TEST_MODE unset), so a "not auto-routed" result cannot be produced by
// the bypass; the ide-lane positive control proves the harness observes the auto-route.
const REMOTE_FIVE = ["rks_governor_init", "rks_governor_end", "rks_rag_query", "dendron_read_note", "dendron_create_note"];
const sessionTree = (root) => [
  ...listTree(path.join(root, ".rks", "session", "governor")).map((n) => `governor/${n}`),
  ...listTree(path.join(root, ".rks", "session", "lease")).map((n) => `lease/${n}`),
];
function setRemote({ root = noLanesRoot, noRoot = false, actor = "grokbot" } = {}) {
  setLane({ root: noRoot ? undefined : root, via: "remote" });
  if (actor === undefined) delete process.env.RKS_ACTOR; else process.env.RKS_ACTOR = actor;
}
function rmNote(root, name) {
  fs.rmSync(notePath(root, name), { force: true });
}

describe("remote lane — tokenless calls are refused, never auto-routed", () => {
  beforeEach(() => { vi.mocked(runRagQuery).mockClear(); });

  it("tokenless dendron_read_note, dendron_create_note and rks_rag_query return remote_token_required; no agent, no file, one lane.refused each", async () => {
    setRemote();
    expect(process.env.NODE_ENV).not.toBe("production"); // the gate is armed per call, below
    const cases = [
      ["dendron_read_note", { projectId: PROJECT_ID, filename: NOTE_NAME }],
      ["dendron_create_note", { projectId: PROJECT_ID, filename: "inbox.grokbot.tokenless", title: "x" }],
      ["rks_rag_query", { projectId: PROJECT_ID, q: "fixture" }],
    ];
    let n = 0;
    for (const [tool, args] of cases) {
      const { res, json, text } = await call(tool, args); // gate armed: bypass disabled
      expect(json?.reason, `${tool}: ${text}`).toBe("remote_token_required");
      expect(json).toMatchObject({ ok: false, lane: "remote", tool });
      expect(res.isError).toBe(true);
      expect(text).not.toContain("_autoRouted");
      n++;
      expect(laneRefusals()).toHaveLength(n);
      expect(laneRefusals()[n - 1].payload).toEqual({ lane: "remote", tool, reason: "remote_token_required" });
    }
    expect(runAgent).not.toHaveBeenCalled();
    expect(runRagQuery).not.toHaveBeenCalled();
    expect(fs.existsSync(notePath(noLanesRoot, "inbox.grokbot.tokenless"))).toBe(false);
  });

  it("positive control: the same tokenless dendron_create_note under RKS_VIA=ide (bypass disabled) reaches the auto-route and writes the file", async () => {
    const name = "inbox.grokbot.ide-control";
    setLane({ root: noLanesRoot, via: "ide" });
    try {
      const { json, text } = await call("dendron_create_note", { projectId: PROJECT_ID, filename: name, title: "x" });
      expect(json?.reason, text).toBeUndefined();
      expect(text).toContain("_autoRouted");
      expect(fs.existsSync(notePath(noLanesRoot, name)), text).toBe(true);
      expect(laneRefusals()).toHaveLength(0);
    } finally {
      rmNote(noLanesRoot, name);
    }
  });

  it("a tokenless rks_agent_research is refused by the lane gate and creates no governor session record or lease", async () => {
    setRemote();
    const before = sessionTree(noLanesRoot);
    const { json, text } = await call("rks_agent_research", { projectId: PROJECT_ID, query: "anything" });
    expect(json?.reason, text).toBe("remote_tool_not_allowed");
    expect(json.lane).toBe("remote");
    expect(sessionTree(noLanesRoot)).toEqual(before);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rks_rag_query with an unknown _governorToken string is refused remote_token_required and runRagQuery is not called", async () => {
    setRemote();
    const { json, text } = await call("rks_rag_query", { projectId: PROJECT_ID, q: "fixture", _governorToken: "00000000-not-a-live-token" });
    expect(json?.reason, text).toBe("remote_token_required");
    expect(runRagQuery).not.toHaveBeenCalled();
  });
});

describe("remote lane — project pin", () => {
  beforeEach(() => { vi.mocked(runRagQuery).mockClear(); });

  it("a valid remote token with projectId other-project is refused remote_project_mismatch; lane-fixture is admitted and runs the query", async () => {
    setRemote();
    const token = await openToken();
    expect(getSession(token)?.via).toBe("remote");
    const foreign = await call("rks_rag_query", { projectId: "other-project", q: "fixture", _governorToken: token });
    expect(foreign.json?.reason, foreign.text).toBe("remote_project_mismatch");
    expect(runRagQuery).not.toHaveBeenCalled();
    const own = await call("rks_rag_query", { projectId: PROJECT_ID, q: "fixture", _governorToken: token });
    expect(own.json?.reason, own.text).toBeUndefined();
    expect(runRagQuery).toHaveBeenCalled();
  });

  it("rks_governor_init with projectId other-project is refused remote_project_mismatch with no token; unset roots refuse remote_project_unresolved", async () => {
    setRemote();
    const foreign = await call("rks_governor_init", { projectId: "other-project" });
    expect(foreign.json?.reason, foreign.text).toBe("remote_project_mismatch");
    expect(foreign.json.token).toBeUndefined();
    setRemote({ noRoot: true });
    expect(process.env.ROUTEKIT_PROJECT_ROOT).toBeUndefined();
    expect(process.env.RKS_PROJECT_ROOT).toBeUndefined();
    const unresolved = await call("rks_governor_init", { projectId: PROJECT_ID });
    expect(unresolved.json?.reason, unresolved.text).toBe("remote_project_unresolved");
    expect(unresolved.json.token).toBeUndefined();
  });
});

describe("remote lane — the lane gate sits above preflight", () => {
  it("RKS_VIA=remote with preflight enabled: tokenless rks_release and rks_plan return the remote refusal, not preflightFailed", async () => {
    setRemote();
    for (const tool of ["rks_release", "rks_plan"]) {
      const { json, text } = await call(tool, { projectId: PROJECT_ID }); // RKS_SKIP_PREFLIGHT unset
      expect(json?.preflightFailed, `${tool}: ${text}`).toBeUndefined();
      expect(json?.reason, `${tool}: ${text}`).toBe("remote_tool_not_allowed");
      expect(json.lane).toBe("remote");
    }
  });

  it("RKS_VIA=mcp on the full-lanes fixture with preflight enabled: tokenless rks_plan returns lane_read_only, not preflightFailed", async () => {
    setLane({ root: fullLanesRoot, via: "mcp" });
    const { json, text } = await call("rks_plan", { projectId: PROJECT_ID });
    expect(json?.preflightFailed, text).toBeUndefined();
    expect(json?.reason, text).toBe("lane_read_only");
  });

  it("every registered tool outside the five is refused remote_tool_not_allowed (pure decision and through the server)", async () => {
    // The remote tools/list is filtered to the five (backlog.fix.remote-lane-tools-list-advertises-refused-tools),
    // so the sweep sources the full registered set from a non-remote listing, then switches to remote.
    setLane({ root: noLanesRoot, via: "ide" });
    const fullNames = await listToolNames();
    for (const tool of REMOTE_FIVE) expect(fullNames.includes(tool), tool).toBe(true);
    const names = fullNames.filter((n) => !REMOTE_FIVE.includes(n));
    expect(names.length).toBeGreaterThan(20);
    expect(names).toContain("rks_release");
    setRemote();
    expect(process.env.RKS_VIA).toBe("remote");
    for (const tool of REMOTE_FIVE) expect((await listToolNames()).includes(tool), tool).toBe(true);
    for (const tool of names) {
      expect(decideLane({ lane: "remote", policy: loadBootLanePolicy(), tool, args: { projectId: PROJECT_ID }, tokenValid: true, bootProjectId: PROJECT_ID }), tool)
        .toMatchObject({ ok: false, reason: "remote_tool_not_allowed", lane: "remote", tool });
      const { json, text } = await call(tool, { projectId: PROJECT_ID });
      expect(json?.reason, `${tool}: ${text}`).toBe("remote_tool_not_allowed");
    }
    expect(runAgent).not.toHaveBeenCalled();
  }, 60_000);
});

describe("remote lane — tokened open-flow session writes only under inbox.<actor>.", () => {
  beforeEach(() => { vi.mocked(runRagQuery).mockClear(); });

  it("init returns a token; create inbox.grokbot.test-note writes it; a second create is refused; a later rks_rag_query is admitted in state writing", async () => {
    const name = "inbox.grokbot.test-note";
    setRemote();
    try {
      const init = await call("rks_governor_init", { projectId: PROJECT_ID });
      expect(init.json?.ok, init.text).toBe(true);
      expect(init.json.lane).toMatchObject({ via: "remote", mode: "remote", enforced: true });
      const token = init.json.token;
      const first = await call("dendron_create_note", { projectId: PROJECT_ID, filename: name, title: "Test note", _governorToken: token });
      expect(first.json?.reason, first.text).toBeUndefined();
      expect(fs.existsSync(notePath(noLanesRoot, name)), first.text).toBe(true);
      expect(getSession(token)?.state).toBe("writing");
      const second = await call("dendron_create_note", { projectId: PROJECT_ID, filename: name, title: "Again", _governorToken: token });
      expect(second.text).toMatch(/already exists/i);
      const outside = await call("dendron_create_note", { projectId: PROJECT_ID, filename: "research.remote-x", title: "x", _governorToken: token });
      expect(outside.json?.reason, outside.text).toBe("remote_write_outside_prefix");
      expect(fs.existsSync(notePath(noLanesRoot, "research.remote-x"))).toBe(false);
      const rag = await call("rks_rag_query", { projectId: PROJECT_ID, q: "fixture", _governorToken: token });
      expect(rag.json?.reason, rag.text).toBeUndefined();
      expect(rag.text).not.toMatch(/chain_violation/);
      expect(runRagQuery).toHaveBeenCalled();
      expect(getSession(token)?.state).toBe("writing");
    } finally {
      rmNote(noLanesRoot, name);
    }
  });
});

describe("remote lane — tools/list advertises only the admitted tools", () => {
  it("RKS_VIA=remote lists exactly the REMOTE_LANE_TOOLS names", async () => {
    setRemote();
    const names = await listToolNames();
    expect([...names].sort()).toEqual([...REMOTE_LANE_TOOLS].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => !REMOTE_LANE_TOOLS.has(n))).toEqual([]);
    // The test's own literal list agrees with the policy set, so the other remote cases test the same five.
    expect([...REMOTE_FIVE].sort()).toEqual([...REMOTE_LANE_TOOLS].sort());
  });

  it("RKS_VIA=remote schemas deep-equal the ide listing for the same tools", async () => {
    setLane({ root: noLanesRoot, via: "ide" });
    const ide = new Map((await listTools()).map((t) => [t.name, t]));
    setRemote();
    const remote = await listTools();
    expect(remote.length).toBe(REMOTE_LANE_TOOLS.size);
    let tokenBearing = 0;
    for (const t of remote) {
      const ideTool = ide.get(t.name);
      expect(ideTool, t.name).toBeDefined();
      expect(t.inputSchema, t.name).toEqual(ideTool.inputSchema);
      const ideHasToken = Object.prototype.hasOwnProperty.call(ideTool.inputSchema?.properties ?? {}, "_governorToken");
      const remoteHasToken = Object.prototype.hasOwnProperty.call(t.inputSchema?.properties ?? {}, "_governorToken");
      expect(remoteHasToken, `${t.name} _governorToken`).toBe(ideHasToken);
      if (ideHasToken) tokenBearing += 1;
    }
    // Positive control: at least one of the five carries the injected _governorToken property.
    expect(tokenBearing).toBeGreaterThan(0);
  });

  it("non-remote lanes and the read-only lane list the full unfiltered tool set", async () => {
    setLane({ root: noLanesRoot, via: "ide" });
    const ideNames = [...(await listToolNames())].sort();
    expect(ideNames.length).toBeGreaterThan(20);
    expect(ideNames).toContain("rks_release");
    const cases = [
      ...["ide", "dispatch", "call", "mcp"].map((via) => ({ root: noLanesRoot, via, label: `no-lanes ${via}` })),
      { root: fullLanesRoot, via: "mcp", label: "read-only lanes mcp" },
    ];
    // Positive control: the read-only case really is a read-only lane.
    expect(FULL_LANES.mcp).toBe("read-only");
    for (const { root, via, label } of cases) {
      setLane({ root, via });
      const names = [...(await listToolNames())].sort();
      expect(names, label).toEqual(ideNames);
      expect(names.length, label).toBeGreaterThan(20);
      expect(names.includes("rks_release"), label).toBe(true);
    }
  });

  it("server.mjs sources the remote filter from REMOTE_LANE_TOOLS in lane-policy.mjs", () => {
    const serverSrc = fs.readFileSync(new URL("../../packages/mcp-rks/src/server.mjs", import.meta.url), "utf8");
    expect(serverSrc).toMatch(/^import \{[^}\n]*\bREMOTE_LANE_TOOLS\b[^}\n]*\} from "\.\/shared\/lane-policy\.mjs";$/m);
    const start = serverSrc.indexOf("server.setRequestHandler(ListToolsRequestSchema");
    const end = serverSrc.indexOf("server.setRequestHandler(CallToolRequestSchema");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = serverSrc.slice(start, end);
    expect(body).toContain("REMOTE_LANE_TOOLS.has(");
    expect(body).toContain("envLane()");
    // The filter is set membership, not a per-name comparison against one of the five.
    for (const name of REMOTE_LANE_TOOLS) expect(body.includes(`=== "${name}"`) || body.includes(`=== '${name}'`), name).toBe(false);
  });

  it("an unadvertised rks_release is still refused remote_tool_not_allowed", async () => {
    setRemote();
    const names = await listToolNames();
    expect(names).not.toContain("rks_release");
    expect(names.length).toBe(REMOTE_LANE_TOOLS.size);
    const { json, text } = await call("rks_release", { projectId: PROJECT_ID });
    expect(json?.ok, text).toBe(false);
    expect(json.reason, text).toBe("remote_tool_not_allowed");
    expect(json.lane).toBe("remote");
    expect(json.tool).toBe("rks_release");
    expect(runAgent).not.toHaveBeenCalled();
  });
});
