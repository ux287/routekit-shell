// backlog.feat.admission-conformance-suite
// Shared harness for the admission conformance suite. Test-only. It drives mcp-rks through its MCP
// dispatch (tools/call) and never asserts on source text. Every server it boots points at a mkdtemp
// fixture repo from makeFixtureRoot, never at the routekit-shell-core checkout (AC 13). It exports no
// function that writes governor session state directly (AC 2): chain states are reached only by
// replaying tools/call setup steps.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REMOTE_REASONS } from "../../packages/mcp-rks/src/shared/lane-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const CORPUS_PATH = path.join(HERE, "..", "integration", "fixtures", "admission-conformance.corpus.json");
export const SERVER_PATH = path.join(REPO_ROOT, "packages", "mcp-rks", "src", "server.mjs");

export const LANES = Object.freeze(["ide", "dispatch", "call", "mcp", "remote"]);
export const FLOW_TYPES = Object.freeze(["story", "open", "qa", "ship", "ops"]);
export const CLIENT_PROFILES = Object.freeze([
  { name: "claude-code", label: "ide" },
  { name: "routekit-call", label: "call" },
  { name: "cursor", label: "cursor" },
]);

export const FIXTURE_PROJECT_ID = "admission-conformance-fixture";
export const FIXTURE_STORY_ID = "backlog.conformance.fixture-story";
export const CONFORMANCE_NOTE_PREFIXES = Object.freeze(["backlog.conformance.", "inbox.conformance"]);

// AC 3: the closed set of reasons an ADMISSION layer emits. A handler's own refusal is never a member.
// Build adds a member only when it observes an admission layer emit it; an AC 2 checkToolArgs refusal
// case that classifies as allow fails the suite, so a missing member cannot hide.
export const ADMISSION_REASONS = new Set([
  "lane_read_only", "invalid_lane_policy", ...REMOTE_REASONS,
  "chain_violation", "namespace_violation", "proto_story_guard",
  "unauthorized",
  "project_leased", "lease_contended", "lease_lost",
]);

// AC 13: cleared before, and restored after, every case.
export const SCRUBBED_ENV = Object.freeze([
  "RKS_DISPATCH_RUN_ID", "RKS_ACTOR", "RKS_VIA", "RKS_VIA_DEFAULT", "RKS_PROJECT_ROOT",
  "ROUTEKIT_PROJECT_ROOT", "NODE_ENV", "RKS_TEST_MODE", "RKS_SKIP_PREFLIGHT",
]);

// AC 13 (ARCH v2 item 1): fixture identity, saved and restored with SCRUBBED_ENV. withCaseEnv SETS
// ROUTEKIT_PROJECT_ID to FIXTURE_PROJECT_ID (project-context.mjs:47 reads it before project.json) and
// CLEARS DENDRON_VAULT_PATH and ROUTEKIT_NOTES_DIR (dendron.mjs:272 and :276 honour them ahead of
// <root>/notes). Precedent: tests/integration/server-lane-gate.test.mjs:59, :89, :92-94 and :199
// (:59 names the variables, :89 saves them, :92-94 set and clear them, :199 restores them).
export const FIXTURE_ENV = Object.freeze(["ROUTEKIT_PROJECT_ID", "DENDRON_VAULT_PATH", "ROUTEKIT_NOTES_DIR"]);

// AC 15: every subprocess carries its own bound.
const GIT_TIMEOUT_MS = 30_000;
export const STDIO_CLOSE_TIMEOUT_MS = 15_000;

const FIXTURE_STORY_NOTE = `---\nid: "${FIXTURE_STORY_ID}"\ntitle: "Admission conformance fixture story"\nphase: "draft"\n---\n\n# Fixture story\n`;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: GIT_TIMEOUT_MS, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" } });
}

/** The repo's own lanes value, copied into a lanes-block "ok" fixture. Nothing else is copied. */
export function readRepoLanes() {
  const projectJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".rks", "project.json"), "utf8"));
  return projectJson.lanes ?? null;
}

/**
 * The repo's HEAD as "@<short sha>" plus "+dirty" when the worktree has changes: the corpus anchor
 * (AC 11). Read-only git against the checkout, bounded like every other git call (AC 15).
 */
export function repoAnchor() {
  const sha = git(REPO_ROOT, ["rev-parse", "--short", "HEAD"]).trim();
  const dirty = git(REPO_ROOT, ["status", "--porcelain"]).trim() !== "";
  return `@${sha}${dirty ? "+dirty" : ""}`;
}

/**
 * A fresh mkdtemp git repo on branch staging with no remote (AC 13). Build one per replay (each case,
 * client and transport) through replayOnFreshFixture; never share a root between replays. It holds
 * routekit/kg.yaml, because rks_governor_init calls loadContext (governance.mjs:661), which throws
 * "KG file not found" without it (project-context.mjs:164). lanes: "repo" copies the repo's
 * lanes value, null omits the block, any other value is written as-is (the lanes-block "invalid" case).
 * branch checks out a non-staging branch for refused-preflight cases (AC 2); it is fixture git state.
 */
export const FIXTURE_WORKTREE_CHANGE = "conformance-change.txt";
export function makeFixtureRoot({ lanes = "repo", label = "case", branch = null, worktreeChange = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `admission-conformance-${label}-`)));
  git(root, ["init", "-b", "staging"]);
  git(root, ["config", "user.email", "conformance@example.invalid"]);
  git(root, ["config", "user.name", "admission-conformance"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  const projectJson = { id: FIXTURE_PROJECT_ID, baseBranch: "staging", kgFile: "routekit/kg.yaml", notes: { vaultPath: "notes" } };
  const lanesValue = lanes === "repo" ? readRepoLanes() : lanes;
  if (lanesValue !== null && lanesValue !== undefined) projectJson.lanes = lanesValue;
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify(projectJson, null, 2) + "\n");
  // Precedent: tests/integration/server-lane-gate.test.mjs:74 (kgFile) and :76 (kg.yaml content).
  fs.mkdirSync(path.join(root, "routekit"), { recursive: true });
  fs.writeFileSync(path.join(root, "routekit", "kg.yaml"), "project: fixture\n");
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes", `${FIXTURE_STORY_ID}.md`), FIXTURE_STORY_NOTE);
  // An (empty, untracked) .routekit/hooks directory: outside test mode the stdio server's boot check
  // (server.mjs bootServer -> verifyHooksPresent(cwd)) exits 1 without it. Every fixture carries it, so
  // the in-process and stdio replays see the same tree.
  fs.mkdirSync(path.join(root, ".routekit", "hooks"), { recursive: true });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "admission-conformance fixture", "--no-verify"]);
  if (branch) git(root, ["checkout", "-b", branch]);
  // backlog.feat.admission-conformance-strict-baseline AC 5: an uncommitted worktree change is fixture
  // git state, so a ship-flow setup step (a real rks_git_commit) can reach the committed state.
  if (worktreeChange) fs.writeFileSync(path.join(root, FIXTURE_WORKTREE_CHANGE), "admission conformance worktree change\n");
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * Run fn with SCRUBBED_ENV and FIXTURE_ENV cleared, ROUTEKIT_PROJECT_ID set to FIXTURE_PROJECT_ID and vars
 * applied, then restore every touched variable, all three FIXTURE_ENV variables included (AC 13).
 */
export async function withCaseEnv(vars, fn) {
  const keys = new Set([...SCRUBBED_ENV, ...FIXTURE_ENV, ...Object.keys(vars)]);
  const saved = new Map([...keys].map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.ROUTEKIT_PROJECT_ID = FIXTURE_PROJECT_ID;
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** Connect an MCP client, with the given client name, to a server created by createServer(). */
export async function connectInProcess(createServer, { clientName }) {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: "0.0.0-conformance" });
  await client.connect(clientTransport);
  return { client, server, close: async () => { await client.close(); await server.close?.(); } };
}

/**
 * The stdio subprocess env: an explicit allowlist, never a spread of process.env (AC 9). The subprocess
 * has no VITEST, so RKS_SKIP_BACKGROUND_EMBED is required: without it writeNoteRaw, reached by the verbatim
 * dendron_create_note route (server.mjs:599), spawns packages/rag/src/embed.mjs (dendron.mjs:325, :357).
 */
export function stdioEnv({ root, home, via, actor }) {
  const env = {
    PATH: process.env.PATH ?? "", HOME: home, TMPDIR: os.tmpdir(),
    ROUTEKIT_PROJECT_ROOT: root, ROUTEKIT_PROJECT_ID: FIXTURE_PROJECT_ID,
    RKS_SKIP_BACKGROUND_EMBED: "1",
    ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "",
  };
  if (via) env.RKS_VIA = via;
  if (actor) env.RKS_ACTOR = actor;
  return env;
}

/** Connect an MCP client to mcp-rks over a stdio subprocess, with a SIGKILL guard on close (AC 15). */
export async function connectStdio({ env, cwd, clientName }) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH], env, cwd, stderr: "pipe" });
  // Drain the piped stderr so a chatty server can never block on a full pipe.
  transport.stderr?.on?.("data", () => {});
  const client = new Client({ name: clientName, version: "0.0.0-conformance" });
  await client.connect(transport);
  const close = async () => {
    const pid = transport.pid;
    const guard = setTimeout(() => { try { if (pid) process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }, STDIO_CLOSE_TIMEOUT_MS);
    try { await client.close(); } finally { clearTimeout(guard); }
  };
  return { client, close };
}

export function parseBody(result) {
  const text = result?.content?.[0]?.text;
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// AC 11: reason and handlerReason hold stable code strings only. A handler that puts a prose
// message (which can carry a fixture path or a token) in `error` is recorded as "error_message".
const CODE_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
export function stableCode(value) {
  if (typeof value !== "string" || value === "") return null;
  return CODE_RE.test(value) ? value : "error_message";
}

// backlog.feat.admission-conformance-strict-baseline AC 1: a thrown error that names no admission reason
// is recorded as thrown:<code>:<class>. The class comes from this closed classifier, never from free text:
// a zod issue list (the server rewraps a handler throw with the original message, server.mjs McpError
// InternalError) is zod:<first issue path>; a small closed map names the other observed patterns; anything
// else is "unclassified", the only fallback.
export const THROWN_MESSAGE_PATTERNS = Object.freeze([
  Object.freeze({ cls: "project_not_found", re: /^Project not found: / }),
  Object.freeze({ cls: "unknown_tool", re: /^Unknown tool: / }),
  Object.freeze({ cls: "note_exists", re: /^Note already exists: / }),
  Object.freeze({ cls: "invalid_filename", re: /^Invalid filename: / }),
  Object.freeze({ cls: "notes_dir_not_found", re: /^notes directory not found: / }),
]);
export const UNCLASSIFIED = "unclassified";
const MCP_ERROR_PREFIX_RE = /^(?:MCP error -?\d+: )+/;

/** The closed cause class of a thrown message: zod:<path>, a THROWN_MESSAGE_PATTERNS class, or unclassified. */
export function classifyThrownMessage(message) {
  const text = String(message ?? "").replace(MCP_ERROR_PREFIX_RE, "").trim();
  if (text.startsWith("[")) {
    let issues = null;
    try { issues = JSON.parse(text); } catch { issues = null; }
    const first = Array.isArray(issues) ? issues[0] : null;
    if (first && typeof first === "object" && typeof first.code === "string" && Array.isArray(first.path)) {
      const p = first.path.map((seg) => String(seg)).join(".").replace(/[^A-Za-z0-9_.-]/g, "_");
      return `zod:${p === "" ? "root" : p}`;
    }
  }
  const hit = THROWN_MESSAGE_PATTERNS.find((m) => m.re.test(text));
  return hit ? hit.cls : UNCLASSIFIED;
}

function thrownReason(thrown) {
  const rawCode = thrown?.code ?? "error";
  const code = /^-?[A-Za-z0-9_]{1,12}$/.test(String(rawCode)) ? String(rawCode) : "error";
  const prefix = `thrown:${code}:`;
  const cls = classifyThrownMessage(thrown?.message ?? thrown);
  return prefix + cls.slice(0, 80 - prefix.length);
}

/** AC 10: an ADMISSION_REASONS member that appears in a message as a whole token, never as a substring. */
export function admissionReasonInMessage(message) {
  const tokens = new Set(String(message ?? "").split(/[^A-Za-z0-9_]+/).filter(Boolean));
  return [...ADMISSION_REASONS].find((r) => tokens.has(r)) ?? null;
}

/**
 * Normalise a tools/call outcome to { effect, reason, handlerReason } (AC 3). route iff _autoRouted;
 * deny iff preflightFailed or an ADMISSION_REASONS member in `error` or `reason`, whatever `ok` says
 * (an isError body included); on a thrown error, deny iff its message names a member as a whole token.
 * Everything else is allow, with the handler's own refusal code recorded as handlerReason ("ok_false"
 * for an ok: false body that names no code, "is_error" for an isError result, "thrown:<code>:<class>"
 * for a thrown error, <class> from classifyThrownMessage).
 */
export function normaliseDecision(result, { thrown = null } = {}) {
  if (thrown) {
    const hit = admissionReasonInMessage(thrown?.message ?? thrown);
    if (hit) return { effect: "deny", reason: hit, handlerReason: null };
    return { effect: "allow", reason: null, handlerReason: thrownReason(thrown) };
  }
  const body = parseBody(result);
  if (body && body._autoRouted) return { effect: "route", reason: "auto_routed", handlerReason: null };
  if (body && body.ok === false && body.preflightFailed === true) {
    return { effect: "deny", reason: `preflight:${body.errors?.[0]?.check ?? "unknown"}`, handlerReason: null };
  }
  const member = body ? [body.error, body.reason].find((c) => typeof c === "string" && ADMISSION_REASONS.has(c)) : undefined;
  if (member) return { effect: "deny", reason: member, handlerReason: null };
  if (body && body.ok === false) {
    const code = stableCode(body.reason) ?? stableCode(body.error) ?? "ok_false";
    return { effect: "allow", reason: null, handlerReason: code };
  }
  return { effect: "allow", reason: null, handlerReason: result?.isError ? "is_error" : null };
}

export async function decide(client, name, args) {
  try {
    return normaliseDecision(await client.callTool({ name, arguments: args }));
  } catch (err) {
    return normaliseDecision(null, { thrown: err });
  }
}

const SESSION_TOKEN_FILE_RE = /^([A-Za-z0-9-]+)\.json$/;

/** Basenames (with .json stripped) of the per-token session records under <root>/.rks/session/governor. */
export function governorSessionTokens(root) {
  if (!root) return [];
  let names = [];
  try { names = fs.readdirSync(path.join(root, ".rks", "session", "governor")); } catch { return []; }
  return names.map((n) => SESSION_TOKEN_FILE_RE.exec(n)?.[1] ?? null).filter(Boolean).sort();
}

/** A setup step failed: thrown out of replayCase as a test failure, never recorded as a decision (AC 8). */
export class SetupStepError extends Error {
  constructor(caseId, index, step, detail) {
    super(`replayCase ${caseId ?? "(case)"}: setup step ${index} (${step.tool}) failed: ${detail}`);
    this.name = "SetupStepError";
  }
}

/**
 * Replay one corpus case: its setup steps (tools/call only, starting with rks_governor_init), then
 * the case call. "$TOKEN" in args is replaced by the most recently minted token. Every minted session
 * is ended, every setup token as well as any `token` in the case call's own response body (an AC 5
 * rks_governor_init case): an exclusive session left live turns later cases into project_leased, and
 * a live story session would be resumed by a later case's init (ARCH v2 item 2).
 * agentCallCount, when given, returns the runAgent stub's current call count. agentCalls is the
 * difference across the CASE CALL only, so setup steps such as a PO research chain are not counted
 * (AC 10). Without a counter (the stdio transport) agentCalls is null.
 *
 * backlog.feat.admission-conformance-strict-baseline:
 * - AC 8: a setup step that fails throws SetupStepError (a test failure). A setup rks_governor_init
 *   fails when it throws, returns isError or ok: false, or returns no token; any other step fails when
 *   it throws or returns isError or ok: false, unless the step declares expectRefusal: true.
 * - AC 8: setupOnly replays the setup alone, then ends the latest setup session and returns the chain
 *   state rks_governor_end reports for it (governor-end.mjs: { ok, ended, flowType, state }).
 * - AC 9: root, when given, is the fixture root. The basenames under <root>/.rks/session/governor are
 *   snapshot before the case call and diffed after it; each new token (a server-minted session, such as
 *   the tokenless rks_agent_research self-bootstrap) is pushed onto sessionTokens and minted, so the
 *   finally block ends it. onSessionsDiscovered({ tokens, root }) is called while they are live, and
 *   onSessionsEnded({ tokens, root }) after the finally block has ended them.
 */
export async function replayCase(client, kase, { minted = [], agentCallCount = null, root = null, setupOnly = false, onSessionsDiscovered = null, onSessionsEnded = null } = {}) {
  let token = null;
  const sessionTokens = [];
  const discovered = [];
  const sub = (args) => JSON.parse(JSON.stringify(args ?? {}).replaceAll('"$TOKEN"', JSON.stringify(token)));
  try {
    for (const [index, step] of (kase.setup ?? []).entries()) {
      let res = null;
      try { res = await client.callTool({ name: step.tool, arguments: sub(step.args) }); } catch (err) {
        throw new SetupStepError(kase.id, index, step, `threw ${err?.code ?? ""} ${String(err?.message ?? err).slice(0, 200)}`);
      }
      const body = parseBody(res);
      if (step.tool === "rks_governor_init") {
        const minted1 = body?.token ?? null;
        if (typeof minted1 === "string" && minted1 !== "") { minted.push(minted1); if (!sessionTokens.includes(minted1)) sessionTokens.push(minted1); }
        if (res?.isError) throw new SetupStepError(kase.id, index, step, "returned isError");
        if (body?.ok === false) throw new SetupStepError(kase.id, index, step, `refused: ${String(body.reason ?? body.error ?? "ok_false")}`);
        if (typeof minted1 !== "string" || minted1 === "") throw new SetupStepError(kase.id, index, step, "returned no token");
        token = minted1;
        continue;
      }
      if (step.expectRefusal === true) continue;
      if (res?.isError) throw new SetupStepError(kase.id, index, step, "returned isError");
      if (body?.ok === false) throw new SetupStepError(kase.id, index, step, `returned ok: false (${String(body.reason ?? body.error ?? "no code").slice(0, 120)})`);
    }
    if (setupOnly) {
      if (!token) return { observedFlowType: null, observedState: null };
      const endBody = parseBody(await client.callTool({ name: "rks_governor_end", arguments: { projectId: FIXTURE_PROJECT_ID, _governorToken: token } }));
      if (endBody?.ended !== true) throw new Error(`replayCase ${kase.id}: rks_governor_end did not end the setup session (${JSON.stringify(endBody)?.slice(0, 200)})`);
      sessionTokens.splice(sessionTokens.indexOf(token), 1);
      return { observedFlowType: endBody.flowType ?? null, observedState: endBody.state ?? null };
    }
    const sessionsBefore = new Set(governorSessionTokens(root));
    const before = agentCallCount ? agentCallCount() : null;
    let result = null;
    let thrown = null;
    try { result = await client.callTool({ name: kase.tool, arguments: sub(kase.args) }); } catch (err) { thrown = err; }
    const agentCalls = agentCallCount ? agentCallCount() - before : null;
    const caseToken = thrown ? null : (parseBody(result)?.token ?? null);
    if (typeof caseToken === "string" && !sessionTokens.includes(caseToken)) { sessionTokens.push(caseToken); minted.push(caseToken); }
    for (const t of governorSessionTokens(root)) {
      if (sessionsBefore.has(t) || sessionTokens.includes(t)) continue;
      sessionTokens.push(t); minted.push(t); discovered.push(t);
    }
    if (discovered.length > 0) onSessionsDiscovered?.({ tokens: [...discovered], root });
    const decision = thrown ? normaliseDecision(null, { thrown }) : normaliseDecision(result);
    return { ...decision, agentCalls };
  } finally {
    for (const t of [...sessionTokens].reverse()) {
      try { await client.callTool({ name: "rks_governor_end", arguments: { projectId: FIXTURE_PROJECT_ID, _governorToken: t } }); } catch { /* repoLeaks reports anything left behind */ }
    }
    if (discovered.length > 0) onSessionsEnded?.({ tokens: [...discovered], root });
  }
}

/**
 * AC 13 (ARCH v2 item 2): every replay (each case, each client name, each transport) runs on its own
 * fresh makeFixtureRoot and its own server. A shared root is not repeatable: a second dendron_create_note
 * route throws "Note already exists" (server.mjs:557), autoRouteUnauthorized returns null (:358), and the
 * case flips from route to deny. onBoot, when given, is called with { root, transport } inside the case
 * env just before the server is booted.
 */
export async function replayOnFreshFixture(kase, { clientName, transport = "in-process", createServer = null, minted = [], agentCallCount = null, onBoot = null, setupOnly = false, onSessionsDiscovered = null, onSessionsEnded = null, sessionAudit = null } = {}) {
  const lanes = kase.lanesBlock === "absent" ? null : (kase.fixture?.lanes ?? "repo");
  const label = String(kase.id ?? "case").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
  const fixture = makeFixtureRoot({ lanes, label, branch: kase.fixture?.branch ?? null, worktreeChange: kase.fixture?.worktreeChange === true });
  const vars = { RKS_VIA: kase.lane, ...(kase.env ?? {}), ROUTEKIT_PROJECT_ROOT: fixture.root };
  const mintedBefore = minted.length;
  try {
    return await withCaseEnv(vars, async () => {
      // AC 15: onBoot sees the env the server will see: the stdio allowlist env, or (in-process, env null)
      // the process env it reads at createServer time.
      const env = transport === "stdio" ? stdioEnv({ root: fixture.root, home: fixture.root, via: vars.RKS_VIA, actor: vars.RKS_ACTOR }) : null;
      onBoot?.({ root: fixture.root, transport, env });
      const conn = transport === "stdio"
        ? await connectStdio({ env, cwd: fixture.root, clientName })
        : await connectInProcess(createServer, { clientName });
      try {
        return await replayCase(conn.client, kase, { minted, agentCallCount: transport === "stdio" ? null : agentCallCount, root: fixture.root, setupOnly, onSessionsDiscovered, onSessionsEnded });
      } finally {
        await conn.close();
      }
    });
  } finally {
    // backlog.feat.admission-conformance-hardening AC 5: audit the fixture's session files for every token
    // this replay minted, after its sessions were ended and its server closed, before the root is removed.
    if (Array.isArray(sessionAudit)) sessionAudit.push(auditFixtureSessions({ id: kase.id ?? null, transport, root: fixture.root, tokens: minted.slice(mintedBefore) }));
    fixture.cleanup();
  }
}

/**
 * backlog.feat.admission-conformance-hardening AC 5: the session files under <root>/.rks/session that still
 * mention any of tokens. A non-empty liveFiles means a minted session was left live in that fixture. It reads
 * the fixture directly, so it judges a stdio-minted token as well as an in-process one; it must run before
 * the fixture is removed.
 */
export function auditFixtureSessions({ id = null, transport = "in-process", root, tokens }) {
  const list = [...(tokens ?? [])];
  return { id, transport, root, tokens: list, liveFiles: sessionFilesMentioning(root, list) };
}

/** Files under <root>/.rks/session whose name or content contains any of the tokens. */
export function sessionFilesMentioning(root, tokens) {
  const hits = [];
  if (!tokens || tokens.length === 0) return hits;
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let body = "";
      try { body = fs.readFileSync(p, "utf8"); } catch { body = ""; }
      if (tokens.some((t) => e.name.includes(t) || body.includes(t))) hits.push(p);
    }
  };
  walk(path.join(root, ".rks", "session"));
  return hits;
}

/** AC 13: anything the suite left in the real repo. Empty means untouched. */
export function repoLeaks(minted) {
  const leaks = sessionFilesMentioning(REPO_ROOT, minted);
  for (const n of fs.readdirSync(path.join(REPO_ROOT, "notes"))) {
    if (CONFORMANCE_NOTE_PREFIXES.some((p) => n.startsWith(p))) leaks.push(path.join("notes", n));
  }
  return leaks;
}

export function loadCorpus() {
  return JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));
}

/** Read-modify-write one or more top-level corpus sections (UPDATE_ADMISSION_CORPUS=1 only). */
export function writeCorpusSections(sections) {
  let current = {};
  try { current = loadCorpus(); } catch { current = {}; }
  const next = {
    schemaVersion: 1,
    story: "backlog.feat.admission-conformance-suite",
    regenerateWith: "UPDATE_ADMISSION_CORPUS=1",
    anchor: current.anchor ?? null,
    cases: current.cases ?? [],
    hookOracle: current.hookOracle ?? [],
    anomalies: current.anomalies ?? [],
    ...sections,
  };
  fs.writeFileSync(CORPUS_PATH, JSON.stringify(next, null, 2) + "\n");
  return next;
}
