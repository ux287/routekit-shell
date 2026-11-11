/**
 * backlog.fix.fetchraw-denial-gap-closeout — GAP 2.
 *
 * External research degraded SILENTLY. When this project's egress policy refuses the
 * hosts a search returned, the governor writes its answer from search snippets alone and
 * the result is indistinguishable from "the internet did not have much on this". This is
 * the half of the defect a UAT tester actually sees.
 *
 * The prior story skipped this on faulty reasoning — that an `egress` field was
 * unpopulatable because runExternalResearch never fetches. It does not need to. It runs
 * its OWN host check over the source URLs; the point is to TELL A HUMAN the research was
 * degraded, not to retrieve the documents.
 *
 * Everything here runs with BRAVE_SEARCH_API_KEY and ANTHROPIC_API_KEY absent, no
 * network, and no LLM. That is only possible because each credential guard lives INSIDE
 * the dep it guards — a guard on the outer path ahead of the injection point would throw
 * before an injected dep could run, and none of the behavioral tests below could exist.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTempDir } from '../_helpers/with-temp-dir.mjs';
import {
  applyEgressWarning,
  runExternalResearch,
  ExternalResearchOutputSchema,
} from '../../packages/mcp-rks/src/agents/external-research.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT_SRC = path.join(
  REPO_ROOT, 'packages', 'mcp-rks', 'src', 'agents', 'external-research.mjs',
);

/** A source shaped to satisfy ExternalResearchOutputSchema — the result is parsed. */
const src = (url, i = 0) => ({ title: `Source ${i}`, url, snippet: `snippet ${i}` });

const ORIGINAL = 'The synthesized answer body, which must survive verbatim.';

// --- credential absence is a precondition, not an accident ---
let savedBrave;
let savedAnthropic;

beforeEach(() => {
  savedBrave = process.env.BRAVE_SEARCH_API_KEY;
  savedAnthropic = process.env.ANTHROPIC_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (savedBrave === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = savedBrave;
  if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropic;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The pure helper. No collector, no projectId, no telemetryId, no I/O.
// ---------------------------------------------------------------------------
describe('applyEgressWarning — pure egress preflight', () => {
  it('G2-3: is a named export and needs no key, no network and no LLM', () => {
    expect(typeof applyEgressWarning).toBe('function');
    expect(process.env.BRAVE_SEARCH_API_KEY).toBeUndefined();

    // Purity: same inputs, same outputs, and nothing emitted anywhere — the helper
    // has no collector to emit on. Implementing the preflight inline inside
    // runExternalResearch instead of exporting it makes this import undefined.
    const args = {
      answer: ORIGINAL,
      sources: [src('https://docs.allowed.com/a')],
      mode: 'allowlist',
      allowedHosts: ['docs.allowed.com'],
    };
    expect(applyEgressWarning(args)).toEqual(applyEgressWarning(args));
  });

  it('G2-4: partial denial returns the exact egress shape and names the refused host', () => {
    const out = applyEgressWarning({
      answer: ORIGINAL,
      sources: [src('https://docs.allowed.com/a', 1), src('https://blocked.example.com/b', 2)],
      mode: 'allowlist',
      allowedHosts: ['docs.allowed.com'],
    });

    expect(out.egress).toEqual({
      mode: 'allowlist',
      fetchableCount: 1,
      deniedHosts: ['blocked.example.com'],
    });

    // The banner must be actionable: what was refused, and where to change it.
    expect(out.answer).toContain('blocked.example.com');
    expect(out.answer).toContain('.rks/project.json');
    expect(out.answer).toContain('fetchRaw.allowedHosts');
  });

  it('G2-5: the banner is PREPENDED — position is the requirement', () => {
    const out = applyEgressWarning({
      answer: ORIGINAL,
      sources: [src('https://docs.allowed.com/a', 1), src('https://blocked.example.com/b', 2)],
      mode: 'allowlist',
      allowedHosts: ['docs.allowed.com'],
    });

    const bodyAt = out.answer.indexOf(ORIGINAL);
    expect(bodyAt, 'original answer body missing entirely').toBeGreaterThan(-1);
    expect(out.answer.indexOf('Egress notice')).toBeLessThan(bodyAt);
    expect(out.answer.includes(ORIGINAL)).toBe(true);

    // A warning appended below a 2000-word answer is a warning nobody reads.
    const banner = out.answer.slice(0, bodyAt);
    expect(out.answer).not.toBe(ORIGINAL + banner);
  });

  it('G2-6: total denial says the answer is snippets-only', () => {
    const out = applyEgressWarning({
      answer: ORIGINAL,
      sources: [src('https://a.example.com/x', 1), src('https://b.example.com/y', 2)],
      mode: 'allowlist',
      allowedHosts: ['docs.allowed.com'],
    });

    expect(out.egress.fetchableCount).toBe(0);
    expect(out.egress.deniedHosts).toEqual(['a.example.com', 'b.example.com']);

    // Durable phrases, not a pinned sentence — the wording will be edited.
    expect(out.answer).toMatch(/snippets only/i);
    expect(out.answer).toMatch(/egress/i);
  });

  it('G2-7: no false alarm — an all-allowed answer is byte-identical', () => {
    const sources = [src('https://docs.allowed.com/a', 1), src('https://api.allowed.com/b', 2)];
    const out = applyEgressWarning({
      answer: ORIGINAL,
      sources,
      mode: 'allowlist',
      allowedHosts: ['docs.allowed.com', 'api.allowed.com'],
    });

    // Strict identity, not toContain — a stray leading newline is a regression.
    expect(out.answer).toBe(ORIGINAL);
    expect(out.egress).toEqual({
      mode: 'allowlist',
      fetchableCount: sources.length,
      deniedHosts: [],
    });
  });

  it('G2-8: open mode does not nag, even against an empty allowlist', () => {
    const sources = [src('https://anything.example.com/a', 1), src('https://other.example.com/b', 2)];

    for (const allowedHosts of [[], undefined]) {
      const out = applyEgressWarning({ answer: ORIGINAL, sources, mode: 'open', allowedHosts });

      // hostAllowed() would deny every one of these against an empty list — the
      // mode bypass is what keeps an 'open' project from being warned about
      // egress it does not enforce.
      expect(out.answer).toBe(ORIGINAL);
      expect(out.egress.deniedHosts).toEqual([]);
      expect(out.egress.fetchableCount).toBe(sources.length);
    }
  });

  it('G2-10: never throws on degenerate input', () => {
    // An unparseable URL is neither fetchable nor deniable — it must not become a
    // phantom denial, and it must not throw.
    expect(
      applyEgressWarning({
        answer: ORIGINAL,
        sources: [{ title: 't', url: 'not a url', snippet: 's' }],
        mode: 'allowlist',
        allowedHosts: ['docs.allowed.com'],
      }).answer,
    ).toBe(ORIGINAL);

    expect(
      applyEgressWarning({
        answer: ORIGINAL, sources: [], mode: 'allowlist', allowedHosts: ['docs.allowed.com'],
      }).answer,
    ).toBe(ORIGINAL);

    // No allowlist array at all means no policy to evaluate. Never invent a denial
    // out of missing data.
    expect(
      applyEgressWarning({
        answer: ORIGINAL,
        sources: [src('https://anything.example.com/a')],
        mode: 'allowlist',
        allowedHosts: undefined,
      }).answer,
    ).toBe(ORIGINAL);
  });
});

// ---------------------------------------------------------------------------
// The output contract.
// ---------------------------------------------------------------------------
describe('ExternalResearchOutputSchema — egress field', () => {
  it('G2-1: egress is OPTIONAL', () => {
    // STRUCTURALLY required, not merely back-compat: the zero-sources early return
    // in runExternalResearch builds exactly this payload on a LIVE path, and a
    // required egress field would throw there.
    const parsed = ExternalResearchOutputSchema.parse({
      ok: true, answer: 'a', sources: [], telemetryId: 't',
    });

    expect(parsed).not.toHaveProperty('egress');
  });

  it('G2-2: egress round-trips intact when present', () => {
    const egress = { mode: 'allowlist', fetchableCount: 1, deniedHosts: ['blocked.example.com'] };
    const parsed = ExternalResearchOutputSchema.parse({
      ok: true, answer: 'a', sources: [], telemetryId: 't', egress,
    });

    expect(parsed.egress).toEqual(egress);
  });
});

// ---------------------------------------------------------------------------
// The production path. runExternalResearch OWNS the emit — the pure helper has no
// telemetryId (it is minted in the entry point) and no collector.
//
// process.cwd() is stubbed to a temp project so the egress posture under test is a
// fixture, not this repo's real .rks/project.json. loadContext() rejects the
// unregistered projectId, which is exactly the path that falls back to cwd.
// ---------------------------------------------------------------------------
describe('runExternalResearch — degraded egress on the real production path', () => {
  const PROJECT_ID = 'unregistered-egress-fixture-project';

  async function runWith(dir, { mode, allowedHosts, sources }) {
    fs.mkdirSync(path.join(dir, '.rks'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.rks', 'project.json'),
      JSON.stringify({ id: PROJECT_ID, fetchRaw: { mode, allowedHosts } }, null, 2),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    const collector = { emit: vi.fn() };
    const result = await runExternalResearch(
      { projectId: PROJECT_ID, query: 'what does the egress policy refuse' },
      {
        collector,
        searchFn: async () => sources,
        synthesizeFn: async () => ORIGINAL,
      },
    );

    const degraded = collector.emit.mock.calls.filter(
      (c) => c[0] === 'agent.external-research.degraded',
    );
    return { result, collector, degraded };
  }

  it('G2-11: the helper is actually WIRED IN — the returned answer carries the banner', async () => {
    await withTempDir('egress-wired', async (dir) => {
      const { result, degraded } = await runWith(dir, {
        mode: 'allowlist',
        allowedHosts: ['docs.allowed.com'],
        sources: [src('https://docs.allowed.com/a', 1), src('https://blocked.example.com/b', 2)],
      });

      // Proven BY EXECUTION. Deleting the applyEgressWarning call from
      // runExternalResearch while leaving the exported helper intact reddens
      // exactly this test — without it the whole GAP 2 suite is vacuous.
      expect(result.ok).toBe(true);
      expect(result.answer).toContain('Egress notice');
      expect(result.answer).toContain(ORIGINAL);
      expect(result.egress.deniedHosts).toEqual(['blocked.example.com']);
      expect(degraded).toHaveLength(1);
    });
  });

  it('G2-11: the preflight never fetches — it only inspects hosts', () => {
    // The one source-text check with no behavioral equivalent. The whole point of
    // the preflight is that it does NOT perform egress of its own.
    const source = fs.readFileSync(AGENT_SRC, 'utf8');
    expect(source.includes('fetchRaw('), 'the egress preflight must not fetch').toBe(false);
  });

  it('G2-9: partial and total denial each emit exactly one degraded event', async () => {
    for (const sources of [
      [src('https://docs.allowed.com/a', 1), src('https://blocked.example.com/b', 2)],
      [src('https://a.example.com/x', 1), src('https://b.example.com/y', 2)],
    ]) {
      await withTempDir('egress-degraded', async (dir) => {
        const { result, degraded } = await runWith(dir, {
          mode: 'allowlist', allowedHosts: ['docs.allowed.com'], sources,
        });

        expect(degraded).toHaveLength(1);

        // Positional contract: emit(type, projectId, payload). A vi.fn() accepts any
        // shape, so assert the SLOTS — emit(type, payload) would otherwise pass here
        // and land the payload in the projectId column in production.
        const [type, projectId, payload] = degraded[0];
        expect(type).toBe('agent.external-research.degraded');
        expect(projectId).toBe(PROJECT_ID);

        // telemetryId is minted inside the entry point, so only the entry point can
        // supply it — its presence proves the emit did not move into the pure helper.
        expect(payload.telemetryId).toBeTruthy();
        expect(payload.telemetryId).toBe(result.telemetryId);
        expect(payload.mode).toBe('allowlist');
        expect(payload.deniedHostCount).toBe(payload.deniedHosts.length);
        expect(payload.deniedHosts).toEqual(result.egress.deniedHosts);
      });
    }
  });

  it('G2-9: an all-allowed run and an open-mode run emit ZERO degraded events', async () => {
    const sources = [src('https://docs.allowed.com/a', 1), src('https://api.allowed.com/b', 2)];

    await withTempDir('egress-allowed', async (dir) => {
      const { result, degraded } = await runWith(dir, {
        mode: 'allowlist',
        allowedHosts: ['docs.allowed.com', 'api.allowed.com'],
        sources,
      });

      expect(degraded).toHaveLength(0);
      expect(result.answer).toBe(ORIGINAL);
    });

    await withTempDir('egress-open', async (dir) => {
      const { result, degraded } = await runWith(dir, {
        mode: 'open', allowedHosts: [], sources,
      });

      expect(degraded).toHaveLength(0);
      expect(result.answer).toBe(ORIGINAL);
    });
  });

  it('G2-10: widening the signature left the structured-failure contract intact', async () => {
    await withTempDir('egress-failure', async (dir) => {
      fs.mkdirSync(path.join(dir, '.rks'), { recursive: true });
      vi.spyOn(process, 'cwd').mockReturnValue(dir);

      const collector = { emit: vi.fn() };
      const result = await runExternalResearch(
        { projectId: PROJECT_ID, query: 'a query that will fail during search' },
        { collector, searchFn: async () => { throw new Error('search exploded'); } },
      );

      // AD #5: never throw, always a structured failure.
      expect(result).toMatchObject({
        ok: false, answer: '', sources: [], error: 'search exploded',
      });
      expect(result.telemetryId).toBeTruthy();
      expect(
        collector.emit.mock.calls.filter((c) => c[0] === 'agent.external-research.degraded'),
      ).toHaveLength(0);
    });
  });

  it('G2-10: a zero-source run returns early and emits no degraded event', async () => {
    await withTempDir('egress-empty', async (dir) => {
      const { result, degraded } = await runWith(dir, {
        mode: 'allowlist', allowedHosts: ['docs.allowed.com'], sources: [],
      });

      expect(result.ok).toBe(true);
      expect(result.answer).toBe('No results found for the query.');
      expect(result).not.toHaveProperty('egress');
      expect(degraded).toHaveLength(0);
    });
  });
});
