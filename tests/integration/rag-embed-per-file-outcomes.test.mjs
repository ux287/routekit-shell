/**
 * Witness for backlog.fix.rag-embed-reports-corpus-total-not-per-run-outcome.
 *
 * Reported from child project ux287-bpm: `rks_rag_embed({ files: ['notes/<one>.md'] })`
 * returned `indexed: 4050`, then `indexed: 4109` after that one file grew ~58KB → ~89KB.
 * Both are whole-corpus row totals, and neither answers the only question the caller had —
 * was MY file embedded? The honest per-run counts existed inside the embed layer and were
 * discarded before they reached the caller; per-file identity was destroyed before the
 * counts even formed, because `processNote` returned a bare array.
 *
 * STUB EMBEDDER, not a real model. `embedding-pipeline.mjs` has a production stub arm
 * selected by these env vars, and the exemplar this file follows
 * (tests/integration/rag-embed-upsert.test.mjs) uses it. The mode is read into a
 * MODULE-SCOPE const, so the env must be set BEFORE the dynamic import — a top-level static
 * import would pin the mode to "model" and download ~90MB inside the mock sweep.
 */
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { makeTempDir, writeFile } from "../helpers/tmp.mjs";

const NOTE = (title, body) => `---\ntitle: ${title}\n---\n\n${body}\n`;

describe("rks_rag_embed reports what THIS RUN did to each file", { timeout: 60_000 }, () => {
  let projectRoot;
  let dbPath;

  beforeEach(() => {
    process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "stub";
    process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
    delete process.env.RKS_CODE_GLOB;
    delete process.env.ROUTEKIT_CODE_GLOB;
    delete process.env.RKS_RAG_SCOPE_MODE;
    delete process.env.RKS_RAG_RESET;
    projectRoot = makeTempDir("rag_outcomes");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "rag-outcomes", private: true }));
    dbPath = path.join(projectRoot, ".rks", "rag", "lance", "notes.lance");
  });

  const run = async (opts = {}) => {
    const { embed } = await import("@routekit/rag/embed");
    return embed({ projectRoot, vault: path.join(projectRoot, "notes"), glob: "**/*", db: dbPath, ...opts });
  };

  const outcomeFor = (res, needle) => (res.fileOutcomes || []).find((o) => o.file.includes(needle));

  it("names every file it considered, with whether it was embedded", async () => {
    writeFile(path.join(projectRoot, "notes", "alpha.md"), NOTE("Alpha", "content one"));
    writeFile(path.join(projectRoot, "notes", "beta.md"), NOTE("Beta", "content two"));

    const res = await run();

    expect(res.ok).toBe(true);
    expect(Array.isArray(res.fileOutcomes)).toBe(true);
    expect(outcomeFor(res, "alpha.md")).toMatchObject({ embedded: true, reason: null });
    expect(outcomeFor(res, "beta.md")).toMatchObject({ embedded: true, reason: null });
  });

  it("a caller can answer 'was MY file embedded?' from the return value alone", async () => {
    writeFile(path.join(projectRoot, "notes", "mine.md"), NOTE("Mine", "the one I asked about"));
    writeFile(path.join(projectRoot, "notes", "other.md"), NOTE("Other", "not mine"));

    const res = await run();
    const mine = outcomeFor(res, "mine.md");

    expect(mine).toBeTruthy();
    expect(mine.embedded).toBe(true);
    // The defect, restated: the corpus total cannot answer this.
    expect(typeof res.corpusRowTotal).toBe("number");
    expect(res.corpusRowTotal).not.toBe(mine.embedded);
  });

  it("reports a file the EXCLUSION PREDICATE skipped, with its verbatim reason", async () => {
    // `rag: false` is the opt-out the predicate consults first. It survives the sibling
    // deny-list story, which is why the fixture hangs on it rather than on a namespace.
    writeFile(path.join(projectRoot, "notes", "kept.md"), NOTE("Kept", "included"));
    writeFile(path.join(projectRoot, "notes", "optedout.md"), `---\ntitle: Opted\nrag: false\n---\n\nbody\n`);

    const res = await run();
    const skipped = outcomeFor(res, "optedout.md");

    expect(skipped).toBeTruthy();
    expect(skipped.embedded).toBe(false);
    expect(skipped.reason).toBe("excluded");
    // Not invisible behind an unchanged aggregate — it is named.
    expect(outcomeFor(res, "kept.md").embedded).toBe(true);
  });

  // NOT COVERED, deliberately, and recorded rather than quietly dropped: the `empty` skip
  // reason at buildEmbeddingRows could not be reached from this tier. Both an
  // frontmatter-only note and a zero-byte file still produce a chunk and report
  // embedded: true. Whether `empty` is reachable at all is a separate question about the
  // chunker, not about this story's reporting. The verbatim-reason path is proven by the
  // `excluded` case above, which is the reason the acceptance criterion actually names.

  it("reports an unchanged file as unchanged rather than silently omitting it", async () => {
    writeFile(path.join(projectRoot, "notes", "stable.md"), NOTE("Stable", "unchanging"));
    await run();

    // Second pass: nothing changed, so this takes the zero-work return.
    const res = await run();
    const stable = outcomeFor(res, "stable.md");

    expect(res.ok).toBe(true);
    expect(stable).toBeTruthy();
    expect(stable.embedded).toBe(false);
    expect(stable.reason).toBe("unchanged");
  });

  it("carries all four per-run counters on the ZERO-WORK return, not just the full one", async () => {
    // This is the return a caller hits most often, and three of the four counters existed
    // only on the full return — so the boundary was told to project fields the producer did
    // not carry here. Asserted as numbers: `undefined` fails.
    writeFile(path.join(projectRoot, "notes", "stable.md"), NOTE("Stable", "unchanging"));
    await run();
    const res = await run();

    expect(res.skipped).toBe(true);
    for (const field of ["processedNotes", "embeddedNotes", "skippedNotes", "skippedCodeFiles"]) {
      expect(typeof res[field], `${field} must be a number on the zero-work return`).toBe("number");
    }
  });

  it("distinguishes the corpus total from per-run work by NAME on every return", async () => {
    writeFile(path.join(projectRoot, "notes", "one.md"), NOTE("One", "content"));
    const first = await run();
    expect(typeof first.corpusRowTotal).toBe("number");
    expect(first.corpusRowTotal).toBe(first.indexed);

    const second = await run();
    expect(typeof second.corpusRowTotal).toBe("number");
    // `indexed` keeps its meaning — tools.mjs uses indexed === 0 as its zero-work predicate.
    expect(second.indexed).toBe(second.corpusRowTotal);
  });

  it("reports a REQUESTED file that selection dropped before the loop ran", async () => {
    // The branch where "invisible behind an unchanged aggregate" survives an outcome list
    // that only covers files the loop saw. `drafts.*` is dropped by the ignore list applied
    // to the caller's own paths in incremental mode.
    writeFile(path.join(projectRoot, "notes", "real.md"), NOTE("Real", "content"));
    writeFile(path.join(projectRoot, "notes", "drafts.skipme.md"), NOTE("Draft", "content"));

    // `files`, not `incrementalFiles` — the wrapper renames it, and passing the inner name
    // is silently ignored rather than rejected.
    const res = await run({ files: ["notes/real.md", "notes/drafts.skipme.md"] });
    const dropped = outcomeFor(res, "drafts.skipme.md");

    expect(dropped).toBeTruthy();
    expect(dropped.embedded).toBe(false);
    expect(dropped.reason).toBe("not-selected");
  });
});
