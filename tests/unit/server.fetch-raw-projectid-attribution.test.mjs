/**
 * backlog.fix.fetchraw-denial-gap-closeout — GAP 1.
 *
 * fetchRaw() grew a `projectId` opt so denial events could be attributed to a project.
 * The only production caller — the rks_fetch_raw CallTool handler in server.mjs — never
 * passed it, so the opt was null on every real request and every denial emitted in
 * production was unattributable: /telemetry could not say which project was refused.
 *
 * G1-1 is the PRIMARY, BEHAVIORAL witness: a real CallTool round trip over an in-process
 * transport. G1-2 is a COMPANION source check, never the sole proof.
 *
 * createServer() is EXPORTED (server.mjs:977) and the composition-root comment above it
 * states that importing the module is side-effect-free and that tests may construct a
 * server instance with no vi.resetModules / re-import dance. The static import below is
 * therefore permitted: unit-tier-purity Rule B flags only a vi.resetModules() followed
 * within 60 lines by a DYNAMIC import() of a >1000-line module, and
 * tests/unit/dendron-create-note-verbatim-content.test.mjs:17 already statically imports
 * server.mjs in this tier today.
 *
 * OPERATIVE CONSTRAINT (S-3): no vi.resetModules() anywhere in this file, and no dynamic
 * import() of server.mjs.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { withTempDir } from '../_helpers/with-temp-dir.mjs';

const FETCH_RAW_MODULE = '../../packages/mcp-rks/src/agents/fetch-raw.mjs';

// The specifier is written out in full here ON PURPOSE: vi.mock is hoisted above every
// const in this file, so referencing FETCH_RAW_MODULE inside it is a TDZ error.
//
// Spread the original module so every OTHER export survives — external-research.mjs
// imports loadFetchMode/loadAllowedHosts/hostAllowed from here, and server.mjs pulls
// that in, so a bare factory would break the module graph rather than the handler.
vi.mock('../../packages/mcp-rks/src/agents/fetch-raw.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchRaw: vi.fn(async () => ({ ok: false, reason: 'host_not_allowlisted', url: 'https://blocked.example.com/x' })),
  };
});

// STATIC imports, per S-3's operative constraint. vi.mock is hoisted above these, so the
// mock is installed before server.mjs resolves its own dynamic import of fetch-raw.mjs.
// Exactly one static import of server.mjs, and no vi.resetModules() anywhere in this file.
import { createServer } from '../../packages/mcp-rks/src/server.mjs';
import { fetchRaw as fetchRawSpy } from '../../packages/mcp-rks/src/agents/fetch-raw.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_SRC = path.join(REPO_ROOT, 'packages', 'mcp-rks', 'src', 'server.mjs');

const PROJECT_ID = 'fetchraw-attribution-fixture';

/**
 * A self-contained project the env override can resolve without any user registry.
 * loadProjectContext short-circuits to { root: ROUTEKIT_PROJECT_ROOT } when the id
 * matches ROUTEKIT_PROJECT_ID, so CI needs nothing installed.
 */
function writeFixtureProject(dir) {
  fs.mkdirSync(path.join(dir, '.rks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'routekit'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.rks', 'project.json'),
    JSON.stringify({ id: PROJECT_ID, root: dir, kgFile: 'routekit/kg.yaml' }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'routekit', 'kg.yaml'), 'project: fixture\n');
}

describe('rks_fetch_raw CallTool handler — projectId attribution', () => {
  it('G1-1: a fetch through the REAL CallTool path carries the projectId', async () => {
    await withTempDir('fetchraw-attribution', async (dir) => {
      writeFixtureProject(dir);

      const saved = {
        root: process.env.ROUTEKIT_PROJECT_ROOT,
        id: process.env.ROUTEKIT_PROJECT_ID,
      };
      process.env.ROUTEKIT_PROJECT_ROOT = dir;
      process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;
      fetchRawSpy.mockClear();

      try {
        // In-process transport: no network, no subprocess. This is the real handler
        // reached through the real tool-dispatch path, not a hand-called function.
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const server = createServer();
        const client = new Client({ name: 'attribution-test', version: '1.0.0' }, { capabilities: {} });

        await Promise.all([
          server.connect(serverTransport),
          client.connect(clientTransport),
        ]);

        await client.callTool({
          name: 'rks_fetch_raw',
          arguments: { projectId: PROJECT_ID, url: 'https://blocked.example.com/x' },
        });

        expect(fetchRawSpy, 'the handler never reached fetchRaw').toHaveBeenCalledTimes(1);

        // The whole point of GAP 1. Deleting `projectId: input.projectId` from the
        // handler reddens this; moving that line into any OTHER tool handler also
        // leaves it red, because only rks_fetch_raw is invoked here.
        expect(fetchRawSpy.mock.calls[0][1]).toEqual(
          expect.objectContaining({ projectId: PROJECT_ID }),
        );

        await client.close();
        await server.close();
      } finally {
        if (saved.root === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
        else process.env.ROUTEKIT_PROJECT_ROOT = saved.root;
        if (saved.id === undefined) delete process.env.ROUTEKIT_PROJECT_ID;
        else process.env.ROUTEKIT_PROJECT_ID = saved.id;
      }
    });
  });

  it('G1-2: the opts the handler builds actually attribute a real denial', async () => {
    // COMPANION to G1-1, never the sole proof. Region-anchored between two stable
    // landmarks and FAIL-LOUD on either, per tests/unit/bootstrap-fetchraw-defaults.test.mjs:123-124.
    const source = fs.readFileSync(SERVER_SRC, 'utf8');
    const start = source.indexOf('if (tool === "rks_fetch_raw")');
    expect(start, 'rks_fetch_raw handler landmark not found').toBeGreaterThan(-1);

    const end = source.indexOf('if (tool === ', start + 1);
    expect(end, 'handler region end landmark not found').toBeGreaterThan(start);

    const region = source.slice(start, end);
    expect(region).toContain('projectRoot');
    expect(region).toContain('projectId: input.projectId');

    // NARROW to the second argument of fetchRaw( — the options object literal ONLY.
    // A region-wide key scan would harvest `projectId` from the loadContext call two
    // lines above and pass GREEN against the UNFIXED handler. That vacuous green is
    // the exact failure this test exists to rule out.
    const callAt = region.indexOf('fetchRaw(');
    expect(callAt, 'fetchRaw( call not found in the handler region').toBeGreaterThan(-1);
    const open = region.indexOf('{', callAt);
    expect(open, 'fetchRaw options object literal not found').toBeGreaterThan(callAt);

    let depth = 0;
    let close = -1;
    for (let i = open; i < region.length; i += 1) {
      if (region[i] === '{') depth += 1;
      else if (region[i] === '}') {
        depth -= 1;
        if (depth === 0) { close = i; break; }
      }
    }
    expect(close, 'unbalanced fetchRaw options object literal').toBeGreaterThan(open);

    const inner = region.slice(open + 1, close);
    const parts = [];
    let buf = '';
    let d = 0;
    for (const ch of inner) {
      if ('{(['.includes(ch)) d += 1;
      else if ('})]'.includes(ch)) d -= 1;
      if (ch === ',' && d === 0) { parts.push(buf); buf = ''; } else buf += ch;
    }
    parts.push(buf);
    const derivedKeys = parts.map((s) => s.split(':')[0].trim()).filter(Boolean);

    expect(derivedKeys).toContain('projectId');

    // Replay the DERIVED key set through the real fetchRaw. projectId reaches the
    // emit ONLY if the handler's own object literal carries it.
    const { fetchRaw } = await vi.importActual(FETCH_RAW_MODULE);
    const available = {
      projectRoot: REPO_ROOT,
      projectId: 'test-proj',
      timeoutMs: 5000,
      maxBytes: 1024,
    };
    const opts = {};
    for (const key of derivedKeys) {
      if (key in available) opts[key] = available[key];
    }

    const collector = { emit: vi.fn() };
    const res = await fetchRaw('https://not-allowed.example.com/doc', {
      ...opts,
      allowedHosts: ['allowed.example.com'],
      mode: 'allowlist',
      collector,
      fetch: vi.fn(async () => ({ status: 200, ok: true })),
      resolveDns: async () => ['93.184.216.34'],
    });

    expect(res.ok).toBe(false);

    const denied = collector.emit.mock.calls.filter((c) => c[0] === 'agent.fetch-raw.denied');
    expect(denied).toHaveLength(1);
    // Positional contract is emit(type, projectId, payload) — slot 1 must not be null.
    expect(denied[0][1]).toBe('test-proj');
  });
});
