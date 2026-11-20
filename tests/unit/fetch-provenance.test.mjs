/**
 * Session-scoped, URL-exact fetch provenance witnesses (backlog.feat.fetch-raw-url-provenance-allow).
 * Unit tier: no subprocess, no network. Sessions come from governor-token.mjs (createSession /
 * endSession) under a temp project root (setProjectRoot + resetToken, as AB-TR13 does). fetchRaw
 * is driven with injected fetch and resolveDns only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { normalizeFetchUrl, recordSurfacedUrls, isSurfacedUrl, surfacedPredicateFor, surfacedRecorderFor } from "../../packages/mcp-rks/src/shared/fetch-provenance.mjs";
import { fetchRaw } from "../../packages/mcp-rks/src/agents/fetch-raw.mjs";
import { createSession, endSession, resetToken, setProjectRoot } from "../../packages/mcp-rks/src/shared/governor-token.mjs";

const PROJECT_ID = "fetch-provenance-unit";
const PROV_REL = path.join(".rks", "session", "fetch-provenance");

let ROOT;
beforeEach(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-fetch-prov-")));
  setProjectRoot(ROOT);
  resetToken();
});
afterEach(() => {
  resetToken();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const live = () => createSession({ projectId: PROJECT_ID, flowType: "open" }).token;
const fileOf = (token) => path.join(ROOT, PROV_REL, `${token}.json`);
const readBack = (token) => JSON.parse(fs.readFileSync(fileOf(token), "utf8")).urls;

describe("normalizeFetchUrl", () => {
  it("drops the fragment, folds host case and default port, and refuses non-https or unparseable input", () => {
    expect(normalizeFetchUrl("https://Docs.Example.COM:443/Path/To?x=1#section-2")).toBe("https://docs.example.com/Path/To?x=1");
    expect(normalizeFetchUrl("https://docs.example.com/a#")).toBe("https://docs.example.com/a");
    // Returns the WHATWG href.
    const raw = "https://docs.example.com:443/a b?q=1";
    expect(normalizeFetchUrl(raw)).toBe(new URL("https://docs.example.com/a b?q=1").href);
    // A non-default port is kept.
    expect(normalizeFetchUrl("https://docs.example.com:8443/a")).toBe("https://docs.example.com:8443/a");
    expect(normalizeFetchUrl("http://docs.example.com/a")).toBeNull();
    expect(normalizeFetchUrl("not a url")).toBeNull();
    expect(normalizeFetchUrl(undefined)).toBeNull();
  });

  it("compares path and query exactly: no reordering and no trailing-slash folding", () => {
    const base = normalizeFetchUrl("https://docs.example.com/a?x=1&y=2");
    expect(normalizeFetchUrl("https://docs.example.com/a?y=2&x=1")).not.toBe(base);
    expect(normalizeFetchUrl("https://docs.example.com/a?x=1&y=2&z=3")).not.toBe(base);
    expect(normalizeFetchUrl("https://docs.example.com/a/?x=1&y=2")).not.toBe(base);
    expect(normalizeFetchUrl("https://docs.example.com/a/")).not.toBe(normalizeFetchUrl("https://docs.example.com/a"));
  });
});

describe("surfaced-URL store", () => {
  it("admits the exact recorded URL for a live session, refuses any modification, and returns the URLs read back from the file", () => {
    const token = live();
    const URL_A = "https://surfaced.example.org/doc?id=7";
    const URL_B = "https://Other.Example.net:443/b#frag";
    const out = recordSurfacedUrls(ROOT, token, [URL_A, URL_B]);
    const persisted = readBack(token);
    // urls: exactly the normalized inputs found in the file on read-back; recorded is its length.
    const expected = [URL_A, URL_B].map(normalizeFetchUrl).filter((u) => persisted.includes(u));
    expect(expected).toEqual([URL_A, "https://other.example.net/b"]);
    expect(out.urls).toEqual(expected);
    expect(out.recorded).toBe(out.urls.length);

    expect(isSurfacedUrl(ROOT, token, URL_A)).toBe(true);
    expect(isSurfacedUrl(ROOT, token, `${URL_A}#anchor`)).toBe(true);
    expect(isSurfacedUrl(ROOT, token, `${URL_A}&extra=1`)).toBe(false);
    expect(isSurfacedUrl(ROOT, token, "https://surfaced.example.org/other?id=7")).toBe(false);

    // A repeat call merges: nothing duplicated, and the read-back still reports the inputs.
    const again = recordSurfacedUrls(ROOT, token, [URL_A]);
    expect(again).toEqual({ recorded: 1, urls: [URL_A] });
    expect(readBack(token)).toEqual([URL_A, "https://other.example.net/b"]);
  });

  it("refuses a URL surfaced in session A for session B and after session A ends", () => {
    const a = live();
    const b = live();
    const URL_A = "https://surfaced.example.org/session-a";
    expect(recordSurfacedUrls(ROOT, a, [URL_A]).recorded).toBe(1);
    expect(isSurfacedUrl(ROOT, a, URL_A)).toBe(true);
    expect(isSurfacedUrl(ROOT, b, URL_A)).toBe(false);
    endSession(a);
    // The file survives, but a dead token never admits.
    expect(fs.existsSync(fileOf(a))).toBe(true);
    expect(isSurfacedUrl(ROOT, a, URL_A)).toBe(false);
  });

  it("with no token records nothing, writes no file and admits nothing", () => {
    const URL_A = "https://surfaced.example.org/none";
    for (const token of [undefined, null, ""]) {
      expect(recordSurfacedUrls(ROOT, token, [URL_A]), String(token)).toEqual({ recorded: 0, urls: [] });
      expect(isSurfacedUrl(ROOT, token, URL_A), String(token)).toBe(false);
    }
    expect(fs.existsSync(path.join(ROOT, PROV_REL))).toBe(false);
  });

  it("never throws and records only https URLs", () => {
    const token = live();
    // Non-array urls and non-string entries.
    for (const urls of [undefined, null, "https://surfaced.example.org/str", 42, { url: "x" }]) {
      expect(() => recordSurfacedUrls(ROOT, token, urls)).not.toThrow();
      expect(recordSurfacedUrls(ROOT, token, urls)).toEqual({ recorded: 0, urls: [] });
    }
    const mixed = recordSurfacedUrls(ROOT, token, [7, null, { href: "https://x.example" }, "http://plain.example.org/a", "not a url", "https://ok.example.org/a"]);
    expect(mixed).toEqual({ recorded: 1, urls: ["https://ok.example.org/a"] });
    expect(isSurfacedUrl(ROOT, token, "http://plain.example.org/a")).toBe(false);
    expect(isSurfacedUrl(ROOT, token, "not a url")).toBe(false);
    expect(readBack(token)).toEqual(["https://ok.example.org/a"]);

    // Unwritable project root: a regular FILE where the root directory should be.
    const fileRoot = path.join(ROOT, "not-a-dir");
    fs.writeFileSync(fileRoot, "x");
    let res;
    expect(() => { res = recordSurfacedUrls(fileRoot, token, ["https://ok.example.org/b"]); }).not.toThrow();
    expect(res).toEqual({ recorded: 0, urls: [] });
    expect(isSurfacedUrl(fileRoot, token, "https://ok.example.org/b")).toBe(false);
    // Degenerate roots.
    expect(() => recordSurfacedUrls(undefined, token, ["https://ok.example.org/c"])).not.toThrow();
    expect(recordSurfacedUrls(undefined, token, ["https://ok.example.org/c"])).toEqual({ recorded: 0, urls: [] });
  });

  it("a URL reached by fetchRaw, including a redirect target, is never added to the set", async () => {
    const token = live();
    const SURFACED = "https://surfaced.example.org/start";
    const FINAL = "https://cdn.elsewhere.example.net/final";
    recordSurfacedUrls(ROOT, token, [SURFACED]);
    const before = fs.readFileSync(fileOf(token));

    const responses = [
      { status: 302, ok: false, headers: { get: (k) => (String(k).toLowerCase() === "location" ? FINAL : null) } },
      { status: 200, ok: true, headers: { get: () => null }, async text() { return `see ${"https://linked.example.com/next"}`; } },
    ];
    const fetch = vi.fn(async () => responses.shift());
    const res = await fetchRaw(SURFACED, {
      allowedHosts: [],
      mode: "allowlist",
      isSurfaced: surfacedPredicateFor(token, ROOT),
      fetch,
      resolveDns: async () => ["93.184.216.34"],
      cacheDir: path.join(ROOT, "cache"),
      recordProvenance: () => {},
      collector: { emit: () => {} },
    });
    expect(res.ok).toBe(true);
    expect(res.allowedBy).toBe("provenance-redirect");
    expect(res.url).toBe(FINAL);
    expect(fetch).toHaveBeenCalledTimes(2);

    expect(fs.readFileSync(fileOf(token)).equals(before)).toBe(true);
    expect(isSurfacedUrl(ROOT, token, FINAL)).toBe(false);
    expect(isSurfacedUrl(ROOT, token, "https://linked.example.com/next")).toBe(false);
    expect(isSurfacedUrl(ROOT, token, SURFACED)).toBe(true);
  });

  it("the injected builders: surfacedPredicateFor needs a token and surfacedRecorderFor needs a live session", () => {
    for (const token of [undefined, null, ""]) {
      expect(surfacedPredicateFor(token, ROOT), String(token)).toBeUndefined();
      expect(surfacedRecorderFor(token, ROOT), String(token)).toBeUndefined();
    }
    const token = live();
    const URL_A = "https://surfaced.example.org/builder";
    const URL_B = "https://surfaced.example.org/builder-b";

    const recorder = surfacedRecorderFor(token, ROOT);
    expect(typeof recorder).toBe("function");
    const out = recorder([URL_A]);
    expect(out).toEqual(recordSurfacedUrls(ROOT, token, [URL_A]));
    expect(out).toEqual({ recorded: 1, urls: [URL_A] });
    expect(readBack(token)).toEqual([URL_A]);

    const predicate = surfacedPredicateFor(token, ROOT);
    expect(typeof predicate).toBe("function");
    for (const url of [URL_A, URL_B, `${URL_A}#x`, "http://surfaced.example.org/builder"]) {
      expect(predicate(url), url).toBe(isSurfacedUrl(ROOT, token, url));
    }
    expect(predicate(URL_A)).toBe(true);
    expect(predicate(URL_B)).toBe(false);

    // A token with no session still gets a predicate (it checks liveness per call), but no recorder.
    const ghost = "0f0f0f0f-dead-4bad-8bad-000000000000";
    expect(typeof surfacedPredicateFor(ghost, ROOT)).toBe("function");
    expect(surfacedPredicateFor(ghost, ROOT)(URL_A)).toBe(false);
    expect(surfacedRecorderFor(ghost, ROOT)).toBeUndefined();

    endSession(token);
    expect(surfacedRecorderFor(token, ROOT)).toBeUndefined();
    expect(predicate(URL_A)).toBe(false);
  });
});
