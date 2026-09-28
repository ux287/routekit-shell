/**
 * Tests for backlog.fix.ci-skips-already-verified-sha-via-workflow-guard.
 *
 * A5 closes the accumulated-FF-merge CI-savings gap left by A1 and A2:
 *   - A1 skipped same-content single-commit pushes (bump commit standalone)
 *   - A2 skipped docs/config-only commits
 *   - A5 skips ANY push whose head_sha has already succeeded in a prior CI run
 *     (covers the multi-commit ff-merge to main case where the same content
 *     was already verified on staging).
 *
 * Safety invariants this file pins:
 *   - Fail-open posture (AC3) — any error path leaves skip=false so downstream
 *     jobs run normally. The guard must never silently skip CI due to its own
 *     bug or a flaky GH API.
 *   - Self-exclusion (AC4) — the gh api query filters out github.run_id so a
 *     re-triggered run doesn't see itself as "prior success."
 *   - Workflow disambiguation (ARCH ask #1) — jq filters by name=="CI" so a
 *     green release-smoke or check-hooks-drift on the same SHA doesn't trip
 *     a CI skip (different workflows, different contracts).
 *   - A1+A2 paths-ignore entries preserved unchanged (AC7).
 *
 * Mirrors the source-grep + YAML-structural pattern in
 * tests/unit/release-bump-skip-ci.test.mjs and
 * tests/unit/ci-skips-docs-and-config-commits.test.mjs.
 *
 * Subprocess timeout rule: N/A — this file parses YAML and reads markdown,
 * no spawn calls. The workflow's `timeout-minutes: 5` cap on the sha-guard
 * job is the runtime ceiling for the gh api call.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const CI_YML_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const CI_YML_SRC = fs.readFileSync(CI_YML_PATH, 'utf8');
const CI_CONFIG = parseYaml(CI_YML_SRC);

const SHA_GUARD = CI_CONFIG.jobs['sha-guard'];

const A1_PRESERVED_ENTRIES = [
  'package.json',
  'CHANGELOG.md',
  'notes/research.public.**',
];

const A2_PRESERVED_ENTRIES = [
  'notes/backlog.**',
  'notes/research.**',
  'notes/canon.**',
  'notes/how-to.**',
  'notes/scratch.**',
  '.rks/project.json',
  '.rks/active-scope.json',
];

const DOWNSTREAM_JOBS = ['unit-tests', 'integration-tests', 'e2e-tests'];

describe('AC1 — sha-guard job present and shaped', () => {
  it("jobs.sha-guard is declared", () => {
    expect(CI_CONFIG.jobs).toHaveProperty('sha-guard');
    expect(SHA_GUARD).toBeDefined();
  });

  it('jobs.sha-guard.runs-on is ubuntu-latest', () => {
    expect(SHA_GUARD['runs-on']).toBe('ubuntu-latest');
  });

  it('jobs.sha-guard declares outputs.skip wired to a step output', () => {
    expect(SHA_GUARD.outputs).toBeDefined();
    expect(SHA_GUARD.outputs).toHaveProperty('skip');
    // The output must reference a step output — not a hardcoded value.
    expect(SHA_GUARD.outputs.skip).toMatch(/\$\{\{\s*steps\.[^.]+\.outputs\.skip\s*\}\}/);
  });

  it('jobs.sha-guard.steps[].run invokes gh api on actions/runs', () => {
    const runText = (SHA_GUARD.steps || []).map((s) => s.run || '').join('\n');
    expect(runText).toContain('gh api');
    expect(runText).toContain('actions/runs');
  });

  it('jobs.sha-guard step writes the skip value to $GITHUB_OUTPUT', () => {
    const runText = (SHA_GUARD.steps || []).map((s) => s.run || '').join('\n');
    expect(runText).toContain('$GITHUB_OUTPUT');
    expect(runText).toMatch(/echo\s+"skip=(?:true|false)"\s+>>\s+"\$GITHUB_OUTPUT"/);
  });
});

describe('AC1 followup — endpoint query parameters (head_sha + status + exclude_pull_requests)', () => {
  const runText = (SHA_GUARD.steps || []).map((s) => s.run || '').join('\n');

  it("gh api URL includes head_sha=", () => {
    expect(runText).toContain('head_sha=');
  });

  it("gh api URL includes status=success", () => {
    expect(runText).toContain('status=success');
  });

  it("gh api URL includes exclude_pull_requests=true", () => {
    expect(runText).toContain('exclude_pull_requests=true');
  });
});

describe('AC2 — needs/if wiring on three downstream jobs', () => {
  for (const jobName of DOWNSTREAM_JOBS) {
    it(`${jobName} has a needs: declaration that includes sha-guard`, () => {
      const job = CI_CONFIG.jobs[jobName];
      expect(job, `${jobName} job must exist`).toBeDefined();
      const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
      expect(needs).toContain('sha-guard');
    });

    it(`${jobName} has an if: condition that references needs.sha-guard.outputs.skip`, () => {
      const job = CI_CONFIG.jobs[jobName];
      // Coalesce multi-line YAML if literal: parsed YAML collapses to one string with newlines.
      const ifClause = job.if || '';
      expect(ifClause).toContain("needs.sha-guard.outputs.skip");
      expect(ifClause).toContain("'true'");
      // The condition must be a negation: skip != 'true' (so skip=='true' means SKIP).
      expect(ifClause).toMatch(/needs\.sha-guard\.outputs\.skip\s*!=\s*'true'/);
    });
  }

  it('each downstream job has exactly ONE `if` key (YAML duplicate-key silent overwrite guard)', () => {
    // YAML parsers silently keep only the LAST duplicate key. Source-grep the
    // raw YAML to make sure no downstream job stanza has multiple `if:` lines.
    for (const jobName of DOWNSTREAM_JOBS) {
      const jobBlockRe = new RegExp(
        `^  ${jobName}:\\s*$([\\s\\S]*?)^(?:  [a-z][\\w-]*:|$)`,
        'm',
      );
      const m = CI_YML_SRC.match(jobBlockRe);
      expect(m, `${jobName} block must be locatable`).not.toBeNull();
      const block = m[1];
      const ifLines = block.match(/^ {4}if:/gm) || [];
      expect(ifLines.length, `${jobName} must have exactly one top-level if: key (found ${ifLines.length})`).toBe(1);
    }
  });

  it('integration-tests preserves its staging-only condition composed with the new sha-guard check', () => {
    const ifClause = CI_CONFIG.jobs['integration-tests'].if || '';
    expect(ifClause).toContain('staging');
    expect(ifClause).toContain('needs.sha-guard.outputs.skip');
  });

  it('e2e-tests preserves its vars.RKS_E2E_ENABLED condition composed with the new sha-guard check', () => {
    const ifClause = CI_CONFIG.jobs['e2e-tests'].if || '';
    expect(ifClause).toContain('RKS_E2E_ENABLED');
    expect(ifClause).toContain('needs.sha-guard.outputs.skip');
  });
});

describe('AC3 — fail-open posture (safety-critical)', () => {
  it('AC3.a structural: sha-guard step declares continue-on-error: true', () => {
    const step = (SHA_GUARD.steps || []).find((s) => s.id === 'check' || s['continue-on-error'] !== undefined);
    expect(step).toBeDefined();
    expect(step['continue-on-error']).toBe(true);
  });

  it('AC3.b source-grep: || true (or || echo) pattern on the gh api invocation', () => {
    // The gh api line must short-circuit failures so the rest of the bash runs
    // and the explicit skip=false branch fires. Accept either `|| true` or
    // `|| echo` (both used in defensive shell patterns).
    const runText = (SHA_GUARD.steps || []).map((s) => s.run || '').join('\n');
    const hasOrTrue = /gh api[^|]*\|\|\s*(?:true|echo)/.test(runText);
    expect(hasOrTrue, 'gh api invocation must use `|| true` or `|| echo` to short-circuit non-zero exit').toBe(true);
  });

  it('AC3.c documented fallback: skip=false branch fires when gh api exits non-zero or response empty', () => {
    // Source-grep for the explicit fail-open log + skip=false write.
    const runText = (SHA_GUARD.steps || []).map((s) => s.run || '').join('\n');
    expect(runText).toContain('Running CI: guard fail-open');
    expect(runText).toMatch(/echo\s+"skip=false"\s+>>\s+"\$GITHUB_OUTPUT"/);
  });

  it('AC3 invariant: bash uses `set +e` (not `set -e`) so errors do not abort the step', () => {
    const runText = (SHA_GUARD.steps || []).map((s) => s.run || '').join('\n');
    // The default mode without `set -e` is OK too — only explicitly fail if
    // we find `set -euo pipefail` or `set -e` which would abort on error.
    const hasStrictMode = /^\s*set\s+-(?:euo?\s*pipefail|e\b)/m.test(runText);
    if (hasStrictMode) {
      // If strict mode is present, then `set +e` MUST also be present (relaxing before risky calls).
      expect(runText).toMatch(/set\s+\+e/);
    }
  });
});

describe('AC4 — self-exclusion via github.run_id', () => {
  const runText = (SHA_GUARD.steps || []).map((s) => s.run || '').join('\n');

  it('the workflow env block passes github.run_id to the bash script', () => {
    const step = (SHA_GUARD.steps || []).find((s) => s.id === 'check');
    expect(step).toBeDefined();
    expect(step.env).toBeDefined();
    // Any env name that holds run_id is acceptable; CURRENT_RUN_ID is the convention.
    const hasRunIdInEnv = Object.values(step.env || {}).some((v) =>
      /github\.run_id/.test(String(v)),
    );
    expect(hasRunIdInEnv, 'env block must expose github.run_id to the bash script').toBe(true);
  });

  it('jq filter excludes the current run id from the prior-success match', () => {
    // The bash + jq pipeline must compare candidate run ids against the current
    // run id and reject matches. Look for both the comparison and the rejection.
    expect(runText).toMatch(/\.id\s*\|\s*tostring\s*\)\s*!=\s*\$current_run_id/);
  });
});

describe('AC5 — skip-reason log strings', () => {
  const runText = (SHA_GUARD.steps || []).map((s) => s.run || '').join('\n');

  it('logs "Skipping CI" with prior run id, sha, and branch when skipping', () => {
    expect(runText).toContain('Skipping CI');
    // Reference variables for sha and prior run/branch.
    expect(runText).toMatch(/Skipping CI[^"\n]*\$CURRENT_SHA/);
    expect(runText).toMatch(/\$PRIOR_ID/);
    expect(runText).toMatch(/\$PRIOR_BRANCH/);
  });

  it('logs "Running CI" with a reason when not skipping', () => {
    expect(runText).toContain('Running CI');
    // At least one of the two reason strings must be present.
    const hasReason =
      /Running CI:\s*no prior success/.test(runText) ||
      /Running CI:\s*guard fail-open/.test(runText);
    expect(hasReason, 'Running CI log line must include a reason ("no prior success" or "guard fail-open")').toBe(true);
  });
});

describe('AC6 — source-grep pins (regression guard against future edits)', () => {
  it("CI_YML_SRC contains the literal 'actions/runs?head_sha=' endpoint substring", () => {
    expect(CI_YML_SRC).toContain('actions/runs?head_sha=');
  });

  it("CI_YML_SRC writes outputs.skip from a step (echo skip=... >> $GITHUB_OUTPUT)", () => {
    expect(CI_YML_SRC).toMatch(/echo\s+"skip=(?:true|false)"\s+>>\s+"\$GITHUB_OUTPUT"/);
  });

  it("CI_YML_SRC declares jobs.sha-guard.outputs.skip mapping (job-level output)", () => {
    expect(CI_YML_SRC).toMatch(/skip:\s*\$\{\{\s*steps\.[^.]+\.outputs\.skip\s*\}\}/);
  });

  it("CI_YML_SRC contains the literal `needs.sha-guard.outputs.skip != 'true'` condition", () => {
    expect(CI_YML_SRC).toContain("needs.sha-guard.outputs.skip != 'true'");
  });

  it("CI_YML_SRC has a needs: declaration including 'sha-guard' for each downstream job", () => {
    // Loose pin — the parsed-YAML test above is the authoritative check.
    // Source-grep that the literal substring appears at least N times.
    const occurrences = (CI_YML_SRC.match(/sha-guard/g) || []).length;
    // Expected: 1 job declaration + 3 needs: + 3 if: clauses + comments → at least 7
    expect(occurrences).toBeGreaterThanOrEqual(7);
  });

  it("CI_YML_SRC includes name == \"CI\" jq filter (workflow disambiguation, ARCH ask #1)", () => {
    // The guard must ONLY trip on prior CI workflow runs, not release-smoke or check-hooks-drift.
    expect(CI_YML_SRC).toMatch(/select\([^)]*\.name\s*==\s*"CI"/);
  });

  it("CI_YML_SRC declares permissions: { actions: read } on sha-guard (ARCH ask #3)", () => {
    expect(SHA_GUARD.permissions).toBeDefined();
    expect(SHA_GUARD.permissions.actions).toBe('read');
  });
});

describe('AC7 — A1 + A2 paths-ignore preservation (regression guard)', () => {
  describe('A1 entries preserved on on.push.paths-ignore', () => {
    for (const entry of A1_PRESERVED_ENTRIES) {
      it(`on.push.paths-ignore still contains A1 entry '${entry}'`, () => {
        expect(CI_CONFIG.on.push['paths-ignore']).toContain(entry);
      });
    }
  });

  describe('A1 entries preserved on on.pull_request.paths-ignore', () => {
    for (const entry of A1_PRESERVED_ENTRIES) {
      it(`on.pull_request.paths-ignore still contains A1 entry '${entry}'`, () => {
        expect(CI_CONFIG.on.pull_request['paths-ignore']).toContain(entry);
      });
    }
  });

  describe('A2 entries preserved on on.push.paths-ignore', () => {
    for (const entry of A2_PRESERVED_ENTRIES) {
      it(`on.push.paths-ignore still contains A2 entry '${entry}'`, () => {
        expect(CI_CONFIG.on.push['paths-ignore']).toContain(entry);
      });
    }
  });

  describe('A2 entries preserved on on.pull_request.paths-ignore', () => {
    for (const entry of A2_PRESERVED_ENTRIES) {
      it(`on.pull_request.paths-ignore still contains A2 entry '${entry}'`, () => {
        expect(CI_CONFIG.on.pull_request['paths-ignore']).toContain(entry);
      });
    }
  });

  it('on.push.branches still includes main and staging', () => {
    expect(CI_CONFIG.on.push.branches).toContain('main');
    expect(CI_CONFIG.on.push.branches).toContain('staging');
  });

  it('on.pull_request.branches still includes main and staging', () => {
    expect(CI_CONFIG.on.pull_request.branches).toContain('main');
    expect(CI_CONFIG.on.pull_request.branches).toContain('staging');
  });

  it('on.push.paths-ignore has no duplicate entries', () => {
    const arr = CI_CONFIG.on.push['paths-ignore'];
    expect(new Set(arr).size).toBe(arr.length);
  });

  it('on.pull_request.paths-ignore has no duplicate entries', () => {
    const arr = CI_CONFIG.on.pull_request['paths-ignore'];
    expect(new Set(arr).size).toBe(arr.length);
  });
});

describe('AC8 — operational post-merge verification (humans observe)', () => {
  // This AC is human-observable, not a unit assertion. Documented per Governor
  // convention so future readers know the gap and how to close it.
  it.skip('OPERATIONAL: next ff-merge to main with same SHA as a green staging run should skip unit tests (<30s sha-guard step, NOT full ~50min suite)', () => {
    // Verification: after v0.20.17 (or any future release) ships, open the
    // Actions UI and look at the CI run on main for the chore(release): X.Y.Z
    // commit. Expected: a single "sha-guard" job that takes <30s and logs
    // "Skipping CI: same SHA <...> already succeeded in run <...> on branch staging".
    // The downstream unit-tests / integration-tests / e2e-tests jobs should be
    // skipped (greyed-out with no run details). Total wall-clock <2 min.
    // If you see a full unit-test run firing, A5 regressed.
  });
});

describe('AC9 — rks_release CI-green gate independence (no edits to git-release.mjs)', () => {
  const gitReleasePath = path.join(REPO_ROOT, 'packages/mcp-rks/src/server/git/git-release.mjs');
  const gitReleaseSrc = fs.readFileSync(gitReleasePath, 'utf8');

  // SINGLE-SOURCED invocation-shape pattern. Declared exactly ONCE here, inside the AC9
  // describe (which opens well below the it.skip that skip-debt-audit.test.mjs pins by line
  // number), and evaluated BOTH by the real-source assertion below AND by every AC9 mutation
  // self-test. A self-test must never be able to author its own copy of this regex and mask a
  // silently weakened real pin. No /g flag, so .test() stays stateless across calls.
  //
  // The alternation is deliberately ordered LONGEST-FIRST. The semantically identical
  // optional-suffix form is FORBIDDEN here: its own SOURCE TEXT would place `spawn`
  // immediately before an open paren, self-tripping SPAWN_FAMILY_RE
  // (unit-tier-purity.test.mjs) and subprocess-timeout-convention.test.mjs. Both are TEXTUAL
  // detectors and this file IS scanned by both, so a regex literal is scored exactly like a
  // real call site.
  const INVOCATION_SHAPE_RE = /(?:spawnSync|spawn)\(\s*\n?\s*"gh",\s*\n?\s*\[\s*"run",\s*"list"/;

  // Mutant fixtures below are ALWAYS single-line .replace(...) transformations of the
  // runtime-read gitReleaseSrc, with both literals held inside single-line quoted strings.
  // That form is protected by the detectors' odd-quote heuristic. A multi-line
  // template-literal fixture carrying a call line would have EVEN quote counts in its prefix
  // and would be flagged as a genuine subprocess call — reproducing the very red this suite
  // exists to keep closed. Every anchor below was verified to occur exactly once in
  // git-release.mjs, and each mutant asserts it actually applied.
  const GH_RUN_LIST_CALL =
    'const ciCheck = spawn(\n    "gh",\n    ["run", "list", "--branch", integration, "--limit", "20", "--json", "databaseId,url,status,conclusion,headSha,createdAt"],\n    { cwd: projectRoot, encoding: "utf8", timeout: 30_000 },\n  );';
  const GATE_CALL_LINE =
    '    const ciGate = evaluateCiGate({ projectRoot, integration: branchConfig.integration });\n';
  const BUMP_LINE =
    '    const [major, minor, patch] = pkg.version.split(".").map(Number);\n';

  // INVOCATION_SHAPE_RE is a whole-file text match and is therefore POSITION-BLIND: it would
  // still pass if the gate were relocated BELOW the version bump. This helper is the separate
  // witness for that direction. It re-asserts anchor uniqueness at runtime rather than
  // trusting indexOf, because the obvious looser anchors are ambiguous:
  //   - bare `evaluateCiGate(` occurs twice (the declaration and the call site), and indexOf
  //     returns the DECLARATION — which always precedes the bump, making the check vacuous
  //     against exactly the relocation it exists to witness;
  //   - bare `"package.json"` occurs three times, one of them ABOVE the gate — which would
  //     make the ordering FALSE against correct source, an instant new red.
  const GATE_ANCHOR = 'const ciGate = evaluateCiGate(';
  const BUMP_ANCHOR = 'pkg.version.split(';

  function occurrences(haystack, needle) {
    return haystack.split(needle).length - 1;
  }

  function gateIsPreBump(src) {
    const gateHits = occurrences(src, GATE_ANCHOR);
    if (gateHits !== 1) {
      throw new Error(`gate anchor "${GATE_ANCHOR}" must occur exactly once; found ${gateHits}`);
    }
    const bumpHits = occurrences(src, BUMP_ANCHOR);
    if (bumpHits !== 1) {
      throw new Error(`bump anchor "${BUMP_ANCHOR}" must occur exactly once; found ${bumpHits}`);
    }
    return src.indexOf(GATE_ANCHOR) < src.indexOf(BUMP_ANCHOR);
  }

  it('git-release.mjs still invokes the staging-CI pre-bump gate via an array-form gh run list call', () => {
    // A1's pre-bump CI gate calls `gh run list --branch <integration> ...`. A3 split the args
    // across lines; the evaluateCiGate extraction then moved the call site onto that
    // function's INJECTABLE callee parameter (whose default is the child_process sync helper,
    // see the evaluateCiGate signature in git-release.mjs), so the callee IDENTIFIER at the
    // call site changed while the invocation did not.
    //
    // What this test pins is the INVOCATION SHAPE — the array-form gh run list carrying
    // --branch — not the callee identifier. Do NOT weaken it to a bare toContain: a gutted
    // gate would still pass that. The mutation self-tests below prove it.
    expect(gitReleaseSrc).toMatch(INVOCATION_SHAPE_RE);
    expect(gitReleaseSrc).toContain('"--branch"');
  });

  it('the invocation-shape pin accepts the seam DEFAULT callee too (the widening is real)', () => {
    const syncCalleeMutant = gitReleaseSrc.replace('const ciCheck = spawn(', 'const ciCheck = spawnSync(');
    expect(syncCalleeMutant, 'mutant did not apply — the call-site anchor drifted').not.toBe(gitReleaseSrc);
    expect(INVOCATION_SHAPE_RE.test(syncCalleeMutant)).toBe(true);
  });

  it('the invocation-shape pin REDS when the gh run list invocation is removed outright', () => {
    const removalMutant = gitReleaseSrc.replace(GH_RUN_LIST_CALL, 'const ciCheck = null;');
    expect(removalMutant, 'mutant did not apply — GH_RUN_LIST_CALL drifted').not.toBe(gitReleaseSrc);
    expect(INVOCATION_SHAPE_RE.test(removalMutant)).toBe(false);
  });

  it('the invocation-shape pin REDS when the call survives but its shape is gutted', () => {
    // (a) args array no longer leads with "run", "list"
    const wrongVerb = gitReleaseSrc.replace('["run", "list", "--branch"', '["run", "view", "--branch"');
    expect(wrongVerb, 'mutant did not apply — args-array anchor drifted').not.toBe(gitReleaseSrc);
    expect(INVOCATION_SHAPE_RE.test(wrongVerb)).toBe(false);

    // (b) args array emptied entirely
    const emptyArgs = gitReleaseSrc.replace('["run", "list", "--branch", integration, "--limit", "20", "--json", "databaseId,url,status,conclusion,headSha,createdAt"]', '[]');
    expect(emptyArgs, 'mutant did not apply — full args-array anchor drifted').not.toBe(gitReleaseSrc);
    expect(INVOCATION_SHAPE_RE.test(emptyArgs)).toBe(false);

    // (c) callee renamed out of the spawn family entirely
    const foreignCallee = gitReleaseSrc.replace('const ciCheck = spawn(', 'const ciCheck = runShell(');
    expect(foreignCallee, 'mutant did not apply — the call-site anchor drifted').not.toBe(gitReleaseSrc);
    expect(INVOCATION_SHAPE_RE.test(foreignCallee)).toBe(false);
  });

  it('the CI gate is still PRE-BUMP by source ordering', () => {
    expect(gateIsPreBump(gitReleaseSrc)).toBe(true);
  });

  it('the ordering check REDS when the gate is relocated below the version bump', () => {
    const relocated = gitReleaseSrc
      .replace(GATE_CALL_LINE, '')
      .replace(BUMP_LINE, BUMP_LINE + GATE_CALL_LINE);
    expect(relocated, 'relocation mutant did not apply — an anchor drifted').not.toBe(gitReleaseSrc);
    // The evaluateCiGate DECLARATION is deliberately RETAINED, so a naive
    // indexOf on the bare identifier would still find a hit above the bump.
    // That is precisely what makes this fixture non-vacuous.
    expect(relocated).toContain('export function evaluateCiGate(');
    expect(gateIsPreBump(relocated)).toBe(false);
  });

  it('the ordering check fails LOUDLY when an anchor is absent or duplicated', () => {
    const noGate = gitReleaseSrc.replace(GATE_CALL_LINE, '');
    expect(noGate).not.toBe(gitReleaseSrc);
    expect(() => gateIsPreBump(noGate)).toThrow(/exactly once/);

    const twoGates = gitReleaseSrc.replace(GATE_CALL_LINE, GATE_CALL_LINE + GATE_CALL_LINE);
    expect(twoGates).not.toBe(gitReleaseSrc);
    expect(() => gateIsPreBump(twoGates)).toThrow(/exactly once/);
  });

  it("git-release.mjs still emits the literal '[skip ci]' from A1", () => {
    // A1 regression guard — must remain intact through A5.
    expect(gitReleaseSrc).toContain('[skip ci]');
  });
});

describe('AC10 — workflow timeout cap (subprocess-rule mapping)', () => {
  it('jobs.sha-guard.timeout-minutes <= 5 (gh api should return in ~2s; 5min is generous headroom)', () => {
    const t = SHA_GUARD['timeout-minutes'];
    expect(t).toBeDefined();
    expect(typeof t).toBe('number');
    expect(t).toBeLessThanOrEqual(5);
  });
});

describe('Scaffolding constraints (test-file invariants)', () => {
  // Self-grep meta-tests would trip on their own assertion strings (a test that
  // asserts "no spawnSync in this file" contains the word spawnSync itself).
  // The structural invariant we actually want is "this test reads YAML the same
  // way A1/A2 do" — that's testable without a self-defeating string check.
  it('uses the same YAML parsing helper as A1/A2 tests', () => {
    const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(selfSrc).toContain("from 'yaml'");
  });
});
