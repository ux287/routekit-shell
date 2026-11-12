/**
 * Inbox family handler — backlog.feat.remote-inbox-owner-review.
 *
 * rks_inbox_review is the OWNER-side review of remote-lane inbox.<actor>.* notes: list them on a
 * remote worktree branch, accept one into the current working branch under a name outside
 * inbox., or discard it. Never admitted on the remote lane (REMOTE_LANE_TOOLS is default-deny).
 * The logic lives in shared/inbox-review.mjs; this module parses, resolves the project root and
 * the configured working branch, and wraps the result as an MCP response.
 *
 * Handler contract: see ./registry.mjs. The schema const stays in server.mjs (TOOL_ARG_SCHEMAS)
 * and is passed in at registration. `deps.getDendronContext` is the server.mjs helper (project
 * root + notes directory); `deps.resolveWorkingBranch` defaults to the runCycleComplete
 * resolution (getBranchConfig over the project record and .rks/project.json).
 */
import fs from "fs";
import path from "path";
import { resolveProjectRoot, resolveNotesDir } from "../../dendron.mjs";
import { loadContext, getBranchConfig } from "../project.mjs";
import { listInboxNotes, acceptInboxNote, discardInboxNote, validateAcceptTarget, inboxActor } from "../../shared/inbox-review.mjs";

function defaultDendronContext() {
  const projectRoot = resolveProjectRoot();
  return { projectRoot, notesDir: resolveNotesDir(projectRoot) };
}

function readProjectJson(projectRoot) {
  try {
    const p = path.join(projectRoot, ".rks", "project.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { /* defaults below */ }
  return {};
}

/**
 * The project's configured working branch, resolved the way runCycleComplete does
 * (server/git/git-ship.mjs): getBranchConfig(context.record, context.projectJson) when a
 * projectId loads, otherwise getBranchConfig over <projectRoot>/.rks/project.json alone
 * (default working: "staging").
 */
export async function resolveWorkingBranch({ projectId, projectRoot }) {
  if (projectId) {
    try {
      const context = await loadContext(projectId);
      return getBranchConfig(context.record, context.projectJson).working;
    } catch { /* fall through to the project root's own config */ }
  }
  return getBranchConfig(null, readProjectJson(projectRoot)).working;
}

export function registerInboxHandlers({ registerHandler }, { inboxReviewSchema }, deps = {}) {
  const getDendronContext = deps.getDendronContext || defaultDendronContext;
  const workingBranchOf = deps.resolveWorkingBranch || resolveWorkingBranch;

  registerHandler("rks_inbox_review", async (cleanArgs) => {
    const args = inboxReviewSchema.parse(cleanArgs);
    const reply = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
    const { projectRoot, notesDir } = getDendronContext();

    if (args.action === "list") {
      return reply(listInboxNotes({ projectRoot, notesDir, branch: args.branch }));
    }

    if (args.action === "accept") {
      const target = validateAcceptTarget(args.targetFilename);
      if (!target.ok) return reply({ ok: false, action: "accept", reason: target.reason, writeOk: false, commitOk: false });
      if (args.filename && !inboxActor(args.filename)) {
        return reply({ ok: false, action: "accept", reason: "not_inbox_note", filename: args.filename, writeOk: false, commitOk: false });
      }
      const workingBranch = await workingBranchOf({ projectId: args.projectId, projectRoot });
      const result = await acceptInboxNote({
        projectRoot,
        notesDir,
        branch: args.branch,
        filename: args.filename,
        targetFilename: args.targetFilename,
        workingBranch,
      });
      return reply(result.ok ? result : { action: "accept", writeOk: false, commitOk: false, ...result });
    }

    // discard
    return reply(discardInboxNote({ projectRoot, notesDir, branch: args.branch, filename: args.filename }));
  });
}
