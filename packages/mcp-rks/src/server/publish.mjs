import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { spawnSync } from "child_process";
import { getTelemetryCollector } from "./telemetry/index.mjs";

// --- Transform helpers ---

function patternToRegex(pattern) {
  const special = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);
  let result = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      result += '.*';
      i += 2;
    } else if (ch === '*') {
      result += '[^/]*';
      i += 1;
    } else if (special.has(ch)) {
      result += '\\' + ch;
      i += 1;
    } else {
      result += ch;
      i += 1;
    }
  }
  return new RegExp('^' + result + '$');
}

function extractRest(filePath, pattern) {
  const dblIdx = pattern.indexOf('**');
  const sglIdx = pattern.indexOf('*');
  const idx = dblIdx >= 0 ? dblIdx : sglIdx;
  if (idx < 0) return '';
  const isDouble = dblIdx >= 0 && dblIdx === idx;
  const prefix = pattern.slice(0, idx);
  const suffix = isDouble ? pattern.slice(idx + 2) : pattern.slice(idx + 1);
  const start = prefix.length;
  const end = suffix.length > 0 ? filePath.length - suffix.length : filePath.length;
  return filePath.slice(start, end);
}

function getTransformRoot(matchPattern) {
  const parts = matchPattern.split('/');
  const wildcardIdx = parts.findIndex(p => p.includes('*'));
  if (wildcardIdx <= 0) return '';
  return parts.slice(0, wildcardIdx).join('/');
}

function walkFiles(dir, baseDir = dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, baseDir));
    } else {
      files.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
    }
  }
  return files;
}

/**
 * Apply file rename transforms to an extracted archive directory.
 * After all rules run, files in transform root directories that were not
 * matched by any rule are deleted (allowlist behavior).
 */
export function applyTransforms(tmpDir, transforms) {
  if (!transforms || transforms.length === 0) {
    return { renamedFiles: [], deletedFiles: [] };
  }

  const allFiles = walkFiles(tmpDir);
  const renamedFiles = [];
  const touchedOriginals = new Set();
  const transformRoots = new Set();

  for (const rule of transforms) {
    const { match, rename } = rule;
    const regex = patternToRegex(match);
    const root = getTransformRoot(match);
    if (root) transformRoots.add(root);

    for (const relPath of allFiles) {
      if (!regex.test(relPath)) continue;

      const rest = extractRest(relPath, match);
      const dest = rename.replace('{rest}', rest);

      touchedOriginals.add(relPath);

      if (dest === relPath) continue;

      const srcAbs = path.join(tmpDir, relPath);
      const destAbs = path.join(tmpDir, dest);

      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.renameSync(srcAbs, destAbs);

      renamedFiles.push({ from: relPath, to: dest });
    }
  }

  const deletedFiles = [];
  for (const relPath of allFiles) {
    if (touchedOriginals.has(relPath)) continue;

    const underRoot = [...transformRoots].some(root =>
      relPath.startsWith(root + '/') || relPath === root
    );

    if (underRoot) {
      const absPath = path.join(tmpDir, relPath);
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        deletedFiles.push(relPath);
      }
    }
  }

  return { renamedFiles, deletedFiles };
}

/**
 * Normalize the project IDENTITY in a static-export snapshot.
 *
 * The dev repo has one identity (e.g. "routekit-shell-core"); the published product has
 * another ("routekit-shell"). Because the export is a byte-copy of the dev tree, the dev
 * identity leaks into the snapshot's package name, registry id, MCP env, Dispatcher config,
 * and the setup-script fallbacks. This rewrites ONLY those identity locations to `to`, using
 * targeted key/line edits — NEVER a global string replace, which would corrupt package-lock
 * integrity hashes, the `<org>/<repo>` URLs, and the `tests/**` fixtures that assert the
 * literal on purpose. Runs on the extracted temp snapshot only; the dev repo is untouched.
 *
 * Idempotent and defensive: missing/malformed files are skipped. Returns the changed paths.
 */
export function normalizeExportIdentity(tmpDir, from, to, { log = () => {} } = {}) {
  if (!from || !to || from === to) return { changed: [] };
  const changed = [];

  const editJson = (rel, mutate) => {
    const abs = path.join(tmpDir, rel);
    if (!fs.existsSync(abs)) return;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(abs, "utf-8"));
    } catch {
      return; // malformed — leave untouched
    }
    if (mutate(json)) {
      fs.writeFileSync(abs, JSON.stringify(json, null, 2) + "\n");
      changed.push(rel);
    }
  };

  const editText = (rel, transform) => {
    const abs = path.join(tmpDir, rel);
    if (!fs.existsSync(abs)) return;
    const before = fs.readFileSync(abs, "utf-8");
    const after = transform(before);
    if (after !== before) {
      fs.writeFileSync(abs, after);
      changed.push(rel);
    }
  };

  // 1. package.json — the package name.
  editJson("package.json", (j) => {
    if (j.name === from) { j.name = to; return true; }
    return false;
  });

  // 2. package-lock.json — top-level name + the root package entry name (npm v2/v3 shape).
  //    ONLY the name fields; resolved/integrity/version are never touched.
  editJson("package-lock.json", (j) => {
    let c = false;
    if (j.name === from) { j.name = to; c = true; }
    if (j.packages && j.packages[""] && j.packages[""].name === from) {
      j.packages[""].name = to;
      c = true;
    }
    return c;
  });

  // 3. .rks/project.json — the registry id readProjectId() adopts on the clone.
  editJson(".rks/project.json", (j) => {
    if (j.id === from) { j.id = to; return true; }
    return false;
  });

  // 4. .mcp.json.example — every server's ROUTEKIT_PROJECT_ID.
  editJson(".mcp.json.example", (j) => {
    let c = false;
    for (const srv of Object.values(j.mcpServers || {})) {
      if (srv?.env?.ROUTEKIT_PROJECT_ID === from) {
        srv.env.ROUTEKIT_PROJECT_ID = to;
        c = true;
      }
    }
    return c;
  });

  // 5. CLAUDE.md — the Dispatcher projectId governing the clone. In the PUBLIC export every
  //    `from` occurrence is an identity reference, so normalize them all.
  editText("CLAUDE.md", (s) => s.split(from).join(to));

  // 6. scripts/setup.mjs — readProjectId()'s fallback literals + its doc comment. Same
  //    reasoning: in the export the only `from` occurrences are the identity fallbacks.
  editText("scripts/setup.mjs", (s) => s.split(from).join(to));

  log(`identity: ${from} → ${to} in ${changed.length} file(s)${changed.length ? ": " + changed.join(", ") : ""}`);
  return { changed };
}

/**
 * Load publish profiles from project config
 */
export function loadPublishProfiles(projectRoot) {
  const configPath = path.join(projectRoot, ".routekit", "publish-profiles.yaml");
  
  if (!fs.existsSync(configPath)) {
    return { profiles: {}, remotes: {} };
  }
  
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return yaml.load(content) || { profiles: {}, remotes: {} };
  } catch (err) {
    return { profiles: {}, remotes: {}, error: err.message };
  }
}

/**
 * Get profile by name
 */
export function getProfile(projectRoot, profileName) {
  const config = loadPublishProfiles(projectRoot);
  return config.profiles?.[profileName] || null;
}

/**
 * Get remote configuration by name
 */
export function getRemoteConfig(projectRoot, remoteName) {
  const config = loadPublishProfiles(projectRoot);
  return config.remotes?.[remoteName] || null;
}

/**
 * Generate git archive exclude arguments from profile
 */
export function generateExcludeArgs(profile) {
  if (!profile?.exclude || profile.exclude.length === 0) {
    return [];
  }

  const args = [];
  for (const pattern of profile.exclude) {
    if (pattern.startsWith("!")) {
      continue; // git archive doesn't support negation
    }
    args.push(`--exclude=${pattern}`);
  }
  return args;
}

/**
 * Enumerate the files in the HEAD tree, so glob include patterns can be resolved
 * to the concrete pathspecs `git archive` understands. Uses the HEAD tree (not the
 * index) to match exactly what `git archive HEAD` produces. Returns null if git
 * fails so callers can fall back gracefully.
 */
function listHeadFiles(projectRoot) {
  const res = spawnSync("git", ["ls-tree", "-r", "HEAD", "--name-only"], {
    cwd: projectRoot,
    encoding: "utf-8",
    timeout: 30000,
  });
  if (res.status !== 0) return null;
  return res.stdout.split("\n").filter(Boolean);
}

/**
 * Generate git archive include path arguments from profile.
 * Returned as plain positional path args appended after the tree-ish; when
 * non-empty, git archive restricts output to only these paths.
 *
 * Literal paths (`README.md`) and directory prefixes (`packages/`) are valid git
 * archive pathspecs as-is. Glob patterns (`notes/canon.**`, `*`) are NOT expanded
 * by git archive — it would silently match nothing — so we resolve them against the
 * HEAD file list here, using the same `patternToRegex()` glob semantics as transforms.
 * `projectRoot` is required to expand globs; without it (or if git fails) the patterns
 * are returned unchanged (back-compat; production always passes projectRoot).
 */
/**
 * Apply an optional `profile.exclude` denylist to an already-resolved include set.
 * Each exclude glob is compiled with the same `patternToRegex()` semantics as includes.
 * `git archive` has no `--exclude`, so this post-filter (over the set we resolve
 * ourselves) is the ONLY place a surgical per-file drop under a broad include glob
 * (e.g. a `.bak` under `packages/**`, or `scripts/publish-to-ux287.mjs` under `scripts/**`)
 * can live. Absent/empty exclude is a no-op (back-compat). Returns a new array.
 */
export function applyExclude(paths, exclude) {
  if (!exclude || exclude.length === 0) return paths;
  const denyRx = exclude.map((p) => patternToRegex(p));
  return paths.filter((f) => !denyRx.some((rx) => rx.test(f)));
}

export function generateIncludeArgs(profile, projectRoot) {
  if (!profile?.include || profile.include.length === 0) {
    return [];
  }
  const patterns = profile.include;
  const hasGlob = patterns.some((p) => p.includes("*"));
  let result;
  if (!hasGlob) {
    // All literal paths / directory prefixes — valid pathspecs as-is.
    result = [...patterns];
  } else {
    const headFiles = projectRoot ? listHeadFiles(projectRoot) : null;
    if (!headFiles) {
      // Cannot enumerate (no projectRoot / git failure): return patterns unchanged.
      result = [...patterns];
    } else {
      const resolved = new Set();
      for (const pattern of patterns) {
        if (!pattern.includes("*")) {
          resolved.add(pattern); // literal path or directory prefix
          continue;
        }
        const rx = patternToRegex(pattern);
        for (const f of headFiles) {
          if (rx.test(f)) resolved.add(f);
        }
      }
      result = [...resolved];
    }
  }
  // Post-filter denylist applies to whichever set we're about to return (all branches).
  return applyExclude(result, profile.exclude);
}

/**
 * Check if remote exists in git config
 */
export function remoteExists(projectRoot, remoteName) {
  const result = spawnSync("git", ["remote", "get-url", remoteName], {
    cwd: projectRoot,
    encoding: "utf-8",
  });
  return result.status === 0;
}

/**
 * Add a remote if it doesn't exist
 */
export function addRemote(projectRoot, remoteName, url) {
  if (remoteExists(projectRoot, remoteName)) {
    return { ok: true, existed: true };
  }
  
  const result = spawnSync("git", ["remote", "add", remoteName, url], {
    cwd: projectRoot,
    encoding: "utf-8",
  });
  
  return {
    ok: result.status === 0,
    existed: false,
    error: result.status !== 0 ? result.stderr : null,
  };
}

/**
 * Publish filtered project to remote
 */
export async function publish(projectRoot, options = {}) {
  const {
    remote,
    profile: profileName = "app-only",
    branch = "main",
    dryRun = false,
    message = "Publish from RKS",
  } = options;
  
  const collector = getTelemetryCollector();
  collector.emit("publish.start", options.projectId || "unknown", {
    remote,
    profile: profileName,
    branch,
    dryRun,
  });
  
  // Load profile
  const profile = getProfile(projectRoot, profileName);
  if (!profile) {
    const error = `Profile "${profileName}" not found`;
    collector.emit("publish.failed", options.projectId || "unknown", { error });
    return { ok: false, error };
  }
  
  // Check/setup remote
  const remoteConfig = getRemoteConfig(projectRoot, remote);
  if (remoteConfig?.url) {
    const addResult = addRemote(projectRoot, remote, remoteConfig.url);
    if (!addResult.ok) {
      collector.emit("publish.failed", options.projectId || "unknown", { 
        error: addResult.error 
      });
      return { ok: false, error: addResult.error };
    }
  } else if (!remoteExists(projectRoot, remote)) {
    const error = `Remote "${remote}" not found and no URL configured`;
    collector.emit("publish.failed", options.projectId || "unknown", { error });
    return { ok: false, error };
  }
  
  // Resolve the concrete include pathspecs. Any profile.exclude denylist is applied as a
  // POST-FILTER inside generateIncludeArgs (git archive has NO --exclude option), so the
  // resolved set is already exclude-filtered — no --exclude args go to git archive.
  const includeArgs = generateIncludeArgs(profile, projectRoot);

  if (dryRun) {
    let plannedRenames = [];

    if (profile.transforms && profile.transforms.length > 0) {
      const lsResult = spawnSync(
        "git", ["ls-tree", "-r", "HEAD", "--name-only"],
        { cwd: projectRoot, encoding: "utf-8" }
      );

      if (lsResult.status === 0) {
        const fileList = lsResult.stdout.split('\n').filter(Boolean);
        for (const rule of profile.transforms) {
          const regex = patternToRegex(rule.match);
          for (const filePath of fileList) {
            if (!regex.test(filePath)) continue;
            const rest = extractRest(filePath, rule.match);
            const dest = rule.rename.replace('{rest}', rest);
            if (dest !== filePath) {
              plannedRenames.push({ from: filePath, to: dest });
            }
          }
        }
      }
    }

    return {
      ok: true,
      dryRun: true,
      profile: profileName,
      remote,
      branch,
      excludePatterns: profile.exclude || [],
      includePatterns: profile.include || [],
      plannedRenames,
      identity: profile.identity?.from && profile.identity?.to ? profile.identity : null,
      message: "Dry run - no changes made",
    };
  }
  
  // Create temporary directory for filtered export
  const tmpDir = path.join(projectRoot, ".rks", "publish-tmp");
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    // Export filtered archive
    // Order: options (--format) → tree-ish → resolved (exclude-filtered) include paths
    const archiveResult = spawnSync(
      "git",
      ["archive", "--format=tar", "HEAD", ...includeArgs],
      // maxBuffer default is 1MB; a full framework snapshot tar is many MB, so raise it —
      // otherwise spawnSync fails silently with an empty stderr and a null status.
      { cwd: projectRoot, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }
    );
    
    if (archiveResult.status !== 0) {
      throw new Error(`git archive failed: ${archiveResult.stderr}`);
    }
    
    // Extract to tmp directory
    const extractResult = spawnSync(
      "tar",
      ["-xf", "-"],
      {
        cwd: tmpDir,
        input: archiveResult.stdout,
        encoding: "utf-8",
        maxBuffer: 512 * 1024 * 1024,
      }
    );
    
    if (extractResult.status !== 0) {
      throw new Error(`tar extract failed: ${extractResult.stderr}`);
    }

    if (profile.transforms && profile.transforms.length > 0) {
      applyTransforms(tmpDir, profile.transforms);
    }

    // Static-export identity normalization: rewrite the dev identity to the public product
    // identity in the snapshot ONLY (dev repo untouched). Opt-in per profile via `identity`.
    if (profile.identity?.from && profile.identity?.to) {
      normalizeExportIdentity(tmpDir, profile.identity.from, profile.identity.to);
    }

    // Initialize git in tmp directory
    spawnSync("git", ["init"], { cwd: tmpDir });
    spawnSync("git", ["add", "-A"], { cwd: tmpDir });
    spawnSync("git", ["commit", "-m", message], { cwd: tmpDir });
    
    // Add remote and push
    spawnSync("git", ["remote", "add", "target", 
      remoteConfig?.url || spawnSync("git", ["remote", "get-url", remote], {
        cwd: projectRoot,
        encoding: "utf-8"
      }).stdout.trim()
    ], { cwd: tmpDir });
    
    const pushResult = spawnSync(
      "git",
      ["push", "-f", "target", `HEAD:${branch}`],
      { cwd: tmpDir, encoding: "utf-8" }
    );
    
    if (pushResult.status !== 0) {
      throw new Error(`git push failed: ${pushResult.stderr}`);
    }
    
    collector.emit("publish.success", options.projectId || "unknown", {
      remote,
      branch,
      profile: profileName,
    });
    
    return {
      ok: true,
      remote,
      branch,
      profile: profileName,
      excludePatterns: profile.exclude || [],
      includePatterns: profile.include || [],
      message: `Published to ${remote}/${branch} using profile "${profileName}"`,
    };
    
  } catch (err) {
    collector.emit("publish.failed", options.projectId || "unknown", {
      error: err.message,
    });
    return { ok: false, error: err.message };
    
  } finally {
    // Cleanup
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  }
}

/**
 * List available profiles
 */
export function listProfiles(projectRoot) {
  const config = loadPublishProfiles(projectRoot);
  return Object.entries(config.profiles || {}).map(([name, profile]) => ({
    name,
    description: profile.description,
    excludeCount: profile.exclude?.length || 0,
    includeCount: profile.include?.length || 0,
  }));
}

/**
 * List configured remotes with their profiles
 */
export function listRemotes(projectRoot) {
  const config = loadPublishProfiles(projectRoot);
  return Object.entries(config.remotes || {}).map(([name, remote]) => ({
    name,
    url: remote.url,
    profile: remote.profile,
    branch: remote.branch || "main",
  }));
}