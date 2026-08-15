import fs from "node:fs";
import path from "node:path";
import { readRksVersion, advanceStamp } from "./read-rks-version.mjs";
import { loadSkillsExclude } from "./skills-manifest.mjs";

/**
 * backlog.fix.shell-self-sync-skill-wipe-health-gate
 *
 * Are these two paths THE SAME DIRECTORY? Compared by filesystem identity (device + inode), not by
 * string. A string compare is defeated by every one of: a trailing slash, a `..` segment, a symlink,
 * and a case-variant on a case-insensitive volume (macOS default) — and `realpathSync` still cannot
 * see two DIFFERENT real paths that share an inode (a hardlink, or a bind mount). dev+ino sees all
 * of them, because it asks the filesystem what the thing IS rather than what it is spelled.
 *
 * The guard fires on IDENTITY, never on CONTAINMENT. A legitimate child at <shellRoot>/children/kid
 * is a different directory and must sync normally — a `startsWith` guard would refuse it, and every
 * fixture that uses sibling temp dirs would stay green while it did.
 *
 * ENOENT/ENOTDIR on EITHER side means that path does not exist — `attach` legitimately passes a
 * projectRoot it is about to create, and the CLI asks "is this record the shell?" about roots that
 * may be stale. A directory that does not exist cannot BE another directory, so `false` is the
 * correct and safe answer: there is nothing to destroy. (And if it is `shellRoot` that is missing,
 * syncProject's required-source check throws loudly a few lines later — the failure is reported, not
 * swallowed.)
 *
 * Every OTHER stat error RETHROWS. An EACCES/EPERM/ELOOP quietly caught here would read as "not the
 * same directory" and license the destructive copy on a path that IS the shell — a bypass of the one
 * guard standing between a typo and a wiped shell.
 */
export function sameDirectory(a, b) {
  const statOrNull = (p) => {
    try {
      return fs.statSync(p);
    } catch (err) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
      throw err;
    }
  };
  const sa = statOrNull(a);
  if (!sa) return false;
  const sb = statOrNull(b);
  if (!sb) return false;
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

export class SelfSyncRefusedError extends Error {
  constructor(message, { projectRoot, shellRoot, at } = {}) {
    super(message);
    this.name = "SelfSyncRefusedError";
    this.code = "self_sync_refused";
    this.projectRoot = projectRoot;
    this.shellRoot = shellRoot;
    this.at = at;
  }
}

export class MissingRequiredSourceError extends Error {
  constructor(message, { source } = {}) {
    super(message);
    this.name = "MissingRequiredSourceError";
    this.code = "missing_required_source";
    this.source = source;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDirOverwriteTracked(srcDir, destDir, projectRoot, updated) {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return;
  ensureDir(destDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirOverwriteTracked(src, dest, projectRoot, updated);
    } else if (entry.isFile()) {
      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
      updated.push(path.relative(projectRoot, dest));
    }
  }
}

export function syncProject({ projectRoot, projectId, shellRoot, refreshStamp = true }) {
  // backlog.fix.shell-self-sync-skill-wipe-health-gate — THE ENTRY GUARD.
  //
  // Syncing a directory FROM ITSELF destroys it. The skills loop below rm's each destination skill
  // before copying the source over it; when projectRoot === shellRoot they are the SAME directory, so
  // the rm deletes the source and the copy then finds nothing to copy and silently no-ops. Exit 0.
  // "Synced 0 file(s)". Every skill, gone, and nothing said so.
  //
  // This is not hypothetical: `setup.mjs` registers the shell in its OWN registry, and three callers
  // then loop that registry with no idea one of the records IS the shell — `project upgrade --all`,
  // `routekit doctor`, and bootstrap. It cost a clean-machine UAT round: 17 skills deleted, rks
  // reporting itself healthy the whole time.
  //
  // Refuse LOUDLY. A silent skip here would just be a quieter version of the same bug.
  if (sameDirectory(projectRoot, shellRoot)) {
    throw new SelfSyncRefusedError(
      `refusing to sync ${projectRoot} from itself — projectRoot and shellRoot are the same directory. ` +
        `A shell is not one of its own children; syncing it from itself deletes its skills. ` +
        `If you meant to sync a child, pass that child's path; if you meant to update the shell, use git.`,
      { projectRoot, shellRoot, at: "syncProject" },
    );
  }

  const updated = [];

  // 1. Hooks — overwrite from generic template
  const srcHooks = path.join(shellRoot, "templates", "generic", ".routekit", "hooks");
  const destHooks = path.join(projectRoot, ".routekit", "hooks");
  copyDirOverwriteTracked(srcHooks, destHooks, projectRoot, updated);

  // 2. Governor prompts — overwrite
  const srcPrompts = path.join(shellRoot, ".rks", "prompts");
  if (fs.existsSync(srcPrompts)) {
    const destPrompts = path.join(projectRoot, ".rks", "prompts");
    ensureDir(destPrompts);
    for (const file of fs.readdirSync(srcPrompts)) {
      if (!file.startsWith("governor-") || !file.endsWith(".md")) continue;
      fs.copyFileSync(path.join(srcPrompts, file), path.join(destPrompts, file));
      updated.push(path.relative(projectRoot, path.join(destPrompts, file)));
    }
  }

  // 3. Skills — overwrite with projectId substitution
  //
  // Skills are a REQUIRED source, unlike hooks/prompts/agents above (each of which is legitimately
  // optional and tolerated when absent). A shell with no skills to hand out is a broken shell, and
  // the old `if (existsSync)` turned that into a silent no-op: "Synced 0 file(s)", exit 0 — the same
  // silence that made the self-sync wipe invisible. Say it out loud instead.
  const srcSkills = path.join(shellRoot, ".claude", "skills");
  if (!fs.existsSync(srcSkills)) {
    throw new MissingRequiredSourceError(
      `shell has no skills to sync: ${srcSkills} does not exist. Skills are required — a shell that ` +
        `cannot hand out skills cannot bootstrap or repair a child. Restore them from git ` +
        `(\`git checkout HEAD -- .claude/skills\`) and retry.`,
      { source: srcSkills },
    );
  }
  {
    const skillsExclude = loadSkillsExclude(shellRoot);
    const destSkills = path.join(projectRoot, ".claude", "skills");
    ensureDir(destSkills);
    for (const entry of fs.readdirSync(srcSkills, { withFileTypes: true })) {
      if (!entry.isDirectory() || skillsExclude.has(entry.name)) continue;
      const srcSkill = path.join(srcSkills, entry.name);
      const destSkill = path.join(destSkills, entry.name);
      // THE POINT-OF-DESTRUCTION GUARD. The entry guard above compares projectRoot to shellRoot, and
      // that is not enough: projectRoot can be a genuinely DIFFERENT directory whose
      // .claude/skills — or one skill inside it — is a SYMLINK back to the shell's. Then src and
      // dest are the same directory, this rm deletes THROUGH the link, and the shell is wiped with
      // the entry guard none the wiser. Check identity where the destruction actually happens; that
      // also closes the TOCTOU window between the entry check and this line.
      if (fs.existsSync(destSkill) && sameDirectory(srcSkill, destSkill)) {
        throw new SelfSyncRefusedError(
          `refusing to delete ${destSkill} — it is the same directory as its own copy source ` +
            `${srcSkill}. Removing it would destroy the source and silently sync nothing.`,
          { projectRoot, shellRoot, at: "skills" },
        );
      }
      if (fs.existsSync(destSkill)) fs.rmSync(destSkill, { recursive: true, force: true });
      copyDirOverwriteTracked(srcSkill, destSkill, projectRoot, updated);
      if (projectId && projectId !== "routekit-shell") {
        for (const f of fs.readdirSync(destSkill).filter(n => n.endsWith(".md"))) {
          const fp = path.join(destSkill, f);
          const content = fs.readFileSync(fp, "utf8");
          const replaced = content.replace(/routekit-shell/g, projectId);
          if (replaced !== content) fs.writeFileSync(fp, replaced);
        }
      }
    }
  }

  // 4. Agent definitions — overwrite (flat .md files; no projectId substitution — they
  //    declare Claude Code subagents by tool allowlist, not project identity). Mirrors the
  //    bootstrap seed so `project upgrade` repairs children scaffolded before agents shipped.
  const srcAgents = path.join(shellRoot, ".claude", "agents");
  if (fs.existsSync(srcAgents)) {
    const destAgents = path.join(projectRoot, ".claude", "agents");
    ensureDir(destAgents);
    for (const file of fs.readdirSync(srcAgents)) {
      if (!file.endsWith(".md")) continue;
      fs.copyFileSync(path.join(srcAgents, file), path.join(destAgents, file));
      updated.push(path.relative(projectRoot, path.join(destAgents, file)));
    }
  }

  // Refresh the child's rksVersion stamp to the running shell version so a plain
  // `routekit project sync` no longer leaves a stale stamp (the drift that let a child
  // run many versions behind, blind). Opt-out via refreshStamp:false — the upgrade path
  // passes false so IT stamps LAST for crash-safety. Idempotent (only writes when the
  // stamp actually differs); sibling-preserving + safe on missing/malformed via advanceStamp.
  if (refreshStamp) {
    const shellVersion = readRksVersion(shellRoot);
    if (shellVersion) {
      const rksJsonPath = path.join(projectRoot, ".rks", "project.json");
      let current = null;
      try {
        current = JSON.parse(fs.readFileSync(rksJsonPath, "utf8")).rksVersion ?? null;
      } catch {
        /* missing/malformed — advanceStamp will create/repair */
      }
      if (current !== shellVersion) {
        advanceStamp(rksJsonPath, shellVersion);
        updated.push(path.relative(projectRoot, rksJsonPath));
      }
    }
  }

  return updated;
}
