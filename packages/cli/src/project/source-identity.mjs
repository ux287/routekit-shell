import fs from "node:fs";
import path from "node:path";

/**
 * Source-project identity recovery, shared by bootstrap and sync.
 *
 * backlog.fix.mirror-clone-sync-reverts-child-skill-identity: these three helpers were introduced
 * in bootstrap.mjs by the v0.50.3 mirror-clone fix and are extracted here because sync.mjs needs
 * exactly the same behaviour. Extracted rather than duplicated deliberately — the defect this
 * closes IS a divergence between two copies of one substitution rule, so a second copy would
 * reinstate it. A leaf module rather than a cross-import: bootstrap.mjs already imports from
 * sync.mjs, so importing bootstrap from sync would close a circular ESM dependency.
 *
 * On a PUBLISHED MIRROR the sentinel is already spent. publish.mjs resolves __RKS_SOURCE_PROJECT__
 * to the literal public id across the delivered skills tree, so a sentinel-only replacement matches
 * nothing on a clone and the cloner's child keeps skills naming the SOURCE project. Recover the
 * source identity from the shell checkout's own .rks/project.json — publish rewrites that same `id`
 * from the SAME value, and .gitignore re-includes the file, so every clone carries it.
 */
export function readShellIdentity(shellRoot) {
  const idFile = path.join(shellRoot, ".rks", "project.json");
  try {
    const id = JSON.parse(fs.readFileSync(idFile, "utf8"))?.id;
    return { id: typeof id === "string" && id ? id : null, idFile };
  } catch {
    return { id: null, idFile };
  }
}

export function escapeForRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Scoped to the VALUE POSITIONS the sentinel occupies — never a blanket id replacement. A blanket
// pass would corrupt live prose such as `routekit-shell-release` in the release skill's SKILL.md,
// and because that is a SUPERSTRING of the source id, a \b word boundary is not a safe escape
// either. The trailing guard stops `for projectId routekit-shell` matching inside an id that merely
// begins with it, e.g. `for projectId routekit-shell-core`.
export function substituteSourceIdentity(content, sourceId, projectId) {
  const src = escapeForRegExp(sourceId);
  const tail = "(?![A-Za-z0-9_-])";
  const forms = [
    new RegExp(`(for projectId )${src}${tail}()`, "g"),
    new RegExp(`(Replace __PROJECT_ID__ with )${src}${tail}()`, "g"),
    new RegExp(`(projectId: ')${src}(')`, "g"),
    new RegExp(`(projectId: ")${src}(")`, "g"),
  ];
  return forms.reduce((acc, re) => acc.replace(re, (_m, pre, post) => pre + projectId + post), content);
}
