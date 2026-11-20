import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { attachProject, secretScanNotArmedWarning } from '../../../cli/src/project/bootstrap.mjs';
import { upsertProject, getProjectById } from '../../../cli/src/project/index.js';
import { getTelemetryCollector } from '@routekit/telemetry';
import { provenanceTrailerLine } from '../shared/commit-provenance.mjs';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function copyRecursive(src, dest) {
  const stat = await fs.promises.stat(src);
  if (stat.isDirectory()) {
    await ensureDir(dest);
    const entries = await fs.promises.readdir(src);
    for (const entry of entries) {
      await copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else if (stat.isFile()) {
    await ensureDir(path.dirname(dest));
    await fs.promises.copyFile(src, dest);
  }
}

function validateProjectName(name) {
  // allow letters, numbers, ., _, -
  return /^[a-zA-Z0-9_.-]+$/.test(name);
}

// Preflight: the GitHub CLI must be installed AND authenticated before we attempt any
// remote operation. Without this, a machine lacking `gh` surfaces a raw
// "/bin/sh: gh: command not found" instead of an actionable message. Timeouts guard
// against `gh auth status` hanging on a network call.
// D15 (backlog.fix.rks-init-post-attach-commit-refused-by-gitleaks-gate): attachProject arms the
// fail-closed gitleaks pre-commit shim, and rks_init's initial commit runs after that arm point.
// The shim honours this override and skips only the scan; any other pre-commit hook still runs.
// A literal (not bootstrap.mjs's SECRET_SCAN_OVERRIDE_ENV): the init tests mock bootstrap.mjs with
// a factory exposing only attachProject, so a named import read on every path would be undefined.
const SECRET_SCAN_OVERRIDE_ENV = 'RKS_ALLOW_UNSCANNED_COMMIT';

// Trimmed string output of a git call; '' when execSync returned nothing (mocked in the init tests).
function gitOut(cmd, cwd) {
  return String(execSync(cmd, { cwd, stdio: 'pipe' }) ?? '').trim();
}

function gitBranchExists(branch, cwd) {
  try {
    execSync(`git rev-parse --verify --quiet refs/heads/${branch}`, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function isGhReady() {
  try {
    execSync('which gh', { stdio: 'pipe', timeout: 5000 });
    execSync('gh auth status', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function runInitTool({ projectName, parentDir = '..', dev = false, branchModel = '3-branch' } = {}) {
  const warnings = [];

  // Emit init.start telemetry
  try {
    const collector = getTelemetryCollector();
    collector.emit('init.start', { projectName, dev, branchModel });
  } catch {}

  function emitFailed(error) {
    try {
      const collector = getTelemetryCollector();
      collector.emit('init.failed', { projectName, dev, branchModel, error });
    } catch {}
  }

  if (!projectName || typeof projectName !== 'string') {
    emitFailed('projectName is required and must be a string');
    throw new Error('projectName is required and must be a string');
  }
  if (!validateProjectName(projectName)) {
    emitFailed('Invalid projectName');
    throw new Error('Invalid projectName. Use only letters, numbers, dot, underscore or hyphen');
  }

  // Authoritative shell root — the SAME anchor used by the registry writer (attachProject /
  // upsertProject) and reader (getProjectById). Scaffold dir, git cwd, registry write, and
  // registry read must ALL resolve against this root, never process.cwd(): the cwd-vs-__dirname
  // split-brain was the root cause of the false-success defect (writes landed in one place while
  // reads looked in another). An absolute parentDir still wins via path.resolve.
  const shellRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const projectPath = path.resolve(shellRoot, parentDir, projectName);
  if (fs.existsSync(projectPath)) {
    emitFailed(`Target path already exists: ${projectPath}`);
    throw new Error(`Target path already exists: ${projectPath}`);
  }

  // locate template directory relative to package. fallback to process.cwd()/templates/base
  const templateDirCandidates = [
    path.resolve(__dirname, '..', '..', 'templates', 'base'),
    path.resolve(process.cwd(), 'templates', 'base')
  ];
  let templateDir = null;
  for (const cand of templateDirCandidates) {
    if (fs.existsSync(cand)) {
      templateDir = cand;
      break;
    }
  }

  await ensureDir(projectPath);

  if (templateDir) {
    try {
      await copyRecursive(templateDir, projectPath);
      // Update .rks/project.json with the actual project ID
      const projectJsonPath = path.join(projectPath, '.rks', 'project.json');
      const baseBranch = branchModel === '2-branch' ? 'main' : 'dev';
      const branches = branchModel === '3-branch'
        ? { working: 'dev', integration: 'staging', production: 'main' }
        : { working: 'main', integration: 'main', production: 'main' };
      try {
        const projectJson = JSON.parse(await fs.promises.readFile(projectJsonPath, 'utf8'));
        projectJson.id = projectName;
        projectJson.baseBranch = baseBranch;
        projectJson.branches = branches;
        await fs.promises.writeFile(projectJsonPath, JSON.stringify(projectJson, null, 2) + '\n');
      } catch (e) {
        // If project.json doesn't exist or is malformed, create minimal one
        const minimalConfig = { id: projectName, rksVersion: '0.1.0', kgFile: 'routekit/kg.yaml', baseBranch, branches };
        await fs.promises.writeFile(projectJsonPath, JSON.stringify(minimalConfig, null, 2) + '\n');
      }
    } catch (err) {
      // cleanup on failure
      try { await fs.promises.rm(projectPath, { recursive: true, force: true }); } catch (e) {}
      emitFailed(`Failed to copy template: ${err.message}`);
      throw new Error(`Failed to copy template: ${err.message}`);
    }
  } else {
    // create minimal scaffold if no template available
    await ensureDir(path.join(projectPath, 'src'));
    await fs.promises.writeFile(path.join(projectPath, 'README.md'), `# ${projectName}\n\nCreated by rks_init`);
  }

    // Call attachProject to set up project properly (writes needsOnboarding, etc.)
  let registrationOk = false;
  let attachResult;
  try {
    attachResult = await attachProject({
      shellRoot,
      projectRoot: projectPath,
      projectId: projectName,
      dev,
      branchModel,
    });
    registrationOk = true;
  } catch (err) {
    const attachMsg = `attachProject failed: ${err?.message || err}`;
    console.warn(attachMsg);
    warnings.push(attachMsg);
    // Fallback: register directly via upsertProject
    try {
      upsertProject({
        id: projectName,
        path: projectPath,
        stack: 'base',
        addedAt: new Date().toISOString(),
      }, shellRoot);
      registrationOk = true;
      warnings.push('Registration recovered via upsertProject fallback');
    } catch (regErr) {
      const regMsg = `Registration fallback also failed: ${regErr?.message || regErr}`;
      console.warn(regMsg);
      warnings.push(regMsg);
    }
  }

  // Surface attachProject's secret-scan outcome (R9): only when it reported one and it is not armed.
  // secretScanNotArmedWarning is read only on this path (see SECRET_SCAN_OVERRIDE_ENV above).
  let secretScan;
  const reportedScan = attachResult && attachResult.secretScan;
  if (reportedScan && typeof reportedScan === 'object' && reportedScan.armed !== true) {
    secretScan = reportedScan;
    warnings.push(secretScanNotArmedWarning(reportedScan));
  }

  // MCP config is now handled by ensureMcpJson in attachProject (respects dev flag).
  // .claude/settings.json with hooks/permissions is handled by ensureClaudeSettings.

  // Write package.json before git init so it's included in the initial commit
  try {
    const depValue = dev
      ? "file:../routekit-shell/packages/mcp-rks"
      : "github:vinniefm/routekit-shell?path=packages/mcp-rks#v0.3.0";
    await fs.promises.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({
      name: projectName,
      version: '0.1.0',
      private: true,
      dependencies: {
        "@routekit/mcp-rks": depValue
      }
    }, null, 2));
  } catch (e) {
    const msg = `package.json write failed: ${e?.message || e}`;
    console.warn(msg);
    warnings.push(msg);
  }

  // Initialize git, create initial commit, set up GitHub remote and branches
  const configuredBranches = branchModel === '3-branch'
    ? { working: 'dev', integration: 'staging', production: 'main' }
    : { working: 'main', integration: 'main', production: 'main' };
  let initCommitScanned;
  try {
    execSync('git init', { cwd: projectPath, stdio: 'pipe' });
    let preHead = '';
    try { preHead = gitOut('git rev-parse HEAD', projectPath); } catch { preHead = ''; }
    execSync('git add -A', { cwd: projectPath, stdio: 'pipe' });
    // backlog.feat.commit-provenance-trailer-remaining-sites AC6: the root commit carries the
    // Rks-Provenance line. The message goes in on stdin (-F -) so no attribution value is ever
    // interpolated into a shell string; it stays on execSync (the init tests mock only execSync).
    // D15: this commit, and only this one, adds the scan override to the inherited environment.
    execSync('git commit -F -', {
      cwd: projectPath,
      stdio: 'pipe',
      env: { ...process.env, [SECRET_SCAN_OVERRIDE_ENV]: '1' },
      input: `chore: initialize project from routekit-shell template\n\n${provenanceTrailerLine({ defaultTool: 'rks_init' })}\n`,
    });
    // Evidence-bound (R1/R8): report the commit as not scanned only when HEAD is observed to have
    // moved to a non-empty sha. An empty or undefined rev-parse output is not an observation.
    let postHead = '';
    try { postHead = gitOut('git rev-parse HEAD', projectPath); } catch { postHead = ''; }
    if (postHead && postHead !== preHead) {
      let shortSha = '';
      try { shortSha = gitOut('git rev-parse --short HEAD', projectPath); } catch { shortSha = ''; }
      initCommitScanned = false;
      warnings.push(
        `initial commit ${shortSha || postHead.slice(0, 7)} was NOT secret-scanned (initCommitScanned: false): ` +
        `rks_init's initial commit runs with ${SECRET_SCAN_OVERRIDE_ENV}=1.`
      );
    }

    // Reconcile with the branches attachProject's git bootstrap may already have created: never
    // rename or recreate an existing configured branch. The initial commit landed on the current
    // branch; every other configured branch is created at it or fast-forwarded to it.
    const { production, working } = configuredBranches;
    const configured = Array.from(new Set([production, configuredBranches.integration, working]));
    let current = gitOut('git rev-parse --abbrev-ref HEAD', projectPath);
    if (!configured.includes(current) && !gitBranchExists(production, projectPath)) {
      // Fresh repository on git's default branch (e.g. master): rename it to the production branch.
      execSync(`git branch -M ${production}`, { cwd: projectPath, stdio: 'pipe' });
      current = production;
    }
    for (const b of configured) {
      if (b === current) continue;
      if (!gitBranchExists(b, projectPath)) {
        execSync(`git branch ${b}`, { cwd: projectPath, stdio: 'pipe' });
        continue;
      }
      let isAncestor = false;
      try {
        execSync(`git merge-base --is-ancestor ${b} HEAD`, { cwd: projectPath, stdio: 'pipe' });
        isAncestor = true;
      } catch {
        isAncestor = false;
      }
      if (isAncestor) {
        execSync(`git branch -f ${b} HEAD`, { cwd: projectPath, stdio: 'pipe' });
      } else {
        warnings.push(`branch '${b}' has diverged from the initial commit — left unchanged (not fast-forwarded).`);
      }
    }

    // Preflight the GitHub CLI once. If gh is missing/unauthenticated, skip BOTH the remote
    // repo creation and the staging push cleanly with a single actionable warning — never
    // surface the raw "gh: command not found". Local branch setup still proceeds.
    const ghReady = isGhReady();
    if (!ghReady) {
      warnings.push(
        `GitHub CLI (gh) is not installed or not authenticated — skipped remote repo creation and staging push. ` +
        `Install gh (https://cli.github.com) and run \`gh auth login\`, then from ${projectPath} run ` +
        `\`gh repo create ${projectName} --private --source=. --push\` and \`git push -u origin staging\` manually.`
      );
    }

    // Create GitHub repo and push main (only when gh is ready). `gh repo create --push` pushes the
    // current HEAD, so the production branch is checked out for that call.
    if (ghReady) {
      if (current !== production) {
        execSync(`git checkout ${production}`, { cwd: projectPath, stdio: 'pipe' });
        current = production;
      }
      try {
        execSync(`gh repo create ${projectName} --private --source=. --push`, { cwd: projectPath, stdio: 'pipe' });
      } catch (e) {
        const errMsg = e?.message || String(e);
        if (errMsg.includes('Name already exists')) {
          warnings.push(`GitHub repo '${projectName}' already exists — skipped. Create manually with a different name or delete the existing repo.`);
        } else {
          warnings.push(`GitHub repo creation failed (create manually): ${errMsg}`);
        }
        console.warn('GitHub repo creation failed:', errMsg);
      }
      if (branchModel === '3-branch') {
        // staging already exists locally (reconciled above); push only when gh preflight passed.
        try {
          execSync('git push -u origin staging', { cwd: projectPath, stdio: 'pipe' });
        } catch (e) {
          const msg = `staging push failed: ${e?.message || e}`;
          console.warn(msg);
          warnings.push(msg);
        }
      }
    }

    // End with the configured working branch checked out (dev is local only — not pushed).
    if (current !== working) {
      execSync(`git checkout ${working}`, { cwd: projectPath, stdio: 'pipe' });
    }
  } catch (err) {
    const msg = `git/GitHub setup failed: ${err.message}`;
    console.warn(msg);
    warnings.push(msg);
  }

  const nextSteps = [
    `cd ${projectPath}`,
    `Open in Claude Code and start chatting — onboarding is automatic`
  ];

  // Post-write verification — success and registrationOk MUST reflect what actually landed,
  // never optimistic. Read back the scaffold (dir on disk) and the registry entry (round-trip
  // via getProjectById against the SAME shellRoot the write used). A registration is only OK
  // if its write path claimed success AND the entry round-trips. Git failures already route to
  // warnings and do NOT demote success; a missing dir or non-round-tripping registry does.
  const dirExists = fs.existsSync(projectPath);
  let readbackOk = false;
  try {
    readbackOk = !!getProjectById(projectName, shellRoot);
  } catch {
    readbackOk = false;
  }
  registrationOk = registrationOk && readbackOk;
  const verified = dirExists && readbackOk;

  if (!verified) {
    const reason = !dirExists
      ? `project directory was not created at ${projectPath}`
      : `project '${projectName}' did not round-trip in the registry (getProjectById returned null)`;
    emitFailed(`post-write verification failed: ${reason}`);
    return {
      success: false,
      path: projectPath,
      templateUsed: !!templateDir,
      registrationOk,
      warnings,
      ...(initCommitScanned === false ? { initCommitScanned } : {}),
      ...(secretScan ? { secretScan } : {}),
      error: `rks_init verification failed: ${reason}`,
      message: `Project ${projectName} could not be verified after creation: ${reason}`
    };
  }

  // Emit init.complete telemetry (verified success only)
  try {
    const collector = getTelemetryCollector();
    collector.emit('init.complete', {
      projectName, dev, branchModel,
      templateUsed: !!templateDir,
      registrationOk,
      warningCount: warnings.length,
    });
  } catch {}

  return {
    success: true,
    path: projectPath,
    templateUsed: !!templateDir,
    registrationOk,
    warnings,
    ...(initCommitScanned === false ? { initCommitScanned } : {}),
    ...(secretScan ? { secretScan } : {}),
    nextSteps,
    message: `Project ${projectName} created at ${projectPath}`
  };
}
