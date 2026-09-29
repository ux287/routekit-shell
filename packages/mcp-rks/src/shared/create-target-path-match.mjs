/**
 * Shared create-target path matching.
 *
 * backlog.fix.create-target-coverage-predicate-diverges: `plan-ready.mjs` decided create-target
 * coverage suffix-tolerantly while `planner.mjs` decided the SAME question with exact `Set.has`
 * at four sites. A story whose body fence path differed in PREFIX from its frontmatter path
 * passed readiness and then died in the planner as `failureClass: "structural"`,
 * `refinable: false` — unrefinable, so the refine loop could not even engage.
 *
 * One predicate, both consumers, so they cannot drift again.
 *
 * The match is deliberately SEGMENT-AWARE, which makes it strictly tighter than the bare
 * `endsWith` it replaces. Two classes of HEAD-true match are removed, and both were false
 * positives naming two different files:
 *
 *   - mid-token suffix — `foo/bar.py` vs `oo/bar.py`, `src/helper.js` vs `elper.js`
 *   - either side empty — at HEAD `d.endsWith("")` is true, so an empty target matched
 *     EVERY directive
 *
 * What is preserved is the real authoring shape: a body fence naming a path relative to some
 * inner root while frontmatter names it from the repo root. `packages/mcp-rks/src/shared/x.mjs`
 * still matches `src/shared/x.mjs`, and still matches bare `x.mjs`, because each truncation
 * lands on a `/` boundary.
 */

function normalizeCreateTargetPath(value) {
  if (typeof value !== "string") return "";
  let out = value.trim();
  if (!out) return "";
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

/**
 * True when two paths denote the same create target.
 *
 * Symmetric by construction: neither caller knows which side carries the longer prefix.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function createTargetPathsMatch(a, b) {
  const left = normalizeCreateTargetPath(a);
  const right = normalizeCreateTargetPath(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/**
 * First candidate matching `target`, or undefined.
 *
 * Candidates come FIRST because every call site holds a collection and probes it with a
 * single target, which reads as a lookup rather than an argument order to remember.
 *
 * Iterates rather than indexing, so a Set, an Array and a `Map.keys()` iterator all work —
 * the three shapes the coverage sites actually hold.
 *
 * @param {Iterable<unknown>} candidates
 * @param {unknown} target
 * @returns {unknown}
 */
export function findMatchingCreateTargetPath(candidates, target) {
  if (!candidates) return undefined;
  for (const candidate of candidates) {
    if (createTargetPathsMatch(target, candidate)) return candidate;
  }
  return undefined;
}
