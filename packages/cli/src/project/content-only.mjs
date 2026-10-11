// Content-only remote mode: keep rks-owned paths out of git for a client-hosted remote.
// backlog.feat.content-only-remote.init-attach-exclude
//
// One module owns the excluded-path set and both git guards (the .git/info/exclude managed
// block and the fail-closed pre-push hook), so the block, the hook, the tracked-path audit and
// `routekit project upgrade` cannot drift apart.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

export const EXCLUDE_BLOCK_BEGIN = "# >>> rks content-only (managed) >>>";
export const EXCLUDE_BLOCK_END = "# <<< rks content-only (managed) <<<";
export const PRE_PUSH_MARKER = "# rks-content-only-pre-push (managed)";

// rks runtime and config: never client content, excluded regardless of any licence exception.
export const CONTENT_ONLY_RUNTIME_PATHS = [
  "/.rks/",
  "/.routekit/",
  "/.claude/",
  "/.codex/",
  "/routekit/",
  "/.mcp.json",
  "/dendron.yml",
];

// rks-authored template text seeded into client-shaped locations. Kept separate so a future
// AGPLv3 section 7 template exception can flip this group to tracked without touching the runtime group.
export const CONTENT_ONLY_TEMPLATE_PATHS = [
  "/CLAUDE.md",
  "/AGENTS.md",
  "/vitest.config.unit.mjs",
  "/vitest.config.base.mjs",
  "/scripts/vitest-runner.mjs",
  "/scripts/lib/spawn-managed.mjs",
];

export const CONTENT_ONLY_VENDOR_CONFLICT = "content_only_vendor_conflict";

const GIT_TIMEOUT_MS = 30_000;

// One /notes/<rel> entry per file ensureNotes seeds: templates/base/notes plus, with a stack,
// templates/<stackId>/skeleton/notes. Listed at call time; a missing dir contributes nothing.
export function listSeededNotePaths({ shellRoot, stackId = null } = {}) {
  if (!shellRoot) return [];
  const out = [];
  const roots = [path.join(shellRoot, "templates", "base", "notes")];
  if (stackId) roots.push(path.join(shellRoot, "templates", String(stackId), "skeleton", "notes"));
  for (const root of roots) {
    let rels;
    try {
      if (!fs.statSync(root).isDirectory()) continue;
      rels = fs.readdirSync(root, { recursive: true });
    } catch {
      continue;
    }
    for (const rel of rels) {
      try {
        if (fs.statSync(path.join(root, rel)).isFile()) out.push("/notes/" + String(rel).split(path.sep).join("/"));
      } catch {
        // vanished between readdir and stat: contributes nothing
      }
    }
  }
  return Array.from(new Set(out)).sort();
}

export function readContentOnly(projectRoot) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(projectRoot, ".rks", "project.json"), "utf8"));
    return Boolean(pj && pj.vcs && pj.vcs.contentOnly === true);
  } catch {
    return false;
  }
}

/**
 * Content-only implies off-rail disabled (backlog.feat.content-only-remote.offrail-disabled).
 * Pure: returns a new object whose offRail is `{ ...existingObject, enabled: false }`; a
 * non-object (absent, null, array, scalar) offRail is replaced by `{ enabled: false }`. Other
 * offRail keys such as `roots` are preserved. `changed` is false only when offRail.enabled was
 * already exactly false; `previous` is the offRail value observed on input (undefined if absent).
 *
 * @param {object} rksJson parsed .rks/project.json
 * @returns {{ json: object, changed: boolean, previous: unknown }}
 */
export function applyContentOnlyOffRail(rksJson) {
  const base = rksJson && typeof rksJson === "object" && !Array.isArray(rksJson) ? rksJson : {};
  const previous = base.offRail;
  const isObj = previous !== null && typeof previous === "object" && !Array.isArray(previous);
  if (isObj && previous.enabled === false) {
    return { json: base, changed: false, previous };
  }
  const offRail = isObj ? { ...previous, enabled: false } : { enabled: false };
  return { json: { ...base, offRail }, changed: true, previous };
}

export function gitPath(projectRoot, rel) {
  const out = execFileSync("git", ["rev-parse", "--git-path", rel], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  }).trim();
  return path.resolve(projectRoot, out);
}

// A bare notes directory entry would hide every client note; it is never emitted.
const isBareNotesEntry = (e) => /^\/?notes\/?$/.test(e);

/**
 * The full ordered entry list: runtime group, template group, then extraPaths (seeded notes).
 * Every entry is root-anchored ("/..."). Invalid or bare-notes extra entries are dropped.
 */
export function contentOnlyEntries(extraPaths = []) {
  const extras = (Array.isArray(extraPaths) ? extraPaths : [])
    .filter((e) => typeof e === "string" && e.trim())
    .map((e) => (e.startsWith("/") ? e : "/" + e))
    .filter((e) => !isBareNotesEntry(e) && !/[\r\n]/.test(e));
  return Array.from(new Set([...CONTENT_ONLY_RUNTIME_PATHS, ...CONTENT_ONLY_TEMPLATE_PATHS, ...extras]));
}

/** Does repo-relative POSIX path `rel` fall under root-anchored entry `entry`? */
export function matchesContentOnlyEntry(rel, entry) {
  const e = entry.replace(/^\//, "");
  return e.endsWith("/") ? rel.startsWith(e) : rel === e;
}

export function renderExcludeBlock(extraPaths = []) {
  return (
    [
      EXCLUDE_BLOCK_BEGIN,
      "# Written by routekit (content-only remote mode). Edits inside this block are overwritten.",
      ...contentOnlyEntries(extraPaths),
      EXCLUDE_BLOCK_END,
    ].join("\n") + "\n"
  );
}

/**
 * Write or refresh the managed block in the repository's info/exclude (resolved with
 * `git rev-parse --git-path info/exclude`, so worktrees resolve correctly). Idempotent: replaces
 * only its own block, in place, and keeps every other byte. Throws on any failure (the caller
 * decides whether that is fatal).
 * @returns {{ ok: true, path: string, entries: string[], changed: boolean }}
 */
export function writeContentOnlyExclude(projectRoot, { extraPaths = [] } = {}) {
  const p = gitPath(projectRoot, "info/exclude");
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const block = renderExcludeBlock(extraPaths);

  // Cut every managed block (a hand-duplicated one included), remembering where the first sat.
  let rest = existing;
  let insertAt = -1;
  for (;;) {
    const begin = findLineStart(rest, EXCLUDE_BLOCK_BEGIN, 0);
    if (begin === -1) break;
    const end = findLineStart(rest, EXCLUDE_BLOCK_END, begin);
    if (end === -1) {
      throw new Error(`${p}: managed block begin marker has no end marker; refusing to rewrite it`);
    }
    const nl = rest.indexOf("\n", end);
    const stop = nl === -1 ? rest.length : nl + 1;
    rest = rest.slice(0, begin) + rest.slice(stop);
    if (insertAt === -1) insertAt = begin;
  }

  let next;
  if (insertAt === -1) {
    const sep = rest.length > 0 && !rest.endsWith("\n") ? "\n" : "";
    next = rest + sep + block;
  } else {
    next = rest.slice(0, insertAt) + block + rest.slice(insertAt);
  }
  const changed = next !== existing;
  if (changed) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, next);
  }
  return { ok: true, path: p, entries: contentOnlyEntries(extraPaths), changed };
}

function findLineStart(text, marker, from) {
  let i = text.indexOf(marker, from);
  while (i !== -1) {
    const atLineStart = i === 0 || text[i - 1] === "\n";
    const after = text[i + marker.length];
    const atLineEnd = after === undefined || after === "\n" || after === "\r";
    if (atLineStart && atLineEnd) return i;
    i = text.indexOf(marker, i + 1);
  }
  return -1;
}

// ERE-escape a literal path for grep -E, then anchor it: directory entries match by prefix.
function entryToEre(entry) {
  const e = entry.replace(/^\//, "");
  const esc = e.replace(/[.[\]()*+?{}|^$\\]/g, "\\$&");
  return e.endsWith("/") ? `^${esc}` : `^${esc}$`;
}

const shSingleQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The pre-push hook text for an entry set. POSIX sh; fails closed on any git or grep error. */
export function renderPrePushHook(extraPaths = []) {
  const entries = contentOnlyEntries(extraPaths);
  const pattern = entries.map(entryToEre).join("|");
  return `#!/bin/sh
${PRE_PUSH_MARKER}
# Installed by routekit (content-only remote mode). Do not edit: routekit rewrites this file.
# Rejects a push whose outgoing commits touch, or whose pushed tip tree contains, an rks-owned
# path. For a new remote branch every commit not on any remote-tracking ref is checked. A branch
# deletion is allowed. Any git or grep failure rejects the push (fail closed).

RKS_PATTERN=${shSingleQuote(pattern)}
z40=0000000000000000000000000000000000000000
z64=0000000000000000000000000000000000000000000000000000000000000000
found=0

is_null() {
  case "$1" in
    "$z40"|"$z64") return 0 ;;
  esac
  return 1
}

die() {
  echo "rks content-only pre-push: $*; failing closed, push rejected." >&2
  exit 1
}

check() {
  label="$1"
  list="$2"
  [ -n "$list" ] || return 0
  hits=$(printf '%s\\n' "$list" | grep -E -- "$RKS_PATTERN")
  st=$?
  if [ "$st" -eq 0 ]; then
    echo "rks content-only pre-push: $label contains rks-owned path(s):" >&2
    printf '%s\\n' "$hits" | sed 's/^/  /' >&2
    found=1
  elif [ "$st" -ne 1 ]; then
    die "grep failed (exit $st) while checking $label"
  fi
}

while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "$local_sha" ] || continue
  if is_null "$local_sha"; then
    continue
  fi
  if is_null "$remote_sha"; then
    commits=$(git rev-list "$local_sha" --not --remotes </dev/null) || die "git rev-list failed for $local_ref"
  else
    commits=$(git rev-list "$remote_sha..$local_sha" </dev/null) || die "git rev-list failed for $local_ref ($remote_sha..$local_sha)"
  fi
  for c in $commits; do
    files=$(git -c core.quotePath=false diff-tree --no-commit-id --name-only -r --root "$c" </dev/null) || die "git diff-tree failed for commit $c"
    check "commit $c" "$files"
  done
  tree=$(git -c core.quotePath=false ls-tree -r --name-only "$local_sha" </dev/null) || die "git ls-tree failed for $local_sha"
  check "pushed tip $local_sha ($local_ref)" "$tree"
done

if [ "$found" -ne 0 ]; then
  echo "rks content-only pre-push: push rejected. This repository is in content-only mode; rks-owned paths must stay out of the remote." >&2
  echo "Untrack them with: git rm --cached <path> (and rewrite any commit that added them) before pushing." >&2
  exit 1
fi
exit 0
`;
}

function readGitConfig(projectRoot, key) {
  const r = spawnSync("git", ["config", "--get", key], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  if (r.error) throw r.error;
  if (r.status === 0) return String(r.stdout || "").trim() || null;
  if (r.status === 1) return null; // key not set
  throw new Error(`git config --get ${key} failed (exit ${r.status}): ${String(r.stderr || "").trim()}`);
}

/**
 * Install the pre-push hook into `git rev-parse --git-path hooks`. Writes nothing when
 * core.hooksPath is set or when a pre-push exists that rks did not write.
 * @returns {{ installed: boolean, reason?: string, path?: string, refreshed?: boolean }}
 */
export function installContentOnlyPrePush(projectRoot, { extraPaths = [] } = {}) {
  const hooksPathCfg = readGitConfig(projectRoot, "core.hooksPath");
  if (hooksPathCfg) return { installed: false, reason: "core_hooks_path", hooksPath: hooksPathCfg };
  const hookPath = path.join(gitPath(projectRoot, "hooks"), "pre-push");
  let refreshed = false;
  if (fs.existsSync(hookPath)) {
    const current = fs.readFileSync(hookPath, "utf8");
    if (!current.includes(PRE_PUSH_MARKER)) return { installed: false, reason: "existing_hook", path: hookPath };
    refreshed = true;
  }
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, renderPrePushHook(extraPaths));
  fs.chmodSync(hookPath, 0o755);
  return { installed: true, path: hookPath, refreshed };
}

/**
 * Tracked paths that fall under the content-only set. Exclusion cannot untrack these, so they are
 * reported, never silently passed over.
 */
export function listTrackedRksPaths(projectRoot, { extraPaths = [] } = {}) {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries = contentOnlyEntries(extraPaths);
  return out
    .split("\0")
    .filter(Boolean)
    .filter((rel) => entries.some((e) => matchesContentOnlyEntry(rel, e)))
    .sort();
}

/**
 * Apply both guards and audit tracked paths. Each step is attempted independently; a failure is
 * recorded in its own field, never thrown, so one failing guard does not skip the others.
 */
export function applyContentOnlyGuards(projectRoot, { extraPaths = [] } = {}) {
  const result = { exclude: null, prePush: null, alreadyTracked: [], warnings: [] };
  try {
    result.exclude = writeContentOnlyExclude(projectRoot, { extraPaths });
  } catch (e) {
    result.exclude = { ok: false, error: e?.message || String(e) };
    result.warnings.push(`content-only: .git/info/exclude block NOT written (${result.exclude.error}).`);
  }
  try {
    result.prePush = installContentOnlyPrePush(projectRoot, { extraPaths });
    if (!result.prePush.installed) {
      result.warnings.push(
        `content-only: pre-push hook NOT installed (${result.prePush.reason}); rks-owned paths are not guarded at push time.`,
      );
    }
  } catch (e) {
    result.prePush = { installed: false, reason: "error", error: e?.message || String(e) };
    result.warnings.push(`content-only: pre-push hook NOT installed (${result.prePush.error}).`);
  }
  try {
    result.alreadyTracked = listTrackedRksPaths(projectRoot, { extraPaths });
  } catch (e) {
    result.alreadyTrackedError = e?.message || String(e);
    result.warnings.push(`content-only: could not audit tracked rks-owned paths (${result.alreadyTrackedError}).`);
  }
  if (result.alreadyTracked.length > 0) {
    let msg =
      `content-only: ${result.alreadyTracked.length} rks-owned path(s) are already tracked; exclusion cannot untrack them ` +
      `and the pre-push hook will reject pushes containing them. Untrack each with \`git rm --cached <path>\`: ` +
      result.alreadyTracked.join(", ");
    if (result.alreadyTracked.some((p) => p.startsWith("notes/"))) {
      msg +=
        ". Note: /notes/ entries are matched by template note NAME, so a client-authored note that shares a template " +
        "note's name is listed here too; check its content before untracking it.";
    }
    result.warnings.push(msg);
  }
  return result;
}
