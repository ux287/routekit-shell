/**
 * Witness for backlog.fix.rag-embed-manifest-records-unindexed-content.
 *
 * The embed manifest recorded SEEN and the skip check read it as INDEXED.
 *
 * `newHashes[relPath] = contentHash` ran BEFORE `processNote`, so a note that produced no rows —
 * excluded by the predicate, empty, or an exception caught inside `processNote` — still had its
 * current hash committed. Every later run then matched that hash, logged "Skipping unchanged", and
 * reported `embedded: false, reason: 'unchanged'` for content that had never reached the vector
 * store. Silent, and permanent: `reset` drops the LanceDB table but never clears the manifest, so
 * only a content edit or a hand-deleted manifest recovered it.
 *
 * The fix cannot simply withhold the hash. The stale set is derived from ABSENCE from `newHashes`
 * and handed to `deleteByPaths`, so withholding alone would classify a previously-indexed note that
 * later throws as deleted-from-disk and remove its existing rows — trading a silent absence for a
 * silent deletion. Hence three dispositions rather than two, and the `unindexed` channel that keeps
 * such a path out of both the hash map and the stale set.
 *
 * STUB EMBEDDER. `embedding-pipeline.mjs` has a production stub arm selected by these env vars, and
 * the mode is read into a MODULE-SCOPE const — so the env must be set BEFORE the dynamic import. A
 * top-level static import would pin the mode to "model" and download ~90MB inside the mock sweep.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { makeTempDir, writeFile } from "../helpers/tmp.mjs";

const NOTE = (title, body) => `---\ntitle: ${title}\n---\n\n${body}\n`;
const OPTED_OUT = (title, body) => `---\ntitle: ${title}\nrag: false\n---\n\n${body}\n`;

describe("the embed manifest records only what was indexed", { timeout: 60_000 }, () => {
  let projectRoot;
  let dbPath;

  beforeEach(() => {
    process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "stub";
    process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
    delete process.env.RKS_CODE_GLOB;
    delete process.env.ROUTEKIT_CODE_GLOB;
    delete process.env.RKS_RAG_SCOPE_MODE;
    delete process.env.RKS_RAG_RESET;
    projectRoot = makeTempDir("rag_manifest_indexed");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "rag-manifest", private: true }));
    dbPath = path.join(projectRoot, ".rks", "rag", "lance", "notes.lance");
  });

  const run = async (opts = {}) => {
    const { embed } = await import("@routekit/rag/embed");
    return embed({ projectRoot, vault: path.join(projectRoot, "notes"), glob: "**/*", db: dbPath, ...opts });
  };

  const outcomeFor = (res, needle) => (res.fileOutcomes || []).find((o) => o.file.includes(needle));

  const readManifest = () => {
    const p = path.join(projectRoot, ".rks", "rag", "embed-manifest.json");
    if (!fs.existsSync(p)) return { hashes: {} };
    return JSON.parse(fs.readFileSync(p, "utf8"));
  };

  const hashKeyFor = (needle) =>
    Object.keys(readManifest().hashes || {}).find((k) => k.includes(needle));

  it("does not hash a note the predicate excluded", async () => {
    writeFile(path.join(projectRoot, "notes", "kept.md"), NOTE("Kept", "included"));
    writeFile(path.join(projectRoot, "notes", "optedout.md"), OPTED_OUT("Opted", "body"));

    const res = await run();

    expect(outcomeFor(res, "optedout.md").reason).toBe("excluded"); // positive control
    expect(hashKeyFor("kept.md")).toBeTruthy(); // the indexed one IS hashed
    expect(hashKeyFor("optedout.md")).toBeUndefined();
  });

  it("RED at HEAD — an excluded note is re-examined next run, never reported 'unchanged'", async () => {
    // The defect, stated as a caller sees it. Before the fix the second run answered "unchanged",
    // which asserts the note's current content is in the index. It never was.
    writeFile(path.join(projectRoot, "notes", "optedout.md"), OPTED_OUT("Opted", "body"));
    const first = await run();
    expect(first.fileOutcomes.length).toBeGreaterThan(0); // positive control — the file was seen

    const second = await run();
    const again = outcomeFor(second, "optedout.md");

    expect(again).toBeTruthy();
    expect(again.reason).toBe("excluded");
    expect(again.reason).not.toBe("unchanged");
  });

  it("a successfully indexed note is unaffected — still 'unchanged' on the second run", async () => {
    // No behaviour change on the path that was always correct. Withholding hashes too broadly
    // would show up here as endless re-embedding.
    writeFile(path.join(projectRoot, "notes", "stable.md"), NOTE("Stable", "unchanging"));
    const first = await run();
    expect(outcomeFor(first, "stable.md").embedded).toBe(true);

    const second = await run();
    const stable = outcomeFor(second, "stable.md");

    expect(stable.embedded).toBe(false);
    expect(stable.reason).toBe("unchanged");
    expect(hashKeyFor("stable.md")).toBeTruthy();
  });

  it("a note that stops producing rows is re-examined rather than skipped forever", async () => {
    // Indexed first, then opted out. Its content changed, so the skip check does not fire on the
    // second run — but the THIRD run is where the old code committed the opted-out hash and lost
    // the file for good.
    const p = path.join(projectRoot, "notes", "turncoat.md");
    writeFile(p, NOTE("Turncoat", "indexed at first"));
    expect(outcomeFor(await run(), "turncoat.md").embedded).toBe(true); // positive control

    writeFile(p, OPTED_OUT("Turncoat", "indexed at first"));
    expect(outcomeFor(await run(), "turncoat.md").reason).toBe("excluded");

    const third = await run();
    expect(outcomeFor(third, "turncoat.md").reason).toBe("excluded");
    expect(hashKeyFor("turncoat.md")).toBeUndefined();
  });
});

/**
 * The stale-classification half, asserted directly on the exported pure function.
 *
 * This is the half that cannot be reached from an `embed()` run without inspecting LanceDB rows:
 * whether a visited-but-unindexed path is handed to `deleteByPaths`. `computeManifestUpdate` is
 * exported and is where that decision is made, so it is asserted where it lives.
 */
describe("computeManifestUpdate — three dispositions, not two", () => {
  const load = async () => (await import("@routekit/rag/embed")).computeManifestUpdate;

  it("a visited-but-unindexed path is NEITHER hashed NOR stale", async () => {
    const computeManifestUpdate = await load();
    const out = computeManifestUpdate({
      priorHashes: { "notes/a.md": "old", "notes/b.md": "keep" },
      newHashes: { "notes/b.md": "keep" },
      unindexed: new Set(["notes/a.md"]),
    });

    // Not stale — its existing rows survive. This is the assertion a naive fix fails.
    expect(out.stale).not.toContain("notes/a.md");
    // Not hashed — the next run tries it again instead of skipping it as unchanged.
    expect(out.hashes["notes/a.md"]).toBeUndefined();
    expect(out.hashes["notes/b.md"]).toBe("keep");
  });

  it("a path that genuinely vanished is STILL stale — the prune contract is unchanged", async () => {
    const computeManifestUpdate = await load();
    const out = computeManifestUpdate({
      priorHashes: { "notes/gone.md": "old", "notes/b.md": "keep" },
      newHashes: { "notes/b.md": "keep" },
      unindexed: new Set(),
    });

    expect(out.stale).toEqual(["notes/gone.md"]);
    expect(out.hashes["notes/gone.md"]).toBeUndefined();
  });

  it("bounded runs keep both properties, and still carry out-of-scope entries forward", async () => {
    const computeManifestUpdate = await load();
    const out = computeManifestUpdate({
      priorHashes: { "notes/a.md": "old", "notes/gone.md": "old", "notes/far.md": "untouched" },
      newHashes: {},
      visitedScope: new Set(["notes/a.md", "notes/gone.md"]),
      unindexed: new Set(["notes/a.md"]),
    });

    expect(out.stale).toEqual(["notes/gone.md"]);
    expect(out.hashes["notes/a.md"]).toBeUndefined();
    // Never examined this run — must survive untouched, or a one-file commit wipes the index.
    expect(out.hashes["notes/far.md"]).toBe("untouched");
  });

  it("omitting `unindexed` preserves the original two-disposition behaviour", async () => {
    // Back-compatibility: every existing caller and pinned test passes no `unindexed`.
    const computeManifestUpdate = await load();
    const out = computeManifestUpdate({
      priorHashes: { "notes/gone.md": "old" },
      newHashes: { "notes/b.md": "new" },
    });

    expect(out.stale).toEqual(["notes/gone.md"]);
    expect(out.hashes).toEqual({ "notes/b.md": "new" });
  });
});
