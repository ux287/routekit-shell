/**
 * backlog.fix.mirror-ci-green-unship-doc-integrity-tests — AC3 (the split).
 *
 * THIS half stays in the published set. Its two cases assert on CLAUDE.md and
 * .rks/prompts/**, BOTH of which ship to the public mirror, so they are meaningful to a
 * cloner and pass there.
 *
 * The other 15 cases in this file asserted on notes/canon.prompt-architecture.md and
 * notes/canon.getting-started.md, neither of which is in the publish set. They have moved to
 * tests/unit/docs/canon.prompt-architecture.test.mjs, which is excluded from publish but
 * still collected upstream by vitest.config.unit.mjs's recursive tests/unit/** glob.
 *
 * The split is by SUBJECT, not by convenience: a test whose subject ships, ships.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('stale path audit', () => {
  function scanForPattern(filePath, pattern) {
    if (!fs.existsSync(filePath)) return false;
    return fs.readFileSync(filePath, 'utf8').includes(pattern);
  }

  it('CLAUDE.md does not reference notes/public.agents.', () => {
    expect(scanForPattern(path.join(PROJECT_ROOT, 'CLAUDE.md'), 'notes/public.agents.')).toBe(false);
  });

  it('no .rks/prompts/ file references notes/public.agents.', () => {
    const promptsDir = path.join(PROJECT_ROOT, '.rks', 'prompts');
    if (!fs.existsSync(promptsDir)) return;
    const hits = fs.readdirSync(promptsDir)
      .filter(f => f.endsWith('.md'))
      .filter(f => scanForPattern(path.join(promptsDir, f), 'notes/public.agents.'));
    expect(hits).toHaveLength(0);
  });
});
