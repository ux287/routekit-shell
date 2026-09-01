/**
 * Tests for backlog.fix.multiline-anchor-verification-false-green.
 *
 * A governor verified a two-line @@SEARCH anchor as two separate searches, got
 * `matchCount: 1` from each, and reported it verified. Both results were true. A
 * line had already been inserted between the two, so the block could not match —
 * the conclusion drawn from the two greens was the thing that was wrong.
 *
 * Two concerns here.
 *
 * (1) EXECUTABLE DOC-CONFORMANCE. The argument keys of every documented
 *     rks_exhaustive_search call in governor-build.md are extracted from the
 *     prompt text and handed to the REAL runExhaustiveSearch. This exists to
 *     prevent prompt/schema parameter-name DRIFT — NOT to unblock a broken call.
 *     A governor copying the wrong key is rejected by MCP schema validation at
 *     packages/mcp-rks/src/server.mjs:1357, which names the missing parameter and
 *     is self-correcting within one call; no incident is on record. What is not
 *     self-correcting is the prompt drifting again, silently, later.
 *
 * (2) PROMPT CONTENT. That the shared block states the two facts, and that the PO
 *     anchor-authoring region gained them additively.
 *
 * Full-source `toContain` on durable phrases throughout — no fixed-size source
 * windows, which is the brittleness this file's own subject matter warns about.
 *
 * This file must contain no spawn-family call (unit-tier purity guard).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExhaustiveSearch } from '@routekit/rag/tools';
import { makeTempDir } from '../helpers/tmp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const readPrompt = (name) =>
  fs.readFileSync(path.join(REPO_ROOT, '.rks/prompts', name), 'utf8');

const BUILD = readPrompt('governor-build.md');
const PO = readPrompt('governor-po.md');

/**
 * Every documented rks_exhaustive_search call in the prompt, as its argument-key set.
 *
 * Matches only occurrences carrying an argument object — the prompt also mentions
 * the tool in prose, and those are not calls.
 */
function documentedCallKeys(src) {
  const calls = [];
  const re = /rks_exhaustive_search\(\{([^}]*)\}\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const keys = [...m[1].matchAll(/(\w+)\s*:/g)].map((k) => k[1]);
    calls.push(keys);
  }
  return calls;
}

let repo;

beforeAll(() => {
  repo = makeTempDir('anchor-verification-procedure');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'const x = 1;\nSENTINEL\n');
});

afterAll(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('documented call keys are the keys the tool actually accepts', () => {
  it('FIXTURE PRECONDITION — the prompt documents at least one call with arguments', () => {
    // Anti-vacuity: if the regex stops matching, every assertion below would pass
    // over an empty list and prove nothing.
    const calls = documentedCallKeys(BUILD);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('every documented call drives the REAL tool without the bounded-path throw', () => {
    // The discriminator is `path` versus `scope`. runExhaustiveSearch takes
    // projectRoot POSITIONALLY (packages/rag/src/tools.mjs:529), so the documented
    // projectId and _governorToken keys are not options and are ignored — supply
    // the fixture root positionally instead.
    //
    // CONSTRUCTION NOTE: tools.mjs:532 throws "pattern is required" BEFORE the path
    // guard, so `pattern` must be truthy or this reds on the wrong throw.
    for (const keys of documentedCallKeys(BUILD)) {
      const options = {};
      for (const k of keys) {
        if (k === 'projectId' || k === '_governorToken') continue;
        options[k] = k === 'pattern' ? 'SENTINEL' : 'src';
      }
      expect(
        () => runExhaustiveSearch(repo, options),
        `documented keys [${keys.join(', ')}] do not drive the tool — `
          + 'the scoped-path argument name has drifted from the schema',
      ).not.toThrow();
    }
  });

  it("MUTATION CONTROL — a 'scope' key really does throw, so the case above can fail", () => {
    // Without this, "not.toThrow" could pass because nothing ever throws.
    expect(() => runExhaustiveSearch(repo, { pattern: 'SENTINEL', scope: 'src' }))
      .toThrow(/a scoped 'path' is required/);
  });

  it('no documented call in governor-build.md carries a scope key', () => {
    for (const keys of documentedCallKeys(BUILD)) {
      expect(keys, `documented call keys: [${keys.join(', ')}]`).not.toContain('scope');
    }
  });
});

describe('governor-build.md states a sound anchor procedure', () => {
  it('reads the verdict off results, not off matchCount', () => {
    expect(BUILD).toContain('Read the VERDICT OFF `results`, NOT off `matchCount`');
    expect(BUILD).toContain('`results[0].text` equals the pattern exactly');
  });

  it('states a multi-line procedure requiring consecutive lines in one file', () => {
    expect(BUILD).toContain('do not verify it as N separate searches');
    expect(BUILD).toContain('CONSECUTIVE ascending integers with no gap');
    expect(BUILD).toContain('SAME `results[].file`');
  });

  it('does NOT present rks_plan_ready as verifying a file-specific anchor', () => {
    // plan-ready.mjs raises pattern_exists only when a pattern is absent from EVERY
    // target (foundInAnyTarget at :238/:248/:267), so it cannot detect an anchor
    // that drifted in one target while the same text survives in another.
    expect(BUILD).toContain('`rks_plan_ready` is NOT a substitute');
    expect(BUILD).toContain('not in the file the anchor names');
  });
});

describe('governor-po.md gained the authoring-time rule additively', () => {
  it('states that a count is not evidence the anchor is verbatim', () => {
    expect(PO).toContain('A count of one is NOT evidence');
    expect(PO).toContain('Take the anchor from `results[].text`');
  });

  it('states that a multi-line anchor is not verified line by line', () => {
    expect(PO).toContain('separate searches carry no evidence of adjacency');
    expect(PO).toContain('CONSECUTIVE `results[].line` values');
  });

  it('ADDITIVE — every previously pinned phrase in that region survives', () => {
    // WRAP-TOLERANT BY NECESSITY, and the reason is this story's own subject.
    // "refine loop must supply it" is broken across a newline in the prompt
    // ("must\nsupply it"), so a literal toContain reports absence for a phrase
    // that is present. A first draft of this test asserted the literal and failed
    // — the same line-boundary trap the prompt amendment exists to warn about,
    // reproduced inside its own witness.
    for (const phrase of [
      'Get the anchor text from `rks_exhaustive_search`',
      'Do NOT take it from RAG',
      'caution 2 applied to anchors',
      'refine loop must supply it',
      'Silence is not an escape',
    ]) {
      const wrapTolerant = new RegExp(
        phrase.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'),
      );
      expect(wrapTolerant.test(PO), `additive edit dropped: ${phrase}`).toBe(true);
    }
  });
});
