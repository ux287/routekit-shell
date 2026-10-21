/**
 * Project/meta family handlers — moved verbatim from server.mjs (S3 of
 * research.2026.10.05.server-mjs-safe-decomposition).
 * Bare specifiers are byte-identical to server.mjs; relative imports resolve to the same
 * module files (invariant I3). Schema consts stay in server.mjs (TOOL_ARG_SCHEMAS and the
 * schema-drift guard reference them) and are passed in at registration.
 * Handler contract: see ./registry.mjs. No handler in this family reads ctx.
 */
import { execSync } from "child_process";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { resolveKgKey } from "../../project-context.mjs";
import { listTemplates } from "../../templates.mjs";
import { repoRoot, loadContext, getBranchConfig } from "../project.mjs";
import { publish, listProfiles, listRemotes } from "../publish.mjs";
import { previewChannelPublish } from "../channel-preview.mjs";
import { resolveNotesDir } from "../../dendron.mjs";

export function registerProjectMetaHandlers({ registerHandler }, {
  projectGetSchema,
  kgQuerySchema,
  templatesListSchema,
  gitStateSchema,
  publishSchema,
  publishProfilesSchema,
  channelPreviewSchema,
}) {
  registerHandler("rks_project_get", async (cleanArgs, ctx) => {
    const input = projectGetSchema.parse(cleanArgs);
    const context = await loadContext(input.id);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              registry: context.record,
              projectJson: context.projectJson,
              kg: context.kg,
              branches: getBranchConfig(context.record, context.projectJson),
            },
            null,
            2
          ),
        },
      ],
    };
  });

  registerHandler("rks_kg_query", async (cleanArgs, ctx) => {
    const input = kgQuerySchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const value = resolveKgKey(context.kg, input.key || "");
    if (value === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Key not found in KG: ${input.key || "(root)"}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  });

  registerHandler("rks_templates_list", async (cleanArgs, ctx) => {
    const input = templatesListSchema.parse(cleanArgs || {});
    const templates = listTemplates(repoRoot).filter((template) =>
      input.prefix ? template.stackId.startsWith(input.prefix) : true
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ templates }, null, 2),
        },
      ],
    };
  });

  registerHandler("rks_git_state", async (cleanArgs, ctx) => {
    const input = gitStateSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const run = (cmd) => {
      try {
        return execSync(cmd, { cwd: projectRoot, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
      } catch { return null; }
    };
    const currentBranch = run("git rev-parse --abbrev-ref HEAD");
    const upstream = run("git rev-parse --abbrev-ref --symbolic-full-name @{u}");
    const statusOut = run("git status --porcelain");
    const isClean = statusOut !== null && statusOut.length === 0;
    const uncommittedFiles = statusOut ? statusOut.split("\n").filter(Boolean).slice(0, 20).map(l => l.slice(3)) : [];
    let aheadBy = 0, behindBy = 0;
    if (upstream && currentBranch) {
      const counts = run(`git rev-list --left-right --count ${currentBranch}...${upstream}`);
      if (counts) {
        const parts = counts.split(/\s+/);
        aheadBy = Number(parts[0] || 0);
        behindBy = Number(parts[1] || 0);
      }
    }
    const diverged = aheadBy > 0 && behindBy > 0;
    const recommendations = [];
    if (!isClean) recommendations.push("Working tree has uncommitted changes");
    if (!upstream) recommendations.push("No upstream tracking branch set");
    if (behindBy > 0) recommendations.push(`Pull remote changes (${behindBy} commits behind)`);
    if (aheadBy > 0) recommendations.push(`Push local commits (${aheadBy} commits ahead)`);
    if (diverged) recommendations.push("Branch diverged - consider git pull --rebase");
    return {
      content: [
        {
          type: "text",
          // upstream (additive, backlog.fix.ship-flow-deterministic-no-llm): the tracking ref, or
          // null when none is set — the explicit signal the Ship prompt's "nothing to ship" rule reads.
          text: JSON.stringify({ currentBranch, isClean, aheadBy, behindBy, diverged, uncommittedFiles, recommendations, upstream: upstream || null }, null, 2),
        },
      ],
    };
  });

  registerHandler("rks_publish", async (cleanArgs, ctx) => {
    const input = publishSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const result = await publish(projectRoot, {
      projectId: input.projectId,
      remote: input.remote,
      profile: input.profile || "app-only",
      branch: input.branch || "main",
      dryRun: input.dryRun || false,
      message: input.message || `Publish from RKS - ${new Date().toISOString()}`,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  registerHandler("rks_publish_profiles", async (cleanArgs, ctx) => {
    const input = publishProfilesSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const profiles = listProfiles(projectRoot);
    const remotes = listRemotes(projectRoot);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, profiles, remotes }, null, 2) }] };
  });

  registerHandler("rks_channel_preview", async (cleanArgs, ctx) => {
    const input = channelPreviewSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const notesDir = resolveNotesDir(context.record.root);
    const result = previewChannelPublish(notesDir, { system: input.system });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
}
