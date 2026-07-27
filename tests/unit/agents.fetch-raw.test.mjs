/**
 * rks_fetch_raw security + provenance witnesses (backlog.feat.rks-fetch-raw).
 *
 * All network + DNS are injected (opts.fetch / opts.resolveDns) — no real egress. The
 * load-bearing witnesses assert that a denied request makes NO network call, that SSRF
 * targets are blocked, and that the write-ledger is recorded on success only.
 */
import { describe, it, expect, vi } from "vitest";
import path from "path";
import fs from "fs";
import { withTempDir } from "../_helpers/with-temp-dir.mjs";
import {
  fetchRaw,
  isBlockedIp,
  hostAllowed,
  loadAllowedHosts,
  loadFetchMode,
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
} from "../../packages/mcp-rks/src/agents/fetch-raw.mjs";

// --- transport mock ---
function mockResponse({ status = 200, body = "hello", location = null, headers = {} } = {}) {
  const hmap = new Map(Object.entries({ ...(location ? { location } : {}), ...headers }));
  return {
    status,
    ok: status >= 200 && status < 400,
    headers: { get: (k) => hmap.get(String(k).toLowerCase()) ?? null },
    async text() {
      return body;
    },
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new TextEncoder().encode(body) };
          },
          async cancel() {},
        };
      },
    },
  };
}
// Returns a mock fetch fn that records its calls and yields queued responses in order.
function mkFetch(responses) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls = [];
  const fn = vi.fn(async (target, init) => {
    calls.push({ target, init });
    return queue.shift() ?? mockResponse({});
  });
  fn.calls = calls;
  return fn;
}
const publicDns = async () => ["93.184.216.34"]; // example.com public IP
const ALLOW = ["example.com"];

describe("hostAllowed — default-deny + patterns", () => {
  it("empty/absent allowlist denies everything", () => {
    expect(hostAllowed("example.com", [])).toBe(false);
    expect(hostAllowed("example.com", undefined)).toBe(false);
  });
  it("exact, *.sub and .sub patterns match; others do not", () => {
    expect(hostAllowed("example.com", ["example.com"])).toBe(true);
    expect(hostAllowed("api.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("api.example.com", [".example.com"])).toBe(true);
    expect(hostAllowed("evil.com", ["example.com"])).toBe(false);
    expect(hostAllowed("notexample.com", ["*.example.com"])).toBe(false);
  });
});

describe("isBlockedIp — SSRF ranges", () => {
  it("blocks loopback / private / link-local (incl 169.254.169.254) / ULA / mapped", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });
  it("allows public IPs", () => {
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:2800:220:1::"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
  it("blocks non-IP junk", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
  });
});

describe("fetchRaw — allowlist default-deny (no network on deny)", () => {
  it("non-allowlisted host: ok:false + NO fetch call", async () => {
    const fetch = mkFetch([mockResponse({})]);
    const record = vi.fn();
    const r = await fetchRaw("https://evil.com/x", { allowedHosts: ALLOW, fetch, resolveDns: publicDns, recordProvenance: record });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("host_not_allowlisted");
    expect(fetch).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
  it("empty allowlist denies an otherwise-fine URL, no fetch", async () => {
    const fetch = mkFetch([mockResponse({})]);
    const r = await fetchRaw("https://example.com/x", { allowedHosts: [], fetch, resolveDns: publicDns });
    expect(r.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  // backlog.fix.fetch-raw-uninvocable-research-gov — self-documenting deny.
  // A child-project agent that hits the default-deny must learn how to fix it WITHOUT
  // asking the rks shell: name the offending host, the exact config key, and that the
  // project owns its own allowlist.
  it("host_not_allowlisted message is self-documenting (names host + .rks/project.json + the key)", async () => {
    const fetch = mkFetch([mockResponse({})]);
    const r = await fetchRaw("https://api.notallowed.dev/x", { allowedHosts: ALLOW, fetch, resolveDns: publicDns });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("host_not_allowlisted");
    expect(r.message).toContain("api.notallowed.dev"); // the offending host
    expect(r.message).toContain("fetchRaw.allowedHosts"); // the config key
    expect(r.message).toContain(".rks/project.json"); // where the child edits it
    expect(r.message).toMatch(/own/i); // "this project's own" / "each project owns"
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("fetchRaw — scheme + SSRF gates (no network on deny)", () => {
  it("http:// rejected, no fetch", async () => {
    const fetch = mkFetch([mockResponse({})]);
    const r = await fetchRaw("http://example.com/x", { allowedHosts: ALLOW, fetch, resolveDns: publicDns });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("scheme_denied");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("allowlisted host resolving to an internal IP is SSRF-blocked, no fetch", async () => {
    const fetch = mkFetch([mockResponse({})]);
    const record = vi.fn();
    const r = await fetchRaw("https://example.com/x", { allowedHosts: ALLOW, fetch, resolveDns: async () => ["169.254.169.254"], recordProvenance: record });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ssrf_blocked");
    expect(fetch).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

// backlog.feat.fetch-raw-open-mode — the casual per-project egress posture.
// 'open' bypasses ONLY the host allowlist; the SSRF + https-only + GET-only floor is intact.
describe("loadFetchMode — fail-closed posture read", () => {
  const write = (dir, obj) => {
    fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".rks", "project.json"), JSON.stringify(obj));
  };
  it("returns 'open' ONLY for the exact string fetchRaw.mode === 'open'", async () => {
    await withTempDir("fm-open-", async (dir) => {
      write(dir, { fetchRaw: { mode: "open" } });
      expect(loadFetchMode(dir)).toBe("open");
    });
  });
  it("FAIL-CLOSED: absent / wrong-case / junk / non-string / no-fetchRaw all fall back to 'allowlist'", async () => {
    const cases = [
      { fetchRaw: { mode: "allowlist" } },
      { fetchRaw: { mode: "OPEN" } }, // wrong case
      { fetchRaw: { mode: "Open" } },
      { fetchRaw: { mode: "yolo" } },
      { fetchRaw: { mode: "" } },
      { fetchRaw: { mode: 1 } }, // non-string
      { fetchRaw: { mode: null } },
      { fetchRaw: {} }, // no mode
      { other: true }, // no fetchRaw
    ];
    for (const [i, cfg] of cases.entries()) {
      await withTempDir(`fm-fc-${i}-`, async (dir) => {
        write(dir, cfg);
        expect(loadFetchMode(dir), JSON.stringify(cfg)).toBe("allowlist");
      });
    }
  });
  it("missing / unreadable .rks/project.json ⇒ 'allowlist' (never throws, never fail-open)", async () => {
    await withTempDir("fm-none-", async (dir) => {
      expect(loadFetchMode(dir)).toBe("allowlist");
    });
  });
});

describe("fetchRaw — open egress mode (casual posture, security floor intact)", () => {
  it("CASUAL WIN: mode:'open' + EMPTY allowlist fetches a public host that default mode would deny", async () => {
    await withTempDir("open-win-", async (dir) => {
      const fetch = mkFetch([mockResponse({ body: "OPEN DOC" })]);
      const record = vi.fn();
      const r = await fetchRaw("https://anything.example.org/x", {
        allowedHosts: [], // would be host_not_allowlisted in default mode
        mode: "open",
        fetch,
        resolveDns: publicDns,
        cacheDir: path.join(dir, "cache"),
        recordProvenance: record,
      });
      expect(r.ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(r.content).toBe("OPEN DOC");
    });
  });
  it("SSRF FLOOR INTACT: mode:'open' STILL blocks an internal-resolving host (no fetch)", async () => {
    const fetch = mkFetch([mockResponse({})]);
    const record = vi.fn();
    const r = await fetchRaw("https://internal.example.org/x", {
      allowedHosts: [],
      mode: "open",
      fetch,
      resolveDns: async () => ["10.0.0.5"], // RFC-1918 internal
      recordProvenance: record,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ssrf_blocked");
    expect(fetch).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
  it("SCHEME FLOOR INTACT: mode:'open' STILL denies http:// (no fetch)", async () => {
    const fetch = mkFetch([mockResponse({})]);
    const r = await fetchRaw("http://anything.example.org/x", { allowedHosts: [], mode: "open", fetch, resolveDns: publicDns });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("scheme_denied");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("REDIRECT FLOOR INTACT: mode:'open' STILL re-validates a redirect hop for SSRF", async () => {
    const fetch = mkFetch([mockResponse({ status: 302, location: "https://evil-internal.example.org/x" })]);
    const resolveDns = async (host) =>
      host === "evil-internal.example.org" ? ["127.0.0.1"] : ["93.184.216.34"];
    const r = await fetchRaw("https://start.example.org/x", { allowedHosts: [], mode: "open", fetch, resolveDns });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ssrf_blocked"); // internal redirect target refused even in open mode
  });
  it("BACKWARD COMPAT: explicit mode:'allowlist' + empty allowlist ⇒ default-deny, no fetch", async () => {
    const fetch = mkFetch([mockResponse({})]);
    const r = await fetchRaw("https://anything.example.org/x", { allowedHosts: [], mode: "allowlist", fetch, resolveDns: publicDns });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("host_not_allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("FAIL-CLOSED at the fetch layer: a malformed mode value grants NO open egress", async () => {
    for (const bad of ["OPEN", "Open", "yolo", "", 1, null, undefined]) {
      const fetch = mkFetch([mockResponse({})]);
      const r = await fetchRaw("https://anything.example.org/x", { allowedHosts: [], mode: bad, fetch, resolveDns: publicDns });
      // undefined ⇒ loadFetchMode(cwd) which is 'allowlist' in this repo; all others ⇒ 'allowlist' branch.
      expect(r.ok, `mode=${String(bad)}`).toBe(false);
      expect(r.reason, `mode=${String(bad)}`).toBe("host_not_allowlisted");
      expect(fetch, `mode=${String(bad)}`).not.toHaveBeenCalled();
    }
  });
});

describe("fetchRaw — success path, provenance, byte-exact", () => {
  it("allowlisted https host fetches the full body, records provenance, returns sha256", async () => {
    await withTempDir("fetch-raw-", async (dir) => {
      const fetch = mkFetch([mockResponse({ body: "FULL DOCUMENT BODY" })]);
      const record = vi.fn();
      const r = await fetchRaw("https://example.com/doc", {
        allowedHosts: ALLOW,
        fetch,
        resolveDns: publicDns,
        cacheDir: path.join(dir, "cache"),
        recordProvenance: record,
        now: () => "2026-01-01T00:00:00Z",
      });
      expect(r.ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(r.content).toBe("FULL DOCUMENT BODY"); // byte-exact, no transform
      expect(r.bytes).toBe(Buffer.byteLength("FULL DOCUMENT BODY"));
      expect(typeof r.sha256).toBe("string");
      // write-ledger provenance recorded exactly once on success, for the written path
      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(r.path);
      expect(fs.readFileSync(r.path, "utf8")).toBe("FULL DOCUMENT BODY");
    });
  });

  it("passes an AbortSignal into fetch (timeout wiring)", async () => {
    await withTempDir("fetch-raw-sig-", async (dir) => {
      const fetch = mkFetch([mockResponse({ body: "x" })]);
      await fetchRaw("https://example.com/x", { allowedHosts: ALLOW, fetch, resolveDns: publicDns, cacheDir: path.join(dir, "c") });
      const init = fetch.calls[0].init;
      expect(init.signal).toBeDefined();
      expect(typeof init.signal.aborted).toBe("boolean");
      expect(init.redirect).toBe("manual");
    });
  });

  it("clamps timeoutMs to the MAX ceiling and floors tiny values (distinct from LLM timeout)", () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(30000);
    expect(DEFAULT_FETCH_TIMEOUT_MS).not.toBe(300000); // NOT the 5-min LLM timeout
    expect(MAX_FETCH_TIMEOUT_MS).toBe(120000);
  });
});

describe("fetchRaw — size cap + timeout + http error", () => {
  it("truncates a body over maxBytes", async () => {
    await withTempDir("fetch-raw-cap-", async (dir) => {
      const big = "A".repeat(100);
      const fetch = mkFetch([mockResponse({ body: big })]);
      const r = await fetchRaw("https://example.com/big", { allowedHosts: ALLOW, fetch, resolveDns: publicDns, cacheDir: path.join(dir, "c"), maxBytes: 10 });
      expect(r.ok).toBe(true);
      expect(r.truncated).toBe(true);
      expect(r.bytes).toBeLessThanOrEqual(10);
    });
  });
  it("maps an AbortError to a timeout denial (no provenance)", async () => {
    const fetch = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    const record = vi.fn();
    const r = await fetchRaw("https://example.com/slow", { allowedHosts: ALLOW, fetch, resolveDns: publicDns, recordProvenance: record });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("timeout");
    expect(record).not.toHaveBeenCalled();
  });
  it("surfaces an HTTP error status without recording provenance", async () => {
    const fetch = mkFetch([mockResponse({ status: 404, body: "nope" })]);
    const record = vi.fn();
    const r = await fetchRaw("https://example.com/missing", { allowedHosts: ALLOW, fetch, resolveDns: publicDns, recordProvenance: record });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("http_error");
    expect(r.status).toBe(404);
    expect(record).not.toHaveBeenCalled();
  });
});

describe("fetchRaw — per-redirect-hop revalidation (no link-following off-policy)", () => {
  it("follows an allowlisted https redirect to a public host", async () => {
    await withTempDir("fetch-raw-redir-", async (dir) => {
      const fetch = mkFetch([
        mockResponse({ status: 302, location: "https://example.com/final" }),
        mockResponse({ body: "REDIRECTED BODY" }),
      ]);
      const r = await fetchRaw("https://example.com/start", { allowedHosts: ALLOW, fetch, resolveDns: publicDns, cacheDir: path.join(dir, "c") });
      expect(r.ok).toBe(true);
      expect(r.content).toBe("REDIRECTED BODY");
      expect(r.url).toBe("https://example.com/final");
    });
  });
  it("blocks a redirect to a NON-allowlisted host", async () => {
    const fetch = mkFetch([mockResponse({ status: 302, location: "https://evil.com/x" }), mockResponse({ body: "should-not-read" })]);
    const r = await fetchRaw("https://example.com/start", { allowedHosts: ALLOW, fetch, resolveDns: publicDns });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("redirect_host_not_allowlisted");
  });
  it("blocks a redirect whose host resolves to an internal IP (SSRF via redirect)", async () => {
    // allow a second host so the redirect passes the allowlist but fails SSRF
    const fetch = mkFetch([mockResponse({ status: 302, location: "https://internal.example.com/meta" }), mockResponse({ body: "x" })]);
    const resolveDns = async (h) => (h === "internal.example.com" ? ["169.254.169.254"] : ["93.184.216.34"]);
    const r = await fetchRaw("https://example.com/start", { allowedHosts: ["*.example.com", "example.com"], fetch, resolveDns });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ssrf_blocked");
  });
  it("blocks a redirect to a non-https scheme", async () => {
    const fetch = mkFetch([mockResponse({ status: 302, location: "http://example.com/x" }), mockResponse({ body: "x" })]);
    const r = await fetchRaw("https://example.com/start", { allowedHosts: ALLOW, fetch, resolveDns: publicDns });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("scheme_denied");
  });
});

describe("loadAllowedHosts — config, default-deny", () => {
  it("reads fetchRaw.allowedHosts from .rks/project.json; missing config → []", async () => {
    await withTempDir("fetch-raw-cfg-", async (dir) => {
      expect(loadAllowedHosts(dir)).toEqual([]); // no config → deny-all
      fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".rks", "project.json"), JSON.stringify({ fetchRaw: { allowedHosts: ["docs.example.com"] } }));
      expect(loadAllowedHosts(dir)).toEqual(["docs.example.com"]);
    });
  });
});
