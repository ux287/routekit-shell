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
import { isSurfacedUrl, surfacedRecorderFor } from '../../packages/mcp-rks/src/shared/fetch-provenance.mjs';
import { createSession, resetToken, setProjectRoot } from '../../packages/mcp-rks/src/shared/governor-token.mjs';

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
      deniedSourceCount: 1,
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
    expect(out.answer).toMatch(/snippets/i);
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
      deniedSourceCount: 0,
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

  it('G2-12: only sources whose normalized URL is in the observed provenance set are not reported as refused, and egress carries the optional split', () => {
    // backlog.feat.fetch-raw-url-provenance-allow. provenanceUrls is the recorder's read-back:
    // normalized URLs observed persisted, never the URLs it meant to write.
    const sources = [
      src('https://docs.allowed.com/a', 1),
      src('https://surfaced.example.com/p?q=1#frag', 2),
      src('https://other.example.net/x', 3),
    ];
    const base = { answer: ORIGINAL, sources, mode: 'allowlist', allowedHosts: ['docs.allowed.com'] };

    // Every non-allowlisted source is in the set: byte-identical answer, no denial, split present.
    const all = applyEgressWarning({
      ...base,
      provenanceUrls: new Set(['https://surfaced.example.com/p?q=1', 'https://other.example.net/x']),
    });
    expect(all.answer).toBe(ORIGINAL);
    expect(all.answer).not.toContain('Egress notice');
    expect(all.egress).toEqual({
      mode: 'allowlist',
      fetchableCount: 3,
      deniedHosts: [],
      deniedSourceCount: 0,
      fetchableBy: { allowlist: 1, provenance: 2 },
    });

    // A source whose URL is absent from the set is still reported refused, even on a host
    // that has another URL in the set (URL-exact, never host-level).
    const some = applyEgressWarning({
      ...base,
      sources: [...sources, src('https://surfaced.example.com/p?q=2', 4)],
      provenanceUrls: ['https://surfaced.example.com/p?q=1'],
    });
    expect(some.egress.deniedHosts).toEqual(['other.example.net', 'surfaced.example.com']);
    expect(some.egress.deniedSourceCount).toBe(2);
    expect(some.egress.fetchableBy).toEqual({ allowlist: 1, provenance: 1 });
    expect(some.answer).toContain('Egress notice');
    expect(some.answer).toContain('other.example.net');

    // provenanceUrls absent or empty: identical to the allowlist-only preflight, no split field.
    const without = applyEgressWarning(base);
    for (const provenanceUrls of [undefined, [], new Set()]) {
      const out = applyEgressWarning({ ...base, provenanceUrls });
      expect(out).toEqual(without);
      expect(out.egress).not.toHaveProperty('fetchableBy');
    }
    expect(without.egress).toEqual({
      mode: 'allowlist', fetchableCount: 1, deniedHosts: ['surfaced.example.com', 'other.example.net'], deniedSourceCount: 2,
    });
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

  it('G2-2b: deniedSourceCount is optional and round-trips when present', () => {
    const base = { ok: true, answer: 'a', sources: [], telemetryId: 't' };

    // Present: survives parsing intact (zod strips undeclared keys, so an
    // undeclared field would vanish here).
    const withCount = {
      mode: 'allowlist', fetchableCount: 1, deniedHosts: ['blocked.example.com'], deniedSourceCount: 2,
    };
    expect(ExternalResearchOutputSchema.parse({ ...base, egress: withCount }).egress).toEqual(withCount);

    // Absent: still accepted — the field is additive, not required.
    const without = { mode: 'allowlist', fetchableCount: 1, deniedHosts: ['blocked.example.com'] };
    const parsed = ExternalResearchOutputSchema.parse({ ...base, egress: without });
    expect(parsed.egress).toEqual(without);
    expect(parsed.egress).not.toHaveProperty('deniedSourceCount');
  });

  it('G2-14: egress with the allowlist/provenance split round-trips intact and egress without it is still accepted', () => {
    const base = { ok: true, answer: 'a', sources: [], telemetryId: 't' };
    const withSplit = {
      mode: 'allowlist', fetchableCount: 3, deniedHosts: [], deniedSourceCount: 0,
      fetchableBy: { allowlist: 1, provenance: 2 },
    };
    expect(ExternalResearchOutputSchema.parse({ ...base, egress: withSplit }).egress).toEqual(withSplit);

    const without = { mode: 'allowlist', fetchableCount: 1, deniedHosts: [], deniedSourceCount: 0 };
    const parsed = ExternalResearchOutputSchema.parse({ ...base, egress: without });
    expect(parsed.egress).toEqual(without);
    expect(parsed.egress).not.toHaveProperty('fetchableBy');
  });
});

// ---------------------------------------------------------------------------
// The banner reports what the egress policy WOULD do to a fetch that never runs.
// runExternalResearch fetches no pages and synthesis receives every source, so the
// banner may not claim a refusal happened or that inputs were filtered.
// ---------------------------------------------------------------------------
describe('applyEgressWarning — banner states only observed facts', () => {
  const FORBIDDEN = ['was refused', 'were refused', 'draws only on the sources that were permitted'];

  const total = () => applyEgressWarning({
    answer: ORIGINAL,
    sources: [src('https://a.example.com/x', 1), src('https://b.example.com/y', 2)],
    mode: 'allowlist',
    allowedHosts: ['docs.allowed.com'],
  });

  const partial = () => applyEgressWarning({
    answer: ORIGINAL,
    sources: [
      src('https://docs.allowed.com/a', 1),
      src('https://blocked.example.com/b', 2),
      src('https://blocked.example.com/c', 3),
    ],
    mode: 'allowlist',
    allowedHosts: ['docs.allowed.com'],
  });

  /** The banner alone — everything before the untouched answer body. */
  const bannerOf = (out) => {
    const at = out.answer.indexOf(ORIGINAL);
    expect(at, 'answer body missing').toBeGreaterThan(0);
    return out.answer.slice(0, at);
  };

  it('E1: total-denial banner makes no refusal or input-filter claim', () => {
    const out = total();
    expect(out.egress.fetchableCount).toBe(0);
    const banner = bannerOf(out);
    for (const phrase of FORBIDDEN) expect(banner).not.toContain(phrase);
  });

  it('E2: partial-denial banner makes no refusal or input-filter claim', () => {
    const out = partial();
    expect(out.egress.fetchableCount).toBeGreaterThan(0);
    const banner = bannerOf(out);
    for (const phrase of FORBIDDEN) expect(banner).not.toContain(phrase);
  });

  it('E3: both banners say no page was fetched and the answer used all M sources', () => {
    for (const [out, m] of [[total(), 2], [partial(), 3]]) {
      const banner = bannerOf(out);
      expect(banner).toMatch(/fetches no pages/i);
      expect(banner).toContain(`snippets of all ${m} sources`);
    }
  });

  it('E4: partial D of M counts denied sources and names distinct hosts separately', () => {
    const out = partial();
    expect(out.egress.deniedSourceCount).toBe(2);
    expect(out.egress.deniedHosts).toHaveLength(1);

    const banner = bannerOf(out);
    // Numerator and denominator share one unit: denied SOURCES over total SOURCES.
    expect(banner).toContain('2 of 3 sources');
    // The distinct-host count is named on its own, not mixed into "D of M".
    expect(banner).toContain('1 distinct host');
    expect(banner).not.toContain('1 of 3');
  });

  it('E5: total-denial banner names every denied host and points at fetchRaw.allowedHosts', () => {
    const out = total();
    const banner = bannerOf(out);
    for (const host of out.egress.deniedHosts) expect(banner).toContain(host);
    expect(out.egress.deniedHosts).toEqual(['a.example.com', 'b.example.com']);
    expect(banner).toContain('fetchRaw.allowedHosts');
    expect(banner).toContain('.rks/project.json');
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

        // Self-contained "N of M": the degraded event alone carries the totals.
        expect(payload.sourceCount).toBe(sources.length);
        expect(payload.fetchableCount).toBe(result.egress.fetchableCount);
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

  // backlog.feat.fetch-raw-url-provenance-allow
  const writeProject = (dir) => {
    fs.mkdirSync(path.join(dir, '.rks'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.rks', 'project.json'),
      JSON.stringify({ id: PROJECT_ID, fetchRaw: { mode: 'allowlist', allowedHosts: ['docs.allowed.com'] } }, null, 2),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  };
  const PROV_SOURCES = [
    src('https://docs.allowed.com/a', 1),
    src('https://blocked.example.com/b', 2),
    src('https://other.example.net/c', 3),
  ];

  it('G2-13: the recorder runs once after synthesis and before the banner, and its persisted URLs suppress the banner and degraded events', async () => {
    await withTempDir('egress-provenance', async (dir) => {
      writeProject(dir);
      setProjectRoot(dir);
      resetToken();
      try {
        const token = createSession({ projectId: PROJECT_ID, flowType: 'open' }).token;
        const order = [];
        const realRecorder = surfacedRecorderFor(token, dir);
        const recordSurfaced = vi.fn((urls) => { order.push('record'); return realRecorder(urls); });
        const collector = { emit: vi.fn() };
        const result = await runExternalResearch(
          { projectId: PROJECT_ID, query: 'what does provenance admit' },
          {
            collector,
            searchFn: async () => { order.push('search'); return PROV_SOURCES; },
            synthesizeFn: async () => { order.push('synthesize'); return ORIGINAL; },
            recordSurfaced,
          },
        );

        expect(recordSurfaced).toHaveBeenCalledTimes(1);
        expect(recordSurfaced.mock.calls[0][0]).toEqual(PROV_SOURCES.map((s) => s.url));
        expect(order).toEqual(['search', 'synthesize', 'record']);
        // Persisted: the provenance file holds them, so the session admits them.
        for (const s of PROV_SOURCES) expect(isSurfacedUrl(dir, token, s.url), s.url).toBe(true);
        // Before the banner: the banner consumed the recorder's read-back.
        expect(result.ok).toBe(true);
        expect(result.answer).toBe(ORIGINAL);
        expect(result.egress).toEqual({
          mode: 'allowlist', fetchableCount: 3, deniedHosts: [], deniedSourceCount: 0,
          fetchableBy: { allowlist: 1, provenance: 2 },
        });
        expect(collector.emit.mock.calls.filter((c) => c[0] === 'agent.external-research.degraded')).toHaveLength(0);

        // A synthesis failure never reaches the recorder.
        const failing = vi.fn(() => ({ recorded: 0, urls: [] }));
        const failed = await runExternalResearch(
          { projectId: PROJECT_ID, query: 'a synthesis that will fail' },
          {
            collector: { emit: vi.fn() },
            searchFn: async () => PROV_SOURCES,
            synthesizeFn: async () => { throw new Error('synthesis exploded'); },
            recordSurfaced: failing,
          },
        );
        expect(failed.ok).toBe(false);
        expect(failing).not.toHaveBeenCalled();
      } finally {
        resetToken();
      }
    });
  });

  it('G2-15: a recorder that persists nothing yields output identical to no recorder', async () => {
    await withTempDir('egress-provenance-empty', async (dir) => {
      writeProject(dir);
      const run = async (extra) => {
        const collector = { emit: vi.fn() };
        const result = await runExternalResearch(
          { projectId: PROJECT_ID, query: 'what does provenance admit' },
          { collector, searchFn: async () => PROV_SOURCES, synthesizeFn: async () => ORIGINAL, ...extra },
        );
        const degraded = collector.emit.mock.calls
          .filter((c) => c[0] === 'agent.external-research.degraded')
          .map(([type, pid, { telemetryId, ...rest }]) => [type, pid, rest]);
        return { result, degraded };
      };
      const recordSurfaced = vi.fn(() => ({ recorded: 0, urls: [] }));
      const withEmpty = await run({ recordSurfaced });
      const without = await run({});

      expect(recordSurfaced).toHaveBeenCalledTimes(1);
      expect(withEmpty.result.answer).toBe(without.result.answer);
      expect(withEmpty.result.answer).toContain('Egress notice');
      expect(withEmpty.result.egress.deniedHosts).toEqual(without.result.egress.deniedHosts);
      expect(withEmpty.result.egress).toEqual(without.result.egress);
      expect(withEmpty.result.egress).not.toHaveProperty('fetchableBy');
      expect(withEmpty.degraded).toEqual(without.degraded);
      expect(withEmpty.degraded).toHaveLength(1);
    });
  });
});
