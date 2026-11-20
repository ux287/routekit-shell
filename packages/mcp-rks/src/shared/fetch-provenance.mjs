/**
 * Session-scoped, URL-exact fetch provenance (backlog.feat.fetch-raw-url-provenance-allow).
 *
 * rks_agent_external_research records the exact URLs it surfaced under the caller's governor
 * token; rks_fetch_raw admits a target only if its normalized URL is in that token's set AND
 * the session is still live. The SSRF / https-only floor in fetch-raw.mjs is never bypassed.
 *
 * Store (ARCH D2 option b): one file per token under .rks/session/fetch-provenance/<token>.json,
 * shaped { urls: string[] }. It is honoured only while getSession(token) returns a live session,
 * so a dead token never admits, whatever its file still holds. Cleanup of dead-token files is
 * best-effort and not done here.
 *
 * Normalization (ARCH D3): new URL(u), https only, fragment dropped, compared by WHATWG href
 * (which already lowercases scheme and host and drops a default :443). Path and query are
 * compared exactly: no reordering and no trailing-slash folding.
 *
 * Nothing in rks_fetch_raw ever writes here: fetched URLs and redirect targets are never added.
 */
import fs from "fs";
import path from "path";
import { getSession } from "./governor-token.mjs";

const DIR = path.join(".rks", "session", "fetch-provenance");

/** Normalize for exact comparison: https only, fragment dropped, WHATWG href. Null if unusable. */
export function normalizeFetchUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

function fileFor(projectRoot, token) {
  const safe = String(token).replace(/[^A-Za-z0-9-]/g, "");
  if (!safe) return null;
  return path.join(projectRoot, DIR, `${safe}.json`);
}

function readSet(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed?.urls) ? parsed.urls.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Record surfaced URLs for a token. No token -> no-op. Never throws.
 * Returns { recorded, urls }, both from ONE read-back after the write: urls is the normalized
 * input URLs actually present in the token file, and recorded is urls.length (never a count of
 * the URLs it meant to write). A failed write therefore yields { recorded: 0, urls: [] }.
 */
export function recordSurfacedUrls(projectRoot, token, urls) {
  if (!token) return { recorded: 0, urls: [] };
  try {
    const file = fileFor(projectRoot, token);
    if (!file) return { recorded: 0, urls: [] };
    const wanted = [];
    for (const raw of Array.isArray(urls) ? urls : []) {
      if (typeof raw !== "string") continue;
      const norm = normalizeFetchUrl(raw);
      if (norm && !wanted.includes(norm)) wanted.push(norm);
    }
    if (wanted.length === 0) return { recorded: 0, urls: [] };

    const existing = readSet(file);
    const merged = [...existing];
    for (const norm of wanted) if (!merged.includes(norm)) merged.push(norm);
    if (merged.length !== existing.length) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ urls: merged }, null, 2));
        fs.renameSync(tmp, file);
      } catch {
        /* the read-back below reports what actually persisted */
      }
    }

    // Observed, not intended: only the inputs found in the file after the write.
    const after = readSet(file);
    const observed = wanted.filter((norm) => after.includes(norm));
    return { recorded: observed.length, urls: observed };
  } catch {
    return { recorded: 0, urls: [] };
  }
}

/** True only when the session is live and the normalized URL was surfaced under this token. */
export function isSurfacedUrl(projectRoot, token, url) {
  try {
    if (!token || !getSession(token)) return false;
    const norm = normalizeFetchUrl(url);
    if (!norm) return false;
    const file = fileFor(projectRoot, token);
    if (!file) return false;
    return readSet(file).includes(norm);
  } catch {
    return false;
  }
}

/** Builder injected by server.mjs into registerRagHandlers (helpers.surfacedPredicate). No token -> undefined. */
export function surfacedPredicateFor(token, projectRoot) {
  if (!token) return undefined;
  return (url) => isSurfacedUrl(projectRoot, token, url);
}

/** Builder injected by server.mjs into registerAgentBootstrapHandlers (surfacedRecorder). Recorder only for a live session. */
export function surfacedRecorderFor(token, projectRoot) {
  if (!token || !getSession(token)) return undefined;
  return (urls) => recordSurfacedUrls(projectRoot, token, urls);
}
