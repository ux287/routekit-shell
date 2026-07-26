// Release & ops git operations — staging merge, release, sync, conflict, promote, repair.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ensureTelemetryStorage } from "../telemetry/index.mjs";
import { loadContext, getBranchConfig } from "../project.mjs";
import { updateField, resolveNotesDir } from "../../dendron.mjs";
import { advancePhase } from "../../workflow/auto-phase.mjs";
import { loadPublishProfiles, publish } from "../publish.mjs";
import {
  runGit,
  getCurrentBranch,
  VALID_UNLINKED_REASONS,
} from "./git-utils.mjs";
import { ghPrView } from "../gh-tools.mjs";

// ANSI escape stripper — runRelease's CI-diagnostic path (rawTail) needs clean
// text. Standard ansi-regex pattern; no external dep so this file stays tree-shake
// safe. Exported for unit-test pinning per backlog.feat.release-skill-diagnoses-ci-failures.
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
export function stripAnsi(s) {
  return typeof s === "string" ? s.replace(ANSI_REGEX, "") : "";
}

// Parse `gh run view <id> --log-failed` stdout into structured diagnostics.
// gh emits one tab-delimited record per log line: <job>\t<step>\t<timestamp>\t<content>
// failingJob/failingStep come from the FIRST emitted record (gh orders by job+step).
// failingTests are extracted via vitest's `FAIL <file>` marker; supports both
// "FAIL  path/file.test.mjs" (bare) and "FAIL  path > suite > test" (descriptive) forms.
// rawTail is the LAST 50 non-empty content lines, ANSI-stripped.
export function parseGhLogFailedOutput(rawStdout) {
  const cleaned = stripAnsi(rawStdout || "");
  const lines = cleaned.split("\n").filter((l) => l.length > 0);
  let failingJob = null;
  let failingStep = null;
  if (lines.length > 0) {
    const firstParts = lines[0].split("\t");
    if (firstParts.length >= 2) {
      failingJob = firstParts[0] || null;
      failingStep = firstParts[1] || null;
    }
  }
  const failingTests = [];
  // Match vitest FAIL lines. Anchored by \bFAIL\b followed by whitespace, then a
  // path ending in .test.{mjs,js,ts} or .spec.{mjs,js,ts}. Optional `> ... > name`.
  const FAIL_RE = /\bFAIL\b\s+([^\s>\t]+\.(?:test|spec)\.(?:mjs|js|ts|cjs|mts|cts))(?:\s*>\s*([^\t\n]+?))?(?=$|\s{2,}|\t)/g;
  for (const line of lines) {
    // gh prefixes each line with `<job>\t<step>\t<ts>\t`. Slice to the content
    // segment to avoid false-positive matches on job names containing "FAIL".
    const tabParts = line.split("\t");
    const content = tabParts.length >= 4 ? tabParts.slice(3).join("\t") : line;
    FAIL_RE.lastIndex = 0;
    let m;
    while ((m = FAIL_RE.exec(content)) !== null) {
      failingTests.push({ file: m[1], test: (m[2] || "").trim() || null });
    }
  }
  // Tail of the content-only lines (drop the tab prefix when present) so the
  // tail is human-readable, not gh's metadata-prefixed form.
  const contentLines = lines.map((line) => {
    const parts = line.split("\t");
    return parts.length >= 4 ? parts.slice(3).join("\t") : line;
  });
  const rawTail = contentLines.slice(-50);
  return { failingJob, failingStep, failingTests, rawTail };
}

// Run `gh run view <id> --log-failed` and shape the result into a `diagnostics`
// object suitable for inclusion in the rks_release tool response. Returns
// `{ runId, runUrl, failingJob, failingStep, failingTests, rawTail }` on success
// or `{ error, ...optional rawTail }` on subprocess failure (ENOENT, auth fail,
// timeout). Production timeout: 60s — gh log fetches can be sizable.
export function fetchCiDiagnostics({ projectRoot, runId, runUrl, spawn = spawnSync }) {
  const result = spawn(
    "gh",
    ["run", "view", String(runId), "--log-failed"],
    { cwd: projectRoot, encoding: "utf8", timeout: 60_000 },
  );
  if (result.error && result.error.code === "ENOENT") {
    return { error: `gh CLI unavailable; check the run manually at ${runUrl}` };
  }
  // spawnSync sets `signal` to "SIGTERM" when killed by the timeout option on
  // POSIX, and result.error may be set with code ETIMEDOUT depending on Node ver.
  if (result.signal === "SIGTERM" || (result.error && result.error.code === "ETIMEDOUT")) {
    return { error: `gh run view timed out after 60s; check the run manually at ${runUrl}` };
  }
  if (result.status !== 0) {
    // Auth failure (gh: Not Found / authentication required), invalid run id, etc.
    const stderrText = stripAnsi((result.stderr || "").toString());
    const rawTail = stderrText.split("\n").filter(Boolean).slice(-50);
    return {
      error: `gh run view failed (status ${result.status}); check the run manually at ${runUrl}`,
      rawTail,
    };
  }
  const parsed = parseGhLogFailedOutput(result.stdout || "");
  return { runId, runUrl, ...parsed };
}

export async function runStagingMerge({ projectRoot, prNumber = null, problemId = null, reason = null, projectId = "unknown" }) {
  const timestamp = new Date().toISOString();
  const collector = ensureTelemetryStorage(projectRoot);
  try {
    if (!problemId && !reason) {
      return { ok: false, error: "Either problemId or reason is required", hint: `Provide problemId to link to a backlog story, or reason for unlinked merges. Valid reasons: ${VALID_UNLINKED_REASONS.join(", ")}` };
    }
    if (reason && !VALID_UNLINKED_REASONS.includes(reason)) {
      return { ok: false, error: `Invalid reason '${reason}'. Valid reasons: ${VALID_UNLINKED_REASONS.join(", ")}` };
    }

    const featureBranch = getCurrentBranch(projectRoot);
    let prNum = prNumber;
    if (!prNum) {
      const view = spawnSync("gh", ["pr", "view", "--json", "number"], { cwd: projectRoot, encoding: "utf8" });
      if (view.status !== 0) return { ok: false, error: "No PR found for current branch" };
      prNum = JSON.parse(view.stdout).number;
    }

    const prView = ghPrView({ projectRoot, prNumber: prNum });
    if (!prView.ok) return { ok: false, error: `Failed to fetch PR checks: ${prView.error}` };
    const checks = prView.pr.checks;
    if (checks.length === 0) {
      collector.emit("staging.merge.no_ci", projectId, { prNumber: prNum, warning: "No CI checks configured — proceeding without CI gate" });
    } else {
      const running = checks.filter((c) => c.status !== "COMPLETED");
      if (running.length > 0) return { ok: false, error: "CI checks still running", checks };
      const failed = checks.filter((c) => c.conclusion !== "SUCCESS");
      if (failed.length > 0) return { ok: false, error: "CI checks failed", checks };
    }

    const merge = spawnSync("gh", ["pr", "merge", String(prNum), "--squash", "--delete-branch"], { cwd: projectRoot, encoding: "utf8" });
    if (merge.status !== 0) return { ok: false, error: merge.stderr || "merge failed" };
    spawnSync("git", ["checkout", "staging"], { cwd: projectRoot, encoding: "utf8" });
    spawnSync("git", ["pull"], { cwd: projectRoot, encoding: "utf8" });
    let localBranchDeleted = false;
    if (featureBranch && featureBranch !== "staging" && featureBranch !== "main") {
      const del = spawnSync("git", ["branch", "-d", featureBranch], { cwd: projectRoot, encoding: "utf8" });
      localBranchDeleted = del.status === 0;
    }
    const commitId = runGit(projectRoot, ["rev-parse", "--short", "HEAD"]);
    let phaseUpdated = false;
    if (problemId) {
      try {
        // R1.3-followup: route through advancePhase('ship') instead of direct
        // updateField. advancePhase validates the executed → integrated transition
        // and emits telemetry. Defensive: if the story is already past executed
        // (e.g., re-merge of an already-integrated story), log and continue —
        // the git merge has already succeeded and shouldn't be reversed.
        const advanceResult = await advancePhase(projectRoot, problemId, "ship", projectId);
        if (advanceResult.ok) {
          phaseUpdated = true;
        } else {
          console.error(`[rks_staging_merge] phase update failed: ${advanceResult.error}`);
        }
      } catch (err) {
        console.error(`[rks_staging_merge] phase update failed: ${err.message}`);
      }
    }

    collector.emit("pr.merged", projectId, { prNumber: prNum, commitId, problemId: problemId || null, reason: reason || null, mode: problemId ? "linked" : "unlinked" });

    if (reason && !problemId) {
      collector.emit("merge.unlinked", projectId, { prNumber: prNum, commitId, reason, hint: "Merge without story linkage - requires human approval in child projects" });
    }

    return { ok: true, merged: true, commitId, prNumber: prNum, backlogUpdated: false, phaseUpdated, localBranchDeleted, metadata: { timestamp } };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

// Transition every backlog story currently at phase `integrated` to `released`,
// stamping `releasedIn`. Shared by the fresh-release path and the resume path.
// R1.3-followup: phase write now routes through advancePhase (which validates
// the integrated → released transition and emits telemetry). The regex stays
// as the DISCOVERY mechanism; the WRITE goes through the state-machine helper.
// The releasedIn metadata is still a direct updateField (metadata, not phase).
// See notes/research.2026.06.13.integrated-implemented-released-arc.md §7.
async function transitionIntegratedStories(projectRoot, newVersion, projectId = "unknown") {
  const notesDir = resolveNotesDir(projectRoot);
  const releasedStories = [];
  const noteFiles = fs.readdirSync(notesDir).filter(f => f.startsWith("backlog.") && f.endsWith(".md"));
  for (const file of noteFiles) {
    const content = fs.readFileSync(path.join(notesDir, file), "utf8");
    const phaseMatch = content.match(/^phase:\s*["']?integrated["']?/m);
    if (phaseMatch) {
      const problemId = file.replace(".md", "");
      try {
        const advanceResult = await advancePhase(projectRoot, problemId, "release", projectId);
        if (!advanceResult.ok) {
          console.error(`[rks_release] failed to update ${problemId}: ${advanceResult.error}`);
          continue;
        }
        updateField(notesDir, problemId, "releasedIn", newVersion);
        releasedStories.push(problemId);
      } catch (err) {
        console.error(`[rks_release] failed to update ${problemId}: ${err.message}`);
      }
    }
  }
  return releasedStories;
}

export async function runRelease({ projectRoot, version = "patch", changelog = null, projectId = "unknown", projectRecord = null, projectJson = null }) {
  const timestamp = new Date().toISOString();
  const releaseStartMs = Date.now();
  const collector = ensureTelemetryStorage(projectRoot);
  try {
    // Resolve branch topology — integration (release source) + production (release
    // target). Defaults to staging/main; 3-branch projects override via getBranchConfig.
    const branchConfig = getBranchConfig(projectRecord, projectJson);
    const currentBranch = runGit(projectRoot, ["branch", "--show-current"]);
    collector.emit("release.start", projectId, { version, bump: version, branch: currentBranch });
    if (currentBranch !== branchConfig.integration) {
      collector.emit("release.failed", projectId, { version, durationMs: Date.now() - releaseStartMs, error: `Must be on ${branchConfig.integration} branch to release` });
      return { ok: false, error: `Must be on ${branchConfig.integration} branch to release` };
    }
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
    if (status.stdout.trim()) {
      return { ok: false, error: "Working tree not clean" };
    }

    spawnSync("git", ["fetch", "origin", branchConfig.integration], { cwd: projectRoot, encoding: "utf8" });
    const syncCountResult = spawnSync("git", ["rev-list", "--left-right", "--count", `${branchConfig.integration}...origin/${branchConfig.integration}`], { cwd: projectRoot, encoding: "utf8" });
    if (syncCountResult.status !== 0) {
      return { ok: false, error: `Failed to compare ${branchConfig.integration} with origin/${branchConfig.integration}.` };
    }
    const [syncAhead, syncBehind] = syncCountResult.stdout.trim().split(/\s+/).map(Number);
    if (syncAhead > 0 && syncBehind === 0) {
      // Clean fast-forward ahead: origin/<integration> is an ancestor of local HEAD, so a plain
      // push is a guaranteed remote fast-forward (no --force, no rewrite). Self-push here — the
      // governed release path previously dead-ended asking the user to `git push` manually, even
      // though the off-rail auto-ship already pushes staging via this same mechanism
      // (guardrails-audit.mjs). On push failure ABORT before any irreversible step (version bump,
      // production ff-merge, tag) — never force-push, never proceed.
      const pushAhead = spawnSync("git", ["push", "origin", branchConfig.integration], { cwd: projectRoot, encoding: "utf8" });
      if (pushAhead.status !== 0) {
        const detail = (pushAhead.stderr || pushAhead.stdout || "").trim();
        collector.emit("release.failed", projectId, { version, durationMs: Date.now() - releaseStartMs, error: `Failed to push ${branchConfig.integration} to origin` });
        return { ok: false, error: `Failed to push ${branchConfig.integration} to origin/${branchConfig.integration}${detail ? `: ${detail}` : "."} Resolve and re-run release.` };
      }
    }
    if (syncBehind > 0 && syncAhead === 0) {
      return { ok: false, error: `Local ${branchConfig.integration} is behind origin/${branchConfig.integration}. Pull first.` };
    }
    if (syncAhead > 0 && syncBehind > 0) {
      return { ok: false, error: `${branchConfig.integration} has diverged from origin/${branchConfig.integration}. Rebase or reset.` };
    }

    const ciCheck = spawnSync(
      "gh",
      ["run", "list", "--branch", branchConfig.integration, "--limit", "1", "--json", "databaseId,url,status,conclusion,headSha"],
      { cwd: projectRoot, encoding: "utf8", timeout: 30_000 },
    );
    if (ciCheck.status === 0) {
      try {
        const runs = JSON.parse(ciCheck.stdout);
        if (runs.length > 0) {
          const latest = runs[0];
          const runUrl = latest.url || `https://github.com (run ${latest.databaseId})`;
          if (latest.status !== "completed") {
            return { ok: false, error: `CI in progress at ${runUrl}` };
          }
          if (latest.conclusion !== "success") {
            const diagnostics = fetchCiDiagnostics({ projectRoot, runId: latest.databaseId, runUrl });
            return {
              ok: false,
              error: `CI failed on ${branchConfig.integration} (conclusion: ${latest.conclusion}). Fix before releasing.`,
              diagnostics,
            };
          }
        }
      } catch (e) { /* gh parse failure, proceed */ }
    }

    const pkgPath = path.join(projectRoot, "package.json");
    if (!fs.existsSync(pkgPath)) return { ok: false, error: "No package.json found" };
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const [major, minor, patch] = pkg.version.split(".").map(Number);
    let newVersion;
    if (version === "major") newVersion = `${major + 1}.0.0`;
    else if (version === "minor") newVersion = `${major}.${minor + 1}.0`;
    else newVersion = `${major}.${minor}.${patch + 1}`;

    // Resume detection — if the integration branch HEAD is already a `chore(release): X`
    // commit, a prior release run reached the bump but did not finish. Reuse X (never
    // re-derive from package.json, never re-bump) and reconcile against remote state.
    let resuming = false;
    const resumeHeadSubject = runGit(projectRoot, ["log", "-1", "--format=%s", branchConfig.integration]);
    const resumeMatch = resumeHeadSubject.match(/^chore\(release\): (.+)$/);
    if (resumeMatch) {
      resuming = true;
      newVersion = resumeMatch[1];
      spawnSync("git", ["fetch", "origin", branchConfig.production], { cwd: projectRoot, encoding: "utf8" });
      const resumeRemoteMain = runGit(projectRoot, ["rev-parse", `origin/${branchConfig.production}`]);
      const resumeStagingHead = runGit(projectRoot, ["rev-parse", branchConfig.integration]);
      const resumeTagLs = spawnSync("git", ["ls-remote", "--tags", "origin", `v${newVersion}`], { cwd: projectRoot, encoding: "utf8" });
      const resumeTagOnOrigin = ((resumeTagLs.stdout || "").trim()) !== "";
      if (resumeRemoteMain === resumeStagingHead && resumeTagOnOrigin) {
        // Resume Row 1 — the release already completed on origin. Fast-forward the local
        // production branch, fetch the tag, finish local story bookkeeping, return.
        spawnSync("git", ["checkout", branchConfig.production], { cwd: projectRoot });
        spawnSync("git", ["merge", "--ff-only", `origin/${branchConfig.production}`], { cwd: projectRoot });
        spawnSync("git", ["fetch", "origin", "tag", `v${newVersion}`], { cwd: projectRoot });
        spawnSync("git", ["checkout", branchConfig.integration], { cwd: projectRoot });
        const resumedStories = await transitionIntegratedStories(projectRoot, newVersion, projectId);
        return { ok: true, version: newVersion, tag: `v${newVersion}`, resumed: true, releasedStories: resumedStories, metadata: { timestamp } };
      }
      // Resume Rows 2 & 3 — the bump exists but merge/tag/push is incomplete. Skip the
      // pre-mutation gate and the bump below; the merge/tag/push stages are each
      // idempotent and converge from whichever step the prior run stopped at.
    }

    if (!resuming) {
      // Pre-mutation divergence + tag-existence gate. Runs BEFORE any file write or
      // commit — on any failure the repo is byte-identical to the pre-call state.
      spawnSync("git", ["fetch", "origin", branchConfig.production], { cwd: projectRoot, encoding: "utf8" });
      const gateLocalMain = runGit(projectRoot, ["rev-parse", branchConfig.production]);
      const gateRemoteMain = runGit(projectRoot, ["rev-parse", `origin/${branchConfig.production}`]);
      // (1) Local production branch must not have diverged. Behind-only is fast-forwardable.
      const mainMergeBase = runGit(projectRoot, ["merge-base", branchConfig.production, `origin/${branchConfig.production}`]);
      if (gateLocalMain !== gateRemoteMain && mainMergeBase !== gateLocalMain) {
        return { ok: false, error: `Local ${branchConfig.production} has diverged from origin/${branchConfig.production} (local commits not on origin). Run \`git fetch && git reset --hard origin/${branchConfig.production}\` then retry rks_release.` };
      }
      // (2) integration must fast-forward production: origin/<production> must be an ancestor of integration HEAD.
      const releaseMergeBase = runGit(projectRoot, ["merge-base", `origin/${branchConfig.production}`, branchConfig.integration]);
      if (releaseMergeBase !== gateRemoteMain) {
        return { ok: false, error: `${branchConfig.production} and ${branchConfig.integration} have diverged — ${branchConfig.integration} cannot fast-forward ${branchConfig.production}. Rebase ${branchConfig.integration} onto ${branchConfig.production} (\`git rebase origin/${branchConfig.production} ${branchConfig.integration}\`) then retry rks_release.` };
      }
      // (3) the release tag must not already exist locally or on origin.
      const tagExistsLocal = runGit(projectRoot, ["tag", "--list", `v${newVersion}`]);
      const tagLsRemote = spawnSync("git", ["ls-remote", "--tags", "origin", `v${newVersion}`], { cwd: projectRoot, encoding: "utf8" });
      if (tagExistsLocal || (tagLsRemote.stdout || "").trim()) {
        return { ok: false, error: `Tag v${newVersion} already exists. Bump version or delete the stale tag before retrying.` };
      }
    }

    // Late, idempotent version bump — the last mutation on staging before checkout main.
    // Idempotent: if staging HEAD is already this release's bump, reuse it (no re-commit).
    const stagingHeadSubject = runGit(projectRoot, ["log", "-1", "--format=%s", branchConfig.integration]);
    const date = new Date().toISOString().split("T")[0];
    // Notes: prefer the caller's changelog; else derive from commits since the
    // previous release tag so releases never carry the bare "Release <version>".
    let notes = changelog;
    if (!notes) {
      const descRes = spawnSync("git", ["describe", "--tags", "--abbrev=0", "HEAD"], { cwd: projectRoot, encoding: "utf8" });
      const prevTag = descRes.status === 0 ? (descRes.stdout || "").trim() : "";
      const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
      const logOut = spawnSync("git", ["log", range, "--no-merges", "--pretty=format:- %s"], { cwd: projectRoot, encoding: "utf8" });
      notes = (logOut.stdout || "").trim() || `Release ${newVersion}`;
    }
    if (stagingHeadSubject !== `chore(release): ${newVersion}`) {
      pkg.version = newVersion;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      // Lockstep bump: keep the workspace sub-packages in version-sync with root so the three
      // package.json files never drift (backlog.chore.codify-semver-versioning-policy). Each write
      // is existsSync-guarded — child projects and test fixtures without these sub-packages must
      // not throw — and only the files that were actually written are staged below.
      const bumpedFiles = ["package.json"];
      for (const rel of ["packages/mcp-rks/package.json", "packages/cli/package.json"]) {
        const subPath = path.join(projectRoot, rel);
        if (!fs.existsSync(subPath)) continue;
        try {
          const subPkg = JSON.parse(fs.readFileSync(subPath, "utf8"));
          subPkg.version = newVersion;
          fs.writeFileSync(subPath, JSON.stringify(subPkg, null, 2) + "\n");
          bumpedFiles.push(rel);
        } catch { /* leave a malformed sub-package.json untouched rather than crash the release */ }
      }
      const changelogPath = path.join(projectRoot, "CHANGELOG.md");
      const entry = `## [${newVersion}] - ${date}\n\n${notes}\n\n`;
      if (fs.existsSync(changelogPath)) {
        const existing = fs.readFileSync(changelogPath, "utf8");
        fs.writeFileSync(changelogPath, entry + existing);
      } else {
        fs.writeFileSync(changelogPath, `# Changelog\n\n${entry}`);
      }
      spawnSync("git", ["add", ...bumpedFiles, "CHANGELOG.md"], { cwd: projectRoot });
      // [skip ci] in the body tells GitHub Actions to skip the workflow on this
      // commit. Combined with the paths-ignore filter in .github/workflows/ci.yml
      // (which catches the bump-only file set: package.json + CHANGELOG.md), this
      // eliminates 2-3 redundant ~50min CI runs per release on identical content
      // (staging push, main ff-merge, tag push). The literal string `[skip ci]`
      // is canonical; alternatives like `[ci skip]` work too but `[skip ci]` is
      // the one source-grep tests pin against. See backlog.fix.ci-skips-release-bump-commits.
      const commitResult = spawnSync("git", ["commit", "-m", `chore(release): ${newVersion}`, "-m", "[skip ci]"], { cwd: projectRoot, encoding: "utf8" });
      if (commitResult.status !== 0) return { ok: false, error: "Failed to commit version bump" };
    }

    // Step 3: Checkout production and ff-merge integration (divergence already gated above)
    spawnSync("git", ["checkout", branchConfig.production], { cwd: projectRoot });
    const preMergeMain = runGit(projectRoot, ["rev-parse", "HEAD"]);
    const mergeResult = spawnSync("git", ["merge", "--ff-only", branchConfig.integration], { cwd: projectRoot, encoding: "utf8" });
    if (mergeResult.status !== 0) {
      // FF-merge failed — production HEAD never moved, nothing to undo there.
      // Roll back the version bump commit on the integration branch before returning.
      spawnSync("git", ["checkout", branchConfig.integration], { cwd: projectRoot });
      spawnSync("git", ["reset", "--hard", "HEAD~1"], { cwd: projectRoot });
      return { ok: false, error: `Cannot fast-forward ${branchConfig.production} onto ${branchConfig.integration}. Rebase ${branchConfig.integration} onto ${branchConfig.production} first, then retry.` };
    }

    // Step 4: Create tag on main (after successful ff-merge). Idempotent — on a
    // resume the release tag may already exist locally; reuse it instead of failing.
    if (!runGit(projectRoot, ["tag", "--list", `v${newVersion}`])) {
      const tagResult = spawnSync("git", ["tag", "-a", `v${newVersion}`, "-m", `Release ${newVersion}`], { cwd: projectRoot, encoding: "utf8" });
      if (tagResult.status !== 0) {
        // Rollback: reset production to pre-merge state, then undo the bump on integration.
        spawnSync("git", ["reset", "--hard", preMergeMain], { cwd: projectRoot });
        spawnSync("git", ["checkout", branchConfig.integration], { cwd: projectRoot });
        // Guarded: only reset integration if HEAD is in fact this release's bump commit.
        if (runGit(projectRoot, ["log", "-1", "--format=%s", "HEAD"]) === `chore(release): ${newVersion}`) {
          spawnSync("git", ["reset", "--hard", "HEAD~1"], { cwd: projectRoot });
        }
        return { ok: false, error: "Failed to create tag" };
      }
    }

    // Step 5: Push production, then the single new release tag (with rollback on failure).
    // Never `git push --tags` — that pushes every local tag and a pre-existing-tag
    // rejection returns non-zero for the whole push, falsely triggering rollback.
    const pushResult = spawnSync("git", ["push", "origin", branchConfig.production], { cwd: projectRoot, encoding: "utf8" });
    if (pushResult.status !== 0) {
      // Rollback: delete local tag, reset production, then undo the bump on integration.
      spawnSync("git", ["tag", "-d", `v${newVersion}`], { cwd: projectRoot });
      spawnSync("git", ["reset", "--hard", preMergeMain], { cwd: projectRoot });
      spawnSync("git", ["checkout", branchConfig.integration], { cwd: projectRoot });
      // Guarded: only reset integration if HEAD is in fact this release's bump commit.
      if (runGit(projectRoot, ["log", "-1", "--format=%s", "HEAD"]) === `chore(release): ${newVersion}`) {
        spawnSync("git", ["reset", "--hard", "HEAD~1"], { cwd: projectRoot });
      }
      return { ok: false, error: `Push failed: ${pushResult.stderr || "unknown error"}. Tag and merge rolled back.` };
    }
    // Push exactly the new release tag — one ref, cannot be rejected as "already exists".
    const tagPushResult = spawnSync("git", ["push", "origin", `v${newVersion}`], { cwd: projectRoot, encoding: "utf8" });
    if (tagPushResult.status !== 0) {
      // Defense-in-depth: a non-zero exit is not necessarily fatal. If the remote tag
      // already resolves to our local tag SHA, the tag is effectively pushed.
      const localTagSha = runGit(projectRoot, ["rev-parse", `v${newVersion}`]);
      const remoteTagLs = spawnSync("git", ["ls-remote", "--tags", "origin", `v${newVersion}`], { cwd: projectRoot, encoding: "utf8" });
      const remoteTagSha = (remoteTagLs.stdout || "").trim().split(/\s+/)[0] || "";
      if (remoteTagSha !== localTagSha) {
        spawnSync("git", ["tag", "-d", `v${newVersion}`], { cwd: projectRoot });
        spawnSync("git", ["reset", "--hard", preMergeMain], { cwd: projectRoot });
        spawnSync("git", ["checkout", branchConfig.integration], { cwd: projectRoot });
        // Guarded: only reset integration if HEAD is in fact this release's bump commit.
        if (runGit(projectRoot, ["log", "-1", "--format=%s", "HEAD"]) === `chore(release): ${newVersion}`) {
          spawnSync("git", ["reset", "--hard", "HEAD~1"], { cwd: projectRoot });
        }
        return { ok: false, error: `Tag push failed: ${tagPushResult.stderr || "unknown error"}. Tag and merge rolled back.` };
      }
    }

    // Push the integration branch to keep origin in sync with the version bump commit
    spawnSync("git", ["checkout", branchConfig.integration], { cwd: projectRoot });
    const stagingPushResult = spawnSync("git", ["push", "origin", branchConfig.integration], { cwd: projectRoot, encoding: "utf8" });
    let stagingPushWarning = null;
    if (stagingPushResult.status !== 0) {
      // The production branch and the tag are already pushed — the release is complete on origin.
      // A local rollback is impossible and would corrupt local state. Report ok:true with a warning.
      stagingPushWarning = `Release complete but ${branchConfig.integration} push failed — run: git push origin ${branchConfig.integration}. Details: ${stagingPushResult.stderr?.trim() || "unknown error"}`;
      console.error(`[rks_release] ${stagingPushWarning}`);
    }

    // Step 6: Create GitHub Release (non-fatal — tag and push already succeeded)
    let ghReleaseWarning = null;
    const ghReleaseResult = spawnSync("gh", ["release", "create", `v${newVersion}`, "--title", `v${newVersion}`, "--notes", notes], { cwd: projectRoot, encoding: "utf8" });
    if (ghReleaseResult.status !== 0) {
      ghReleaseWarning = `GitHub Release creation failed: ${ghReleaseResult.stderr?.trim() || "unknown error"}. Tag v${newVersion} was pushed — create the release manually on GitHub.`;
      console.error(`[rks_release] ${ghReleaseWarning}`);
    }

    // Step 7: Publish rks-public profile (non-fatal)
    let publishResult;
    try {
      const publishConfig = loadPublishProfiles(projectRoot);
      if (!publishConfig.profiles?.["rks-public"]) {
        publishResult = { skipped: true, reason: "rks-public profile not configured" };
        console.log("[rks_release] rks-public profile not found — skipping publish step");
      } else {
        const remoteEntries = Object.entries(publishConfig.remotes || {});
        const matchingEntry = remoteEntries.find(([name, r]) => r.profile === "rks-public" || name === "rks-public");
        if (!matchingEntry) {
          publishResult = { skipped: true, reason: "no remote configured for rks-public profile" };
          console.log("[rks_release] no remote uses rks-public profile — skipping publish step");
        } else {
          const [remoteName] = matchingEntry;
          try {
            const pubResult = await publish(projectRoot, {
              profile: "rks-public",
              remote: remoteName,
              message: `Release ${newVersion}`,
              projectId,
            });
            if (!pubResult.ok) {
              const warning = `Publish to ${remoteName} failed: ${pubResult.error}`;
              console.error(`[rks_release] ${warning}`);
              publishResult = { ok: false, warning };
            } else {
              publishResult = { ok: true };
            }
          } catch (pubErr) {
            const warning = `Publish to ${remoteName} threw: ${pubErr.message}`;
            console.error(`[rks_release] ${warning}`);
            publishResult = { ok: false, warning };
          }
        }
      }
    } catch (profileErr) {
      publishResult = { skipped: true, reason: `failed to load publish profiles: ${profileErr.message}` };
    }

    // Step 7b: display-only GitHub Release on the PUBLIC mirror repo. The rks-public
    // publish above force-pushes a fresh single-commit snapshot (no tags) to the public
    // repo's main, so `gh release create --repo <public> --target main` creates the tag
    // v<version> at the just-published public main HEAD. The Release persists in the
    // public Releases list even after a later publish force-push orphans the commit
    // (display-only — NOT `git checkout`-able on the public repo). Non-fatal + idempotent,
    // and only runs when the publish actually updated public main.
    let publicReleaseWarning = null;
    if (publishResult?.ok) {
      let publicRepo = null;
      // Public target branch comes from the rks-public remote config — never a hardcoded
      // branch literal; fall back to the production branch if the remote omits it.
      let publicBranch = branchConfig.production;
      try {
        const cfg = loadPublishProfiles(projectRoot);
        const entry = Object.entries(cfg.remotes || {}).find(([name, r]) => r.profile === "rks-public" || name === "rks-public");
        const url = entry?.[1]?.url || "";
        const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
        publicRepo = m ? m[1] : null;
        if (entry?.[1]?.branch) publicBranch = entry[1].branch;
      } catch { publicRepo = null; }
      if (publicRepo) {
        // Idempotent: refresh notes if the release already exists, else create it.
        const exists = spawnSync("gh", ["release", "view", `v${newVersion}`, "--repo", publicRepo], { cwd: projectRoot, encoding: "utf8" });
        const ghArgs = exists.status === 0
          ? ["release", "edit", `v${newVersion}`, "--repo", publicRepo, "--notes", notes]
          : ["release", "create", `v${newVersion}`, "--repo", publicRepo, "--target", publicBranch, "--title", `v${newVersion}`, "--notes", notes];
        const pubRelease = spawnSync("gh", ghArgs, { cwd: projectRoot, encoding: "utf8" });
        if (pubRelease.status !== 0) {
          publicReleaseWarning = `Public GitHub Release on ${publicRepo} failed: ${pubRelease.stderr?.trim() || "unknown error"}. Create it manually on GitHub.`;
          console.error(`[rks_release] ${publicReleaseWarning}`);
        }
      } else {
        publicReleaseWarning = "Public GitHub Release skipped — could not resolve public repo slug from the rks-public remote.";
        console.error(`[rks_release] ${publicReleaseWarning}`);
      }
    }

    spawnSync("git", ["checkout", branchConfig.integration], { cwd: projectRoot });

    const releasedStories = await transitionIntegratedStories(projectRoot, newVersion, projectId);

    const result = { ok: true, version: newVersion, tag: `v${newVersion}`, releasedStories, publishResult, metadata: { timestamp } };
    if (resuming) result.resumed = true;
    if (stagingPushWarning) result.warning = stagingPushWarning;
    if (ghReleaseWarning) result.warning = result.warning ? `${result.warning}\n${ghReleaseWarning}` : ghReleaseWarning;
    if (publicReleaseWarning) result.warning = result.warning ? `${result.warning}\n${publicReleaseWarning}` : publicReleaseWarning;
    const releaseSha = (() => { try { return runGit(projectRoot, ["rev-parse", "--short", `v${newVersion}^{}`]); } catch (e) { return null; } })();
    try { collector.emit("release.complete", projectId, { version: newVersion, tag: `v${newVersion}`, sha: releaseSha, bump: version, branch: currentBranch, durationMs: Date.now() - releaseStartMs, changelogLines: notes.split("\n").length }); } catch (e) { /* telemetry is best-effort */ }
    return result;
  } catch (error) {
    try { collector.emit("release.failed", projectId, { version, durationMs: Date.now() - releaseStartMs, error: error.message || String(error) }); } catch (e) { /* telemetry is best-effort */ }
    return { ok: false, error: error.message || String(error) };
  }
}

export async function runSyncStaging({ projectRoot, strategy = "auto" }) {
  const timestamp = new Date().toISOString();
  try {
    const currentBranch = runGit(projectRoot, ["branch", "--show-current"]);
    if (currentBranch !== "staging") return { ok: false, error: "Must be on staging branch to sync" };

    const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
    if (status.stdout.trim()) return { ok: false, error: "Working tree not clean - commit or stash first" };

    spawnSync("git", ["fetch", "origin", "staging"], { cwd: projectRoot });

    const countResult = spawnSync("git", ["rev-list", "--left-right", "--count", "staging...origin/staging"], { cwd: projectRoot, encoding: "utf8" });
    if (countResult.status !== 0) return { ok: false, error: "Failed to compare with origin/staging" };

    const [ahead, behind] = countResult.stdout.trim().split(/\s+/).map(Number);

    if (ahead === 0 && behind === 0) return { ok: true, state: "equivalent", action: "none", metadata: { timestamp } };
    if (ahead > 0 && behind === 0) {
      const pushAheadResult = spawnSync("git", ["push", "origin", "staging"], { cwd: projectRoot, encoding: "utf8" });
      if (pushAheadResult.status !== 0) {
        return { ok: false, error: "staging_ahead_push_failed", message: pushAheadResult.stderr || "Push failed" };
      }
      return { ok: true, state: "ahead", ahead, action: "pushed", pushed: ahead, metadata: { timestamp } };
    }

    if (behind > 0 && ahead === 0) {
      const pullResult = spawnSync("git", ["pull", "--ff-only", "origin", "staging"], { cwd: projectRoot, encoding: "utf8" });
      if (pullResult.status !== 0) return { ok: false, error: "Failed to fast-forward" };
      return { ok: true, state: "behind", behind, action: "pulled", metadata: { timestamp } };
    }

    const effectiveStrategy = strategy === "auto" ? "rebase" : strategy;
    console.error(`[rks_sync_staging] ${timestamp} diverged (ahead=${ahead}, behind=${behind}), using ${effectiveStrategy}`);

    if (effectiveStrategy === "rebase") {
      const rebaseResult = spawnSync("git", ["rebase", "origin/staging"], { cwd: projectRoot, encoding: "utf8" });
      if (rebaseResult.status !== 0) {
        const conflictStatus = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
        const conflictFiles = conflictStatus.stdout.split("\n").filter(l => l.startsWith("UU")).map(l => l.slice(3));
        if (conflictFiles.length > 0) {
          spawnSync("git", ["rebase", "--abort"], { cwd: projectRoot });
          return { ok: false, state: "diverged", conflicts: conflictFiles, strategy: effectiveStrategy };
        }
        return { ok: false, error: rebaseResult.stderr || "Rebase failed" };
      }
    } else {
      const mergeResult = spawnSync("git", ["merge", "origin/staging", "--no-edit"], { cwd: projectRoot, encoding: "utf8" });
      if (mergeResult.status !== 0) {
        const conflictStatus = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
        const conflictFiles = conflictStatus.stdout.split("\n").filter(l => l.startsWith("UU")).map(l => l.slice(3));
        if (conflictFiles.length > 0) {
          spawnSync("git", ["merge", "--abort"], { cwd: projectRoot });
          return { ok: false, state: "diverged", conflicts: conflictFiles, strategy: effectiveStrategy };
        }
        return { ok: false, error: mergeResult.stderr || "Merge failed" };
      }
    }

    return { ok: true, state: "diverged", ahead, behind, action: effectiveStrategy, metadata: { timestamp } };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

export async function runResolveConflict({ projectRoot, strategy = "theirs", files = [] }) {
  const timestamp = new Date().toISOString();
  try {
    const mergeHead = path.join(projectRoot, ".git", "MERGE_HEAD");
    const rebaseDir = path.join(projectRoot, ".git", "rebase-merge");
    const inMerge = fs.existsSync(mergeHead);
    const inRebase = fs.existsSync(rebaseDir);

    if (!inMerge && !inRebase) {
      const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
      const conflicts = status.stdout.split("\n").filter(l => l.startsWith("UU") || l.startsWith("AA") || l.startsWith("DD"));
      if (conflicts.length === 0) return { ok: false, error: "No merge/rebase in progress and no conflicts detected" };
    }

    console.error(`[rks_resolve_conflict] ${timestamp} strategy=${strategy} files=${files.length || "all"}`);

    if (strategy === "abort") {
      if (inMerge) { spawnSync("git", ["merge", "--abort"], { cwd: projectRoot }); return { ok: true, action: "merge_aborted", metadata: { timestamp } }; }
      else if (inRebase) { spawnSync("git", ["rebase", "--abort"], { cwd: projectRoot }); return { ok: true, action: "rebase_aborted", metadata: { timestamp } }; }
      return { ok: false, error: "No merge/rebase to abort" };
    }

    const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
    const conflictedFiles = status.stdout.split("\n")
      .filter(l => l.startsWith("UU") || l.startsWith("AA") || l.startsWith("DD") || l.startsWith("AU") || l.startsWith("UA"))
      .map(l => l.slice(3).trim());

    if (conflictedFiles.length === 0) return { ok: false, error: "No conflicted files found" };

    const toResolve = files.length > 0 ? conflictedFiles.filter(f => files.includes(f)) : conflictedFiles;
    if (toResolve.length === 0) return { ok: false, error: "Specified files not in conflict", conflictedFiles };

    const resolved = [];
    for (const file of toResolve) {
      const checkoutArg = strategy === "ours" ? "--ours" : "--theirs";
      const result = spawnSync("git", ["checkout", checkoutArg, file], { cwd: projectRoot, encoding: "utf8" });
      if (result.status !== 0) return { ok: false, error: `Failed to resolve ${file}: ${result.stderr}` };
      spawnSync("git", ["add", file], { cwd: projectRoot });
      resolved.push(file);
    }

    const remainingStatus = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
    const remaining = remainingStatus.stdout.split("\n").filter(l => l.startsWith("UU") || l.startsWith("AA") || l.startsWith("DD")).length;

    if (remaining === 0) {
      if (inMerge) {
        const r = spawnSync("git", ["commit", "--no-edit"], { cwd: projectRoot, encoding: "utf8" });
        if (r.status !== 0) return { ok: false, error: "Failed to complete merge commit", resolved };
        return { ok: true, action: "merge_completed", resolved, metadata: { timestamp } };
      } else if (inRebase) {
        const r = spawnSync("git", ["rebase", "--continue"], { cwd: projectRoot, encoding: "utf8" });
        if (r.status !== 0) return { ok: true, action: "rebase_needs_continue", resolved, hint: "Run git rebase --continue", metadata: { timestamp } };
        return { ok: true, action: "rebase_completed", resolved, metadata: { timestamp } };
      }
    }

    return { ok: true, action: "partially_resolved", resolved, remaining, metadata: { timestamp } };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

export async function runPromote({ projectRoot, projectId, from, to, push = true }) {
  const timestamp = new Date().toISOString();
  const promoteStartMs = Date.now();
  const promoteCollector = ensureTelemetryStorage(projectRoot);

  let branchConfig = { working: "staging", integration: "staging", production: "main" };
  if (projectId) {
    try {
      const context = await loadContext(projectId);
      branchConfig = getBranchConfig(context.record, context.projectJson);
    } catch (e) {
      console.warn(`[rks_promote] Failed to load context for ${projectId}, using defaults`);
    }
  }

  const sourceBranch = from || getCurrentBranch(projectRoot);
  const targetBranch = to || branchConfig.integration;

  console.error(`[rks_promote] ${timestamp} promoting ${sourceBranch} → ${targetBranch}`);

  try { promoteCollector.emit("promote.start", projectId || "unknown", { source: sourceBranch, target: targetBranch, projectId: projectId || "unknown" }); } catch (e) { /* telemetry is best-effort */ }

  if (sourceBranch === targetBranch) {
    try { promoteCollector.emit("promote.failed", projectId || "unknown", { source: sourceBranch, target: targetBranch, durationMs: Date.now() - promoteStartMs, error: `Cannot promote ${sourceBranch} to itself` }); } catch (e) { /* telemetry is best-effort */ }
    return { ok: false, error: `Cannot promote ${sourceBranch} to itself` };
  }

  try {
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
    if (status.stdout.trim()) {
      try { promoteCollector.emit("promote.failed", projectId || "unknown", { source: sourceBranch, target: targetBranch, durationMs: Date.now() - promoteStartMs, error: "Uncommitted changes - commit or stash first" }); } catch (e) { /* telemetry is best-effort */ }
      return { ok: false, error: "Uncommitted changes - commit or stash first" };
    }

    runGit(projectRoot, ["checkout", targetBranch]);
    try { runGit(projectRoot, ["pull", "--ff-only", "origin", targetBranch]); } catch (e) { /* continue */ }

    const mergeResult = spawnSync("git", ["merge", sourceBranch, "--no-edit"], { cwd: projectRoot, encoding: "utf8" });

    if (mergeResult.status !== 0) {
      spawnSync("git", ["merge", "--abort"], { cwd: projectRoot });
      runGit(projectRoot, ["checkout", sourceBranch]);
      try { promoteCollector.emit("promote.failed", projectId || "unknown", { source: sourceBranch, target: targetBranch, durationMs: Date.now() - promoteStartMs, error: "Merge conflict detected" }); } catch (e) { /* telemetry is best-effort */ }
      return { ok: false, error: "Merge conflict detected", from: sourceBranch, to: targetBranch, hint: "Resolve conflicts manually or use rks_resolve_conflict" };
    }

    const mergeCommit = runGit(projectRoot, ["rev-parse", "--short", "HEAD"]);

    let pushed = false;
    if (push) {
      const pushResult = spawnSync("git", ["push", "origin", targetBranch], { cwd: projectRoot, encoding: "utf8" });
      pushed = pushResult.status === 0;
      if (!pushed) console.warn(`[rks_promote] Push failed: ${pushResult.stderr}`);
    }

    runGit(projectRoot, ["checkout", sourceBranch]);

    try { promoteCollector.emit("promote.complete", projectId || "unknown", { source: sourceBranch, target: targetBranch, durationMs: Date.now() - promoteStartMs, commitId: mergeCommit }); } catch (e) { /* telemetry is best-effort */ }
    return { ok: true, action: "promoted", from: sourceBranch, to: targetBranch, mergeCommit, pushed, branchConfig, metadata: { timestamp } };
  } catch (error) {
    try { runGit(projectRoot, ["checkout", sourceBranch]); } catch (e) { /* ignore */ }
    try { promoteCollector.emit("promote.failed", projectId || "unknown", { source: sourceBranch, target: targetBranch, durationMs: Date.now() - promoteStartMs, error: error.message || String(error) }); } catch (e) { /* telemetry is best-effort */ }
    return { ok: false, error: error.message || String(error) };
  }
}

export async function runBranchRepair({ projectRoot, branch, target, dryRun = false, confirm = false }) {
  const timestamp = new Date().toISOString();
  const effectiveTarget = target || `origin/${branch}`;
  console.error(`[rks_branch_repair] ${timestamp} branch=${branch} target=${effectiveTarget} dryRun=${dryRun} confirm=${confirm}`);

  try {
    const originalBranch = getCurrentBranch(projectRoot);

    try { runGit(projectRoot, ["fetch", "origin"]); } catch (e) { /* continue */ }

    try { runGit(projectRoot, ["rev-parse", "--verify", effectiveTarget]); } catch (e) {
      return { ok: false, error: `Target '${effectiveTarget}' does not exist`, hint: "Check that the remote branch exists and you have fetched latest" };
    }

    const localBranches = runGit(projectRoot, ["branch", "--list", branch]);
    if (!localBranches.trim()) return { ok: false, error: `Branch '${branch}' does not exist locally`, hint: "Use rks_git_branch to create it, or checkout a remote tracking branch" };

    const currentHead = runGit(projectRoot, ["rev-parse", "--short", branch]);
    const targetHead = runGit(projectRoot, ["rev-parse", "--short", effectiveTarget]);

    if (currentHead === targetHead) return { ok: true, branch, action: "already_at_target", currentHead, targetHead, metadata: { timestamp } };

    const commitsOutput = runGit(projectRoot, ["log", "--oneline", `${effectiveTarget}..${branch}`]);
    const commitsToRemove = commitsOutput.split("\n").filter(Boolean).map(line => {
      const [sha, ...messageParts] = line.split(" ");
      return { sha, message: messageParts.join(" ") };
    });

    if (dryRun) return { ok: true, dryRun: true, branch, currentHead, targetHead, commitsToRemove, hint: "Run with confirm: true to apply this repair", metadata: { timestamp } };

    if (!confirm) return { ok: false, error: "Branch repair requires confirmation", branch, currentHead, targetHead, commitsToRemove, hint: "Run with confirm: true to apply this repair, or dryRun: true to preview" };

    if (originalBranch !== branch) runGit(projectRoot, ["checkout", branch]);
    runGit(projectRoot, ["reset", "--hard", effectiveTarget]);
    if (originalBranch !== branch) runGit(projectRoot, ["checkout", originalBranch]);

    return { ok: true, branch, previousHead: currentHead, newHead: targetHead, commitsRemoved: commitsToRemove.length, returnedTo: originalBranch !== branch ? originalBranch : undefined, metadata: { timestamp } };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}
