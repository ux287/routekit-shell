/**
 * RAG / retrieval family handlers — moved verbatim from server.mjs (S5 of
 * research.2026.10.05.server-mjs-safe-decomposition).
 * Bare specifiers are byte-identical to server.mjs; relative imports resolve to the same
 * module files (invariant I3). The one lazy import (rks_fetch_raw) is re-pathed to
 * ../../agents/fetch-raw.mjs, the same file. Schema consts stay in server.mjs
 * (TOOL_ARG_SCHEMAS and the schema-drift guard reference them) and are passed in at
 * registration. getDendronContext has callers that stay in server.mjs, so it is passed in
 * too — a registration-time dependency, not a ctx extension. RAG host-hook wiring stays in
 * startServer(). Handler contract: see ./registry.mjs. No handler reads ctx.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { runRagEmbed, runRagInit, runRagReset, runRagQuery, runRagCompact, ensureRagIndex, runExhaustiveSearch, resolveFidelityCeiling } from "@routekit/rag";
import { createCapabilityToken } from "@routekit/rag/capability-token";
import { AGENT_ROLES } from "@routekit/rag/capability-profiles";
import { hasGitRepo, getCurrentBranch } from "../exec.mjs";
import { loadContext, getBranchConfig } from "../project.mjs";
import { commitAndEmbedNote } from "../../shared/commit-and-embed-note.mjs";

export function registerRagHandlers({ registerHandler }, {
  ragInitSchema,
  ragEmbedSchema,
  ragQuerySchema,
  ragCompactSchema,
  memorySaveSchema,
  fetchRawSchema,
}, {
  getDendronContext,
}) {
  registerHandler("rks_rag_init", async (cleanArgs, ctx) => {
    const input = ragInitSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const { working: workingBranch } = getBranchConfig(context.record, context.projectJson);
    if (hasGitRepo(projectRoot)) {
      // No clean-tree gate: RAG init writes no commits and reads the working
      // tree (not a committed ref), so a dirty tree (e.g. an npm-install'd
      // package-lock.json — already in CODE_IGNORE) must not block it. The
      // orphaned gate was copy-pasted from exec, which DOES write commits.
      // See notes/research.2026.06.28.uat-findings.md Finding 2.
      const currentBranch = getCurrentBranch(projectRoot);
      if (currentBranch !== workingBranch) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `rks_rag_init: expected to run from working branch "${workingBranch}" but you're on "${currentBranch}".`
        );
      }
    }

    const reset = input.reset === true;
    let result;
    if (input.reset === true) {
      result = await runRagReset(projectRoot);
    } else {
      result = await runRagInit(projectRoot);
    }
    const payload = {
      ok: result?.ok ?? false,
      projectId: input.projectId,
      projectRoot,
      db: result?.db,
      reset,
      message: result?.ok ? "RAG database initialized" : result?.error || "Initialization failed",
    };
    if (reset) {
      payload.rowsBeforeReset = result?.rowsBeforeReset;
      payload.tableDropped = result?.tableDropped;
      payload.manifestPath = result?.manifestPath;
      if (result?.locked) payload.locked = true;
      if (result?.ok) {
        payload.message = result.tableDropped === true
          ? `RAG index reset: dropped ${result.rowsBeforeReset} row(s) and cleared the embed manifest. Run a full rks_rag_embed to rebuild.`
          : "No embeddings table to drop; embed manifest cleared. Run a full rks_rag_embed to rebuild.";
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  });

  registerHandler("rks_rag_embed", async (cleanArgs, ctx) => {
    const input = ragEmbedSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const { working: workingBranch } = getBranchConfig(context.record, context.projectJson);
    if (hasGitRepo(projectRoot)) {
      // No clean-tree gate (see rks_rag_init above): embedding reads the
      // working tree via globby and writes only to the gitignored, regenerable
      // .rks/rag index — a dirty tree must not block it.
      // notes/research.2026.06.28.uat-findings.md Finding 2.
      const currentBranch = getCurrentBranch(projectRoot);
      if (currentBranch !== workingBranch) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `rks_rag_embed: expected to run from working branch "${workingBranch}" but you're on "${currentBranch}".`
        );
      }
    }

    const result = await runRagEmbed(projectRoot, { glob: input.glob, files: input.files });
    const payload = {
      ok: result?.ok ?? false,
      projectId: input.projectId,
      projectRoot,
      glob: input.glob || null,
      // ECHOED so a caller can confirm the request arrived intact. Its absence is what
      // made `indexed: 4050` unreadable — there was nothing in the response tying the
      // number to the one file that had been asked for.
      files: input.files ?? null,
      // UNCHANGED MEANING. Consumers read this as the whole-corpus row count, and
      // tools.mjs treats indexed === 0 as its zero-work predicate, so it keeps both.
      indexed: result?.indexed,
      // The same total under a name that says what it counts, so no field named for a
      // run result holds a corpus figure.
      corpusRowTotal: result?.corpusRowTotal,
      // PER-RUN work, which the embed layer already computed and the projection discarded.
      processedNotes: result?.processedNotes,
      embeddedNotes: result?.embeddedNotes,
      skippedNotes: result?.skippedNotes,
      skippedCodeFiles: result?.skippedCodeFiles,
      // PER-FILE outcomes, each written by the code path that handled that file. This is
      // what lets a caller answer "was MY file embedded?" without a second query.
      fileOutcomes: result?.fileOutcomes,
      db: result?.db,
      warning: result?.error,
    };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  });

  registerHandler("rks_rag_query", async (cleanArgs, ctx) => {
    const input = ragQuerySchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    try {
      await ensureRagIndex(projectRoot);
    } catch (err) {
      console.error(`[rks] RAG index stale or ensure failed - auto-embedding notes...`);
      try {
        await runRagEmbed(projectRoot, { glob: "notes/**/*.md" });
        console.error(`[rks] auto-embed completed`);
      } catch (embedErr) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "RAG index stale and auto-embed failed: " + (embedErr?.message || String(embedErr)) }, null, 2) }] };
      }
    }

    // Create capability token when role is provided for fidelity filtering
    let capabilityToken = null;
    if (input.role && Object.values(AGENT_ROLES).includes(input.role)) {
      capabilityToken = createCapabilityToken({
        runId: `query-${Date.now()}`,
        role: input.role,
        projectId: input.projectId,
      });
    }

    const result = await runRagQuery(projectRoot, {
      q: input.q,
      k: input.k,
      capabilityToken,
    });
    const payload = {
      ok: result?.ok ?? true,
      projectId: input.projectId,
      matches: result?.matches || [],
      role: input.role || null,
      fidelityApplied: capabilityToken
        ? `L${capabilityToken.maxFidelity}`
        : (resolveFidelityCeiling(projectRoot) === "full" ? "L3 (owned corpus)" : "L2 (default)"),
      hint: result?.error,
    };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  });

  registerHandler("rks_exhaustive_search", async (cleanArgs, ctx) => {
    // Governed (protected-by-default) deterministic exhaustive search. Reaching
    // this handler means the token gate above already passed — only cited
    // results are returned; the raw search runs server-side in runExhaustiveSearch.
    try {
      const context = await loadContext(cleanArgs.projectId);
      const projectRoot = context.record.root;
      const result = runExhaustiveSearch(projectRoot, {
        pattern: cleanArgs.pattern,
        path: cleanArgs.path,
        countOnly: cleanArgs.countOnly,
        maxResults: cleanArgs.maxResults,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2) }] };
    }
  });

  registerHandler("rks_rag_compact", async (cleanArgs, ctx) => {
    const input = ragCompactSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    try {
      const result = await runRagCompact(projectRoot);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              projectId: input.projectId,
              ...result,
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: err?.message || String(err),
            }, null, 2),
          },
        ],
      };
    }
  });

  registerHandler("rks_memory_save", async (cleanArgs, ctx) => {
    const input = memorySaveSchema.parse(cleanArgs);
    // Root from the env/process (same resolver as the dendron write tools), NEVER from
    // loadContext(input.projectId): a token-free tool must not let projectId pick which
    // registered repository it commits into.
    const { projectRoot } = getDendronContext();
    // Slug validation is delegated to the helper's allowlist (one rule for both entry points).
    const res = await commitAndEmbedNote({
      projectRoot,
      slug: input.slug,
      content: input.content,
      title: input.title,
      desc: input.desc,
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_fetch_raw", async (cleanArgs, ctx) => {
    const input = fetchRawSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const { fetchRaw } = await import("../../agents/fetch-raw.mjs");
    const res = await fetchRaw(input.url, {
      projectRoot,
      projectId: input.projectId,
      timeoutMs: input.timeoutMs,
      maxBytes: input.maxBytes,
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });
}
