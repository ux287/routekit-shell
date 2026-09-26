// backlog.fix.posttooluse-sources-provenance-mint
//
// ============================== WHAT THIS PROVES ==============================
// STRUCTURAL ONLY. These assertions prove that the three matcher sites were
// EDITED CORRECTLY. They do NOT prove that the track-agent-provenance.mjs hook
// FIRES, and they do NOT prove that a provenance entry is ever minted.
//
// A GREEN RUN OF THIS FILE IS NOT EVIDENCE THAT THE BUG IS FIXED, and must never
// be reported as such.
//
// The bug this story closes was shipped green precisely because the existing
// tests (track-agent-provenance-payload.test.mjs, posttooluse-payload-contract.
// test.mjs) hand-build the hook envelope they then parse, and invoke the hook
// DIRECTLY — which, under Claude Code issue #33585, is the one thing the real
// harness never does. This file deliberately does not repeat that mistake: it
// asserts nothing about invocation, and it spawns nothing.
//
// End-to-end confirmation for this story is a MANUAL post-restart procedure
// (one real rks_agent_research call in a fresh session, then a new
// .rks/session/state.json ragSourcedPaths entry whose query begins
// `agent:research "`). There is no automated substitute, and none is attempted
// here.
// =============================================================================
//
// The defect: an `a|b|c` PostToolUse matcher binds only its FIRST alternative
// (Claude Code issue #33585). All three sites carried a byte-identical 12-way
// pipe alternation whose first alternative was rks_agent_run — a tool the
// governor chain-state machine effectively never permits — so the provenance
// hook fired NEVER, for ANY tool. Baseline at fix time: 0 of 458 ledger entries
// carried the `agent:` prefix that getProvenanceQuery stamps.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_PROVENANCE_TOOLS,
  buildHookRegistration,
} from '../../packages/cli/src/project/bootstrap.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const PROVENANCE_HOOK = 'track-agent-provenance.mjs';

// The tool list is NOT duplicated here. It is imported from bootstrap.mjs, which
// owns the canonical copy. A private list in this file would defeat the whole
// point: this file is the drift guard, and a guard that asserts against its own
// frozen copy cannot detect the generator drifting away from it.
//
// The two static settings.json files cannot import from JS, so they are pinned to
// the canonical list by EXACT SET EQUALITY below — not containment. Containment is
// one-directional and would silently accept both a site missing a name and a site
// carrying an extra one.

// Frozen inventory of every hook script registered in the REAL
// .claude/settings.json immediately BEFORE the #33585 matcher split, recorded as
// <tier>/<name>.mjs. This is the wholesale-disable guard: .claude/settings.json
// is the single file that registers every hook, so an edit that drops, renames
// or re-paths one silently disables enforcement. Post-edit must be a SUPERSET.
// Adding a hook is fine; losing one is not.
const PRE_SPLIT_HOOK_SCRIPTS = [
  'read/track-rag-results.mjs',
  'system/track-agent-provenance.mjs',
  'system/rag-embed-on-commit.mjs',
  'system/guardrails-auto-enable.mjs',
  'read/monitor-context.mjs',
  'read/check-docs-sync.mjs',
  'system/track-write-telemetry.mjs',
  'write/capture-plan-to-backlog.mjs',
  'system/guardrails-gate.mjs',
  'write/redirect-plan-to-backlog.mjs',
  'read/redirect-read-to-agent.mjs',
  'read/redirect-grep-to-agent.mjs',
  'read/redirect-glob-to-agent.mjs',
  'read/redirect-task-explore-to-agent.mjs',
  'read/enforce-orchestration.mjs',
  'read/enforce-rag-discovery.mjs',
  'read/enforce-read-provenance.mjs',
  'write/redirect-edit-to-governor.mjs',
  'system/enforce-targetfile-scope.mjs',
  'write/enforce-plan-scope.mjs',
  'read/enforce-architecture.mjs',
  'read/enforce-dendron-note-creation.mjs',
  'write/redirect-validate-story-to-agent.mjs',
  'write/redirect-git-tools-to-agent.mjs',
  'write/redirect-dendron-tools-to-agent.mjs',
  'read/redirect-rag-tools-to-agent.mjs',
  'write/enforce-staging-release-governor.mjs',
  'write/redirect-github-tools-to-governor.mjs',
  'read/redirect-websearch-to-agent.mjs',
  'read/redirect-webfetch-to-governor.mjs',
  'write/redirect-notebookedit-to-governor.mjs',
  'write/redirect-bash-to-governor.mjs',
  'system/block-git-during-off-rail.mjs',
  'write/enforce-git-workflow.mjs',
  'write/enforce-branch-workflow.mjs',
  'read/enforce-rag-for-search.mjs',
  'read/check-dependency-security.mjs',
];

const SETTINGS_SITES = [
  { label: '.claude/settings.json', relPath: path.join('.claude', 'settings.json') },
  {
    label: 'templates/base/.claude/settings.json',
    relPath: path.join('templates', 'base', '.claude', 'settings.json'),
  },
];

function readRaw(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

// Every hook script referenced anywhere in a settings object, as <tier>/<name>.mjs
// (or bare <name>.mjs for the flat template layout).
function hookScripts(settings) {
  const found = new Set();
  for (const entries of Object.values(settings.hooks || {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks || []) {
        const match = /\/\.routekit\/hooks\/(.+?\.mjs)/.exec(hook.command || '');
        if (match) found.add(match[1]);
      }
    }
  }
  return found;
}

// The matcher string of every PostToolUse entry that registers the provenance hook.
function provenanceMatchers(postToolUse) {
  return (postToolUse || [])
    .filter((entry) =>
      (entry.hooks || []).some((hook) => (hook.command || '').includes(PROVENANCE_HOOK))
    )
    .map((entry) => entry.matcher);
}

// Exact set equality against the canonical list, in BOTH directions, with a
// failure that names the out-of-sync site and separates missing from extra.
// Asserting one object rather than two separate expects means a single failure
// reports both directions at once instead of hiding the second behind the first.
function expectMatchesCanonical(site, matchers) {
  const present = new Set(matchers);
  const canonical = new Set(AGENT_PROVENANCE_TOOLS);

  const missing = AGENT_PROVENANCE_TOOLS.filter((tool) => !present.has(tool));
  const extra = [...present].filter((tool) => !canonical.has(tool));

  expect(
    { site, missing, extra },
    `${site} is out of sync with the canonical AGENT_PROVENANCE_TOOLS list in ` +
      'packages/cli/src/project/bootstrap.mjs',
  ).toEqual({ site, missing: [], extra: [] });
}

describe('PostToolUse MCP matcher registration (#33585 alternation split)', () => {
  describe('the canonical list itself', () => {
    it('is importable from bootstrap.mjs as a module-scope named export', () => {
      expect(Array.isArray(AGENT_PROVENANCE_TOOLS)).toBe(true);
      expect(AGENT_PROVENANCE_TOOLS.length).toBeGreaterThan(0);
    });

    it('holds exactly the 12 agent tool names, in order', () => {
      // Ordered toEqual, so a rename, reorder, addition or deletion all fail.
      // Every other assertion in this file is relative to this list, so if it
      // drifts silently the whole guard drifts with it.
      expect(AGENT_PROVENANCE_TOOLS).toEqual([
        'mcp__rks__rks_agent_run',
        'mcp__rks__rks_agent_research',
        'mcp__rks__rks_agent_validate_story',
        'mcp__rks__rks_agent_git',
        'mcp__rks__rks_agent_dendron',
        'mcp__rks__rks_agent_telemetry',
        'mcp__rks__rks_agent_external_research',
        'mcp__rks__rks_agent_ship',
        'mcp__rks__rks_agent_cycle_complete',
        'mcp__rks__rks_agent_story',
        'mcp__rks__rks_agent_delivery',
        'mcp__rks__rks_agent_recovery',
      ]);
    });
  });

  describe.each(SETTINGS_SITES)('$label', ({ label, relPath }) => {
    it('parses as valid JSON', () => {
      expect(() => JSON.parse(readRaw(relPath))).not.toThrow();
    });

    it('registers the provenance hook with no pipe-alternated matcher', () => {
      const settings = JSON.parse(readRaw(relPath));
      const matchers = provenanceMatchers(settings.hooks.PostToolUse);

      expect(matchers.length).toBeGreaterThan(0);
      for (const matcher of matchers) {
        expect(matcher).not.toContain('|');
      }
    });

    it('matches the canonical tool list exactly — no missing names, no extras', () => {
      const settings = JSON.parse(readRaw(relPath));

      expectMatchesCanonical(label, provenanceMatchers(settings.hooks.PostToolUse));
    });

    it('emits exactly one provenance entry per tool name — no duplicates', () => {
      const settings = JSON.parse(readRaw(relPath));
      const matchers = provenanceMatchers(settings.hooks.PostToolUse);

      // Set equality alone would accept a duplicated matcher entry, since a Set
      // collapses it. Assert on the ARRAY length to catch that. A mismatch here
      // means either a duplicate OR a count divergence from the canonical list —
      // the set-equality test above says which.
      expect(
        matchers,
        `${label} provenance matcher count does not match the canonical ` +
          'AGENT_PROVENANCE_TOOLS length — a duplicated entry, or a name added ' +
          'to the canonical list without being added here',
      ).toHaveLength(AGENT_PROVENANCE_TOOLS.length);
    });
  });

  describe('.claude/settings.json wholesale-disable guard', () => {
    it('still registers every hook script present before the split', () => {
      const settings = JSON.parse(readRaw(path.join('.claude', 'settings.json')));
      const present = hookScripts(settings);

      for (const script of PRE_SPLIT_HOOK_SCRIPTS) {
        expect(present).toContain(script);
      }
    });
  });

  describe('buildHookRegistration() — the child-project writer', () => {
    // This is the site that PROPAGATES: buildHookRegistration is the sole
    // producer of every child project's hooks block, so an alternation here
    // writes a permanently dead provenance hook into every `routekit project
    // attach` / `init`. Asserted on matchers only — with no manifest the command
    // paths are the flat fallback, which is irrelevant to matcher registration.
    const hooks = buildHookRegistration(null);

    it('emits no pipe-alternated provenance matcher', () => {
      const matchers = provenanceMatchers(hooks.PostToolUse);

      expect(matchers.length).toBeGreaterThan(0);
      for (const matcher of matchers) {
        expect(matcher).not.toContain('|');
      }
    });

    it('matches the canonical tool list exactly — no missing names, no extras', () => {
      expectMatchesCanonical('buildHookRegistration', provenanceMatchers(hooks.PostToolUse));
    });

    it('emits one provenance entry per tool name, not a collapsed matcher', () => {
      expect(provenanceMatchers(hooks.PostToolUse)).toHaveLength(
        AGENT_PROVENANCE_TOOLS.length,
      );
    });
  });
});
