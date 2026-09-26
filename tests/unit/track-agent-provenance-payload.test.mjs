/**
 * backlog.fix.posttooluse-tool-response-provenance — end-to-end provenance proof.
 *
 * track-agent-provenance.mjs read `hookData.tool_result`, but Claude Code's PostToolUse
 * payload field is `tool_response`. The value was therefore ALWAYS undefined, so the
 * hook was a silent no-op: a path the research agent cited in sources[] never became
 * read provenance, and the sanctioned "route to Research, then read what it cited" loop
 * did not close.
 *
 * These tests spawn the CANONICAL hook (packages/hooks/**, the source of truth — never
 * the deployed copy, which guardrails-off relocates) as a subprocess against a fresh
 * temp project root. That isolation is the control that makes the proof meaningful:
 * session-state.mjs binds PROJECT_DIR at module load from ROUTEKIT_PROJECT_ROOT, so
 * ragSourcedPaths starts EMPTY and only this hook can populate it — the server-side
 * rks_rag_query chunk-hit registration path cannot mask the fix.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs tests/unit/track-agent-provenance-payload.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const HOOK = path.join(REPO_ROOT, 'packages', 'hooks', 'system', 'track-agent-provenance.mjs');

const CITED = 'packages/cli/src/rag/config.mjs';
const UNCITED = 'packages/cli/src/rag/embed.mjs';

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-')));
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Spawn the canonical hook with an isolated project root. */
function runHook(payload, { root = tmpRoot } = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      // session-state.mjs resolves this first; hook-output.mjs uses CLAUDE_PROJECT_DIR.
      ROUTEKIT_PROJECT_ROOT: root,
      CLAUDE_PROJECT_DIR: root,
    },
  });
  return res;
}

/** Read the isolated session state, or null if the hook never wrote one. */
function readState(root = tmpRoot) {
  const p = path.join(root, '.rks', 'session', 'state.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function grantedPaths(root = tmpRoot) {
  const state = readState(root);
  if (!state) return [];
  const raw = state.ragSourcedPaths;
  if (!raw) return [];
  // Entries are { path, query, timestamp } records.
  return (Array.isArray(raw) ? raw : Object.values(raw)).map((e) =>
    typeof e === 'string' ? e : String(e?.path ?? ''),
  );
}

/** A realistic rks_agent_research PostToolUse payload in the MCP envelope shape. */
function researchPayload({ sources, field = 'tool_response', answer = 'The loader resolves paths.' }) {
  const body = {
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__rks__rks_agent_research',
    tool_input: { query: 'how does rag config resolve paths' },
  };
  body[field] = {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, answer, sources }) }],
  };
  return body;
}

const CITED_SOURCES = [{ file: CITED, snippet: 'export function getRagPaths' }];

describe('payload contract: tool_response is the primary field', () => {
  it('PRIMARY: tool_response present and tool_result ABSENT registers the cited paths', () => {
    const res = runHook(researchPayload({ sources: CITED_SOURCES }));
    expect(res.status).toBe(0);

    const granted = grantedPaths();
    expect(granted.length).toBeGreaterThan(0);
    expect(granted.some((p) => p.includes('rag/config.mjs'))).toBe(true);
  });

  it('FALLBACK: only the legacy tool_result present still registers', () => {
    const res = runHook(researchPayload({ sources: CITED_SOURCES, field: 'tool_result' }));
    expect(res.status).toBe(0);
    expect(grantedPaths().some((p) => p.includes('rag/config.mjs'))).toBe(true);
  });

  it('NULLISH: a present-but-falsy tool_response does NOT fall through to tool_result', () => {
    // `??` semantics. With `||`, the empty response would be silently replaced by the
    // populated legacy field and the contract drift would stay hidden.
    const payload = researchPayload({ sources: CITED_SOURCES, field: 'tool_result' });
    payload.tool_response = '';

    const res = runHook(payload);
    expect(res.status).toBe(0);
    expect(grantedPaths()).toEqual([]);
  });
});

describe('end-to-end grant', () => {
  it('E2E: a cited path becomes rag_sourced provenance for a Read of its ABSOLUTE path', async () => {
    const res = runHook(researchPayload({ sources: CITED_SOURCES }));
    expect(res.status).toBe(0);
    expect(grantedPaths().length).toBeGreaterThan(0);

    // Resolve classification from the SAME isolated root. read-classification and
    // session-state both bind PROJECT_DIR at module load, so the env must be set
    // before the dynamic import and the module cache reset for the fresh binding.
    const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
    const prevDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.ROUTEKIT_PROJECT_ROOT = tmpRoot;
    process.env.CLAUDE_PROJECT_DIR = tmpRoot;
    try {
      vi.resetModules(); // PROJECT_DIR is bound at module load — force a fresh binding
      const { classifyReadIntent } = await import('../../packages/hooks/lib/read-classification.mjs');
      const absolute = path.join(tmpRoot, CITED);
      const decision = classifyReadIntent({
        targetPath: absolute,
        toolName: 'Read',
        toolInput: { file_path: absolute },
      });

      // Assert on the returned DECISION, not on hook source text.
      expect(decision).toBeTruthy();
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('rag_sourced');
      expect(decision.metadata?.matchedRule).toBe('ragSourcedPaths');
    } finally {
      if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
      else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
      if (prevDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prevDir;
    }
  });

  it('NORMALIZATION BOTH WAYS: an ABSOLUTE citation grants a repo-relative Read', async () => {
    // The mirror of the case above — session-state normalizePath and
    // read-classification pathMatches must agree in both directions.
    const absoluteCitation = path.join(tmpRoot, CITED);
    const res = runHook(
      researchPayload({ sources: [{ file: absoluteCitation, snippet: 's' }] }),
    );
    expect(res.status).toBe(0);
    expect(grantedPaths().length).toBe(1);

    const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
    const prevDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.ROUTEKIT_PROJECT_ROOT = tmpRoot;
    process.env.CLAUDE_PROJECT_DIR = tmpRoot;
    try {
      vi.resetModules();
      const { classifyReadIntent } = await import('../../packages/hooks/lib/read-classification.mjs');
      const decision = classifyReadIntent({
        targetPath: CITED, // repo-relative
        toolName: 'Read',
        toolInput: { file_path: CITED },
      });
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('rag_sourced');
    } finally {
      if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
      else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
      if (prevDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prevDir;
    }
  });

  it('ISOLATION: the granted set equals EXACTLY the cited set', () => {
    // Proves no server-side chunk-hit registration can contribute — the temp root
    // starts empty and only this hook writes to it.
    expect(grantedPaths()).toEqual([]);

    runHook(researchPayload({ sources: CITED_SOURCES }));

    const granted = grantedPaths();
    expect(granted).toHaveLength(1);
    expect(granted[0]).toContain('rag/config.mjs');
  });

  it('NEGATIVE: an uncited sibling path is not granted', async () => {
    runHook(researchPayload({ sources: CITED_SOURCES }));

    const granted = grantedPaths();
    expect(granted.some((p) => p.includes('rag/embed.mjs'))).toBe(false);
    expect(granted.some((p) => p.includes(UNCITED))).toBe(false);
  });

  it('NEGATIVE: prose mentioning file-like strings grants nothing when sources[] is empty', () => {
    const res = runHook(
      researchPayload({
        sources: [],
        answer: `See packages/cli/src/rag/config.mjs and packages/rag/src/embed.mjs for details.`,
      }),
    );
    expect(res.status).toBe(0);
    // Provenance is never scraped out of prose — hallucinated paths must not be granted.
    expect(grantedPaths()).toEqual([]);
  });
});

describe('shape handling', () => {
  it('ENVELOPE: the MCP content[] -> text -> JSON.parse unwrap still works on tool_response', () => {
    const res = runHook(researchPayload({ sources: CITED_SOURCES }));
    expect(res.status).toBe(0);
    expect(grantedPaths().length).toBe(1);
  });

  it('PO STRING-ARRAY shape still registers', () => {
    const res = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__rks__rks_agent_research',
      tool_input: {},
      tool_response: { content: [{ type: 'text', text: JSON.stringify({ ok: true, sources: [CITED] }) }] },
    });
    expect(res.status).toBe(0);
    expect(grantedPaths().some((p) => p.includes('rag/config.mjs'))).toBe(true);
  });

  it('FAIL-OPEN: malformed payloads grant nothing, do not throw, and exit 0', () => {
    const malformed = [
      { tool_response: { content: [{ type: 'text', text: 'not json{{{' }] } },
      { tool_response: null },
      { tool_response: 42 },
      { tool_response: [1, 2, 3] },
    ];
    for (const extra of malformed) {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-mal-')));
      try {
        const res = runHook(
          { hook_event_name: 'PostToolUse', tool_name: 'mcp__rks__rks_agent_research', tool_input: {}, ...extra },
          { root },
        );
        expect(res.status, `payload ${JSON.stringify(extra)} must exit 0`).toBe(0);
        expect(grantedPaths(root)).toEqual([]);
      } finally {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  });
});

describe('LOUD FAILURE — the silence was the defect', () => {
  function telemetryRecords(root = tmpRoot) {
    const p = path.join(root, '.routekit', 'telemetry', 'guardrails.log');
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  it('a handled tool with NEITHER field emits stderr + telemetry naming key names only', () => {
    const res = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__rks__rks_agent_research',
      tool_input: { query: 'x' },
      // deliberately no tool_response and no tool_result
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/Unrecognized PostToolUse payload/);

    const records = telemetryRecords().filter((r) => r.event === 'hook.payload_shape_unknown');
    expect(records.length).toBeGreaterThan(0);
    const rec = records.at(-1);
    expect(rec.hook).toBe('track-agent-provenance');
    expect(rec.tool_name).toContain('rks_agent_research');
    expect(rec.keys).toEqual(expect.arrayContaining(['tool_input', 'tool_name']));
  });

  it('an unrecognized parsed shape emits the same telemetry and grants nothing', () => {
    const res = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__rks__rks_agent_research',
      tool_input: {},
      // Parses fine, but exposes no sources[] and no path array.
      tool_response: { content: [{ type: 'text', text: JSON.stringify({ ok: true, answer: 'no citations' }) }] },
    });

    expect(res.status).toBe(0);
    expect(grantedPaths()).toEqual([]);
    const records = telemetryRecords().filter((r) => r.event === 'hook.payload_shape_unknown');
    expect(records.length).toBeGreaterThan(0);
  });

  it('NO SECRET LEAKAGE: the diagnostic carries key names, never payload values', () => {
    const SECRET = 'sk-ant-THIS-MUST-NEVER-APPEAR';
    const res = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__rks__rks_agent_research',
      tool_input: { query: SECRET },
      tool_response: { content: [{ type: 'text', text: JSON.stringify({ ok: true, answer: SECRET }) }] },
    });

    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain(SECRET);

    const raw = (() => {
      const p = path.join(tmpRoot, '.routekit', 'telemetry', 'guardrails.log');
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    })();
    expect(raw).not.toContain(SECRET);
  });
});
