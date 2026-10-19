// backlog.fix.provenance-hook-silent-exit-instrumentation
//
// Guards the two changes that make track-agent-provenance.mjs stop failing
// silently:
//
//   AC-A  an unconditional entry heartbeat, so "the hook minted nothing" is no
//         longer observationally identical to "the hook never ran"
//   AC-B  readStdin decoding ONCE, so a multi-byte character straddling a chunk
//         boundary is not corrupted
//
// WHAT THIS DOES NOT PROVE. Like every other test that spawns this hook, it
// hand-builds the payload it feeds in. It therefore proves the hook behaves
// correctly GIVEN a payload of that shape — never that the real Claude Code
// harness delivers that shape, and never that the hook is dispatched at all.
// Confirming a real heartbeat requires observing telemetry after a live MCP
// restart. Do not cite a green run here as evidence the provenance bridge works.
//
// Spawns the CANONICAL hook under packages/hooks/ — never the deployed copy,
// which guardrails-off relocates. Same precedent as
// track-agent-provenance-payload.test.mjs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const HOOK = path.join(REPO_ROOT, 'packages', 'hooks', 'system', 'track-agent-provenance.mjs');

const AGENT_TOOL = 'mcp__rks__rks_agent_research';

// SHA-256 of the brace-balanced extractAgentResult body.
//
// RECOMPUTED by backlog.fix.extract-agent-result-harness-shape after the bare-array
// branch landed. The previous value (133371cb…) pinned the pre-fix body and its
// message said "INSTRUMENTATION ONLY" — that gate has been discharged: live
// telemetry proved the hook runs and receives a payload, so changing the extractor
// is evidence-backed rather than speculative.
//
// The pin STAYS because the extractor is still the most consequential function in
// this file and a silent change to it is how the original defect survived. Update
// it deliberately, in a story that carries evidence — never to make a red run green.
const EXTRACT_AGENT_RESULT_SHA =
  '88515f715bea2be3b22d6bb043065bce4fc5f66b40aaa07f66fea30d2420674b';

let tmpRoot;

beforeEach(() => {
  // realpath matters on macOS (/var → /private/var) — the hook realpath-compares.
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-')));
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * Spawn the canonical hook, writing stdin in the given chunks.
 *
 * Async spawn rather than spawnSync because spawnSync's `input` hands the whole
 * buffer over as one blob — it cannot control chunk boundaries, which is exactly
 * what AC-B needs to exercise.
 */
function runHook(chunks, { root = tmpRoot, chunkDelayMs = 0 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [HOOK], {
      cwd: root,
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // session-state.mjs resolves this one; hook-output.mjs uses CLAUDE_PROJECT_DIR
        // to place .routekit/telemetry/guardrails.log. Both are module-load-time
        // bindings in the child, so they must be set here, at spawn.
        ROUTEKIT_PROJECT_ROOT: root,
        CLAUDE_PROJECT_DIR: root,
      },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    // chunkDelayMs must be a REAL timer, not setImmediate. setImmediate only
    // yields the PARENT's event loop: both writes then sit in the pipe buffer and
    // the child — which has not finished booting — reads them as ONE coalesced
    // chunk, so no boundary is ever split. Verified empirically: with setImmediate
    // the AC-B test passed against the OLD, broken readStdin.
    //
    // The leading delay lets the child boot and start reading before the first
    // write; the inter-chunk delay guarantees the first chunk is consumed as its
    // own read before the second arrives.
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    (async () => {
      if (chunkDelayMs) await wait(chunkDelayMs);
      for (let i = 0; i < chunks.length; i += 1) {
        if (i > 0 && chunkDelayMs) await wait(chunkDelayMs);
        proc.stdin.write(chunks[i]);
      }
      proc.stdin.end();
    })();

    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

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

// Full ragSourcedPaths records — the existing helpers elsewhere return paths only,
// and `query` is the load-bearing field here: the `agent:` prefix is the ONLY thing
// distinguishing a hook mint from a server-side RAG mint.
function sessionRagSourcedPaths(root = tmpRoot) {
  const p = path.join(root, '.rks', 'session', 'state.json');
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')).ragSourcedPaths || [];
  } catch { return []; }
}

const heartbeats = (root = tmpRoot) =>
  telemetryRecords(root).filter((r) => r.event === 'hook.provenance_heartbeat');

const stageOf = (stage, root = tmpRoot) => heartbeats(root).find((r) => r.stage === stage);

describe('AC-A — unconditional entry heartbeat', () => {
  it('records an entry heartbeat even when stdin is empty', async () => {
    // Mutation that reddens this: move recordHeartbeat({stage:'entry'}) below the
    // `if (!raw)` exit. The empty-stdin path then leaves no trace again.
    const res = await runHook([]);

    expect(res.code).toBe(0);
    expect(stageOf('entry')).toBeTruthy();
    expect(stageOf('exit_stdin_empty')).toMatchObject({ raw_length: 0 });
  });

  it('records a heartbeat when stdin is unparseable, without leaking payload text', async () => {
    const garbage = 'not json at all {{{ SECRET_TOKEN=hunter2';
    const res = await runHook([Buffer.from(garbage, 'utf8')]);

    expect(res.code).toBe(0);

    const rec = stageOf('exit_stdin_unparseable');
    expect(rec).toBeTruthy();
    expect(rec.raw_length).toBe(garbage.length);

    // Length only — the raw text must never reach telemetry.
    const raw = fs.readFileSync(
      path.join(tmpRoot, '.routekit', 'telemetry', 'guardrails.log'),
      'utf8',
    );
    expect(raw).not.toContain('SECRET_TOKEN');
    expect(raw).not.toContain('hunter2');
  });

  it('records sorted top-level key NAMES and the observed tool fields', async () => {
    // Keys are deliberately NOT in alphabetical insertion order, so a missing
    // .sort() in the hook fails this rather than passing by luck.
    const payload = {
      tool_response: { sources: [] },
      hook_event_name: 'PostToolUse',
      tool_name: AGENT_TOOL,
      answer_secret: 'must-not-appear',
    };
    await runHook([Buffer.from(JSON.stringify(payload), 'utf8')]);

    const rec = stageOf('payload_received');
    expect(rec).toBeTruthy();
    expect(rec.keys).toEqual(
      ['answer_secret', 'hook_event_name', 'tool_name', 'tool_response'],
    );
    expect(rec.tool_name).toBe(AGENT_TOOL);
    expect(rec.tool_name_present).toBe(true);
    expect(rec.tool_present).toBe(false);

    // KEY NAMES ONLY — the value behind answer_secret must never be emitted.
    const raw = fs.readFileSync(
      path.join(tmpRoot, '.routekit', 'telemetry', 'guardrails.log'),
      'utf8',
    );
    expect(raw).not.toContain('must-not-appear');
  });

  it('distinguishes the two tool-gate exits that used to look identical', async () => {
    // Neither tool_name nor tool present → contract drift, toolName === "".
    await runHook([Buffer.from(JSON.stringify({ hook_event_name: 'PostToolUse' }), 'utf8')]);

    const drift = stageOf('exit_not_agent_tool');
    expect(drift).toBeTruthy();
    expect(drift.tool_name).toBeNull();
    expect(stageOf('payload_received')).toMatchObject({
      tool_name_present: false,
      tool_present: false,
    });
  });

  it('records a real but non-agent tool name at the gate', async () => {
    await runHook([Buffer.from(JSON.stringify({ tool_name: 'Read' }), 'utf8')]);

    expect(stageOf('exit_not_agent_tool')).toMatchObject({ tool_name: 'Read' });
  });

  it('survives a telemetry sink that cannot be written', async () => {
    // AC-A5: heartbeat writes are best-effort and must never throw out of main().
    // A read-only project dir makes every appendTelemetry fail.
    const locked = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-ro-')));
    fs.chmodSync(locked, 0o500);
    try {
      const res = await runHook(
        [Buffer.from(JSON.stringify({ tool_name: 'Read' }), 'utf8')],
        { root: locked },
      );
      expect(res.code).toBe(0);
    } finally {
      fs.chmodSync(locked, 0o700);
      fs.rmSync(locked, { recursive: true, force: true });
    }
  });
});

describe('AC-B — stdin decoded once, not per chunk', () => {
  it('preserves a multi-byte character split across a chunk boundary', async () => {
    // THE OBSERVABLE IS ROUND-TRIP BYTE FIDELITY, not "does not throw".
    //
    // The original `input += chunk` coerced each Buffer independently, so a
    // bisected 3-byte sequence became U+FFFD on BOTH sides. That does NOT make
    // JSON.parse throw — U+FFFD is valid inside a JSON string literal — so the
    // parse succeeded and the corruption flowed onward silently. A test asserting
    // "parses without exiting" would therefore have passed BEFORE the fix.
    //
    // The multi-byte character sits in a top-level KEY name, because key names are
    // exactly what the heartbeat records — so the observable is privacy-safe and
    // independent of the mint path.
    const key = 'tool_input_日本語';
    const payload = { tool_name: AGENT_TOOL, [key]: 1 };
    const buf = Buffer.from(JSON.stringify(payload), 'utf8');

    const idx = buf.indexOf(Buffer.from('日', 'utf8'));
    expect(idx).toBeGreaterThan(-1);

    // Leave 1 of the 3 bytes in the first chunk.
    const split = idx + 1;

    // Assert the test's OWN premise: the split byte must be a UTF-8 continuation
    // byte (0b10xxxxxx). Without this the test passes vacuously if the arithmetic
    // ever drifts off the multi-byte sequence.
    expect(buf[split] & 0b1100_0000).toBe(0b1000_0000);

    await runHook([buf.subarray(0, split), buf.subarray(split)], { chunkDelayMs: 250 });

    const rec = stageOf('payload_received');
    expect(rec).toBeTruthy();
    expect(rec.keys).toContain(key);

    // No replacement characters anywhere in what was written.
    const raw = fs.readFileSync(
      path.join(tmpRoot, '.routekit', 'telemetry', 'guardrails.log'),
      'utf8',
    );
    expect(raw).not.toContain('�');
  });
});

describe('AC-C2 — extractAgentResult is untouched by this story', () => {
  // Read the canonical source and slice out extractAgentResult by BRACE BALANCE,
  // so the pin tracks the function's semantic boundary. Edits elsewhere in the
  // file do not redden it; edits to this function do.
  function extractAgentResultBody(source) {
    const start = source.indexOf('function extractAgentResult(');
    if (start === -1) return null;

    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    return null;
  }

  it('has an unchanged function body (source-integrity pin)', () => {
    const body = extractAgentResultBody(fs.readFileSync(HOOK, 'utf8'));
    expect(body).toBeTruthy();

    const sha = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    expect(
      sha,
      'extractAgentResult changed. This function is the mint path: a silent change to ' +
        'it is exactly how the original provenance defect survived undetected for its ' +
        'entire life. If the change is intentional and backed by an OBSERVED harness ' +
        'payload shape (not an inferred one), recompute this pin in the story that ' +
        'carries that evidence. Never update it just to turn a red run green.',
    ).toBe(EXTRACT_AGENT_RESULT_SHA);
  });

  it('parses the bare content array the harness actually sends, and mints', async () => {
    // INVERTED by backlog.fix.extract-agent-result-harness-shape.
    //
    // This assertion previously REQUIRED hook.payload_shape_unknown — the bare array
    // was the one shape extractAgentResult could not read. Live telemetry on
    // 2026-08-15 showed that shape is exactly what the harness delivers:
    //   {"type":"array","array_length":1,"array_element_types":["text"],
    //    "found_text_block":true,"text_json_parse_ok":true}
    // So parsing it is now REQUIRED, and failing to parse it is the regression.
    //
    // Mutation that reddens this: delete the Array.isArray branch in
    // extractAgentResult. The mint disappears and payload_shape_unknown returns.
    const cited = 'packages/cli/src/rag/config.mjs';
    const res = await runHook([
      Buffer.from(
        JSON.stringify({
          tool_name: AGENT_TOOL,
          tool_input: { query: 'where is rag config' },
          tool_response: [
            { type: 'text', text: JSON.stringify({ ok: true, sources: [{ file: cited }] }) },
          ],
        }),
        'utf8',
      ),
    ]);

    expect(res.code).toBe(0);

    // The record that was REQUIRED before is now FORBIDDEN. tmpRoot is per-test, so
    // toEqual([]) is exact — not merely "none recently".
    expect(
      telemetryRecords().filter((r) => r.event === 'hook.payload_shape_unknown'),
    ).toEqual([]);

    const minted = sessionRagSourcedPaths();
    expect(minted).toHaveLength(1);
    expect(minted[0].path).toContain('rag/config.mjs');
    // Anchored at the start: unprefixed entries are the signature of the server-side
    // RAG path (packages/rag/src/tools.mjs:398) and must never satisfy this.
    expect(minted[0].query).toMatch(/^agent:research "/);
  });

  it('does NOT treat a bare array lacking a text block as a result', async () => {
    // Boundary case: typeof [] === 'object', so a branch that fell through to the
    // "already parsed object" check would wrongly accept this. track-agent-provenance-
    // payload.test.mjs:240-260 pins the same input and must stay green.
    await runHook([
      Buffer.from(
        JSON.stringify({ tool_name: AGENT_TOOL, tool_response: [1, 2, 3] }),
        'utf8',
      ),
    ]);

    const unknown = telemetryRecords().filter((r) => r.event === 'hook.payload_shape_unknown');
    expect(unknown.length).toBeGreaterThan(0);
    expect(sessionRagSourcedPaths()).toHaveLength(0);
  });

  it('records tool_response STRUCTURE without leaking its content', async () => {
    // The shape probe reads inside tool_response, which is where agent output — and
    // therefore any credential material — lives. It must emit types, lengths and
    // key names only.
    const sentinel = 'sk-ant-SHAPE-SENTINEL-MUST-NEVER-APPEAR';
    await runHook([
      Buffer.from(
        JSON.stringify({
          tool_name: AGENT_TOOL,
          tool_response: [{ type: 'text', text: JSON.stringify({ secret_key: sentinel }) }],
        }),
        'utf8',
      ),
    ]);

    const shape = stageOf('payload_received')?.tool_response_shape;
    expect(shape).toBeTruthy();

    // Structural fields present — without these the privacy assertion below would
    // pass vacuously against a probe that recorded nothing at all.
    expect(shape.type).toBe('array');
    expect(shape.array_element_types).toEqual(['text']);
    expect(shape.found_text_block).toBe(true);
    expect(shape.text_json_parse_ok).toBe(true);
    expect(typeof shape.text_length).toBe('number');

    const raw = fs.readFileSync(
      path.join(tmpRoot, '.routekit', 'telemetry', 'guardrails.log'),
      'utf8',
    );
    expect(raw).not.toContain(sentinel);
  });
});
