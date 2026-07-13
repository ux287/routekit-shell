/**
 * Unit tests for exec auto-embed on success.
 *
 * Tests embedScopedFiles (embedding-pipeline.mjs) in isolation.
 * The integration with exec.mjs is a call-site change; these tests verify
 * the scoped-embed entry point behaves correctly under success, failure,
 * and edge-case inputs so exec can trust the non-fatal contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Single top-level mock — no vi.resetModules() needed.
// embedScopedFiles dynamically imports tools.mjs; this mock ensures it always
// gets the spy regardless of module cache state.
vi.mock('../../packages/mcp-rks/src/rag/tools.mjs', () => ({
  runRagEmbed: vi.fn(),
}));

// Mock the @xenova/transformers third-party leaf. embedding-pipeline.mjs
// statically imports it at module top level, which transitively loads
// onnxruntime-node's 15-35 MB native addon via an unguarded require().
// Stubbing the leaf cuts that native-addon load at import time while leaving
// embedScopedFiles (the system under test) and all 7 tests fully real.
vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(),
}));

const { runRagEmbed } = await import('../../packages/mcp-rks/src/rag/tools.mjs');
const { embedScopedFiles } = await import('../../packages/mcp-rks/src/rag/embedding-pipeline.mjs');

describe('embedScopedFiles — scoped entry point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runRagEmbed.mockResolvedValue({ ok: true });
  });

  it('returns { ok: true, filesEmbedded: 0 } when files list is empty', async () => {
    const result = await embedScopedFiles('/proj', []);
    expect(result.ok).toBe(true);
    expect(result.filesEmbedded).toBe(0);
    expect(runRagEmbed).not.toHaveBeenCalled();
  });

  it('returns { ok: true, filesEmbedded: 0 } when files is not an array', async () => {
    const result = await embedScopedFiles('/proj', null);
    expect(result.ok).toBe(true);
    expect(result.filesEmbedded).toBe(0);
  });

  it('calls runRagEmbed with projectRoot and files list on success', async () => {
    const files = ['src/foo.mjs', 'src/bar.mjs'];
    await embedScopedFiles('/my/project', files);
    expect(runRagEmbed).toHaveBeenCalledWith('/my/project', { files });
  });

  it('returns filesEmbedded count matching the files list length', async () => {
    const files = ['a.mjs', 'b.mjs', 'c.mjs'];
    const result = await embedScopedFiles('/proj', files);
    expect(result.filesEmbedded).toBe(3);
  });

  it('returns { ok: false, error } when runRagEmbed throws', async () => {
    runRagEmbed.mockRejectedValue(new Error('DB locked'));
    const result = await embedScopedFiles('/proj', ['src/foo.mjs']);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('DB locked');
  });

  it('returns { ok: false } when runRagEmbed returns ok: false', async () => {
    runRagEmbed.mockResolvedValue({ ok: false, error: 'embed lock active' });
    const result = await embedScopedFiles('/proj', ['src/foo.mjs']);
    expect(result.ok).toBe(false);
  });

  it('does NOT throw on failure — returns error object instead', async () => {
    runRagEmbed.mockRejectedValue(new Error('fatal'));
    await expect(embedScopedFiles('/proj', ['src/foo.mjs'])).resolves.not.toThrow();
    const result = await embedScopedFiles('/proj', ['src/foo.mjs']);
    expect(result.ok).toBe(false);
  });
});
