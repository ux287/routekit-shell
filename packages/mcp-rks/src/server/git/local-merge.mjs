/**
 * Shared local-merge helper.
 *
 * Used by both rks_story_ship and the auto-ship flow inside guardrailsOn()
 * for projects on a 3-branch workflow (working !== integration), where the
 * working branch is local-only and ship is a local merge with no remote
 * interaction.
 *
 * Sequence:
 *   git checkout <targetBranch>
 *   git merge <featureBranch> --no-edit
 *   git branch -d <featureBranch>
 *
 * Branch deletion failure is non-fatal — returned as { ok: true, warning }.
 */
import { spawnSync } from 'child_process';

export function localMerge(projectRoot, featureBranch, targetBranch) {
  const checkout = spawnSync('git', ['checkout', targetBranch], { cwd: projectRoot, encoding: 'utf8' });
  if (checkout.status !== 0) {
    return { ok: false, error: `Failed to checkout ${targetBranch}: ${checkout.stderr?.trim()}` };
  }

  const merge = spawnSync('git', ['merge', featureBranch, '--no-edit'], { cwd: projectRoot, encoding: 'utf8' });
  if (merge.status !== 0) {
    return { ok: false, error: `Failed to merge ${featureBranch}: ${merge.stderr?.trim()}` };
  }

  const deleteBranch = spawnSync('git', ['branch', '-d', featureBranch], { cwd: projectRoot, encoding: 'utf8' });
  if (deleteBranch.status !== 0) {
    return { ok: true, warning: `Merged but could not delete branch: ${deleteBranch.stderr?.trim()}` };
  }

  return { ok: true };
}
