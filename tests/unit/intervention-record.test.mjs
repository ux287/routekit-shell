/**
 * The intervention receipt primitive.
 * backlog.feat.intervention-receipts-at-forced-exit-paths, requirements 1-6.
 *
 * This file must contain no spawn-family call (unit-tier purity guard).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  recordIntervention,
  RECEIPT_RELATIVE_PATH,
} from '../../packages/mcp-rks/src/shared/intervention-record.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const dirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const tmpRoot = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'intervention-receipt-'));
  dirs.push(d);
  return d;
};

const receiptPath = (root) => path.join(root, RECEIPT_RELATIVE_PATH);
const linesIn = (root) =>
  fs.readFileSync(receiptPath(root), 'utf8').split('\n').filter((l) => l.length > 0);

describe('recordIntervention — the durable half', () => {
  it('R1 — appends exactly one newline-terminated JSON line per call, never overwrites', () => {
    const root = tmpRoot();
    recordIntervention(root, { kind: 'tree_restore', cause: 'first' });
    recordIntervention(root, { kind: 'analyzer_gate', cause: 'second' });

    const raw = fs.readFileSync(receiptPath(root), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = linesIn(root);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).cause).toBe('first');
    expect(JSON.parse(lines[1]).cause).toBe('second');
  });

  it('R2 — THE DIVERGENCE BRIDGE: the returned record deep-equals the appended line', () => {
    // This is what makes R1 and R5 safe to read off the file at all. It is
    // falsified by any implementation that serializes before assigning
    // `recorded` and `recordPath` — that one always writes "recorded":false
    // while returning true.
    const root = tmpRoot();
    const returned = recordIntervention(root, { kind: 'tree_restore', cause: 'test_failure' });
    expect(returned.recorded).toBe(true);

    const lines = linesIn(root);
    expect(JSON.parse(lines[lines.length - 1])).toEqual(returned);
  });

  it('R3 — recorded is a READ-BACK, not existsSync and not end-of-try', () => {
    const root = tmpRoot();
    const ok = recordIntervention(root, { kind: 'tree_restore', cause: 'ok' });
    expect(ok.recorded).toBe(true);
    expect(ok.recordPath).toBe(receiptPath(root));
    expect(ok.writeError).toBeUndefined();
    // The bytes really are on disk.
    expect(fs.readFileSync(receiptPath(root), 'utf8')).toContain('"cause":"ok"');
  });

  it('R3 — a read-back observing DIFFERENT bytes reports recorded false, and does not throw', () => {
    // The discriminating control. existsSync would still be true here, and the
    // try block still completes — only an actual read-back can tell.
    const root = tmpRoot();
    vi.spyOn(fs, 'readSync').mockImplementation((_fd, buffer) => {
      buffer.fill(0x20); // spaces: the file says something other than what we wrote
      return buffer.length;
    });

    let result;
    expect(() => {
      result = recordIntervention(root, { kind: 'tree_restore', cause: 'mismatch' });
    }).not.toThrow();

    expect(result.recorded).toBe(false);
    expect(result.writeError).toBeTruthy();
    expect(result.writeError.length).toBeGreaterThan(0);
  });

  it('R4 — an unwritable projectRoot yields recorded false with a writeError, and does not throw', () => {
    const root = tmpRoot();
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    let result;
    expect(() => {
      result = recordIntervention(root, { kind: 'analyzer_gate', cause: 'static_analysis_failed' });
    }).not.toThrow();

    expect(result.recorded).toBe(false);
    expect(result.recordPath).toBeNull();
    expect(result.writeError).toContain('EACCES');
    // The caller's own fields survive, so a failed receipt is still legible.
    expect(result.kind).toBe('analyzer_gate');
    expect(result.cause).toBe('static_analysis_failed');
  });

  it('R5 — writes under the projectRoot it was GIVEN, not the shell repo root', () => {
    const root = tmpRoot();
    recordIntervention(root, { kind: 'project_unresolved', cause: 'Project not found' });

    expect(fs.existsSync(receiptPath(root))).toBe(true);
    // ANTI-VACUITY: the shell's own receipt file is not what we just read.
    expect(receiptPath(root).startsWith(REPO_ROOT)).toBe(false);
  });

  it('R6 — imports no telemetry collector and nothing that binds telemetry storage', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/mcp-rks/src/shared/intervention-record.mjs'),
      'utf8',
    );
    const imports = src.split('\n').filter((l) => /^\s*import\s/.test(l));
    // ANTI-VACUITY: there ARE imports, so the filter is not silently empty.
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line).not.toContain('telemetry');
      expect(line).not.toContain('collector');
    }
  });
});
