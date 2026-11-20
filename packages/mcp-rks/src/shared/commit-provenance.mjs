// backlog.feat.commit-provenance-trailer
//
// Every commit and merge rks itself creates carries one non-secret trailer line:
//
//   Rks-Provenance: v1 session=<sessionRef> tool=<tool> client=<client> via=<lane> actor=<actor> run=<runId>
//
// The two builders below (sessionRefFromToken, buildProvenanceTrailer) are pure. The rest of the
// module is the carrier that lets a commit site deep inside a tool handler find out which request
// it is serving without threading arguments through every call chain: server.mjs runs each tool
// handler inside runWithProvenanceContext(), and a commit site calls provenanceTrailerLine() or
// appendProvenanceTrailer(). Outside any MCP request (a CLI path, a test calling runGitCommit
// directly) the context is empty and the trailer falls back to session=none, client=unknown-client
// and the process attribution from resolveAttribution().
//
// All attribution here is self-reported (RKS_VIA, RKS_ACTOR, RKS_DISPATCH_RUN_ID and the MCP client
// name are chosen by whoever starts the process), and the trailer is text any `git commit` can
// forge. It makes an ungoverned commit detectable, not impossible. The governor token itself never
// appears: sessionRef is a truncated sha256 digest of it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveAttribution } from "./project-lease.mjs";

export const PROVENANCE_KEY = "Rks-Provenance";

export function sessionRefFromToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 12);
}

export function buildProvenanceTrailer({ sessionRef, tool, client, via, actor, runId }) {
  for (const v of [sessionRef, tool, client, via, actor, runId]) {
    if (/[\r\n]/.test(String(v ?? ""))) throw new Error("provenance values must not contain CR or LF");
  }
  const tok = (v, dflt) => (v ? String(v).replace(/\s+/g, "_") : dflt);
  return `${PROVENANCE_KEY}: v1 session=${tok(sessionRef, "none")} tool=${tok(tool, "unknown-tool")} client=${tok(client, "unknown-client")} via=${tok(via, "mcp")} actor=${tok(actor, "unknown")} run=${tok(runId, "none")}`;
}

// ── request context carrier ─────────────────────────────────────────

const _store = new AsyncLocalStorage();

/**
 * Run fn with the provenance context of one MCP request. server.mjs calls this around tool
 * dispatch. ctx: { tool, client, sessionRef, via, actor, runId } — every field optional. The raw
 * governor token is never accepted here; pass sessionRefFromToken(token).
 */
export function runWithProvenanceContext(ctx, fn) {
  return _store.run(Object.freeze({ ...(ctx || {}) }), fn);
}

/** The provenance context of the current request, or null outside one. */
export function getProvenanceContext() {
  return _store.getStore() ?? null;
}

const CR_LF = /[\r\n]/g;
// A CR or LF in a context value (a hostile client name, say) must not make every commit throw.
// The builder's throw protects callers passing values directly; context values are sanitised.
const clean = (v) => (v == null || v === "" ? null : String(v).replace(CR_LF, "_"));

/**
 * The Rks-Provenance line for a commit made now.
 *
 * tool: an explicit tool name, which wins (commitDendronWriteResult passes the dendron tool).
 * defaultTool: used only when neither an explicit tool nor a request context names one
 *   (e.g. runGitCommit called outside any MCP request).
 * Session-derived fields (via, actor, runId) come from the request context, and any that are
 * missing fall back to the process attribution (resolveAttribution).
 */
export function provenanceTrailerLine({ tool, defaultTool } = {}) {
  const ctx = getProvenanceContext() || {};
  let env = {};
  try { env = resolveAttribution() || {}; } catch { env = {}; }
  return buildProvenanceTrailer({
    sessionRef: clean(ctx.sessionRef),
    tool: clean(tool) ?? clean(ctx.tool) ?? clean(defaultTool),
    client: clean(ctx.client),
    via: clean(ctx.via) ?? clean(env.via),
    actor: clean(ctx.actor) ?? clean(env.actor),
    runId: clean(ctx.runId) ?? clean(env.runId),
  });
}

const TRAILER_LINE = /^[A-Za-z0-9][A-Za-z0-9-]*:[ \t]*\S/;

/**
 * True when the message's final paragraph is a block of `Key: value` trailer lines. Like git's
 * own trailer parser, lines starting with `#` are skipped, so the off-rail ship's
 * `#off-rail-work` marker followed by Co-Authored-By still counts as a trailer block (and the
 * provenance line joining it keeps Co-Authored-By inside the block git parses).
 */
function endsWithTrailerBlock(message) {
  const trimmed = message.replace(/\s+$/, "");
  const paragraphs = trimmed.split(/\n[ \t]*\n/);
  if (paragraphs.length < 2) return false; // the subject paragraph is never a trailer block
  const lines = paragraphs[paragraphs.length - 1].split("\n");
  return lines.length > 0 && lines.every((l) => TRAILER_LINE.test(l) || /^[ \t]+\S/.test(l) || l.startsWith("#"));
}

/** True when the message already carries an Rks-Provenance trailer line. */
export function hasProvenanceTrailer(message) {
  return new RegExp(`^${PROVENANCE_KEY}: `, "m").test(String(message ?? ""));
}

/**
 * Append the Rks-Provenance line to a commit message. The caller's bytes are always an exact
 * prefix of the result. When the message already ends in a trailer block (Story:, Co-Authored-By:,
 * Plan-Hash: ...) the line joins that block; otherwise it opens a new paragraph so
 * `git interpret-trailers --parse` reports it. A message that already carries the line is
 * returned unchanged, so a commit routed through two helpers is never stamped twice.
 */
export function appendProvenanceTrailer(message, opts = {}) {
  const msg = String(message ?? "");
  if (hasProvenanceTrailer(msg)) return msg;
  const line = provenanceTrailerLine(opts);
  if (msg.length === 0) return line;
  const endsNl = msg.endsWith("\n");
  // A message ending in blank lines cannot join its last paragraph without rewriting the caller's
  // bytes, so only a message whose final line is non-empty joins an existing trailer block.
  const joins = !/\n[ \t]*\n$/.test(msg) && endsWithTrailerBlock(msg);
  if (joins) return `${msg}${endsNl ? "" : "\n"}${line}`;
  return `${msg}${endsNl ? "\n" : "\n\n"}${line}`;
}

/**
 * argv for a `git merge` that may create a merge commit: an explicit `-m` pair carrying the
 * subject and the provenance trailer as its own paragraph. A fast-forward ignores -m and creates
 * no commit, so passing it is harmless there.
 */
export function provenanceMergeMessageArgs(subject, opts = {}) {
  return ["-m", String(subject), "-m", provenanceTrailerLine(opts)];
}

/**
 * argv to append to a `git commit --no-edit` (finalising a merge or conflict resolution, where the
 * message comes from MERGE_MSG): git's own --trailer adds the line to that message.
 */
export function provenanceCommitTrailerArgs(opts = {}) {
  return ["--trailer", provenanceTrailerLine(opts)];
}

/**
 * The text of the repository's prepared MERGE_MSG (written by a conflicted merge, or by
 * `git revert|cherry-pick --no-commit`), or null when there is none or it cannot be read.
 * The path is resolved with `git rev-parse --git-path`, so a linked worktree's own MERGE_MSG
 * is the one read.
 */
export function readPreparedMergeMessage(cwd) {
  try {
    const r = spawnSync("git", ["rev-parse", "--git-path", "MERGE_MSG"], { cwd, encoding: "utf8", timeout: 15_000 });
    if (!r || r.status !== 0 || !r.stdout) return null;
    const p = path.resolve(cwd, r.stdout.trim());
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * backlog.feat.commit-provenance-trailer-remaining-sites AC7: argv to append to a
 * `git commit --no-edit` whose message comes from MERGE_MSG. Every rks merge that can conflict
 * already wrote the trailer into its merge message (provenanceMergeMessageArgs), and git's
 * --trailer would add a second, different line next to it (trailer.ifExists defaults to
 * addIfDifferentNeighbor). So when the prepared MERGE_MSG already carries an Rks-Provenance
 * line this returns [], and otherwise the same --trailer pair as provenanceCommitTrailerArgs.
 * The result is exactly one line either way. When MERGE_MSG cannot be read it stamps, so the
 * commit is never left with none.
 */
export function provenanceMergeMsgTrailerArgs(cwd, opts = {}) {
  const prepared = readPreparedMergeMessage(cwd);
  if (prepared != null && hasProvenanceTrailer(prepared)) return [];
  return provenanceCommitTrailerArgs(opts);
}
