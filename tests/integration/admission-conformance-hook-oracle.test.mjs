// backlog.feat.admission-conformance-suite
// backlog.feat.admission-conformance-strict-baseline (AC 14: hookOracle key uniqueness)
// Hook oracle (AC 8): the four mcp__rks__* PreToolUse hooks run as subprocesses, decisions recorded in the corpus.
// The hookOracle section of tests/integration/fixtures/admission-conformance.corpus.json is regenerated only
// with UPDATE_ADMISSION_CORPUS=1; this file rewrites that section alone and leaves the server cases untouched.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalHookPath } from "../helpers/hook-path.mjs";
import { loadCorpus, writeCorpusSections, FIXTURE_PROJECT_ID, REPO_ROOT, CORPUS_PATH } from "../helpers/admission-conformance.mjs";

// AC 15: per-spawn bound plus an explicit per-it timeout (the mock tier has no testTimeout).
const HOOK_TIMEOUT_MS = 120_000;
const ORACLE_TIMEOUT_MS = 600_000;

const UPDATE_CORPUS = process.env.UPDATE_ADMISSION_CORPUS === "1";
// backlog.feat.admission-conformance-hardening AC 8: this file's own start-of-run capture of the corpus bytes,
// compared at the end of a normal run. A guard against a future write: today the corpus is written here only
// under UPDATE_ADMISSION_CORPUS=1.
const corpusBytesAtStart = fs.existsSync(CORPUS_PATH) ? fs.readFileSync(CORPUS_PATH) : null;

// canonicalHookPath, never resolveHookByName: off-rail the latter resolves .routekit/hooks.bak,
// whose relative imports are broken (tests/helpers/hook-path.mjs:44-47, :79).
const HOOKS = Object.freeze({
  "redirect-validate-story-to-agent": "write/redirect-validate-story-to-agent.mjs",
  "redirect-git-tools-to-agent": "write/redirect-git-tools-to-agent.mjs",
  "redirect-dendron-tools-to-agent": "write/redirect-dendron-tools-to-agent.mjs",
  "redirect-rag-tools-to-agent": "read/redirect-rag-tools-to-agent.mjs",
});
const CREDENTIAL_STATES = Object.freeze(["keyless", "keyed"]);
const TOKEN_STATES = Object.freeze(["absent", "present", "invalid"]);
const TOKEN_VALUES = Object.freeze({ present: "00000000-0000-4000-8000-000000000000", invalid: "admission-conformance-not-a-live-token" });
const MCP_PREFIX = "mcp__rks__";

// Hermetic hook env (AC 8): an allowlist, never a spread of process.env. RKS_GUARDRAILS is absent.
function hookEnv(projectDir, credential) {
  const env = { PATH: process.env.PATH ?? "", HOME: projectDir, CLAUDE_PROJECT_DIR: projectDir };
  if (credential === "keyed") env.ANTHROPIC_API_KEY = "sk-ant-admission-conformance-dummy";
  return env;
}

function makeHookProjectDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "admission-conformance-hook-")));
}

function runHook(hookName, payload, { projectDir, credential }) {
  const hookPath = canonicalHookPath(HOOKS[hookName], REPO_ROOT);
  return spawnSync(process.execPath, [hookPath], { input: JSON.stringify(payload), env: hookEnv(projectDir, credential), cwd: projectDir, encoding: "utf8", timeout: HOOK_TIMEOUT_MS });
}

/** pass: exit 0 and empty stdout. redirect: a deny carrying a REDIRECT ORDER. deny: any other refusal. */
function classifyHook(r) {
  if (r.error) throw r.error;
  const stdout = (r.stdout ?? "").trim();
  if (r.status === 0 && stdout === "") return "pass";
  if (r.status === 2) return "deny";
  let out = null;
  try { out = JSON.parse(stdout); } catch { return `unparsed:${r.status}`; }
  const hso = out?.hookSpecificOutput ?? {};
  if (hso.permissionDecision === "deny") return String(hso.additionalContext ?? "").includes("REDIRECT ORDER") ? "redirect" : "deny";
  if (out?.decision === "block") return "deny";
  return r.status === 0 ? "pass" : `status:${r.status}`;
}

function payloadFor(tool, token, projectDir) {
  const toolInput = { projectId: FIXTURE_PROJECT_ID, filename: "research.conformance.hook-oracle", q: "fixture", message: "admission conformance" };
  if (token !== "absent") toolInput._governorToken = TOKEN_VALUES[token];
  return { session_id: "admission-conformance", hook_event_name: "PreToolUse", cwd: projectDir, tool_name: `${MCP_PREFIX}${tool}`, tool_input: toolInput };
}

/** The registered PreToolUse matcher of each of the four hooks, split into bare tool names. */
function registeredMatchers() {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".claude", "settings.json"), "utf8"));
  const out = {};
  for (const entry of settings.hooks?.PreToolUse ?? []) {
    for (const h of entry.hooks ?? []) {
      for (const [name, rel] of Object.entries(HOOKS)) {
        if (String(h.command ?? "").includes(`/${rel}`)) {
          out[name] = [...new Set([...(out[name] ?? []), ...String(entry.matcher).split("|")])];
        }
      }
    }
  }
  for (const name of Object.keys(out)) {
    for (const m of out[name]) expect(m.startsWith(MCP_PREFIX), m).toBe(true);
    out[name] = out[name].map((m) => m.slice(MCP_PREFIX.length)).sort();
  }
  return out;
}

function computeOracle() {
  const matchers = registeredMatchers();
  const entries = [];
  const projectDir = makeHookProjectDir();
  try {
    for (const hook of Object.keys(HOOKS)) {
      for (const tool of matchers[hook] ?? []) {
        for (const token of TOKEN_STATES) {
          for (const credential of CREDENTIAL_STATES) {
            const decision = classifyHook(runHook(hook, payloadFor(tool, token, projectDir), { projectDir, credential }));
            entries.push({ hook, tool, token, credential, decision });
          }
        }
      }
    }
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
  return entries;
}

beforeAll(() => {
  if (UPDATE_CORPUS) writeCorpusSections({ hookOracle: computeOracle() });
}, ORACLE_TIMEOUT_MS);

describe("AC8 hook oracle", () => {
  it("every matcher tool, tokenless and with a token, yields the recorded hook decision", () => {
    const { hookOracle } = loadCorpus();
    expect(hookOracle.length).toBeGreaterThan(0);
    for (const name of Object.keys(HOOKS)) expect(fs.existsSync(canonicalHookPath(HOOKS[name], REPO_ROOT)), name).toBe(true);
    const live = computeOracle();
    const key = (e) => `${e.hook}|${e.tool}|${e.token}|${e.credential}`;
    const recorded = new Map(hookOracle.map((e) => [key(e), e.decision]));
    const differences = [];
    for (const e of live) {
      if (!recorded.has(key(e))) differences.push(`not recorded: ${key(e)}`);
      else if (recorded.get(key(e)) !== e.decision) differences.push(`${key(e)}: recorded ${recorded.get(key(e))}, observed ${e.decision}`);
    }
    expect(live.length).toBe(hookOracle.length);
    expect(differences).toEqual([]);
    // Both token states and both credential states are pinned for every (hook, tool).
    for (const e of hookOracle) {
      for (const token of ["absent", "present"]) {
        for (const credential of CREDENTIAL_STATES) expect(recorded.has(key({ ...e, token, credential })), key({ ...e, token, credential })).toBe(true);
      }
      expect(["pass", "deny", "redirect"], key(e)).toContain(e.decision);
    }
  }, ORACLE_TIMEOUT_MS);

  // backlog.feat.admission-conformance-strict-baseline AC 14.
  it("each hook|tool|token|credential key appears once in hookOracle", () => {
    const { hookOracle } = loadCorpus();
    expect(hookOracle.length).toBeGreaterThan(0);
    const key = (e) => `${e.hook}|${e.tool}|${e.token}|${e.credential}`;
    const keys = hookOracle.map(key);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
    expect(new Set(keys).size).toBe(hookOracle.length);
    // Positive control: the check reports a repeated key.
    const doubled = [...hookOracle, hookOracle[0]].map(key);
    expect(doubled.filter((k, i) => doubled.indexOf(k) !== i)).toEqual([key(hookOracle[0])]);
  }, ORACLE_TIMEOUT_MS);

  it("registered PreToolUse matcher strings equal the tool sets the oracle covers", () => {
    const { hookOracle } = loadCorpus();
    const matchers = registeredMatchers();
    expect(Object.keys(matchers).sort()).toEqual(Object.keys(HOOKS).sort());
    for (const hook of Object.keys(HOOKS)) {
      const covered = [...new Set(hookOracle.filter((e) => e.hook === hook).map((e) => e.tool))].sort();
      expect(covered, hook).toEqual(matchers[hook]);
    }
  }, ORACLE_TIMEOUT_MS);

  it("redirect-git-tools-to-agent passes on a supplied-but-invalid token", () => {
    const { hookOracle } = loadCorpus();
    const gitTools = registeredMatchers()["redirect-git-tools-to-agent"];
    expect(gitTools.length).toBeGreaterThan(0);
    const projectDir = makeHookProjectDir();
    try {
      for (const tool of gitTools) {
        for (const credential of CREDENTIAL_STATES) {
          const rec = hookOracle.find((e) => e.hook === "redirect-git-tools-to-agent" && e.tool === tool && e.token === "invalid" && e.credential === credential);
          expect(rec?.decision, `${tool} ${credential}`).toBe("pass");
          const r = runHook("redirect-git-tools-to-agent", payloadFor(tool, "invalid", projectDir), { projectDir, credential });
          expect(r.status, tool).toBe(0);
          expect((r.stdout ?? "").trim(), tool).toBe("");
          // Positive control: the same call without a token is redirected, so the pass is the token's doing.
          const tokenless = runHook("redirect-git-tools-to-agent", payloadFor(tool, "absent", projectDir), { projectDir, credential });
          expect(classifyHook(tokenless), tool).toBe("redirect");
        }
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }, ORACLE_TIMEOUT_MS);

  // Runs last in this file, so it covers every test above in a normal run.
  it("a normal run leaves the corpus byte-identical", () => {
    if (UPDATE_CORPUS) {
      expect(fs.existsSync(CORPUS_PATH)).toBe(true);
      return;
    }
    expect(corpusBytesAtStart, "corpus must exist for a normal run").not.toBeNull();
    expect(corpusBytesAtStart.length).toBeGreaterThan(0);
    expect(Buffer.compare(fs.readFileSync(CORPUS_PATH), corpusBytesAtStart)).toBe(0);
    // Positive control: the comparison reports a one-byte difference.
    const altered = Buffer.from(corpusBytesAtStart);
    altered[0] = altered[0] ^ 0xff;
    expect(Buffer.compare(altered, corpusBytesAtStart)).not.toBe(0);
  }, HOOK_TIMEOUT_MS);
});
