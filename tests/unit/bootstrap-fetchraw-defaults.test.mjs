// backlog.fix.fetchraw-silent-denial-trap — the child-bootstrap half.
//
// Every project rks ever created was born unable to fetch anything: bootstrap
// wrote .rks/project.json with no `fetchRaw` block, and rks_fetch_raw is
// default-deny, so every raw fetch was refused — silently.
//
// WHY THESE TESTS EXERCISE A PURE HELPER RATHER THAN attachProject:
// attachProject's config write has ZERO in-process coverage. Every case in
// tests/project-bootstrap.test.mjs is .skip()'d (they drive the CLI as a
// subprocess at 60-137s each), and the tests/unit/init-*.test.mjs files vi.mock
// attachProject rather than running it. A decision buried inside that function
// would therefore ship untested. withFetchRawDefaults isolates the decision from
// all I/O so it can actually be asserted. Do NOT "improve" this by adding a
// CLI-spawning test.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FETCH_RAW,
  withFetchRawDefaults,
} from '../../packages/cli/src/project/bootstrap.mjs';

// Imported in the TEST ONLY. bootstrap.mjs must never depend on @routekit/mcp-rks —
// these are the gate that actually enforces the list, so asserting through them proves
// the entries are matchable and not merely present as strings.
import {
  loadAllowedHosts,
  hostAllowed,
} from '../../packages/mcp-rks/src/agents/fetch-raw.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOTSTRAP = path.join(REPO_ROOT, 'packages', 'cli', 'src', 'project', 'bootstrap.mjs');

// The 12 hosts that predate this story. Both lists must still carry all of them.
const PREEXISTING_HOSTS = [
  'code.claude.com',
  'docs.claude.com',
  'github.com',
  'docs.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'registry.npmjs.org',
  'www.npmjs.com',
  'nodejs.org',
  'developer.mozilla.org',
  'modelcontextprotocol.io',
  'spec.modelcontextprotocol.io',
];

const ADDED_HOSTS = ['docs.anthropic.com', 'api.github.com'];

describe('withFetchRawDefaults', () => {
  it('adds a working fetchRaw block to a config that has none', () => {
    // The fresh-project case: init/attach previously produced exactly this shape,
    // minus fetchRaw, and the resulting project could fetch nothing.
    const out = withFetchRawDefaults({
      id: 'child-proj',
      rksVersion: '1.2.3',
      kgFile: 'routekit/kg.yaml',
    });

    expect(out.fetchRaw).toBeTruthy();
    expect(out.fetchRaw.mode).toBe('allowlist');
    expect(Array.isArray(out.fetchRaw.allowedHosts)).toBe(true);
    // A non-empty list is the whole point — hostAllowed() denies everything when
    // the list is empty, so an empty default would reproduce the original bug.
    expect(out.fetchRaw.allowedHosts.length).toBeGreaterThan(0);
  });

  it('BACKFILLS an existing config without disturbing unrelated keys', () => {
    // This is the branch that repairs dormant child projects on re-attach, and
    // the one that actually runs for fresh projects too (readJSON swallows ENOENT,
    // so attachProject's catch branch is dead for the fresh case).
    const existing = {
      id: 'dormant-child',
      rksVersion: '0.4.0',
      kgFile: 'routekit/kg.yaml',
      offRail: { enabled: true, roots: ['src/*'] },
      skillDefaults: { build: 'heartbeat' },
      rag: { enabled: true },
    };
    const out = withFetchRawDefaults(existing);

    expect(out.fetchRaw.mode).toBe('allowlist');
    // Every sibling key survives byte-for-byte.
    for (const key of Object.keys(existing)) {
      expect(out[key]).toEqual(existing[key]);
    }
  });

  it('NEVER clobbers a project that already chose its own posture', () => {
    // A project owning fetchRaw owns it — including a deliberately empty list or
    // an "open" posture. Absence is the only trigger for the backfill.
    const opened = { id: 'x', fetchRaw: { mode: 'open', allowedHosts: [] } };
    expect(withFetchRawDefaults(opened).fetchRaw).toEqual({ mode: 'open', allowedHosts: [] });

    const narrowed = { id: 'y', fetchRaw: { mode: 'allowlist', allowedHosts: ['only.example.com'] } };
    expect(withFetchRawDefaults(narrowed).fetchRaw.allowedHosts).toEqual(['only.example.com']);
  });

  it('is idempotent — a second pass changes nothing', () => {
    // Re-attach runs this repeatedly; it must converge, not accumulate.
    const once = withFetchRawDefaults({ id: 'z' });
    expect(withFetchRawDefaults(once)).toEqual(once);
  });

  it('does not share array state between projects', () => {
    // A shallow copy of DEFAULT_FETCH_RAW would hand every project the same array
    // instance, so one project editing its allowlist would mutate the default.
    const a = withFetchRawDefaults({ id: 'a' });
    const b = withFetchRawDefaults({ id: 'b' });

    a.fetchRaw.allowedHosts.push('leaked.example.com');

    expect(b.fetchRaw.allowedHosts).not.toContain('leaked.example.com');
    expect(DEFAULT_FETCH_RAW.allowedHosts).not.toContain('leaked.example.com');
  });

  it('tolerates a null or non-object config', () => {
    expect(withFetchRawDefaults(null).fetchRaw.mode).toBe('allowlist');
    expect(withFetchRawDefaults(undefined).fetchRaw.mode).toBe('allowlist');
  });

  it('enumerates subdomains explicitly, because matching is exact', () => {
    // hostAllowed() matches bare patterns EXACTLY: 'github.com' does not cover
    // 'docs.github.com'. And redirect hops are re-validated against the same list,
    // so raw.githubusercontent.com is useless without its redirect target.
    const hosts = DEFAULT_FETCH_RAW.allowedHosts;

    expect(hosts).toContain('github.com');
    expect(hosts).toContain('docs.github.com');
    expect(hosts).toContain('raw.githubusercontent.com');
    expect(hosts).toContain('objects.githubusercontent.com');
    expect(hosts).toContain('modelcontextprotocol.io');
    expect(hosts).toContain('spec.modelcontextprotocol.io');
  });

  it('is actually WIRED INTO attachProject, on both config-write branches', () => {
    // Without this, every other test in this file passes while the helper is never
    // called and no project is repaired — a perfectly green suite over a no-op.
    // Region-anchored between two stable landmarks rather than a fixed-size window,
    // so unrelated edits to bootstrap.mjs do not redden it.
    const src = fs.readFileSync(BOOTSTRAP, 'utf8');
    const start = src.indexOf('const rksProjectJsonPath = path.join(rksDir, "project.json");');
    const end = src.indexOf('upsertProject(', start);

    expect(start, 'config-write region start landmark not found').toBeGreaterThan(-1);
    expect(end, 'config-write region end landmark not found').toBeGreaterThan(start);

    const region = src.slice(start, end);
    const wired = region.match(/withFetchRawDefaults\(/g) || [];

    // Both the existing-config branch (which also runs for fresh projects, because
    // readJSON swallows ENOENT) and the catch branch must be wired.
    expect(
      wired.length,
      'attachProject must call withFetchRawDefaults on BOTH config-write branches',
    ).toBeGreaterThanOrEqual(2);
  });

  it('keeps the shipped default posture conservative', () => {
    // This default propagates to EVERY child project. `open` would drop the host
    // allowlist ecosystem-wide. The 2026-07-15 proposal to flip it was motivated
    // by denials being invisible; they are loud now, so that pressure is gone.
    expect(DEFAULT_FETCH_RAW.mode).toBe('allowlist');
  });
});

// ---------------------------------------------------------------------------
// backlog.fix.fetchraw-denial-gap-closeout — GAP 3.
//
// docs.anthropic.com and api.github.com were missing from BOTH the shell's own
// allowlist and the child template. The omission shipped unseen because the
// membership test above asserts only hosts that were ALREADY PRESENT, and only
// over the template — nothing ever witnessed the shell's own list.
//
// The two membership assertions below are deliberately INDEPENDENT: G3-1 reads
// .rks/project.json, G3-2 reads the exported constant. Reverting only one list
// must redden only its own test. A single assertion that passes when just one
// side is fixed would let the same class of bug through again.
// ---------------------------------------------------------------------------
describe('fetchRaw allowlist — shell and child template, asserted independently', () => {
  it('G3-1: the SHELL allowlist (.rks/project.json) carries both added hosts', () => {
    const hosts = loadAllowedHosts(REPO_ROOT);

    for (const h of ADDED_HOSTS) expect(hosts, `shell allowlist missing ${h}`).toContain(h);
    for (const h of PREEXISTING_HOSTS) expect(hosts, `shell allowlist lost ${h}`).toContain(h);
  });

  it('G3-2: the CHILD TEMPLATE (DEFAULT_FETCH_RAW) carries both added hosts', () => {
    // Reads the constant only — never .rks/project.json. Fixing the shell alone
    // leaves every future child born without these hosts.
    const hosts = DEFAULT_FETCH_RAW.allowedHosts;

    for (const h of ADDED_HOSTS) expect(hosts, `template missing ${h}`).toContain(h);
    for (const h of PREEXISTING_HOSTS) expect(hosts, `template lost ${h}`).toContain(h);
  });

  it('G3-3: both hosts are matchable by the gate that enforces them', () => {
    // Behavioral, not string-matched. 'https://docs.anthropic.com' would satisfy a
    // naive toContain but is unmatchable by hostAllowed — this is what catches that.
    const shell = loadAllowedHosts(REPO_ROOT);

    for (const h of ADDED_HOSTS) {
      expect(hostAllowed(h, shell), `${h} not matchable against shell list`).toBe(true);
      expect(
        hostAllowed(h, DEFAULT_FETCH_RAW.allowedHosts),
        `${h} not matchable against template list`,
      ).toBe(true);
    }
  });

  it('G3-4: a child is never born with fewer hosts than the shell that created it', () => {
    // Subset in this direction only — the shell may legitimately hold extra
    // operator-added hosts that the template should not ship.
    const shell = loadAllowedHosts(REPO_ROOT);

    for (const h of DEFAULT_FETCH_RAW.allowedHosts) {
      expect(shell, `template host ${h} absent from the shell's own allowlist`).toContain(h);
    }
  });

  it('G3-5: the template list stays well-formed', () => {
    const hosts = DEFAULT_FETCH_RAW.allowedHosts;

    expect(new Set(hosts).size, 'duplicate host in the template allowlist').toBe(hosts.length);
    for (const h of hosts) {
      // Bare hostnames only — no scheme, no path, no port, no whitespace.
      expect(h, `${h} is not a bare hostname`).toMatch(/^(\*\.)?[a-z0-9.-]+$/);
    }
  });

  it('G3-6: editing the allowlist did no collateral damage to .rks/project.json', () => {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, '.rks', 'project.json'), 'utf8'),
    );

    // PRESENCE check, never exact key-set equality — a future key addition must
    // not redden this.
    for (const key of [
      'id', 'root', 'schemaVersion', 'frameworkProject', 'createdAt', 'updatedAt',
      'kgFile', 'notes', 'rag', 'kg', 'llm', 'skillDefaults', 'fetchRaw', 'offRail',
    ]) {
      expect(cfg, `top-level key ${key} lost from .rks/project.json`).toHaveProperty(key);
    }

    expect(cfg.fetchRaw.mode).toBe('allowlist');
  });

  it('G3-7: the absence-only backfill trigger is untouched', () => {
    // Appending hosts must not turn the backfill into an unconditional assignment.
    // Operator customization is still never clobbered.
    expect(withFetchRawDefaults({ fetchRaw: { mode: 'open' } })).toEqual({
      fetchRaw: { mode: 'open' },
    });
  });
});
