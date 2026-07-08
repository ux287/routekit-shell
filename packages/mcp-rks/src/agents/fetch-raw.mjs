/**
 * rks_fetch_raw — "curl mode" fetch primitive (backlog.feat.rks-fetch-raw).
 *
 * Fetch a COMPLETE raw document from an ALLOWLISTED https URL, for cases where RAG
 * snippets / summarized external research are not enough (read a full external doc/spec).
 *
 * SECURITY (this is a network egress primitive — gates are load-bearing):
 *  - DEFAULT-DENY host allowlist from `.rks/project.json` → `fetchRaw.allowedHosts`
 *    (empty/absent = deny-all). A denied request performs NO network call.
 *  - HTTPS-only.
 *  - SSRF: resolve the host and refuse if ANY resolved IP is internal
 *    (RFC-1918 / loopback / link-local incl. 169.254.169.254 / ULA / mapped). Every
 *    redirect hop is re-validated (allowlist + scheme + SSRF).
 *  - Size cap (streaming abort) + AbortController request timeout (DEFAULT_FETCH_TIMEOUT_MS,
 *    deliberately NOT the 5-min LLM timeout).
 *  - On SUCCESS only, the cached file is recorded in the write-ledger (recordWrittenPath) so
 *    it reads back under session_write provenance.
 *
 * NOT a crawler (single URL, redirects surfaced+revalidated but capped), NO JS rendering,
 * NO credentialed/authenticated fetch (fetchRaw.auth is reserved, not implemented in MVP).
 *
 * Transport (`opts.fetch`) and DNS (`opts.resolveDns`) are injectable so the whole security
 * surface is unit-testable with no real network / no real DNS.
 *
 * CAVEAT (documented follow-up): true DNS-pinning (connecting to the validated IP) needs a
 * custom undici connector; this MVP validates the resolved set and blocks if any IP is
 * internal, then lets fetch re-resolve — a narrow TOCTOU rebinding window remains for a
 * production hardening pass. The injected resolver makes the IP-block deterministic in tests.
 */
import fs from "fs";
import path from "path";
import net from "net";
import crypto from "node:crypto";
import dns from "dns/promises";
import { recordWrittenPath } from "../shared/session-state.mjs";

export const DEFAULT_FETCH_TIMEOUT_MS = 30000; // 30s — distinct from DEFAULT_LLM_TIMEOUT_MS (300000)
export const MAX_FETCH_TIMEOUT_MS = 120000; // hard ceiling on timeoutMs override
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_REDIRECTS = 5;

/** Read the host allowlist from .rks/project.json → fetchRaw.allowedHosts (default-deny). */
export function loadAllowedHosts(projectRoot) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(projectRoot, ".rks", "project.json"), "utf8"));
    const list = cfg?.fetchRaw?.allowedHosts;
    return Array.isArray(list) ? list.filter((h) => typeof h === "string" && h.trim()) : [];
  } catch {
    return [];
  }
}

/** Read the per-project egress posture from .rks/project.json → fetchRaw.mode.
 *  FAIL-CLOSED: only the exact string "open" enables open mode; absent / unknown /
 *  wrong-case / non-string all fall back to "allowlist" (today's default-deny). A
 *  malformed config must never fail OPEN. */
export function loadFetchMode(projectRoot) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(projectRoot, ".rks", "project.json"), "utf8"));
    return cfg?.fetchRaw?.mode === "open" ? "open" : "allowlist";
  } catch {
    return "allowlist";
  }
}

/** Host allowlist match. Default-deny: empty/absent list allows nothing. Supports exact,
 *  `.example.com` and `*.example.com` subdomain patterns. */
export function hostAllowed(host, allowedHosts) {
  if (!host || !Array.isArray(allowedHosts) || allowedHosts.length === 0) return false;
  const h = host.toLowerCase();
  return allowedHosts.some((pat) => {
    const p = String(pat).toLowerCase().trim();
    if (!p) return false;
    if (p === h) return true;
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      return h === base || h.endsWith("." + base);
    }
    if (p.startsWith(".")) {
      const base = p.slice(1);
      return h === base || h.endsWith("." + base);
    }
    return false;
  });
}

/** True if an IP is loopback / private / link-local / ULA / reserved (SSRF-blocked). */
export function isBlockedIp(ip) {
  if (!ip || typeof ip !== "string") return true;
  if (net.isIPv4(ip)) {
    const o = ip.split(".").map(Number);
    if (o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    if (o[0] === 0) return true; // "this" network
    if (o[0] === 10) return true; // 10/8 private
    if (o[0] === 127) return true; // loopback
    if (o[0] === 169 && o[1] === 254) return true; // link-local incl 169.254.169.254 metadata
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16/12 private
    if (o[0] === 192 && o[1] === 168) return true; // 192.168/16 private
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // 100.64/10 CGNAT
    if (o[0] >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (l === "::1" || l === "::") return true; // loopback / unspecified
    if (l.startsWith("fe80")) return true; // link-local
    if (l.startsWith("fc") || l.startsWith("fd")) return true; // ULA fc00::/7
    const mapped = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]); // IPv4-mapped
    return false;
  }
  return true; // not a valid IP literal → block
}

async function defaultResolveDns(host) {
  const res = await dns.lookup(host, { all: true });
  return res.map((r) => r.address);
}

/** Validate a target URL against scheme + allowlist + SSRF. Returns { ok } or a denial.
 *  `mode` is the per-project egress posture: 'open' bypasses ONLY the host-allowlist
 *  check below — the https-only scheme gate (above) and the SSRF isBlockedIp gate (below)
 *  ALWAYS run, so 'open' is "any public host", never "any host". */
async function validateTarget(u, allowedHosts, resolveDns, mode = "allowlist") {
  if (u.protocol !== "https:") return { ok: false, reason: "scheme_denied", message: `Only https:// is allowed (got ${u.protocol}).` };
  if (mode !== "open" && !hostAllowed(u.hostname, allowedHosts))
    return {
      ok: false,
      reason: "host_not_allowlisted",
      message:
        `Host '${u.hostname}' is not in fetchRaw.allowedHosts (default-deny). ` +
        `To allow it, add '${u.hostname}' to fetchRaw.allowedHosts in THIS project's own ` +
        `.rks/project.json — e.g. {"fetchRaw":{"allowedHosts":["${u.hostname}"]}} — then retry. ` +
        `Each project owns its own allowlist; the rks shell does not manage it for you.`,
    };
  let ips;
  try {
    ips = await resolveDns(u.hostname);
  } catch (e) {
    return { ok: false, reason: "dns_error", message: `DNS resolution failed for ${u.hostname}: ${e.message}` };
  }
  if (!Array.isArray(ips) || ips.length === 0) return { ok: false, reason: "dns_error", message: `No address for ${u.hostname}.` };
  if (ips.some(isBlockedIp)) return { ok: false, reason: "ssrf_blocked", message: `${u.hostname} resolves to an internal/blocked address.` };
  return { ok: true, ips };
}

/**
 * Fetch a raw document.
 * @param {string} url
 * @param {object} [opts] projectRoot, allowedHosts, mode, fetch, resolveDns, maxBytes,
 *   timeoutMs, cacheDir, recordProvenance, now. `mode` ('open'|'allowlist', default from
 *   .rks/project.json → fetchRaw.mode) selects the egress posture: 'open' drops the host
 *   allowlist (SSRF + https-only + GET-only floor retained); anything else is default-deny.
 * @returns {Promise<object>} { ok:true, url, path, content, bytes, truncated, sha256, ... }
 *   or { ok:false, reason, message, url }
 */
export async function fetchRaw(url, opts = {}) {
  const {
    projectRoot = process.cwd(),
    allowedHosts = loadAllowedHosts(projectRoot),
    mode = loadFetchMode(projectRoot),
    fetch: fetchImpl = globalThis.fetch,
    resolveDns = defaultResolveDns,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    cacheDir = path.join(projectRoot, ".rks", "fetch-cache"),
    recordProvenance = recordWrittenPath,
    now = () => new Date().toISOString(),
  } = opts;

  const deny = (reason, message, extra = {}) => ({ ok: false, reason, message, url, ...extra });
  const effTimeout = Math.min(Math.max(1000, Number(timeoutMs) || DEFAULT_FETCH_TIMEOUT_MS), MAX_FETCH_TIMEOUT_MS);

  let u;
  try {
    u = new URL(url);
  } catch {
    return deny("invalid_url", `Not a valid URL: ${url}`);
  }

  // Gate the initial target BEFORE any network call (default-deny + SSRF).
  const firstCheck = await validateTarget(u, allowedHosts, resolveDns, mode);
  if (!firstCheck.ok) return deny(firstCheck.reason, firstCheck.message);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effTimeout);
  let resp;
  let finalUrl = u.href;
  try {
    let target = u.href;
    let hops = 0;
    for (;;) {
      resp = await fetchImpl(target, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "rks-fetch-raw", accept: "*/*" },
      });
      const status = resp.status;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const loc = resp.headers?.get?.("location");
        if (!loc) break; // no Location — treat as final
        if (++hops > MAX_REDIRECTS) {
          clearTimeout(timer);
          return deny("too_many_redirects", `Exceeded ${MAX_REDIRECTS} redirects.`);
        }
        let next;
        try {
          next = new URL(loc, target);
        } catch {
          clearTimeout(timer);
          return deny("invalid_redirect", `Bad redirect Location: ${loc}`);
        }
        // Re-validate every hop against scheme + allowlist + SSRF (same posture).
        const hopCheck = await validateTarget(next, allowedHosts, resolveDns, mode);
        if (!hopCheck.ok) {
          clearTimeout(timer);
          return deny(hopCheck.reason === "host_not_allowlisted" ? "redirect_host_not_allowlisted" : hopCheck.reason, `Redirect blocked: ${hopCheck.message}`);
        }
        target = next.href;
        finalUrl = next.href;
        continue;
      }
      break;
    }
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === "AbortError") return deny("timeout", `Fetch aborted after ${effTimeout}ms.`);
    return deny("fetch_error", `Fetch failed: ${e?.message || e}`);
  }

  if (!resp.ok) {
    clearTimeout(timer);
    return deny("http_error", `HTTP ${resp.status} from ${finalUrl}`, { status: resp.status });
  }

  // Read body with a hard size cap (streaming abort — never buffer unbounded).
  let body;
  let truncated = false;
  try {
    const reader = resp.body && typeof resp.body.getReader === "function" ? resp.body.getReader() : null;
    if (reader) {
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          truncated = true;
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
        chunks.push(Buffer.from(value));
      }
      body = Buffer.concat(chunks).toString("utf8");
    } else {
      const text = await resp.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) {
        body = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
        truncated = true;
      } else {
        body = text;
      }
    }
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === "AbortError") return deny("timeout", `Body read aborted after ${effTimeout}ms.`);
    return deny("read_error", `Body read failed: ${e?.message || e}`);
  }
  clearTimeout(timer);

  // Persist verbatim (no transform) + record write-ledger provenance (SUCCESS ONLY).
  fs.mkdirSync(cacheDir, { recursive: true });
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const slug = (u.hostname + u.pathname).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "doc";
  const outPath = path.join(cacheDir, `${slug}-${sha256.slice(0, 12)}.txt`);
  fs.writeFileSync(outPath, body);
  try {
    recordProvenance(outPath);
  } catch {
    /* provenance is best-effort but required-on-success; do not fail the fetch */
  }

  return {
    ok: true,
    requestedUrl: url,
    url: finalUrl,
    path: outPath,
    content: body,
    bytes: Buffer.byteLength(body, "utf8"),
    truncated,
    sha256,
    fetchedAt: now(),
  };
}
