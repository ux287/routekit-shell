/**
 * Tests for the post-write verification in the dendron_create_note direct
 * handler (packages/mcp-rks/src/server.mjs:~3296).
 *
 * Before this fix, dendron_create_note could return ok:true with latencyMs:0
 * even when the note was never written to disk — observed in concourse-prototype
 * telemetry 2026-05-26T18:52:19Z. Downstream Governors (QA, ARCH) then ran via
 * RAG queries and "approved" a phantom story that the Build Governor later
 * discovered did not exist.
 *
 * The fix adds a post-write fs.existsSync + non-zero-size check between
 * writeNoteRaw and the success-return statement.
 *
 * Layer 2 (CLAUDE.md Dispatcher instruction) and Layer 3 (governor-po.md
 * chain step 2a) are also pinned by source-grep tests in this file.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const SERVER_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/mcp-rks/src/server.mjs'),
  'utf8',
);

/**
 * Extract the dendron_create_note handler block from server.mjs so each test
 * targets that specific code path.
 */
function extractCreateNoteHandlerBlock(src) {
  const start = src.indexOf('if (tool === "dendron_create_note")');
  if (start === -1) return null;
  // The handler ends at the next `if (tool === "dendron_fix_frontmatter")` block.
  const end = src.indexOf('if (tool === "dendron_fix_frontmatter")', start);
  if (end === -1) return null;
  return src.slice(start, end);
}

describe('Layer 1 — server.mjs dendron_create_note post-write verification', () => {
  const block = extractCreateNoteHandlerBlock(SERVER_SRC);

  it('a dendron_create_note handler exists in server.mjs', () => {
    expect(block).not.toBeNull();
  });

  it('handler defines a verifyNoteOnDisk helper (or equivalent re-stat path) after writeNoteRaw', () => {
    expect(block).toMatch(/verifyNoteOnDisk|verifyNote|fs\.existsSync\(notePath\)/);
  });

  it('handler checks fs.existsSync(notePath) post-write', () => {
    // The verifier must consult the filesystem, not trust writeNoteRaw's silence.
    expect(block).toMatch(/fs\.existsSync\(notePath\)/);
  });

  it('handler checks file size post-write (rejects zero-byte writes)', () => {
    expect(block).toMatch(/fs\.statSync\(notePath\)\.size|\.size\s*===\s*0/);
  });

  it('schema/template branch returns the verification error on failed verification (no schema success leaks)', () => {
    // The schema branch must check verify.ok BEFORE returning the success payload.
    const schemaBranch = block.slice(0, block.indexOf('writeNoteRaw(notePath, formatWithFrontmatter(generated, bodyContent))'));
    expect(schemaBranch).toMatch(/if\s*\(!verify\.ok\)|verify\.ok\s*===\s*false/);
  });

  it('no-schema branch returns the verification error on failed verification', () => {
    // After the final writeNoteRaw call, the verify-and-return-error pattern must appear before the final ok:true.
    const noSchemaBranch = block.slice(block.lastIndexOf('writeNoteRaw(notePath, formatWithFrontmatter(generated, bodyContent))'));
    expect(noSchemaBranch).toMatch(/if\s*\(!verify\.ok\)|verify\.ok\s*===\s*false/);
  });

  it('regression guard: the pre-write "already exists" McpError path is unchanged', () => {
    // The pre-write existsSync check (early reject for re-creates) must still throw McpError.
    expect(block).toMatch(/if\s*\(fs\.existsSync\(notePath\)\)\s*\{[^}]*throw\s+new\s+McpError/s);
  });

  it('error message mentions "post-write verification failed" so the failure mode is identifiable in telemetry/UI', () => {
    expect(block).toMatch(/post-write verification failed/);
  });
});

describe('Layer 2 — CLAUDE.md Dispatcher verification instruction', () => {
  const claudeMd = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');

  it('the "On Governor return" section instructs the Dispatcher to call dendron_read_note for each storyId', () => {
    const section = claudeMd.slice(claudeMd.indexOf('## On Governor return'));
    expect(section).toMatch(/PO Governor returns/);
    expect(section).toMatch(/dendron_read_note/);
  });

  it('the instruction tells the Dispatcher NOT to proceed to /qa if any read fails', () => {
    const section = claudeMd.slice(claudeMd.indexOf('## On Governor return'));
    expect(section).toMatch(/do NOT proceed|do not proceed/i);
  });
});

describe('Layer 3 — governor-po.md in-chain verification step', () => {
  const poPrompt = fs.readFileSync(
    path.join(REPO_ROOT, '.rks/prompts/governor-po.md'),
    'utf8',
  );

  it('PO Governor chain instructs a dendron_read_note verification step between create_note (step 2) and update_field (step 3)', () => {
    // The instruction must appear between the create call and the first update_field call.
    const createIdx = poPrompt.indexOf('dendron_create_note(');
    const updateIdx = poPrompt.indexOf('dendron_update_field(');
    expect(createIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(createIdx);
    const between = poPrompt.slice(createIdx, updateIdx);
    expect(between).toMatch(/dendron_read_note/);
  });

  it('the verification step is mandatory and instructs the PO to STOP/fail on read failure', () => {
    // The instruction must include MANDATORY + a stop-on-failure semantic.
    const createIdx = poPrompt.indexOf('dendron_create_note(');
    const updateIdx = poPrompt.indexOf('dendron_update_field(');
    const between = poPrompt.slice(createIdx, updateIdx);
    expect(between).toMatch(/MANDATORY|MUST/);
    expect(between).toMatch(/STOP|status:\s*['"]failed['"]|do not proceed/i);
  });
});
