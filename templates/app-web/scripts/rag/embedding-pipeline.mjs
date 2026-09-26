import { pipeline } from '@xenova/transformers';
import { createHash } from 'crypto';

const EMBEDDINGS_MODE = process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE || process.env.RKS_RAG_EMBEDDINGS_MODE || 'model';

let embeddingPipeline = null;
let initPromise = null;

/**
 * Shared embedding pipeline (singleton) for this scaffolded app-web project.
 * Thread-safe — concurrent calls await the same initialization, so only ONE ONNX
 * model is loaded per process (prevents SIGILL from duplicate/concurrent init).
 *
 * Standalone BY DESIGN: a scaffolded app-web project has no access to the rks
 * shell's packages/mcp-rks singleton, so this is the template-local copy. Keep it
 * behavior-identical to the shell singleton (same model, same stub mode).
 */
export async function getSharedEmbeddingPipeline() {
  if (embeddingPipeline) {
    return embeddingPipeline;
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    if (EMBEDDINGS_MODE === 'stub') {
      console.error('🧪 Using stub embeddings mode (deterministic, offline).');
      embeddingPipeline = async (text) => {
        const hash = createHash('sha256').update(String(text || '')).digest();
        const vec = new Array(384);
        for (let i = 0; i < vec.length; i += 1) {
          vec[i] = (hash[i % hash.length] / 255) * 2 - 1;
        }
        return { data: vec };
      };
      return embeddingPipeline;
    }

    console.error('🤖 Loading embedding model (Xenova/all-MiniLM-L6-v2)...');
    embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.error('✅ Embedding model loaded');
    return embeddingPipeline;
  })();

  return initPromise;
}
