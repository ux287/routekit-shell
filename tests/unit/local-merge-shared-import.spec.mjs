/**
 * Static-analysis assertions: localMerge is a single shared module imported
 * by both story-ship.mjs and guardrails-audit.mjs (no duplication).
 *
 * (backlog.feat.guardrails-on-three-branch-aware)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const sharedSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server/git/local-merge.mjs'),
  'utf8'
);
const storyShipSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server/story-ship.mjs'),
  'utf8'
);
const guardrailsSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server/guardrails-audit.mjs'),
  'utf8'
);
const branchDeliverySrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server/git/branch-delivery.mjs'),
  'utf8'
);

describe('localMerge shared module', () => {
  it('exports localMerge from packages/mcp-rks/src/server/git/local-merge.mjs', () => {
    expect(sharedSrc).toMatch(/export\s+function\s+localMerge\s*\(/);
  });

  it('story-ship.mjs imports localMerge from ./git/local-merge.mjs', () => {
    expect(storyShipSrc).toMatch(/import\s*\{[^}]*\blocalMerge\b[^}]*\}\s*from\s*['"]\.\/git\/local-merge\.mjs['"]/);
  });

  it('story-ship.mjs no longer contains an inline `function localMerge(` declaration', () => {
    expect(storyShipSrc).not.toMatch(/^\s*function\s+localMerge\s*\(/m);
  });

  it('branch-delivery.mjs imports localMerge from ./local-merge.mjs', () => {
    // backlog.fix.ship-delivery-implemented-twice: the shared delivery module is now the
    // rail-agnostic caller of localMerge.
    expect(branchDeliverySrc).toMatch(/import\s*\{[^}]*\blocalMerge\b[^}]*\}\s*from\s*['"]\.\/local-merge\.mjs['"]/);
  });

  it('guardrails-audit.mjs does NOT import localMerge — its delivery is delegated', () => {
    // REWORKED TO THE NEGATIVE, not deleted. This assertion used to require the import,
    // and was green on a reference that had become DEAD: off-rail delivery moved into
    // deliverFeatureBranch, which calls localMerge itself, leaving guardrails-audit.mjs
    // importing a symbol it never used. Asserting the import would now pin exactly the
    // dead reference AC 15 removes.
    expect(guardrailsSrc).not.toMatch(/import\s*\{[^}]*\blocalMerge\b[^}]*\}\s*from\s*['"]\.\/git\/local-merge\.mjs['"]/);
    // …and it must not have re-inlined one either.
    expect(guardrailsSrc).toMatch(/import\s*\{[^}]*\bdeliverFeatureBranch\b[^}]*\}\s*from\s*['"]\.\/git\/branch-delivery\.mjs['"]/);
  });

  it('guardrails-audit.mjs does not contain an inline `function localMerge(` declaration', () => {
    expect(guardrailsSrc).not.toMatch(/^\s*function\s+localMerge\s*\(/m);
  });
});
