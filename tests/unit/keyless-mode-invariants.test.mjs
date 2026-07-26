/**
 * backlog.feat.keyless-mode-enforcement — invariant property suite (SECURITY)
 *
 * Table/adversarial witnesses for the 5 safety invariants of keyless mode. Key state is set/deleted
 * EXPLICITLY per case (never ambient) — the CI unit job runs keyless, so relying on ambient env
 * could not exercise the key-present branch and would leak state.
 *
 *  INV-1 retrieval-only ceiling   — keyless: rks_rag_query ALLOWED; every other tool still redirects.
 *  INV-2 read boundary preserved  — (covered by the messaging-only hook changes; decision unchanged).
 *  INV-3 no read scope-escape     — keyless rag runs tokenless → L2 (asserted at query.mjs level elsewhere).
 *  INV-4 bounded write            — keyless: keyless-notes.* ALLOWED; every other path DENIED, incl.
 *                                   the symlink / absolute-anchor / traversal / prefix-confusion escapes.
 *  INV-5 fail-closed / no-drift   — ambiguous → governed; ONE shared isKeyless / isKeylessNotesTarget.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

import { isKeyless, hasLlmCredential } from "../../packages/hooks/system/credential-presence.mjs";
import { isKeylessNotesTarget } from "../../packages/hooks/system/hook-output.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOKS = path.join(repoRoot, "packages", "hooks");

let proj; // temp project with notes/, a real keyless-notes file, and a planted leaf symlink
let otherProj; // a second repo root (for the out-of-repo absolute-anchor case)

beforeAll(() => {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), "keyless-proj-"));
  fs.mkdirSync(path.join(proj, "notes"), { recursive: true });
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(proj, "decoy.txt"), "out-of-namespace target");
  fs.writeFileSync(path.join(proj, "notes", "keyless-notes.exists.md"), "real flat file");
  // Planted LEAF symlink inside notes/ pointing OUT of the namespace — the core write-escape vector.
  fs.symlinkSync(path.join("..", "decoy.txt"), path.join(proj, "notes", "keyless-notes.link.md"));

  otherProj = fs.mkdtempSync(path.join(os.tmpdir(), "keyless-other-"));
  fs.mkdirSync(path.join(otherProj, "notes"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(otherProj, { recursive: true, force: true });
});

// ── Env / hook-spawn harness ──────────────────────────────────────────────────────────────────
function envFor(keyState, projectDir) {
  const base = { ...process.env };
  delete base.ANTHROPIC_API_KEY;
  delete base.OPENAI_API_KEY;
  delete base.RKS_GUARDRAILS; // never guardrails-off in these witnesses
  if (keyState === "anthropic") base.ANTHROPIC_API_KEY = "sk-ant-test-not-real";
  if (keyState === "openai") base.OPENAI_API_KEY = "sk-openai-test-not-real";
  base.CLAUDE_PROJECT_DIR = projectDir;
  return base;
}

function runHook(hookRelPath, hookInput, keyState, projectDir = proj) {
  return spawnSync(process.execPath, [path.join(HOOKS, hookRelPath)], {
    input: JSON.stringify(hookInput),
    env: envFor(keyState, projectDir),
    encoding: "utf8",
    timeout: 15000, // subprocess-timeout guard
  });
}

// Redirect hooks: exit 0 + empty stdout = allow; exit 0 + deny JSON = redirect/deny.
const isRedirectAllow = (r) => r.status === 0 && String(r.stdout || "").trim() === "";
const isRedirectDeny = (r) => r.status === 0 && /"permissionDecision"\s*:\s*"deny"/.test(String(r.stdout || ""));
// enforce-dendron-note-creation: exit 0 = allow, exit 2 = block.
const isEnforceAllow = (r) => r.status === 0;
const isEnforceBlock = (r) => r.status === 2;

// ── INV-5 activation authority (pure) ─────────────────────────────────────────────────────────
describe("INV-5 activation: isKeyless keys off credential-KEY absence, fail-closed", () => {
  it("keyless when NO recognized key is present (bare clone / provider=null; or provider set, key absent)", () => {
    expect(isKeyless({})).toBe(true);
    expect(hasLlmCredential({})).toBe(false);
    expect(isKeyless({ ROUTEKIT_LLM_PROVIDER: "anthropic" })).toBe(true); // provider resolved, key absent
    expect(isKeyless({ ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" })).toBe(true); // empty = absent
  });
  it("NOT keyless when any recognized key is present", () => {
    expect(isKeyless({ ANTHROPIC_API_KEY: "sk-x" })).toBe(false);
    expect(isKeyless({ OPENAI_API_KEY: "sk-x" })).toBe(false);
    expect(isKeyless({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b" })).toBe(false);
  });
  it("fail-closed: ambiguous env → governed (NOT keyless)", () => {
    expect(isKeyless(null)).toBe(false);
    expect(hasLlmCredential(null)).toBe(true);
  });
});

// ── INV-4 predicate (pure, realpath-anchored, adversarial) ──────────────────────────────────────
describe("INV-4 isKeylessNotesTarget: realpath-anchored, absolute, fail-closed", () => {
  it("ALLOWS a flat keyless-notes.*.md directly under PROJECT/notes (dot-prefix boundary)", () => {
    expect(isKeylessNotesTarget("notes/keyless-notes.evil.md", proj)).toBe(true);
    expect(isKeylessNotesTarget(path.join(proj, "notes", "keyless-notes.evil.md"), proj)).toBe(true);
    expect(isKeylessNotesTarget("notes/keyless-notes.exists.md", proj)).toBe(true); // overwrite real file
  });
  it("DENIES prefix-confusion (hyphen, not the dendron dot-prefix)", () => {
    expect(isKeylessNotesTarget("notes/keyless-notes-evil.md", proj)).toBe(false);
  });
  it("DENIES wrong directory / repo-root ambiguity", () => {
    expect(isKeylessNotesTarget("src/keyless-notes.foo.md", proj)).toBe(false);
    expect(isKeylessNotesTarget("keyless-notes.md", proj)).toBe(false); // repo-root file_path, not a bare name
    expect(isKeylessNotesTarget("foo/notes/keyless-notes.x.md", proj)).toBe(false); // nested wrong dir
  });
  it("DENIES an out-of-repo absolute path that contains notes/keyless-notes.<x>.md", () => {
    expect(isKeylessNotesTarget(path.join(otherProj, "notes", "keyless-notes.x.md"), proj)).toBe(false);
  });
  it("DENIES lexical path-traversal", () => {
    expect(isKeylessNotesTarget("notes/keyless-notes.x/../evil.md", proj)).toBe(false);
    expect(isKeylessNotesTarget("notes/keyless-notes.../../src/server.mjs", proj)).toBe(false);
  });
  it("DENIES a planted LEAF symlink whose target is outside notes/ (core write-escape)", () => {
    expect(isKeylessNotesTarget("notes/keyless-notes.link.md", proj)).toBe(false);
    expect(isKeylessNotesTarget(path.join(proj, "notes", "keyless-notes.link.md"), proj)).toBe(false);
  });
  it("bare dendron name (dendron_create_note filename): ALLOWS keyless-notes.foo, DENIES separators/traversal", () => {
    expect(isKeylessNotesTarget("keyless-notes.foo", proj)).toBe(true);
    expect(isKeylessNotesTarget("keyless-notes.x/../evil", proj)).toBe(false);
    expect(isKeylessNotesTarget("keyless-notes-evil", proj)).toBe(false);
  });
  it("fail-closed on non-string / empty", () => {
    for (const bad of [undefined, null, "", 123, {}]) expect(isKeylessNotesTarget(bad, proj)).toBe(false);
  });
});

// ── INV-1 retrieval-only ceiling (real hook) ────────────────────────────────────────────────────
describe("INV-1 redirect-rag-tools-to-agent: keyless rag_query ALLOW, everything else redirects", () => {
  const rag = { tool_name: "mcp__rks__rks_rag_query", tool_input: { q: "how does preflight work?" } };
  const kg = { tool_name: "mcp__rks__rks_kg_query", tool_input: { query: "x" } };

  it("keyless: rks_rag_query is ALLOWED (exit 0, empty stdout)", () => {
    expect(isRedirectAllow(runHook("read/redirect-rag-tools-to-agent.mjs", rag, "absent"))).toBe(true);
  });
  it("keyless: rks_kg_query still REDIRECTS (ceiling — only rag opens)", () => {
    expect(isRedirectDeny(runHook("read/redirect-rag-tools-to-agent.mjs", kg, "absent"))).toBe(true);
  });
  it("key present: rks_rag_query REDIRECTS (byte-identical keyed behavior)", () => {
    expect(isRedirectDeny(runHook("read/redirect-rag-tools-to-agent.mjs", rag, "anthropic"))).toBe(true);
    expect(isRedirectDeny(runHook("read/redirect-rag-tools-to-agent.mjs", rag, "openai"))).toBe(true);
  });
});

// ── INV-4 bounded write (real hooks) ────────────────────────────────────────────────────────────
describe("INV-4 redirect-edit-to-governor: keyless keyless-notes.* ALLOW, all else DENY, key-present byte-identical", () => {
  const write = (fp) => ({ tool_name: "Write", tool_input: { file_path: fp } });
  // Lazy thunks — `proj` is only assigned in the top-level beforeAll, so building these paths in the
  // describe body (collection time) would join an undefined `proj`. Resolve them inside each it().
  const notesOk = () => path.join(proj, "notes", "keyless-notes.demo.md");
  const symlink = () => path.join(proj, "notes", "keyless-notes.link.md");
  const code = () => path.join(proj, "src", "foo.ts");

  it("keyless: Write to notes/keyless-notes.*.md is ALLOWED", () => {
    expect(isRedirectAllow(runHook("write/redirect-edit-to-governor.mjs", write(notesOk()), "absent"))).toBe(true);
  });
  it("keyless: Write to a planted keyless-notes symlink is DENIED (write-escape closed)", () => {
    expect(isRedirectDeny(runHook("write/redirect-edit-to-governor.mjs", write(symlink()), "absent"))).toBe(true);
  });
  it("keyless: Write to code is DENIED (redirect)", () => {
    expect(isRedirectDeny(runHook("write/redirect-edit-to-governor.mjs", write(code()), "absent"))).toBe(true);
  });
  it("key present: Write to keyless-notes.* is DENIED (no keyless branch fires)", () => {
    expect(isRedirectDeny(runHook("write/redirect-edit-to-governor.mjs", write(notesOk()), "anthropic"))).toBe(true);
  });
});

describe("INV-4 enforce-dendron-note-creation: keyless keyless-notes.* ALLOW, other notes BLOCK, key-present BLOCK", () => {
  const write = (fp) => ({ tool_name: "Write", tool_input: { file_path: fp } });
  // Lazy thunks — see note above; resolve paths inside each it() after beforeAll assigns `proj`.
  const notesOk = () => path.join(proj, "notes", "keyless-notes.demo.md");
  const otherNote = () => path.join(proj, "notes", "backlog.foo.md");

  it("keyless: raw Write to keyless-notes.*.md is ALLOWED (exit 0, not blocked)", () => {
    expect(isEnforceAllow(runHook("read/enforce-dendron-note-creation.mjs", write(notesOk()), "absent"))).toBe(true);
  });
  it("keyless: raw Write to another notes namespace is BLOCKED (exit 2)", () => {
    expect(isEnforceBlock(runHook("read/enforce-dendron-note-creation.mjs", write(otherNote()), "absent"))).toBe(true);
  });
  it("key present: raw Write to keyless-notes.*.md is BLOCKED (byte-identical keyed behavior)", () => {
    expect(isEnforceBlock(runHook("read/enforce-dendron-note-creation.mjs", write(notesOk()), "anthropic"))).toBe(true);
  });
});
