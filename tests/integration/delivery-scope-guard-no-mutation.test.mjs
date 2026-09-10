/**
 * backlog.fix.agent-run-strict-input-and-delivery-guard — no side effects without scope.
 *
 * The load-bearing safety assertion: an under-specified delivery invocation must produce
 * ZERO side effects. Asserted on observed git and note state, NOT on a returned error
 * string — a correct-looking error with a mutated branch still fails this.
 *
 * The agent itself is LLM-driven and is not invoked here. What IS deterministic, and what
 * this file pins, is the config the factory produces and the behaviour of the discovery
 * tool it hands the model: the tool must refuse to authorize, must cap what it returns,
 * and must touch nothing on disk.
 *
 * Run:
 *   npx vitest run --config vitest.config.mock.mjs tests/integration/delivery-scope-guard-no-mutation.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  createDeliveryAgent,
  AUTO_DISCOVER_MAX,
} from '../../packages/mcp-rks/src/agents/delivery.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, env: GIT_ENV });
}

let projectRoot;

/** Temp project with more ready stories than the cap, so the bound is observable. */
function makeProject(readyCount) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-guard-')));
  const notes = path.join(dir, 'notes');
  fs.mkdirSync(notes, { recursive: true });

  for (let i = 0; i < readyCount; i++) {
    fs.writeFileSync(
      path.join(notes, `backlog.feat.story-${i}.md`),
      ['---', `id: "backlog.feat.story-${i}"`, 'status: not-implemented', 'phase: ready', '---', ''].join('\n'),
    );
  }

  git(['init', '-b', 'staging'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'test'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

/** Snapshot of everything a delivery run could mutate. */
function snapshot(dir) {
  return {
    head: git(['rev-parse', 'HEAD'], dir).stdout.trim(),
    branches: git(['branch', '--list'], dir).stdout.trim(),
    tags: git(['tag', '--list'], dir).stdout.trim(),
    status: git(['status', '--porcelain'], dir).stdout.trim(),
    notes: fs
      .readdirSync(path.join(dir, 'notes'))
      .sort()
      .map((f) => `${f}:${fs.readFileSync(path.join(dir, 'notes', f), 'utf8')}`)
      .join('\n'),
  };
}

/** Pull the list_ready_stories tool out of a built agent config. */
function discoveryTool(config) {
  const tool = config.tools.find((t) => t.name === 'list_ready_stories');
  expect(tool, 'list_ready_stories tool must exist').toBeTruthy();
  return tool;
}

beforeEach(() => {
  projectRoot = makeProject(AUTO_DISCOVER_MAX + 3);
});

afterEach(() => {
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('under-specified delivery causes no mutation', () => {
  it(
    'storyIds omitted and autoDiscover unset: discovery is a read-only preview, tree untouched',
    async () => {
      const before = snapshot(projectRoot);

      const config = createDeliveryAgent({ projectId: 'p', projectRoot });
      const result = await discoveryTool(config).execute({});

      // Refuses to authorize...
      expect(result.autoDiscoverAuthorized).toBe(false);
      expect(result.notice).toMatch(/READ-ONLY preview/);

      // ...and nothing on disk moved.
      expect(snapshot(projectRoot)).toEqual(before);
    },
    60_000,
  );

  it(
    'the instruction to the model says STOP rather than discover-and-ship',
    async () => {
      const config = createDeliveryAgent({ projectId: 'p', projectRoot });
      expect(config.userMessage).toMatch(/autoDiscover is NOT set/);
      expect(config.userMessage).toMatch(/Do NOT ship anything/);
      // And no branch was created merely by building the config.
      expect(git(['branch', '--list'], projectRoot).stdout).not.toMatch(/off-rail|release/);
    },
    60_000,
  );

  it(
    'AUTO-DISCOVERY IS BOUNDED: even when authorized, the cap holds',
    async () => {
      const before = snapshot(projectRoot);

      const config = createDeliveryAgent({ projectId: 'p', autoDiscover: true, projectRoot });
      const result = await discoveryTool(config).execute({});

      expect(result.autoDiscoverAuthorized).toBe(true);
      expect(result.stories.length).toBe(AUTO_DISCOVER_MAX);
      expect(result.totalFound).toBe(AUTO_DISCOVER_MAX + 3);
      expect(result.capped).toBe(true);

      // Discovery is still read-only — authorization is not mutation.
      expect(snapshot(projectRoot)).toEqual(before);
    },
    60_000,
  );

  it(
    'explicit storyIds are used as given, without widening',
    async () => {
      const config = createDeliveryAgent({
        projectId: 'p',
        storyIds: ['backlog.feat.story-0'],
        projectRoot,
      });
      expect(config.userMessage).toContain('backlog.feat.story-0');
      expect(config.userMessage).not.toMatch(/autoDiscover is NOT set/);
    },
    60_000,
  );

  it(
    'no branch, commit, tag, or phase advance occurs in any of the above',
    async () => {
      const before = snapshot(projectRoot);

      for (const opts of [{}, { autoDiscover: true }, { dryRun: true }]) {
        const config = createDeliveryAgent({ projectId: 'p', projectRoot, ...opts });
        await discoveryTool(config).execute({});
      }

      const after = snapshot(projectRoot);
      expect(after.head).toBe(before.head);
      expect(after.branches).toBe(before.branches);
      expect(after.tags).toBe(before.tags);
      expect(after.status).toBe(before.status);
      // Story phases must not have advanced.
      expect(after.notes).toBe(before.notes);
    },
    60_000,
  );
});
