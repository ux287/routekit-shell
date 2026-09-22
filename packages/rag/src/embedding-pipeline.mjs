import { pipeline } from "@xenova/transformers";
import { createHash } from "crypto";

const EMBEDDINGS_MODE = process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE || process.env.RKS_RAG_EMBEDDINGS_MODE || "model";

let embeddingPipeline = null;
let initPromise = null;

/**
 * Get the shared embedding pipeline (singleton).
 * Thread-safe - concurrent calls will wait for the same initialization.
 *
 * This module ensures only ONE ONNX model is loaded per process, preventing
 * SIGILL crashes from concurrent/duplicate model initialization.
 */
export async function getSharedEmbeddingPipeline() {
  if (embeddingPipeline) {
    return embeddingPipeline;
  }

  // Use promise to prevent concurrent initialization
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    if (EMBEDDINGS_MODE === "stub") {
      console.error("🧪 Using stub embeddings mode (deterministic, offline).");
      embeddingPipeline = async (text) => {
        const hash = createHash("sha256").update(String(text || "")).digest();
        const vec = new Array(384);
        for (let i = 0; i < vec.length; i += 1) {
          vec[i] = (hash[i % hash.length] / 255) * 2 - 1;
        }
        return { data: vec };
      };
      return embeddingPipeline;
    }

    console.error('🤖 Loading embedding model (Xenova/all-MiniLM-L6-v2)...');
    embeddingPipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    console.error('✅ Embedding model loaded');
    return embeddingPipeline;
  })();

  return initPromise;
}

/**
 * Re-embed a scoped list of files after a successful exec run.
 * Only the supplied files are indexed — not a full re-embed of the project.
 * This closes the op:create → op:edit handoff gap: files written by exec
 * are immediately available to the next planner invocation.
 *
 * If embedding fails, the error is returned (non-throwing) so the caller
 * can log a warning without failing the exec result.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {string[]} files - Relative file paths to embed (as written by exec)
 * @returns {{ ok: boolean, filesEmbedded?: number, error?: string }}
 */
export async function embedScopedFiles(projectRoot, files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: true, filesEmbedded: 0 };
  }
  try {
    // Dynamic import avoids a circular dependency — tools.mjs does not import this module
    const { runRagEmbed } = await import("./tools.mjs");
    const result = await runRagEmbed(projectRoot, { files });
    return { ok: result?.ok !== false, filesEmbedded: files.length };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
