import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { attachProject } from '../../../cli/src/project/bootstrap.mjs';
import { upsertProject, getProjectById } from '../../../cli/src/project/index.js';
import { getTelemetryCollector } from './telemetry/index.mjs';

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
  try {
    await attachProject({
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
  try {
    execSync('git init', { cwd: projectPath, stdio: 'pipe' });
    execSync('git add -A', { cwd: projectPath, stdio: 'pipe' });
    execSync('git commit -m "chore: initialize project from routekit-shell template"', { cwd: projectPath, stdio: 'pipe' });
    // Rename default branch to main (in case git defaults to master)
    try {
      execSync('git branch -M main', { cwd: projectPath, stdio: 'pipe' });
    } catch (e) {
      // Already on main or rename failed, ignore
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

    // Create GitHub repo and push main (only when gh is ready)
    if (ghReady) {
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
    }

    if (branchModel === '3-branch') {
      // Create staging from main (local); push only when gh preflight passed.
      execSync('git checkout -b staging', { cwd: projectPath, stdio: 'pipe' });
      if (ghReady) {
        try {
          execSync('git push -u origin staging', { cwd: projectPath, stdio: 'pipe' });
        } catch (e) {
          const msg = `staging push failed: ${e?.message || e}`;
          console.warn(msg);
          warnings.push(msg);
        }
      }
      // Create dev from staging (local only — not pushed)
      execSync('git checkout -b dev', { cwd: projectPath, stdio: 'pipe' });
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
    nextSteps,
    message: `Project ${projectName} created at ${projectPath}`
  };
}
