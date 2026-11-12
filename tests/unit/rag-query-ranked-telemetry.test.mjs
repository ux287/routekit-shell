/**
 * backlog.fix.rag-query-ranked-telemetry: runRagQuery's rag.query event carries k, intent, ranked
 * (after the stale-path filter), windowRows and candidates, and keeps its existing fields. query()
 * and the RAG path loader are mocked the same way tests/unit/rag-query-role-k-cap.test.mjs mocks
 * them; the collector is injected with setRagHostHooks as tests/unit/rag-init-reset.test.mjs does.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../packages/rag/src/query.mjs", () => ({ query: (...args) => queryMock(...args) }));
vi.mock("../../packages/rag/src/rag-config-loader.mjs", () => ({
  getRagPathsFor: vi.fn(async () => ({ notes: "/nonexistent/rag/notes" })),
}));

import { runRagQuery, setRagHostHooks } from "../../packages/rag/src/tools.mjs";
import { checkStateAllowed } from "../../packages/mcp-rks/src/shared/governor-state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RANKED_KEYS = ["hybridRank", "keywordScore", "path", "rank", "score", "semanticScore", "slug"];

let tmp;
let events;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-ranked-telemetry-"));
  fs.writeFileSync(path.join(tmp, "doc.a.md"), "a\n", "utf8");
  fs.writeFileSync(path.join(tmp, "doc.b.md"), "b\n", "utf8");
});

afterAll(() => {
  setRagHostHooks({ getTelemetryCollector: () => ({ emit() {} }) });
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  events = [];
  setRagHostHooks({ getTelemetryCollector: () => ({ emit: (type, _projectId, data) => events.push({ type, data }) }) });
  queryMock.mockReset();
});

const match = (slug, extra = {}) => ({
  slug,
  path: `${slug}.md`,
  text: `${slug} text`,
  score: 0.5,
  hybridRank: 1,
  semanticScore: 0.4,
  keywordScore: 0.1,
  ...extra,
});
const ragQueryEvent = () => events.find((e) => e.type === "rag.query")?.data;

describe("rag.query ranked telemetry (runRagQuery)", () => {
  it("records the k and intent query() applied from candidateTrace, not the caller arguments", async () => {
    // The mock deliberately reports applied values that differ from the arguments, so the test
    // proves the event is sourced from candidateTrace and not from options.k / options.intent.
    queryMock.mockResolvedValue({ ok: true, matches: [], candidateTrace: { k: 5, intent: "neutral", windowRows: 0, candidates: [] } });
    await runRagQuery(tmp, { q: "probe", k: 7 });
    expect(queryMock.mock.calls[0][0].k).toBe(7);
    expect(queryMock.mock.calls[0][0].intent).toBeUndefined();
    expect(ragQueryEvent().k).toBe(5);
    expect(ragQueryEvent().intent).toBe("neutral");
    events = [];
    queryMock.mockResolvedValue({ ok: true, matches: [] });
    await runRagQuery(tmp, { q: "probe", k: 3, intent: "planning" });
    expect(ragQueryEvent().k).toBeNull();
    expect(ragQueryEvent().intent).toBeNull();
  });

  it("ranked has one entry per returned match in returned order with no text", async () => {
    queryMock.mockResolvedValue({
      ok: true,
      matches: [match("doc.a", { hybridRank: 2, score: 0.9 }), match("doc.b", { hybridRank: 1, score: 0.8 })],
    });
    await runRagQuery(tmp, { q: "probe", k: 5 });
    const { ranked } = ragQueryEvent();
    expect(ranked.map((r) => r.slug)).toEqual(["doc.a", "doc.b"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
    expect(ranked[0]).toMatchObject({ path: "doc.a.md", hybridRank: 2, semanticScore: 0.4, keywordScore: 0.1, score: 0.9 });
    for (const r of ranked) expect(Object.keys(r).sort()).toEqual(RANKED_KEYS);
  });

  it("ranked excludes a stale-path match and its length equals resultsReturned", async () => {
    queryMock.mockResolvedValue({ ok: true, matches: [match("doc.a"), match("doc.gone"), match("doc.b")] });
    await runRagQuery(tmp, { q: "probe", k: 5 });
    const data = ragQueryEvent();
    expect(data.ranked.map((r) => r.slug)).toEqual(["doc.a", "doc.b"]);
    expect(data.ranked.length).toBe(data.resultsReturned);
  });

  it("copies windowRows and candidates from candidateTrace, and still emits without one", async () => {
    const candidates = [{ semanticRank: 1, id: "doc.a", path: "doc.a.md", semanticScore: 0.4 }];
    queryMock.mockResolvedValue({ ok: true, matches: [match("doc.a")], candidateTrace: { windowRows: 4, candidates } });
    await runRagQuery(tmp, { q: "probe", k: 5 });
    expect(ragQueryEvent().windowRows).toBe(4);
    expect(ragQueryEvent().candidates).toEqual(candidates);
    events = [];
    queryMock.mockResolvedValue({ ok: true, matches: [match("doc.a")] });
    await runRagQuery(tmp, { q: "probe", k: 5 });
    expect(ragQueryEvent()).toMatchObject({ query: "probe", resultsReturned: 1, indexSize: null });
  });

  it("keeps the existing query, resultsReturned, durationMs and indexSize fields", async () => {
    queryMock.mockResolvedValue({ ok: true, matches: [match("doc.a")] });
    const longQ = "x".repeat(250);
    await runRagQuery(tmp, { q: longQ, k: 5 });
    const data = ragQueryEvent();
    expect(data.query).toBe(longQ.slice(0, 200));
    expect(data.resultsReturned).toBe(1);
    expect(typeof data.durationMs).toBe("number");
    expect(data.indexSize).toBeNull();
  });
});

describe("Governor surface for rks_rag_query", () => {
  it("is absent from governor.md and admitted only in open init and writing", () => {
    const governorMd = fs.readFileSync(path.join(REPO_ROOT, ".claude/agents/governor.md"), "utf8");
    expect(governorMd).not.toContain("rks_rag_query");
    expect(checkStateAllowed("open", "init", "rks_rag_query").allowed).toBe(true);
    expect(checkStateAllowed("open", "writing", "rks_rag_query").allowed).toBe(true);
    for (const state of ["researching", "concern-separating", "test-file-scanning"]) {
      expect(checkStateAllowed("open", state, "rks_rag_query").allowed, state).toBe(false);
    }
  });
});
